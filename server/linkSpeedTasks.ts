import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { pushAgentRefresh } from "./agentEvents";
import { releaseHostPortReservations } from "./portReservations";
import {
  linkSpeedActive,
  type LinkSpeedStatus,
  type LinkSpeedMeasurement,
  type LinkSpeedSample,
} from "../shared/linkSpeed";
import type { SpeedPlan, SpeedComponent } from "./linkSpeedPlan";

export type LinkSpeedTask = {
  taskId: string;
  jobId: string;
  op: "prepare" | "run" | "stop";
  token: string;
  protocol: "tcp" | "udp";
  duration: number;
  rateMbps: number;
  expiresAt: number;
  target?: string;
  components?: SpeedComponent[];
};
type Job = {
  userId: number;
  status: LinkSpeedStatus;
  plan: SpeedPlan;
  token: string;
  ready: Set<number>;
  pending: Map<string, { hostId: number; op: LinkSpeedTask["op"] }>;
  timer?: ReturnType<typeof setTimeout>;
  cleanupUntil?: number;
};
const jobs = new Map<string, Job>();
const queues = new Map<number, LinkSpeedTask[]>();
const capabilities = new Map<number, number>();
export function recordLinkSpeedCapability(hostId: number, supported: boolean) {
  if (supported) capabilities.set(hostId, Date.now());
  else capabilities.delete(hostId);
}
export function linkSpeedHostSupported(hostId: number) {
  return Date.now() - (capabilities.get(hostId) || 0) < 15 * 60_000;
}
export function hasQueuedLinkSpeedTasks(hostId: number) {
  return !!queues.get(hostId)?.length;
}
export function takeLinkSpeedTasks(hostId: number) {
  const tasks = queues.get(hostId) || [];
  queues.delete(hostId);
  return tasks.filter(
    (task) =>
      task.expiresAt > Date.now() &&
      (task.op === "stop" ||
        linkSpeedActive(jobs.get(task.jobId)?.status.state)),
  );
}
function enqueue(job: Job, hostId: number, op: LinkSpeedTask["op"]) {
  const status = job.status;
  const task: LinkSpeedTask = {
    taskId: crypto.randomUUID(),
    jobId: status.id,
    op,
    token: job.token,
    protocol: status.protocol,
    duration: status.duration,
    rateMbps: status.rateMbps,
    expiresAt: Date.now() + 150_000,
    ...(op === "prepare" ? { components: job.plan.hosts.get(hostId) } : {}),
    ...(op === "run" ? { target: job.plan.target } : {}),
  };
  job.pending.set(task.taskId, { hostId, op });
  queues.set(hostId, [
    ...(queues.get(hostId) || []).filter(
      (t) => t.jobId !== status.id || t.op === op,
    ),
    task,
  ]);
  pushAgentRefresh(hostId, `link-speed-${op}`, { urgent: true });
}
function finish(
  job: Job,
  state: "completed" | "cancelled" | "error",
  error?: string,
) {
  if (!linkSpeedActive(job.status.state)) return;
  job.status.state = state;
  job.status.error = error;
  job.status.finishedAt = new Date().toISOString();
  job.cleanupUntil = Date.now() + 155_000;
  clearTimeout(job.timer);
  for (const hostId of job.plan.hosts.keys()) {
    queues.set(
      hostId,
      (queues.get(hostId) || []).filter((t) => t.jobId !== job.status.id),
    );
    enqueue(job, hostId, "stop");
  }
  // Keep ports reserved until the stop requests/Agent leases have had time to run.
  setTimeout(
    () => releaseHostPortReservations(job.plan.reservations),
    155_000,
  ).unref?.();
}
export function createLinkSpeedJob(
  userId: number,
  status: Omit<
    LinkSpeedStatus,
    "id" | "state" | "route" | "samples" | "createdAt"
  >,
  plan: SpeedPlan,
  token: string,
) {
  const now = Date.now();
  for (const [id, job] of jobs)
    if (
      !linkSpeedActive(job.status.state) &&
      now - Date.parse(job.status.finishedAt || job.status.createdAt) >
        60 * 60_000
    )
      jobs.delete(id);
  if (jobs.size >= 1000) {
    releaseHostPortReservations(plan.reservations);
    throw new Error("测速任务过多，请稍后重试");
  }
  for (const job of jobs.values())
    if (
      (linkSpeedActive(job.status.state) || Number(job.cleanupUntil) > now) &&
      [...plan.hosts.keys()].some((id) => job.plan.hosts.has(id))
    ) {
      releaseHostPortReservations(plan.reservations);
      throw new Error("链路中有主机正在测速，请等待结束");
    }
  const job: Job = {
    userId,
    plan,
    token,
    ready: new Set(),
    pending: new Map(),
    status: {
      ...status,
      id: crypto.randomUUID(),
      state: "preparing",
      route: plan.route,
      samples: [],
      createdAt: new Date().toISOString(),
    },
  };
  jobs.set(job.status.id, job);
  job.timer = setTimeout(
    () =>
      finish(
        job,
        "error",
        "测速超时，请检查 Agent、链路连通性及临时端口防火墙",
      ),
    140_000,
  );
  job.timer.unref?.();
  for (const hostId of plan.hosts.keys()) enqueue(job, hostId, "prepare");
  return job.status;
}
export function getLinkSpeedJob(
  id: string,
  user: { id: number; role: string },
) {
  const job = jobs.get(id);
  if (!job || (user.role !== "admin" && job.userId !== user.id))
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "测速任务不存在或无权访问",
    });
  return job;
}
export function latestLinkSpeedJob(
  resourceType: "tunnel" | "chain",
  resourceId: number,
  userId: number,
) {
  return (
    [...jobs.values()]
      .reverse()
      .find(
        (job) =>
          job.userId === userId &&
          job.status.resourceType === resourceType &&
          job.status.resourceId === resourceId,
      )?.status || null
  );
}
export function cancelLinkSpeedJob(
  id: string,
  user: { id: number; role: string },
) {
  const job = getLinkSpeedJob(id, user);
  finish(job, "cancelled");
  return job.status;
}
export function claimLinkSpeedTask(
  hostId: number,
  taskId: string,
  jobId: string,
) {
  const job = jobs.get(jobId);
  const pending = job?.pending.get(taskId);
  return (
    !!job &&
    pending?.hostId === hostId &&
    (pending.op === "stop" || linkSpeedActive(job.status.state))
  );
}
function measurement(value: any): LinkSpeedMeasurement | undefined {
  if (
    !value ||
    !Number.isFinite(value.bytes) ||
    value.bytes < 0 ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs <= 0
  )
    return undefined;
  const result: LinkSpeedMeasurement = {
    bytes: value.bytes,
    durationMs: value.durationMs,
    mbps: (value.bytes * 8) / value.durationMs / 1000,
    peakMbps: Number.isFinite(value.peakMbps) ? Math.max(0, value.peakMbps) : 0,
  };
  for (const key of [
    "packets",
    "sentPackets",
    "lostPackets",
    "lossPercent",
    "jitterMs",
  ] as const)
    if (Number.isFinite(value[key]) && value[key] >= 0)
      result[key] = value[key];
  return result;
}
export function reportLinkSpeedTask(hostId: number, report: any) {
  if (
    !report ||
    typeof report.jobId !== "string" ||
    typeof report.taskId !== "string"
  )
    return false;
  const job = jobs.get(report.jobId);
  const pending = job?.pending.get(report.taskId);
  if (!job || pending?.hostId !== hostId) return false;
  if (pending.op === "stop") {
    if (report.state === "stopped") {
      job.pending.delete(report.taskId);
      if (![...job.pending.values()].some((task) => task.op === "stop")) {
        job.cleanupUntil = 0;
        releaseHostPortReservations(job.plan.reservations);
      }
    }
    return true;
  }
  if (!linkSpeedActive(job.status.state)) return false;
  if (report.state === "error") {
    finish(
      job,
      "error",
      String(report.error || "Agent 测速失败").slice(0, 1000),
    );
    return true;
  }
  if (pending.op === "prepare") {
    if (report.state !== "ready") return false;
    job.ready.add(hostId);
    job.pending.delete(report.taskId);
    if (job.ready.size === job.plan.hosts.size) {
      job.status.state = "upload";
      enqueue(job, job.plan.sourceHostId, "run");
    }
    return true;
  }
  if (
    report.sample &&
    (report.sample.direction === "upload" ||
      report.sample.direction === "download")
  ) {
    const sample = report.sample as LinkSpeedSample;
    if (
      [sample.elapsedMs, sample.bytes, sample.mbps].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) &&
      sample.elapsedMs <= (job.status.duration + 5) * 1000 &&
      job.status.samples.length < 300
    ) {
      job.status.state = sample.direction;
      job.status.samples.push({
        direction: sample.direction,
        elapsedMs: sample.elapsedMs,
        bytes: sample.bytes,
        mbps: sample.mbps,
      });
    }
  }
  if (report.upload) job.status.upload = measurement(report.upload);
  if (report.download) job.status.download = measurement(report.download);
  if (report.state === "completed") {
    if (!job.status.upload || !job.status.download)
      finish(job, "error", "测速结果不完整");
    else finish(job, "completed");
  }
  return true;
}

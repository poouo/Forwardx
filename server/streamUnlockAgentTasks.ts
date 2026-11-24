import crypto from "node:crypto";
import type {
  StreamUnlockAgentResult,
  StreamUnlockAgentTask,
  StreamUnlockFamily,
  StreamUnlockTaskSnapshot,
  StreamUnlockTaskStatus,
} from "../shared/streamUnlock";
import { STREAM_UNLOCK_DEFAULT_PROVIDER_IDS, STREAM_UNLOCK_PROBE_VERSION } from "../shared/streamUnlock";
import { pushAgentRefresh } from "./agentEvents";

type TaskState = {
  hostId: number;
  task: StreamUnlockAgentTask;
  status: StreamUnlockTaskStatus;
  result: StreamUnlockAgentResult | null;
  createdAt: string;
  updatedAt: string;
  timer: NodeJS.Timeout;
};

const states = new Map<string, TaskState>();
const latestByHost = new Map<number, string>();
const queues = new Map<number, StreamUnlockAgentTask[]>();
const TERMINAL = new Set<StreamUnlockTaskStatus>(["success", "error", "timeout"]);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const TASK_TIMEOUT_MS = 180 * 1000;

function nowIso() { return new Date().toISOString(); }

function snapshot(state: TaskState): StreamUnlockTaskSnapshot {
  const result = state.result || {
    taskId: state.task.taskId,
    probeVersion: STREAM_UNLOCK_PROBE_VERSION,
    family: state.task.family,
    providers: [],
    dns: [],
    startedAt: state.createdAt,
    finishedAt: "",
  };
  return {
    ...result,
    hostId: state.hostId,
    status: state.status,
    running: !TERMINAL.has(state.status),
    checkedAt: result.finishedAt || state.updatedAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function mergeResult(state: TaskState, incoming: StreamUnlockAgentResult, finished = false) {
  const current = state.result || {
    taskId: state.task.taskId,
    probeVersion: STREAM_UNLOCK_PROBE_VERSION,
    family: state.task.family,
    providers: [],
    dns: [],
    startedAt: state.createdAt,
    finishedAt: "",
  } as StreamUnlockAgentResult;
  state.result = {
    ...current,
    ...incoming,
    taskId: state.task.taskId,
    family: incoming.family || current.family,
    probeVersion: incoming.probeVersion || current.probeVersion,
    exitIPv4: incoming.exitIPv4 || current.exitIPv4,
    exitIPv6: incoming.exitIPv6 || current.exitIPv6,
    providers: Array.isArray(incoming.providers) && incoming.providers.length > 0
      ? [...current.providers.filter((row) => !incoming.providers.some((item) => item.providerId === row.providerId && String(item.evidence || "").startsWith(String(row.evidence || "").split(":")[0]))), ...incoming.providers]
      : current.providers,
    dns: Array.isArray(incoming.dns) && incoming.dns.length > 0
      ? [...current.dns.filter((row) => !incoming.dns.some((item) => item.domain === row.domain && String(item.family || "") === String(row.family || ""))), ...incoming.dns]
      : current.dns,
    startedAt: incoming.startedAt || current.startedAt || state.createdAt,
    finishedAt: finished ? (incoming.finishedAt || nowIso()) : current.finishedAt,
    error: incoming.error || current.error,
  };
}

function prune(now = Date.now()) {
  for (const [taskId, state] of states) {
    if (!TERMINAL.has(state.status)) continue;
    const updatedAt = Date.parse(state.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < RETENTION_MS) continue;
    states.delete(taskId);
    if (latestByHost.get(state.hostId) === taskId) latestByHost.delete(state.hostId);
  }
}

function timeoutTask(taskId: string) {
  const state = states.get(taskId);
  if (!state || TERMINAL.has(state.status)) return;
  const finishedAt = nowIso();
  state.status = "timeout";
  state.updatedAt = finishedAt;
  mergeResult(state, {
    ...(state.result || {
      taskId,
      probeVersion: STREAM_UNLOCK_PROBE_VERSION,
      family: state.task.family,
      providers: [],
      dns: [],
      startedAt: state.createdAt,
      finishedAt: "",
    }),
    taskId,
    error: "Agent 流媒体解锁检测超时",
    finishedAt,
  }, true);
  queues.set(state.hostId, (queues.get(state.hostId) || []).filter((item) => item.taskId !== taskId));
}

export function enqueueStreamUnlockAgentTask(
  hostId: number,
  input: { family?: StreamUnlockFamily; providerIds?: string[] },
) {
  prune();
  const existing = latestStreamUnlockAgentTask(hostId);
  if (existing && !TERMINAL.has(existing.status)) {
    throw new Error("该主机已有流媒体解锁检测正在执行");
  }
  const family: StreamUnlockFamily = input.family === "ipv4" || input.family === "ipv6" ? input.family : "both";
  const providerIds = Array.from(new Set((input.providerIds || STREAM_UNLOCK_DEFAULT_PROVIDER_IDS)
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => STREAM_UNLOCK_DEFAULT_PROVIDER_IDS.includes(item as any))));
  const task: StreamUnlockAgentTask = {
    taskId: crypto.randomUUID(),
    family,
    providerIds: providerIds.length > 0 ? providerIds : [...STREAM_UNLOCK_DEFAULT_PROVIDER_IDS],
    createdAt: nowIso(),
  };
  const timer = setTimeout(() => timeoutTask(task.taskId), TASK_TIMEOUT_MS);
  timer.unref?.();
  const state: TaskState = {
    hostId,
    task,
    status: "queued",
    result: null,
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
    timer,
  };
  states.set(task.taskId, state);
  latestByHost.set(hostId, task.taskId);
  queues.set(hostId, [task]);
  pushAgentRefresh(hostId, "stream-unlock", { urgent: true });
  return snapshot(state);
}

export function takeStreamUnlockAgentTasks(hostId: number, limit = 1) {
  const queue = queues.get(hostId) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(hostId, queue);
  else queues.delete(hostId);
  for (const task of tasks) {
    const state = states.get(task.taskId);
    if (!state || TERMINAL.has(state.status)) continue;
    state.status = "running";
    state.updatedAt = nowIso();
  }
  return tasks;
}

export function hasQueuedStreamUnlockAgentTasks(hostId: number) {
  return !!queues.get(Number(hostId))?.length;
}

export function completeStreamUnlockAgentTask(hostId: number, result: StreamUnlockAgentResult) {
  const taskId = String(result?.taskId || "");
  const state = states.get(taskId);
  if (!state || state.hostId !== hostId || TERMINAL.has(state.status)) return false;
  clearTimeout(state.timer);
  const updatedAt = nowIso();
  state.status = result.error ? "error" : "success";
  mergeResult(state, result, true);
  state.updatedAt = updatedAt;
  return true;
}

export function updateStreamUnlockAgentTaskProgress(hostId: number, result: StreamUnlockAgentResult) {
  const taskId = String(result?.taskId || "");
  const state = states.get(taskId);
  if (!state || state.hostId !== hostId || TERMINAL.has(state.status)) return false;
  state.status = "running";
  mergeResult(state, result, false);
  state.updatedAt = nowIso();
  return true;
}

export function getStreamUnlockAgentTaskStatus(hostId: number, taskId: string) {
  const state = states.get(String(taskId || ""));
  if (!state || state.hostId !== Number(hostId)) return null;
  return snapshot(state);
}

export function latestStreamUnlockAgentTask(hostId: number) {
  prune();
  const taskId = latestByHost.get(Number(hostId));
  if (!taskId) return null;
  const state = states.get(taskId);
  return state ? snapshot(state) : null;
}

export function hasActiveStreamUnlockAgentTask(hostId: number) {
  const status = latestStreamUnlockAgentTask(hostId)?.status;
  return !!status && !TERMINAL.has(status);
}

const cleanupTimer = setInterval(() => prune(), 10 * 60 * 1000);
cleanupTimer.unref?.();

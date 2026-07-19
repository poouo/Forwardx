import { randomUUID } from "node:crypto";
import { formatPanelLogsForExport } from "./_core/panelLogger";
import { listRecentConfigAuditEvents } from "./configAudit";

type SupportHostResult = {
  hostId: number;
  hostName: string;
  status: "pending" | "offline" | "complete" | "error" | "timeout";
  reportedAt?: string;
  diagnostics?: unknown;
  error?: string;
};

type SupportTask = {
  id: string;
  createdAt: number;
  expiresAt: number;
  hosts: Map<number, SupportHostResult>;
  panelHosts: unknown[];
};

const tasks = new Map<string, SupportTask>();
const SUPPORT_TIMEOUT_MS = 45_000;
const SUPPORT_RETENTION_MS = 30 * 60_000;
const SECRET_KEY = /(password|passwd|secret|token|private.?key|certificate|authorization|cookie|credential)/i;

export function redactSupportValue(value: any, key = ""): any {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value
      .replace(/(authorization:\s*(?:bearer\s+)?)[^\s]+/gi, "$1[REDACTED]")
      .replace(/((?:password|passwd|secret|token|private.?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSupportValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSupportValue(child, childKey)]));
  }
  return value;
}

function pruneTasks(now = Date.now()) {
  for (const [id, task] of tasks) if (task.expiresAt <= now) tasks.delete(id);
}

export function createSupportBundleTask(hosts: any[]) {
  pruneTasks();
  const id = randomUUID();
  const results = new Map<number, SupportHostResult>();
  for (const host of hosts) {
    const hostId = Number(host?.id || 0);
    if (hostId <= 0) continue;
    results.set(hostId, {
      hostId,
      hostName: String(host?.name || `host-${hostId}`),
      status: host?.isOnline ? "pending" : "offline",
      ...(!host?.isOnline ? { error: "Agent offline; diagnostics were not requested" } : {}),
    });
  }
  tasks.set(id, {
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SUPPORT_RETENTION_MS,
    hosts: results,
    panelHosts: redactSupportValue(hosts.map((host) => ({
      id: host.id,
      name: host.name,
      ip: host.ip,
      ipv4: host.ipv4,
      ipv6: host.ipv6,
      isOnline: host.isOnline,
      lastHeartbeat: host.lastHeartbeat,
      agentVersion: host.agentVersion,
      agentBootId: host.agentBootId,
      agentProcessId: host.agentProcessId,
      agentProcessStartedAt: host.agentProcessStartedAt,
      agentLastReceivedRevision: host.agentLastReceivedRevision,
      agentLastAppliedRevision: host.agentLastAppliedRevision,
      agentLastReceivedHash: host.agentLastReceivedHash,
      agentLastAppliedHash: host.agentLastAppliedHash,
      agentRecoveryStartedAt: host.agentRecoveryStartedAt,
      agentRecoveryCompletedAt: host.agentRecoveryCompletedAt,
      agentRecoveryExpected: host.agentRecoveryExpected,
      agentRecoveryReady: host.agentRecoveryReady,
      mimicAvailable: host.mimicAvailable,
      mimicVersion: host.mimicVersion,
      mimicStatus: host.mimicStatus,
      mimicRuntimeStatus: host.mimicRuntimeStatus,
      mimicRuntimeMessage: host.mimicRuntimeMessage,
    }))),
  });
  return { taskId: id, hostIds: Array.from(results.values()).filter((item) => item.status === "pending").map((item) => item.hostId) };
}

export function completeSupportBundleHost(taskId: string, hostId: number, report: any) {
  const task = tasks.get(String(taskId || ""));
  const current = task?.hosts.get(Number(hostId));
  if (!task || !current || current.status !== "pending") return false;
  task.hosts.set(Number(hostId), {
    ...current,
    status: report?.error ? "error" : "complete",
    reportedAt: new Date().toISOString(),
    diagnostics: redactSupportValue(report?.diagnostics || report || {}),
    error: report?.error ? String(redactSupportValue(report.error)) : undefined,
  });
  return true;
}

export function failSupportBundleHost(taskId: string, hostId: number, error: string) {
  const task = tasks.get(String(taskId || ""));
  const current = task?.hosts.get(Number(hostId));
  if (!task || !current || current.status !== "pending") return false;
  task.hosts.set(Number(hostId), { ...current, status: "error", error: String(error || "Agent request failed") });
  return true;
}

export async function getSupportBundleTask(taskId: string) {
  pruneTasks();
  const task = tasks.get(String(taskId || ""));
  if (!task) return null;
  const now = Date.now();
  if (now - task.createdAt >= SUPPORT_TIMEOUT_MS) {
    for (const [hostId, result] of task.hosts) {
      if (result.status === "pending") task.hosts.set(hostId, { ...result, status: "timeout", error: "Agent diagnostics timed out after 45 seconds" });
    }
  }
  const hosts = Array.from(task.hosts.values());
  const pending = hosts.filter((item) => item.status === "pending").length;
  const complete = pending === 0;
  let download: { filename: string; mimeType: string; content: string } | undefined;
  if (complete) {
    const panelLogs = formatPanelLogsForExport("all");
    const audits = await listRecentConfigAuditEvents(1000);
    const payload = redactSupportValue({
      format: "forwardx-support-bundle-v1",
      generatedAt: new Date().toISOString(),
      panelLogs: panelLogs.content,
      configAuditEvents: audits,
      panelHosts: task.panelHosts,
      agentDiagnostics: hosts,
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download = {
      filename: `forwardx-support-bundle-${stamp}.json`,
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify(payload, null, 2),
    };
  }
  return { taskId: task.id, complete, pending, total: hosts.length, hosts, download };
}

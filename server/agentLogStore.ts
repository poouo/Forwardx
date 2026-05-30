type AgentLogLevel = "info" | "warn" | "error";

export type AgentLogEntry = {
  id: string;
  hostId: number;
  hostName: string;
  level: AgentLogLevel;
  message: string;
  createdAt: string;
};

let logs: AgentLogEntry[] = [];

const MAX_AGENT_LOGS = 2000;

export function appendAgentLog(host: any, level: AgentLogLevel, message: string, createdAt?: string) {
  const text = String(message || "").trim();
  if (!text) return;
  logs.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostId: Number(host?.id) || 0,
    hostName: String(host?.name || `Host #${host?.id || "-"}`),
    level,
    message: text.slice(0, 2000),
    createdAt: createdAt || new Date().toISOString(),
  });
  if (logs.length > MAX_AGENT_LOGS) logs = logs.slice(-MAX_AGENT_LOGS);
}

export function getAgentLogs(input: { hostId?: number | null; level?: string | null } = {}) {
  const hostId = Number(input.hostId || 0);
  const level = String(input.level || "all").toLowerCase();
  return logs.filter((entry) => {
    if (hostId > 0 && entry.hostId !== hostId) return false;
    if (level !== "all" && entry.level !== level) return false;
    return true;
  });
}

export function getAgentLogSummary(input: { hostId?: number | null } = {}) {
  const hostId = Number(input.hostId || 0);
  return logs.reduce<Record<"all" | AgentLogLevel, number>>((acc, entry) => {
    if (hostId > 0 && entry.hostId !== hostId) return acc;
    acc.all += 1;
    acc[entry.level] += 1;
    return acc;
  }, { all: 0, info: 0, warn: 0, error: 0 });
}

export function clearAgentLogs(hostId?: number | null) {
  const id = Number(hostId || 0);
  logs = id > 0 ? logs.filter((entry) => entry.hostId !== id) : [];
}

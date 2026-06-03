import { appendJsonLog, clearJsonLogFile, getLogFilePath, pruneJsonLogFile, readRecentJsonLogPageAsync } from "./logFileStore";

type AgentLogLevel = "info" | "warn" | "error";

export type AgentLogEntry = {
  id: string;
  hostId: number;
  hostName: string;
  level: AgentLogLevel;
  message: string;
  createdAt: string;
};

const AGENT_LOG_FILE = getLogFilePath("agent.jsonl");
const LOG_PRUNE_INTERVAL_MS = 60 * 1000;
let lastPruneAt = 0;
const retentionTimer = setInterval(() => pruneJsonLogFile(AGENT_LOG_FILE), 60 * 60 * 1000);
retentionTimer.unref?.();

function readAgentLogs() {
  return pruneJsonLogFile(AGENT_LOG_FILE) as AgentLogEntry[];
}

function pruneAgentLogsThrottled() {
  const now = Date.now();
  if (now - lastPruneAt < LOG_PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruneJsonLogFile(AGENT_LOG_FILE);
}

export function appendAgentLog(host: any, level: AgentLogLevel, message: string, createdAt?: string) {
  const text = String(message || "").trim();
  if (!text) return;
  const time = createdAt ? new Date(createdAt) : new Date();
  appendJsonLog(AGENT_LOG_FILE, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostId: Number(host?.id) || 0,
    hostName: String(host?.name || `Host #${host?.id || "-"}`),
    level,
    message: text.slice(0, 2000),
    createdAt: Number.isFinite(time.getTime()) ? time.toISOString() : new Date().toISOString(),
  });
  pruneAgentLogsThrottled();
}

export function getAgentLogs(input: { hostId?: number | null; level?: string | null } = {}) {
  const hostId = Number(input.hostId || 0);
  const level = String(input.level || "all").toLowerCase();
  return readAgentLogs().filter((entry) => {
    if (hostId > 0 && entry.hostId !== hostId) return false;
    if (level !== "all" && entry.level !== level) return false;
    return true;
  });
}

export async function getAgentLogPage(input: { hostId?: number | null; level?: string | null; limit?: number | null; offset?: number | null } = {}) {
  const page = await readRecentJsonLogPageAsync<AgentLogEntry>(AGENT_LOG_FILE, {
    hostId: input.hostId,
    level: input.level || "all",
    limit: input.limit,
    offset: input.offset,
  });
  return {
    ...page,
    summary: {
      all: page.summary.all || 0,
      info: page.summary.info || 0,
      warn: page.summary.warn || 0,
      error: page.summary.error || 0,
    },
  };
}

export function getAgentLogSummary(input: { hostId?: number | null } = {}) {
  const hostId = Number(input.hostId || 0);
  return readAgentLogs().reduce<Record<"all" | AgentLogLevel, number>>((acc, entry) => {
    if (hostId > 0 && entry.hostId !== hostId) return acc;
    acc.all += 1;
    acc[entry.level] += 1;
    return acc;
  }, { all: 0, info: 0, warn: 0, error: 0 });
}

export function clearAgentLogs(hostId?: number | null) {
  const id = Number(hostId || 0);
  if (id <= 0) {
    clearJsonLogFile(AGENT_LOG_FILE);
    return;
  }
  const retained = readAgentLogs().filter((entry) => entry.hostId !== id);
  clearJsonLogFile(AGENT_LOG_FILE);
  for (const entry of retained) appendJsonLog(AGENT_LOG_FILE, entry);
}

import { appendJsonLog, clearJsonLogFile, getLogFilePath, pruneJsonLogFile, readRecentJsonLogPageAsync } from "../logFileStore";

export type PanelLogLevel = "log" | "info" | "warn" | "error";
export type PanelLogFilterLevel = PanelLogLevel | "all";

export type PanelLogEntry = {
  id: string | number;
  level: PanelLogLevel;
  message: string;
  createdAt: string;
};

let nextLogId = 1;
let installed = false;
let lastPruneAt = 0;
const PANEL_LOG_FILE = getLogFilePath("panel.jsonl");
const LOG_PRUNE_INTERVAL_MS = 60 * 1000;

function stringifyArg(arg: unknown) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function isNoisyPanelLog(message: string) {
  return (
    /^\[AgentEvent\].*event=agent-refresh\b/.test(message) ||
    /^\[AgentEvent\].*\bconnected\b/.test(message) ||
    /^\[AgentEvent\].*\bdisconnected\b/.test(message) ||
    /^\[Agent TCPing\]/.test(message) ||
    /^\[(TunnelTraffic|Traffic)\]/.test(message)
  );
}

export function appendPanelLog(level: PanelLogLevel, ...args: unknown[]) {
  const message = args.map(stringifyArg).join(" ").trim();
  if (!message) return;
  if (level !== "warn" && level !== "error" && isNoisyPanelLog(message)) return;
  appendJsonLog(PANEL_LOG_FILE, {
    id: `${Date.now()}-${nextLogId++}`,
    level,
    message,
    createdAt: new Date().toISOString(),
  });
  prunePanelLogsThrottled();
}

function prunePanelLogsThrottled() {
  const now = Date.now();
  if (now - lastPruneAt < LOG_PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruneJsonLogFile(PANEL_LOG_FILE);
}

export function getPanelLogs() {
  return pruneJsonLogFile(PANEL_LOG_FILE) as PanelLogEntry[];
}

export function getFilteredPanelLogs(level: PanelLogFilterLevel = "all") {
  const currentLogs = getPanelLogs();
  return level === "all" ? currentLogs : currentLogs.filter((entry) => entry.level === level);
}

export async function getPanelLogPage(input: { level?: PanelLogFilterLevel; limit?: number | null; offset?: number | null } = {}) {
  const page = await readRecentJsonLogPageAsync<PanelLogEntry>(PANEL_LOG_FILE, {
    level: input.level || "all",
    limit: input.limit,
    offset: input.offset,
  });
  return {
    ...page,
    summary: {
      all: page.summary.all || 0,
      log: page.summary.log || 0,
      info: page.summary.info || 0,
      warn: page.summary.warn || 0,
      error: page.summary.error || 0,
    },
  };
}

export function getPanelLogSummary() {
  return getPanelLogs().reduce<Record<string, number>>((acc, entry) => {
    acc[entry.level] = (acc[entry.level] || 0) + 1;
    acc.all = (acc.all || 0) + 1;
    return acc;
  }, { all: 0, log: 0, info: 0, warn: 0, error: 0 });
}

export function clearPanelLogs() {
  clearJsonLogFile(PANEL_LOG_FILE);
}

export function formatPanelLogsForExport(level: PanelLogFilterLevel = "all", metadata: Record<string, unknown> = {}) {
  const selectedLogs = getFilteredPanelLogs(level);
  const summary = getPanelLogSummary();
  const generatedAt = new Date().toISOString();
  const header = [
    "ForwardX Panel Logs",
    `Generated At: ${generatedAt}`,
    `Level: ${level}`,
    `Exported Count: ${selectedLogs.length}`,
    `Summary: all=${summary.all || 0}, log=${summary.log || 0}, info=${summary.info || 0}, warn=${summary.warn || 0}, error=${summary.error || 0}`,
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${String(value ?? "")}`),
    "",
    "---- Logs ----",
  ];
  const body = selectedLogs.map((entry) => {
    return `[${entry.createdAt}] [${entry.level.toUpperCase()}] ${entry.message}`;
  });
  return {
    content: [...header, ...body, ""].join("\n"),
    count: selectedLogs.length,
    generatedAt,
  };
}

export function installPanelLogger() {
  if (installed) return;
  installed = true;
  const retentionTimer = setInterval(() => pruneJsonLogFile(PANEL_LOG_FILE), 60 * 60 * 1000);
  retentionTimer.unref?.();
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  (["log", "info", "warn", "error"] as PanelLogLevel[]).forEach((level) => {
    console[level] = (...args: unknown[]) => {
      appendPanelLog(level, ...args);
      original[level](...args);
    };
  });
}

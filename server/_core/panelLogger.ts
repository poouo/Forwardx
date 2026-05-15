type PanelLogLevel = "log" | "info" | "warn" | "error";

type PanelLogEntry = {
  id: number;
  level: PanelLogLevel;
  message: string;
  createdAt: string;
};

const MAX_LOGS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
let nextLogId = 1;
let logs: PanelLogEntry[] = [];
let installed = false;

function stringifyArg(arg: unknown) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function trimLogs() {
  const cutoff = Date.now() - DAY_MS;
  logs = logs.filter((entry) => new Date(entry.createdAt).getTime() >= cutoff).slice(-MAX_LOGS);
}

export function appendPanelLog(level: PanelLogLevel, ...args: unknown[]) {
  const message = args.map(stringifyArg).join(" ").trim();
  if (!message) return;
  logs.push({
    id: nextLogId++,
    level,
    message,
    createdAt: new Date().toISOString(),
  });
  trimLogs();
}

export function getPanelLogs() {
  trimLogs();
  return logs;
}

export function clearPanelLogs() {
  logs = [];
}

export function installPanelLogger() {
  if (installed) return;
  installed = true;
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

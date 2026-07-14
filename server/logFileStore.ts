import fs from "fs";
import path from "path";
import readline from "readline";

export type FileLogEntry = {
  id: string | number;
  level: string;
  message: string;
  createdAt: string;
  [key: string]: unknown;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;

export type JsonLogPageOptions = {
  level?: string | null;
  hostId?: number | null;
  limit?: number | null;
  offset?: number | null;
};

export type JsonLogPageResult<T extends FileLogEntry = FileLogEntry> = {
  logs: T[];
  total: number;
  summary: Record<string, number>;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number;
};

export function getLogDir() {
  const configured = process.env.FORWARDX_LOG_DIR?.trim();
  if (configured) return configured;
  if (process.platform !== "win32" && fs.existsSync("/data")) return "/data/logs";
  return path.resolve(process.cwd(), "data", "logs");
}

export function getLogFilePath(filename: string) {
  return path.join(getLogDir(), filename);
}

function ensureLogDir() {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

function parseLogLine(line: string): FileLogEntry | null {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== "object") return null;
    const createdAt = String(entry.createdAt || "");
    if (!Number.isFinite(new Date(createdAt).getTime())) return null;
    return entry as FileLogEntry;
  } catch {
    return null;
  }
}

function recentEntry(entry: FileLogEntry, now = Date.now()) {
  const time = new Date(entry.createdAt).getTime();
  return Number.isFinite(time) && time >= now - DAY_MS;
}

function normalizeLimit(limit: number | null | undefined) {
  const value = Math.floor(Number(limit) || DEFAULT_PAGE_LIMIT);
  return Math.min(Math.max(value, 1), MAX_PAGE_LIMIT);
}

function normalizeOffset(offset: number | null | undefined) {
  const value = Math.floor(Number(offset) || 0);
  return Math.max(value, 0);
}

function normalizeLevel(level: unknown) {
  return String(level || "").trim().toLowerCase();
}

export function appendJsonLog(filePath: string, entry: FileLogEntry) {
  ensureLogDir();
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readRecentJsonLogs(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.map(parseLogLine).filter((entry): entry is FileLogEntry => !!entry && recentEntry(entry));
}

export async function readRecentJsonLogPageAsync<T extends FileLogEntry = FileLogEntry>(
  filePath: string,
  options: JsonLogPageOptions = {},
): Promise<JsonLogPageResult<T>> {
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const filterLevel = normalizeLevel(options.level || "all");
  const hostId = Number(options.hostId || 0);
  const filterHost = Number.isFinite(hostId) && hostId > 0;
  const summary: Record<string, number> = { all: 0 };
  const windowSize = offset + limit;
  const windowLogs: T[] = [];
  let total = 0;

  if (!fs.existsSync(filePath)) {
    return { logs: [], total, summary, limit, offset, hasMore: false, nextOffset: offset };
  }

  const now = Date.now();
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (!entry || !recentEntry(entry, now)) continue;
    if (filterHost && Number(entry.hostId || 0) !== hostId) continue;

    const entryLevel = normalizeLevel(entry.level) || "log";
    summary.all = (summary.all || 0) + 1;
    summary[entryLevel] = (summary[entryLevel] || 0) + 1;

    if (filterLevel !== "all" && entryLevel !== filterLevel) continue;
    total += 1;
    if (windowSize <= 0) continue;
    windowLogs.push(entry as T);
    if (windowLogs.length > windowSize) {
      windowLogs.splice(0, windowLogs.length - windowSize);
    }
  }

  const newestFirst = windowLogs.reverse();
  const logs = newestFirst.slice(offset, offset + limit);
  return {
    logs,
    total,
    summary,
    limit,
    offset,
    hasMore: total > offset + logs.length,
    nextOffset: offset + logs.length,
  };
}

export function pruneJsonLogFile(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const logs = readRecentJsonLogs(filePath);
  ensureLogDir();
  if (logs.length === 0) {
    fs.writeFileSync(filePath, "", "utf8");
  } else {
    fs.writeFileSync(filePath, `${logs.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  }
  return logs;
}

export function clearJsonLogFile(filePath: string) {
  ensureLogDir();
  fs.writeFileSync(filePath, "", "utf8");
}

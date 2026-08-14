import fs from "fs";
import path from "path";
import readline from "readline";
import { once } from "events";

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
const pendingAppends = new Map<string, string[]>();
const appendFlushScheduled = new Set<string>();
const fileOperationQueues = new Map<string, Promise<void>>();
const ensuredLogDirs = new Set<string>();

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
  const dir = getLogDir();
  if (ensuredLogDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredLogDirs.add(dir);
}

function queueFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperationQueues.get(filePath) || Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  fileOperationQueues.set(filePath, tail);
  void tail.then(() => {
    if (fileOperationQueues.get(filePath) === tail) fileOperationQueues.delete(filePath);
  });
  return result;
}

function reportLogFileError(action: string, filePath: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[ForwardX] ${action} failed file=${filePath}: ${message}\n`);
}

function queuePendingAppend(filePath: string) {
  const chunks = pendingAppends.get(filePath);
  if (!chunks?.length) return fileOperationQueues.get(filePath) || Promise.resolve();
  pendingAppends.delete(filePath);
  const content = chunks.join("");
  return queueFileOperation(filePath, async () => {
    ensureLogDir();
    try {
      await fs.promises.appendFile(filePath, content, "utf8");
    } catch (error) {
      // The log directory can be removed by an external rotation or cleanup
      // after it was cached as present. Recreate it and retry asynchronously
      // before falling back to a blocking write on the error path.
      try {
        const dir = path.dirname(filePath);
        ensuredLogDirs.delete(dir);
        await fs.promises.mkdir(dir, { recursive: true });
        ensuredLogDirs.add(dir);
        await fs.promises.appendFile(filePath, content, "utf8");
        return;
      } catch {
        // Fall through to the synchronous last-resort write below.
      }
      // Preserve logs on transient async-I/O failures. This fallback only runs
      // on an error path, so normal console output never blocks the event loop.
      try {
        fs.appendFileSync(filePath, content, "utf8");
      } catch (fallbackError) {
        reportLogFileError("append", filePath, fallbackError || error);
      }
    }
  });
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
  const chunks = pendingAppends.get(filePath) || [];
  chunks.push(`${JSON.stringify(entry)}\n`);
  pendingAppends.set(filePath, chunks);
  if (appendFlushScheduled.has(filePath)) return;
  appendFlushScheduled.add(filePath);
  setImmediate(() => {
    appendFlushScheduled.delete(filePath);
    void queuePendingAppend(filePath);
  });
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

  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
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
  });
}

export async function readRecentJsonLogsAsync(filePath: string) {
  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
    if (!fs.existsSync(filePath)) return [];
    const logs: FileLogEntry[] = [];
    const now = Date.now();
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const entry = line ? parseLogLine(line) : null;
      if (entry && recentEntry(entry, now)) logs.push(entry);
    }
    return logs;
  });
}

export function pruneJsonLogFile(filePath: string) {
  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
    if (!fs.existsSync(filePath)) return [];
    ensureLogDir();
    const now = Date.now();
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const output = fs.createWriteStream(tempPath, { encoding: "utf8", flags: "w" });
    try {
      for await (const line of lines) {
        const entry = line ? parseLogLine(line) : null;
        if (!entry || !recentEntry(entry, now)) continue;
        if (!output.write(`${JSON.stringify(entry)}\n`)) await once(output, "drain");
      }
      output.end();
      await once(output, "finish");
      await fs.promises.rename(tempPath, filePath);
      return undefined;
    } catch (error) {
      output.destroy();
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export function clearJsonLogFile(filePath: string) {
  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
    ensureLogDir();
    await fs.promises.writeFile(filePath, "", "utf8");
  });
}

export async function flushJsonLogWrites(filePath?: string) {
  if (filePath) {
    await queuePendingAppend(filePath);
    return;
  }
  const paths = new Set([...pendingAppends.keys(), ...fileOperationQueues.keys()]);
  await Promise.all(Array.from(paths, (target) => queuePendingAppend(target)));
}

export function clearJsonLogStateForTests() {
  pendingAppends.clear();
  appendFlushScheduled.clear();
  fileOperationQueues.clear();
  ensuredLogDirs.clear();
}

process.once("beforeExit", () => {
  // setImmediate/fs operations normally keep Node alive; this is a final guard
  // for callers that append a last message while the event loop is draining.
  for (const filePath of pendingAppends.keys()) void queuePendingAppend(filePath);
});

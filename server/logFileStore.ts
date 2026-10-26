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

export const LOG_RETENTION_DAYS = 3;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 500;
const pendingAppends = new Map<string, Array<{ line: string; day: string }>>();
const pendingAppendBytes = new Map<string, number>();
// Include writes already captured by the serialized file-operation queue in
// the budget. Slow I/O must not turn that queue into an unbounded log buffer.
const queuedAppendBytes = new Map<string, number>();
const queuedAppendEntries = new Map<string, number>();
const pendingAppendDrops = new Map<string, number>();
const pendingAppendDropLoggedAt = new Map<string, number>();
const appendFlushScheduled = new Set<string>();
const fileOperationQueues = new Map<string, Promise<void>>();
const ensuredLogDirs = new Set<string>();
const MAX_PENDING_APPEND_ENTRIES = 10_000;
const MAX_PENDING_APPEND_BYTES = 4 * 1024 * 1024;

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

function ensureLogDir(dir = getLogDir()) {
  if (ensuredLogDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  ensuredLogDirs.add(dir);
}

function logDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function retentionStart(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS + 1);
  return cutoff;
}

export function datedJsonLogPath(filePath: string, day: string) {
  const extension = path.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}.${day}${extension}`;
}

function archivedLogDay(filePath: string, filename: string) {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  const prefix = `${stem}.`;
  if (!filename.startsWith(prefix) || !filename.endsWith(extension)) return null;
  const day = filename.slice(prefix.length, filename.length - extension.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

async function rotateJsonLogFile(filePath: string, now = new Date()) {
  const info = await fs.promises.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile() || logDay(info.mtime) >= logDay(now)) return;
  const archive = datedJsonLogPath(filePath, logDay(info.mtime));
  try {
    await fs.promises.access(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.promises.rename(filePath, archive);
    return;
  }
  // A restarted process or a clock adjustment may revisit an existing day.
  // Merge without replacing that day's earlier records or buffering a full log.
  for await (const chunk of fs.createReadStream(filePath)) await fs.promises.appendFile(archive, chunk);
  await fs.promises.unlink(filePath);
}

async function logFamilyFiles(filePath: string, includeExpired = false) {
  const files = await fs.promises.readdir(path.dirname(filePath), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const firstDay = logDay(retentionStart());
  return files.flatMap((file) => {
    if (!file.isFile()) return [];
    if (file.name === path.basename(filePath)) return [{ filePath, day: "9999" }];
    const day = archivedLogDay(filePath, file.name);
    return day && (includeExpired || day >= firstDay) ? [{ filePath: path.join(path.dirname(filePath), file.name), day }] : [];
  }).sort((a, b) => a.day.localeCompare(b.day));
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
  pendingAppendBytes.delete(filePath);
  const bytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.line, "utf8"), 0);
  const entries = chunks.length;
  queuedAppendBytes.set(filePath, (queuedAppendBytes.get(filePath) || 0) + bytes);
  queuedAppendEntries.set(filePath, (queuedAppendEntries.get(filePath) || 0) + entries);
  return queueFileOperation(filePath, async () => {
    try {
      ensureLogDir(path.dirname(filePath));
      await rotateJsonLogFile(filePath);
      const today = logDay(new Date());
      const groups = new Map<string, string[]>();
      for (const chunk of chunks) {
        const target = chunk.day === today ? filePath : datedJsonLogPath(filePath, chunk.day);
        const lines = groups.get(target) || [];
        lines.push(chunk.line);
        groups.set(target, lines);
      }
      for (const [target, lines] of groups) {
        const content = lines.join("");
        try {
          await fs.promises.appendFile(target, content, "utf8");
        } catch (error) {
          // The directory may have been removed by an external cleanup.
          try {
            const dir = path.dirname(target);
            ensuredLogDirs.delete(dir);
            await fs.promises.mkdir(dir, { recursive: true });
            ensuredLogDirs.add(dir);
            await fs.promises.appendFile(target, content, "utf8");
            continue;
          } catch {
            // A blocking last-resort write runs only on this error path.
          }
          try {
            fs.appendFileSync(target, content, "utf8");
          } catch (fallbackError) {
            reportLogFileError("append", target, fallbackError || error);
          }
        }
      }
    } finally {
      const remainingBytes = (queuedAppendBytes.get(filePath) || 0) - bytes;
      const remainingEntries = (queuedAppendEntries.get(filePath) || 0) - entries;
      if (remainingBytes > 0) queuedAppendBytes.set(filePath, remainingBytes);
      else queuedAppendBytes.delete(filePath);
      if (remainingEntries > 0) queuedAppendEntries.set(filePath, remainingEntries);
      else queuedAppendEntries.delete(filePath);
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

function recentEntry(entry: FileLogEntry, cutoff: number) {
  const time = new Date(entry.createdAt).getTime();
  return Number.isFinite(time) && time >= cutoff;
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
  ensureLogDir(path.dirname(filePath));
  const serialized = `${JSON.stringify(entry)}\n`;
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_PENDING_APPEND_BYTES) {
    recordPendingAppendDrop(filePath);
    return;
  }
  const chunks = pendingAppends.get(filePath) || [];
  let queuedBytes = pendingAppendBytes.get(filePath) || 0;
  const writingBytes = queuedAppendBytes.get(filePath) || 0;
  const writingEntries = queuedAppendEntries.get(filePath) || 0;
  let dropped = 0;
  while (
    chunks.length + writingEntries >= MAX_PENDING_APPEND_ENTRIES
    || queuedBytes + writingBytes + serializedBytes > MAX_PENDING_APPEND_BYTES
  ) {
    const removed = chunks.shift();
    if (removed === undefined) break;
    queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(removed.line, "utf8"));
    dropped += 1;
  }
  if (dropped > 0) recordPendingAppendDrop(filePath, dropped);
  if (writingEntries + chunks.length >= MAX_PENDING_APPEND_ENTRIES
    || writingBytes + queuedBytes + serializedBytes > MAX_PENDING_APPEND_BYTES) {
    if (chunks.length > 0) pendingAppendBytes.set(filePath, queuedBytes);
    else {
      pendingAppends.delete(filePath);
      pendingAppendBytes.delete(filePath);
    }
    recordPendingAppendDrop(filePath);
    return;
  }
  const createdAt = new Date(entry.createdAt);
  chunks.push({ line: serialized, day: logDay(Number.isFinite(createdAt.getTime()) ? createdAt : new Date()) });
  queuedBytes += serializedBytes;
  pendingAppends.set(filePath, chunks);
  pendingAppendBytes.set(filePath, queuedBytes);
  if (appendFlushScheduled.has(filePath)) return;
  appendFlushScheduled.add(filePath);
  setImmediate(() => {
    appendFlushScheduled.delete(filePath);
    void queuePendingAppend(filePath).catch(error => reportLogFileError("flush", filePath, error));
  });
}

function recordPendingAppendDrop(filePath: string, count = 1) {
  const dropped = (pendingAppendDrops.get(filePath) || 0) + Math.max(1, count);
  pendingAppendDrops.set(filePath, dropped);
  const now = Date.now();
  const lastLoggedAt = pendingAppendDropLoggedAt.get(filePath) || 0;
  if (now - lastLoggedAt < 60 * 1000) return;
  pendingAppendDropLoggedAt.set(filePath, now);
  process.stderr.write(`[ForwardX] log write backlog capped file=${filePath}; droppedPending=${dropped}\n`);
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
    await rotateJsonLogFile(filePath);
    const cutoff = retentionStart().getTime();
    for (const file of await logFamilyFiles(filePath)) {
      const stream = fs.createReadStream(file.filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of lines) {
        if (!line) continue;
        const entry = parseLogLine(line);
        if (!entry || !recentEntry(entry, cutoff)) continue;
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
    await rotateJsonLogFile(filePath);
    const logs: FileLogEntry[] = [];
    const cutoff = retentionStart().getTime();
    for (const file of await logFamilyFiles(filePath)) {
      const stream = fs.createReadStream(file.filePath, { encoding: "utf8" });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        const entry = line ? parseLogLine(line) : null;
        if (entry && recentEntry(entry, cutoff)) logs.push(entry);
      }
    }
    return logs;
  });
}

export function pruneJsonLogFile(filePath: string) {
  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
    await rotateJsonLogFile(filePath);
    const cutoff = retentionStart();
    const firstDay = logDay(cutoff);
    for (const file of await logFamilyFiles(filePath, true)) {
      if (file.day < firstDay) {
        await fs.promises.unlink(file.filePath);
        continue;
      }
      // Old installations used one mixed-day file: filter its lines too.
      const target = file.filePath;
      const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
      const input = fs.createReadStream(target, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      const output = fs.createWriteStream(tempPath, { encoding: "utf8", flags: "w" });
      try {
        for await (const line of lines) {
          const entry = line ? parseLogLine(line) : null;
          if (!entry || !recentEntry(entry, cutoff.getTime())) continue;
          if (!output.write(`${JSON.stringify(entry)}\n`)) await once(output, "drain");
        }
        output.end();
        await once(output, "finish");
        await fs.promises.rename(tempPath, target);
      } catch (error) {
        output.destroy();
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  });
}

export function clearJsonLogFile(filePath: string) {
  queuePendingAppend(filePath);
  return queueFileOperation(filePath, async () => {
    ensureLogDir(path.dirname(filePath));
    for (const file of await logFamilyFiles(filePath, true)) {
      if (file.filePath !== filePath) await fs.promises.unlink(file.filePath);
    }
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
  pendingAppendBytes.clear();
  queuedAppendBytes.clear();
  queuedAppendEntries.clear();
  pendingAppendDrops.clear();
  pendingAppendDropLoggedAt.clear();
  appendFlushScheduled.clear();
  fileOperationQueues.clear();
  ensuredLogDirs.clear();
}

process.once("beforeExit", () => {
  // setImmediate/fs operations normally keep Node alive; this is a final guard
  // for callers that append a last message while the event loop is draining.
  for (const filePath of pendingAppends.keys()) {
    void queuePendingAppend(filePath).catch(error => reportLogFileError("flush", filePath, error));
  }
});

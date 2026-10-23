import { performance } from "node:perf_hooks";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import superjson from "superjson";
import { displayQueries } from "./displayQueryCache";

type Entry = {
  value?: unknown;
  load: () => Promise<unknown>;
  pending?: Promise<unknown>;
  updatedAt: number;
  lastReadAt: number;
  retryAt: number;
  bytes: number;
};

/** Request reads never refresh an existing summary. A paced background worker
 * refreshes active keys; only a first miss builds this one user's summary.
 * The loaders must capture IDs/options, never HTTP contexts or auth objects.
 */
export function createBackgroundSummaryCache(options: {
  now?: () => number; refreshMs?: number; idleMs?: number; maxEntries?: number; maxBytes?: number;
  run?: <T>(load: () => Promise<T>) => Promise<T>;
} = {}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 60_000;
  const idleMs = options.idleMs ?? 15 * 60_000;
  const maxEntries = options.maxEntries ?? 5_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const entries = new Map<string, Entry>();
  let bytes = 0;
  let sweeping = false;
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
  };
  const trim = () => {
    for (const [key] of entries) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      remove(key);
    }
  };
  async function refresh(key: string, entry: Entry) {
    if (entry.pending) return entry.pending;
    const task = Promise.resolve().then(() => options.run ? options.run(entry.load) : entry.load()).then((value) => {
      if (entries.get(key) === entry) {
        const size = Buffer.byteLength(superjson.stringify(value));
        bytes += size - entry.bytes;
        entry.bytes = size; entry.value = value; entry.updatedAt = now(); entry.retryAt = 0;
        trim();
      }
      return value;
    }).catch((error) => {
      entry.retryAt = now() + 30_000;
      if (entry.value === undefined && entries.get(key) === entry) remove(key);
      throw error;
    }).finally(() => { if (entry.pending === task) entry.pending = undefined; });
    entry.pending = task;
    return task;
  }
  return {
    get<T>(key: string, load: () => Promise<T>): Promise<T> {
      let entry = entries.get(key);
      if (entry) {
        entry.lastReadAt = now(); entry.load = load;
        entries.delete(key); entries.set(key, entry); // O(1) LRU, no full-map sort per request.
        if (entry.value !== undefined) return Promise.resolve(entry.value as T);
        return refresh(key, entry) as Promise<T>;
      }
      entry = { load, updatedAt: 0, lastReadAt: now(), retryAt: 0, bytes: 0 };
      entries.set(key, entry); trim();
      return refresh(key, entry) as Promise<T>;
    },
    async refreshDue(budgetMs = 100) {
      if (sweeping) return { refreshed: 0, failed: 0 };
      sweeping = true;
      let refreshed = 0, failed = 0;
      const started = performance.now();
      try {
        // Oldest computed first, so a busy user's reads cannot starve other users.
        const due: Array<[string, Entry]> = [];
        for (const [key, entry] of entries) {
          if (now() - entry.lastReadAt > idleMs && !entry.pending) { remove(key); continue; }
          if (!entry.pending && now() - entry.updatedAt >= refreshMs && now() >= entry.retryAt) due.push([key, entry]);
        }
        due.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key, entry] of due) {
          if (entries.get(key) !== entry) continue;
          try { await refresh(key, entry); refreshed++; } catch { failed++; }
          await yieldToRequests();
          if (performance.now() - started >= budgetMs) break;
        }
      } finally { sweeping = false; }
      return { refreshed, failed };
    },
    clear(userIds?: number[]) {
      if (!userIds) { entries.clear(); bytes = 0; return; }
      const ids = new Set(userIds.map(String));
      for (const key of entries.keys()) if (ids.has(key.split(":", 1)[0])) remove(key);
    },
    size: () => ({ entries: entries.size, bytes }),
  };
}

export const dashboardSummaries = createBackgroundSummaryCache({ run: displayQueries.run });
// Administrative reports have a separate, smaller budget; they cannot evict
// ordinary users' home summaries when an admin explores many date ranges.
export const operationsSummaries = createBackgroundSummaryCache({ maxEntries: 300, maxBytes: 8 * 1024 * 1024, run: displayQueries.run });

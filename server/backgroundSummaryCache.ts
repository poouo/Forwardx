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
  maxBackgroundPending?: number;
  slowRefreshMs?: number;
  onSlowRefresh?: (key: string, elapsedMs: number) => void;
} = {}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 60_000;
  const idleMs = options.idleMs ?? 15 * 60_000;
  const maxEntries = options.maxEntries ?? 5_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxBackgroundPending = Math.max(1, Math.floor(options.maxBackgroundPending ?? 2));
  const slowRefreshMs = options.slowRefreshMs ?? 30_000;
  const entries = new Map<string, Entry>();
  // These slots outlive a scheduling slice (and cache invalidation). Never
  // release a slot just because we stopped waiting for an actual DB query.
  const backgroundPending = new Map<string, { startedAt: number; reported: boolean }>();
  let completed = 0, failures = 0;
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
      const started = performance.now();
      const budget = Math.max(1, Number.isFinite(budgetMs) ? budgetMs : 100);
      try {
        for (const [key, pending] of backgroundPending) {
          const elapsed = performance.now() - pending.startedAt;
          if (!pending.reported && elapsed >= slowRefreshMs) {
            pending.reported = true;
            options.onSlowRefresh?.(key, Math.round(elapsed));
          }
        }
        // Oldest computed first, so a busy user's reads cannot starve other users.
        const due: Array<[string, Entry]> = [];
        for (const [key, entry] of entries) {
          if (now() - entry.lastReadAt > idleMs && !entry.pending) { remove(key); continue; }
          if (!entry.pending && now() - entry.updatedAt >= refreshMs && now() >= entry.retryAt) due.push([key, entry]);
        }
        due.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key, entry] of due) {
          if (backgroundPending.size >= maxBackgroundPending || performance.now() - started >= budget) break;
          if (entries.get(key) !== entry || entry.pending || backgroundPending.has(key)) continue;
          backgroundPending.set(key, { startedAt: performance.now(), reported: false });
          // Handle completion even after this slice returns. A late failure
          // retains old data/backoff and is reported by the next slice.
          const task = refresh(key, entry).then(() => { completed++; }, () => { failures++; })
            .finally(() => { backgroundPending.delete(key); });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([task, new Promise<void>(resolve => {
              timer = setTimeout(resolve, Math.max(1, budget - (performance.now() - started)));
            })]);
          } finally { clearTimeout(timer); }
          await yieldToRequests();
        }
      } finally { sweeping = false; }
      const refreshed = completed, failed = failures;
      completed = 0; failures = 0;
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

function slowRefreshWarning(cache: string) {
  return (key: string, elapsedMs: number) => {
    // Keys are application-owned IDs/section names; never log query inputs or SQL values.
    const [userId, section] = key.split(":");
    console.warn(`[DashboardSummary] slow refresh cache=${cache} user=${Number(userId) || 0} section=${section} elapsedMs=${elapsedMs}; previous summary retained, pending query is not duplicated`);
  };
}
export const dashboardSummaries = createBackgroundSummaryCache({ run: displayQueries.run,
  onSlowRefresh: slowRefreshWarning("dashboard") });
// Administrative reports have a separate, smaller budget; they cannot evict
// ordinary users' home summaries when an admin explores many date ranges.
export const operationsSummaries = createBackgroundSummaryCache({ maxEntries: 300, maxBytes: 8 * 1024 * 1024,
  maxBackgroundPending: 1, run: displayQueries.run, onSlowRefresh: slowRefreshWarning("operations") });

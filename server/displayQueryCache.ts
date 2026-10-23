import { TRPCError } from "@trpc/server";
import superjson from "superjson";
import { createQueryCache, QueryCacheBusyError } from "./queryCache";

const busy = () => new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "服务繁忙，请稍后重试" });

/** Bound queued read work, not running SQL. A timeout never releases a running
 * SQL slot early, so slow DBs cannot accumulate abandoned background queries.
 * Loaders must not recursively call get/run on this same pool. */
export function createDisplayQueryCache(options: {
  concurrency?: number; maxQueued?: number; queueTimeoutMs?: number;
  maxEntries?: number; maxBytes?: number; now?: () => number;
} = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const maxQueued = Math.max(0, options.maxQueued ?? 128);
  const cache = createQueryCache({
    maxEntries: options.maxEntries ?? 2000,
    maxBytes: options.maxBytes ?? 24 * 1024 * 1024,
    sizeOf: (value) => Buffer.byteLength(superjson.stringify(value)),
    now: options.now,
  });
  let active = 0;
  const queue = new Set<{ start: () => void }>();

  async function limited<T>(load: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      if (queue.size >= maxQueued) throw busy();
      await new Promise<void>((resolve, reject) => {
        const waiter = { start: () => { clearTimeout(timer); active++; resolve(); } };
        const timer = setTimeout(() => { queue.delete(waiter); reject(busy()); }, options.queueTimeoutMs ?? 2000);
        queue.add(waiter);
      });
    } else active++;
    try { return await load(); }
    finally {
      active--;
      const waiter = queue.values().next().value;
      if (waiter) { queue.delete(waiter); waiter.start(); }
    }
  }

  function get<T>(user: { id: number; role: string }, section: string, input: unknown,
    load: () => Promise<T>, timing = { ttlMs: 2000, staleMs: 8000 }): Promise<T> {
    const key = `${user.role}:${user.id}:${section}:${JSON.stringify(input)}`;
    // Avoid retaining huge ACL/filter keys; still bound their DB work.
    if (key.length > 16384) return limited(load);
    return cache.get(key, timing, () => limited(load)).catch((error) => {
      if (error instanceof QueryCacheBusyError) throw busy();
      throw error;
    });
  }

  function invalidate(user?: { id: number; role: string }) {
    if (!user || user.role === "admin") cache.clear();
    else cache.clear((key) => key.startsWith(`${user.role}:${user.id}:`) || key.startsWith("admin:") || key.startsWith("metrics:"));
  }
  // Only physical measurements may be shared across viewers. Callers must
  // authorize the host IDs on every request before returning these values.
  function metrics<T>(section: string, ids: number[] | undefined, load: () => Promise<T>) {
    return get({ id: 0, role: "metrics" }, section,
      ids ? [...new Set(ids)].sort((a, b) => a - b) : "all", load);
  }
  return { get, metrics, invalidate, run: limited, stats: () => ({ entries: cache.size(), bytes: cache.bytes(), active, queued: queue.size }) };
}

// Display only. Never use for authentication, authorization, balance checks,
// payment/redemption execution or traffic-limit enforcement.
export const displayQueries = createDisplayQueryCache();

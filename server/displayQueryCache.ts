import { TRPCError } from "@trpc/server";
import superjson from "superjson";
import { createQueryCache, QueryCacheBusyError } from "./queryCache";
import { createRequestWorkPool } from "./requestWorkPool";
import { SERVICE_BUSY_MESSAGE } from "../shared/databaseHealth";

const busy = () => new TRPCError({ code: "SERVICE_UNAVAILABLE", message: SERVICE_BUSY_MESSAGE });

/** Bound queued read work, not running SQL. A timeout never releases a running
 * SQL slot early, so slow DBs cannot accumulate abandoned background queries.
 * Loaders must not recursively call get/run on this same pool. */
export function createDisplayQueryCache(options: {
  concurrency?: number; maxQueued?: number; queueTimeoutMs?: number;
  maxEntries?: number; maxBytes?: number; now?: () => number;
} = {}) {
  // A loader can issue several SQL queries. Keep room for auth, Agent reports
  // and writes even on the smallest (16-connection) MySQL pool.
  const pool = createRequestWorkPool({ concurrency: Math.max(1, options.concurrency ?? 8),
    maxQueued: Math.max(0, options.maxQueued ?? 64), queueTimeoutMs: options.queueTimeoutMs ?? 1500 });
  const cache = createQueryCache({
    maxEntries: options.maxEntries ?? 2000,
    maxBytes: options.maxBytes ?? 24 * 1024 * 1024,
    sizeOf: (value) => Buffer.byteLength(superjson.stringify(value)),
    now: options.now,
  });
  const limited = pool.run;

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
  return { get, metrics, invalidate, run: limited, stats: () => ({ entries: cache.size(), bytes: cache.bytes(), ...pool.stats() }) };
}

// Display only. Never use for authentication, authorization, balance checks,
// payment/redemption execution or traffic-limit enforcement.
export const displayQueries = createDisplayQueryCache();

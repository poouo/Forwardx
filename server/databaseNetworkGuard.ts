import { AsyncLocalStorage } from "node:async_hooks";

type Driver = "mysql" | "postgresql";
type Limits = { maxOpen: number; queueLimit: number; connectTimeoutMillis: number };
type GuardOptions = {
  queryTimeoutMs?: number;
  idleLeaseTimeoutMs?: number;
  closeTimeoutMs?: number;
};

export const DATABASE_QUERY_TIMEOUT_MS = 30_000;
export const DATABASE_MAINTENANCE_TIMEOUT_MS = 5 * 60_000;
const queryBudget = new AsyncLocalStorage<number>();

// A longer, still finite per-statement budget for initialization/backfills.
// It is scoped to that async workflow, never to other users' concurrent reads.
export function withDatabaseMaintenanceBudget<T>(work: () => T): T {
  return queryBudget.run(DATABASE_MAINTENANCE_TIMEOUT_MS, work);
}

export class DatabaseNetworkTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly phase: "acquire" | "query" | "lease" | "close") {
    super(`Database ${phase} deadline exceeded; connection discarded`);
    this.name = "DatabaseNetworkTimeoutError";
  }
}

function busyError() {
  return Object.assign(new Error("Database connection wait limit reached"), { code: "POOL_ENQUEUELIMIT" });
}

function brokenConnection(error: any): boolean {
  return error?.fatal === true
    || /^(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST|PROTOCOL_SEQUENCE_TIMEOUT|57P0[123]|08\w{3})$/.test(String(error?.code || ""))
    || /query read timeout|connection terminated|connection is closed/i.test(String(error?.message || ""));
}

function destroyConnection(client: any, driver: Driver) {
  // mysql2.destroy() alone sends FIN; explicitly destroy the socket as well so
  // an unresponsive peer cannot leave a half-open connection/command behind.
  // Supplying an error also settles mysql2's active and queued command callbacks.
  const error = new DatabaseNetworkTimeoutError("query");
  if (driver === "mysql") {
    client.connection?.once?.("error", () => {});
    try { client.connection?.stream?.destroy(error); } catch { /* continue cleanup */ }
    try { client.destroy(); } catch { /* already disconnected */ }
  } else {
    try { client.connection?.stream?.destroy(); } catch { /* continue cleanup */ }
    try { client.release(true); } catch { /* already removed */ }
  }
}

function destroyMysqlHandshake(connection: any) {
  // mysql2 clears its connectTimeout on the first received packet, even if
  // authentication never completes. Retain the core connection created by
  // this checkout and hard-close it at our acquisition deadline as well.
  connection.once?.("error", () => {});
  try { connection.stream?.destroy(new DatabaseNetworkTimeoutError("acquire")); } catch { /* continue */ }
  try { connection.destroy(); } catch { /* already disconnected */ }
}

function guardedLease(client: any, driver: Driver, done: () => void, options: GuardOptions) {
  let closed = false;
  const idleTimeoutMs = options.idleLeaseTimeoutMs ?? Math.max(120_000, queryBudget.getStore() || 0);
  const pending = new Set<(error: Error) => void>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (error?: Error) => {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    try {
      if (error || pending.size) destroyConnection(client, driver);
      else client.release();
    } catch {
      destroyConnection(client, driver);
    }
    // Clear the physical connection before freeing admission/query slots.
    for (const reject of pending) reject(error || new Error("Database lease released"));
    pending.clear();
    done();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (closed || pending.size) return;
    idleTimer = setTimeout(() => dispose(new DatabaseNetworkTimeoutError("lease")), idleTimeoutMs);
    idleTimer.unref();
  };
  armIdle();
  const proxy = new Proxy(client, {
    get(target, key) {
      if (key === "release") return (error?: unknown) => dispose(error ? new Error("Database client discarded") : undefined);
      if (key === "destroy") return () => dispose(new Error("Database client discarded"));
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!["query", "execute", "beginTransaction", "commit", "rollback", "ping", "reset"].includes(String(key))) return value.bind(target);
      return (...args: any[]) => {
        if (closed) return Promise.reject(Object.assign(new Error("Database connection is closed"), { code: "PROTOCOL_CONNECTION_LOST" }));
        clearTimeout(idleTimer);
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.sql || args[0]?.text || "";
        const ddl = /^\s*(CREATE|ALTER|DROP|ANALYZE|VACUUM|REINDEX)\b/i.test(sql);
        const timeoutMs = options.queryTimeoutMs ?? queryBudget.getStore() ?? (ddl ? DATABASE_MAINTENANCE_TIMEOUT_MS : DATABASE_QUERY_TIMEOUT_MS);
        return new Promise((resolve, reject) => {
          let finished = false;
          const settle = (error: unknown, result?: unknown) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            pending.delete(abort);
            armIdle();
            if (error) reject(error); else resolve(result);
          };
          const abort = (error: Error) => settle(error);
          const timer = setTimeout(() => dispose(new DatabaseNetworkTimeoutError("query")), timeoutMs);
          pending.add(abort);
          // Attach both handlers even after cancellation: late driver failures
          // must not become unhandled rejections. Never retry uncertain writes.
          Promise.resolve().then(() => {
            if (closed) throw new Error("Database connection is closed");
            return Reflect.apply(value, target, args);
          }).then(result => settle(null, result), error => {
            if (brokenConnection(error)) dispose(error);
            settle(error);
          });
        });
      };
    },
  });
  return { client: proxy, abort: (error: Error) => dispose(error) };
}

// Own the wait queue so timed-out entries are actually removed (mysql2's pool
// has no acquire timeout). Every SQL call owns a client, making cancellation
// safe: never kill another request's connection or return a busy one to pool.
export function guardDatabasePool<T extends object>(pool: T, driver: Driver, limits: () => Limits, options: GuardOptions = {}): T {
  const raw = pool as any;
  const queue = new Set<{ start: () => void; cancel: () => void }>();
  const waiting = new Set<{ start: () => void; cancel: () => void }>();
  const leases = new Set<ReturnType<typeof guardedLease>>();
  let active = 0;
  let ending = false;
  let endPromise: Promise<void> | undefined;
  const pump = () => {
    while (!ending && active < limits().maxOpen && queue.size) {
      const next = queue.values().next().value!;
      queue.delete(next);
      next.start();
    }
  };
  const acquire = () => new Promise<any>((resolve, reject) => {
    if (ending) { reject(new Error("Database pool is closed")); return; }
    if (active >= limits().maxOpen && queue.size >= limits().queueLimit) { reject(busyError()); return; }
    let expired = false;
    let dispatched = false;
    let connectingMysql: any;
    const timer = setTimeout(() => {
      expired = true;
      queue.delete(waiter);
      waiting.delete(waiter);
      // A dispatched connect retains its slot until the driver acknowledges
      // closure/failure, preventing a reconnect storm during an outage.
      reject(dispatched ? new DatabaseNetworkTimeoutError("acquire") : busyError());
      if (connectingMysql) destroyMysqlHandshake(connectingMysql);
    }, limits().connectTimeoutMillis);
    const waiter = {
      cancel: () => {
        expired = true;
        clearTimeout(timer);
        reject(new Error("Database pool is closed"));
        if (connectingMysql) destroyMysqlHandshake(connectingMysql);
      },
      start: () => {
        dispatched = true;
        active++;
        Promise.resolve().then(() => {
          if (expired || ending) throw new Error("Database pool is closed");
          if (driver !== "mysql") return raw.connect();
          // mysql2 creates a core connection synchronously during checkout.
          // Only capture the newly created one; never close another lease.
          const connections = raw.pool?._allConnections;
          const previousCount = connections?.length ?? 0;
          const result = raw.getConnection();
          if (connections?.length > previousCount) connectingMysql = connections.get(previousCount);
          return result;
        }).then(client => {
          clearTimeout(timer);
          connectingMysql = undefined;
          waiting.delete(waiter);
          if (expired || ending) {
            destroyConnection(client, driver);
            active--;
            pump();
            return;
          }
          const lease = guardedLease(client, driver, () => {
            leases.delete(lease);
            active--;
            pump();
          }, options);
          leases.add(lease);
          resolve(lease.client);
        }, error => {
          clearTimeout(timer);
          connectingMysql = undefined;
          waiting.delete(waiter);
          active--;
          if (!expired) reject(error);
          pump();
        });
      },
    };
    waiting.add(waiter);
    if (active < limits().maxOpen) waiter.start(); else queue.add(waiter);
  });
  const end = () => endPromise ??= (async () => {
    ending = true;
    for (const waiter of waiting) waiter.cancel();
    waiting.clear();
    queue.clear();
    for (const lease of [...leases]) lease.abort(new Error("Database pool is closed"));
    // Idle/connecting clients are not leases yet. Force socket cleanup here
    // if the driver's graceful shutdown does not finish.
    const force = () => {
      const clients = driver === "mysql" ? raw.pool?._allConnections?.toArray() || [] : raw._clients || [];
      for (const client of [...clients]) {
        try { (driver === "mysql" ? client.stream : client.connection?.stream)?.destroy(); } catch { /* continue */ }
        if (driver === "mysql") { try { client.destroy(); } catch { /* continue */ } }
      }
    };
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { force(); resolve(); }, options.closeTimeoutMs ?? 1_000);
      Promise.resolve().then(() => raw.end()).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); force(); resolve(); });
    });
  })();
  return new Proxy(pool, {
    get(target, key) {
      if (key === "end") return end;
      if (key === (driver === "mysql" ? "getConnection" : "connect")) return acquire;
      if (key === "query" || (driver === "mysql" && key === "execute")) return async (...args: any[]) => {
        const client = await acquire();
        try { return await client[key](...args); } finally { client.release(); }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

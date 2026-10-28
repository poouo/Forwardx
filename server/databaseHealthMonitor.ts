import mysql from "mysql2/promise";
import pg from "pg";
import { databaseHealth } from "./databaseHealthState";
import { getSqlite, readDatabaseConfig, withSqliteExclusive, type DatabaseConfig } from "./dbRuntime";
import { MYSQL_COMPATIBILITY_FLAGS } from "./mysqlCompatibility";
import { guardDatabasePool } from "./databaseNetworkGuard";

export async function probeDatabase(config: DatabaseConfig) {
  // Separate, bounded diagnostic connections cannot queue behind business
  // queries or accumulate in the main pool during an outage.
  if (config.type === "postgresql") {
    const pool = guardDatabasePool(new pg.Pool({ ...config.postgresql, ssl: config.postgresql.ssl ? true : undefined, max: 1, connectionTimeoutMillis: 3000 }), "postgresql", () => ({ maxOpen: 1, queueLimit: 1, connectTimeoutMillis: 3000 }), { queryTimeoutMs: 3000 });
    pool.on("error", () => {}); // Query errors are reported by the monitor.
    try { await pool.query("SELECT 1"); } finally { await pool.end(); }
    return;
  }
  if (config.type === "mysql") {
    const pool = guardDatabasePool(mysql.createPool({ ...config.mysql, flags: MYSQL_COMPATIBILITY_FLAGS, ssl: config.mysql.ssl ? {} : undefined, connectTimeout: 3000, connectionLimit: 1, maxIdle: 1 }), "mysql", () => ({ maxOpen: 1, queueLimit: 1, connectTimeoutMillis: 3000 }), { queryTimeoutMs: 3000 });
    try { await pool.query("SELECT 1"); } finally { await pool.end(); }
    return;
  }
  // Reuse the SQLite handle and its transaction-safe connection lock.
  if (getSqlite()) await withSqliteExclusive((sqlite) => {
    sqlite.prepare("SELECT 1").get();
  });
}

export function startDatabaseHealthMonitor(options: {
  initialized: boolean;
  initialize: () => Promise<{ ready: boolean }>;
  onReady: () => void;
  probe?: typeof probeDatabase;
  readConfig?: typeof readDatabaseConfig;
  intervalMs?: number;
}) {
  let initialized = options.initialized;
  let running = false;
  let stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const config = (options.readConfig || readDatabaseConfig)();
      if (!config) { databaseHealth.notConfigured(); return; }
      databaseHealth.configure(config.type);
      await (options.probe || probeDatabase)(config);
      // A successful SELECT does not prove SQLite can write or that a corrupt
      // database has been repaired. Do not falsely clear storage errors.
      if (/^SQLITE_(FULL|READONLY|CORRUPT|NOTADB|IOERR)$/.test(databaseHealth.snapshot().reason?.code || "")) return;
      if (!initialized) {
        // Only connectivity failures are retried automatically. Re-running
        // migrations repeatedly cannot repair a schema/configuration failure.
        if (!databaseHealth.canRetryInitialization()) return;
        const result = await options.initialize();
        if (!result.ready) return;
        initialized = true;
        options.onReady();
      }
      databaseHealth.healthy();
    } catch (error) {
      databaseHealth.unavailable(error, !initialized, true);
    } finally { running = false; }
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs || 15_000);
  timer.unref();
  return { check, stop: () => { stopped = true; clearInterval(timer); } };
}

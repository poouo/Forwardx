import mysql from "mysql2/promise";
import pg from "pg";
import { databaseHealth, describeDatabaseError, isDatabaseBusyError } from "./databaseHealthState";
import { getSqlite, readDatabaseConfig, withSqliteExclusive, type DatabaseConfig } from "./dbRuntime";
import { MYSQL_COMPATIBILITY_FLAGS } from "./mysqlCompatibility";
import { guardDatabasePool } from "./databaseNetworkGuard";
import { performance } from "node:perf_hooks";

function boundedSetting(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return value !== undefined && String(value).trim() !== "" && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

export function databaseHealthMonitorSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    intervalMs: boundedSetting(env.FORWARDX_DB_HEALTH_INTERVAL_MS, 15_000, 5_000, 300_000),
    timeoutMs: boundedSetting(env.FORWARDX_DB_HEALTH_TIMEOUT_MS, 6_000, 1_000, 60_000),
    failureThreshold: boundedSetting(env.FORWARDX_DB_HEALTH_FAILURE_THRESHOLD, 3, 1, 10),
  };
}

export async function probeDatabase(config: DatabaseConfig, options: { timeoutMs?: number } = {}) {
  const timeout = options.timeoutMs ?? databaseHealthMonitorSettings().timeoutMs;
  // Separate, bounded diagnostic connections cannot queue behind business
  // queries or accumulate in the main pool during an outage.
  if (config.type === "postgresql") {
    const pool = guardDatabasePool(new pg.Pool({ ...config.postgresql, ssl: config.postgresql.ssl ? true : undefined, max: 1, connectionTimeoutMillis: timeout }), "postgresql", () => ({ maxOpen: 1, queueLimit: 1, connectTimeoutMillis: timeout }), { queryTimeoutMs: timeout });
    pool.on("error", () => {}); // Query errors are reported by the monitor.
    try { await pool.query("SELECT 1"); } finally { await pool.end(); }
    return;
  }
  if (config.type === "mysql") {
    const pool = guardDatabasePool(mysql.createPool({ ...config.mysql, flags: MYSQL_COMPATIBILITY_FLAGS, ssl: config.mysql.ssl ? {} : undefined, connectTimeout: timeout, connectionLimit: 1, maxIdle: 1 }), "mysql", () => ({ maxOpen: 1, queueLimit: 1, connectTimeoutMillis: timeout }), { queryTimeoutMs: timeout });
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
  timeoutMs?: number;
  failureThreshold?: number;
  logger?: Pick<typeof console, "warn">;
}) {
  const settings = databaseHealthMonitorSettings();
  const threshold = boundedSetting(options.failureThreshold, settings.failureThreshold, 1, 10);
  const logger = options.logger ?? console;
  let initialized = options.initialized;
  let running = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let configIdentity = "";
  let lastWarning = Number.NEGATIVE_INFINITY;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    const started = performance.now();
    const eventLoop = performance.eventLoopUtilization();
    try {
      const config = (options.readConfig || readDatabaseConfig)();
      if (!config) { consecutiveFailures = 0; configIdentity = ""; databaseHealth.notConfigured(); return; }
      const identity = JSON.stringify(config);
      if (identity !== configIdentity) { consecutiveFailures = 0; configIdentity = identity; }
      databaseHealth.configure(config.type);
      await (options.probe || probeDatabase)(config, { timeoutMs: options.timeoutMs ?? settings.timeoutMs });
      if (stopped) return;
      consecutiveFailures = 0;
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
      if (stopped) return;
      consecutiveFailures++;
      const reason = describeDatabaseError(error);
      const transient = isDatabaseBusyError(error) || reason?.code === "ETIMEDOUT"
        || /^(ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|CONNECTION_LOST|PROTOCOL_CONNECTION_LOST|57P0[123]|08[A-Z0-9]{3})$/.test(reason?.code || "");
      if (initialized && transient && databaseHealth.snapshot().state === "healthy" && consecutiveFailures < threshold) {
        if (Date.now() - lastWarning >= 60_000) {
          lastWarning = Date.now();
          const utilization = performance.eventLoopUtilization(eventLoop).utilization;
          logger.warn(`[DatabaseHealth] probe delayed code=${reason?.code || "DATABASE_BUSY"} failures=${consecutiveFailures}/${threshold} durationMs=${Math.round(performance.now() - started)} eventLoopUtilization=${utilization.toFixed(3)}; awaiting confirmation, last healthy state retained`);
        }
        return;
      }
      databaseHealth.unavailable(error, !initialized, true);
    } finally { running = false; }
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs || settings.intervalMs);
  timer.unref();
  return { check, stop: () => { stopped = true; clearInterval(timer); } };
}

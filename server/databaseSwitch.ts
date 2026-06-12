import crypto from "crypto";
import fs from "fs";
import path from "path";
import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";
import pg from "pg";
import Database from "better-sqlite3";
import { MIGRATION_TABLES, ensureDatabaseSchema, getDatabaseTableDefs, type ColumnDef } from "./dbSchema";
import {
  type DatabaseConfig,
  type DatabaseKind,
  defaultSqlitePath,
  getDatabaseKind,
  getDatabasePoolSettings,
  getSchemaDialect,
  maskDatabaseConfig,
  readDatabaseConfig,
  reconnectDatabase,
  testDatabaseConnection,
  writeDatabaseConfig,
} from "./dbRuntime";
import { ENV } from "./env";
import { exportMigrationSnapshot, summarizeMigrationSnapshot, type MigrationSnapshotSummary } from "./migration";
import { maintainPostgresqlDatabase } from "./postgresqlMaintenance";

export type DatabaseSwitchJobStatus = "pending" | "running" | "success" | "failed";

export interface DatabaseSwitchJob {
  id: string;
  status: DatabaseSwitchJobStatus;
  progress: number;
  step: string;
  message?: string;
  error?: string;
  sourceType?: DatabaseKind | null;
  targetType?: DatabaseKind;
  restartRequired?: boolean;
  summary?: MigrationSnapshotSummary;
  inserted?: Record<string, number>;
  startedAt: number;
  finishedAt?: number;
}

type TargetHandle =
  | { kind: "mysql"; pool: Pool }
  | { kind: "postgresql"; pool: pg.Pool }
  | { kind: "sqlite"; sqlite: Database.Database };

type TargetSession =
  | { kind: "mysql"; executor: PoolConnection }
  | { kind: "postgresql"; executor: pg.PoolClient }
  | { kind: "sqlite"; executor: Database.Database };

const jobs = new Map<string, DatabaseSwitchJob>();
const tableDefs = new Map(getDatabaseTableDefs().map((table) => [table.name, table]));
let activeJobId: string | null = null;
let restartScheduled = false;

function setJob(job: DatabaseSwitchJob, patch: Partial<DatabaseSwitchJob>) {
  Object.assign(job, {
    ...patch,
    progress: patch.progress === undefined ? job.progress : Math.max(0, Math.min(100, Math.round(patch.progress))),
  });
  jobs.set(job.id, job);
}

export function getDatabaseSwitchJob(id: string) {
  return jobs.get(id) || null;
}

export function getDatabaseSwitchStatus() {
  const current = readDatabaseConfig();
  const activeJob = activeJobId ? getDatabaseSwitchJob(activeJobId) : null;
  return {
    current: maskDatabaseConfig(current),
    currentType: current?.type ?? null,
    activeType: getDatabaseKind(),
    schemaDialect: getSchemaDialect(),
    defaultSqlitePath: defaultSqlitePath(),
    blockedReason: databaseEnvironmentOverrideReason(),
    activeJob,
  };
}

function databaseEnvironmentOverrideReason() {
  if (String(ENV.databaseType || "").trim()) {
    return "当前服务通过 DATABASE_TYPE/DB_TYPE 强制指定数据库类型，面板内切换不会在重启后生效，请先移除该环境变量。";
  }
  if (String(ENV.mysqlUrl || "").trim() || (ENV.mysqlHost && ENV.mysqlUser && ENV.mysqlDatabase)) {
    return "当前服务通过 MySQL 环境变量指定数据库连接，面板内切换不会在重启后生效，请先移除 MYSQL_URL 或 MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE。";
  }
  if (String(ENV.postgresUrl || "").trim() || (ENV.postgresHost && ENV.postgresUser && ENV.postgresDatabase)) {
    return "当前服务通过 PostgreSQL 环境变量指定数据库连接，面板内切换不会在重启后生效，请先移除 POSTGRES_URL 或 POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE。";
  }
  return null;
}

function normalizeMysqlConfig(config: DatabaseConfig & { type: "mysql" }) {
  return {
    host: config.mysql.host.trim(),
    port: Number(config.mysql.port || 3306),
    user: config.mysql.user.trim(),
    password: config.mysql.password || "",
    database: config.mysql.database.trim(),
    ssl: !!config.mysql.ssl,
  };
}

function normalizePostgresqlConfig(config: DatabaseConfig & { type: "postgresql" }) {
  return {
    host: config.postgresql.host.trim(),
    port: Number(config.postgresql.port || 5432),
    user: config.postgresql.user.trim(),
    password: config.postgresql.password || "",
    database: config.postgresql.database.trim(),
    ssl: !!config.postgresql.ssl,
  };
}

function normalizeSqlitePath(config: DatabaseConfig & { type: "sqlite" }) {
  const raw = (config.sqlite.path || defaultSqlitePath()).trim() || defaultSqlitePath();
  return path.resolve(raw);
}

function sameDatabaseLocation(a: DatabaseConfig | null, b: DatabaseConfig) {
  if (!a || a.type !== b.type) return false;
  if (a.type === "sqlite" && b.type === "sqlite") {
    return path.resolve(a.sqlite.path) === normalizeSqlitePath(b);
  }
  if (a.type === "mysql" && b.type === "mysql") {
    const left = normalizeMysqlConfig(a);
    const right = normalizeMysqlConfig(b);
    return left.host.toLowerCase() === right.host.toLowerCase()
      && left.port === right.port
      && left.database === right.database;
  }
  if (a.type === "postgresql" && b.type === "postgresql") {
    const left = normalizePostgresqlConfig(a);
    const right = normalizePostgresqlConfig(b);
    return left.host.toLowerCase() === right.host.toLowerCase()
      && left.port === right.port
      && left.database === right.database;
  }
  return false;
}

function assertSwitchAllowed(target: DatabaseConfig) {
  const blockedReason = databaseEnvironmentOverrideReason();
  if (blockedReason) throw new Error(blockedReason);
  if (sameDatabaseLocation(readDatabaseConfig(), target)) {
    throw new Error("目标数据库与当前数据库相同，无需执行迁移切换。");
  }
}

export async function testDatabaseSwitchTarget(target: DatabaseConfig) {
  assertSwitchAllowed(target);
  await testDatabaseConnection(target);
  return { success: true };
}

function mysqlPoolOptions(config: DatabaseConfig & { type: "mysql" }): PoolOptions {
  const mysqlConfig = normalizeMysqlConfig(config);
  const pool = getDatabasePoolSettings();
  return {
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    waitForConnections: true,
    connectionLimit: pool.maxOpen,
    maxIdle: pool.maxIdle,
    idleTimeout: pool.idleTimeoutMillis,
    queueLimit: 0,
    connectTimeout: pool.connectTimeoutMillis,
    timezone: "+00:00",
    dateStrings: false,
    ssl: mysqlConfig.ssl ? {} : undefined,
  };
}

function postgresqlPoolOptions(config: DatabaseConfig & { type: "postgresql" }): pg.PoolConfig {
  const postgresqlConfig = normalizePostgresqlConfig(config);
  const pool = getDatabasePoolSettings();
  const options: pg.PoolConfig & { maxLifetimeSeconds?: number } = {
    host: postgresqlConfig.host,
    port: postgresqlConfig.port,
    user: postgresqlConfig.user,
    password: postgresqlConfig.password,
    database: postgresqlConfig.database,
    max: pool.maxOpen,
    idleTimeoutMillis: pool.idleTimeoutMillis,
    connectionTimeoutMillis: pool.connectTimeoutMillis,
    maxLifetimeSeconds: pool.maxLifetimeSeconds,
    ssl: postgresqlConfig.ssl ? { rejectUnauthorized: false } : undefined,
  };
  return options;
}

async function openTarget(config: DatabaseConfig): Promise<TargetHandle> {
  if (config.type === "mysql") {
    const pool = mysql.createPool(mysqlPoolOptions(config));
    await pool.query("SELECT 1");
    return { kind: "mysql", pool };
  }
  if (config.type === "postgresql") {
    const pool = new pg.Pool(postgresqlPoolOptions(config));
    await pool.query("SELECT 1");
    return { kind: "postgresql", pool };
  }
  const sqlitePath = normalizeSqlitePath(config);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.prepare("SELECT 1").get();
  return { kind: "sqlite", sqlite };
}

async function closeTarget(handle: TargetHandle | null) {
  if (!handle) return;
  if (handle.kind === "mysql") {
    await handle.pool.end().catch(() => undefined);
    return;
  }
  if (handle.kind === "postgresql") {
    await handle.pool.end().catch(() => undefined);
    return;
  }
  try {
    handle.sqlite.close();
  } catch {
    // Ignore close failures during cleanup.
  }
}

function quote(kind: DatabaseKind, id: string) {
  if (kind === "mysql") return `\`${id.replace(/`/g, "``")}\``;
  return `"${id.replace(/"/g, "\"\"")}"`;
}

function postgresSql(sqlText: string, params: any[] = []) {
  let index = 0;
  return {
    text: sqlText.replace(/\?/g, () => `$${++index}`),
    values: params,
  };
}

function normalizeTargetValue(value: any, kind: DatabaseKind) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean" && kind !== "postgresql") return value ? 1 : 0;
  return value;
}

async function targetQuery<T = Record<string, any>>(session: TargetSession, sqlText: string, params: any[] = []): Promise<T[]> {
  const normalized = params.map((value) => normalizeTargetValue(value, session.kind));
  if (session.kind === "mysql") {
    const [rows] = await session.executor.query(sqlText, normalized);
    return rows as T[];
  }
  if (session.kind === "postgresql") {
    const result = await session.executor.query(postgresSql(sqlText, normalized));
    return result.rows as T[];
  }
  return session.executor.prepare(sqlText).all(...normalized) as T[];
}

async function targetExecute(session: TargetSession, sqlText: string, params: any[] = []) {
  const normalized = params.map((value) => normalizeTargetValue(value, session.kind));
  if (session.kind === "mysql") {
    const [result] = await session.executor.execute(sqlText, normalized);
    return result;
  }
  if (session.kind === "postgresql") {
    return session.executor.query(postgresSql(sqlText, normalized));
  }
  return session.executor.prepare(sqlText).run(...normalized);
}

function normalizeColumnValue(value: any, kind: DatabaseKind, column: ColumnDef) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (column.type === "bool") {
    const boolValue = value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
    return kind === "postgresql" ? boolValue : boolValue ? 1 : 0;
  }
  if (column.type === "id" || column.type === "int" || column.type === "epoch") {
    if (value === "") return null;
    if (column.type === "epoch" && typeof value === "string") {
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate)) return Math.floor(parsedDate / 1000);
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : value;
  }
  if (column.type === "bigint" && typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

async function targetTableCount(session: TargetSession, table: string) {
  const rows = await targetQuery<{ count: number | string }>(
    session,
    `SELECT COUNT(*) as ${quote(session.kind, "count")} FROM ${quote(session.kind, table)}`,
  );
  return Number(rows[0]?.count || 0);
}

async function assertTargetHasNoBusinessData(session: TargetSession) {
  const blockingTables: string[] = [];
  for (const table of MIGRATION_TABLES) {
    const count = await targetTableCount(session, table);
    if (table !== "system_settings" && count > 0) {
      blockingTables.push(`${table}(${count})`);
    }
  }
  if (blockingTables.length > 0) {
    throw new Error(`目标数据库不是空库，请先使用新的空数据库。已发现数据表：${blockingTables.slice(0, 6).join("、")}${blockingTables.length > 6 ? " 等" : ""}`);
  }
}

async function insertTargetRow(session: TargetSession, table: string, row: Record<string, any>) {
  const tableDef = tableDefs.get(table);
  if (!tableDef) return false;
  if (table === "system_settings") {
    const key = String(row.key || "");
    if (!key) return false;
    await targetExecute(session, `DELETE FROM ${quote(session.kind, table)} WHERE ${quote(session.kind, "key")} = ?`, [key]);
  }
  const columns = tableDef.columns.filter((column) => row[column.name] !== undefined);
  if (columns.length === 0) return false;
  const columnSql = columns.map((column) => quote(session.kind, column.name)).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const values = columns.map((column) => normalizeColumnValue(row[column.name], session.kind, column));
  await targetExecute(
    session,
    `INSERT INTO ${quote(session.kind, table)} (${columnSql}) VALUES (${placeholders})`,
    values,
  );
  return true;
}

function databaseSettingsForTarget(target: DatabaseConfig) {
  return {
    databaseConfigured: "true",
    databaseType: target.type,
    mysqlConfigured: target.type === "mysql" ? "true" : "false",
    mysqlHost: target.type === "mysql" ? target.mysql.host.trim() : "",
    mysqlDatabase: target.type === "mysql" ? target.mysql.database.trim() : "",
    postgresqlConfigured: target.type === "postgresql" ? "true" : "false",
    postgresqlHost: target.type === "postgresql" ? target.postgresql.host.trim() : "",
    postgresqlDatabase: target.type === "postgresql" ? target.postgresql.database.trim() : "",
    sqlitePath: target.type === "sqlite" ? target.sqlite.path.trim() : "",
    setupDataChoice: "use-existing",
    databaseSwitchLastAt: String(Math.floor(Date.now() / 1000)),
  } satisfies Record<string, string>;
}

async function upsertTargetSetting(session: TargetSession, key: string, value: string | null) {
  const now = Math.floor(Date.now() / 1000);
  await insertTargetRow(session, "system_settings", { key, value, updatedAt: now });
}

async function syncTargetPostgresqlSequences(session: TargetSession) {
  if (session.kind !== "postgresql") return;
  for (const table of MIGRATION_TABLES) {
    const tableDef = tableDefs.get(table);
    if (!tableDef?.columns.some((column) => column.type === "id")) continue;
    const tableName = quote("postgresql", table);
    await targetExecute(
      session,
      `SELECT setval(pg_get_serial_sequence(?, 'id')::regclass, GREATEST((SELECT COALESCE(MAX(${quote("postgresql", "id")}), 0) FROM ${tableName}), 1), (SELECT COALESCE(MAX(${quote("postgresql", "id")}), 0) FROM ${tableName}) > 0)`,
      [table],
    ).catch(() => undefined);
  }
}

async function copySnapshotIntoTarget(
  session: TargetSession,
  target: DatabaseConfig,
  job: DatabaseSwitchJob,
) {
  setJob(job, { progress: 34, step: "正在导出当前面板数据" });
  const snapshot = await exportMigrationSnapshot();
  const summary = summarizeMigrationSnapshot(snapshot);
  const inserted: Record<string, number> = {};
  const totalRows = Math.max(1, MIGRATION_TABLES.reduce((sum, table) => sum + (snapshot.tables?.[table]?.length || 0), 0));
  let processed = 0;

  setJob(job, { progress: 35, step: "正在写入目标数据库" });
  for (const table of MIGRATION_TABLES) {
    const rows = snapshot.tables?.[table] || [];
    if (rows.length === 0) continue;
    for (const row of rows) {
      if (await insertTargetRow(session, table, row)) {
        inserted[table] = (inserted[table] || 0) + 1;
      }
      processed += 1;
      if (processed === totalRows || processed % 10 === 0) {
        setJob(job, {
          progress: 35 + Math.floor((processed / totalRows) * 55),
          step: `正在迁移 ${table}`,
        });
      }
    }
  }

  setJob(job, { progress: 92, step: "正在同步数据库切换标记" });
  for (const [key, value] of Object.entries(databaseSettingsForTarget(target))) {
    await upsertTargetSetting(session, key, value);
  }
  await syncTargetPostgresqlSequences(session);
  return { summary, inserted };
}

async function runTargetTransaction<T>(handle: TargetHandle, action: (session: TargetSession) => Promise<T>) {
  if (handle.kind === "mysql") {
    const conn = await handle.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await action({ kind: "mysql", executor: conn });
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }
  if (handle.kind === "postgresql") {
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action({ kind: "postgresql", executor: client });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  try {
    handle.sqlite.exec("BEGIN IMMEDIATE");
    const result = await action({ kind: "sqlite", executor: handle.sqlite });
    handle.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      handle.sqlite.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures.
    }
    throw error;
  }
}

function scheduleRestartAfterSwitch() {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(() => {
    console.info("[DatabaseSwitch] exiting process to load the new database dialect");
    process.exit(0);
  }, 1500);
}

async function finalizeDatabaseSwitch(target: DatabaseConfig) {
  const restartRequired = getSchemaDialect() !== target.type;
  writeDatabaseConfig(target);
  if (restartRequired) {
    scheduleRestartAfterSwitch();
  } else {
    await reconnectDatabase();
    await ensureDatabaseSchema();
  }
  return restartRequired;
}

export function startDatabaseSwitch(target: DatabaseConfig) {
  if (activeJobId) {
    const active = getDatabaseSwitchJob(activeJobId);
    if (active?.status === "pending" || active?.status === "running") {
      throw new Error("已有数据库切换任务正在执行，请等待完成后再操作。");
    }
  }
  assertSwitchAllowed(target);

  const job: DatabaseSwitchJob = {
    id: crypto.randomUUID(),
    status: "pending",
    progress: 0,
    step: "等待数据库切换开始",
    sourceType: readDatabaseConfig()?.type ?? null,
    targetType: target.type,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  void (async () => {
    let handle: TargetHandle | null = null;
    try {
      setJob(job, { status: "running", progress: 5, step: "正在测试目标数据库连接" });
      await testDatabaseConnection(target);

      setJob(job, { progress: 18, step: "正在连接目标数据库" });
      handle = await openTarget(target);

      setJob(job, { progress: 25, step: "正在初始化目标数据库结构" });
      if (handle.kind === "mysql") await ensureDatabaseSchema(handle.pool);
      else if (handle.kind === "postgresql") await ensureDatabaseSchema(handle.pool);
      else await ensureDatabaseSchema(handle.sqlite);

      const result = await runTargetTransaction(handle, async (session) => {
        setJob(job, { progress: 32, step: "正在检查目标数据库是否为空" });
        await assertTargetHasNoBusinessData(session);
        await targetExecute(session, `DELETE FROM ${quote(session.kind, "system_settings")}`);
        return copySnapshotIntoTarget(session, target, job);
      });

      if (handle.kind === "postgresql") {
        setJob(job, { progress: 95, step: "正在优化 PostgreSQL 查询性能" });
        await maintainPostgresqlDatabase(handle.pool, { forceAnalyze: true }).catch((error) => {
          console.warn("[PostgreSQL] Database switch maintenance skipped:", error instanceof Error ? error.message : String(error));
        });
      }

      setJob(job, { progress: 97, step: "正在写入数据库切换配置" });
      const restartRequired = await finalizeDatabaseSwitch(target);

      setJob(job, {
        status: "success",
        progress: 100,
        step: restartRequired ? "迁移完成，正在重启面板" : "迁移完成，已切换数据库",
        message: restartRequired
          ? "目标数据库已迁移完成，面板将自动重启以加载新的数据库类型。"
          : "目标数据库已迁移完成，面板已切换到新的数据库连接。",
        restartRequired,
        summary: result.summary,
        inserted: result.inserted,
        finishedAt: Date.now(),
      });
    } catch (error) {
      setJob(job, {
        status: "failed",
        progress: Math.max(job.progress, 1),
        step: "数据库切换失败",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    } finally {
      await closeTarget(handle);
      const latest = activeJobId ? getDatabaseSwitchJob(activeJobId) : null;
      if (latest && latest.id === job.id && latest.status !== "pending" && latest.status !== "running") {
        activeJobId = null;
      }
    }
  })();

  return job;
}

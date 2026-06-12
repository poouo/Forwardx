import { getDatabaseTableDefs } from "./dbSchema";
import { getDatabaseKind, getPostgresPool } from "./dbRuntime";

type PostgresqlExecutor = {
  query: (query: string, values?: any[]) => Promise<any>;
};

type PostgresqlMaintenanceOptions = {
  forceAnalyze?: boolean;
  logger?: Pick<typeof console, "info" | "warn">;
};

const HEALTH_CHECK_NAME = "pg-health-20260612";
const HEALTH_CHECK_SETTING_KEY = "postgresqlHealthCheckCompleted";

function quote(id: string) {
  return `"${id.replace(/"/g, "\"\"")}"`;
}

function indexName(prefix: string, table: string, cols: string[]) {
  return `${prefix}_${table}_${cols.join("_")}`.slice(0, 60);
}

async function settingValue(executor: PostgresqlExecutor, key: string) {
  const result = await executor
    .query(`SELECT ${quote("value")} FROM ${quote("system_settings")} WHERE ${quote("key")} = $1 LIMIT 1`, [key])
    .catch(() => null);
  return result?.rows?.[0]?.value ?? null;
}

async function setSettingValue(executor: PostgresqlExecutor, key: string, value: string) {
  const now = Math.floor(Date.now() / 1000);
  await executor.query(
    `INSERT INTO ${quote("system_settings")} (${quote("key")}, ${quote("value")}, ${quote("updatedAt")})
     VALUES ($1, $2, $3)
     ON CONFLICT (${quote("key")}) DO UPDATE SET ${quote("value")} = EXCLUDED.${quote("value")}, ${quote("updatedAt")} = EXCLUDED.${quote("updatedAt")}`,
    [key, value, now],
  ).catch(() => undefined);
}

async function indexExists(executor: PostgresqlExecutor, name: string) {
  const result = await executor.query(
    `SELECT 1
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'i'
       AND c.relname = $1
       AND n.nspname = current_schema()
     LIMIT 1`,
    [name],
  );
  return result.rows.length > 0;
}

async function ensureExpectedIndexes(executor: PostgresqlExecutor, logger: PostgresqlMaintenanceOptions["logger"]) {
  let checked = 0;
  let created = 0;
  let failed = 0;
  for (const table of getDatabaseTableDefs()) {
    for (const cols of table.indexes || []) {
      checked += 1;
      const name = indexName("idx", table.name, cols);
      try {
        const exists = await indexExists(executor, name);
        if (!exists) {
          await executor.query(
            `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(table.name)} (${cols.map(quote).join(", ")})`,
          );
          created += 1;
        }
      } catch (error) {
        failed += 1;
        logger?.warn?.(`[PostgreSQL] Failed to ensure index ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { checked, created, failed };
}

async function analyzeTables(executor: PostgresqlExecutor, logger: PostgresqlMaintenanceOptions["logger"]) {
  let analyzed = 0;
  let failed = 0;
  for (const table of getDatabaseTableDefs()) {
    try {
      await executor.query(`ANALYZE ${quote(table.name)}`);
      analyzed += 1;
    } catch (error) {
      failed += 1;
      logger?.warn?.(`[PostgreSQL] Failed to analyze ${table.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { analyzed, failed };
}

async function collectTableHealth(executor: PostgresqlExecutor) {
  const result = await executor.query(
    `SELECT relname,
            COALESCE(n_live_tup, 0)::bigint AS "liveRows",
            COALESCE(n_dead_tup, 0)::bigint AS "deadRows"
       FROM pg_stat_user_tables
      WHERE schemaname = current_schema()
        AND relname = ANY($1::text[])`,
    [getDatabaseTableDefs().map((table) => table.name)],
  ).catch(() => null);
  return (result?.rows || []) as Array<{ relname: string; liveRows: string | number; deadRows: string | number }>;
}

function formatLargestTables(rows: Awaited<ReturnType<typeof collectTableHealth>>) {
  return [...rows]
    .sort((a, b) => Number(b.liveRows || 0) - Number(a.liveRows || 0))
    .slice(0, 6)
    .map((row) => `${row.relname}:${Number(row.liveRows || 0)}`)
    .join(", ") || "-";
}

export async function maintainPostgresqlDatabase(
  executor: PostgresqlExecutor,
  options: PostgresqlMaintenanceOptions = {},
) {
  const logger = options.logger ?? console;
  const startedAt = Date.now();
  const existingCheck = await settingValue(executor, HEALTH_CHECK_SETTING_KEY);
  if (!options.forceAnalyze && existingCheck === HEALTH_CHECK_NAME) {
    logger.info?.(`[PostgreSQL] Health check already completed marker=${HEALTH_CHECK_NAME}; skipping`);
    return { skipped: true, indexesChecked: 0, indexesCreated: 0, analyzedTables: 0 };
  }

  logger.info?.(`[PostgreSQL] Health check started marker=${HEALTH_CHECK_NAME} force=${!!options.forceAnalyze}`);
  const indexes = await ensureExpectedIndexes(executor, logger);
  const analyze = await analyzeTables(executor, logger);
  const tableHealth = await collectTableHealth(executor);
  const failedSteps = indexes.failed + analyze.failed;
  if (failedSteps === 0) {
    await setSettingValue(executor, HEALTH_CHECK_SETTING_KEY, HEALTH_CHECK_NAME);
    await setSettingValue(executor, "postgresqlHealthCheckCompletedAt", String(Math.floor(Date.now() / 1000)));
  }
  logger.info?.(
    `[PostgreSQL] Health check complete marker=${HEALTH_CHECK_NAME} indexesChecked=${indexes.checked} indexesCreated=${indexes.created} indexFailures=${indexes.failed} tablesAnalyzed=${analyze.analyzed} analyzeFailures=${analyze.failed} largestTables=${formatLargestTables(tableHealth)} completed=${failedSteps === 0} elapsedMs=${Date.now() - startedAt}`,
  );
  return { skipped: false, indexesChecked: indexes.checked, indexesCreated: indexes.created, indexFailures: indexes.failed, analyzedTables: analyze.analyzed, analyzeFailures: analyze.failed };
}

export async function maintainCurrentPostgresqlDatabase(options: PostgresqlMaintenanceOptions = {}) {
  if (getDatabaseKind() !== "postgresql") return null;
  const pool = getPostgresPool();
  if (!pool) return null;
  return maintainPostgresqlDatabase(pool, options);
}

import { getDatabaseTableDefs } from "./dbSchema";
import { getDatabaseKind, getPool } from "./dbRuntime";
import { getSetting, setSetting } from "./repositories/settingsRepository";

type MysqlMaintenanceOptions = {
  forceAnalyze?: boolean;
  logger?: Pick<typeof console, "info" | "warn">;
};

const HEALTH_CHECK_NAME = "mysql-health-20260612-query-cache-v1";
const HEALTH_CHECK_SETTING_KEY = "mysqlHealthCheckCompleted";

function quote(id: string) {
  return `\`${id.replace(/`/g, "``")}\``;
}

export async function maintainCurrentMysqlDatabase(options: MysqlMaintenanceOptions = {}) {
  if (getDatabaseKind() !== "mysql") return null;
  const pool = getPool();
  if (!pool) return null;

  const logger = options.logger ?? console;
  const existingCheck = await getSetting(HEALTH_CHECK_SETTING_KEY).catch(() => null);
  if (!options.forceAnalyze && existingCheck === HEALTH_CHECK_NAME) {
    logger.info?.(`[MySQL] Health check already completed marker=${HEALTH_CHECK_NAME}; skipping`);
    return { skipped: true, analyzedTables: 0 };
  }

  const startedAt = Date.now();
  let analyzed = 0;
  let failed = 0;
  logger.info?.(`[MySQL] Health check started marker=${HEALTH_CHECK_NAME} force=${!!options.forceAnalyze}`);
  for (const table of getDatabaseTableDefs()) {
    try {
      await pool.query(`ANALYZE TABLE ${quote(table.name)}`);
      analyzed += 1;
    } catch (error) {
      failed += 1;
      logger.warn?.(`[MySQL] Failed to analyze ${table.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed === 0) {
    await setSetting(HEALTH_CHECK_SETTING_KEY, HEALTH_CHECK_NAME);
    await setSetting("mysqlHealthCheckCompletedAt", String(Math.floor(Date.now() / 1000)));
  }
  logger.info?.(`[MySQL] Health check complete marker=${HEALTH_CHECK_NAME} tablesAnalyzed=${analyzed} analyzeFailures=${failed} completed=${failed === 0} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, analyzedTables: analyzed, analyzeFailures: failed };
}

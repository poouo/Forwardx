import { executeRaw, getDatabaseKind, rawAffectedRows } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";

const HISTORY_DELETE_BATCH_SIZE = 2_000;
const HISTORY_DELETE_MAX_BATCHES = 25;
const HISTORY_DELETE_BUDGET_MS = 2_000;
const lastBudgetWarning = new Map<string, number>();

/** Bound both transactions and total work per pass. Remaining rows are retried
 * by scheduled maintenance; the time budget is checked between SQL statements,
 * not a Promise timeout that leaves a destructive query running unattended. */
export async function deleteExpiredHistoryRows(
  tableName: string,
  timeColumn: string,
  cutoff: number,
  options: { whereSql?: string; whereParams?: unknown[]; maxBatches?: number; maxDurationMs?: number; batchPauseMs?: number } = {},
) {
  const positiveInteger = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && Number(value) >= 1 ? Math.floor(Number(value)) : fallback;
  const maxBatches = positiveInteger(options.maxBatches, HISTORY_DELETE_MAX_BATCHES);
  const maxDurationMs = positiveInteger(options.maxDurationMs, HISTORY_DELETE_BUDGET_MS);
  const batchPauseMs = options.batchPauseMs !== undefined && Number.isFinite(options.batchPauseMs)
    ? Math.min(1_000, Math.max(0, options.batchPauseMs)) : 25;
  const startedAt = Date.now();
  const prefix = options.whereSql ? `${options.whereSql} AND ` : "";
  const params = [...(options.whereParams || []), cutoff];
  // mysql2 encodes JS numbers as DOUBLE in prepared statements. Some MySQL
  // versions reject that type for LIMIT with ER_WRONG_ARGUMENTS (1210).
  // Inline only our fixed integer batch size; keep all input values bound.
  const selection = `SELECT ${q("id")} FROM ${q(tableName)}
    WHERE ${prefix}${q(timeColumn)} < ?
    ORDER BY ${q(timeColumn)} ASC, ${q("id")} ASC LIMIT ${HISTORY_DELETE_BATCH_SIZE}`;
  // MySQL disallows selecting the delete target directly from an IN subquery.
  // The extra derived table materializes the bounded set of primary keys.
  const selectedIds = getDatabaseKind() === "mysql"
    ? `SELECT ${q("id")} FROM (${selection}) expired_history`
    : selection;
  let deleted = 0;
  let batches = 0;
  while (true) {
    const affected = rawAffectedRows(await executeRaw(
      `DELETE FROM ${q(tableName)} WHERE ${q("id")} IN (${selectedIds})`, params,
    ));
    deleted += affected;
    batches++;
    if (affected < HISTORY_DELETE_BATCH_SIZE) return deleted;
    if (batches >= maxBatches || Date.now() - startedAt >= maxDurationMs) {
      const key = `${tableName}.${timeColumn}`;
      const now = Date.now();
      if (now - (lastBudgetWarning.get(key) ?? -Infinity) >= 60 * 60_000) {
        lastBudgetWarning.set(key, now);
        console.warn(`[HistoryCleanup] budget reached table=${tableName} deleted=${deleted} batches=${batches} durationMs=${now - startedAt}; remaining expired rows deferred to a later pass`);
      }
      return deleted;
    }
    // Pace MySQL/PostgreSQL too, leaving capacity for heartbeats and Web requests.
    await new Promise<void>((resolve) => setTimeout(resolve, batchPauseMs));
  }
}

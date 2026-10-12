import { executeRaw, getDatabaseKind, rawAffectedRows } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";

const HISTORY_DELETE_BATCH_SIZE = 2_000;

/** Bounded transactions on every backend; yield between batches on SQLite. */
export async function deleteExpiredHistoryRows(
  tableName: string,
  timeColumn: string,
  cutoff: number,
  options: { whereSql?: string; whereParams?: unknown[] } = {},
) {
  const prefix = options.whereSql ? `${options.whereSql} AND ` : "";
  const params = [...(options.whereParams || []), cutoff, HISTORY_DELETE_BATCH_SIZE];
  const selection = `SELECT ${q("id")} FROM ${q(tableName)}
    WHERE ${prefix}${q(timeColumn)} < ?
    ORDER BY ${q(timeColumn)} ASC, ${q("id")} ASC LIMIT ?`;
  // MySQL disallows selecting the delete target directly from an IN subquery.
  // The extra derived table materializes the bounded set of primary keys.
  const selectedIds = getDatabaseKind() === "mysql"
    ? `SELECT ${q("id")} FROM (${selection}) expired_history`
    : selection;
  let deleted = 0;
  while (true) {
    const affected = rawAffectedRows(await executeRaw(
      `DELETE FROM ${q(tableName)} WHERE ${q("id")} IN (${selectedIds})`, params,
    ));
    deleted += affected;
    if (affected < HISTORY_DELETE_BATCH_SIZE) return deleted;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

import { boolLiteral, bucketExpression, quoteIdentifier as q } from "../dbCompat";
import { queryRaw } from "../dbRuntime";

type LatencyTable = "tcping_stats" | "tunnel_latency_stats" | "forward_group_latency_stats";
type LatencyIdColumn = "ruleId" | "tunnelId" | "groupId";

/** Scalar subqueries allow indexed top-one seeks on MySQL as well (unlike
 * MySQL's unsupported LIMIT directly inside an IN subquery). Chunk UNIONs to
 * stay below SQLite's compound-select limit for large rule lists. */
export async function queryLatestHistoryRows(
  table: LatencyTable | "host_probe_service_stats",
  idColumn: LatencyIdColumn | "serviceId",
  ids: number[],
  options: { hostId?: number; orderByTime?: boolean } = {},
) {
  const rows: any[] = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const host = options.hostId ? ` AND ${q("hostId")} = ?` : "";
    const order = options.orderByTime ? `${q("recordedAt")} DESC, ${q("id")} DESC` : `${q("id")} DESC`;
    rows.push(...await queryRaw<any>(batch.map(() => `SELECT s.* FROM ${q(table)} s
      WHERE s.${q("id")} = (SELECT ${q("id")} FROM ${q(table)}
        WHERE ${q(idColumn)} = ?${host} ORDER BY ${order} LIMIT 1)`).join(" UNION ALL "),
    batch.flatMap((id) => options.hostId ? [id, options.hostId] : [id])));
  }
  return rows;
}

/** Client supplies local midnight boundaries, including DST transitions.
 * Values must pass resolveLatencyHistoryWindow before reaching a repository. */
export function latencyDayBucketExpression(days: Date[], columnSql: string) {
  return `CASE ${days.slice(0, -1).map((day, index) =>
    `WHEN ${columnSql} < ${Math.floor(days[index + 1].getTime() / 1000)} THEN ${Math.floor(day.getTime() / 1000)}`,
  ).join(" ")} ELSE -1 END`;
}

/** Aggregate in SQL so a month of raw samples never enters Node's heap.
 * Keep success-weighted latency and packet totals (not averages of loss %).
 * This does not rewrite or remove any of the source records. */
export async function queryLatencyChartBuckets(
  table: LatencyTable,
  idColumn: LatencyIdColumn,
  ids: number[],
  since: Date,
  bucketSeconds: number,
  until = new Date(Date.now() + 1000),
  dayBoundaries?: Date[],
) {
  if (!ids.length) return [];
  const end = Math.min(Math.floor(until.getTime() / 1000), Math.floor(Date.now() / 1000) + 1);
  const start = Math.floor(since.getTime() / 1000);
  const series = table === "tunnel_latency_stats"
    ? `COALESCE(NULLIF(TRIM(s.${q("seriesKey")}), ''), 'total')` : null;
  let seriesCount = ids.length;
  if (series && !dayBoundaries) {
    const counts = await queryRaw<any>(`SELECT COUNT(*) AS ${q("count")} FROM (
      SELECT s.${q(idColumn)}, ${series} FROM ${q(table)} s
      WHERE s.${q(idColumn)} IN (${ids.map(() => "?").join(",")})
        AND s.${q("recordedAt")} >= ? AND s.${q("recordedAt")} < ?
      GROUP BY s.${q(idColumn)}, ${series}) history_series`, [...ids, start, end]);
    seriesCount = Math.max(1, Number(counts[0]?.count) || 1);
  }
  const perSeriesBudget = Math.max(2, Math.floor(20_000 / seriesCount));
  const width = Math.max(60, Math.floor(bucketSeconds), Math.ceil((end - start) / (perSeriesBudget - 1) / 60) * 60);
  const bucket = dayBoundaries ? latencyDayBucketExpression(dayBoundaries, `s.${q("recordedAt")}`) : bucketExpression("s", "recordedAt", width);
  const count = `CASE WHEN s.${q("probeCount")} BETWEEN 1 AND 1024 THEN s.${q("probeCount")} ELSE 1 END`;
  const successes = `CASE
    WHEN s.${q("isTimeout")} = ${boolLiteral(true)} AND COALESCE(s.${q("probeSuccesses")}, 0) <= 0 THEN 0
    WHEN s.${q("probeSuccesses")} > 0 THEN CASE WHEN s.${q("probeSuccesses")} > (${count}) THEN (${count}) ELSE s.${q("probeSuccesses")} END
    WHEN s.${q("isTimeout")} = ${boolLiteral(true)} THEN 0
    ELSE (${count}) END`;
  const validSuccesses = `CASE WHEN s.${q("latencyMs")} IS NOT NULL THEN (${successes}) ELSE 0 END`;
  return queryRaw<any>(`SELECT s.${q(idColumn)},
      MAX(s.${q("recordedAt")}) AS ${q("recordedAt")},
      ${bucket} AS ${q("bucketStart")},
      ${series ? `${series} AS ${q("seriesKey")}, MAX(s.${q("seriesLabel")}) AS ${q("seriesLabel")},` : ""}
      SUM(s.${q("latencyMs")} * (${validSuccesses})) * 1.0 / NULLIF(SUM(${validSuccesses}), 0) AS ${q("latencyMs")},
      MIN(CASE WHEN (${validSuccesses}) > 0 THEN s.${q("latencyMs")} END) AS ${q("minLatencyMs")},
      MAX(CASE WHEN (${validSuccesses}) > 0 THEN s.${q("latencyMs")} END) AS ${q("maxLatencyMs")},
      SUM(${count}) AS ${q("probeCount")},
      SUM(${successes}) AS ${q("probeSuccesses")}
    FROM ${q(table)} s
    WHERE s.${q(idColumn)} IN (${ids.map(() => "?").join(",")})
      AND s.${q("recordedAt")} >= ? AND s.${q("recordedAt")} < ?
    GROUP BY s.${q(idColumn)}, ${bucket}${series ? `, ${series}` : ""}
    ORDER BY ${q("bucketStart")} DESC`,
  [...ids, start, end]);
}

export function mapLatencyChartBucket(row: any) {
  const probeCount = Number(row.probeCount);
  const probeSuccesses = Number(row.probeSuccesses);
  return {
    latencyMs: row.latencyMs == null ? null : Math.round(Number(row.latencyMs)),
    isTimeout: probeSuccesses <= 0,
    probeCount,
    probeSuccesses,
    recordedAt: new Date(Number(row.recordedAt) * 1000),
    dayStart: Number(row.bucketStart) * 1000,
    minLatencyMs: row.minLatencyMs == null ? null : Number(row.minLatencyMs),
    maxLatencyMs: row.maxLatencyMs == null ? null : Number(row.maxLatencyMs),
  };
}

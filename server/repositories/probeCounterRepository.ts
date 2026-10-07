import { createHash } from "node:crypto";
import { hasAgentProbeCounter, normalizeAgentProbeCounts, type AgentProbeCounter } from "../../shared/agentDtos";
import type { ProbeStatistics } from "../../shared/probeStatistics";
import { executeRaw, getDatabaseKind, queryRaw } from "../dbRuntime";
import { quoteIdentifier as q } from "../dbCompat";

export type ProbeCounterKind = "rule" | "tunnel" | "forwardGroup";
export type ProbeCounterSnapshot = {
  kind: ProbeCounterKind;
  refId: number;
  hostId: number;
  probeKey: string;
  epoch: string;
  totalCount: number;
  totalSuccesses: number;
  batchCount: number;
  batchSuccesses: number;
};

/** Call only after host, entity, target and topology authorization. Never
 * call for an aggregate assembled from cached hops or tunnel health. */
export function probeCounterSnapshot(kind: ProbeCounterKind, refId: number, hostId: number,
  report: AgentProbeCounter & { probeCount?: number; probeSuccesses?: number; isTimeout?: boolean } & Record<string, any>): ProbeCounterSnapshot | null {
  if (!hasAgentProbeCounter(report) || report.method === "self") return null;
  const counts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
  if (Number(report.probeTotalCount) < counts.probeCount || Number(report.probeTotalSuccesses) < counts.probeSuccesses
    || Number(report.probeTotalCount) - Number(report.probeTotalSuccesses) < counts.probeCount - counts.probeSuccesses) return null;
  // Include the validated identity, not only the Agent-supplied probeKey.
  const identity = [kind, refId, hostId, report.topologyKey || "", report.probeKey || "",
    String(report.targetIp || "").toLowerCase(), report.targetPort || 0, report.sourcePort || 0,
    report.method || "", report.hopIndex ?? -1, report.hopCount || 0, report.seriesKey || "", report.memberId || 0, report.probeType || ""];
  return { kind, refId, hostId, probeKey: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    epoch: report.probeCounterEpoch!, totalCount: report.probeTotalCount!, totalSuccesses: report.probeTotalSuccesses!,
    batchCount: counts.probeCount, batchSuccesses: counts.probeSuccesses };
}

export function probeCounterInsertSql(rowCount: number, kind = getDatabaseKind()) {
  const columns = ["kind", "refId", "hostId", "probeKey", "epoch", "totalCount", "totalSuccesses", "batchCount", "batchSuccesses", "recordedAt"];
  const unique = ["hostId", "kind", "refId", "probeKey", "epoch", "totalCount"];
  return `INSERT INTO ${q("probe_counter_snapshots")} (${columns.map(q).join(", ")}) VALUES ${Array.from({ length: rowCount }, () => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`
    + (kind === "mysql" ? ` ON DUPLICATE KEY UPDATE ${q("totalCount")} = ${q("totalCount")}`
      : ` ON CONFLICT (${unique.map(q).join(", ")}) DO NOTHING`);
}

export async function insertProbeCounterSnapshots(rows: ProbeCounterSnapshot[], recordedAt = new Date()) {
  // Keep SQLite bind counts and each write bounded. Duplicate HTTP delivery
  // keeps the original timestamp rather than moving an old sample forward.
  const at = Math.floor(recordedAt.getTime() / 1000);
  for (let offset = 0; offset < rows.length; offset += 80) {
    const batch = rows.slice(offset, offset + 80);
    await executeRaw(probeCounterInsertSql(batch.length), batch.flatMap((row) => [row.kind, row.refId, row.hostId,
      row.probeKey, row.epoch, row.totalCount, row.totalSuccesses, row.batchCount, row.batchSuccesses, at]));
  }
}

export async function getProbeCounterStatistics(kind: ProbeCounterKind, refIds: number | number[], since: Date): Promise<ProbeStatistics> {
  const ids = [...new Set((Array.isArray(refIds) ? refIds : [refIds]).filter((id) => Number.isInteger(id) && id > 0))];
  const empty: ProbeStatistics = { total: 0, successes: 0, available: false, observedSince: null, latestAt: null };
  if (!ids.length) return empty;
  const start = Math.floor(since.getTime() / 1000);
  // Retention is 72h. The latest pre-window snapshot is the baseline; for a
  // newly observed stream count only its first batch + subsequent deltas,
  // never its unobserved lifetime. MAX tolerates retries and out-of-order POSTs.
  const rows = await queryRaw<any>(`
    SELECT ${q("hostId")}, ${q("refId")}, ${q("probeKey")}, ${q("epoch")},
      MAX(CASE WHEN ${q("recordedAt")} < ? THEN ${q("totalCount")} END) AS ${q("baseCount")},
      MAX(CASE WHEN ${q("recordedAt")} < ? THEN ${q("totalSuccesses")} END) AS ${q("baseSuccesses")},
      MIN(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("totalCount")} - ${q("batchCount")} END) AS ${q("initialCount")},
      MIN(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("totalSuccesses")} - ${q("batchSuccesses")} END) AS ${q("initialSuccesses")},
      MAX(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("totalCount")} END) AS ${q("endCount")},
      MAX(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("totalSuccesses")} END) AS ${q("endSuccesses")},
      MIN(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("recordedAt")} END) AS ${q("firstAt")},
      MAX(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("recordedAt")} END) AS ${q("lastAt")}
    FROM ${q("probe_counter_snapshots")}
    WHERE ${q("kind")} = ? AND ${q("refId")} IN (${ids.map(() => "?").join(", ")})
      AND ${q("recordedAt")} >= ?
    GROUP BY ${q("hostId")}, ${q("refId")}, ${q("probeKey")}, ${q("epoch")}`,
  [start, start, start, start, start, start, start, start, kind, ...ids, start - 72 * 3600]);
  for (const row of rows) {
    if (row.endCount === null || row.endCount === undefined) continue;
    const count = Math.max(0, Number(row.endCount) - Number(row.baseCount ?? row.initialCount));
    const successes = Math.max(0, Math.min(count, Number(row.endSuccesses) - Number(row.baseSuccesses ?? row.initialSuccesses)));
    empty.total += count;
    empty.successes += successes;
    empty.available = true;
    const first = new Date(Number(row.firstAt) * 1000);
    const last = new Date(Number(row.lastAt) * 1000);
    if (!empty.observedSince || first < empty.observedSince) empty.observedSince = first;
    if (!empty.latestAt || last > empty.latestAt) empty.latestAt = last;
  }
  return empty;
}

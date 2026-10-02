import { afterDatabaseCommit, executeRaw, queryRaw, rawAffectedRows } from "./dbRuntime";
import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { appendPanelLog } from "./_core/panelLogger";
import { hostTrafficExcluded } from "../shared/hostTrafficPolicy";

export async function getTrafficExcludedHostIds() {
  const rows = await queryRaw<any>(`SELECT ${q("id")}, ${q("trafficLimit")}, ${q("trafficFailoverEnabled")}, ${q("trafficFailoverExcluded")}
    FROM ${q("hosts")} WHERE ${q("trafficFailoverExcluded")} = ${boolLiteral(true)}`);
  return new Set(rows.filter(hostTrafficExcluded).map((host) => Number(host.id)));
}

/** Runs in the traffic/config transaction. Only a transition schedules work. */
export async function reconcileHostTrafficPolicy(hostId: number) {
  const rows = await queryRaw<any>(`SELECT h.${q("id")}
    FROM ${q("hosts")} h
    WHERE h.${q("id")} = ? AND (h.${q("trafficFailoverEnabled")} = ${boolLiteral(true)} OR h.${q("trafficFailoverExcluded")} = ${boolLiteral(true)})`, [hostId]);
  const host = rows[0];
  if (!host) return false;
  const h = (name: string) => `${q("hosts")}.${q(name)}`;
  const ti = `t.${q("bytesIn")}`;
  const to = `t.${q("bytesOut")}`;
  const usage = `COALESCE((SELECT CASE WHEN ${h("trafficMeasureMode")} = 'outbound' THEN ${to}
    WHEN ${h("trafficMeasureMode")} = 'max' THEN CASE WHEN ${ti} > ${to} THEN ${ti} ELSE ${to} END
    ELSE ${ti} + ${to} END FROM ${q("host_traffic_counters")} t WHERE t.${q("hostId")} = ${h("id")}), 0)`;
  // Compute in UPDATE, not from the earlier snapshot: a simultaneous reset or
  // settings change must not be overwritten by a stale report decision.
  const decision = `CASE WHEN ${h("trafficFailoverEnabled")} = ${boolLiteral(true)} AND ${h("trafficLimit")} > 0
    AND ${usage} >= ${h("trafficLimit")} * 1.0 * ${h("trafficFailoverThresholdPercent")} / 100
    THEN ${boolLiteral(true)} ELSE ${boolLiteral(false)} END`;
  const result = await executeRaw(`UPDATE ${q("hosts")} SET ${q("trafficFailoverExcluded")} = ${decision}
    WHERE ${q("id")} = ? AND ${q("trafficFailoverExcluded")} <> (${decision})`, [hostId]);
  if (!rawAffectedRows(result)) return false;
  await afterDatabaseCommit(async () => {
    // Load lazily to keep repository imports acyclic. Runtime reads the latest
    // committed state, rather than this possibly superseded transition.
    try {
      const current = await queryRaw<any>(`SELECT * FROM ${q("hosts")} WHERE ${q("id")} = ?`, [hostId]);
      appendPanelLog("info", `[HostTrafficPolicy] host=${hostId} groupParticipation=${hostTrafficExcluded(current[0]) ? "excluded" : "restored"} threshold=${current[0]?.trafficFailoverThresholdPercent ?? 100}%`);
      const { refreshHostTrafficPolicyRuntime } = await import("./hostTrafficPolicyRuntime");
      await refreshHostTrafficPolicyRuntime(hostId);
    } catch (error) {
      appendPanelLog("warn", `[HostTrafficPolicy] runtime refresh failed host=${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return true;
}

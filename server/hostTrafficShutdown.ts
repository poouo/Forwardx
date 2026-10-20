import type { Router } from "express";
import { getAgentHostFromRequest } from "./agentAuth";
import { boolLiteral, quoteIdentifier as q } from "./dbCompat";
import { executeRaw, rawAffectedRows } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { getSeamlessMigrationState } from "./seamlessMigrationState";

/** Authorize once per traffic cycle, using live config/counters in one atomic
 * statement. A stale heartbeat must never shut down a disabled/reset host. */
export async function claimHostTrafficShutdown(hostId: number, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(hostId) || hostId <= 0) return false;
  const h = (name: string) => `${q("hosts")}.${q(name)}`;
  const ti = `t.${q("bytesIn")}`, to = `t.${q("bytesOut")}`;
  const used = `COALESCE((SELECT CASE WHEN ${h("trafficMeasureMode")} = 'outbound' THEN ${to}
    WHEN ${h("trafficMeasureMode")} = 'max' THEN CASE WHEN ${ti} > ${to} THEN ${ti} ELSE ${to} END
    ELSE ${ti} + ${to} END FROM ${q("host_traffic_counters")} t
    WHERE t.${q("hostId")} = ${h("id")} AND t.${q("lastReportedAt")} >= ? AND t.${q("lastReportedAt")} <= ?), -1)`;
  const result = await executeRaw(`UPDATE ${q("hosts")} SET ${q("trafficShutdownTriggered")} = ${boolLiteral(true)}
    WHERE ${q("id")} = ? AND ${q("trafficShutdownEnabled")} = ${boolLiteral(true)}
      AND ${q("trafficShutdownTriggered")} = ${boolLiteral(false)} AND ${q("trafficLimit")} > 0
      AND ${q("trafficShutdownThresholdPercent")} BETWEEN 1 AND 100
      AND ${used} >= ${h("trafficLimit")} * 1.0 * ${h("trafficShutdownThresholdPercent")} / 100`,
  [hostId, now - 120, now + 30]);
  const allowed = rawAffectedRows(result) > 0;
  if (allowed) appendPanelLog("warn", `[HostTrafficShutdown] host=${hostId} traffic threshold reached; Agent authorized to power off once this cycle`);
  return allowed;
}

export function registerAgentTrafficShutdownRoutes(router: Router) {
  router.post("/api/agent/traffic-shutdown-claim", async (req, res) => {
    try {
      const host = await getAgentHostFromRequest(req);
      if (!host) { res.status(401).json({ error: "Invalid token" }); return; }
      const migration = getSeamlessMigrationState();
      if (migration && migration.phase !== "active") { res.json({ allowed: false }); return; }
      res.json({ allowed: await claimHostTrafficShutdown(Number(host.id)) });
    } catch (error) {
      console.error("[HostTrafficShutdown] authorization failed:", error);
      res.status(500).json({ allowed: false, error: "Shutdown authorization failed" });
    }
  });
}

import { randomUUID } from "node:crypto";
import { executeRaw, queryRaw, rawAffectedRows, withDatabaseTransaction, getDatabaseKind } from "./dbRuntime";
import { quoteIdentifier as q, boolLiteral } from "./dbCompat";
import { createForwardTest } from "./repositories/forwardTestRepository";
import { insertTcpingStat } from "./repositories/metricsRepository";
import { buildRuleTunnelProbeResult } from "./ruleTunnelProbeResult";
import { type ManualTunnelProbe } from "./tunnelManualProbe";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { linkProbeMethodForRule } from "../shared/latencyProbe";
import { clearRuleLatencyQueryCaches } from "./ruleLatencyQueryCache";
import { selfTestSweepActivity } from "./selfTestTiming";
import { appendPanelLog } from "./_core/panelLogger";

export async function queueRuleTunnelProbeBatch(rule: any, tunnel: any, probes: ManualTunnelProbe[], hosts: Map<number, any>) {
  if (!probes.length) throw new Error("隧道没有可测试的有效链路");
  const batchId = `rt-${randomUUID()}`;
  const requests: any[] = probes.map(probe => ({ ...probe, kind: "tunnel-hop", method: "tcp",
    wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(probe.toHostId) : undefined }));
  // Probe the target once per actual exit, not from an arbitrary entry. Each
  // alternative path includes its own exit-to-target result.
  const targets = new Map<number, Set<string>>();
  for (const probe of probes.filter(probe => probe.hopIndex === probe.hopCount - 1)) {
    const keys = targets.get(probe.toHostId) || new Set<string>();
    probe.pathKeys.forEach(key => keys.add(key));
    targets.set(probe.toHostId, keys);
  }
  for (const [fromHostId, keys] of targets) requests.push({
    kind: "forward-via-tunnel", fromHostId, toHostId: null,
    targetIp: rule.targetIp, targetPort: rule.targetPort, method: linkProbeMethodForRule(rule),
    pathKeys: [...keys], hopLabel: `出口 -> 目标 ${rule.targetIp}:${rule.targetPort}`,
    routeLabel: `${hosts.get(fromHostId)?.name || `主机${fromHostId}`} -> 目标 ${rule.targetIp}:${rule.targetPort}`,
  });
  return withDatabaseTransaction(async () => {
    let id = 0;
    for (const request of requests) id = Number(await createForwardTest({
      ruleId: Number(rule.id), userId: Number(rule.userId), hostId: request.fromHostId, batchId,
      message: JSON.stringify({ ...request, tunnelId: Number(tunnel.id),
        entryHostId: Number(tunnel.entryHostId), exitHostId: Number(tunnel.exitHostId), batchId }),
    }));
    appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} batch=${batchId} queued segments=${requests.length}`);
    return { id, queued: requests.length, hostIds: [...new Set(requests.map(request => Number(request.fromHostId)))] };
  });
}

export async function settleRuleTunnelProbeBatch(batchId: string) {
  if (!batchId?.startsWith("rt-")) return false;
  return withDatabaseTransaction(async () => {
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const rows = await queryRaw<any>(`SELECT * FROM ${q("forward_tests")} WHERE ${q("batchId")} = ? ORDER BY ${q("id")}${lock}`, [batchId]);
    if (!rows.length || rows.every(row => !!Number(row.batchSettled))) return false;
    const result = buildRuleTunnelProbeResult(rows)!;
    if (result.status === "running") return false;
    const claimed = await executeRaw(`UPDATE ${q("forward_tests")} SET ${q("batchSettled")} = ${boolLiteral(true)}
      WHERE ${q("batchId")} = ? AND ${q("batchSettled")} = ${boolLiteral(false)}`, [batchId]);
    if (!rawAffectedRows(claimed)) return false;
    await insertTcpingStat({ ruleId: Number(result.ruleId), hostId: Number(result.hostId),
      latencyMs: result.latencyMs, isTimeout: result.status !== "success" });
    clearRuleLatencyQueryCaches();
    const missingHosts = [...new Set(rows.filter(row => row.status === "timeout").map(row => row.hostId))];
    appendPanelLog(result.status === "success" && !missingHosts.length ? "info" : "warn",
      `[SelfTest] rule=${result.ruleId} batch=${batchId} completed segments=${rows.length} status=${result.status} latency=${result.latencyMs ?? "-"}ms unreportedHosts=${missingHosts.join(",") || "-"}`);
    return true;
  });
}

export async function recoverRuleTunnelProbeBatches() {
  const batches = await queryRaw<{ batchId: string }>(`SELECT ${q("batchId")} FROM ${q("forward_tests")}
    WHERE ${q("batchSettled")} = ${boolLiteral(false)} AND ${q("batchId")} LIKE 'rt-%'
    GROUP BY ${q("batchId")} HAVING SUM(CASE WHEN ${q("status")} IN ('pending', 'running') THEN 1 ELSE 0 END) = 0 LIMIT 100`);
  for (const { batchId } of batches) await settleRuleTunnelProbeBatch(batchId);
  if (batches.length === 100) selfTestSweepActivity.markActive();
}

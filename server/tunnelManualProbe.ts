import { randomUUID } from "node:crypto";
import { tunnels } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { quoteIdentifier as q, boolLiteral } from "./dbCompat";
import { executeRaw, queryRaw, getDb, getDatabaseKind, rawAffectedRows, withDatabaseTransaction, nowDate } from "./dbRuntime";
import { createForwardTest } from "./repositories/forwardTestRepository";
import { insertTunnelLatencyStat } from "./repositories/metricsRepository";
import { structuredLinkTestMessage } from "./linkTestMessages";
import { selectTunnelDialAddress, selectTunnelHopDialAddress } from "./tunnelAddressSelection";
import { isTunnelRelayFailover, tunnelRelayCandidates } from "../shared/tunnelRelay";
import { normalizeExitGroupStrategy } from "../shared/exitStrategy";
import { isForwardXWireGuardV2 } from "./forwardXWireGuard";
import { selfTestSweepActivity, SELF_TEST_MAX_LIFETIME_SECONDS } from "./selfTestTiming";
import { appendPanelLog } from "./_core/panelLogger";

export type ManualTunnelProbe = {
  fromHostId: number; toHostId: number; targetIp: string; targetPort: number;
  hopIndex: number; hopCount: number; routeLabel: string; hopLabel: string;
  pathKeys: string[];
};

/** Each path is an alternative; all edges of that path must succeed. */
export function planManualTunnelProbes(input: {
  tunnel: any; hops: any[]; exits: any[]; entryHostIds: number[]; hosts: Map<number, any>;
}) {
  const { tunnel, hosts } = input;
  const hops = input.hops.length >= 2 ? input.hops : [
    { hostId: tunnel.entryHostId }, { hostId: tunnel.exitHostId, listenPort: tunnel.listenPort },
  ];
  const entries = Array.from(new Set(input.entryHostIds));
  const paths: Array<{ key: string; nodes: any[] }> = [];
  for (const entryId of entries) {
    const entry = { hostId: entryId };
    if (isTunnelRelayFailover(tunnel, hops)) {
      tunnelRelayCandidates(hops).forEach((relay: any, index) => paths.push({
        key: `entry-${entryId}-relay-${index + 1}`, nodes: [entry, relay, hops[hops.length - 1]],
      }));
    } else if (hops.length >= 3) {
      paths.push({ key: `entry-${entryId}`, nodes: [entry, ...hops.slice(1)] });
    } else {
      paths.push({ key: `entry-${entryId}-primary`, nodes: [entry, {
        hostId: tunnel.exitHostId, listenPort: tunnel.listenPort, connectHost: tunnel.connectHost,
      }] });
      if ((tunnel.loadBalanceEnabled === true || Number(tunnel.loadBalanceEnabled) === 1)
        && normalizeExitGroupStrategy(tunnel.loadBalanceStrategy) !== "none") {
        input.exits.filter(node => node.isEnabled == null || node.isEnabled === true || Number(node.isEnabled) === 1)
          .forEach((exit, index) => paths.push({ key: `entry-${entryId}-exit-${index + 2}`, nodes: [entry, exit] }));
      }
    }
  }
  const edges = new Map<string, ManualTunnelProbe>();
  for (const path of paths) {
    for (let index = 0; index < path.nodes.length - 1; index++) {
      const fromHostId = Number(path.nodes[index].hostId);
      const next = path.nodes[index + 1];
      const toHostId = Number(next.hostId);
      const nextHost = hosts.get(toHostId);
      const targetIp = hops.length >= 3
        ? selectTunnelHopDialAddress(next, nextHost, tunnel)
        : selectTunnelDialAddress({ ...tunnel, connectHost: next.connectHost }, nextHost);
      const targetPort = Number(next.listenPort);
      if (!fromHostId || !toHostId || !targetIp || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        throw new Error(`TUNNEL_HOP_TEST_TARGET_INVALID from=${fromHostId} to=${toHostId} target=${targetIp || "-"} port=${targetPort || "-"}`);
      }
      const key = `${fromHostId}:${toHostId}:${targetIp}:${targetPort}`;
      const previous = edges.get(key);
      if (previous) { previous.pathKeys.push(path.key); continue; }
      edges.set(key, {
        fromHostId, toHostId, targetIp, targetPort, hopIndex: index, hopCount: path.nodes.length - 1,
        hopLabel: `${index + 1}/${path.nodes.length - 1} ${fromHostId}->${toHostId}`,
        routeLabel: `${hosts.get(fromHostId)?.name || `主机${fromHostId}`} -> ${nextHost?.name || `主机${toHostId}`}`,
        pathKeys: [path.key],
      });
    }
  }
  if (!edges.size) throw new Error("隧道没有可测试的有效链路");
  return Array.from(edges.values()).sort((a, b) => a.hopIndex - b.hopIndex);
}

export function aggregateManualTunnelProbes(details: any[]) {
  const paths = new Map<string, any[]>();
  for (const detail of details) {
    for (const key of detail.pathKeys || []) {
      const rows = paths.get(key) || [];
      rows.push(detail); paths.set(key, rows);
    }
  }
  const successful = Array.from(paths.values()).filter(rows => rows.length && rows.every(row => row.success));
  return {
    success: successful.length > 0,
    latencyMs: successful.length ? Math.max(...successful.map(rows => rows.reduce((sum, row) => sum + row.latencyMs, 0))) : null,
    available: successful.length, total: paths.size,
  };
}

export async function queueManualTunnelProbeBatch(tunnel: any, probes: ManualTunnelProbe[]) {
  if (!probes.length) throw new Error("隧道没有可测试的有效链路");
  const batchId = `tp-${randomUUID()}`;
  const message = JSON.stringify({
    ...JSON.parse(structuredLinkTestMessage({ kind: "tunnel-hop-pending", tunnelId: tunnel.id,
      message: `隧道逐段探测中：${probes.length} 段`, totalLatencyMs: null,
      details: probes.map(probe => ({ ...probe, success: false, pending: true, latencyMs: null, method: "tcp" })),
    })), batchId, deadlineAt: Date.now() + SELF_TEST_MAX_LIFETIME_SECONDS * 1000,
  });
  return withDatabaseTransaction(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const [current] = await queryRaw<any>(`SELECT ${q("lastTestStatus")}, ${q("lastTestMessage")} FROM ${q("tunnels")} WHERE ${q("id")} = ?${lock}`, [Number(tunnel.id)]);
    if (!current) throw new Error("隧道不存在");
    let pending: any; try { pending = JSON.parse(current.lastTestMessage || "{}"); } catch { pending = {}; }
    const sameProbes = Array.isArray(pending.details) && pending.details.length === probes.length
      && probes.every(probe => pending.details.some((detail: any) => detail.fromHostId === probe.fromHostId
        && detail.toHostId === probe.toHostId && detail.targetIp === probe.targetIp && detail.targetPort === probe.targetPort
        && JSON.stringify(detail.pathKeys) === JSON.stringify(probe.pathKeys)));
    if (["pending", "running"].includes(current.lastTestStatus) && pending.deadlineAt > Date.now()
      && String(pending.batchId || "").startsWith("tp-") && sameProbes) {
      selfTestSweepActivity.markActive();
      return { success: false, pending: true, latencyMs: null, message: current.lastTestMessage as string, batchId: pending.batchId as string };
    }
    // Old batches may still report, but can never complete this new generation.
    for (const probe of probes) await createForwardTest({
      ruleId: 0, userId: Number(tunnel.userId), hostId: probe.fromHostId, batchId,
      message: JSON.stringify({ kind: "tunnel-hop", tunnelId: Number(tunnel.id), batchId, ...probe,
        wireGuardPeerId: isForwardXWireGuardV2(tunnel) ? String(probe.toHostId) : undefined }),
    });
    await db.update(tunnels).set({ lastTestStatus: "pending", lastTestMessage: message, lastTestAt: nowDate() })
      .where(eq(tunnels.id, Number(tunnel.id)));
    selfTestSweepActivity.markActive();
    return { success: false, pending: true, latencyMs: null, message, batchId };
  });
}

/** Reads durable samples, so process restart, duplicate delivery and report order are harmless. */
export async function settleManualTunnelProbeBatch(batchId: string) {
  if (!batchId?.startsWith("tp-")) return false;
  return withDatabaseTransaction(async () => {
    // SQLite's transaction already owns the connection; locking reads on the
    // other backends serialize partial/final publication in the same order.
    const lock = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
    const rows = await queryRaw<any>(`SELECT * FROM ${q("forward_tests")} WHERE ${q("batchId")} = ? ORDER BY ${q("id")}${lock}`, [batchId]);
    if (!rows.length || rows.every(row => row.batchSettled === true || Number(row.batchSettled) === 1)) return false;
    const meta = JSON.parse(rows[0].requestMessage);
    const tunnelId = Number(meta.tunnelId);
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [tunnel] = await db.select().from(tunnels).where(eq(tunnels.id, tunnelId)).limit(1);
    let pending: any;
    try { pending = JSON.parse(tunnel?.lastTestMessage || "{}"); } catch { pending = {}; }
    const complete = rows.every(row => !["pending", "running"].includes(row.status));
    const details = rows.map(row => {
      const request = JSON.parse(row.requestMessage);
      const success = row.status === "success" && Number(row.latencyMs) > 0;
      return { ...request, success, latencyMs: success ? Number(row.latencyMs) : null,
        pending: ["pending", "running"].includes(row.status), method: "tcp",
        message: row.status === "timeout" ? "探测超时：未在截止时间内收到 Agent 结果" : row.message === row.requestMessage ? null : row.message };
    });
    if (!complete) {
      if (pending.batchId === batchId) {
        await db.update(tunnels).set({ lastTestMessage: JSON.stringify({ ...pending, details }) })
          .where(and(eq(tunnels.id, tunnelId), eq(tunnels.lastTestMessage, tunnel.lastTestMessage!)));
      }
      return false;
    }
    // Claim finalization in the same transaction as publishing the result.
    const claimed = await executeRaw(`UPDATE ${q("forward_tests")} SET ${q("batchSettled")} = ${boolLiteral(true)}
      WHERE ${q("batchId")} = ? AND ${q("batchSettled")} = ${boolLiteral(false)}`, [batchId]);
    if (!rawAffectedRows(claimed) || pending.batchId !== batchId) return false;
    const summary = aggregateManualTunnelProbes(details);
    const message = structuredLinkTestMessage({ kind: "tunnel-hop-summary", tunnelId, details,
      totalLatencyMs: summary.latencyMs, message: summary.success
        ? `隧道逐段探测成功，总延迟 ${summary.latencyMs}ms（${summary.available}/${summary.total} 路可用）`
        : "隧道逐段探测失败：没有完整可用路径，请查看失败分段详情",
    });
    const published = await executeRaw(`UPDATE ${q("tunnels")} SET ${q("lastTestStatus")} = ?, ${q("lastTestMessage")} = ?,
      ${q("lastLatencyMs")} = ?, ${q("lastTestAt")} = ? WHERE ${q("id")} = ? AND ${q("lastTestMessage")} = ?`,
      [summary.success ? "success" : "failed", message, summary.latencyMs, nowDate(), tunnelId, tunnel.lastTestMessage]);
    if (!rawAffectedRows(published)) return false;
    await insertTunnelLatencyStat({ tunnelId, latencyMs: summary.latencyMs, isTimeout: !summary.success }, { updateTunnel: false });
    for (const detail of details) await insertTunnelLatencyStat({
      tunnelId, latencyMs: detail.latencyMs, isTimeout: !detail.success,
      seriesKey: `hop-${detail.fromHostId}-${detail.toHostId}`,
      seriesLabel: detail.routeLabel, fromHostId: detail.fromHostId, toHostId: detail.toHostId,
      hopIndex: detail.hopIndex, hopCount: detail.hopCount,
    }, { updateTunnel: false });
    appendPanelLog(summary.success ? "info" : "warn", `[TunnelTest] completed tunnel=${tunnelId} batch=${batchId} segments=${rows.length} paths=${summary.available}/${summary.total} latency=${summary.latencyMs ?? "-"}ms`);
    return true;
  });
}

export async function recoverManualTunnelProbeBatches() {
  // Only completed batches need recovery. An offline batch must not starve
  // completed ones at the head of this bounded recovery queue.
  const batches = await queryRaw<{ batchId: string }>(`SELECT ${q("batchId")} FROM ${q("forward_tests")}
    WHERE ${q("batchSettled")} = ${boolLiteral(false)} AND ${q("batchId")} LIKE 'tp-%'
    GROUP BY ${q("batchId")} HAVING SUM(CASE WHEN ${q("status")} IN ('pending', 'running') THEN 1 ELSE 0 END) = 0 LIMIT 100`);
  for (const { batchId } of batches) await settleManualTunnelProbeBatch(batchId);
  if (batches.length === 100) selfTestSweepActivity.markActive();
  // Also settle pre-upgrade memory-only/orphan batches instead of preserving
  // pending:true forever. This changes probe state only, never runtime state.
  const cutoff = Math.floor(Date.now() / 1000) - SELF_TEST_MAX_LIFETIME_SECONDS;
  const candidates = await queryRaw<any>(`SELECT ${q("id")}, ${q("lastTestAt")}, ${q("lastTestMessage")} FROM ${q("tunnels")}
    WHERE ${q("lastTestStatus")} IN ('pending', 'running') OR ${q("lastTestMessage")} LIKE '%"kind":"tunnel-hop-pending"%'`);
  if (candidates.length) selfTestSweepActivity.markActive();
  const stale = candidates.filter(row => {
    let old: any; try { old = JSON.parse(row.lastTestMessage || "{}"); } catch { old = {}; }
    if (String(old.batchId || "").startsWith("tp-")) return false;
    // Automatic samples in old versions could refresh lastTestAt while keeping
    // the pending message. Its own timestamp is the reliable deadline.
    const started = Date.parse(old.generatedAt || "") / 1000;
    return (Number.isFinite(started) ? started : Number(row.lastTestAt)) < cutoff;
  });
  for (const row of stale) {
    let old: any; try { old = JSON.parse(row.lastTestMessage || "{}"); } catch { old = {}; }
    const message = structuredLinkTestMessage({ kind: "tunnel-hop-summary", tunnelId: Number(row.id),
      message: "探测超时或任务状态已失效，请重新发起探测",
      details: (old.details || []).map((detail: any) => detail.pending
        ? { ...detail, pending: false, success: false, latencyMs: null, message: "未收到探测结果" } : detail),
    });
    await executeRaw(`UPDATE ${q("tunnels")} SET ${q("lastTestStatus")} = 'failed', ${q("lastLatencyMs")} = NULL,
      ${q("lastTestMessage")} = ? WHERE ${q("id")} = ? AND ${q("lastTestMessage")} = ?`, [message, row.id, row.lastTestMessage]);
  }
}

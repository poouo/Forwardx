import { Router, Request, Response } from "express";
import * as db from "./db";
import { buildMetaAgentSelfTestPayload, buildRuleAgentSelfTestPayload, parseSelfTestMeta } from "./agentRouteUtils";
import { recordTunnelHopTestResult } from "./tunnelHopTestState";
import { recordHopTestResult } from "./hopTestState";
import { appendPanelLog } from "./_core/panelLogger";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { normalizeLinkProbeMethod } from "@shared/latencyProbe";
import { structuredLinkTestMessage, tunnelHopLatencyMode, tunnelHopModeText } from "./linkTestMessages";
import { combineTunnelRuleLatencySample, tunnelRuleLatencySampleSucceeded } from "./ruleLatency";
import { clearRuleLatencyQueryCaches } from "./ruleLatencyQueryCache";
import { waitForTunnelLatencyRefresh } from "./tunnelLatencyRefresh";
import { getTunnelAutoHopDetails } from "./tunnelAutoLatencyState";
import { getTunnelMultiEntryHopDetails } from "./tunnelMultiEntryLatencyState";
import { tunnelProbeTopologyKey } from "./probeTopology";
import { isTunnelRelayFailover } from "../shared/tunnelRelay";
import {
  selectTunnelLatencyDetailPathKey,
  structuredTunnelMessageMatchesLatency,
  timestampMs,
  tunnelDetailsMatchTopology,
  tunnelLatencySampleIsAfterBaseline,
} from "./tunnelLatencyDetails";
import { FORWARD_TUNNEL_LATENCY_WAIT_MS } from "./selfTestTiming";

async function resolveSelfTestTarget(rule: any) {
  return rule?.targetIp;
}

function tunnelSeriesKey(value: unknown, fallback: string) {
  const key = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (key || fallback).slice(0, 64);
}

function tunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || fallback).trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
}

async function isTunnelDetailsCurrent(tunnel: any, details: any[]) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId) return false;
  const [hops, exitNodes, entryHostIds] = await Promise.all([
    db.getTunnelHops(tunnelId).catch(() => []) as Promise<any[]>,
    db.getTunnelExitNodes(tunnelId).catch(() => []) as Promise<any[]>,
    tunnelEntryHostIdList(tunnel),
  ]);
  return tunnelDetailsMatchTopology({ tunnel, hops, exitNodes, entryHostIds, details });
}

async function tunnelEntryHostIdList(tunnel: any) {
  const ids = new Set<number>();
  const primary = Number(tunnel?.entryHostId || 0);
  if (primary > 0) ids.add(primary);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const group = await db.getForwardGroupById(entryGroupId).catch(() => null) as any;
    if (group?.isEnabled && String(group.groupMode || "") === "entry") {
      for (const member of group.members || []) {
        const hostId = member?.isEnabled !== false && member?.memberType === "host" ? Number(member.hostId || 0) : 0;
        if (hostId > 0) ids.add(hostId);
      }
    }
  }
  return Array.from(ids).sort((left, right) => left - right);
}

async function loadFreshTunnelAutoDetails(tunnel: any, latestLatency: any) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId) return [];
  const [hops, exitNodes, entryHostIds] = await Promise.all([
    db.getTunnelHops(tunnelId).catch(() => []) as Promise<any[]>,
    db.getTunnelExitNodes(tunnelId).catch(() => []) as Promise<any[]>,
    tunnelEntryHostIdList(tunnel),
  ]);
  const topologyKey = tunnelProbeTopologyKey(tunnel, hops, exitNodes);
  const hopCount = isTunnelRelayFailover(tunnel, hops)
    ? 2
    : Array.isArray(hops) && hops.length >= 2 ? hops.length - 1 : 1;
  const referenceAt = timestampMs(latestLatency?.recordedAt);
  const batchSeries = await db.getTunnelLatencyBranchSeriesForTotal(
    tunnelId,
    Number(latestLatency?.id || 0),
  ).catch(() => []) as any[];
  const pathKey = selectTunnelLatencyDetailPathKey(latestLatency, batchSeries);
  let rawDetails: Array<{
    hopIndex: number;
    hopCount: number;
    fromHostId: number | null;
    toHostId: number | null;
    latencyMs: number | null;
    isTimeout: boolean;
  }> | null = null;
  if (entryHostIds.length > 1) {
    rawDetails = getTunnelMultiEntryHopDetails({
      tunnelId,
      expectedEntryHostIds: entryHostIds,
      hopCount,
      generation: `${topologyKey}:entries:${entryHostIds.join(",")}`,
      pathKey,
      referenceAt,
    });
  } else {
    rawDetails = getTunnelAutoHopDetails({
      tunnelId,
      hopCount,
      generation: topologyKey,
      pathKey,
      referenceAt,
    });
  }
  if (!rawDetails?.length) return [];

  const hostIds = Array.from(new Set(rawDetails.flatMap((detail) => [detail.fromHostId, detail.toHostId]
    .map((value) => Number(value || 0))
    .filter((value) => value > 0))));
  const hostRows = await Promise.all(hostIds.map((hostId) => db.getHostById(hostId).catch(() => null)));
  const hostNames = new Map(hostIds.map((hostId, index) => [
    hostId,
    String((hostRows[index] as any)?.name || `主机${hostId}`),
  ]));
  return rawDetails.map((detail, index) => {
    const fromId = Number(detail.fromHostId || 0) || 0;
    const toId = Number(detail.toHostId || 0) || 0;
    const fromName = hostNames.get(fromId) || (fromId > 0 ? `主机${fromId}` : `节点 ${index + 1}`);
    const toName = hostNames.get(toId) || (toId > 0 ? `主机${toId}` : `节点 ${index + 2}`);
    const success = !detail.isTimeout && typeof detail.latencyMs === "number" && detail.latencyMs > 0;
    return {
      success,
      latencyMs: success ? detail.latencyMs : null,
      message: success ? null : "隧道跳探测超时",
      fromHostId: fromId || null,
      toHostId: toId || null,
      hopIndex: detail.hopIndex,
      hopCount: detail.hopCount,
      hopLabel: `${detail.hopIndex + 1}/${detail.hopCount} ${fromId || fromName}->${toId || toName}`,
      routeLabel: `${fromName} -> ${toName}`,
      method: "tcp",
      pending: false,
    };
  });
}

export function registerAgentSelfTestRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const { testId, targetReachable, latencyMs, message, resolvedTargetIp } = req.body || {};
    if (typeof testId !== "number") {
      res.status(400).json({ error: "testId is required" });
      return;
    }
    const t = await db.getForwardTestById(testId);
    if (!t || t.hostId !== host.id) {
      res.status(404).json({ error: "test not found" });
      return;
    }
    const meta = parseSelfTestMeta((t as any).message);
    const success = !!targetReachable;
    const cleanLatency = typeof latencyMs === "number" ? latencyMs : null;
    const cleanMessage = typeof message === "string" ? message.slice(0, 4000) : null;
    const cleanResolvedTargetIp = typeof resolvedTargetIp === "string" ? resolvedTargetIp.trim().slice(0, 255) : "";
    const tunnelLatencyBaselineId = meta?.kind === "forward-via-tunnel"
      ? Number((meta as any).tunnelLatencyBaselineId || 0)
      : 0;
    const refreshedTunnelLatency = meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number"
      ? await waitForTunnelLatencyRefresh({
        tunnelId: meta.tunnelId,
        baselineId: tunnelLatencyBaselineId,
        loadLatest: db.getLatestTunnelLatency,
        waitMs: FORWARD_TUNNEL_LATENCY_WAIT_MS,
      })
      : null;
    const deferTunnelRuleCompletion = meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number";
    if (!deferTunnelRuleCompletion) {
      const accepted = await db.completeForwardTestIfActive(testId, {
        status: success ? "success" : "failed",
        listenOk: true,
        targetReachable: !!targetReachable,
        forwardOk: success,
        latencyMs: cleanLatency,
        message: cleanMessage,
      });
      if (!accepted) {
        res.json({ success: true, ignored: true });
        return;
      }
    }
    if (meta?.kind === "tunnel" && typeof meta.tunnelId === "number") {
      if (success) await db.updateTunnelRunningStatus(meta.tunnelId, true);
      await db.updateTunnelTestResult(meta.tunnelId, {
        status: success ? "success" : "failed",
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
      });
      await db.insertTunnelLatencyStat(
        { tunnelId: meta.tunnelId, latencyMs: success ? cleanLatency : null, isTimeout: !success },
        { message: cleanMessage },
      );
      if (success) {
        console.log(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping success latency=${cleanLatency}ms`);
      } else {
        console.warn(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping failed: ${cleanMessage || "unknown"}`);
      }
    }
    if (meta?.kind === "tunnel-hop" && typeof meta.tunnelId === "number") {
      const hopLabel = String((meta as any).hopLabel || "hop");
      const routeLabel = typeof (meta as any).routeLabel === "string" ? (meta as any).routeLabel : null;
      const groupKey = typeof (meta as any).groupKey === "string" ? (meta as any).groupKey : null;
      const groupLabel = typeof (meta as any).groupLabel === "string" ? (meta as any).groupLabel : null;
      const latencyMode = tunnelHopLatencyMode(meta as any);
      const modeText = tunnelHopModeText(latencyMode);
      const aggregate = recordTunnelHopTestResult(testId, {
        success,
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
        hopLabel,
        routeLabel,
        groupKey,
        groupLabel,
      }, {
        latencyMode,
        successPrefix: modeText.successPrefix,
        failurePrefix: modeText.failurePrefix,
        totalLabel: modeText.totalLabel,
      });
      if (success) {
        console.log(`[TunnelTest] tunnel=${meta.tunnelId} ${hopLabel} success latency=${cleanLatency ?? "-"}ms`);
      } else {
        console.warn(`[TunnelTest] tunnel=${meta.tunnelId} ${hopLabel} failed: ${cleanMessage || "unknown"}`);
      }
      if (aggregate) {
        const aggregateMessage = structuredLinkTestMessage({
          kind: modeText.kind,
          tunnelId: aggregate.tunnelId,
          message: aggregate.message,
          details: aggregate.details,
          totalLatencyMs: aggregate.latencyMs,
        });
        if (aggregate.success) await db.updateTunnelRunningStatus(aggregate.tunnelId, true);
        await db.updateTunnelTestResult(aggregate.tunnelId, {
          status: aggregate.success ? "success" : "failed",
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          message: aggregateMessage,
        });
        const recordedAt = new Date();
        if (latencyMode === "max") {
          let branchIndex = 0;
          for (const detail of aggregate.details || []) {
            branchIndex += 1;
            const key = branchIndex === 1 ? "primary" : `exit-${branchIndex}`;
            const label = tunnelSeriesLabel((detail as any).routeLabel || (detail as any).hopLabel, `出口 ${branchIndex}`);
            const branchLatency = typeof (detail as any).latencyMs === "number" && (detail as any).latencyMs > 0 ? Number((detail as any).latencyMs) : null;
            await db.insertTunnelLatencyStat({
              tunnelId: aggregate.tunnelId,
              latencyMs: (detail as any).success ? branchLatency : null,
              isTimeout: !(detail as any).success,
              seriesKey: key,
              seriesLabel: label,
              recordedAt,
            }, { preserveMessage: true, updateTunnel: false });
          }
        }
        await db.insertTunnelLatencyStat({
          tunnelId: aggregate.tunnelId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
          seriesKey: "total",
          seriesLabel: modeText.seriesLabel,
          recordedAt,
        }, { message: aggregateMessage });
        if (aggregate.success) {
          console.log(`[TunnelTest] tunnel=${aggregate.tunnelId} multi-hop total latency=${aggregate.latencyMs}ms`);
        } else {
          console.warn(`[TunnelTest] tunnel=${aggregate.tunnelId} multi-hop failed: ${aggregate.message}`);
        }
      }
    }
    if (meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number") {
      const tunnelLatency = tunnelLatencySampleIsAfterBaseline(refreshedTunnelLatency, tunnelLatencyBaselineId)
        ? refreshedTunnelLatency
        : null;
      const tunnel = await db.getTunnelById(meta.tunnelId);
      const combinedLatency = combineTunnelRuleLatencySample({
        targetLatencyMs: cleanLatency,
        targetIsTimeout: !success,
        tunnelLatencyMs: (tunnelLatency as any)?.latencyMs,
        tunnelIsTimeout: !!(tunnelLatency as any)?.isTimeout,
        tunnelRecordedAt: (tunnelLatency as any)?.recordedAt,
      });
      const tunnelLatencyMs = combinedLatency && !combinedLatency.isTimeout && typeof (tunnelLatency as any)?.latencyMs === "number"
        ? Number((tunnelLatency as any).latencyMs)
        : 0;
      let tunnelDetails: any[] = tunnelLatency
        ? await loadFreshTunnelAutoDetails(tunnel, tunnelLatency)
        : [];
      const tunnelMessage = typeof (tunnel as any)?.lastTestMessage === "string" ? String((tunnel as any).lastTestMessage).trim() : "";
      const tunnelTestStatus = String((tunnel as any)?.lastTestStatus || "");
      if (tunnelLatency && tunnelDetails.length === 0 && tunnelMessage.startsWith("{") && tunnelTestStatus !== "pending" && tunnelTestStatus !== "running") {
        try {
          const parsedTunnelMessage = JSON.parse(tunnelMessage);
          if (
            Array.isArray(parsedTunnelMessage?.details)
            && structuredTunnelMessageMatchesLatency(
              parsedTunnelMessage?.generatedAt,
              (tunnelLatency as any)?.recordedAt,
            )
          ) {
            tunnelDetails = parsedTunnelMessage.details
              .filter((detail: any) => !detail?.pending && (detail?.success || detail?.message || typeof detail?.latencyMs === "number"))
              .map((detail: any) => ({
                success: !!detail.success,
                latencyMs: typeof detail.latencyMs === "number" ? detail.latencyMs : null,
                message: typeof detail.message === "string" ? detail.message : null,
                fromHostId: Number(detail.fromHostId || 0) || null,
                toHostId: Number(detail.toHostId || 0) || null,
                hopIndex: typeof detail.hopIndex === "number" && Number.isInteger(detail.hopIndex) && detail.hopIndex >= 0 ? detail.hopIndex : null,
                hopCount: typeof detail.hopCount === "number" && Number.isInteger(detail.hopCount) && detail.hopCount > 0 ? detail.hopCount : null,
                hopLabel: typeof detail.hopLabel === "string" ? detail.hopLabel : null,
                routeLabel: typeof detail.routeLabel === "string" ? detail.routeLabel : null,
                method: typeof detail.method === "string" ? detail.method : "tcp",
                pending: detail.pending === true,
                groupKey: typeof detail.groupKey === "string" ? detail.groupKey : null,
                groupLabel: typeof detail.groupLabel === "string" ? detail.groupLabel : null,
              }));
            if (!(await isTunnelDetailsCurrent(tunnel, tunnelDetails))) tunnelDetails = [];
          }
        } catch {
          tunnelDetails = [];
        }
      }
      const overallSuccess = tunnelRuleLatencySampleSucceeded(success, combinedLatency);
      const tunnelProbeTimedOut = !tunnelLatency || !!(tunnelLatency as any).isTimeout;
      const overallTimedOut = success && (!combinedLatency || combinedLatency.isTimeout);
      const totalLatency = combinedLatency && !combinedLatency.isTimeout ? combinedLatency.latencyMs : null;
      const target = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const targetMethod = normalizeLinkProbeMethod(meta.method);
      const resolvedTargetText = cleanResolvedTargetIp && cleanResolvedTargetIp !== String(meta.targetIp || "").trim()
        ? `解析到 ${cleanResolvedTargetIp}`
        : "";
      const messageParts = [
        `隧道整体链路测试 ${overallSuccess ? "成功" : overallTimedOut ? "超时" : "失败"}`,
        `出口到目标 ${target}${success ? ` ${cleanLatency}ms` : ""}${resolvedTargetText ? `，${resolvedTargetText}` : ""}`,
      ];
      if (tunnelLatencyMs > 0) messageParts.push(`隧道段 ${tunnelLatencyMs}ms`);
      if (tunnelProbeTimedOut) messageParts.push("隧道段探测超时");
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      const detailMessage = cleanMessage || messageParts.join("; ");
      const structuredMessage = structuredLinkTestMessage({
        kind: "forward-via-tunnel",
        tunnelId: meta.tunnelId,
        message: messageParts.join("; "),
        details: [...tunnelDetails, {
          success,
          latencyMs: success ? cleanLatency : null,
          message: success && resolvedTargetText ? resolvedTargetText : success ? null : detailMessage,
          fromHostId: Number(host.id) || null,
          hopLabel: `出口 -> 目标 ${target}`,
          routeLabel: `出口 -> 目标 ${target}`,
          method: targetMethod,
        }],
        totalLatencyMs: totalLatency,
        tunnelProbeTimedOut,
      });
      const accepted = await db.completeForwardTestIfActive(testId, {
        status: overallSuccess ? "success" : overallTimedOut ? "timeout" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: overallSuccess,
        latencyMs: totalLatency,
        message: structuredMessage,
      });
      if (!accepted) {
        res.json({ success: true, ignored: true });
        return;
      }
      if (combinedLatency) {
        await db.insertTcpingStat({
          ruleId: Number(t.ruleId),
          hostId: Number(host.id),
          latencyMs: combinedLatency.isTimeout ? null : combinedLatency.latencyMs,
          isTimeout: combinedLatency.isTimeout,
        });
        clearRuleLatencyQueryCaches();
      }
      console.log(`[SelfTest] tunnel rule overall test=${testId} tunnel=${meta.tunnelId} success=${overallSuccess} targetLatency=${cleanLatency ?? "-"}ms tunnelLatency=${tunnelLatencyMs || "-"}ms total=${totalLatency ?? "-"}ms`);
    }
    if (meta?.kind === "forward-via-tunnel-entry" && typeof meta.tunnelId === "number") {
      const entryTarget = `${meta.entryIp || "-"}:${meta.entrySourcePort || "-"}`;
      const finalTarget = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const messageParts = [
        `隧道入口端口检测 ${success ? "成功" : "失败"}`,
        `入口 ${entryTarget}${success && cleanLatency !== null ? ` ${cleanLatency}ms` : ""}`,
        `最终目标 ${finalTarget}`,
      ];
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: success,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: messageParts.join("; "),
      });
      if (success) {
        console.log(`[SelfTest] tunnel rule entry-port test=${testId} tunnel=${meta.tunnelId} success latency=${cleanLatency ?? "-"}ms entry=${entryTarget} target=${finalTarget}`);
      } else {
        console.warn(`[SelfTest] tunnel rule entry-port test=${testId} tunnel=${meta.tunnelId} failed entry=${entryTarget} target=${finalTarget}: ${cleanMessage || "unknown"}`);
      }
    }
    if (meta?.kind === "forward-chain" && typeof meta.groupId === "number") {
      const entryTarget = `${meta.entryIp || "-"}:${meta.entrySourcePort || "-"}`;
      const finalTarget = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const hopLabel = String((meta as any).hopLabel || "");
      const routeLabel = typeof (meta as any).routeLabel === "string" ? (meta as any).routeLabel : null;
      const latencyMode = (meta as any).latencyMode === "multi-source-remaining-path"
        ? "multi-source-remaining-path"
        : (meta as any).latencyMode === "remaining-path" ? "remaining-path" : "sum";
      if (hopLabel) {
        const aggregate = recordHopTestResult(testId, {
          success,
          latencyMs: success ? cleanLatency : null,
          message: cleanMessage,
          hopLabel,
          routeLabel,
          method: normalizeLinkProbeMethod((meta as any).method),
        }, {
          successPrefix: "转发链逐跳测试成功",
          failurePrefix: "转发链逐跳测试失败",
          latencyMode,
        });
        if (aggregate) {
          const aggregateMessage = structuredLinkTestMessage({
            kind: "forward-chain-hop-summary",
            groupId: meta.groupId,
            message: aggregate.message,
            details: aggregate.details,
            totalLatencyMs: aggregate.latencyMs,
          });
          await db.updateForwardTestResult(testId, {
            status: aggregate.success ? "success" : "failed",
            listenOk: aggregate.success,
            targetReachable: aggregate.success,
            forwardOk: aggregate.success,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            message: aggregateMessage,
          });
          await db.insertForwardGroupLatencyStat({
            groupId: meta.groupId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
          });
          appendPanelLog(
            aggregate.success ? "info" : "warn",
            `[SelfTest] forward-chain group=${meta.groupId} aggregate success=${aggregate.success} latency=${aggregate.success && aggregate.latencyMs !== null ? `${aggregate.latencyMs}ms` : "-"} message=${aggregate.message}`,
          );
        }
        res.json({ success: true });
        return;
      }
      const messageParts = [
        `转发链检测 ${success ? "成功" : "失败"}`,
        `入口 ${entryTarget}${success && cleanLatency !== null ? ` ${cleanLatency}ms` : ""}`,
        `最终目标 ${finalTarget}`,
      ];
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: success,
        targetReachable: success,
        forwardOk: success,
        latencyMs: success ? cleanLatency : null,
        message: messageParts.join("; "),
      });
      appendPanelLog(
        success ? "info" : "warn",
        `[SelfTest] forward-chain test=${testId} group=${meta.groupId} success=${success} latency=${success && cleanLatency !== null ? `${cleanLatency}ms` : "-"} entry=${entryTarget} target=${finalTarget}${cleanMessage && !success ? ` message=${cleanMessage}` : ""}`,
      );
    }
    if (!meta) {
      await db.insertTcpingStat({
        ruleId: Number(t.ruleId),
        hostId: Number(host.id),
        latencyMs: success && cleanLatency !== null ? cleanLatency : null,
        isTimeout: !success || cleanLatency === null,
      });
      clearRuleLatencyQueryCaches();
      appendPanelLog(
        success ? "info" : "warn",
        `[SelfTest] rule=${t.ruleId} direct test=${testId} host=${host.id} success=${success} latency=${success && cleanLatency !== null ? `${cleanLatency}ms` : "-"}${cleanMessage ? ` message=${cleanMessage}` : ""}`,
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent SelfTest] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
agentRouter.post("/api/agent/selftest-pull", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const pendingTests = await db.getPendingForwardTestsByHost(host.id);
    const selfTests: any[] = [];
    for (const t of pendingTests) {
      const claimed = await db.markForwardTestRunning(t.id);
      if (!claimed) continue;
      const meta = parseSelfTestMeta((t as any).message);
      const metaSelfTest = buildMetaAgentSelfTestPayload(t, meta);
      if (metaSelfTest) {
        selfTests.push(metaSelfTest);
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      const targetIp = await resolveSelfTestTarget(rule);
      selfTests.push(buildRuleAgentSelfTestPayload(t, rule, targetIp));
    }
    res.json({ success: true, selfTests });
  } catch (error) {
    console.error("[Agent SelfTest Pull] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 流量上报

}

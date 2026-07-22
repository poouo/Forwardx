import { Router, Request, Response } from "express";
import * as db from "./db";
import { buildMetaAgentSelfTestPayload, buildRuleAgentSelfTestPayload, parseSelfTestMeta } from "./agentRouteUtils";
import { recordTunnelHopTestResult } from "./tunnelHopTestState";
import { recordHopTestResult } from "./hopTestState";
import { appendPanelLog } from "./_core/panelLogger";
import { getAgentHostFromRequest } from "./agentAuth";
import { normalizeLinkProbeMethod } from "@shared/latencyProbe";
import { structuredLinkTestMessage, tunnelHopLatencyMode, tunnelHopModeText } from "./linkTestMessages";
import { combineTunnelRuleLatencySample } from "./ruleLatency";
import { clearRuleLatencyQueryCaches } from "./ruleLatencyQueryCache";

async function resolveSelfTestTarget(rule: any) {
  return rule?.targetIp;
}

async function waitForTunnelLatencyRefresh(tunnelId: number, baselineId: number, waitMs = 4500) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let latest = await db.getLatestTunnelLatency(tunnelId);
  while (Date.now() < deadline) {
    const latestId = Number((latest as any)?.id || 0);
    if (latestId > 0 && (baselineId <= 0 || latestId !== baselineId)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await db.getLatestTunnelLatency(tunnelId);
  }
  return latest;
}

function tunnelSeriesKey(value: unknown, fallback: string) {
  const key = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (key || fallback).slice(0, 64);
}

function tunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || fallback).trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
}

function detailHostEdges(details: any[]) {
  const edges: Array<[number, number]> = [];
  for (const detail of details || []) {
    const labels = [detail?.hopLabel, detail?.routeLabel]
      .map((value) => String(value || ""))
      .filter(Boolean);
    for (const label of labels) {
      const match = label.match(/(\d+)\s*->\s*(\d+)/);
      if (!match) continue;
      const from = Number(match[1]);
      const to = Number(match[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) continue;
      edges.push([from, to]);
      break;
    }
  }
  return edges;
}

async function currentTunnelHostPath(tunnel: any) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId) return [];
  const hops = await db.getTunnelHops(tunnelId).catch(() => []) as any[];
  if (Array.isArray(hops) && hops.length >= 2) {
    return hops
      .map((hop) => Number(hop?.hostId || 0))
      .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
  }
  return [Number(tunnel?.entryHostId || 0), Number(tunnel?.exitHostId || 0)]
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
}

async function isTunnelDetailsCurrent(tunnel: any, details: any[]) {
  const detailEdges = detailHostEdges(details);
  if (detailEdges.length === 0) return false;
  const currentPath = await currentTunnelHostPath(tunnel);
  if (currentPath.length < 2) return false;
  const allowedEdges = new Set<string>();
  for (let index = 0; index < currentPath.length - 1; index += 1) {
    allowedEdges.add(`${currentPath[index]}->${currentPath[index + 1]}`);
  }
  const firstNextHostId = Number(currentPath[1] || currentPath[currentPath.length - 1] || 0);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0 && firstNextHostId > 0) {
    const entryGroup = await db.getForwardGroupById(entryGroupId).catch(() => null) as any;
    for (const member of entryGroup?.members || []) {
      const hostId = Number(member?.hostId || 0);
      if (member?.isEnabled !== false && hostId > 0) allowedEdges.add(`${hostId}->${firstNextHostId}`);
    }
  }
  const extraExits = await db.getTunnelExitNodes(Number(tunnel?.id || 0)).catch(() => []) as any[];
  const entryHostId = Number(currentPath[0] || tunnel?.entryHostId || 0);
  for (const exit of extraExits || []) {
    const exitHostId = Number(exit?.hostId || 0);
    if (entryHostId > 0 && exitHostId > 0) allowedEdges.add(`${entryHostId}->${exitHostId}`);
  }
  return detailEdges.every(([from, to]) => allowedEdges.has(`${from}->${to}`));
}

export function registerAgentSelfTestRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
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
    const refreshedTunnelLatency = meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number"
      ? await waitForTunnelLatencyRefresh(meta.tunnelId, Number((meta as any).tunnelLatencyBaselineId || 0))
      : null;
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
      const tunnelLatency = refreshedTunnelLatency;
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
      let tunnelDetails: any[] = [];
      const tunnelMessage = typeof (tunnel as any)?.lastTestMessage === "string" ? String((tunnel as any).lastTestMessage).trim() : "";
      const tunnelTestStatus = String((tunnel as any)?.lastTestStatus || "");
      if (tunnelMessage.startsWith("{") && tunnelTestStatus !== "pending" && tunnelTestStatus !== "running") {
        try {
          const parsedTunnelMessage = JSON.parse(tunnelMessage);
          if (Array.isArray(parsedTunnelMessage?.details)) {
            tunnelDetails = parsedTunnelMessage.details
              .filter((detail: any) => !detail?.pending && (detail?.success || detail?.message || typeof detail?.latencyMs === "number"))
              .map((detail: any) => ({
                success: !!detail.success,
                latencyMs: typeof detail.latencyMs === "number" ? detail.latencyMs : null,
                message: typeof detail.message === "string" ? detail.message : null,
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
      const overallSuccess = success && combinedLatency?.isTimeout !== true;
      const totalLatency = combinedLatency && !combinedLatency.isTimeout ? combinedLatency.latencyMs : null;
      const target = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const targetMethod = normalizeLinkProbeMethod(meta.method);
      const resolvedTargetText = cleanResolvedTargetIp && cleanResolvedTargetIp !== String(meta.targetIp || "").trim()
        ? `解析到 ${cleanResolvedTargetIp}`
        : "";
      const messageParts = [
        `隧道整体链路测试 ${overallSuccess ? "成功" : "失败"}`,
        `出口到目标 ${target}${success ? ` ${cleanLatency}ms` : ""}${resolvedTargetText ? `，${resolvedTargetText}` : ""}`,
      ];
      if (tunnelLatencyMs > 0) messageParts.push(`隧道段 ${tunnelLatencyMs}ms`);
      if (success && !combinedLatency) messageParts.push("隧道段暂无新鲜探测结果");
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
          hopLabel: `出口 -> 目标 ${target}`,
          routeLabel: `出口 -> 目标 ${target}`,
          method: targetMethod,
        }],
        totalLatencyMs: totalLatency,
      });
      await db.updateForwardTestResult(testId, {
        status: overallSuccess ? "success" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: overallSuccess,
        latencyMs: totalLatency,
        message: structuredMessage,
      });
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
    const host = await getAgentHostFromRequest(req);
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

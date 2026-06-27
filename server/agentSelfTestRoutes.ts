import { Router, Request, Response } from "express";
import * as db from "./db";
import { parseSelfTestMeta } from "./agentRouteUtils";
import { recordTunnelHopTestResult } from "./tunnelHopTestState";
import { recordHopTestResult } from "./hopTestState";
import { appendPanelLog } from "./_core/panelLogger";
import { getAgentHostFromRequest } from "./agentAuth";

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

function structuredLinkTestMessage(input: {
  kind: string;
  message: string;
  details?: any[];
  totalLatencyMs?: number | null;
  groupId?: number | null;
  tunnelId?: number | null;
}) {
  return JSON.stringify({
    kind: input.kind,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.tunnelId ? { tunnelId: input.tunnelId } : {}),
    message: input.message,
    details: input.details || [],
    totalLatencyMs: input.totalLatencyMs ?? null,
  });
}

function tunnelHopLatencyMode(meta: any): "sum" | "max" | "multi-source" {
  const value = String(meta?.latencyMode || "");
  return value === "max" || value === "multi-source" ? value : "sum";
}

function tunnelHopModeText(latencyMode: "sum" | "max" | "multi-source") {
  if (latencyMode === "max") {
    return {
      kind: "tunnel-load-balance-summary",
      successPrefix: "多出口负载探测成功",
      failurePrefix: "多出口负载探测失败",
      totalLabel: "最大延迟",
      seriesLabel: "最大延迟",
    };
  }
  if (latencyMode === "multi-source") {
    return {
      kind: "tunnel-entry-group-summary",
      successPrefix: "多入口隧道探测成功",
      failurePrefix: "多入口隧道探测失败",
      totalLabel: "总延迟",
      seriesLabel: "总延迟",
    };
  }
  return {
    kind: "tunnel-hop-summary",
    successPrefix: "多级隧道逐跳测试成功",
    failurePrefix: "多级隧道逐跳测试失败",
    totalLabel: undefined,
    seriesLabel: "总延迟",
  };
}

function ruleLatencyProbeMethod(rule: any): "tcp" | "ping" {
  return String(rule?.protocol || "tcp").toLowerCase() === "udp" ? "ping" : "tcp";
}

export function registerAgentSelfTestRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const { testId, targetReachable, latencyMs, message } = req.body || {};
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
    await db.updateForwardTestResult(testId, {
      status: success ? "success" : "failed",
      listenOk: true,
      targetReachable: !!targetReachable,
      forwardOk: success,
      latencyMs: cleanLatency,
      message: cleanMessage,
    });
    if (meta?.kind === "tunnel" && typeof meta.tunnelId === "number") {
      await db.updateTunnelRunningStatus(meta.tunnelId, success);
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
        await db.updateTunnelRunningStatus(aggregate.tunnelId, aggregate.success);
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
      const tunnel = await db.getTunnelById(meta.tunnelId);
      const tunnelLatency = await db.getLatestTunnelLatency(meta.tunnelId);
      let tunnelLatencyMs =
        tunnelLatency && !(tunnelLatency as any).isTimeout && typeof (tunnelLatency as any).latencyMs === "number"
          ? Number((tunnelLatency as any).latencyMs)
          : 0;
      if (tunnelLatencyMs <= 0) {
        const last = Number((tunnel as any)?.lastLatencyMs) || 0;
        if (last > 0) tunnelLatencyMs = last;
      }
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
          }
        } catch {
          tunnelDetails = [];
        }
      }
      const totalLatency = success && cleanLatency !== null ? cleanLatency + tunnelLatencyMs : null;
      const target = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const targetMethod = meta.method === "ping" ? "ping" : "tcp";
      const messageParts = [
        `隧道整体链路测试 ${success ? "成功" : "失败"}`,
        `出口到目标 ${target}${success ? ` ${cleanLatency}ms` : ""}`,
      ];
      if (tunnelLatencyMs > 0) messageParts.push(`隧道段 ${tunnelLatencyMs}ms`);
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      const detailMessage = cleanMessage || messageParts.join("; ");
      const structuredMessage = structuredLinkTestMessage({
        kind: "forward-via-tunnel",
        tunnelId: meta.tunnelId,
        message: messageParts.join("; "),
        details: [...tunnelDetails, {
          success,
          latencyMs: success ? cleanLatency : null,
          message: success ? null : detailMessage,
          hopLabel: `出口 -> 目标 ${target}`,
          routeLabel: `出口 -> 目标 ${target}`,
          method: targetMethod,
        }],
        totalLatencyMs: totalLatency,
      });
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: success,
        latencyMs: totalLatency,
        message: structuredMessage,
      });
      console.log(`[SelfTest] tunnel rule overall test=${testId} tunnel=${meta.tunnelId} success=${success} targetLatency=${cleanLatency ?? "-"}ms tunnelLatency=${tunnelLatencyMs || "-"}ms total=${totalLatency ?? "-"}ms`);
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
          method: (meta as any).method === "ping" ? "ping" : "tcp",
        }, {
          successPrefix: "端口转发链逐跳测试成功",
          failurePrefix: "端口转发链逐跳测试失败",
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
        `端口转发链检测 ${success ? "成功" : "失败"}`,
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
      await db.markForwardTestRunning(t.id);
      const meta = parseSelfTestMeta((t as any).message);
      if (meta?.kind === "tunnel") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "tunnel-hop") {
        selfTests.push({
          testId: t.id,
          kind: "tunnel-hop",
          tunnelId: meta.tunnelId,
          ruleId: 0,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel") {
        const method = meta.method === "ping" ? "ping" : "tcp";
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: method,
          method,
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel-entry") {
        const method = meta.method === "ping" ? "ping" : "tcp";
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel-entry",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: method,
          method,
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.entryIp,
          targetPort: meta.entrySourcePort,
        });
        continue;
      }
      if (meta?.kind === "forward-chain") {
        const method = meta.method === "ping" ? "ping" : "tcp";
        selfTests.push({
          testId: t.id,
          kind: "forward-chain",
          groupId: meta.groupId,
          ruleId: t.ruleId,
          forwardType: "forward-chain",
          protocol: method,
          method,
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.targetIp || meta.entryIp,
          targetPort: meta.targetPort || meta.entrySourcePort,
        });
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      const targetIp = await resolveSelfTestTarget(rule);
      const method = ruleLatencyProbeMethod(rule);
      selfTests.push({
        testId: t.id,
        ruleId: rule.id,
        forwardType: rule.forwardType,
        protocol: method,
        method,
        sourcePort: rule.sourcePort,
        targetIp,
        targetPort: rule.targetPort,
      });
    }
    res.json({ success: true, selfTests });
  } catch (error) {
    console.error("[Agent SelfTest Pull] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 流量上报

}

import { Router, Request, Response } from "express";
import * as db from "./db";
import { parseSelfTestMeta } from "./agentRouteUtils";
import { recordTunnelHopTestResult } from "./tunnelHopTestState";

export function registerAgentSelfTestRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/selftest-result", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
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
      await db.insertTunnelLatencyStat({ tunnelId: meta.tunnelId, latencyMs: success ? cleanLatency : null, isTimeout: !success });
      if (success) {
        console.log(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping success latency=${cleanLatency}ms`);
      } else {
        console.warn(`[TunnelTest] tunnel=${meta.tunnelId} entry-agent tcping failed: ${cleanMessage || "unknown"}`);
      }
    }
    if (meta?.kind === "tunnel-hop" && typeof meta.tunnelId === "number") {
      const hopLabel = String((meta as any).hopLabel || "hop");
      const aggregate = recordTunnelHopTestResult(testId, {
        success,
        latencyMs: success ? cleanLatency : null,
        message: cleanMessage,
        hopLabel,
      });
      if (success) {
        console.log(`[TunnelTest] tunnel=${meta.tunnelId} ${hopLabel} success latency=${cleanLatency ?? "-"}ms`);
      } else {
        console.warn(`[TunnelTest] tunnel=${meta.tunnelId} ${hopLabel} failed: ${cleanMessage || "unknown"}`);
      }
      if (aggregate) {
        await db.updateTunnelRunningStatus(aggregate.tunnelId, aggregate.success);
        await db.updateTunnelTestResult(aggregate.tunnelId, {
          status: aggregate.success ? "success" : "failed",
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          message: aggregate.message,
        });
        await db.insertTunnelLatencyStat({
          tunnelId: aggregate.tunnelId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
        });
        if (aggregate.success) {
          console.log(`[TunnelTest] tunnel=${aggregate.tunnelId} multi-hop total latency=${aggregate.latencyMs}ms`);
        } else {
          console.warn(`[TunnelTest] tunnel=${aggregate.tunnelId} multi-hop failed: ${aggregate.message}`);
        }
      }
    }
    if (meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number") {
      const tunnelLatency = await db.getLatestTunnelLatency(meta.tunnelId);
      let tunnelLatencyMs =
        tunnelLatency && !(tunnelLatency as any).isTimeout && typeof (tunnelLatency as any).latencyMs === "number"
          ? Number((tunnelLatency as any).latencyMs)
          : 0;
      if (tunnelLatencyMs <= 0) {
        const tunnel = await db.getTunnelById(meta.tunnelId);
        const last = Number((tunnel as any)?.lastLatencyMs) || 0;
        if (last > 0) tunnelLatencyMs = last;
      }
      const totalLatency = success && cleanLatency !== null ? cleanLatency + tunnelLatencyMs : null;
      const target = `${meta.targetIp || "-"}:${meta.targetPort || "-"}`;
      const messageParts = [
        `隧道整体链路测试 ${success ? "成功" : "失败"}`,
        `出口到目标 ${target}${success ? ` ${cleanLatency}ms` : ""}`,
      ];
      if (tunnelLatencyMs > 0) messageParts.push(`隧道段 ${tunnelLatencyMs}ms`);
      if (cleanMessage && !success) messageParts.push(cleanMessage);
      await db.updateForwardTestResult(testId, {
        status: success ? "success" : "failed",
        listenOk: true,
        targetReachable: success,
        forwardOk: success,
        latencyMs: totalLatency,
        message: messageParts.join("; "),
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
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent SelfTest] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
agentRouter.post("/api/agent/selftest-pull", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
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
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: 0,
          targetIp: meta.targetIp,
          targetPort: meta.targetPort,
        });
        continue;
      }
      if (meta?.kind === "forward-via-tunnel-entry") {
        selfTests.push({
          testId: t.id,
          kind: "forward-via-tunnel-entry",
          tunnelId: meta.tunnelId,
          ruleId: t.ruleId,
          forwardType: "gost-tunnel",
          protocol: "tcp",
          sourcePort: meta.entrySourcePort || 0,
          targetIp: meta.entryIp,
          targetPort: meta.entrySourcePort,
        });
        continue;
      }
      const rule = await db.getForwardRuleById(t.ruleId);
      if (!rule) continue;
      selfTests.push({
        testId: t.id,
        ruleId: rule.id,
        forwardType: rule.forwardType,
        protocol: rule.protocol,
        sourcePort: rule.sourcePort,
        targetIp: rule.targetIp,
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

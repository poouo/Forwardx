import { Router, Request, Response } from "express";
import * as db from "./db";
import {
  isAgentTcpingResult,
  isAgentTrafficStat,
  isAgentTunnelTcpingResult,
  type AgentTcpingResult,
  type AgentTrafficStat,
  type AgentTunnelTcpingResult,
} from "../shared/agentDtos";

export function registerAgentReportRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/traffic", async (req: Request, res: Response) => {
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

    const stats: AgentTrafficStat[] = Array.isArray(req.body?.stats)
      ? req.body.stats.filter(isAgentTrafficStat)
      : [];
    if (!Array.isArray(req.body?.stats)) {
      res.status(400).json({ error: "stats array is required" });
      return;
    }

    const quotaTrafficByUser = new Map<number, number>();
    const trafficBillingEnabled = await db.isTrafficBillingEnabled();
    for (const stat of stats) {
      const bytesIn = Number(stat.bytesIn) || 0;
      const bytesOut = Number(stat.bytesOut) || 0;
      const rule = await db.getForwardRuleById(stat.ruleId);
      if (!rule) {
        continue;
      }
      let allowedHost = rule.hostId === host.id;
      if (!allowedHost && (rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        allowedHost = !!tunnel && tunnel.exitHostId === host.id;
      }
      if (!allowedHost) {
        continue;
      }
      await db.insertTrafficStat({
        ruleId: stat.ruleId,
        hostId: host.id,
        bytesIn,
        bytesOut,
        connections: stat.connections || 0,
      });
      const ruleBytes = bytesIn + bytesOut;
      if (ruleBytes > 0) {
        console.log(`[Traffic] host=${host.id} rule=${rule.id} in=${bytesIn} out=${bytesOut} connections=${stat.connections || 0}`);
        const tunnelId = Number((rule as any).tunnelId || 0);
        const billingResource = tunnelId > 0
          ? { resourceType: "tunnel" as const, resourceId: tunnelId }
          : { resourceType: "host" as const, resourceId: Number(rule.hostId) };
        const billingConfig = trafficBillingEnabled
          ? await db.findTrafficBillingConfig(billingResource.resourceType, billingResource.resourceId)
          : null;
        if (billingConfig) {
          const billed = await db.billTrafficUsage({
            userId: Number(rule.userId),
            ruleId: Number(rule.id),
            bytes: ruleBytes,
            ...billingResource,
          });
          if (billed && billed.balanceAfterCents < 0) {
            console.warn(`[TrafficBilling] user=${rule.userId} balance negative, disabling rules`);
            await db.disableAllUserRules(rule.userId);
          }
        } else {
          quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + ruleBytes);
        }
      }
    }

    // 累加用户已用流量
    for (const [userId, totalBytes] of quotaTrafficByUser.entries()) {
      if (totalBytes <= 0) continue;
      await db.addUserTraffic(userId, totalBytes);

      // 检查用户流量配额
      const user = await db.getUserById(userId);
      if (user) {
        // 流量超额：自动禁用该用户所有规则
        if (user.trafficLimit > 0 && (user.trafficUsed + totalBytes) >= user.trafficLimit) {
          console.log(`[Traffic] User ${user.id} traffic exceeded limit, disabling rules`);
          await db.disableAllUserRules(user.id);
        }
        // 账户到期：自动禁用该用户所有规则
        if (user.expiresAt && new Date(user.expiresAt) <= new Date()) {
          console.log(`[Traffic] User ${user.id} account expired, disabling rules`);
          await db.disableAllUserRules(user.id);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Traffic] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent TCPing 上报接口
agentRouter.post("/api/agent/tcping", async (req: Request, res: Response) => {
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

    const results: AgentTcpingResult[] = Array.isArray(req.body?.results)
      ? req.body.results.filter(isAgentTcpingResult)
      : [];
    const rawTunnelResults = Array.isArray(req.body?.tunnels)
      ? req.body.tunnels
      : (Array.isArray(req.body?.tunnelResults) ? req.body.tunnelResults : []);
    const tunnelResults: AgentTunnelTcpingResult[] = rawTunnelResults.filter(isAgentTunnelTcpingResult);
    if (results.length === 0 && tunnelResults.length === 0) {
      res.status(400).json({ error: "results or tunnels array is required" });
      return;
    }

    const stats = results
      .map((r) => ({
        ruleId: Number(r.ruleId),
        hostId: host.id,
        latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
        isTimeout: !!r.isTimeout,
      }))
      .filter((r) => r.ruleId > 0);

    if (stats.length > 0) {
      await db.insertTcpingStats(stats);
    }

    for (const r of tunnelResults) {
      const tunnelId = Number(r.tunnelId);
      if (!tunnelId) continue;
      const tunnel = await db.getTunnelById(tunnelId);
      if (!tunnel || tunnel.entryHostId !== host.id) continue;
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
        isTimeout: !!r.isTimeout,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Agent TCPing] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

}

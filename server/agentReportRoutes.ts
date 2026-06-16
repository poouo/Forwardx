import { Router, Request, Response } from "express";
import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import {
  isAgentForwardGroupLatencyResult,
  isAgentTcpingResult,
  isAgentTrafficStat,
  isAgentTunnelTcpingResult,
  type AgentForwardGroupLatencyResult,
  type AgentTcpingResult,
  type AgentTrafficStat,
  type AgentTunnelTcpingResult,
} from "../shared/agentDtos";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { completeLookingGlassAgentTask, updateLookingGlassAgentTaskProgress, type LookingGlassMethod } from "./lookingGlassAgentTasks";
import { completeIperf3AgentTask } from "./iperf3AgentTasks";
import { getAgentHostFromRequest } from "./agentAuth";

async function refreshUserRuleAgents(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    if (rule.hostId) hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    hostIds.add(Number(tunnel.entryHostId));
    hostIds.add(Number(tunnel.exitHostId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason);
  }
}

function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

function trafficAccountingHostId(rule: any, tunnel: any | null) {
  if (!tunnel) return Number(rule.hostId);
  return isForwardXTunnel(tunnel) ? Number(tunnel.entryHostId) : Number(tunnel.exitHostId);
}

async function shouldAccountForwardRuleTraffic(rule: any) {
  const groupId = Number(rule?.forwardGroupId || 0);
  const templateId = Number(rule?.forwardGroupRuleId || 0);
  const memberId = Number(rule?.forwardGroupMemberId || 0);
  if (!groupId || !templateId || !memberId) return true;
  const group = await db.getForwardGroupById(groupId) as any;
  if (String(group?.groupMode || "failover") !== "chain") return true;
  const members = [...(group.members || [])]
    .filter((member: any) => !!member.isEnabled)
    .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
  return Number(members[0]?.id || 0) === memberId;
}

export function registerAgentReportRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/looking-glass-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeLookingGlassAgentTask(host.id, {
      taskId: String(result.taskId),
      method: result.method as LookingGlassMethod,
      target: String(result.target || ""),
      port: result.port === undefined || result.port === null ? undefined : Number(result.port),
      resolvedAddress: String(result.resolvedAddress || ""),
      resolvedAddresses: Array.isArray(result.resolvedAddresses) ? result.resolvedAddresses.map(String) : [],
      output: String(result.output || ""),
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      finishedAt: String(result.finishedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlass] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/looking-glass-progress", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = updateLookingGlassAgentTaskProgress(host.id, {
      taskId: String(result.taskId),
      output: String(result.output || ""),
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlassProgress] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/iperf3-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeIperf3AgentTask(host.id, {
      taskId: String(result.taskId),
      op: result.op === "stop" ? "stop" : "start",
      port: Number(result.port || 5201),
      status: result.status === "stopped" ? "stopped" : result.status === "error" ? "error" : "running",
      output: String(result.output || ""),
      pid: result.pid === undefined || result.pid === null ? null : Number(result.pid),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      updatedAt: result.updatedAt ? String(result.updatedAt) : undefined,
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Iperf3] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/traffic", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
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
      if ((rule as any).pendingDelete || !(rule as any).isRunning) {
        continue;
      }
      if (!await shouldAccountForwardRuleTraffic(rule)) {
        continue;
      }
      const tunnelId = Number((rule as any).tunnelId || 0);
      const tunnel = tunnelId > 0 ? await db.getTunnelById(tunnelId) : null;
      const accountingHostId = trafficAccountingHostId(rule, tunnel);
      if (accountingHostId !== Number(host.id)) {
        const ruleBytes = bytesIn + bytesOut;
        if (ruleBytes > 0 && tunnel && !isForwardXTunnel(tunnel)) {
          console.log(`[TunnelTraffic] host=${host.id} tunnel=${tunnelId} rule=${rule.id} in=${bytesIn} out=${bytesOut} connections=${stat.connections || 0}`);
        }
        continue;
      }
      await db.insertTrafficStat({
        ruleId: stat.ruleId,
        hostId: host.id,
        bytesIn,
        bytesOut,
        connections: stat.connections || 0,
      }, {
        userId: Number(rule.userId),
      });
      const ruleBytes = bytesIn + bytesOut;
      if (ruleBytes > 0) {
        console.log(`[Traffic] host=${host.id} rule=${rule.id} in=${bytesIn} out=${bytesOut} connections=${stat.connections || 0}`);
        const billingResource = tunnelId > 0
          ? { resourceType: "tunnel" as const, resourceId: tunnelId }
          : { resourceType: "host" as const, resourceId: Number(rule.hostId) };
        const billingConfig = trafficBillingEnabled
          ? await db.findTrafficBillingConfig(billingResource.resourceType, billingResource.resourceId)
          : null;
        if (billingConfig) {
          const user = await db.getUserById(Number(rule.userId));
          if (user && Number((user as any).balanceCents || 0) <= 0) {
            console.warn(`[TrafficBilling] user=${rule.userId} balance unavailable, disabling rules`);
            await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
            await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-unavailable");
            continue;
          }
          const billed = await db.billTrafficUsage({
            userId: Number(rule.userId),
            ruleId: Number(rule.id),
            bytes: ruleBytes,
            ...billingResource,
          });
          if (billed && billed.balanceAfterCents < 0) {
            console.warn(`[TrafficBilling] user=${rule.userId} balance negative, disabling rules`);
            await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
            await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-negative");
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
        if (user.trafficLimit > 0 && user.trafficUsed >= user.trafficLimit) {
          console.log(`[Traffic] User ${user.id} traffic exceeded limit, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "traffic_limit");
          await refreshUserRuleAgents(user.id, "traffic-limit-exceeded");
        }
        // 账户到期：自动禁用该用户所有规则
        if (user.expiresAt && new Date(user.expiresAt) <= new Date()) {
          console.log(`[Traffic] User ${user.id} account expired, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "expired");
          await refreshUserRuleAgents(user.id, "user-expired");
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
    const host = await getAgentHostFromRequest(req);
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
    const rawForwardGroupResults = Array.isArray(req.body?.forwardGroups)
      ? req.body.forwardGroups
      : (Array.isArray(req.body?.forwardGroupResults) ? req.body.forwardGroupResults : []);
    const forwardGroupResults: AgentForwardGroupLatencyResult[] = rawForwardGroupResults.filter(isAgentForwardGroupLatencyResult);
    if (results.length === 0 && tunnelResults.length === 0 && forwardGroupResults.length === 0) {
      res.status(400).json({ error: "results, tunnels or forwardGroups array is required" });
      return;
    }

    for (const r of tunnelResults) {
      const tunnelId = Number(r.tunnelId);
      if (!tunnelId) continue;
      const tunnel = await db.getTunnelById(tunnelId);
      if (!tunnel) continue;
      const hopIndex = Number((r as any).hopIndex);
      const hopCount = Number((r as any).hopCount);
      if (Number.isFinite(hopIndex) && Number.isFinite(hopCount) && hopCount > 0) {
        const aggregate = recordTunnelAutoHopLatency({
          tunnelId,
          hopIndex,
          hopCount,
          latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
          isTimeout: !!r.isTimeout,
        });
        if (!aggregate) continue;
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
        });
        if (aggregate.success && !(tunnel as any).isRunning) {
          await db.updateTunnelRunningStatus(tunnelId, true);
        }
        continue;
      }
      if (tunnel.entryHostId !== host.id) continue;
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
        isTimeout: !!r.isTimeout,
      });
    }

    for (const r of forwardGroupResults) {
      const groupId = Number(r.groupId);
      if (!groupId) continue;
      const group = await db.getForwardGroupById(groupId) as any;
      if (!group || String(group.groupMode || "failover") !== "chain") continue;
      const hopIndex = Number((r as any).hopIndex);
      const hopCount = Number((r as any).hopCount);
      if (!Number.isFinite(hopIndex) || !Number.isFinite(hopCount) || hopCount <= 0) continue;
      const aggregate = recordForwardGroupAutoHopLatency({
        groupId,
        hopIndex,
        hopCount,
        latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
        isTimeout: !!r.isTimeout,
      });
      if (!aggregate) continue;
      await db.insertForwardGroupLatencyStat({
        groupId,
        latencyMs: aggregate.success ? aggregate.latencyMs : null,
        isTimeout: !aggregate.success,
      });
    }

    const stats = [];
    const tunnelLatencyById = new Map<number, number>();
    for (const r of results) {
      const ruleId = Number(r.ruleId);
      if (ruleId <= 0) continue;
      const rule = await db.getForwardRuleById(ruleId) as any;
      const baseLatency = typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null;
      let latencyMs = baseLatency;
      if (!r.isTimeout && baseLatency && rule?.tunnelId) {
        const tunnelId = Number(rule.tunnelId);
        let tunnelLatency = tunnelLatencyById.get(tunnelId);
        if (tunnelLatency === undefined) {
          const latest = await db.getLatestTunnelLatency(tunnelId) as any;
          tunnelLatency = latest && !latest.isTimeout && typeof latest.latencyMs === "number"
            ? Number(latest.latencyMs)
            : 0;
          if (tunnelLatency <= 0) {
            const tunnel = await db.getTunnelById(tunnelId) as any;
            tunnelLatency = Number(tunnel?.lastLatencyMs) || 0;
          }
          tunnelLatencyById.set(tunnelId, tunnelLatency);
        }
        if (tunnelLatency > 0) latencyMs = baseLatency + tunnelLatency;
      }
      stats.push({
        ruleId,
        hostId: host.id,
        latencyMs,
        isTimeout: !!r.isTimeout,
      });
    }

    if (stats.length > 0) {
      await db.insertTcpingStats(stats);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Agent TCPing] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

}

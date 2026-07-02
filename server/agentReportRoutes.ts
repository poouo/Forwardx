import { Router, Request, Response } from "express";
import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import {
  isAgentForwardGroupLatencyResult,
  isAgentHostProbeServiceResult,
  isAgentHostTrafficStat,
  isAgentTcpingResult,
  isAgentTrafficStat,
  isAgentTunnelTcpingResult,
  type AgentForwardGroupLatencyResult,
  type AgentHostProbeServiceResult,
  type AgentHostTrafficStat,
  type AgentTcpingResult,
  type AgentTrafficStat,
  type AgentTunnelTcpingResult,
} from "../shared/agentDtos";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { completeLookingGlassAgentTask, updateLookingGlassAgentTaskProgress, type LookingGlassMethod } from "./lookingGlassAgentTasks";
import { completeIperf3AgentTask } from "./iperf3AgentTasks";
import { getAgentHostFromRequest } from "./agentAuth";
import { applyTrafficMultiplier, normalizeTrafficMultiplier } from "../shared/trafficMultiplier";

const VERBOSE_AGENT_REPORTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_REPORTS || ""));

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

function cleanTunnelSeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key.slice(0, 64);
}

function cleanTunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
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

async function quotaTrafficMultiplierForRule(rule: any, tunnel: any | null) {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (groupId > 0) {
    const group = await db.getForwardGroupById(groupId) as any;
    if (String(group?.groupMode || "failover") === "chain") {
      return normalizeTrafficMultiplier(group?.trafficMultiplier);
    }
  }
  if (tunnel) return normalizeTrafficMultiplier((tunnel as any).trafficMultiplier);
  return 100;
}

const trafficReportLogIntervalMs = 10_000;
const tcpingReportLogIntervalMs = 30_000;

type TrafficReportLogBucket = {
  lastLoggedAt: number;
  samples: number;
  bytesIn: number;
  bytesOut: number;
  connectionsMax: number;
};

const trafficReportLogBuckets = new Map<string, TrafficReportLogBucket>();
const reportLogTimes = new Map<string, number>();

function logTrafficReportSample(key: string, label: string, bytesIn: number, bytesOut: number, connections: number) {
  if (!VERBOSE_AGENT_REPORTS) return;
  const now = Date.now();
  const bucket = trafficReportLogBuckets.get(key) || {
    lastLoggedAt: 0,
    samples: 0,
    bytesIn: 0,
    bytesOut: 0,
    connectionsMax: 0,
  };
  bucket.samples += 1;
  bucket.bytesIn += Math.max(0, Number(bytesIn) || 0);
  bucket.bytesOut += Math.max(0, Number(bytesOut) || 0);
  bucket.connectionsMax = Math.max(bucket.connectionsMax, Number(connections) || 0);
  if (bucket.lastLoggedAt === 0 || now - bucket.lastLoggedAt >= trafficReportLogIntervalMs) {
    console.log(`${label} samples=${bucket.samples} in=${bucket.bytesIn} out=${bucket.bytesOut} connectionsMax=${bucket.connectionsMax}`);
    trafficReportLogBuckets.set(key, {
      lastLoggedAt: now,
      samples: 0,
      bytesIn: 0,
      bytesOut: 0,
      connectionsMax: 0,
    });
    return;
  }
  trafficReportLogBuckets.set(key, bucket);
}

function shouldLogReport(key: string, intervalMs: number) {
  const now = Date.now();
  const last = reportLogTimes.get(key) || 0;
  if (now - last < intervalMs) return false;
  reportLogTimes.set(key, now);
  return true;
}

function logTcpingReportSummary(
  hostId: number,
  results: AgentTcpingResult[],
  tunnelResults: AgentTunnelTcpingResult[],
  forwardGroupResults: AgentForwardGroupLatencyResult[],
  serviceResults: AgentHostProbeServiceResult[],
) {
  if (!VERBOSE_AGENT_REPORTS) return;
  if (!shouldLogReport(`tcping:${hostId}`, tcpingReportLogIntervalMs)) return;
  const all = [...results, ...tunnelResults, ...forwardGroupResults, ...serviceResults] as Array<{ latencyMs?: unknown; isTimeout?: unknown }>;
  const timeouts = all.filter((item) => !!item.isTimeout).length;
  const latencies = all
    .map((item) => Number(item.latencyMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)}ms`
    : "-";
  console.info(`[Agent TCPing] host=${hostId} rules=${results.length} tunnels=${tunnelResults.length} groups=${forwardGroupResults.length} services=${serviceResults.length} timeouts=${timeouts}/${all.length} avg=${avgLatency}`);
}

function compactTrafficStats(value: unknown): AgentTrafficStat[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!Array.isArray(row)) return null;
      return {
        ruleId: Number(row[0]),
        bytesIn: Number(row[1]) || 0,
        bytesOut: Number(row[2]) || 0,
        connections: Number(row[3]) || 0,
      };
    })
    .filter((row): row is AgentTrafficStat => !!row && Number.isFinite(Number(row.ruleId)));
}

function compactHostTraffic(value: unknown): AgentHostTrafficStat | null {
  if (!Array.isArray(value)) return null;
  const bytesIn = Number(value[0]) || 0;
  const bytesOut = Number(value[1]) || 0;
  if (!Number.isFinite(bytesIn) && !Number.isFinite(bytesOut)) return null;
  return { bytesIn, bytesOut };
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
  let logHostId = 0;
  let logHostName = "";
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    logHostId = Number((host as any).id || 0);
    logHostName = String((host as any).name || "").trim();

    const objectStats = Array.isArray(req.body?.stats)
      ? req.body.stats.filter(isAgentTrafficStat)
      : [];
    const compactStats = compactTrafficStats(req.body?.s);
    const stats: AgentTrafficStat[] = objectStats.length > 0 ? objectStats : compactStats;
    const hostTraffic: AgentHostTrafficStat | null = isAgentHostTrafficStat(req.body?.hostTraffic)
      ? req.body.hostTraffic
      : compactHostTraffic(req.body?.h);
    if (!Array.isArray(req.body?.stats) && !Array.isArray(req.body?.s) && !hostTraffic) {
      res.status(400).json({ error: "stats array or hostTraffic is required" });
      return;
    }

    if (hostTraffic) {
      await db.recordHostTrafficSample(host.id, {
        bytesIn: Number(hostTraffic.bytesIn) || 0,
        bytesOut: Number(hostTraffic.bytesOut) || 0,
      });
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
          logTrafficReportSample(
            `tunnel:${host.id}:${tunnelId}:${rule.id}`,
            `[TunnelTraffic] host=${host.id} tunnel=${tunnelId} rule=${rule.id}`,
            bytesIn,
            bytesOut,
            stat.connections || 0,
          );
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
        logTrafficReportSample(
          `rule:${host.id}:${rule.id}`,
          `[Traffic] host=${host.id} rule=${rule.id}`,
          bytesIn,
          bytesOut,
          stat.connections || 0,
        );
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
          const quotaBytes = applyTrafficMultiplier(ruleBytes, await quotaTrafficMultiplierForRule(rule, tunnel));
          quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + quotaBytes);
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
    console.error(`[Agent Traffic] Error host=${logHostId || "-"} name=${logHostName || "-"}:`, error);
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
    const rawServiceResults = Array.isArray(req.body?.services)
      ? req.body.services
      : (Array.isArray(req.body?.serviceResults) ? req.body.serviceResults : []);
    const serviceResults: AgentHostProbeServiceResult[] = rawServiceResults.filter(isAgentHostProbeServiceResult);
    if (results.length === 0 && tunnelResults.length === 0 && forwardGroupResults.length === 0 && serviceResults.length === 0) {
      res.status(400).json({ error: "results, tunnels, forwardGroups or services array is required" });
      return;
    }
    logTcpingReportSummary(host.id, results, tunnelResults, forwardGroupResults, serviceResults);

    const tunnelBranchGroups = new Map<number, Array<{ key: string; label: string; latencyMs: number | null; isTimeout: boolean }>>();
    for (const r of tunnelResults) {
      const tunnelId = Number(r.tunnelId);
      if (!tunnelId) continue;
      const tunnel = await db.getTunnelById(tunnelId);
      if (!tunnel) continue;
      const latencyValue = typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null;
      const isTimeout = !!r.isTimeout || latencyValue === null;
      const seriesKey = cleanTunnelSeriesKey((r as any).seriesKey);
      if (seriesKey) {
        const label = cleanTunnelSeriesLabel((r as any).seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
        if (!tunnelBranchGroups.has(tunnelId)) tunnelBranchGroups.set(tunnelId, []);
        tunnelBranchGroups.get(tunnelId)!.push({ key: seriesKey, label, latencyMs: latencyValue, isTimeout });
        continue;
      }
      const hopIndex = Number((r as any).hopIndex);
      const hopCount = Number((r as any).hopCount);
      if (Number.isFinite(hopIndex) && Number.isFinite(hopCount) && hopCount > 0) {
        const aggregate = recordTunnelAutoHopLatency({
          tunnelId,
          hopIndex,
          hopCount,
          latencyMs: latencyValue,
          isTimeout,
        });
        if (!aggregate) continue;
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
          seriesKey: "total",
          seriesLabel: "总延迟",
        }, { preserveMessage: true });
        if (aggregate.success && !(tunnel as any).isRunning) {
          await db.updateTunnelRunningStatus(tunnelId, true);
        }
        continue;
      }
      if (tunnel.entryHostId !== host.id) continue;
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: latencyValue,
        isTimeout,
        seriesKey: "total",
        seriesLabel: "总延迟",
      }, { preserveMessage: true });
      if (!isTimeout && !(tunnel as any).isRunning) {
        await db.updateTunnelRunningStatus(tunnelId, true);
      }
    }

    for (const [tunnelId, branches] of tunnelBranchGroups.entries()) {
      const tunnel = await db.getTunnelById(tunnelId) as any;
      if (!tunnel || Number(tunnel.entryHostId) !== Number(host.id)) continue;
      const recordedAt = new Date();
      for (const branch of branches) {
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: branch.isTimeout ? null : branch.latencyMs,
          isTimeout: branch.isTimeout,
          seriesKey: branch.key,
          seriesLabel: branch.label,
          recordedAt,
        }, { preserveMessage: true, updateTunnel: false });
      }
      const failed = branches.length === 0 || branches.some((branch) => branch.isTimeout || !branch.latencyMs || branch.latencyMs <= 0);
      const maxLatency = failed ? null : Math.max(...branches.map((branch) => Number(branch.latencyMs || 0)));
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: maxLatency,
        isTimeout: failed,
        seriesKey: "total",
        seriesLabel: "最大延迟",
        recordedAt,
      }, { preserveMessage: true });
      if (!failed && !(tunnel as any).isRunning) {
        await db.updateTunnelRunningStatus(tunnelId, true);
      }
    }
    for (const r of forwardGroupResults) {
      const groupId = Number(r.groupId);
      if (!groupId) continue;
      if (String((r as any).probeType || "") === "china") {
        await db.updateForwardGroupMemberChinaHealth({
          groupId,
          memberId: Number((r as any).memberId || 0),
          hostId: Number(host.id),
          latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
          isTimeout: !!r.isTimeout,
        });
        continue;
      }
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

    const serviceStats = [];
    for (const r of serviceResults) {
      const serviceId = Number(r.serviceId);
      if (serviceId <= 0) continue;
      const service = await db.getHostProbeServiceById(serviceId) as any;
      if (!service || !service.isEnabled) continue;
      serviceStats.push({
        serviceId,
        hostId: host.id,
        latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
        isTimeout: !!r.isTimeout,
      });
    }
    if (serviceStats.length > 0) {
      await db.insertHostProbeServiceStats(serviceStats);
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

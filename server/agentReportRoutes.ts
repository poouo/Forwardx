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
import { getTunnelAutoHopAggregate, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { completeLookingGlassAgentTask, updateLookingGlassAgentTaskProgress, type LookingGlassMethod } from "./lookingGlassAgentTasks";
import { completeIperf3AgentTask } from "./iperf3AgentTasks";
import { completePluginAgentTask } from "./pluginAgentTasks";
import { getAgentHostFromRequest } from "./agentAuth";
import { applyTrafficMultiplier, normalizeTrafficMultiplier } from "../shared/trafficMultiplier";
import { mapWithConcurrency } from "./asyncPool";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { isTunnelRelayFailover, tunnelRelayCandidates } from "../shared/tunnelRelay";
import { isRuleLatencyReportMethodCompatible } from "../shared/latencyProbe";
import { completeSupportBundleHost } from "./supportBundle";

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
    if (group && ["port", "chain", "failover"].includes(String(group?.groupMode || "failover"))) {
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
  const stats: AgentTrafficStat[] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const ruleId = Number(row[0]);
    if (!Number.isFinite(ruleId)) continue;
    stats.push({
      ruleId,
      bytesIn: Number(row[1]) || 0,
      bytesOut: Number(row[2]) || 0,
      connections: Number(row[3]) || 0,
    });
  }
  return stats;
}

async function tunnelEntryHostIds(tunnel: any) {
  const ids = new Set<number>();
  const primary = Number(tunnel?.entryHostId || 0);
  if (primary > 0) ids.add(primary);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const group = await db.getForwardGroupById(entryGroupId) as any;
    if (group?.isEnabled && String(group.groupMode || "") === "entry") {
      for (const member of group.members || []) {
        const hostId = member?.isEnabled !== false && member?.memberType === "host" ? Number(member.hostId || 0) : 0;
        if (hostId > 0) ids.add(hostId);
      }
    }
  }
  return ids;
}

export async function validateTunnelProbeSource(
  hostId: number,
  tunnel: any,
  report: AgentTunnelTcpingResult,
  context?: { hops: any[]; exitNodes: any[]; entryHostIds?: Set<number>; topologyKey?: string },
) {
  if (!tunnel?.isEnabled) return false;
  const hops = context?.hops || await db.getTunnelHops(Number(tunnel.id)) as any[];
  const exitNodes = context?.exitNodes || await db.getTunnelExitNodes(Number(tunnel.id)) as any[];
  const topologyKey = String((report as any).topologyKey || "");
  const expectedTopologyKey = context?.topologyKey || tunnelProbeTopologyKey(tunnel, hops, exitNodes);
  if (topologyKey && topologyKey !== expectedTopologyKey) return false;
  const hopIndex = Number(report.hopIndex);
  const hopCount = Number(report.hopCount);
  if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
    if (isTunnelRelayFailover(tunnel, hops)) {
      const relayMatch = String(report.seriesKey || "").match(/^relay-(\d+)$/);
      const relayIndex = Number(relayMatch?.[1] || 0);
      const relays = tunnelRelayCandidates(hops) as any[];
      if (!relayMatch || relayIndex <= 0 || relayIndex > relays.length || hopCount !== 2 || hopIndex < 0 || hopIndex > 1) return false;
      const relay = relays[relayIndex - 1] as any;
      if (hopIndex === 0) {
        const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
        return entryHostIds.has(Number(hostId))
          && (!report.targetPort || Number(relay?.listenPort || 0) === Number(report.targetPort));
      }
      const finalExit = hops[hops.length - 1] as any;
      return Number(relay?.hostId || 0) === Number(hostId)
        && (!report.targetPort || Number(finalExit?.listenPort || 0) === Number(report.targetPort));
    }
    if (!Array.isArray(hops) || hops.length - 1 !== hopCount || hopIndex < 0 || hopIndex >= hopCount) return false;
    if (Number(hops[hopIndex]?.hostId || 0) !== Number(hostId)) return false;
    const expectedPort = Number(hops[hopIndex + 1]?.listenPort || 0);
    return !report.targetPort || expectedPort === Number(report.targetPort);
  }
  const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
  if (!entryHostIds.has(Number(hostId))) return false;
  const expectedPorts = new Set<number>([Number(tunnel.listenPort || 0)]);
  for (const node of exitNodes) {
    if (node?.isEnabled !== false && Number(node?.listenPort || 0) > 0) expectedPorts.add(Number(node.listenPort));
  }
  return !report.targetPort || expectedPorts.has(Number(report.targetPort));
}

function sameProbeTarget(left: unknown, right: unknown) {
  return String(left || "").trim().replace(/^\[|\]$/g, "").toLowerCase()
    === String(right || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

export function summarizeTunnelBranches(branches: Array<{ latencyMs: number | null; isTimeout: boolean }>) {
  const successful = branches.filter((branch) => !branch.isTimeout && Number(branch.latencyMs || 0) > 0);
  return {
    unavailable: successful.length === 0,
    partial: successful.length > 0 && successful.length < branches.length,
    latencyMs: successful.length > 0 ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
  };
}

function compactHostTraffic(value: unknown): AgentHostTrafficStat | null {
  if (!Array.isArray(value)) return null;
  const bytesIn = Number(value[0]) || 0;
  const bytesOut = Number(value[1]) || 0;
  if (!Number.isFinite(bytesIn) && !Number.isFinite(bytesOut)) return null;
  return { bytesIn, bytesOut };
}

export function registerAgentReportRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/support-bundle-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const taskId = String(req.body?.taskId || "").trim();
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }
    const accepted = completeSupportBundleHost(taskId, Number(host.id), {
      diagnostics: req.body?.diagnostics,
      error: req.body?.error,
    });
    res.json({ success: accepted });
  } catch (error) {
    console.error("[SupportBundle] Agent report failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

agentRouter.post("/api/agent/plugin-action-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const result = req.body?.result;
    if (!result?.taskId || !result?.groupId || !result?.pluginId || !result?.actionId) {
      res.status(400).json({ error: "plugin action result identifiers are required" });
      return;
    }
    let data = result.data;
    if (data !== undefined) {
      try {
        if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024) {
          res.status(400).json({ error: "plugin action result data is too large" });
          return;
        }
      } catch {
        res.status(400).json({ error: "plugin action result data is invalid" });
        return;
      }
    }
    const ok = completePluginAgentTask(host.id, {
      taskId: String(result.taskId),
      groupId: String(result.groupId),
      pluginId: String(result.pluginId),
      actionId: String(result.actionId),
      success: !!result.success,
      output: String(result.output || "").slice(0, 256 * 1024),
      stderr: String(result.stderr || "").slice(0, 256 * 1024),
      data,
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Math.max(0, Number(result.durationMs || 0)),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      finishedAt: result.finishedAt ? String(result.finishedAt) : undefined,
      error: result.error ? String(result.error).slice(0, 4000) : undefined,
      errorDetail: result.errorDetail ? String(result.errorDetail).slice(0, 4000) : undefined,
      advice: result.advice ? String(result.advice).slice(0, 4000) : undefined,
      processError: result.processError ? String(result.processError).slice(0, 4000) : undefined,
    });
    if (ok) await db.syncPluginAgentActionState(String(result.pluginId), String(result.groupId));
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Plugin Action] Error:", error);
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

    await db.withDatabaseTransaction(async () => {
    if (hostTraffic) {
      await db.recordHostTrafficSample(host.id, {
        bytesIn: Number(hostTraffic.bytesIn) || 0,
        bytesOut: Number(hostTraffic.bytesOut) || 0,
      });
    }

    const quotaTrafficByUser = new Map<number, number>();
    const trafficBillingEnabled = await db.isTrafficBillingEnabled();
    await mapWithConcurrency(stats, 16, async (stat) => {
      const bytesIn = Number(stat.bytesIn) || 0;
      const bytesOut = Number(stat.bytesOut) || 0;
      const rule = await db.getForwardRuleById(stat.ruleId);
      if (!rule) {
        return;
      }
      if ((rule as any).pendingDelete || !(rule as any).isEnabled) {
        return;
      }
      if (!await shouldAccountForwardRuleTraffic(rule)) {
        return;
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
        return;
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
        if (!(rule as any).isRunning) await db.updateRuleRunningStatus(Number(rule.id), true);
        logTrafficReportSample(
          `rule:${host.id}:${rule.id}`,
          `[Traffic] host=${host.id} rule=${rule.id}`,
          bytesIn,
          bytesOut,
          stat.connections || 0,
        );
        const billingResource = trafficBillingEnabled
          ? await db.findTrafficBillingResourceForRule(rule)
          : null;
        if (billingResource?.config) {
          await withKeyedTaskLock(`traffic-billing-user:${Number(rule.userId)}`, async () => {
            const user = await db.getUserById(Number(rule.userId));
            if (user && Number((user as any).balanceCents || 0) <= 0) {
              console.warn(`[TrafficBilling] user=${rule.userId} balance unavailable, disabling rules`);
              await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
              await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-unavailable");
              return;
            }
            const billed = await db.billTrafficUsage({
              userId: Number(rule.userId),
              ruleId: Number(rule.id),
              bytes: ruleBytes,
              resourceType: billingResource.resourceType,
              resourceId: billingResource.resourceId,
            });
            if (billed && billed.balanceAfterCents < 0) {
              console.warn(`[TrafficBilling] user=${rule.userId} balance negative, disabling rules`);
              await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
              await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-negative");
            }
          });
        } else {
          const quotaBytes = applyTrafficMultiplier(ruleBytes, await quotaTrafficMultiplierForRule(rule, tunnel));
          quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + quotaBytes);
        }
      }
    });

    // 累加用户已用流量
    await mapWithConcurrency(Array.from(quotaTrafficByUser.entries()), 8, async ([userId, totalBytes]) => {
      if (totalBytes <= 0) return;
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
    });
    });

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

    const tunnelResultsById = new Map<number, AgentTunnelTcpingResult[]>();
    for (const report of tunnelResults) {
      const tunnelId = Number(report.tunnelId || 0);
      if (tunnelId <= 0) continue;
      const rows = tunnelResultsById.get(tunnelId) || [];
      rows.push(report);
      tunnelResultsById.set(tunnelId, rows);
    }
    await mapWithConcurrency(Array.from(tunnelResultsById.entries()), 12, async ([tunnelId, reports]) => {
      const [tunnel, hops, exitNodes] = await Promise.all([
        db.getTunnelById(tunnelId),
        db.getTunnelHops(tunnelId),
        db.getTunnelExitNodes(tunnelId),
      ]) as [any, any[], any[]];
      if (!tunnel) return;
      const entryHostIds = await tunnelEntryHostIds(tunnel);
      const topologyKey = tunnelProbeTopologyKey(tunnel, hops, exitNodes);
      const relayFailover = isTunnelRelayFailover(tunnel, hops);
      const relayCandidateCount = relayFailover ? tunnelRelayCandidates(hops).length : 0;
      const branchByKey = new Map<string, { key: string; label: string; latencyMs: number | null; isTimeout: boolean }>();
      for (const report of reports) {
        if (!await validateTunnelProbeSource(Number(host.id), tunnel, report, { hops, exitNodes, entryHostIds, topologyKey })) continue;
        const latencyValue = typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null;
        const isTimeout = !!report.isTimeout || latencyValue === null;
        const seriesKey = cleanTunnelSeriesKey(report.seriesKey);
        if (relayFailover && seriesKey && /^relay-\d+$/.test(seriesKey)) {
          recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex: Number(report.hopIndex),
            hopCount: 2,
            latencyMs: latencyValue,
            isTimeout,
            generation: topologyKey,
            pathKey: seriesKey,
            allowEarlyFailure: true,
          });
          continue;
        }
        if (seriesKey) {
          const label = cleanTunnelSeriesLabel(report.seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
          branchByKey.set(seriesKey, { key: seriesKey, label, latencyMs: latencyValue, isTimeout });
          continue;
        }
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
          const aggregate = recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex,
            hopCount,
            latencyMs: latencyValue,
            isTimeout,
            generation: topologyKey,
          });
          if (!aggregate) continue;
          await db.insertTunnelLatencyStat({
            tunnelId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
            seriesKey: "total",
            seriesLabel: "总延迟",
          }, { preserveMessage: true });
          if (aggregate.success && !tunnel.isRunning) {
            await db.updateTunnelRunningStatus(tunnelId, true);
            tunnel.isRunning = true;
          }
          continue;
        }
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: latencyValue,
          isTimeout,
          seriesKey: "total",
          seriesLabel: "总延迟",
        }, { preserveMessage: true });
        if (!isTimeout && !tunnel.isRunning) {
          await db.updateTunnelRunningStatus(tunnelId, true);
          tunnel.isRunning = true;
        }
      }

      if (relayFailover) {
        const aggregates = Array.from({ length: relayCandidateCount }, (_, index) => {
          const key = `relay-${index + 1}`;
          return {
            key,
            label: `中转 ${index + 1}`,
            aggregate: getTunnelAutoHopAggregate(tunnelId, 2, topologyKey, key, true),
          };
        });
        if (aggregates.some((item) => item.aggregate !== null)) {
          for (const item of aggregates) {
            branchByKey.set(item.key, {
              key: item.key,
              label: item.label,
              latencyMs: item.aggregate?.success ? item.aggregate.latencyMs : null,
              isTimeout: !item.aggregate?.success,
            });
          }
        }
      }

      const branches = Array.from(branchByKey.values());
      if (branches.length === 0) return;
      const recordedAt = new Date();
      await mapWithConcurrency(branches, 4, async (branch) => {
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: branch.isTimeout ? null : branch.latencyMs,
          isTimeout: branch.isTimeout,
          seriesKey: branch.key,
          seriesLabel: branch.label,
          recordedAt,
        }, { preserveMessage: true, updateTunnel: false });
      });
      const summary = summarizeTunnelBranches(branches);
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: summary.latencyMs,
        isTimeout: summary.unavailable,
        seriesKey: "total",
        seriesLabel: summary.partial ? "可用出口最大延迟" : "最大延迟",
        recordedAt,
      }, { preserveMessage: true });
      if (!summary.unavailable && !tunnel.isRunning) await db.updateTunnelRunningStatus(tunnelId, true);
    });
    const chinaExpected = forwardGroupResults.some((report) => String(report.probeType || "") === "china")
      ? await db.getForwardGroupChinaHealthProbesForHost(Number(host.id)) as any[]
      : [];
    const chinaExpectedByKey = new Map(chinaExpected.map((probe: any) => [
      `${Number(probe.groupId)}:${Number(probe.memberId)}`,
      probe,
    ]));
    const forwardGroupResultsById = new Map<number, AgentForwardGroupLatencyResult[]>();
    for (const report of forwardGroupResults) {
      const groupId = Number(report.groupId || 0);
      if (groupId <= 0) continue;
      const rows = forwardGroupResultsById.get(groupId) || [];
      rows.push(report);
      forwardGroupResultsById.set(groupId, rows);
    }
    await mapWithConcurrency(Array.from(forwardGroupResultsById.entries()), 12, async ([groupId, reports]) => {
      const group = await db.getForwardGroupById(groupId) as any;
      if (!group?.isEnabled) return;
      const chainProbes = String(group.groupMode || "failover") === "chain"
        ? await db.getForwardGroupChainProbes(groupId)
        : [];
      const topologyKey = forwardGroupProbeTopologyKey(groupId, chainProbes);
      for (const report of reports) {
        if (String(report.probeType || "") === "china") {
          const expected = chinaExpectedByKey.get(`${groupId}:${Number(report.memberId || 0)}`) as any;
          if (!expected) continue;
          if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) continue;
          if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort)) continue;
          await db.updateForwardGroupMemberChinaHealth({
            groupId,
            memberId: Number(report.memberId || 0),
            hostId: Number(host.id),
            latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
            isTimeout: !!report.isTimeout,
          });
          continue;
        }
        if (String(group.groupMode || "failover") !== "chain") continue;
        if (report.topologyKey && report.topologyKey !== topologyKey) continue;
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        if (!Number.isInteger(hopIndex) || !Number.isInteger(hopCount) || hopCount <= 0) continue;
        const expected = (chainProbes as any[]).find((probe: any) => (
          Number(probe.fromHostId) === Number(host.id)
          && Number(probe.hopIndex) === hopIndex
          && Number(probe.hopCount) === hopCount
          && (!report.targetIp || sameProbeTarget(report.targetIp, probe.targetIp))
          && (!report.targetPort || Number(report.targetPort) === Number(probe.targetPort))
        ));
        if (!expected) continue;
        const aggregate = recordForwardGroupAutoHopLatency({
          groupId,
          hopIndex,
          hopCount,
          latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
          isTimeout: !!report.isTimeout,
          generation: topologyKey,
        });
        if (!aggregate) continue;
        await db.insertForwardGroupLatencyStat({
          groupId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
        });
      }
    });

    const expectedServices = serviceResults.length > 0 ? await db.getHostProbeTasksForHost(Number(host.id)) as any[] : [];
    const expectedServiceById = new Map(expectedServices.map((service: any) => [Number(service.serviceId), service]));
    const serviceStats = serviceResults.flatMap((report) => {
      const serviceId = Number(report.serviceId || 0);
      const expected = expectedServiceById.get(serviceId) as any;
      if (!expected) return [];
      if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) return [];
      if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort || 0)) return [];
      return [{
        serviceId,
        hostId: host.id,
        latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
        isTimeout: !!report.isTimeout,
      }];
    });
    if (serviceStats.length > 0) {
      await db.insertHostProbeServiceStats(serviceStats);
    }

    const stats: Array<{ ruleId: number; hostId: number; latencyMs: number | null; isTimeout: boolean }> = [];
    const tunnelLatencyById = new Map<number, number>();
    const tunnelContextById = new Map<number, Promise<{ tunnel: any; allowedHostIds: Set<number> } | null>>();
    const getTunnelContext = (tunnelId: number) => {
      let work = tunnelContextById.get(tunnelId);
      if (!work) {
        work = (async () => {
          const tunnel = await db.getTunnelById(tunnelId) as any;
          if (!tunnel) return null;
          const allowedHostIds = await tunnelEntryHostIds(tunnel);
          allowedHostIds.add(Number(tunnel.exitHostId || 0));
          for (const hop of await db.getTunnelHops(tunnelId) as any[]) allowedHostIds.add(Number(hop?.hostId || 0));
          for (const node of await db.getTunnelExitNodes(tunnelId) as any[]) {
            if (node?.isEnabled !== false) allowedHostIds.add(Number(node?.hostId || 0));
          }
          return { tunnel, allowedHostIds };
        })();
        tunnelContextById.set(tunnelId, work);
      }
      return work;
    };
    const ruleStats = await mapWithConcurrency(results, 16, async (report) => {
      const ruleId = Number(report.ruleId);
      if (ruleId <= 0) return null;
      const rule = await db.getForwardRuleById(ruleId) as any;
      if (!rule || rule.pendingDelete || !rule.isEnabled) return null;
      if (report.sourcePort && Number(report.sourcePort) !== Number(rule.sourcePort || 0)) return null;
      const tunnelId = Number(rule.tunnelId || 0);
      const tunnelContext = tunnelId > 0 ? await getTunnelContext(tunnelId) : null;
      const allowed = Number(rule.hostId || 0) === Number(host.id)
        || !!tunnelContext?.allowedHostIds.has(Number(host.id));
      if (!allowed) return null;
      if (!tunnelId && report.targetPort && Number(report.targetPort) !== Number(rule.targetPort || 0)) return null;
      if (!isRuleLatencyReportMethodCompatible(rule.protocol, report.method)) return null;
      const baseLatency = typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null;
      let latencyMs = baseLatency;
      if (!report.isTimeout && baseLatency && tunnelId > 0) {
        let tunnelLatency = tunnelLatencyById.get(tunnelId);
        if (tunnelLatency === undefined) {
          const latest = await db.getLatestTunnelLatency(tunnelId) as any;
          const latestAt = latest?.recordedAt ? new Date(latest.recordedAt).getTime() : 0;
          tunnelLatency = latest && Date.now() - latestAt <= 5 * 60 * 1000 && !latest.isTimeout && typeof latest.latencyMs === "number"
            ? Number(latest.latencyMs)
            : 0;
          tunnelLatencyById.set(tunnelId, tunnelLatency);
        }
        if (tunnelLatency > 0) latencyMs = baseLatency + tunnelLatency;
      }
      return {
        ruleId,
        hostId: host.id,
        latencyMs,
        isTimeout: !!report.isTimeout,
      };
    });
    stats.push(...ruleStats.filter((stat): stat is NonNullable<typeof stat> => !!stat));

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

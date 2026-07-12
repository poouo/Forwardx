import { Router, Request, Response } from "express";
import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh, requestHostTcping } from "./agentEvents";
import * as hopRepo from "./repositories/tunnelRepository";
import {
  getTunnelRuntimeHostStatus,
  getTunnelRuntimeReadyCount,
  recordTunnelRuntimeHostStatus,
} from "./tunnelRuntimeStatus";
import { getAgentHostFromRequest } from "./agentAuth";
import { notifyForwardRuleError } from "./forwardRuleErrorNotifier";
import { mapWithConcurrency } from "./asyncPool";
import { withKeyedTaskLock } from "./keyedTaskLock";

function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

const STATUS_IMPORTANT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_LOG_CACHE_MAX_SIZE = 5000;
const statusLogCache = new Map<string, { value: string; loggedAt: number }>();

function shouldLogStatus(key: string, value: string, important = false, minIntervalMs = STATUS_IMPORTANT_LOG_INTERVAL_MS) {
  const now = Date.now();
  if (statusLogCache.size > STATUS_LOG_CACHE_MAX_SIZE) {
    for (const [cacheKey, cached] of statusLogCache) {
      if (now - cached.loggedAt > minIntervalMs * 2) statusLogCache.delete(cacheKey);
    }
  }

  const cached = statusLogCache.get(key);
  if (cached == null || cached.value !== value) {
    statusLogCache.set(key, { value, loggedAt: now });
    return true;
  }
  if (important && now - cached.loggedAt >= minIntervalMs) {
    cached.loggedAt = now;
    return true;
  }
  return false;
}

function hostBlocksProtocol(host: any, protocol: string) {
  if (!host) return false;
  if (protocol === "http") return !!(host as any).blockHttp;
  if (protocol === "socks") return !!(host as any).blockSocks;
  if (protocol === "tls") return !!(host as any).blockTls;
  return false;
}

async function updateDirectTunnelRunningStatus(tunnel: any, isRunning: boolean) {
  const tunnelId = Number(tunnel.id);
  const exitHostId = Number(tunnel.exitHostId);
  if (tunnelId > 0 && exitHostId > 0) recordTunnelRuntimeHostStatus(tunnelId, exitHostId, !!isRunning);
  const nextRunning = !!isRunning;
  await db.updateTunnelRunningStatus(tunnelId, nextRunning);
  return nextRunning;
}

function requestTunnelTcpingRefresh(hostIds: number[], reason: string) {
  const uniqueHostIds = Array.from(new Set(hostIds
    .map((hostId) => Number(hostId))
    .filter((hostId) => Number.isFinite(hostId) && hostId > 0)));
  for (const hostId of uniqueHostIds) {
    requestHostTcping(hostId);
    pushAgentRefresh(hostId, reason);
  }
}

async function maybeMarkForwardXTunnelRunningFromRule(tunnel: any) {
  const tunnelId = Number(tunnel?.id || 0);
  if (!tunnelId || !isForwardXTunnel(tunnel)) return false;
  await db.updateTunnelRunningStatus(tunnelId, true);
  return true;
}

function getTunnelListenerPortsForHost(tunnel: any, hops: any[], extraExitNodes: any[], hostId: number) {
  const ports = new Set<number>();
  for (const hop of hops || []) {
    if (Number(hop?.hostId) !== Number(hostId)) continue;
    const port = Number(hop?.listenPort || 0);
    if (port > 0) ports.add(port);
  }
  for (const exitNode of extraExitNodes || []) {
    if (exitNode?.isEnabled === false || Number(exitNode?.hostId) !== Number(hostId)) continue;
    const port = Number(exitNode?.listenPort || 0);
    if (port > 0) ports.add(port);
  }
  if (Number(tunnel?.exitHostId) === Number(hostId)) {
    const port = Number(tunnel?.listenPort || 0);
    if (port > 0) ports.add(port);
  }
  return Array.from(ports).sort((a, b) => a - b);
}

function getTunnelExtraExitHostIdsFromNodes(rows: any[]) {
  return (rows || [])
    .filter((row: any) => row?.isEnabled !== false)
    .map((row: any) => Number(row.hostId || 0))
    .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
}

async function getTunnelExtraExitHostIds(tunnelId: number) {
  return getTunnelExtraExitHostIdsFromNodes(await hopRepo.getTunnelExitNodes(Number(tunnelId)));
}

async function getTunnelEntryHostIds(tunnel: any) {
  const hostIds = new Set<number>();
  const primaryEntryHostId = Number(tunnel?.entryHostId || 0);
  if (Number.isFinite(primaryEntryHostId) && primaryEntryHostId > 0) hostIds.add(primaryEntryHostId);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
    if (entryGroup && entryGroup.isEnabled && String(entryGroup.groupMode || "") === "entry") {
      for (const member of entryGroup.members || []) {
        if (!member || member.isEnabled === false || member.memberType !== "host") continue;
        const memberHostId = Number(member.hostId || 0);
        if (Number.isFinite(memberHostId) && memberHostId > 0) hostIds.add(memberHostId);
      }
    }
  }
  return Array.from(hostIds);
}

const AGENT_STATUS_BATCH_MAX_SIZE = 200;

type AgentStatusApplyResult = {
  status: number;
  body: Record<string, any>;
};

function agentStatusTaskKey(hostIdValue: unknown, payload: Record<string, any>) {
  const hostId = Number(hostIdValue || 0);
  const statusType = String(payload.statusType || (Number(payload.ruleId) > 0 ? "rule" : "tunnel"));
  const resourceId = statusType === "runtime"
    ? String(payload.forwardType || "runtime")
    : statusType === "tunnel"
      ? Number(payload.tunnelId || 0)
      : Number(payload.ruleId || 0);
  return `agent-status:${hostId}:${statusType}:${resourceId}`;
}

async function applyAgentRuleStatus(host: any, payload: any): Promise<AgentStatusApplyResult> {
  const { ruleId, tunnelId, statusType, isRunning } = payload || {};
  const rawMessage = typeof payload?.message === "string" ? payload.message.trim() : "";
  const message = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}...` : rawMessage;
  const hostLogText = `host=${host.id} name=${String(host.name || "-")}`;
  if (statusType === "runtime") {
    const runtimeType = String(payload?.forwardType || "runtime").trim() || "runtime";
    if (shouldLogStatus(`runtime:${runtimeType}:${host.id}`, `running=${!!isRunning}:message=${message}`, !isRunning || !!message)) {
      appendPanelLog(
        !!isRunning ? "info" : "warn",
        `[Runtime] status type=${runtimeType} ${hostLogText} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
      );
    }
    if (runtimeType.startsWith("plugin-") && runtimeType.endsWith("-sync")) {
      pushAgentRefresh(Number(host.id), `${runtimeType}-${isRunning ? "complete" : "failed"}`, { urgent: true });
    }
    return { status: 200, body: { success: true } };
  }
  if (statusType === "tunnel") {
    if (typeof tunnelId !== "number") {
      return { status: 400, body: { error: "tunnelId is required" } };
    }
    const tunnel = await db.getTunnelById(tunnelId);
    const hops = tunnel ? await hopRepo.getTunnelHops(Number(tunnel.id)) : [];
    const extraExitNodes = tunnel ? await hopRepo.getTunnelExitNodes(Number(tunnel.id)) : [];
    const extraExitHostIds = getTunnelExtraExitHostIdsFromNodes(extraExitNodes || []);
    const isTunnelHop = Array.isArray(hops)
      && hops.some((hop: any) => Number(hop.hostId) === Number(host.id));
    const isExtraExit = extraExitHostIds.includes(Number(host.id));
    const tunnelEntryHostIds = tunnel ? await getTunnelEntryHostIds(tunnel) : [];
    const isEntryHost = tunnelEntryHostIds.includes(Number(host.id));
    if (!tunnel || (!isEntryHost && Number(tunnel.exitHostId) !== Number(host.id) && !isTunnelHop && !isExtraExit)) {
      return { status: 404, body: { error: "tunnel not found" } };
    }
    const reportedPort = Number(payload?.sourcePort || 0);
    const expectedPorts = getTunnelListenerPortsForHost(tunnel, hops || [], extraExitNodes || [], Number(host.id));
    if (reportedPort > 0 && expectedPorts.length > 0 && !expectedPorts.includes(reportedPort)) {
      const expectedText = expectedPorts.join(",");
      if (shouldLogStatus(`tunnel:${tunnelId}:stale-port:${host.id}`, `reported=${reportedPort}:expected=${expectedText}`)) {
        appendPanelLog(
          "info",
          `[Tunnel] status ignored stale listener tunnel=${tunnelId} name=${String((tunnel as any)?.name || "-")} ${hostLogText} reportedPort=${reportedPort} expectedPorts=${expectedText}`,
        );
      }
      return { status: 200, body: { success: true, ignored: true, stale: true } };
    }
    const hopHostIds = Array.isArray(hops)
      ? hops.map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
      : [];
    if (isExtraExit) {
      recordTunnelRuntimeHostStatus(tunnelId, host.id, !!isRunning);
      if (shouldLogStatus(`tunnel:${tunnelId}:extra:${host.id}`, `running=${!!isRunning}`, !isRunning || !!message)) {
        appendPanelLog(
          !!isRunning ? "info" : "warn",
          `[Tunnel] status tunnel=${tunnelId} name=${String((tunnel as any)?.name || "-")} extraExit=${hostLogText} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
        );
      }
      return { status: 200, body: { success: true } };
    }
    if (hopHostIds.length >= 3) {
      recordTunnelRuntimeHostStatus(tunnelId, host.id, !!isRunning);
      const readyCount = getTunnelRuntimeReadyCount(tunnelId, hopHostIds);
      const nextRunning = !!isRunning && readyCount >= hopHostIds.length;
      await db.updateTunnelRunningStatus(tunnelId, nextRunning);
      if (isRunning) {
        requestTunnelTcpingRefresh(hopHostIds.slice(0, -1), nextRunning ? "tunnel-tcping-refresh" : "tunnel-runtime-probe-refresh");
      }
      if (!nextRunning && isRunning) {
        for (const hostId of hopHostIds) {
          if (Number(hostId) !== Number(host.id) && getTunnelRuntimeHostStatus(tunnelId, hostId) !== true) {
            pushAgentRefresh(hostId, "tunnel-runtime-sync");
          }
        }
      }
      if (shouldLogStatus(`tunnel:${tunnelId}:host:${host.id}`, `running=${!!isRunning}:ready=${readyCount}/${hopHostIds.length}`, !isRunning || !!message)) {
        appendPanelLog(
          !!isRunning ? "info" : "warn",
          `[Tunnel] status tunnel=${tunnelId} name=${String((tunnel as any)?.name || "-")} ${hostLogText} running=${!!isRunning} ready=${readyCount}/${hopHostIds.length}${message ? ` message=${message}` : ""}`,
        );
      }
      return { status: 200, body: { success: true } };
    }
    if (isForwardXTunnel(tunnel) && Number(tunnel.exitHostId) !== Number(host.id) && !isExtraExit) {
      if (shouldLogStatus(`tunnel:${tunnelId}:ignored:${host.id}`, `running=${!!isRunning}`, !!message)) {
        appendPanelLog("info", `[Tunnel] status ignored non-exit ForwardX tunnel=${tunnelId} name=${String((tunnel as any)?.name || "-")} ${hostLogText} running=${!!isRunning}${message ? ` message=${message}` : ""}`);
      }
      return { status: 200, body: { success: true, ignored: true } };
    }
    const nextRunning = await updateDirectTunnelRunningStatus(tunnel, !!isRunning);
    if (nextRunning) {
      requestTunnelTcpingRefresh(tunnelEntryHostIds, "tunnel-tcping-refresh");
    }
    if (shouldLogStatus(`tunnel:${tunnelId}:direct:${host.id}`, `running=${!!isRunning}:effective=${nextRunning}`, !nextRunning || !!message)) {
      appendPanelLog(
        nextRunning ? "info" : "warn",
        `[Tunnel] status tunnel=${tunnelId} name=${String((tunnel as any)?.name || "-")} ${hostLogText} running=${!!isRunning} effective=${nextRunning}${message ? ` message=${message}` : ""}`,
      );
    }
    return { status: 200, body: { success: true } };
  }
  if (typeof ruleId !== "number") {
    return { status: 400, body: { error: "ruleId is required" } };
  }

  const rule = await db.getForwardRuleById(ruleId);
  if (!rule) {
    return { status: 404, body: { error: "rule not found" } };
  }
  let ruleTunnel: any = null;
  let ruleTunnelEntryHostIds: number[] = [];
  let allowed = Number((rule as any).hostId) === Number(host.id);
  if ((rule as any).tunnelId) {
    ruleTunnel = await db.getTunnelById(Number((rule as any).tunnelId));
    if (ruleTunnel) {
      ruleTunnelEntryHostIds = await getTunnelEntryHostIds(ruleTunnel);
      const extraExitHostIds = await getTunnelExtraExitHostIds(Number(ruleTunnel.id));
      allowed = allowed
        || ruleTunnelEntryHostIds.includes(Number(host.id))
        || Number((ruleTunnel as any).exitHostId) === Number(host.id)
        || extraExitHostIds.includes(Number(host.id));
    }
  }
  if (!allowed) {
    return { status: 403, body: { error: "forbidden" } };
  }

  const currentRuleTunnelId = Number((rule as any).tunnelId || 0);
  const reportedRuleTunnelId = Number(tunnelId || 0);
  if (currentRuleTunnelId !== reportedRuleTunnelId && (currentRuleTunnelId > 0 || reportedRuleTunnelId > 0)) {
    if (shouldLogStatus(`rule:${ruleId}:stale-tunnel:${host.id}`, `reported=${reportedRuleTunnelId}:current=${currentRuleTunnelId}`, true)) {
      appendPanelLog(
        "info",
        `[Rule] status ignored stale tunnel rule=${ruleId} name=${String((rule as any).name || "-")} reportedTunnel=${reportedRuleTunnelId || "-"} currentTunnel=${currentRuleTunnelId || "-"} ${hostLogText} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
      );
    }
    return { status: 200, body: { success: true, ignored: true } };
  }

  const reportedRulePort = Number(payload?.sourcePort || 0);
  const currentRulePort = Number((rule as any).sourcePort || 0);
  if (reportedRulePort > 0 && currentRulePort > 0 && reportedRulePort !== currentRulePort) {
    if (shouldLogStatus(`rule:${ruleId}:stale-port:${host.id}`, `reported=${reportedRulePort}:current=${currentRulePort}`)) {
      appendPanelLog(
        "info",
        `[Rule] status ignored stale listener rule=${ruleId} name=${String((rule as any).name || "-")} ${hostLogText} reportedPort=${reportedRulePort} currentPort=${currentRulePort}`,
      );
    }
    return { status: 200, body: { success: true, ignored: true, stale: true } };
  }

  const wasRunning = !!(rule as any).isRunning;
  await db.updateRuleRunningStatus(ruleId, !!isRunning);
  if (
    (wasRunning || !!message)
    && !isRunning
    && !!(rule as any).isEnabled
    && !(rule as any).pendingDelete
    && !!(rule as any).telegramErrorNotifyEnabled
  ) {
    void notifyForwardRuleError({ rule, host, message }).catch((error) => {
      console.warn(`[Telegram] Forward rule error notify failed rule=${ruleId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (ruleTunnel && ruleTunnelEntryHostIds.includes(Number(host.id))) {
    recordTunnelRuntimeHostStatus(Number(ruleTunnel.id), Number(host.id), !!isRunning);
  }
  if (
    !!isRunning
    && ruleTunnel
    && isForwardXTunnel(ruleTunnel)
    && Number((rule as any).tunnelId) > 0
  ) {
    const hops = await hopRepo.getTunnelHops(Number(ruleTunnel.id));
    if (!Array.isArray(hops) || hops.length < 3) {
      await maybeMarkForwardXTunnelRunningFromRule(ruleTunnel);
    }
  }
  if (shouldLogStatus(`rule:${ruleId}:host:${host.id}`, `running=${!!isRunning}`, !isRunning || !!message)) {
    appendPanelLog(
      !!isRunning ? "info" : "warn",
      `[Rule] status rule=${ruleId} name=${String((rule as any).name || "-")} tunnel=${Number((rule as any).tunnelId || tunnelId || 0) || "-"} ${hostLogText} port=${Number((rule as any).sourcePort || 0) || "-"} type=${(rule as any).forwardType || "-"} proto=${(rule as any).protocol || "-"} target=${String((rule as any).targetIp || "-")}:${Number((rule as any).targetPort || 0) || "-"} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
    );
  }
  return { status: 200, body: { success: true } };
}

export function registerAgentStatusRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/protocol-block", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const ruleId = Number(req.body?.ruleId);
    const tunnelId = Number(req.body?.tunnelId || 0);
    const protocol = String(req.body?.protocol || "").toLowerCase();
    const sourcePort = Number(req.body?.sourcePort || 0);
    if (!ruleId || !["http", "socks", "tls"].includes(protocol)) {
      res.status(400).json({ error: "ruleId and protocol are required" });
      return;
    }

    const rule = await db.getForwardRuleById(ruleId);
    if (!rule) {
      appendPanelLog("info", `[ProtocolBlock] ignored missing rule=${ruleId} tunnel=${Number(tunnelId || 0) || "-"} host=${host.id} protocol=${protocol}`);
      res.json({ success: true, ignored: true });
      return;
    }
    const tunnel = tunnelId ? await db.getTunnelById(tunnelId) : ((rule as any).tunnelId ? await db.getTunnelById((rule as any).tunnelId) : null);
    const tunnelEntryHostIds = tunnel ? await getTunnelEntryHostIds(tunnel) : [];
    const isTunnelEntryHost = tunnelEntryHostIds.includes(Number(host.id));
    const entryHostId = tunnel
      ? (isTunnelEntryHost ? Number(host.id) : Number((tunnel as any).entryHostId))
      : Number((rule as any).hostId);
    const entryHost = entryHostId === Number(host.id) ? host : await db.getHostById(entryHostId);
    const policyAllowsBlock = hostBlocksProtocol(entryHost, protocol);
    const isTunnelRule = !!tunnel
      && Number((rule as any).tunnelId) === Number((tunnel as any).id)
      && (isTunnelEntryHost || Number((tunnel as any).exitHostId) === Number(host.id))
      && policyAllowsBlock;
    const isDirectRule = !tunnel
      && Number((rule as any).hostId) === Number(host.id)
      && policyAllowsBlock;
    const allowed = isTunnelRule || isDirectRule;
    if (!allowed) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const label = protocol.toUpperCase();
    const reason = `检测到该端口使用 ${label} 协议，管理员已禁止在此入口主机使用，请勿使用此协议`;
    await db.disableForwardRuleByProtocolBlock(ruleId, reason);
    if (tunnel) {
      await db.updateTunnel((tunnel as any).id, { isRunning: false } as any);
      for (const entryHostId of tunnelEntryHostIds) pushAgentRefresh(Number(entryHostId), "protocol-block-entry");
      pushAgentRefresh(Number((tunnel as any).exitHostId), "protocol-block-exit");
    } else {
      pushAgentRefresh(Number((rule as any).hostId), "protocol-block-rule");
    }
    appendPanelLog("warn", `[ProtocolBlock] rule=${ruleId} tunnel=${tunnel ? (tunnel as any).id : "-"} host=${host.id} port=${sourcePort || (rule as any).sourcePort} protocol=${protocol}`);
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Protocol Block] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/rule-status-batch", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses : [];
    if (statuses.length === 0 || statuses.length > AGENT_STATUS_BATCH_MAX_SIZE) {
      res.status(400).json({ error: `statuses must contain 1-${AGENT_STATUS_BATCH_MAX_SIZE} items` });
      return;
    }
    const outcomes = await mapWithConcurrency(statuses, 16, async (payload, index) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { index, result: { status: 400, body: { error: "invalid status payload" } } as AgentStatusApplyResult };
      }
      const statusPayload = payload as Record<string, any>;
      const result = await withKeyedTaskLock(
        agentStatusTaskKey(host.id, statusPayload),
        () => applyAgentRuleStatus(host, statusPayload),
      );
      return { index, result };
    });
    let accepted = 0;
    let ignored = 0;
    const rejected: Array<{ index: number; status: number; error: string }> = [];
    for (const { index, result } of outcomes) {
      if (result.status >= 400) {
        rejected.push({ index, status: result.status, error: String(result.body?.error || "status rejected") });
        continue;
      }
      accepted += 1;
      if (result.body?.ignored) ignored += 1;
    }
    res.json({ success: true, accepted, ignored, rejected });
  } catch (error) {
    console.error("[Agent Rule Status Batch] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/rule-status", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const statusPayload = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, any>
      : {};
    const result = await withKeyedTaskLock(
      agentStatusTaskKey(host.id, statusPayload),
      () => applyAgentRuleStatus(host, statusPayload),
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果

}

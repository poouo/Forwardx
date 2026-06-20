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

function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
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

async function getTunnelExtraExitHostIds(tunnelId: number) {
  const rows = await hopRepo.getTunnelExitNodes(Number(tunnelId));
  return (rows || [])
    .map((row: any) => Number(row.hostId))
    .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
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
    const entryHostId = tunnel ? Number((tunnel as any).entryHostId) : Number((rule as any).hostId);
    const entryHost = entryHostId === Number(host.id) ? host : await db.getHostById(entryHostId);
    const policyAllowsBlock = hostBlocksProtocol(entryHost, protocol);
    const isTunnelRule = !!tunnel
      && Number((rule as any).tunnelId) === Number((tunnel as any).id)
      && (Number((tunnel as any).entryHostId) === Number(host.id) || Number((tunnel as any).exitHostId) === Number(host.id))
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
      pushAgentRefresh(Number((tunnel as any).entryHostId), "protocol-block-entry");
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

agentRouter.post("/api/agent/rule-status", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { ruleId, tunnelId, statusType, isRunning } = req.body;
    const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const message = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}...` : rawMessage;
    if (statusType === "tunnel") {
      if (typeof tunnelId !== "number") {
        res.status(400).json({ error: "tunnelId is required" });
        return;
      }
      const tunnel = await db.getTunnelById(tunnelId);
      const hops = tunnel ? await hopRepo.getTunnelHops(Number(tunnel.id)) : [];
      const extraExitHostIds = tunnel ? await getTunnelExtraExitHostIds(Number(tunnel.id)) : [];
      const isTunnelHop = Array.isArray(hops)
        && hops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      const isExtraExit = extraExitHostIds.includes(Number(host.id));
      if (!tunnel || (Number(tunnel.entryHostId) !== Number(host.id) && Number(tunnel.exitHostId) !== Number(host.id) && !isTunnelHop && !isExtraExit)) {
        res.status(404).json({ error: "tunnel not found" });
        return;
      }
      const hopHostIds = Array.isArray(hops)
        ? hops.map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0)
        : [];
      if (isForwardXTunnel(tunnel) && isExtraExit) {
        recordTunnelRuntimeHostStatus(tunnelId, host.id, !!isRunning);
        appendPanelLog(
          !!isRunning ? "info" : "warn",
          `[Tunnel] status tunnel=${tunnelId} extraExit=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
        );
        res.json({ success: true });
        return;
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
        appendPanelLog(
          !!isRunning ? "info" : "warn",
          `[Tunnel] status tunnel=${tunnelId} host=${host.id} running=${!!isRunning} ready=${readyCount}/${hopHostIds.length}${message ? ` message=${message}` : ""}`,
        );
        res.json({ success: true });
        return;
      }
      if (isForwardXTunnel(tunnel) && Number(tunnel.exitHostId) !== Number(host.id) && !isExtraExit) {
        appendPanelLog("info", `[Tunnel] status ignored non-exit ForwardX tunnel=${tunnelId} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`);
        res.json({ success: true, ignored: true });
        return;
      }
      const nextRunning = await updateDirectTunnelRunningStatus(tunnel, !!isRunning);
      if (nextRunning) {
        requestTunnelTcpingRefresh([Number((tunnel as any).entryHostId)], "tunnel-tcping-refresh");
      }
      appendPanelLog(
        nextRunning ? "info" : "warn",
        `[Tunnel] status tunnel=${tunnelId} host=${host.id} running=${!!isRunning} effective=${nextRunning}${message ? ` message=${message}` : ""}`,
      );
      res.json({ success: true });
      return;
    }
    if (typeof ruleId !== "number") {
      res.status(400).json({ error: "ruleId is required" });
      return;
    }

    const rule = await db.getForwardRuleById(ruleId);
    if (!rule) {
      res.status(404).json({ error: "rule not found" });
      return;
    }
    let ruleTunnel: any = null;
    let allowed = Number((rule as any).hostId) === Number(host.id);
    if (!allowed && (rule as any).tunnelId) {
      ruleTunnel = await db.getTunnelById(Number((rule as any).tunnelId));
      const extraExitHostIds = ruleTunnel ? await getTunnelExtraExitHostIds(Number(ruleTunnel.id)) : [];
      allowed = !!ruleTunnel && (
        Number((ruleTunnel as any).entryHostId) === Number(host.id)
        || Number((ruleTunnel as any).exitHostId) === Number(host.id)
        || extraExitHostIds.includes(Number(host.id))
      );
    } else if ((rule as any).tunnelId) {
      ruleTunnel = await db.getTunnelById(Number((rule as any).tunnelId));
    }
    if (!allowed) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    await db.updateRuleRunningStatus(ruleId, !!isRunning);
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
    appendPanelLog(
      !!isRunning ? "info" : "warn",
      `[Rule] status rule=${ruleId} tunnel=${Number((rule as any).tunnelId || tunnelId || 0) || "-"} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果

}

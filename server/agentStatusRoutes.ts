import { Router, Request, Response } from "express";
import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh } from "./agentEvents";
import * as hopRepo from "./repositories/tunnelRepository";

export function registerAgentStatusRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/protocol-block", async (req: Request, res: Response) => {
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
      res.status(404).json({ error: "rule not found" });
      return;
    }
    const tunnel = tunnelId ? await db.getTunnelById(tunnelId) : ((rule as any).tunnelId ? await db.getTunnelById((rule as any).tunnelId) : null);
    const allowed = !!tunnel
      && Number((rule as any).tunnelId) === Number((tunnel as any).id)
      && (Number((tunnel as any).entryHostId) === Number(host.id) || Number((tunnel as any).exitHostId) === Number(host.id));
    if (!allowed) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const label = protocol.toUpperCase();
    const reason = `检测到该端口使用 ${label} 协议，管理员已禁止在此隧道使用，请勿使用此协议`;
    await db.disableForwardRuleByProtocolBlock(ruleId, reason);
    await db.updateTunnel((tunnel as any).id, { isRunning: false } as any);
    pushAgentRefresh(Number((tunnel as any).entryHostId), "protocol-block-entry");
    pushAgentRefresh(Number((tunnel as any).exitHostId), "protocol-block-exit");
    appendPanelLog("warn", `[ProtocolBlock] rule=${ruleId} tunnel=${(tunnel as any).id} host=${host.id} port=${sourcePort || (rule as any).sourcePort} protocol=${protocol}`);
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Protocol Block] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/rule-status", async (req: Request, res: Response) => {
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
      const isTunnelHop = Array.isArray(hops)
        && hops.some((hop: any) => Number(hop.hostId) === Number(host.id));
      if (!tunnel || (tunnel.entryHostId !== host.id && tunnel.exitHostId !== host.id && !isTunnelHop)) {
        res.status(404).json({ error: "tunnel not found" });
        return;
      }
      await db.updateTunnelRunningStatus(tunnelId, !!isRunning);
      appendPanelLog(
        !!isRunning ? "info" : "warn",
        `[Tunnel] status tunnel=${tunnelId} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
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
    let allowed = Number((rule as any).hostId) === Number(host.id);
    if (!allowed && (rule as any).tunnelId) {
      const tunnel = await db.getTunnelById(Number((rule as any).tunnelId));
      allowed = !!tunnel && (
        Number((tunnel as any).entryHostId) === Number(host.id)
        || Number((tunnel as any).exitHostId) === Number(host.id)
      );
    }
    if (!allowed) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    await db.updateRuleRunningStatus(ruleId, !!isRunning);
    appendPanelLog(
      !!isRunning ? "info" : "warn",
      `[Rule] status rule=${ruleId} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果

}

import { Router, Request, Response } from "express";
import * as db from "./db";
import { AGENT_VERSION } from "./_core/systemRouter";
import { appendPanelLog } from "./_core/panelLogger";
import { generateInstallScript } from "./agentInstallScripts";
import { registerAgentEventClient, unregisterAgentEventClient } from "./agentEvents";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { resolvePanelUrl } from "./agentPanelUrl";
import { registerAgentStatusRoutes } from "./agentStatusRoutes";
import { registerAgentSelfTestRoutes } from "./agentSelfTestRoutes";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { registerAgentHeartbeatRoute } from "./agentHeartbeatRoute";

const agentRouter = Router();
const AGENT_RUNTIME_RECOVERY_COOLDOWN_MS = 60 * 1000;
const lastRuntimeRecoveryByHost = new Map<number, number>();

async function resetAgentRuntimeStateAfterReconnect(hostId: number, reason: string) {
  const now = Date.now();
  const last = lastRuntimeRecoveryByHost.get(hostId) || 0;
  if (now - last < AGENT_RUNTIME_RECOVERY_COOLDOWN_MS) return;
  lastRuntimeRecoveryByHost.set(hostId, now);
  await db.resetAgentRuntimeStateForHost(hostId);
  appendPanelLog("info", `[AgentRecovery] host=${hostId} reason=${reason} runtime state marked for reapply`);
}

// 为所有 /api/agent/* POST 接口启用加密中间件（GET install.sh 等不需要）
agentRouter.use("/api/agent", (req, res, next) => {
  if (req.method !== "POST") return next();
  return agentEncryptionMiddleware(req, res, next);
});

agentRouter.get("/api/agent/events", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      const migratedTo = await db.getSetting("migratedToPanelUrl");
      if (migratedTo) {
        res.status(410).json({ error: "Panel migrated", panelUrl: migratedTo });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const agentVersion = req.header("X-Agent-Version");
    if (agentVersion) {
      await db.updateHostHeartbeat(host.id, { agentVersion } as any);
      const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
      const agentUpgradeCompleted = (host as any).agentUpgradeRequested
        && isAgentVersionAtLeast(agentVersion, requestedTargetVersion);
      if (agentUpgradeCompleted) {
        await db.clearHostAgentUpgradeRequest(host.id);
      }
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    registerAgentEventClient(host.id, token, res);
    console.info(`[AgentEvent] host=${host.id} connected${agentVersion ? ` version=${agentVersion}` : ""}`);
    res.write(`event: ready\n`);
    res.write(`data: {"success":true}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`event: ping\n`);
      res.write(`data: {}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unregisterAgentEventClient(host.id, res);
      console.info(`[AgentEvent] host=${host.id} disconnected`);
    });
  } catch (error) {
    console.error("[Agent Events] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 注册接口
agentRouter.post("/api/agent/register", async (req: Request, res: Response) => {
  try {
    const { token, ip, ipv4, ipv6, osInfo, cpuInfo, memoryTotal, agentVersion } = req.body;
    if (!token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    // 验证 token
    const agentToken = await db.getAgentTokenByToken(token);
    if (!agentToken) {
      const migratedTo = await db.getSetting("migratedToPanelUrl");
      if (migratedTo) {
        res.status(410).json({ error: "Panel migrated", panelUrl: migratedTo });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    // 检查是否已有主机使用此 token
    const existingHost = await db.getHostByAgentToken(token);
    if (existingHost) {
      await db.updateHost(existingHost.id, {
        ip: ipv4 || ip || existingHost.ip,
        ipv4: ipv4 || (existingHost as any).ipv4 || null,
        ipv6: ipv6 || (existingHost as any).ipv6 || null,
        osInfo: osInfo || existingHost.osInfo,
        cpuInfo: cpuInfo || existingHost.cpuInfo,
        memoryTotal: memoryTotal || existingHost.memoryTotal,
        agentVersion: agentVersion || (existingHost as any).agentVersion,
        isOnline: true,
        lastHeartbeat: new Date(),
      });
      await resetAgentRuntimeStateAfterReconnect(existingHost.id, "agent-registered");
      res.json({ success: true, hostId: existingHost.id, message: "Host updated" });
      return;
    }

    const tokenDescription = String(agentToken.description || "").trim();

    // 创建新主机
    const hostId = await db.createHost({
      name: tokenDescription || `Agent-${token.substring(0, 8)}`,
      ip: ipv4 || ip || "unknown",
      ipv4: ipv4 || null,
      ipv6: ipv6 || null,
      hostType: "slave",
      agentToken: token,
      osInfo: osInfo || null,
      cpuInfo: cpuInfo || null,
      memoryTotal: memoryTotal || null,
      agentVersion: agentVersion || null,
      isOnline: true,
      lastHeartbeat: new Date(),
      userId: agentToken.userId,
    });

    await db.markAgentTokenUsed(token, hostId);
    await resetAgentRuntimeStateAfterReconnect(hostId, "agent-registered");
    res.json({ success: true, hostId, message: "Host registered" });
  } catch (error) {
    console.error("[Agent Register] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 心跳接口
registerAgentHeartbeatRoute(agentRouter);
registerAgentStatusRoutes(agentRouter);
registerAgentSelfTestRoutes(agentRouter);
registerAgentReportRoutes(agentRouter);

agentRouter.get("/api/agent/install.sh", async (req: Request, res: Response) => {
  const panelUrl = await resolvePanelUrl(req);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateInstallScript(panelUrl));
});

export { agentRouter };

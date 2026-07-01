import { Router, Request, Response, NextFunction } from "express";
import * as db from "./db";
import { AGENT_VERSION } from "./_core/systemRouter";
import { AGENT_ASSET_NAME_SET, getOrFetchAgentAssetPath } from "./agentAssets";
import { appendPanelLog } from "./_core/panelLogger";
import { generateInstallScript } from "./agentInstallScripts";
import { registerAgentEventClient, unregisterAgentEventClient } from "./agentEvents";
import { agentEncryptionMiddleware, getAgentTunneledPath } from "./agentEncryptionMiddleware";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { resolvePanelUrl } from "./agentPanelUrl";
import { decryptPayloadWithCandidates, encryptPayload, isEncryptedEnvelope, rememberEncryptedEnvelope } from "./agentCrypto";
import { resolveAgentTokenFromAuthorization } from "./agentAuth";
import { normalizeAgentAddress, normalizeAgentText } from "./agentInputValidation";
import { registerAgentStatusRoutes } from "./agentStatusRoutes";
import { registerAgentSelfTestRoutes } from "./agentSelfTestRoutes";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { registerAgentHeartbeatRoute } from "./agentHeartbeatRoute";
import { hostUsesAutomaticIngress, refreshAgentsAffectedByHostAddress, refreshHostAddressRuntime } from "./hostAddressRuntime";
import { isHostStatusOnline, notifyHostOnlineIfNeeded } from "./hostStatusNotifier";
import { clearTunnelRuntimeStatusForHost } from "./tunnelRuntimeStatus";

const agentRouter = Router();
const agentApiRouter = Router();
const VERBOSE_AGENT_EVENTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_EVENTS || ""));
const AGENT_RUNTIME_RECOVERY_COOLDOWN_MS = 60 * 1000;
const AGENT_FIREWALL_COUNTER_REFRESH_VERSION = "2.2.108";
const AGENT_PROTOCOL_GUARD_BACKEND_VERSION = "2.2.127";
const lastRuntimeRecoveryByHost = new Map<number, number>();

function migratedAgentPayload(panelUrl: string) {
  return {
    success: false,
    error: "Panel migrated",
    panelUrl,
    agentUpgrade: { targetVersion: "9999.0.0", panelUrl },
  };
}

async function rejectAgentWhenPanelMigrated(_req: Request, res: Response, next: NextFunction) {
  const migratedTo = await db.getSetting("migratedToPanelUrl");
  if (migratedTo) {
    res.status(410).json(migratedAgentPayload(migratedTo));
    return;
  }
  next();
}

async function resetAgentRuntimeStateAfterReconnect(hostId: number, reason: string) {
  const now = Date.now();
  const last = lastRuntimeRecoveryByHost.get(hostId) || 0;
  if (now - last < AGENT_RUNTIME_RECOVERY_COOLDOWN_MS) return;
  lastRuntimeRecoveryByHost.set(hostId, now);
  await db.resetAgentRuntimeStateForHost(hostId);
  clearTunnelRuntimeStatusForHost(hostId);
  await refreshAgentsAffectedByHostAddress(hostId, reason);
  appendPanelLog("info", `[AgentRecovery] host=${hostId} reason=${reason} runtime state marked for reapply`);
}

async function openAgentEventStream(input: {
  req: Request;
  res: Response;
  token: string;
  agentVersion?: string | null;
}) {
  const { req, res, token } = input;
  const migratedTo = await db.getSetting("migratedToPanelUrl");
  if (migratedTo) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "close");
    res.flushHeaders?.();
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(encryptPayload({ type: "agent-upgrade", data: migratedAgentPayload(migratedTo).agentUpgrade }, token))}\n\n`);
    res.end();
    return;
  }
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
  const agentVersion = normalizeAgentText(input.agentVersion, 64);
  const wasOnline = isHostStatusOnline(host);
  if (agentVersion) {
    const upgradedFirewallCounterAgent = isAgentVersionAtLeast(agentVersion, AGENT_FIREWALL_COUNTER_REFRESH_VERSION)
      && !isAgentVersionAtLeast((host as any).agentVersion, AGENT_FIREWALL_COUNTER_REFRESH_VERSION);
    const upgradedProtocolGuardBackendAgent = isAgentVersionAtLeast(agentVersion, AGENT_PROTOCOL_GUARD_BACKEND_VERSION)
      && !isAgentVersionAtLeast((host as any).agentVersion, AGENT_PROTOCOL_GUARD_BACKEND_VERSION);
    await db.updateHostHeartbeat(host.id, { agentVersion } as any);
    if (upgradedFirewallCounterAgent) {
      await resetAgentRuntimeStateAfterReconnect(host.id, "agent-firewall-counter-upgrade");
    }
    if (upgradedProtocolGuardBackendAgent) {
      await resetAgentRuntimeStateAfterReconnect(host.id, "agent-protocol-guard-backend-upgrade");
    }
    const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
    const agentUpgradeCompleted = (host as any).agentUpgradeRequested
      && isAgentVersionAtLeast(agentVersion, requestedTargetVersion);
    if (agentUpgradeCompleted) {
      await db.clearHostAgentUpgradeRequest(host.id);
    }
    if (!wasOnline) {
      void notifyHostOnlineIfNeeded(host).catch((error) => {
        console.warn(`[HostStatus] Online notify failed host=${host.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const writeEncryptedEvent = (type: string, data: any) => {
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(encryptPayload({ type, data }, token))}\n\n`);
  };

  registerAgentEventClient(host.id, token, res);
  if (VERBOSE_AGENT_EVENTS) console.info(`[AgentEvent] host=${host.id} connected${agentVersion ? ` version=${agentVersion}` : ""}`);
  writeEncryptedEvent("ready", { success: true });

  const heartbeat = setInterval(() => {
    writeEncryptedEvent("ping", {});
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unregisterAgentEventClient(host.id, res);
    if (VERBOSE_AGENT_EVENTS) console.info(`[AgentEvent] host=${host.id} disconnected`);
  });
}

// 为所有 /api/agent/* POST 接口启用加密中间件（GET install.sh 等不需要）
agentRouter.use("/api/agent", (req, res, next) => {
  if (req.method !== "POST") return next();
  return agentEncryptionMiddleware(req, res, next);
});

agentRouter.post("/api/sync", agentEncryptionMiddleware, (req: Request, res: Response, next) => {
  const tunneledPath = getAgentTunneledPath(req);
  if (!tunneledPath) {
    res.status(400).json({ error: "Invalid encrypted request" });
    return;
  }
  req.url = tunneledPath;
  (agentApiRouter as any).handle(req, res, next);
});

agentApiRouter.use(rejectAgentWhenPanelMigrated);

agentRouter.get("/api/stream", async (req: Request, res: Response) => {
  try {
    const rawEnvelope = String(req.query.e || "");
    const envelope = rawEnvelope ? JSON.parse(rawEnvelope) : null;
    if (!isEncryptedEnvelope(envelope)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const resolved = decryptPayloadWithCandidates(envelope, await db.getAgentAuthTokenCandidates());
    rememberEncryptedEnvelope(envelope);
    await openAgentEventStream({
      req,
      res,
      token: resolved.token,
      agentVersion: resolved.payload?.agentVersion,
    });
  } catch (error) {
    console.error("[Agent Stream] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.get("/api/agent/events", async (req: Request, res: Response) => {
  try {
    let token: string | null = null;
    try {
      token = await resolveAgentTokenFromAuthorization(req);
    } catch {
      token = null;
    }
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await openAgentEventStream({ req, res, token, agentVersion: req.header("X-Agent-Version") });
  } catch (error) {
    console.error("[Agent Events] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 注册接口
agentApiRouter.post("/api/agent/register", async (req: Request, res: Response) => {
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
    const safeIpv4 = normalizeAgentAddress(ipv4);
    const safeIpv6 = normalizeAgentAddress(ipv6);
    const safeIp = normalizeAgentAddress(ip);
    const primaryIp = safeIpv4 || safeIp || safeIpv6 || "unknown";
    const nextOsInfo = normalizeAgentText(osInfo, 256);
    const nextCpuInfo = normalizeAgentText(cpuInfo, 256);
    const nextAgentVersion = normalizeAgentText(agentVersion, 64);

    const existingHost = await db.getHostByAgentToken(token);
    if (existingHost) {
      const wasOnline = isHostStatusOnline(existingHost);
      const hasIpv4Report = Object.prototype.hasOwnProperty.call(req.body, "ipv4");
      const hasIpv6Report = Object.prototype.hasOwnProperty.call(req.body, "ipv6");
      const nextIpv4 = hasIpv4Report ? (safeIpv4 || null) : ((existingHost as any).ipv4 || null);
      const nextIpv6 = hasIpv6Report ? (safeIpv6 || null) : ((existingHost as any).ipv6 || null);
      const entryChanged = [
        ["ip", primaryIp !== "unknown" ? primaryIp : existingHost.ip],
        ["ipv4", nextIpv4],
        ["ipv6", nextIpv6],
      ].some(([key, value]) => String(value || "") !== String((existingHost as any)[key as string] || ""));
      await db.updateHost(existingHost.id, {
        ip: primaryIp !== "unknown" ? primaryIp : existingHost.ip,
        ipv4: nextIpv4,
        ipv6: nextIpv6,
        ...(entryChanged ? {
          geoCountryCode: null,
          geoCountryName: null,
          geoRegion: null,
          geoEmoji: null,
          geoLatitudeMicro: null,
          geoLongitudeMicro: null,
          geoUpdatedAt: null,
        } : {}),
        osInfo: nextOsInfo || existingHost.osInfo,
        cpuInfo: nextCpuInfo || existingHost.cpuInfo,
        memoryTotal: memoryTotal || existingHost.memoryTotal,
        agentVersion: nextAgentVersion || (existingHost as any).agentVersion,
        isOnline: true,
        lastHeartbeat: new Date(),
      });
      if (entryChanged && hostUsesAutomaticIngress(existingHost)) {
        await refreshHostAddressRuntime(existingHost.id, existingHost, "agent-address-changed");
      }
      if (!wasOnline) {
        void notifyHostOnlineIfNeeded({ ...existingHost, ip: primaryIp !== "unknown" ? primaryIp : existingHost.ip, ipv4: nextIpv4, ipv6: nextIpv6 }).catch((error) => {
          console.warn(`[HostStatus] Online notify failed host=${existingHost.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      await resetAgentRuntimeStateAfterReconnect(existingHost.id, "agent-registered");
      res.json({ success: true, hostId: existingHost.id, message: "Host updated" });
      return;
    }

    const tokenDescription = String(agentToken.description || "").trim();

    // 创建新主机
    const hostId = await db.createHost({
      name: tokenDescription || `Agent-${token.substring(0, 8)}`,
      ip: primaryIp,
      ipv4: safeIpv4 || null,
      ipv6: safeIpv6 || null,
      hostType: "slave",
      agentToken: token,
      osInfo: nextOsInfo || null,
      cpuInfo: nextCpuInfo || null,
      memoryTotal: memoryTotal || null,
      agentVersion: nextAgentVersion || null,
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
registerAgentHeartbeatRoute(agentApiRouter);
registerAgentStatusRoutes(agentApiRouter);
registerAgentSelfTestRoutes(agentApiRouter);
registerAgentReportRoutes(agentApiRouter);

agentRouter.use(agentApiRouter);

agentRouter.get("/api/agent/install.sh", async (req: Request, res: Response) => {
  const panelUrl = await resolvePanelUrl(req);
  const settings = await db.getAllSettings();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateInstallScript(panelUrl, {
    githubAcceleratorEnabled: settings.githubAcceleratorEnabled === "true",
    githubAcceleratorUrl: settings.githubAcceleratorUrl || "",
    preferPanelInstall: settings.agentPreferPanelInstall === "true",
  }));
});

agentRouter.get("/api/agent/assets/:version/:asset", async (req: Request, res: Response) => {
  const version = String(req.params.version || "").trim().replace(/^v/i, "");
  const asset = String(req.params.asset || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version) || !AGENT_ASSET_NAME_SET.has(asset)) {
    res.status(404).send("Not found");
    return;
  }

  const filePath = await getOrFetchAgentAssetPath(version, asset);
  if (!filePath) {
    res.status(503).send("Agent asset not available");
    return;
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="${asset}"`);
  res.sendFile(filePath);
});

export { agentRouter };

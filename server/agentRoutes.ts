import { Router, Request, Response, NextFunction } from "express";
import * as db from "./db";
import {
  encryptPayload,
  decryptPayload,
  isEncryptedEnvelope,
} from "./agentCrypto";
import { AGENT_VERSION } from "./_core/systemRouter";

const agentRouter = Router();

type AgentEventClient = {
  hostId: number;
  token: string;
  res: Response;
};

const agentEventClients = new Map<number, AgentEventClient>();

function sendAgentEvent(hostId: number, event: string, data: any) {
  const client = agentEventClients.get(hostId);
  if (!client) {
    console.warn(`[AgentEvent] host=${hostId} event=${event} no active event stream`);
    return false;
  }
  client.res.write(`event: ${event}\n`);
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  console.info(`[AgentEvent] host=${hostId} event=${event} pushed`);
  return true;
}

export function pushAgentRefresh(hostId: number, reason: string) {
  return sendAgentEvent(hostId, "agent-refresh", { reason, ts: Date.now() });
}

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function parseSelfTestMeta(message: unknown): any | null {
  if (typeof message !== "string" || !message.trim().startsWith("{")) return null;
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

/**
 * Agent 加密中间件
 *
 * 请求处理：
 *   - 检测请求头 X-Agent-Encrypted: 1 与 body 结构是否为加密信封
 *   - 从 body.token 或 Authorization: Bearer 提取 token 作为密钥材料
 *   - 解密后覆盖 req.body，让后续业务代码透明处理
 * 响应处理：
 *   - 若请求是加密请求，拦截 res.json/res.send，对响应 body 加密后发送
 *   - 未加密请求从原路走（向后兼容老 Agent）
 */
function agentEncryptionMiddleware(req: Request, res: Response, next: NextFunction) {
  // 严格要求：所有 /api/agent/* POST 请求必须为加密会话
  const encHeader = req.header("X-Agent-Encrypted");
  if (encHeader !== "1" || !isEncryptedEnvelope(req.body)) {
    res.status(401).json({
      error: "Encrypted communication required",
      hint: "This server only accepts AES-256-CTR + HMAC-SHA256 encrypted requests. Please upgrade your Agent.",
    });
    return;
  }

  // 提取 token：优先从 Authorization: Bearer，其次从加密信封附加字段
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else if ((req.body as any).k && typeof (req.body as any).k === "string") {
    token = (req.body as any).k;
  }
  if (!token) {
    res.status(401).json({ error: "Encrypted request missing token" });
    return;
  }

  try {
    const plain = decryptPayload(req.body, token);
    req.body = plain;
  } catch (err: any) {
    res.status(400).json({ error: "Decryption failed", message: err?.message });
    return;
  }

  // 拦截响应，自动加密 JSON 返回
  const tokenForResp = token;
  const originalJson = res.json.bind(res);
  res.json = (body?: any) => {
    const env = encryptPayload(body, tokenForResp);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Agent-Encrypted", "1");
    return originalJson(env);
  };

  next();
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
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const agentVersion = req.header("X-Agent-Version");
    if (agentVersion) {
      await db.updateHostHeartbeat(host.id, { agentVersion } as any);
      const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
      const agentUpgradeCompleted = (host as any).agentUpgradeRequested
        && compareVersions(agentVersion, requestedTargetVersion) >= 0;
      if (agentUpgradeCompleted) {
        await db.clearHostAgentUpgradeRequest(host.id);
      }
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const previous = agentEventClients.get(host.id);
    previous?.res.end();
    agentEventClients.set(host.id, { hostId: host.id, token, res });
    console.info(`[AgentEvent] host=${host.id} connected${agentVersion ? ` version=${agentVersion}` : ""}`);
    res.write(`event: ready\n`);
    res.write(`data: {"success":true}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`event: ping\n`);
      res.write(`data: {}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      const current = agentEventClients.get(host.id);
      if (current?.res === res) {
        agentEventClients.delete(host.id);
      }
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
      res.json({ success: true, hostId: existingHost.id, message: "Host updated" });
      return;
    }

    // 创建新主机
    const hostId = await db.createHost({
      name: `Agent-${token.substring(0, 8)}`,
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
    res.json({ success: true, hostId, message: "Host registered" });
  } catch (error) {
    console.error("[Agent Register] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 心跳接口
agentRouter.post("/api/agent/heartbeat", async (req: Request, res: Response) => {
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

    const { cpuUsage, memoryUsage, memoryUsed, networkIn, networkOut, diskUsage, uptime, agentVersion } = req.body;

    await db.updateHostHeartbeat(host.id, { agentVersion: agentVersion || (host as any).agentVersion || null } as any);

    await db.insertHostMetric({
      hostId: host.id,
      cpuUsage: cpuUsage ?? null,
      memoryUsage: memoryUsage ?? null,
      memoryUsed: memoryUsed ?? null,
      networkIn: networkIn ?? null,
      networkOut: networkOut ?? null,
      diskUsage: diskUsage ?? null,
      uptime: uptime ?? null,
    });

    // 获取该主机的转发规则
    const rules = await db.getForwardRules(undefined, host.id);
    const hostTunnels = await db.getTunnelsByHost(host.id);
    const actions: any[] = [];

    // 获取主机配置的网卡名称（用于 realm --interface）
    const hostInterface = (host as any).networkInterface || "";

    /** 包装一条只追加一次的 iptables 规则：先 -C 检查是否存在，不存在才 -A */
    const ipIfMissing = (rule: string) => `iptables -C ${rule} 2>/dev/null || iptables -A ${rule}`;
    const ipIfMissingT = (table: string, rule: string) =>
      `iptables -t ${table} -C ${rule} 2>/dev/null || iptables -t ${table} -A ${rule}`;

    /**
     * 为转发规则创建一对 mangle 计数链以跨转发方式采集准确流量。
     * - FWX_IN_<port>：匹配 dport=<port> 的入站包（客户端→Agent）
     * - FWX_OUT_<port>：匹配 sport=<port> 的出站包（Agent→客户端响应）
     * 不设 RETURN，所以只作计数不影响路由。三种转发方式都会经过 mangle 表，覆盖 100% 路径。
     */
    const buildCountingChainCmds = (port: number): string[] => {
      const inCh = `FWX_IN_${port}`;
      const outCh = `FWX_OUT_${port}`;
      return [
        // 创建链（如已存在则忽略）
        `iptables -t mangle -N ${inCh} 2>/dev/null || true`,
        `iptables -t mangle -N ${outCh} 2>/dev/null || true`,
        // 挂入（使用 -C 防重）
        `iptables -t mangle -C PREROUTING -p tcp --dport ${port} -j ${inCh} 2>/dev/null || iptables -t mangle -A PREROUTING -p tcp --dport ${port} -j ${inCh}`,
        `iptables -t mangle -C PREROUTING -p udp --dport ${port} -j ${inCh} 2>/dev/null || iptables -t mangle -A PREROUTING -p udp --dport ${port} -j ${inCh}`,
        `iptables -t mangle -C POSTROUTING -p tcp --sport ${port} -j ${outCh} 2>/dev/null || iptables -t mangle -A POSTROUTING -p tcp --sport ${port} -j ${outCh}`,
        `iptables -t mangle -C POSTROUTING -p udp --sport ${port} -j ${outCh} 2>/dev/null || iptables -t mangle -A POSTROUTING -p udp --sport ${port} -j ${outCh}`,
        `iptables -t mangle -C INPUT -p tcp --dport ${port} -j ${inCh} 2>/dev/null || iptables -t mangle -A INPUT -p tcp --dport ${port} -j ${inCh}`,
        `iptables -t mangle -C INPUT -p udp --dport ${port} -j ${inCh} 2>/dev/null || iptables -t mangle -A INPUT -p udp --dport ${port} -j ${inCh}`,
        `iptables -t mangle -C OUTPUT -p tcp --sport ${port} -j ${outCh} 2>/dev/null || iptables -t mangle -A OUTPUT -p tcp --sport ${port} -j ${outCh}`,
        `iptables -t mangle -C OUTPUT -p udp --sport ${port} -j ${outCh} 2>/dev/null || iptables -t mangle -A OUTPUT -p udp --sport ${port} -j ${outCh}`,
      ];
    };
    const buildCountingCleanupCmds = (port: number): string[] => [
      `iptables -t mangle -D PREROUTING -p tcp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -D PREROUTING -p udp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -D POSTROUTING -p tcp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -t mangle -D POSTROUTING -p udp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -t mangle -D INPUT -p tcp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -D INPUT -p udp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -D OUTPUT -p tcp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -t mangle -D OUTPUT -p udp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -t mangle -F FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -X FWX_IN_${port} 2>/dev/null || true`,
      `iptables -t mangle -F FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -t mangle -X FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -D INPUT -p tcp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -D INPUT -p udp --dport ${port} -j FWX_IN_${port} 2>/dev/null || true`,
      `iptables -D OUTPUT -p tcp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -D OUTPUT -p udp --sport ${port} -j FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -F FWX_IN_${port} 2>/dev/null || true`,
      `iptables -X FWX_IN_${port} 2>/dev/null || true`,
      `iptables -F FWX_OUT_${port} 2>/dev/null || true`,
      `iptables -X FWX_OUT_${port} 2>/dev/null || true`,
    ];
    const writeUnitCmd = (svcName: string, unit: string) =>
      `printf '%s' '${Buffer.from(unit, "utf8").toString("base64")}' | base64 -d > /etc/systemd/system/${svcName}.service`;
    const gostServiceName = "forwardx-gost";
    const gostServiceUnit = [
      "[Unit]",
      "Description=ForwardX unified gost forwarder",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/usr/local/bin/gost -C /etc/forwardx-gost/config.json",
      "Restart=always",
      "RestartSec=5",
      "LimitNOFILE=65535",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    const gostRules = (await db.getForwardRules(undefined, host.id))
      .filter((r: any) => r.isEnabled && r.forwardType === "gost");
    const tunnelById = new Map((hostTunnels as any[]).map((t: any) => [t.id, t]));
    const tunnelProtocolType = (mode: string) => {
      if (mode === "wss" || mode === "mwss") return "ws";
      if (mode === "tcp" || mode === "mtcp") return "tcp";
      return "tls";
    };
    const tunnelProtocolMetadata = (mode: string) => (
      mode === "mtls" || mode === "mwss" || mode === "mtcp"
        ? { mux: "true" }
        : undefined
    );
    const tunnelForwardProtos = (protocol: string) => protocol === "udp" ? [] : ["tcp"];
    const tunnelExitHostAddress = async (tunnel: any) => {
      const exit = await db.getHostById(tunnel.exitHostId);
      if (!exit) return "";
      return ((exit as any).entryIp && String((exit as any).entryIp).trim()) || exit.ip || "";
    };
    const tunnelExitHostById = new Map<number, string>();
    for (const tunnel of hostTunnels as any[]) {
      if (tunnel.entryHostId === host.id && tunnel.isEnabled) {
        tunnelExitHostById.set(tunnel.id, await tunnelExitHostAddress(tunnel));
      }
    }
    const tunnelExitRules = (await db.getForwardRules(undefined))
      .filter((r: any) => {
        if (!r.isEnabled || r.forwardType !== "gost" || !r.tunnelId) return false;
        const tunnel = tunnelById.get(r.tunnelId) as any;
        return !!tunnel && tunnel.isEnabled && tunnel.exitHostId === host.id;
      });

    const gostServiceConfig = gostRules
      .flatMap((r: any) => {
        const tunnel = (r as any).tunnelId ? tunnelById.get((r as any).tunnelId) as any : null;
        const protos = tunnel ? tunnelForwardProtos(r.protocol) : (r.protocol === "both" ? ["tcp", "udp"] : [r.protocol === "udp" ? "udp" : "tcp"]);
        return protos.map((proto) => {
          if ((r as any).gostMode === "reverse") {
            return {
              name: `fwx-${r.id}-${proto}`,
              addr: ":0",
              handler: { type: proto === "udp" ? "rudp" : "rtcp" },
              listener: { type: proto === "udp" ? "rudp" : "rtcp", chain: `chain-${r.id}-${proto}` },
              forwarder: {
                nodes: [{
                  name: `target-${r.id}`,
                  addr: `${r.targetIp}:${r.targetPort}`,
                }],
              },
            };
          }
          const tunnelExitHost = tunnel ? tunnelExitHostById.get(tunnel.id) : "";
          const service: any = {
            name: `fwx-${r.id}-${proto}`,
            addr: `:${r.sourcePort}`,
            handler: tunnel ? { type: proto, chain: `chain-tunnel-${r.id}` } : { type: proto },
            listener: { type: proto },
            forwarder: { nodes: [] as any[] },
          };
          if (!tunnel) {
            service.forwarder.nodes.push({
              name: `target-${r.id}`,
              addr: `${r.targetIp}:${r.targetPort}`,
              connector: { type: proto },
              dialer: { type: proto },
            });
          } else if (!tunnelExitHost || !(r as any).tunnelExitPort) {
            return null;
          }
          return service;
        });
      })
      .filter(Boolean);
    const reverseGostChains = gostRules
      .filter((r: any) => (r as any).gostMode === "reverse")
      .flatMap((r: any) => {
        const protos = r.protocol === "both" ? ["tcp", "udp"] : [r.protocol === "udp" ? "udp" : "tcp"];
        return protos.map((proto) => {
          const tunnelId = `00000000-0000-4000-8000-${String(r.id).padStart(12, "0").slice(-12)}`;
          return {
            name: `chain-${r.id}-${proto}`,
            hops: [{
              name: `hop-${r.id}-${proto}`,
              nodes: [{
                name: `relay-${r.id}-${proto}`,
                addr: `${(r as any).gostRelayHost}:${(r as any).gostRelayPort}`,
                connector: {
                  type: "tunnel",
                  metadata: { "tunnel.id": tunnelId },
                },
                dialer: { type: "tcp" },
              }],
            }],
          };
        });
      });
    const tunnelGostChains = gostRules
      .filter((r: any) => r.isEnabled && r.forwardType === "gost" && r.tunnelId)
      .flatMap((r: any) => {
        const tunnel = tunnelById.get((r as any).tunnelId) as any;
        const tunnelExitHost = tunnel ? tunnelExitHostById.get(tunnel.id) : "";
        if (!tunnel || !tunnelExitHost || !(r as any).tunnelExitPort) return [];
        return [{
          name: `chain-tunnel-${r.id}`,
          hops: [{
            name: `hop-tunnel-${r.id}`,
            nodes: [{
              name: `exit-${r.id}`,
              addr: `${tunnelExitHost}:${(r as any).tunnelExitPort}`,
              connector: { type: "forward" },
              dialer: {
                type: tunnelProtocolType(tunnel.mode),
                ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
              },
            }],
          }],
        }];
      });
    const gostChains = [...reverseGostChains, ...tunnelGostChains];
    const buildGostReloadCmds = () => {
      const encodedConfig = Buffer.from(JSON.stringify({ services: gostServiceConfig, chains: gostChains }, null, 2), "utf8").toString("base64");
      return [
        `command -v /usr/local/bin/gost >/dev/null 2>&1 || command -v gost >/dev/null 2>&1`,
        `mkdir -p /etc/forwardx-gost`,
        `printf '%s' '${encodedConfig}' | base64 -d > /etc/forwardx-gost/config.json`,
        writeUnitCmd(gostServiceName, gostServiceUnit),
        `systemctl daemon-reload`,
        `systemctl enable ${gostServiceName}.service 2>/dev/null || true`,
        gostServiceConfig.length > 0
          ? `systemctl restart ${gostServiceName}.service`
          : `systemctl stop ${gostServiceName}.service 2>/dev/null || true`,
      ];
    };
    const buildTunnelReloadCmds = () => {
      const tunnelProbeServices = hostTunnels
        .filter((tunnel: any) => tunnel.exitHostId === host.id && tunnel.isEnabled)
        .map((tunnel: any) => ({
          name: `fwx-tunnel-probe-${tunnel.id}`,
          addr: `:${tunnel.listenPort}`,
          handler: { type: "tcp" },
          listener: {
            type: tunnelProtocolType(tunnel.mode),
            ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
          },
          forwarder: {
            nodes: [{
              name: `probe-${tunnel.id}`,
              addr: "127.0.0.1:9",
              connector: { type: "tcp" },
              dialer: { type: "tcp" },
            }],
          },
        }));
      const ruleServices = tunnelExitRules.flatMap((rule: any) => {
        const tunnel = tunnelById.get(rule.tunnelId) as any;
        if (!tunnel || !rule.tunnelExitPort) return [];
        const protos = tunnelForwardProtos(rule.protocol);
        return protos.map((proto) => ({
          name: `fwx-tunnel-exit-${tunnel.id}-${rule.id}-${proto}`,
          addr: `:${rule.tunnelExitPort}`,
          handler: { type: "forward" },
          listener: {
            type: tunnelProtocolType(tunnel.mode),
            ...(tunnelProtocolMetadata(tunnel.mode) ? { metadata: tunnelProtocolMetadata(tunnel.mode) } : {}),
          },
          forwarder: {
            nodes: [{
              name: `target-${rule.id}`,
              addr: `${rule.targetIp}:${rule.targetPort}`,
              connector: { type: "forward" },
              dialer: { type: proto },
            }],
          },
        }));
      });
      const services = [...tunnelProbeServices, ...ruleServices];
      const encodedConfig = Buffer.from(JSON.stringify({ services }, null, 2), "utf8").toString("base64");
      return [
        `command -v /usr/local/bin/gost >/dev/null 2>&1 || command -v gost >/dev/null 2>&1`,
        `mkdir -p /etc/forwardx-tunnels`,
        `printf '%s' '${encodedConfig}' | base64 -d > /etc/forwardx-tunnels/config.json`,
        writeUnitCmd("forwardx-tunnels", [
          "[Unit]",
          "Description=ForwardX managed gost tunnels",
          "After=network.target",
          "",
          "[Service]",
          "Type=simple",
          "ExecStart=/usr/local/bin/gost -C /etc/forwardx-tunnels/config.json",
          "Restart=always",
          "RestartSec=5",
          "LimitNOFILE=65535",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
          "",
        ].join("\n")),
        `systemctl daemon-reload`,
        `systemctl enable forwardx-tunnels.service 2>/dev/null || true`,
        services.length > 0 ? `systemctl restart forwardx-tunnels.service` : `systemctl stop forwardx-tunnels.service 2>/dev/null || true`,
      ];
    };

    // 收集所有正在运行的规则的 port→ruleId 映射，用于 agent 重建映射文件
    const runningRules: { ruleId: number; sourcePort: number; targetIp: string; targetPort: number; protocol: string; forwardType: string }[] = [];

    const pendingTunnelExitRuleIds = new Set(
      tunnelExitRules
        .filter((rule: any) => !rule.isRunning)
        .map((rule: any) => Number(rule.tunnelId))
    );
    for (const tunnel of hostTunnels as any[]) {
      if (tunnel.exitHostId !== host.id) continue;
      if (tunnel.isEnabled && (!tunnel.isRunning || pendingTunnelExitRuleIds.has(Number(tunnel.id)))) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "apply",
          forwardType: "gost-tunnel",
          sourcePort: tunnel.listenPort,
          targetIp: host.ip,
          targetPort: tunnel.listenPort,
          protocol: "tcp",
          commands: buildTunnelReloadCmds(),
        });
      } else if (!tunnel.isEnabled && tunnel.isRunning) {
        actions.push({
          tunnelId: tunnel.id,
          statusType: "tunnel",
          ruleId: 0,
          op: "remove",
          forwardType: "gost-tunnel",
          sourcePort: tunnel.listenPort,
          targetIp: host.ip,
          targetPort: tunnel.listenPort,
          protocol: "tcp",
          commands: buildTunnelReloadCmds(),
        });
      }
    }

    for (const rule of rules) {
      // 收集所有已运行的规则映射（无论是否有 action 下发）
      if (rule.isEnabled && rule.isRunning) {
        runningRules.push({
          ruleId: rule.id,
          sourcePort: rule.sourcePort,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          protocol: rule.protocol,
          forwardType: rule.forwardType,
        });
      }

      if (rule.isEnabled && !rule.isRunning) {
        const cmds: string[] = [];
        if (rule.forwardType === "iptables") {
          const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
          // 必须先启用内核转发，否则 DNAT 后数据包不会被路由到目标主机
          cmds.push(`sysctl -w net.ipv4.ip_forward=1 >/dev/null`);
          // 避免重复添加：先反向清理同 sourcePort 老规则
          cmds.push(`while iptables -t nat -C PREROUTING -p tcp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null; do iptables -t nat -D PREROUTING -p tcp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}; done`);
          cmds.push(`while iptables -t nat -C PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null; do iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}; done`);

          cmds.push(ipIfMissingT("nat", `PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}`));
          cmds.push(ipIfMissingT("nat", `POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
          if (rule.protocol === "both") {
            cmds.push(ipIfMissingT("nat", `PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort}`));
            cmds.push(ipIfMissingT("nat", `POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE`));
          }
          // FORWARD 默认 DROP 的发行版（如 Debian/Docker host）需要显式放行
          cmds.push(ipIfMissing(`FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT`));
          cmds.push(ipIfMissing(`FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT`));
          if (rule.protocol === "both") {
            cmds.push(ipIfMissing(`FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT`));
            cmds.push(ipIfMissing(`FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j ACCEPT`));
          }
          // 挂入 mangle 计数链，为 Agent 采样提供准确流量计数器
          for (const c of buildCountingChainCmds(rule.sourcePort)) cmds.push(c);
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: cmds,
          });
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          const udpFlag = rule.protocol === "udp" || rule.protocol === "both" ? "--udp" : "";
          // 如果主机配置了网卡，realm 使用 --interface 绑定
          const ifaceFlag = hostInterface ? `--interface ${hostInterface}` : "";
          const realmCmd = `/usr/local/bin/realm -l 0.0.0.0:${rule.sourcePort} -r ${rule.targetIp}:${rule.targetPort} ${udpFlag} ${ifaceFlag}`.replace(/\s+/g, ' ').trim();
          const unit = [
            "[Unit]",
            `Description=ForwardX realm forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            `ExecStart=${realmCmd}`,
            "Restart=always",
            "RestartSec=5",
            "LimitNOFILE=65535",
            "",
            "[Install]",
            "WantedBy=multi-user.target",
            "",
          ].join("\n");
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            svcName,
            unit,
            commands: [
              `systemctl daemon-reload`,
              `systemctl enable ${svcName}.service`,
              `systemctl restart ${svcName}.service`,
              // 同时为该端口挂入 mangle 计数链，保证 realm 转发也能被准确统计
              ...buildCountingChainCmds(rule.sourcePort),
            ],
          });
        } else if (rule.forwardType === "socat") {
          // socat 转发：用户态进程，通过 systemd 管理
          const svcName = `forwardx-socat-${rule.sourcePort}`;
          const socatCmds: string[] = [];
          // socat 需要安装
          socatCmds.push(`command -v socat >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq socat || yum install -y -q socat || dnf install -y -q socat || apk add --no-cache socat; } 2>/dev/null`);

          // 根据协议生成 socat 命令
          // TCP: socat TCP-LISTEN:sourcePort,fork,reuseaddr TCP:targetIp:targetPort
          // UDP: socat UDP-LISTEN:sourcePort,fork,reuseaddr UDP:targetIp:targetPort
          // both: 需要两个 socat 进程
          if (rule.protocol === "both") {
            // 两个服务：一个 TCP 一个 UDP
            const svcNameTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcNameUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            const unitTcp = [
              "[Unit]",
              `Description=ForwardX socat TCP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat TCP-LISTEN:${rule.sourcePort},fork,reuseaddr TCP:${rule.targetIp}:${rule.targetPort}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            const unitUdp = [
              "[Unit]",
              `Description=ForwardX socat UDP forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=/usr/bin/socat UDP-LISTEN:${rule.sourcePort},fork,reuseaddr UDP:${rule.targetIp}:${rule.targetPort}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat both 模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort)) socatCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              svcName: svcNameTcp,
              svcNameExtra: svcNameUdp,
              unit: unitTcp,
              unitExtra: unitUdp,
              commands: socatCmds,
            });
          } else {
            const protoUpper = rule.protocol === "udp" ? "UDP" : "TCP";
            const socatCmd = `/usr/bin/socat ${protoUpper}-LISTEN:${rule.sourcePort},fork,reuseaddr ${protoUpper}:${rule.targetIp}:${rule.targetPort}`;
            const unit = [
              "[Unit]",
              `Description=ForwardX socat ${rule.protocol} forwarder ${rule.sourcePort}->${rule.targetIp}:${rule.targetPort}`,
              "After=network.target",
              "",
              "[Service]",
              "Type=simple",
              `ExecStart=${socatCmd}`,
              "Restart=always",
              "RestartSec=5",
              "LimitNOFILE=65535",
              "",
              "[Install]",
              "WantedBy=multi-user.target",
              "",
            ].join("\n");
            // socat 单协议模式下为该端口挂入 mangle 计数链
            for (const c of buildCountingChainCmds(rule.sourcePort)) socatCmds.push(c);
            actions.push({
              ruleId: rule.id,
              op: "apply",
              forwardType: rule.forwardType,
              sourcePort: rule.sourcePort,
              targetIp: rule.targetIp,
              targetPort: rule.targetPort,
              protocol: rule.protocol,
              networkInterface: hostInterface,
              svcName,
              unit,
              commands: socatCmds,
            });
          }
        } else if (rule.forwardType === "gost") {
          actions.push({
            ruleId: rule.id,
            op: "apply",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            networkInterface: hostInterface,
            commands: [...buildGostReloadCmds(), ...buildCountingChainCmds(rule.sourcePort)],
          });
        }
      } else if (!rule.isEnabled && rule.isRunning) {
        const cmds: string[] = [];
        if (rule.forwardType === "iptables") {
          const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
          cmds.push(`iptables -t nat -D PREROUTING -p ${proto} --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
          cmds.push(`iptables -t nat -D POSTROUTING -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
          if (rule.protocol === "both") {
            cmds.push(`iptables -t nat -D PREROUTING -p udp --dport ${rule.sourcePort} -j DNAT --to-destination ${rule.targetIp}:${rule.targetPort} 2>/dev/null || true`);
            cmds.push(`iptables -t nat -D POSTROUTING -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j MASQUERADE 2>/dev/null || true`);
          }
          cmds.push(`iptables -D FORWARD -p ${proto} -d ${rule.targetIp} --dport ${rule.targetPort} -j ACCEPT 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p ${proto} -s ${rule.targetIp} --sport ${rule.targetPort} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true`);
          // 清理 conntrack 流量状态文件
          cmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          cmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
          // 兼容清理旧版 mangle/filter 表计数链
          cmds.push(`iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p tcp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -d ${rule.targetIp} --dport ${rule.targetPort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p tcp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -D FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          cmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: cmds,
          });
        } else if (rule.forwardType === "realm") {
          const svcName = `forwardx-realm-${rule.sourcePort}`;
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            svcName,
            commands: [
              `systemctl stop ${svcName}.service 2>/dev/null || true`,
              `systemctl disable ${svcName}.service 2>/dev/null || true`,
              `rm -f /etc/systemd/system/${svcName}.service`,
              `systemctl daemon-reload`,
              `pkill -f "realm .*:${rule.sourcePort}" 2>/dev/null || true`,
              // 清理 conntrack 流量状态文件
              `rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`,
              `rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`,
              // 兼容清理旧版 mangle/filter 表计数链
              `iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D OUTPUT -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -D OUTPUT -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
              `iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`,
            ],
          });
        } else if (rule.forwardType === "socat") {
          const removeCmds: string[] = [];
          if (rule.protocol === "both") {
            const svcTcp = `forwardx-socat-tcp-${rule.sourcePort}`;
            const svcUdp = `forwardx-socat-udp-${rule.sourcePort}`;
            removeCmds.push(`systemctl stop ${svcTcp}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcTcp}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcTcp}.service`);
            removeCmds.push(`systemctl stop ${svcUdp}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcUdp}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcUdp}.service`);
          } else {
            const svcName = `forwardx-socat-${rule.sourcePort}`;
            removeCmds.push(`systemctl stop ${svcName}.service 2>/dev/null || true`);
            removeCmds.push(`systemctl disable ${svcName}.service 2>/dev/null || true`);
            removeCmds.push(`rm -f /etc/systemd/system/${svcName}.service`);
          }
          removeCmds.push(`systemctl daemon-reload`);
          removeCmds.push(`pkill -f "socat.*LISTEN:${rule.sourcePort}" 2>/dev/null || true`);
          // 清理 conntrack 流量状态文件
          removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
          // 兼容清理旧版 mangle/filter 表计数链
          removeCmds.push(`iptables -t mangle -D PREROUTING -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D PREROUTING -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D POSTROUTING -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -D POSTROUTING -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -t mangle -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D INPUT -p tcp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D INPUT -p udp --dport ${rule.sourcePort} -j FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p tcp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -D OUTPUT -p udp --sport ${rule.sourcePort} -j FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_IN_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -F FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          removeCmds.push(`iptables -X FWX_OUT_${rule.sourcePort} 2>/dev/null || true`);
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
          });
        } else if (rule.forwardType === "gost") {
          const removeCmds: string[] = [...buildGostReloadCmds()];
          removeCmds.push(`pkill -f "gost .*:${rule.sourcePort}" 2>/dev/null || true`);
          removeCmds.push(`rm -f /var/lib/forwardx-agent/traffic_${rule.sourcePort}.prev 2>/dev/null || true`);
          removeCmds.push(`rm -f /var/lib/forwardx-agent/port_${rule.sourcePort}.rule 2>/dev/null || true`);
          removeCmds.push(...buildCountingCleanupCmds(rule.sourcePort));
          actions.push({
            ruleId: rule.id,
            op: "remove",
            forwardType: rule.forwardType,
            sourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
            protocol: rule.protocol,
            commands: removeCmds,
          });
        }
      }
    }

    // 取走该主机的 pending 转发自测任务并标为 running
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

    const requestedTargetVersion = (host as any).agentUpgradeTargetVersion || AGENT_VERSION;
    const agentUpgradeCompleted = (host as any).agentUpgradeRequested
      && agentVersion
      && compareVersions(agentVersion, requestedTargetVersion) >= 0;
    if (agentUpgradeCompleted) {
      await db.clearHostAgentUpgradeRequest(host.id);
    }
    const agentUpgrade = (host as any).agentUpgradeRequested && !agentUpgradeCompleted ? {
      targetVersion: requestedTargetVersion,
      panelUrl: await resolvePanelUrl(req),
    } : null;

    res.json({ success: true, actions, selfTests, runningRules, agentUpgrade });
  } catch (error) {
    console.error("[Agent Heartbeat] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 规则状态回调
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
    if (statusType === "tunnel") {
      if (typeof tunnelId !== "number") {
        res.status(400).json({ error: "tunnelId is required" });
        return;
      }
      const tunnel = await db.getTunnelById(tunnelId);
      if (!tunnel || (tunnel.entryHostId !== host.id && tunnel.exitHostId !== host.id)) {
        res.status(404).json({ error: "tunnel not found" });
        return;
      }
      await db.updateTunnelRunningStatus(tunnelId, !!isRunning);
      res.json({ success: true });
      return;
    }
    if (typeof ruleId !== "number") {
      res.status(400).json({ error: "ruleId is required" });
      return;
    }

    await db.updateRuleRunningStatus(ruleId, !!isRunning);
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果
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
    if (meta?.kind === "forward-via-tunnel" && typeof meta.tunnelId === "number") {
      const tunnelLatency = await db.getLatestTunnelLatency(meta.tunnelId);
      const tunnelLatencyMs =
        tunnelLatency && !(tunnelLatency as any).isTimeout && typeof (tunnelLatency as any).latencyMs === "number"
          ? Number((tunnelLatency as any).latencyMs)
          : 0;
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

    const { stats } = req.body;
    if (!Array.isArray(stats)) {
      res.status(400).json({ error: "stats array is required" });
      return;
    }

    let totalBytes = 0;
    for (const stat of stats) {
      const bytesIn = stat.bytesIn || 0;
      const bytesOut = stat.bytesOut || 0;
      await db.insertTrafficStat({
        ruleId: stat.ruleId,
        hostId: host.id,
        bytesIn,
        bytesOut,
        connections: stat.connections || 0,
      });
      totalBytes += bytesIn + bytesOut;
    }

    // 累加用户已用流量
    if (totalBytes > 0) {
      await db.addUserTraffic(host.userId, totalBytes);

      // 检查用户流量配额
      const user = await db.getUserById(host.userId);
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

    const { results } = req.body;
    if (!Array.isArray(results)) {
      res.status(400).json({ error: "results array is required" });
      return;
    }

    const stats = results.map((r: any) => ({
      ruleId: Number(r.ruleId),
      hostId: host.id,
      latencyMs: typeof r.latencyMs === "number" && r.latencyMs > 0 ? r.latencyMs : null,
      isTimeout: !!r.isTimeout,
    }));

    if (stats.length > 0) {
      await db.insertTcpingStats(stats);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Agent TCPing] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Generate install.sh bootstrap script as a plain string
function generateInstallScript(defaultPanelUrl: string): string {
  const lines = [
    '#!/bin/bash',
    '# ForwardX Agent 管理脚本',
    '# 安装: curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL="your-panel-url" bash -s -- install YOUR_TOKEN',
    '# 升级: curl -sL PANEL_URL/api/agent/install.sh | bash -s -- upgrade',
    '# 卸载: curl -sL PANEL_URL/api/agent/install.sh | bash -s -- uninstall',
    '',
    'set -e',
    '',
    'ACTION="${1:-}"',
    'TOKEN="${2:-}"',
    `PANEL_URL="\${PANEL_URL:-${defaultPanelUrl}}"`,
    '# GitHub 仓库脚本镜像，安装时优先从 GitHub 获取，失败后回退面板',
    'GITHUB_INSTALL_URL="https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh"',
    '',
    'show_help() {',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 管理工具"',
    '  echo "======================================"',
    '  echo ""',
    '  echo "用法:"',
    '  echo "  安装 Agent:"',
    '  echo "    curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL=\\"http://your-panel:3000\\" bash -s -- install YOUR_TOKEN"',
    '  echo ""',
    '  echo "  卸载 Agent:"',
    '  echo "    curl -sL PANEL_URL/api/agent/install.sh | bash -s -- uninstall"',
    '  echo ""',
    '  echo "  升级 Agent:"',
    '  echo "    curl -sL PANEL_URL/api/agent/install.sh | bash -s -- upgrade"',
    '  echo ""',
    '  echo "参数:"',
    '  echo "  install   <TOKEN>  安装 Agent 并注册到面板"',
    '  echo "  upgrade   [TOKEN]  升级 Agent，默认复用现有面板地址和 Token"',
    '  echo "  uninstall          完全卸载 Agent 及相关组件"',
    '  echo ""',
    '}',
    '',
    'do_uninstall() {',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 卸载程序"',
    '  echo "======================================"',
    '  echo ""',
    '',
    '  if [ "$(id -u)" != "0" ]; then',
    '    echo "[错误] 请使用 root 权限运行此脚本"',
    '    exit 1',
    '  fi',
    '',
    '  SERVICE_NAME="forwardx-agent"',
    '  INSTALL_DIR="/opt/forwardx-agent"',
    '',
    '  echo "[步骤 1/4] 停止 Agent 服务..."',
    '  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then',
    '    systemctl stop "$SERVICE_NAME"',
    '    echo "[信息] 服务已停止"',
    '  else',
    '    echo "[信息] 服务未在运行"',
    '  fi',
    '',
    '  echo "[步骤 2/4] 禁用并删除服务..."',
    '  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then',
    '    systemctl disable "$SERVICE_NAME" 2>/dev/null || true',
    '    rm -f "/etc/systemd/system/$SERVICE_NAME.service"',
    '    systemctl daemon-reload',
    '    echo "[信息] 服务文件已删除"',
    '  else',
    '    echo "[信息] 服务文件不存在"',
    '  fi',
    '',
    '  echo "[步骤 3/6] 清理 Agent 文件..."',
    '  if [ -d "$INSTALL_DIR" ]; then',
    '    rm -rf "$INSTALL_DIR"',
    '    echo "[信息] 安装目录已删除: $INSTALL_DIR"',
    '  else',
    '    echo "[信息] 安装目录不存在"',
    '  fi',
    '',
    '  echo "[步骤 4/6] 清理转发进程和服务..."',
    '  # 停止转发进程',
    '  pkill -f "realm -l" 2>/dev/null && echo "[信息] 已停止所有 realm 转发进程" || echo "[信息] 无 realm 进程需要停止"',
    '  pkill -f "socat.*LISTEN" 2>/dev/null && echo "[信息] 已停止所有 socat 转发进程" || echo "[信息] 无 socat 进程需要停止"',
    '  pkill -f "gost .*:" 2>/dev/null && echo "[信息] 已停止所有 gost 转发进程" || echo "[信息] 无 gost 进程需要停止"',
    '  # 清理 socat/realm/gost systemd 服务',
    '  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service /etc/systemd/system/forwardx-gost-*.service; do',
    '    if [ -f "$SVC" ]; then',
    '      SVCNAME=$(basename "$SVC" .service)',
    '      systemctl stop "$SVCNAME" 2>/dev/null || true',
    '      systemctl disable "$SVCNAME" 2>/dev/null || true',
    '      rm -f "$SVC"',
    '      echo "[信息] 已删除服务: $SVCNAME"',
    '    fi',
    '  done',
    '  systemctl daemon-reload 2>/dev/null || true',
    '',
    '  echo "[步骤 5/6] 清理转发规则和流量计数链..."',
    '  # 清理 mangle 表中的 FWX 计数链',
    '  for CH in $(iptables -t mangle -L 2>/dev/null | awk \'/^Chain FWX_/ {print $2}\'); do',
    '    for P in tcp udp; do',
    '      iptables -t mangle -D PREROUTING -p $P -j "$CH" 2>/dev/null || true',
    '      iptables -t mangle -D POSTROUTING -p $P -j "$CH" 2>/dev/null || true',
    '    done',
    '    iptables -t mangle -F "$CH" 2>/dev/null || true',
    '    iptables -t mangle -X "$CH" 2>/dev/null || true',
    '    echo "[信息] 已清理 mangle 计数链: $CH"',
    '  done',
    '  # 清理 filter 表中的旧版 FWX 计数链（兼容旧版）',
    '  for CH in $(iptables -L 2>/dev/null | awk \'/^Chain FWX_/ {print $2}\'); do',
    '    for P in tcp udp; do',
    '      iptables -D FORWARD -p $P -j "$CH" 2>/dev/null || true',
    '      iptables -D INPUT -p $P -j "$CH" 2>/dev/null || true',
    '      iptables -D OUTPUT -p $P -j "$CH" 2>/dev/null || true',
    '    done',
    '    iptables -F "$CH" 2>/dev/null || true',
    '    iptables -X "$CH" 2>/dev/null || true',
    '    echo "[信息] 已清理 filter 计数链: $CH"',
    '  done',
    '  # 清理 ForwardX 添加的 iptables 转发规则（nat + FORWARD ACCEPT）',
    '  while iptables -t nat -S PREROUTING 2>/dev/null | grep -q "DNAT"; do',
    '    RULE=$(iptables -t nat -S PREROUTING 2>/dev/null | grep "DNAT" | head -1 | sed "s/^-A/-D/")',
    '    [ -z "$RULE" ] && break',
    '    iptables -t nat $RULE 2>/dev/null || break',
    '  done',
    '  while iptables -t nat -S POSTROUTING 2>/dev/null | grep -q "MASQUERADE"; do',
    '    RULE=$(iptables -t nat -S POSTROUTING 2>/dev/null | grep "MASQUERADE" | head -1 | sed "s/^-A/-D/")',
    '    [ -z "$RULE" ] && break',
    '    iptables -t nat $RULE 2>/dev/null || break',
    '  done',
    '  echo "[信息] 转发规则和计数链已清理"',
    '',
    '  echo "[步骤 6/6] 清理日志和状态文件..."',
    '  if [ -d "/var/log/forwardx-agent" ]; then',
    '    rm -rf "/var/log/forwardx-agent"',
    '    echo "[信息] 日志目录已删除: /var/log/forwardx-agent"',
    '  fi',
    '  if [ -d "/var/lib/forwardx-agent" ]; then',
    '    rm -rf "/var/lib/forwardx-agent"',
    '    echo "[信息] 状态目录已删除: /var/lib/forwardx-agent"',
    '  fi',
    '',
    '  echo ""',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 卸载完成!"',
    '  echo "======================================"',
    '  echo ""',
    '  echo "  已清理内容:"',
    '  echo "    - Agent 服务和安装目录"',
    '  echo "    - ForwardX 转发规则和流量统计数据"',
    '  echo "    - realm/socat/gost 转发进程和服务"',
    '  echo "    - 日志和状态文件"',
    '  echo ""',
    '  echo "  如需重新安装，请使用 install 命令"',
    '  echo "======================================"',
    '}',
    '',
    'read_existing_config() {',
    '  AGENT_FILE="/opt/forwardx-agent/agent.sh"',
    '  if [ -f "$AGENT_FILE" ]; then',
    '    EXISTING_PANEL_URL=$(grep -E "^PANEL_URL=" "$AGENT_FILE" 2>/dev/null | head -1 | cut -d\'"\' -f2 || true)',
    '    EXISTING_AGENT_TOKEN=$(grep -E "^AGENT_TOKEN=" "$AGENT_FILE" 2>/dev/null | head -1 | cut -d\'"\' -f2 || true)',
    '  fi',
    '}',
    '',
    'do_install() {',
    '  AGENT_TOKEN="$1"',
    '  if [ -z "$AGENT_TOKEN" ]; then',
    '    echo "[错误] 安装模式需要提供 Agent Token"',
    '    echo "用法: curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL=\\"http://your-panel:3000\\" bash -s -- install YOUR_TOKEN"',
    '    exit 1',
    '  fi',
    '',
    '  echo "面板地址: $PANEL_URL"',
    '  echo "Token: $AGENT_TOKEN"',
    '  echo ""',
    '',
    '  # 优先尝试从 GitHub 获取安装脚本，失败后回退面板',
    '  echo "[信息] 尝试从 GitHub 获取安装脚本：$GITHUB_INSTALL_URL"',
    '  TMP_SCRIPT=$(mktemp)',
    '  if curl -fsSL --max-time 15 "$GITHUB_INSTALL_URL" -o "$TMP_SCRIPT" 2>/dev/null && [ -s "$TMP_SCRIPT" ]; then',
    '    echo "[信息] 从 GitHub 获取成功，开始安装..."',
    '    PANEL_URL="$PANEL_URL" AGENT_TOKEN="$AGENT_TOKEN" bash "$TMP_SCRIPT" install "$AGENT_TOKEN"',
    '    rm -f "$TMP_SCRIPT"',
    '  else',
    '    echo "[信息] GitHub 不可达或返回为空，回退从面板获取"',
    '    rm -f "$TMP_SCRIPT"',
    '    curl -fsSL --max-time 30 "$PANEL_URL/api/agent/full-install.sh?token=$AGENT_TOKEN" | bash',
    '  fi',
    '}',
    '',
    'do_upgrade() {',
    '  OVERRIDE_TOKEN="$1"',
    '  if [ "$(id -u)" != "0" ]; then',
    '    echo "[错误] 请使用 root 权限运行此脚本"',
    '    exit 1',
    '  fi',
    '  read_existing_config',
    '  PANEL_URL="${PANEL_URL:-${EXISTING_PANEL_URL:-}}"',
    '  AGENT_TOKEN="${OVERRIDE_TOKEN:-${AGENT_TOKEN:-${EXISTING_AGENT_TOKEN:-}}}"',
    '  if [ -z "$PANEL_URL" ]; then',
    '    echo "[错误] 未找到面板地址，请设置 PANEL_URL 后重试"',
    '    exit 1',
    '  fi',
    '  if [ -z "$AGENT_TOKEN" ]; then',
    '    echo "[错误] 未找到 Agent Token，请传入 Token 或重新安装"',
    '    exit 1',
    '  fi',
    '  PANEL_URL="${PANEL_URL%/}"',
    '  echo "======================================"',
    '  echo "  ForwardX Agent 升级程序"',
    '  echo "======================================"',
    '  echo "面板地址: $PANEL_URL"',
    '  echo "Token: ${AGENT_TOKEN:0:8}***"',
    '  echo ""',
    '  echo "[信息] 正在拉取最新完整安装包并覆盖升级..."',
    '  curl -fsSL --max-time 60 "$PANEL_URL/api/agent/full-install.sh?token=$AGENT_TOKEN" | bash',
    '}',
    '',
    'case "$ACTION" in',
    '  install)',
    '    do_install "$TOKEN"',
    '    ;;',
    '  upgrade|update)',
    '    do_upgrade "$TOKEN"',
    '    ;;',
    '  uninstall|remove|delete)',
    '    do_uninstall',
    '    ;;',
    '  *)',
    '    show_help',
    '    if [ -n "$ACTION" ]; then',
    '      echo "[提示] 未知操作: $ACTION"',
    '      echo ""',
    '    fi',
    '    echo "请选择操作:"',
    '    echo "  1) 安装 Agent"',
    '    echo "  2) 卸载 Agent"',
    '    echo "  3) 升级 Agent"',
    '    echo ""',
    '    read -p "请输入选项 [1/2/3]: " CHOICE',
    '    case "$CHOICE" in',
    '      1)',
    '        read -p "请输入 Agent Token: " INPUT_TOKEN',
    '        read -p "请输入面板地址 [$PANEL_URL]: " INPUT_URL',
    '        if [ -n "$INPUT_URL" ]; then',
    '          PANEL_URL="$INPUT_URL"',
    '        fi',
    '        do_install "$INPUT_TOKEN"',
    '        ;;',
    '      2)',
    '        do_uninstall',
    '        ;;',
    '      3)',
    '        read -p "请输入面板地址（留空则读取现有安装）[$PANEL_URL]: " INPUT_URL',
    '        if [ -n "$INPUT_URL" ]; then',
    '          PANEL_URL="$INPUT_URL"',
    '        fi',
    '        do_upgrade',
    '        ;;',
    '      *)',
    '        echo "[错误] 无效选项"',
    '        exit 1',
    '        ;;',
    '    esac',
    '    ;;',
    'esac',
  ];
  return lines.join('\n') + '\n';
}

// Generate full install script as a plain string
export function generateFullInstallScript(panelUrl: string, token: string): string {
  const lines = [
    '#!/bin/bash',
    'set -e',
    '',
    'PANEL_URL="' + panelUrl + '"',
    'AGENT_TOKEN="' + token + '"',
    'INSTALL_DIR="/opt/forwardx-agent"',
    'SERVICE_NAME="forwardx-agent"',
    '',
    'echo "======================================"',
    'echo "  ForwardX Agent 一键安装脚本"',
    'echo "======================================"',
    'echo ""',
    '',
    'if [ "$(id -u)" != "0" ]; then',
    '  echo "[错误] 请使用 root 权限运行此脚本"',
    '  exit 1',
    'fi',
    '',
    '# 检查是否已安装',
    'if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then',
    '  echo "[信息] 检测到已安装的 Agent 服务，将进行更新..."',
    '  systemctl stop "$SERVICE_NAME"',
    'fi',
    '',
    'OS_INFO=$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d\'"\' -f2 || uname -s)',
    'CPU_INFO=$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d\':\' -f2 | xargs || uname -m)',
    'MEM_TOTAL=$(grep MemTotal /proc/meminfo 2>/dev/null | awk \'{print $2}\' || echo "0")',
    'MEM_TOTAL_BYTES=$((MEM_TOTAL * 1024))',
    'PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 icanhazip.com || echo "unknown")',
    '',
    'echo "[信息] 系统: $OS_INFO"',
    'echo "[信息] CPU: $CPU_INFO"',
    'echo "[信息] 内存: $((MEM_TOTAL / 1024)) MB"',
    'echo "[信息] 公网IP: $PUBLIC_IP"',
    'echo ""',
    '',
    'echo "[步骤 1/5] 安装依赖..."',
    'if [ "$(id -u)" -ne 0 ]; then echo "[错误] 必须以 root 运行"; exit 1; fi',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update -qq && apt-get install -y -qq curl jq socat iptables iproute2 coreutils tar systemd openssl xxd >/dev/null 2>&1 || \\',
    '    apt-get install -y -qq curl jq socat iptables iproute2 coreutils tar systemd openssl vim-common >/dev/null 2>&1 || true',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  dnf install -y -q curl jq socat iptables iproute coreutils tar systemd openssl vim-common >/dev/null 2>&1 || true',
    'elif command -v yum >/dev/null 2>&1; then',
    '  yum install -y -q curl jq socat iptables iproute coreutils tar systemd openssl vim-common >/dev/null 2>&1 || true',
    'elif command -v zypper >/dev/null 2>&1; then',
    '  zypper -n install curl jq socat iptables iproute2 coreutils tar systemd openssl vim >/dev/null 2>&1 || true',
    'elif command -v apk >/dev/null 2>&1; then',
    '  apk add --no-cache curl jq socat iptables iproute2 coreutils tar openrc openssl xxd >/dev/null 2>&1 || true',
    'fi',
    'for B in curl jq iptables base64 openssl xxd; do',
    '  if ! command -v $B >/dev/null 2>&1; then echo "[错误] 未能安装依赖: $B，该依赖是加密通讯必需"; exit 1; fi',
    'done',
    '',
    'echo "[步骤 2/5] 安装 realm/gost 与启用内核转发..."',
    '# 开启 conntrack 计数器（流量统计依赖）',
    'sysctl -w net.netfilter.nf_conntrack_acct=1 >/dev/null 2>&1 || true',
    'if ! grep -qE "^\\s*net\\.netfilter\\.nf_conntrack_acct\\s*=\\s*1" /etc/sysctl.conf 2>/dev/null; then',
    '  echo "net.netfilter.nf_conntrack_acct=1" >> /etc/sysctl.conf',
    'fi',
    '# 永久化开启 IPv4 转发',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
    'if ! grep -qE "^\\s*net\\.ipv4\\.ip_forward\\s*=\\s*1" /etc/sysctl.conf 2>/dev/null; then',
    '  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf',
    'fi',
    'sysctl -p >/dev/null 2>&1 || true',
    'if ! command -v realm &>/dev/null; then',
    '  REALM_VERSION="v2.6.0"',
    '  ARCH=$(uname -m)',
    '  case $ARCH in',
    '    x86_64) REALM_ARCH="x86_64-unknown-linux-gnu" ;;',
    '    aarch64) REALM_ARCH="aarch64-unknown-linux-gnu" ;;',
    '    *) echo "[警告] 不支持的架构: $ARCH, 跳过 realm 安装"; REALM_ARCH="" ;;',
    '  esac',
    '  if [ -n "$REALM_ARCH" ]; then',
    '    curl -sL "https://github.com/zhboner/realm/releases/download/$REALM_VERSION/realm-$REALM_ARCH.tar.gz" -o /tmp/realm.tar.gz && \\',
    '    tar -xzf /tmp/realm.tar.gz -C /usr/local/bin/ && \\',
    '    chmod +x /usr/local/bin/realm && \\',
    '    rm -f /tmp/realm.tar.gz && \\',
    '    echo "[信息] realm 安装成功" || echo "[警告] realm 安装失败，将仅使用 iptables/socat/gost"',
    '  fi',
    'else',
    '  echo "[信息] realm 已安装"',
    'fi',
    'install_gost() {',
    '  if [ -x /usr/local/bin/gost ] || command -v gost >/dev/null 2>&1; then echo "[信息] gost 已安装"; return 0; fi',
    '  GOST_VERSION="${GOST_VERSION:-3.2.6}"',
    '  GOST_VERSION="${GOST_VERSION#v}"',
    '  ARCH=$(uname -m)',
    '  case "$ARCH" in',
    '    x86_64|amd64) GOST_ASSETS="amd64v3 amd64v2 amd64v1 amd64" ;;',
    '    aarch64|arm64) GOST_ASSETS="arm64" ;;',
    '    i386|i686) GOST_ASSETS="386" ;;',
    '    *) echo "[警告] 不支持的架构: $ARCH, 跳过 gost 安装"; return 1 ;;',
    '  esac',
    '  TMP=$(mktemp -d)',
    '  for GOST_ARCH in $GOST_ASSETS; do',
    '    GOST_URL="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_${GOST_ARCH}.tar.gz"',
    '    if curl -fsSL --max-time 90 "$GOST_URL" -o "$TMP/gost.tgz"; then',
    '      tar -xzf "$TMP/gost.tgz" -C "$TMP" && \\',
    '        GOST_BIN=$(find "$TMP" -type f -name gost | head -n1) && \\',
    '        [ -n "$GOST_BIN" ] && install -m 0755 "$GOST_BIN" /usr/local/bin/gost && \\',
    '        rm -rf "$TMP" && \\',
    '        echo "[信息] gost 安装成功" && return 0',
    '    fi',
    '  done',
    '  rm -rf "$TMP"',
    '  echo "[警告] gost 安装失败，将仅使用 iptables/realm/socat"',
    '  return 1',
    '}',
    'install_gost || true',
    '',
    'echo "[步骤 3/5] 创建 Agent 程序..."',
    'mkdir -p "$INSTALL_DIR"',
    '',
    "cat > \"$INSTALL_DIR/agent.sh\" << 'AGENT_EOF'",
    '#!/bin/bash',
    'PANEL_URL="__PANEL_URL__"',
    'AGENT_TOKEN="__AGENT_TOKEN__"',
    'HEARTBEAT_INTERVAL=30',
    'SELFTEST_POLL_INTERVAL=3',
    'STATE_DIR="/var/lib/forwardx-agent"',
    'mkdir -p "$STATE_DIR"',
    '',
    '# ============ 日志文件 ============',
    'LOG_DIR="/var/log/forwardx-agent"',
    'mkdir -p "$LOG_DIR"',
    'LOG_TODAY=""',
    'LOG_FILE=""',
    '',
    '# 每次写日志前检查日期，跨天则切换文件并删除旧日志',
    'ensure_log_file() {',
    '  local TODAY=$(date "+%Y-%m-%d")',
    '  if [ "$LOG_TODAY" != "$TODAY" ]; then',
    '    LOG_TODAY="$TODAY"',
    '    LOG_FILE="$LOG_DIR/agent-${LOG_TODAY}.log"',
    '    # 删除非今天的日志文件',
    '    find "$LOG_DIR" -name "agent-*.log" ! -name "agent-${TODAY}.log" -delete 2>/dev/null || true',
    '  fi',
    '}',
    '',
    'log() {',
    '  local LEVEL="$1"; shift',
    '  ensure_log_file',
    '  local MSG="[$(date "+%Y-%m-%d %H:%M:%S")] [$LEVEL] $*"',
    '  echo "$MSG"',
    '  echo "$MSG" >> "$LOG_FILE" 2>/dev/null || true',
    '}',
    '',
    '# ============ 加密通讯辅助函数 (AES-256-CTR + HMAC-SHA256) ============',
    '# 与服务端 agentCrypto.ts 实现保持一致：',
    '#   key_enc = SHA-256(token | "forwardx-agent-v1")',
    '#   key_mac = SHA-256(token | "forwardx-agent-mac")',
    '# 依赖 openssl + xxd（主流 Linux 发行版默认提供）',
    'ENCRYPTION_AVAILABLE=0',
    'if command -v openssl >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then',
    '  ENCRYPTION_AVAILABLE=1',
    'fi',
    '',
    'fwx_key_enc_hex() {',
    '  printf "%s|forwardx-agent-v1" "$AGENT_TOKEN" | openssl dgst -sha256 -hex 2>/dev/null | awk \'{print $NF}\'',
    '}',
    'fwx_key_mac_hex() {',
    '  printf "%s|forwardx-agent-mac" "$AGENT_TOKEN" | openssl dgst -sha256 -hex 2>/dev/null | awk \'{print $NF}\'',
    '}',
    '',
    '# 将整数转 8 字节大端 hex',
    'fwx_int64be_hex() {',
    '  printf "%016x" "$1"',
    '}',
    '',
    '# 将明文 JSON 包装为加密信封，输出为一行 JSON',
    '# 用法: fwx_encrypt_envelope <plaintext>',
    'fwx_encrypt_envelope() {',
    '  local PLAIN="$1"',
    '  local KEY_ENC_HEX=$(fwx_key_enc_hex)',
    '  local KEY_MAC_HEX=$(fwx_key_mac_hex)',
    '  local IV_HEX=$(openssl rand -hex 16)',
    '  local CT_HEX=$(printf "%s" "$PLAIN" | openssl enc -aes-256-ctr -K "$KEY_ENC_HEX" -iv "$IV_HEX" 2>/dev/null | xxd -p -c 99999 | tr -d "\n")',
    '  local TS_MS=$(($(date +%s%N) / 1000000))',
    '  local TS_HEX=$(fwx_int64be_hex "$TS_MS")',
    '  # MAC 输入："v1"(2B) + IV(16B) + CT + TS(8B)',
    '  local V1_HEX="7631"',
    '  local MAC_INPUT_HEX="${V1_HEX}${IV_HEX}${CT_HEX}${TS_HEX}"',
    '  local MAC_HEX=$(printf "%s" "$MAC_INPUT_HEX" | xxd -r -p | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY_MAC_HEX" 2>/dev/null | awk \'{print $NF}\')',
    '  printf \'{"v":1,"iv":"%s","ct":"%s","mac":"%s","ts":%s}\' "$IV_HEX" "$CT_HEX" "$MAC_HEX" "$TS_MS"',
    '}',
    '',
    '# 解密服务端返回的加密信封，输出明文 JSON',
    'fwx_decrypt_envelope() {',
    '  local RAW="$1"',
    '  local V=$(echo "$RAW" | jq -r ".v // empty" 2>/dev/null)',
    '  if [ "$V" != "1" ]; then',
    '    echo "$RAW"',
    '    return 0',
    '  fi',
    '  local IV_HEX=$(echo "$RAW" | jq -r ".iv")',
    '  local CT_HEX=$(echo "$RAW" | jq -r ".ct")',
    '  local KEY_ENC_HEX=$(fwx_key_enc_hex)',
    '  printf "%s" "$CT_HEX" | xxd -r -p | openssl enc -d -aes-256-ctr -K "$KEY_ENC_HEX" -iv "$IV_HEX" 2>/dev/null',
    '}',
    '',
    '# 发送 POST 请求（强制加密，自动解密响应）。',
    '# 用法: agent_post <path> <plaintext_json> [extra_curl_args...]',
    'agent_post() {',
    '  local PATH_="$1"; shift',
    '  local PLAIN="$1"; shift',
    '  local URL="${PANEL_URL}${PATH_}"',
    '  if [ "$ENCRYPTION_AVAILABLE" != "1" ]; then',
    '    log ERROR "[crypto] openssl/xxd 不可用，无法加密。Agent 必须在加密模式下运行。"',
    '    return 1',
    '  fi',
    '  local ENV_JSON',
    '  ENV_JSON=$(fwx_encrypt_envelope "$PLAIN" 2>/dev/null) || ENV_JSON=""',
    '  if [ -z "$ENV_JSON" ]; then',
    '    log ERROR "[crypto] 加密信封生成失败"',
    '    return 1',
    '  fi',
    '  local RESP',
    '  RESP=$(curl -s --max-time 10 -X POST "$URL" \\',
    '    -H "Content-Type: application/json" \\',
    '    -H "Authorization: Bearer $AGENT_TOKEN" \\',
    '    -H "X-Agent-Encrypted: 1" \\',
    '    -d "$ENV_JSON" "$@")',
    '  if [ -z "$RESP" ]; then return 1; fi',
    '  fwx_decrypt_envelope "$RESP"',
    '}',
    '',
    '# 自动检测默认出口网卡',
    'detect_default_iface() {',
    '  DEV=$(ip route show default 2>/dev/null | awk \'{print $5; exit}\')',
    '  echo "${DEV:-eth0}"',
    '}',
    '',
    '# 上报规则运行状态 isRunning=true|false',
    'report_rule_status() {',
    '  RULE_ID="$1"',
    '  RUNNING="$2"',
    '  agent_post "/api/agent/rule-status" "{\\"ruleId\\":$RULE_ID,\\"isRunning\\":$RUNNING}" >/dev/null 2>&1',
    '}',
    '',
    '# 检测本机是否在监听指定端口',
    'check_port_listen() {',
    '  PORT="$1"',
    '  PROTO="$2"   # tcp/udp/both',
    '  FORWARD_TYPE="$3"  # iptables/realm/socat/gost',
    '  if [ "$FORWARD_TYPE" = "iptables" ]; then',
    '    if iptables -t nat -S PREROUTING 2>/dev/null | grep -E " --dport ${PORT} " >/dev/null 2>&1; then',
    '      return 0',
    '    fi',
    '    return 1',
    '  fi',
    '  # realm/socat/gost: 用户态监听检测',
    '  if command -v ss >/dev/null 2>&1; then',
    '    if [ "$PROTO" = "udp" ]; then',
    '      ss -lun 2>/dev/null | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    elif [ "$PROTO" = "both" ]; then',
    '      ( ss -ltn 2>/dev/null; ss -lun 2>/dev/null ) | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    else',
    '      ss -ltn 2>/dev/null | awk \'{print $5}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    fi',
    '    return 1',
    '  fi',
    '  if command -v netstat >/dev/null 2>&1; then',
    '    netstat -ln 2>/dev/null | awk \'{print $4}\' | grep -E "[:.]${PORT}$" >/dev/null 2>&1 && return 0',
    '    return 1',
    '  fi',
    '  return 1',
    '}',
    '',
    '# ============ 流量采集 ============',
    '# 使用 conntrack (内核连接跟踪) 统计流量，不依赖 iptables 链/表',
    '# 优势：无论 iptables-legacy 还是 nftables 后端，无论哪种转发类型，都能正确统计',
    '# 原理：读取 /proc/net/nf_conntrack 按 dport 匹配端口，累加 bytes 字段',
    '# 注意：conntrack 记录的是累计值，需要计算上次采样与本次的差值作为增量上报',
    '',
    '# 确保 conntrack 计数器已开启',
    'ensure_conntrack_acct() {',
    '  ACCT=$(cat /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || echo 0)',
    '  if [ "$ACCT" != "1" ]; then',
    '    sysctl -w net.netfilter.nf_conntrack_acct=1 >/dev/null 2>&1 || true',
    '    # 持久化',
    '    if ! grep -qE "^\\s*net\\.netfilter\\.nf_conntrack_acct\\s*=\\s*1" /etc/sysctl.conf 2>/dev/null; then',
    '      echo "net.netfilter.nf_conntrack_acct=1" >> /etc/sysctl.conf',
    '    fi',
    '    log INFO "[traffic] 已开启 conntrack 计数器 (nf_conntrack_acct=1)"',
    '  fi',
    '}',
    '',
    '# 从 iptables mangle 计数链采集指定端口的累计流量',
    '# 返回: bytesIn bytesOut（connections 从 conntrack 补充）',
    '# 读取 PREROUTING/POSTROUTING 中跳转到子链的规则计数器（内核级累计值）',
    '# 不受 conntrack 过期/重启影响，三种转发方式都能被覆盖。',
    'sample_iptables_counters() {',
    '  PORT="$1"',
    '  IN_CH="FWX_IN_${PORT}"',
    '  OUT_CH="FWX_OUT_${PORT}"',
    '  # 从 PREROUTING 链中找到跳转到 FWX_IN_<port> 的规则，累加其 bytes 计数器',
    '  IN_BYTES=$(iptables -t mangle -nvxL PREROUTING 2>/dev/null | awk -v ch="$IN_CH" \'$0 ~ ch {s+=$2} END {print s+0}\')',
    '  # 从 POSTROUTING 链中找到跳转到 FWX_OUT_<port> 的规则，累加其 bytes 计数器',
    '  OUT_BYTES=$(iptables -t mangle -nvxL POSTROUTING 2>/dev/null | awk -v ch="$OUT_CH" \'$0 ~ ch {s+=$2} END {print s+0}\')',
    '  echo "${IN_BYTES:-0} ${OUT_BYTES:-0}"',
    '}',
    '',
    '# 从 conntrack 表中采集指定端口的流量（累计值，作为备用源与 connections 计数源）',
    '# 返回: bytesIn bytesOut conns',
    'sample_conntrack() {',
    '  PORT="$1"',
    '  # 从 /proc/net/nf_conntrack 读取，精确匹配 dport=PORT(后跟空格)',
    '  # 每行有两组 bytes=：第一组是原始方向(入站)，第二组是回复方向(出站)',
    '  RESULT=$(awk -v port="$PORT" \'',
    '    BEGIN { bi=0; bo=0; c=0 }',
    '    $0 ~ "dport="port" " {',
    '      n=split($0, a, " ")',
    '      ff=0',
    '      for(i=1;i<=n;i++) {',
    '        if(a[i] ~ /^bytes=/) {',
    '          split(a[i], b, "=")',
    '          if(ff==0) { bi += b[2]; ff=1 }',
    '          else { bo += b[2] }',
    '        }',
    '      }',
    '      c++',
    '    }',
    '    END { print bi " " bo " " c }',
    '  \' /proc/net/nf_conntrack 2>/dev/null)',
    '  if [ -z "$RESULT" ]; then echo "0 0 0"; return; fi',
    '  echo "$RESULT"',
    '}',
    '',
    '# 初始化 conntrack',
    'ensure_conntrack_acct',
    '',
    '# 确保 realm 已安装',
    'ensure_realm() {',
    '  if [ -x /usr/local/bin/realm ]; then return 0; fi',
    '  echo "[$(date)] [agent] realm 未安装，开始下载..."',
    '  ARCH=$(uname -m)',
    '  case "$ARCH" in',
    '    x86_64|amd64) RARCH="x86_64-unknown-linux-gnu";;',
    '    aarch64|arm64) RARCH="aarch64-unknown-linux-gnu";;',
    '    *) echo "[agent] 不支持的架构: $ARCH"; return 1;;',
    '  esac',
    '  TMP=$(mktemp -d)',
    '  URL="https://github.com/zhboner/realm/releases/latest/download/realm-${RARCH}.tar.gz"',
    '  if curl -fsSL --max-time 60 "$URL" -o "$TMP/realm.tgz"; then',
    '    tar -xzf "$TMP/realm.tgz" -C "$TMP" 2>/dev/null || true',
    '    REALM_BIN=$(find "$TMP" -type f -name realm | head -n1)',
    '    if [ -n "$REALM_BIN" ]; then',
    '      install -m 0755 "$REALM_BIN" /usr/local/bin/realm',
    '      rm -rf "$TMP"',
    '      echo "[$(date)] [agent] realm 安装完成"',
    '      return 0',
    '    fi',
    '  fi',
    '  rm -rf "$TMP"',
    '  echo "[$(date)] [agent] realm \u4e0b\u8f7d\u5931\u8d25"',
    '  return 1',
    '}',
    '',
    '# ============ \u8f6c\u53d1\u81ea\u6d4b ============',
    '',
    '# TCP \u5ef6\u8fdf\u68c0\u6d4b\uff1a\u6d4b\u8bd5\u8f6c\u53d1\u673a\u5668\u5230\u76ee\u6807 IP:Port \u7684 TCP \u8fde\u63a5\u5ef6\u8fdf\uff08ms\uff09',
    '# \u6574\u4e2a\u51fd\u6570\u6700\u591a 3 \u79d2\u8d85\u65f6\uff0c\u907f\u514d\u5361\u4f4f',
    'tcp_latency() {',
    '  IP="$1"; PORT="$2"',
    '  # \u4f18\u5148\u7528 bash /dev/tcp \u6d4b\u91cf\u7cbe\u786e\u5ef6\u8fdf\uff0c\u4e25\u683c 3 \u79d2\u8d85\u65f6',
    '  if command -v bash >/dev/null 2>&1; then',
    '    START_NS=$(date +%s%N 2>/dev/null || echo 0)',
    '    if timeout 3 bash -c "</dev/tcp/$IP/$PORT" >/dev/null 2>&1; then',
    '      END_NS=$(date +%s%N 2>/dev/null || echo 0)',
    '      if [ "$START_NS" != "0" ] && [ "$END_NS" != "0" ]; then',
    '        DIFF_NS=$((END_NS - START_NS))',
    '        DIFF_MS=$((DIFF_NS / 1000000))',
    '        [ "$DIFF_MS" -le 0 ] && DIFF_MS=1',
    '        echo "$DIFF_MS"',
    '        return 0',
    '      fi',
    '      echo "1"',
    '      return 0',
    '    fi',
    '    # bash /dev/tcp \u8d85\u65f6\u6216\u5931\u8d25\uff0c\u76f4\u63a5\u8fd4\u56de\u5931\u8d25\uff0c\u4e0d\u518d\u56de\u9000 nc',
    '    echo "0"',
    '    return 1',
    '  fi',
    '  # \u65e0 bash \u65f6\u56de\u9000 nc\uff0c\u4e25\u683c 3 \u79d2\u8d85\u65f6',
    '  if command -v nc >/dev/null 2>&1; then',
    '    START_NS=$(date +%s%N 2>/dev/null || echo 0)',
    '    if timeout 3 nc -z -n -w 3 "$IP" "$PORT" >/dev/null 2>&1; then',
    '      END_NS=$(date +%s%N 2>/dev/null || echo 0)',
    '      if [ "$START_NS" != "0" ] && [ "$END_NS" != "0" ]; then',
    '        DIFF_NS=$((END_NS - START_NS))',
    '        DIFF_MS=$((DIFF_NS / 1000000))',
    '        [ "$DIFF_MS" -le 0 ] && DIFF_MS=1',
    '        echo "$DIFF_MS"',
    '        return 0',
    '      fi',
    '      echo "1"',
    '      return 0',
    '    fi',
    '  fi',
    '  echo "0"',
    '  return 1',
    '}',
    '',
    'report_selftest() {',
    '  TID="$1"; TR="$2"; LAT="$3"; MSG="$4"',
    '  PAYLOAD=$(jq -n --argjson tid "$TID" --argjson t "$TR" --argjson lat "${LAT:-0}" --arg msg "$MSG" \'{testId:$tid,targetReachable:($t==1),latencyMs:$lat,message:$msg}\')',
    '  agent_post "/api/agent/selftest-result" "$PAYLOAD" >/dev/null 2>&1',
    '}',
    '',
    'run_selftests() {',
    '  RESPONSE="$1"',
    '  TC=$(echo "$RESPONSE" | jq \'(.selfTests // []) | length\' 2>/dev/null || echo 0)',
    '  if [ "$TC" -le 0 ] 2>/dev/null; then return; fi',
    '  for i in $(seq 0 $((TC - 1))); do',
    '    TID=$(echo "$RESPONSE" | jq -r ".selfTests[$i].testId")',
    '    FT=$(echo "$RESPONSE" | jq -r ".selfTests[$i].forwardType")',
    '    PR=$(echo "$RESPONSE" | jq -r ".selfTests[$i].protocol")',
    '    SP=$(echo "$RESPONSE" | jq -r ".selfTests[$i].sourcePort")',
    '    TIP=$(echo "$RESPONSE" | jq -r ".selfTests[$i].targetIp")',
    '    TPT=$(echo "$RESPONSE" | jq -r ".selfTests[$i].targetPort")',
    '    LOG=""',
    '    TR=0; LAT=0',
    '',
    '    # 仅检测目标端口 TCP 可达性和 tcping 延迟',
    '    log INFO "[selftest] test=$TID 开始: target=$TIP:$TPT proto=$PR"',
    '    log DEBUG "[selftest] test=$TID 开始 TCP 延迟检测: $TIP:$TPT"',
    '    TCP_LAT=$(tcp_latency "$TIP" "$TPT")',
    '    TCP_RC=$?',
    '    if [ $TCP_RC -eq 0 ] && [ "${TCP_LAT:-0}" -gt 0 ] 2>/dev/null; then',
    '      TR=1',
    '      LAT="$TCP_LAT"',
    '      LOG="${LOG}目标 $TIP:$TPT TCP可达, 延迟 ${LAT}ms;"',
    '      log INFO "[selftest] test=$TID 目标 $TIP:$TPT TCP可达, 延迟 ${LAT}ms"',
    '    else',
    '      # TCP 连接失败，回退用 ping 检测网络层可达性（timeout 5s 防止卡住）',
    '      log WARN "[selftest] test=$TID TCP 连接 $TIP:$TPT 失败，回退 ping 检测"',
    '      PING_RESULT=$(timeout 5 ping -c 2 -W 2 "$TIP" 2>/dev/null | tail -1)',
    '      if echo "$PING_RESULT" | grep -q "avg"; then',
    '        PING_LAT=$(echo "$PING_RESULT" | awk -F "/" "NR==1{printf \"%d\", \$5}" 2>/dev/null || echo 0)',
    '        LOG="${LOG}目标 $TIP:$TPT TCP不可达, 但主机 ping 通(${PING_LAT}ms), 端口可能未开放;"',
    '        log WARN "[selftest] test=$TID 目标主机 ping 通(${PING_LAT}ms) 但 TCP $TPT 端口不可达"',
    '      else',
    '        LOG="${LOG}目标 $TIP:$TPT 完全不可达(TCP+ping均失败);"',
    '        log ERROR "[selftest] test=$TID 目标 $TIP:$TPT 完全不可达"',
    '      fi',
    '    fi',
    '',
    '    report_selftest "$TID" "$TR" "$LAT" "$LOG"',
    '    log DEBUG "[selftest] test=$TID 结果已上报: TR=$TR LAT=${LAT}ms"',
    '  done',
    '}',
    '',
    '# 将 systemd unit 全文写入 /etc/systemd/system/<name>.service',
    'write_systemd_unit() {',
    '  NAME="$1"',
    '  CONTENT_B64="$2"',
    '  if [ -z "$NAME" ] || [ -z "$CONTENT_B64" ]; then return 1; fi',
    '  echo "$CONTENT_B64" | base64 -d > "/etc/systemd/system/$NAME.service"',
    '}',
    '',
    'apply_actions() {',
    '  RESPONSE="$1"',
    '  ACTION_COUNT=$(echo "$RESPONSE" | jq \'(.actions // []) | length\' 2>/dev/null || echo 0)',
    '  if [ "$ACTION_COUNT" -le 0 ] 2>/dev/null; then log DEBUG "[apply] 无待执行 actions"; return; fi',
    '  log INFO "[apply] 收到 $ACTION_COUNT 个 actions"',
    '  for i in $(seq 0 $((ACTION_COUNT - 1))); do',
    '    RID=$(echo "$RESPONSE" | jq -r ".actions[$i].ruleId")',
    '    OP=$(echo "$RESPONSE" | jq -r ".actions[$i].op")',
    '    FT=$(echo "$RESPONSE" | jq -r ".actions[$i].forwardType")',
    '    SP=$(echo "$RESPONSE" | jq -r ".actions[$i].sourcePort")',
    '    PR=$(echo "$RESPONSE" | jq -r ".actions[$i].protocol")',
    '    TIP=$(echo "$RESPONSE" | jq -r ".actions[$i].targetIp // empty")',
    '    TPT=$(echo "$RESPONSE" | jq -r ".actions[$i].targetPort // empty")',
    '    log INFO "[apply] action[$i]: ruleId=$RID op=$OP forwardType=$FT port=$SP proto=$PR target=$TIP:$TPT"',
    '    SVC=$(echo "$RESPONSE" | jq -r ".actions[$i].svcName // empty")',
    '    SVC_EXTRA=$(echo "$RESPONSE" | jq -r ".actions[$i].svcNameExtra // empty")',
    '    UNIT_TXT=$(echo "$RESPONSE" | jq -r ".actions[$i].unit // empty")',
    '    UNIT_EXTRA_TXT=$(echo "$RESPONSE" | jq -r ".actions[$i].unitExtra // empty")',
    '    # 从面板下发的网卡名称，为空则自动检测',
    '    IFACE=$(echo "$RESPONSE" | jq -r ".actions[$i].networkInterface // empty")',
    '    if [ -z "$IFACE" ]; then IFACE=$(detect_default_iface); fi',
    '    export NET_IFACE="$IFACE"',
    '    ALL_OK=1',
    '',
    '    # 1) realm apply: 先确保 realm 二进制 + 写入 systemd unit',
    '    if [ "$OP" = "apply" ] && [ "$FT" = "realm" ]; then',
    '      ensure_realm || ALL_OK=0',
    '      if [ -n "$SVC" ] && [ -n "$UNIT_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '    fi',
    '',
    '    # 1b) socat apply: 写入 systemd unit(s)',
    '    if [ "$OP" = "apply" ] && [ "$FT" = "socat" ]; then',
    '      if [ -n "$SVC" ] && [ -n "$UNIT_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '      # TCP+UDP 模式有第二个服务',
    '      if [ -n "$SVC_EXTRA" ] && [ -n "$UNIT_EXTRA_TXT" ]; then',
    '        UNIT_B64=$(printf "%s" "$UNIT_EXTRA_TXT" | base64 -w 0)',
    '        if ! write_systemd_unit "$SVC_EXTRA" "$UNIT_B64"; then ALL_OK=0; fi',
    '      fi',
    '      # socat 服务需要 daemon-reload + enable + restart',
    '      systemctl daemon-reload',
    '      if [ -n "$SVC" ]; then',
    '        systemctl enable "$SVC.service" 2>/dev/null || true',
    '        systemctl restart "$SVC.service" 2>/dev/null || ALL_OK=0',
    '      fi',
    '      if [ -n "$SVC_EXTRA" ]; then',
    '        systemctl enable "$SVC_EXTRA.service" 2>/dev/null || true',
    '        systemctl restart "$SVC_EXTRA.service" 2>/dev/null || ALL_OK=0',
    '      fi',
    '    fi',
    '',
    '    # 2) 逐条执行单行 command',
    '    CMD_COUNT=$(echo "$RESPONSE" | jq "(.actions[$i].commands // []) | length" 2>/dev/null || echo 0)',
    '    if [ "$CMD_COUNT" -gt 0 ] 2>/dev/null; then',
    '      for j in $(seq 0 $((CMD_COUNT - 1))); do',
    '        CMD=$(echo "$RESPONSE" | jq -r ".actions[$i].commands[$j]")',
    '        if [ -z "$CMD" ] || [ "$CMD" = "null" ]; then continue; fi',
    '        log DEBUG "[apply] [rule=$RID op=$OP] 执行: $CMD"',
    '        OUTPUT=$(bash -c "$CMD" 2>&1)',
    '        RC=$?',
    '        if [ -n "$OUTPUT" ]; then echo "$OUTPUT" | head -20; echo "$OUTPUT" | head -20 >> "$LOG_FILE" 2>/dev/null || true; fi',
    '        if [ $RC -ne 0 ]; then',
    '          log ERROR "[apply] [rule=$RID] 命令失败 rc=$RC cmd=$CMD"',
    '          ALL_OK=0',
    '        fi',
    '      done',
    '    fi',
    '',
    '    if [ "$OP" = "apply" ]; then',
    '      sleep 1',
    '      if [ "$ALL_OK" -eq 1 ] && check_port_listen "$SP" "$PR" "$FT"; then',
    '        # 确保 conntrack 计数器已开启（流量采集依赖 conntrack）',
    '        ensure_conntrack_acct',
    '        report_rule_status "$RID" true',
    '        log INFO "[apply] [rule=$RID] apply 成功，已上报 isRunning=true (forwardType=$FT port=$SP)"',
    '      else',
    '        if [ "$FT" = "realm" ] && [ -n "$SVC" ]; then',
    '          systemctl status "$SVC.service" --no-pager 2>&1 | head -20 || true',
    '          journalctl -u "$SVC.service" --no-pager -n 20 2>&1 || true',
    '        fi',
    '        if [ "$FT" = "socat" ] && [ -n "$SVC" ]; then',
    '          systemctl status "$SVC.service" --no-pager 2>&1 | head -20 || true',
    '        fi',
    '        if [ "$FT" = "iptables" ]; then',
    '          iptables -t nat -S PREROUTING 2>/dev/null | grep "--dport $SP" || true',
    '        fi',
    '        log ERROR "[apply] [rule=$RID] apply 失败 (forwardType=$FT port=$SP ALL_OK=$ALL_OK listen_check=failed)"',
    '      fi',
    '    else',
    '      report_rule_status "$RID" false',
    '      log INFO "[apply] [rule=$RID] remove 完成，已上报 isRunning=false (forwardType=$FT port=$SP)"',
    '    fi',
    '  done',
    '}',
    '',
    'collect_traffic() {',
    '  # 采集流量：遍历所有已注册的端口，使用 iptables mangle 计数链读取累计值，计算增量后上报',
    '  ensure_conntrack_acct',
    '  # 遍历所有 port_*.rule 状态文件，确定需要采集的端口',
    '  PORTS=$(ls "$STATE_DIR"/port_*.rule 2>/dev/null | sed "s|.*/port_||;s|\.rule||" | sort -n)',
    '  PORT_COUNT=$(echo "$PORTS" | grep -c "[0-9]" 2>/dev/null || echo 0)',
    '  log DEBUG "[traffic] 开始采集流量 (iptables mangle + conntrack)，监控 $PORT_COUNT 个端口"',
    '  if [ "$PORT_COUNT" -eq 0 ] 2>/dev/null; then',
    '    log DEBUG "[traffic] 无监控端口，跳过采集"',
    '    return',
    '  fi',
    '  STATS_JSON="[]"',
    '  for PORT in $PORTS; do',
    '    RID_FILE="$STATE_DIR/port_${PORT}.rule"',
    '    [ -f "$RID_FILE" ] || continue',
    '    RID=$(cat "$RID_FILE")',
    '    # 读取转发类型',
    '    FWT_FILE="$STATE_DIR/port_${PORT}.fwtype"',
    '    FWT=""',
    '    if [ -f "$FWT_FILE" ]; then FWT=$(cat "$FWT_FILE" 2>/dev/null); fi',
    '    # 采集 iptables mangle 计数链累计值（内核级别精确计数）',
    '    IPT_SAMPLE=$(sample_iptables_counters "$PORT")',
    '    IPT_IN=$(echo "$IPT_SAMPLE" | awk \'{print $1+0}\')',
    '    IPT_OUT=$(echo "$IPT_SAMPLE" | awk \'{print $2+0}\')',
    '    # 采集 conntrack 累计值（用于连接数统计及非 iptables 转发方式的补充）',
    '    CT_SAMPLE=$(sample_conntrack "$PORT")',
    '    CT_IN=$(echo "$CT_SAMPLE" | awk \'{print $1+0}\')',
    '    CT_OUT=$(echo "$CT_SAMPLE" | awk \'{print $2+0}\')',
    '    CT_CONNS=$(echo "$CT_SAMPLE" | awk \'{print $3+0}\')',
    '    # iptables 转发方式：直接使用 iptables mangle 计数链数据（官方接口，最准确）',
    '    # 其他转发方式（realm/socat/gost）：取 iptables 和 conntrack 两源较大值',
    '    if [ "$FWT" = "iptables" ]; then',
    '      CUR_IN=$IPT_IN',
    '      CUR_OUT=$IPT_OUT',
    '    else',
    '      if [ "$IPT_IN" -ge "$CT_IN" ] 2>/dev/null; then CUR_IN=$IPT_IN; else CUR_IN=$CT_IN; fi',
    '      if [ "$IPT_OUT" -ge "$CT_OUT" ] 2>/dev/null; then CUR_OUT=$IPT_OUT; else CUR_OUT=$CT_OUT; fi',
    '    fi',
    '    CUR_CONNS=$CT_CONNS',
    '    # 读取上次累计值',
    '    PREV_FILE="$STATE_DIR/traffic_${PORT}.prev"',
    '    PREV_IN=0; PREV_OUT=0; PREV_CONNS=0',
    '    if [ -f "$PREV_FILE" ]; then',
    '      PREV_IN=$(awk \'NR==1\' "$PREV_FILE" 2>/dev/null || echo 0)',
    '      PREV_OUT=$(awk \'NR==2\' "$PREV_FILE" 2>/dev/null || echo 0)',
    '      PREV_CONNS=$(awk \'NR==3\' "$PREV_FILE" 2>/dev/null || echo 0)',
    '    fi',
    '    # 保存当前累计值供下次使用',
    '    echo -e "${CUR_IN}\\n${CUR_OUT}\\n${CUR_CONNS}" > "$PREV_FILE"',
    '    # 计算增量（如果当前值 < 上次，说明计数器被重置，用当前值作为增量）',
    '    if [ "$CUR_IN" -ge "$PREV_IN" ] 2>/dev/null; then',
    '      DELTA_IN=$((CUR_IN - PREV_IN))',
    '    else',
    '      DELTA_IN=$CUR_IN',
    '    fi',
    '    if [ "$CUR_OUT" -ge "$PREV_OUT" ] 2>/dev/null; then',
    '      DELTA_OUT=$((CUR_OUT - PREV_OUT))',
    '    else',
    '      DELTA_OUT=$CUR_OUT',
    '    fi',
    '    if [ "$CUR_CONNS" -ge "$PREV_CONNS" ] 2>/dev/null; then',
    '      DELTA_CONNS=$((CUR_CONNS - PREV_CONNS))',
    '    else',
    '      DELTA_CONNS=$CUR_CONNS',
    '    fi',
    '    log DEBUG "[traffic] port=$PORT ruleId=$RID: cumulative IN=$CUR_IN OUT=$CUR_OUT conns=$CUR_CONNS | delta IN=$DELTA_IN OUT=$DELTA_OUT conns=$DELTA_CONNS"',
    '    # 只有有增量时才上报',
    '    if [ "$DELTA_IN" -gt 0 ] 2>/dev/null || [ "$DELTA_OUT" -gt 0 ] 2>/dev/null || [ "$DELTA_CONNS" -gt 0 ] 2>/dev/null; then',
    '      STATS_JSON=$(echo "$STATS_JSON" | jq --argjson rid "$RID" --argjson bi "${DELTA_IN:-0}" --argjson bo "${DELTA_OUT:-0}" --argjson c "${DELTA_CONNS:-0}" \'. + [{ruleId:$rid,bytesIn:$bi,bytesOut:$bo,connections:$c}]\')',
    '    fi',
    '  done',
    '  if [ "$STATS_JSON" != "[]" ]; then',
    '    log INFO "[traffic] 上报流量数据: $STATS_JSON"',
    '    TRAFFIC_RESP=$(agent_post "/api/agent/traffic" "{\\"stats\\":$STATS_JSON}" 2>&1)',
    '    log DEBUG "[traffic] 上报响应: $TRAFFIC_RESP"',
    '  else',
    '    log DEBUG "[traffic] \u65e0\u6d41\u91cf\u589e\u91cf\uff0c\u8df3\u8fc7\u4e0a\u62a5"',
    '  fi',
    '}',
    '',
    '# TCPing \u5ef6\u8fdf\u91c7\u96c6\uff1a\u5bf9\u6240\u6709\u8fd0\u884c\u4e2d\u7684\u89c4\u5219\u7684\u76ee\u6807 IP:Port \u6267\u884c TCP \u8fde\u63a5\u5ef6\u8fdf\u68c0\u6d4b',
    'collect_tcping() {',
    '  PORTS=$(ls "$STATE_DIR"/port_*.rule 2>/dev/null | sed "s|.*/port_||;s|\\.rule||" | sort -n)',
    '  PORT_COUNT=$(echo "$PORTS" | grep -c "[0-9]" 2>/dev/null || echo 0)',
    '  if [ "$PORT_COUNT" -eq 0 ] 2>/dev/null; then',
    '    return',
    '  fi',
    '  TCPING_JSON="[]"',
    '  for PORT in $PORTS; do',
    '    RID_FILE="$STATE_DIR/port_${PORT}.rule"',
    '    [ -f "$RID_FILE" ] || continue',
    '    RID=$(cat "$RID_FILE")',
    '    # \u8bfb\u53d6\u89c4\u5219\u5bf9\u5e94\u7684\u76ee\u6807 IP \u548c\u7aef\u53e3\uff08\u4ece runningRules \u7f13\u5b58\u6587\u4ef6\u4e2d\u83b7\u53d6\uff09',
    '    TARGET_FILE="$STATE_DIR/target_${PORT}.info"',
    '    if [ ! -f "$TARGET_FILE" ]; then',
    '      # \u65e0\u76ee\u6807\u4fe1\u606f\uff0c\u8df3\u8fc7',
    '      continue',
    '    fi',
    '    TIP=$(awk "NR==1" "$TARGET_FILE" 2>/dev/null)',
    '    TPT=$(awk "NR==2" "$TARGET_FILE" 2>/dev/null)',
    '    if [ -z "$TIP" ] || [ -z "$TPT" ]; then continue; fi',
    '    # \u6267\u884c TCP \u5ef6\u8fdf\u68c0\u6d4b',
    '    LAT=$(tcp_latency "$TIP" "$TPT")',
    '    RC=$?',
    '    if [ $RC -eq 0 ] && [ "${LAT:-0}" -gt 0 ] 2>/dev/null; then',
    '      TCPING_JSON=$(echo "$TCPING_JSON" | jq --argjson rid "$RID" --argjson lat "$LAT" \'. + [{ruleId:$rid,latencyMs:$lat,isTimeout:false}]\')',
    '      log DEBUG "[tcping] rule=$RID target=$TIP:$TPT latency=${LAT}ms"',
    '    else',
    '      TCPING_JSON=$(echo "$TCPING_JSON" | jq --argjson rid "$RID" \'. + [{ruleId:$rid,latencyMs:0,isTimeout:true}]\')',
    '      log DEBUG "[tcping] rule=$RID target=$TIP:$TPT TIMEOUT"',
    '    fi',
    '  done',
    '  if [ "$TCPING_JSON" != "[]" ]; then',
    '    log INFO "[tcping] \u4e0a\u62a5 TCPing \u6570\u636e: $TCPING_JSON"',
    '    agent_post "/api/agent/tcping" "{\\"results\\":$TCPING_JSON}" >/dev/null 2>&1',
    '  fi',
    '}',
    '',
    'report_status() {',
    '  CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk \'{print int($2)}\' 2>/dev/null || echo "0")',
    '  MEM_INFO=$(free | grep Mem)',
    '  MEM_TOTAL=$(echo $MEM_INFO | awk \'{print $2}\')',
    '  MEM_USED=$(echo $MEM_INFO | awk \'{print $3}\')',
    '  MEM_USAGE=$((MEM_USED * 100 / MEM_TOTAL))',
    '  NET_RX=$(cat /proc/net/dev | grep -v lo | tail -n+3 | awk \'{rx+=$2} END {print rx}\' 2>/dev/null || echo "0")',
    '  NET_TX=$(cat /proc/net/dev | grep -v lo | tail -n+3 | awk \'{tx+=$10} END {print tx}\' 2>/dev/null || echo "0")',
    '  DISK_USAGE=$(df / | tail -1 | awk \'{print int($5)}\' 2>/dev/null || echo "0")',
    '  SYS_UPTIME=$(cat /proc/uptime | awk \'{print int($1)}\' 2>/dev/null || echo "0")',
    '',
    '  PAYLOAD=$(jq -n \\',
    '    --arg cpu "$CPU_USAGE" \\',
    '    --arg memUsage "$MEM_USAGE" \\',
    '    --arg memUsed "$((MEM_USED * 1024))" \\',
    '    --arg netIn "$NET_RX" \\',
    '    --arg netOut "$NET_TX" \\',
    '    --arg disk "$DISK_USAGE" \\',
    '    --arg uptime "$SYS_UPTIME" \\',
    "    '{cpuUsage: ($cpu|tonumber), memoryUsage: ($memUsage|tonumber), memoryUsed: ($memUsed|tonumber), networkIn: ($netIn|tonumber), networkOut: ($netOut|tonumber), diskUsage: ($disk|tonumber), uptime: ($uptime|tonumber)}')",
    '',
    '  log DEBUG "[heartbeat] 发送心跳请求: $PAYLOAD"',
    '  RESPONSE=$(agent_post "/api/agent/heartbeat" "$PAYLOAD" 2>/dev/null)',
    '',
    '  if [ -n "$RESPONSE" ]; then',
    '    log INFO "[heartbeat] 收到响应 (${#RESPONSE} bytes)"',
    '    # 记录响应中的 actions 和 runningRules 概要',
    '    local A_CNT=$(echo "$RESPONSE" | jq \'(.actions // []) | length\' 2>/dev/null || echo 0)',
    '    local R_CNT=$(echo "$RESPONSE" | jq \'(.runningRules // []) | length\' 2>/dev/null || echo 0)',
    '    local S_CNT=$(echo "$RESPONSE" | jq \'(.selfTests // []) | length\' 2>/dev/null || echo 0)',
    '    log INFO "[heartbeat] 响应概要: actions=$A_CNT runningRules=$R_CNT selfTests=$S_CNT"',
    '    log DEBUG "[heartbeat] 完整响应: $RESPONSE"',
    '    apply_actions "$RESPONSE"',
    '',
    '    # 从 actions 中更新 port -> ruleId 映射',
    '    AC=$(echo "$RESPONSE" | jq \'(.actions // []) | length\' 2>/dev/null || echo 0)',
    '    if [ "$AC" -gt 0 ] 2>/dev/null; then',
    '      for i in $(seq 0 $((AC - 1))); do',
    '        RID=$(echo "$RESPONSE" | jq -r ".actions[$i].ruleId")',
    '        SP=$(echo "$RESPONSE" | jq -r ".actions[$i].sourcePort")',
    '        OP=$(echo "$RESPONSE" | jq -r ".actions[$i].op")',
    '        A_TIP=$(echo "$RESPONSE" | jq -r ".actions[$i].targetIp // empty")',
    '        A_TPT=$(echo "$RESPONSE" | jq -r ".actions[$i].targetPort // empty")',
    '        A_FT=$(echo "$RESPONSE" | jq -r ".actions[$i].forwardType // empty")',
    '        if [ "$OP" = "apply" ]; then',
    '          echo "$RID" > "$STATE_DIR/port_${SP}.rule"',
    '          echo -e "${A_TIP}\\n${A_TPT}" > "$STATE_DIR/target_${SP}.info"',
    '          echo "$A_FT" > "$STATE_DIR/port_${SP}.fwtype"',
    '        else',
    '          rm -f "$STATE_DIR/port_${SP}.rule"',
    '          rm -f "$STATE_DIR/target_${SP}.info"',
    '          rm -f "$STATE_DIR/port_${SP}.fwtype"',
    '        fi',
    '      done',
    '    fi',
    '',
    '    # 从 runningRules 中重建所有映射（确保 agent 重启后映射文件不丢失）',
    '    RC=$(echo "$RESPONSE" | jq \'(.runningRules // []) | length\' 2>/dev/null || echo 0)',
    '    if [ "$RC" -gt 0 ] 2>/dev/null; then',
    '      log DEBUG "[runningRules] 重建 $RC 条规则的映射和计数链"',
    '      for i in $(seq 0 $((RC - 1))); do',
    '        RID=$(echo "$RESPONSE" | jq -r ".runningRules[$i].ruleId")',
    '        SP=$(echo "$RESPONSE" | jq -r ".runningRules[$i].sourcePort")',
    '        TIP=$(echo "$RESPONSE" | jq -r ".runningRules[$i].targetIp // empty")',
    '        TPT=$(echo "$RESPONSE" | jq -r ".runningRules[$i].targetPort // empty")',
    '        PR=$(echo "$RESPONSE" | jq -r ".runningRules[$i].protocol // empty")',
    '        R_FT=$(echo "$RESPONSE" | jq -r ".runningRules[$i].forwardType // empty")',
    '        echo "$RID" > "$STATE_DIR/port_${SP}.rule"',
    '        # 保存目标信息供 TCPing 采集使用',
    '        echo -e "${TIP}\\n${TPT}" > "$STATE_DIR/target_${SP}.info"',
    '        echo "$R_FT" > "$STATE_DIR/port_${SP}.fwtype"',
    '        log DEBUG "[runningRules] rule[$i]: ruleId=$RID port=$SP target=$TIP:$TPT proto=$PR fwType=$R_FT"',
    '      done',
    '    fi',
    '',
    '    # 执行转发自测',
    '    run_selftests "$RESPONSE"',
    '  else',
    '    log WARN "[heartbeat] 心跳无响应，面板可能不可达: $PANEL_URL"',
    '  fi',
    '  collect_traffic',
    '  collect_tcping',
    '}',
    '',
    'log INFO "========================================"',
    'log INFO "  ForwardX Agent 已启动"',
    'log INFO "  面板地址: $PANEL_URL"',
    'log INFO "  心跳间隔: ${HEARTBEAT_INTERVAL}s"',
    'log INFO "  日志目录: $LOG_DIR"',
    'log INFO "  状态目录: $STATE_DIR"',
    'log INFO "========================================"',
    '',
    '# 主循环：心跳 30s，期间每 3s 轮询一次软任务下发（转发自测等）',
    'pull_selftests_once() {',
    '  RESPONSE=$(agent_post "/api/agent/selftest-pull" "{}" 2>/dev/null)',
    '  if [ -n "$RESPONSE" ]; then run_selftests "$RESPONSE"; fi',
    '}',
    '',
    'LAST_HEARTBEAT=0',
    'while true; do',
    '  NOW=$(date +%s)',
    '  if [ $((NOW - LAST_HEARTBEAT)) -ge $HEARTBEAT_INTERVAL ]; then',
    '    report_status',
    '    LAST_HEARTBEAT=$NOW',
    '  fi',
    '  pull_selftests_once',
    '  sleep $SELFTEST_POLL_INTERVAL',
    'done',
    'AGENT_EOF',
    '',
    'sed -i "s|__PANEL_URL__|$PANEL_URL|g" "$INSTALL_DIR/agent.sh"',
    'sed -i "s|__AGENT_TOKEN__|$AGENT_TOKEN|g" "$INSTALL_DIR/agent.sh"',
    'chmod +x "$INSTALL_DIR/agent.sh"',
    '',
    'echo "[步骤 4/6] 安装 Go Agent 程序..."',
    'CONFIG_DIR="/etc/forwardx-agent"',
    'GO_AGENT_BIN="/usr/local/bin/forwardx-agent"',
    `AGENT_VERSION="${AGENT_VERSION}"`,
    'mkdir -p "$CONFIG_DIR"',
    'cat > "$CONFIG_DIR/config.json" << EOF',
    '{',
    '  "panelUrl": "$PANEL_URL",',
    '  "token": "$AGENT_TOKEN",',
    '  "interval": 30',
    '}',
    'EOF',
    'install_go_agent() {',
    '  ARCH=$(uname -m)',
    '  case "$ARCH" in',
    '    x86_64|amd64) GO_ARCH="amd64" ;;',
    '    aarch64|arm64) GO_ARCH="arm64" ;;',
    '    *) GO_ARCH="" ;;',
    '  esac',
    '  if [ -n "$GO_ARCH" ]; then',
    '    URL="https://github.com/poouo/Forwardx/releases/download/v${AGENT_VERSION}/forwardx-agent-linux-${GO_ARCH}"',
    '    if curl -fsSL --max-time 30 "$URL" -o "$GO_AGENT_BIN.tmp" 2>/dev/null && [ -s "$GO_AGENT_BIN.tmp" ]; then',
    '      install -m 0755 "$GO_AGENT_BIN.tmp" "$GO_AGENT_BIN"',
    '      rm -f "$GO_AGENT_BIN.tmp"',
    '      echo "[信息] Go Agent 二进制下载完成: $URL"',
    '      return 0',
    '    fi',
    '    rm -f "$GO_AGENT_BIN.tmp"',
    '  fi',
    '  echo "[信息] 未找到预编译 Go Agent，尝试从源码构建..."',
    '  if ! command -v go >/dev/null 2>&1; then',
    '    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq golang-go >/dev/null 2>&1 || true; fi',
    '    if command -v dnf >/dev/null 2>&1; then dnf install -y -q golang >/dev/null 2>&1 || true; fi',
    '    if command -v yum >/dev/null 2>&1; then yum install -y -q golang >/dev/null 2>&1 || true; fi',
    '    if command -v apk >/dev/null 2>&1; then apk add --no-cache go >/dev/null 2>&1 || true; fi',
    '  fi',
    '  if command -v go >/dev/null 2>&1; then',
    '    GOBIN=/tmp/forwardx-agent-build go install -ldflags "-X main.Version=${AGENT_VERSION}" "github.com/poouo/Forwardx/agent@v${AGENT_VERSION}" && \\',
    '      install -m 0755 /tmp/forwardx-agent-build/agent "$GO_AGENT_BIN" && rm -rf /tmp/forwardx-agent-build && return 0',
    '  fi',
    '  echo "[警告] Go Agent 安装失败，将回退使用 Shell Agent"',
    '  return 1',
    '}',
    'USE_GO_AGENT=0',
    'if install_go_agent; then USE_GO_AGENT=1; fi',
    '',
    'echo "[步骤 5/6] 配置系统服务..."',
    'cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF',
    '[Unit]',
    'Description=ForwardX Agent',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/bash $INSTALL_DIR/agent.sh',
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'if [ "$USE_GO_AGENT" = "1" ]; then',
    '  sed -i "s|ExecStart=.*|ExecStart=$GO_AGENT_BIN -config $CONFIG_DIR/config.json|" "/etc/systemd/system/$SERVICE_NAME.service"',
    'fi',
    '',
    'systemctl daemon-reload',
    'systemctl enable "$SERVICE_NAME"',
    'systemctl start "$SERVICE_NAME"',
    '',
    'echo "[步骤 6/6] 注册到面板..."',
    'REGISTER_PAYLOAD=$(jq -n \\',
    '  --arg token "$AGENT_TOKEN" \\',
    '  --arg ip "$PUBLIC_IP" \\',
    '  --arg os "$OS_INFO" \\',
    '  --arg cpu "$CPU_INFO" \\',
    '  --arg mem "$MEM_TOTAL_BYTES" \\',
    '  --arg agentVersion "$AGENT_VERSION" \\',
    "  '{token: $token, ip: $ip, osInfo: $os, cpuInfo: $cpu, memoryTotal: ($mem|tonumber), agentVersion: $agentVersion}')",
    '',
    '# 注册接口必须使用加密会话，不提供明文回退',
    'register_with_panel() {',
    '  if ! command -v openssl >/dev/null 2>&1 || ! command -v xxd >/dev/null 2>&1; then',
    '    echo "[错误] openssl/xxd 不可用，无法以加密模式注册。请先安装依赖。"',
    '    exit 1',
    '  fi',
    '  KEY_ENC_HEX=$(printf "%s|forwardx-agent-v1" "$AGENT_TOKEN" | openssl dgst -sha256 -hex 2>/dev/null | awk \'{print $NF}\')',
    '  KEY_MAC_HEX=$(printf "%s|forwardx-agent-mac" "$AGENT_TOKEN" | openssl dgst -sha256 -hex 2>/dev/null | awk \'{print $NF}\')',
    '  IV_HEX=$(openssl rand -hex 16)',
    '  CT_HEX=$(printf "%s" "$REGISTER_PAYLOAD" | openssl enc -aes-256-ctr -K "$KEY_ENC_HEX" -iv "$IV_HEX" 2>/dev/null | xxd -p -c 99999 | tr -d "\n")',
    '  TS_MS=$(($(date +%s%N) / 1000000))',
    '  TS_HEX=$(printf "%016x" "$TS_MS")',
    '  MAC_HEX=$(printf "7631%s%s%s" "$IV_HEX" "$CT_HEX" "$TS_HEX" | xxd -r -p | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY_MAC_HEX" 2>/dev/null | awk \'{print $NF}\')',
    '  ENV_JSON=$(printf \'{"v":1,"iv":"%s","ct":"%s","mac":"%s","ts":%s}\' "$IV_HEX" "$CT_HEX" "$MAC_HEX" "$TS_MS")',
    '  if [ -z "$ENV_JSON" ]; then',
    '    echo "[错误] 注册加密信封生成失败"',
    '    exit 1',
    '  fi',
    '  curl -s --max-time 10 -X POST "$PANEL_URL/api/agent/register" \\',
    '    -H "Content-Type: application/json" \\',
    '    -H "Authorization: Bearer $AGENT_TOKEN" \\',
    '    -H "X-Agent-Encrypted: 1" \\',
    '    -d "$ENV_JSON"',
    '}',
    'register_with_panel',
    '',
    'echo ""',
    'echo "======================================"',
    'echo "  ForwardX Agent 安装完成!"',
    'echo "======================================"',
    'echo "  安装目录: $INSTALL_DIR"',
    'echo "  服务名称: $SERVICE_NAME"',
    'echo "  查看状态: systemctl status $SERVICE_NAME"',
    'echo "  查看日志: journalctl -u $SERVICE_NAME -f"',
    'echo "  日志文件: /var/log/forwardx-agent/agent-$(date +%Y-%m-%d).log"',
    'echo "  卸载命令: curl -sL $PANEL_URL/api/agent/install.sh | bash -s -- uninstall"',
    'echo "======================================"',
  ];
  return lines.join('\n') + '\n';
}

/** 计算当前会话可用的 panel URL：优先使用管理员在设置中配置的 panelPublicUrl */
async function resolvePanelUrl(req: Request): Promise<string> {
  const configured = (await db.getSetting("panelPublicUrl")) || "";
  if (configured && /^https?:\/\//.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  // 回退到请求中的 host
  return `${req.protocol}://${req.get("host")}`;
}

// 安装/卸载引导脚本
export function pushAgentUpgrade(hostId: number, targetVersion: string | null, panelUrl: string) {
  return sendAgentEvent(hostId, "agent-upgrade", {
    targetVersion: targetVersion || AGENT_VERSION,
    panelUrl,
  });
}

agentRouter.get("/api/agent/install.sh", async (req: Request, res: Response) => {
  const panelUrl = await resolvePanelUrl(req);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateInstallScript(panelUrl));
});

// 完整安装脚本（由 Agent 引导脚本调用）
agentRouter.get("/api/agent/full-install.sh", async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send("echo '[错误] 缺少 Token 参数'");
    return;
  }

  const panelUrl = await resolvePanelUrl(req);

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(generateFullInstallScript(panelUrl, token));
});

export { agentRouter };

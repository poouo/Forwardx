import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import crypto from "crypto";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { pushTunnelEndpointRefresh, requireHostAccess } from "./helpers";
import { requireTunnelProtocolEnabled } from "../forwardProtocolSettings";
import * as hopRepo from "../repositories/tunnelRepository";
import { createTunnelHopBatch, registerTunnelHopTest } from "../tunnelHopTestState";
import { clearTunnelRuntimeStatus } from "../tunnelRuntimeStatus";
import { getTunnelAutoHopAggregate } from "../tunnelAutoLatencyState";
import { createQueryCache } from "../queryCache";
import { isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { structuredLinkTestMessage } from "../linkTestMessages";
import { isValidHostOrIp } from "../networkAddress";

const tunnelNetworkTypeSchema = z.enum(["public", "private"]);
const tunnelModeSchema = z.enum(["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream", "nginx_tls"]);
const tunnelLoadBalanceStrategySchema = z.enum(["round_robin", "random", "least_conn", "ip_hash", "fallback"]);
const MAX_TUNNEL_HOPS = 10;
const MAX_EXTRA_TUNNEL_EXITS = 4;
const MAX_NGINX_CERT_BYTES = 64 * 1024;
const tunnelQueryCache = createQueryCache(300);

function normalizeTunnelMode(mode: unknown) {
  const value = String(mode || "").trim().toLowerCase();
  return value === "nginx_tls" ? "nginx_stream" : value;
}

function normalizeCertDomain(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length > 253 || /[\s'"<>]/.test(text)) throw new Error("证书域名格式无效");
  return text;
}

function normalizePem(value: unknown, label: string) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_NGINX_CERT_BYTES) {
    throw new Error(`${label}不能超过 64KB`);
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeNginxCertInput(input: { certPem?: unknown; certKeyPem?: unknown }, enabled: boolean) {
  if (!enabled) return { certPem: null, certKeyPem: null };
  const certPem = normalizePem(input.certPem, "Nginx 证书");
  const certKeyPem = normalizePem(input.certKeyPem, "Nginx 私钥");
  if ((certPem && !certKeyPem) || (!certPem && certKeyPem)) {
    throw new Error("Nginx 自定义证书和私钥需要同时填写");
  }
  return { certPem, certKeyPem };
}

async function refreshTunnelRuntimeHosts(tunnelId: number, hostIds: number[], reason: string) {
  clearTunnelRuntimeStatus(tunnelId);
  const uniqueHostIds = Array.from(new Set(hostIds.map((hostId) => Number(hostId)).filter((hostId) => Number.isFinite(hostId) && hostId > 0)));
  for (const hostId of uniqueHostIds) {
    pushAgentRefresh(hostId, reason);
  }
  appendPanelLog("info", `[Tunnel] refresh runtime tunnel=${tunnelId} reason=${reason} hosts=${uniqueHostIds.join(",") || "-"}`);
}

const normalizeTunnelConnect = (connectHost?: string | null) => {
  const host = String(connectHost || "").trim();
  if (!host) return null;
  if (!isValidHostOrIp(host)) throw new Error("指定出口地址无效，请输入有效的 IP 或域名");
  return host;
};

function normalizeTunnelConnectForEndpoint(connectHost: string | null | undefined, networkType: "public" | "private" | undefined, host: any) {
  const normalized = normalizeTunnelConnect(connectHost);
  if (normalized) return normalized;
  if (networkType === "private") {
    const privateAddr = getHostPrivateAddress(host);
    if (!privateAddr) throw new Error("出口 Agent 未配置内网IP，无法使用内网 IP 连接");
    return privateAddr;
  }
  return null;
}

const normalizeHopConnectHostsForCompare = (hops: Array<any>) =>
  hops.map((hop, idx) => {
    if (idx === 0) return null;
    const value = typeof hop === "string" || hop === null
      ? hop
      : (hop as any)?.connectHost;
    const text = String(value || "").trim();
    return text || null;
  });

const getTunnelDialHost = (tunnel: any, exit: any) => {
  const connectHost = String(tunnel?.connectHost || "").trim();
  if (connectHost) return connectHost;
  return getHostPublicAddress(exit);
};

const getHostPublicAddress = (host: any) =>
  String((host as any)?.entryIp || (host as any)?.ipv4 || (host as any)?.ipv6 || host?.ip || "").trim();

const getHostIpv6Address = (host: any) =>
  String((host as any)?.ipv6 || "").trim();

function getHostPrivateAddress(host: any) {
  return String((host as any)?.tunnelEntryIp || "").trim();
}

const tunnelLoadBalanceExitSchema = z.object({
  hostId: z.number(),
  connectHost: z.string().max(128).nullable().optional(),
});

function normalizeTunnelLoadBalanceStrategy(value: unknown) {
  const parsed = tunnelLoadBalanceStrategySchema.safeParse(value);
  return parsed.success ? parsed.data : "round_robin";
}

async function requireEntryGroupAccess(ctx: any, entryGroupId: number | null | undefined) {
  const id = Number(entryGroupId || 0);
  if (!id) return null;
  const group = await db.getForwardGroupById(id) as any;
  if (!group || String(group.groupMode || "failover") !== "entry") throw new Error("入口组不存在或类型不正确");
  if (ctx.user.role !== "admin" && Number(group.userId) !== Number(ctx.user.id)) throw new Error("无权使用此入口组");
  return group;
}

async function getTunnelEntryTestHostIds(tunnel: any) {
  const ids: number[] = [];
  const pushId = (value: unknown) => {
    const id = Number(value || 0);
    if (!Number.isFinite(id) || id <= 0 || ids.includes(id)) return;
    ids.push(id);
  };
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const group = await db.getForwardGroupById(entryGroupId) as any;
    if (group && group.isEnabled && String(group.groupMode || "") === "entry") {
      const members = [...(group.members || [])]
        .filter((member: any) => member && member.isEnabled !== false && member.memberType === "host")
        .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));
      for (const member of members) pushId(member.hostId);
    }
  }
  if (ids.length === 0) pushId(tunnel?.entryHostId);
  return ids;
}
function normalizeHopConnectForHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = getHostPublicAddress(host);
  const privateAddr = getHostPrivateAddress(host);
  const ipv6Addr = getHostIpv6Address(host);
  if (!raw) return publicAddr || null;
  const normalized = normalizeTunnelConnect(raw);
  if (privateAddr && normalized === privateAddr) return privateAddr;
  if (ipv6Addr && normalized === ipv6Addr) return ipv6Addr;
  if (publicAddr && normalized === publicAddr) return publicAddr;
  if (!privateAddr && !ipv6Addr) return publicAddr || null;
  throw new Error(`主机 ${host?.name || host?.id || ""} 的连接地址只能使用入口地址、已配置的内网IP或IPv6地址`);
}

function normalizeOptionalConnectForHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  if (!raw) return null;
  const publicAddr = getHostPublicAddress(host);
  const privateAddr = getHostPrivateAddress(host);
  const ipv6Addr = getHostIpv6Address(host);
  const normalized = normalizeTunnelConnect(raw);
  if (privateAddr && normalized === privateAddr) return privateAddr;
  if (ipv6Addr && normalized === ipv6Addr) return ipv6Addr;
  if (publicAddr && normalized === publicAddr) return null;
  throw new Error(`主机 ${host?.name || host?.id || ""} 的连接地址只能使用入口地址、已配置的内网IP或IPv6地址`);
}

function isHostPrivateConnectHost(connectHost: string | null | undefined, host: any) {
  const privateAddr = getHostPrivateAddress(host);
  return !!privateAddr && String(connectHost || "").trim() === privateAddr;
}

async function normalizeHopConnectHostsForHosts(hopHostIds: number[], hopConnectHosts: Array<string | null>) {
  const next: Array<string | null> = [];
  for (let i = 0; i < hopHostIds.length; i++) {
    if (i === 0) {
      next.push(null);
      continue;
    }
    const hopHost = await db.getHostById(hopHostIds[i]) as any;
    next.push(normalizeHopConnectForHost(hopConnectHosts[i] ?? null, hopHost));
  }
  return next;
}

async function buildExtraExitNodes(ctx: any, options: {
  tunnelId?: number;
  primaryHostId: number;
  blockedHostIds?: number[];
  enabled: boolean;
  mode: string;
  exits?: Array<{ hostId: number; connectHost?: string | null }> | null;
  existingNodes?: any[];
  explicitListenPort?: number;
}) {
  if (!options.enabled) return [];
  const raw = Array.isArray(options.exits) ? options.exits : [];
  if (raw.length === 0) throw new Error("开启多出口负载后至少需要添加 1 个额外出口");
  if (raw.length > MAX_EXTRA_TUNNEL_EXITS) throw new Error(`多出口负载最多可额外添加 ${MAX_EXTRA_TUNNEL_EXITS} 个出口`);
  const seen = new Set<number>([
    Number(options.primaryHostId),
    ...(options.blockedHostIds || []).map((id) => Number(id || 0)),
  ].filter((id) => Number.isFinite(id) && id > 0));
  const existingByHost = new Map<number, any>();
  for (const node of options.existingNodes || []) {
    existingByHost.set(Number((node as any).hostId), node);
  }
  const nodes: { seq: number; hostId: number; listenPort: number; connectHost?: string | null; isEnabled: boolean }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const hostId = Number(raw[i]?.hostId || 0);
    if (!Number.isFinite(hostId) || hostId <= 0) throw new Error("请选择有效的额外出口 Agent");
    if (seen.has(hostId)) throw new Error("多出口负载中的出口 Agent 不能重复");
    seen.add(hostId);
    const host = await requireHostAccess(ctx, hostId);
    const connectHost = normalizeOptionalConnectForHost(raw[i]?.connectHost ?? null, host);
    const explicitListenPort = Number(options.explicitListenPort || 0);
    let listenPort = explicitListenPort > 0 ? explicitListenPort : Number(existingByHost.get(hostId)?.listenPort || 0);
    if (explicitListenPort > 0) {
      const policy = portPolicyFrom(host as any);
      if (!isPortAllowedByPolicy(explicitListenPort, policy)) {
        throw new Error(portPolicyErrorMessage(policy, `负载出口 ${host?.name || hostId} 监听端口`));
      }
      const used = await db.isPortUsedOnHost(hostId, explicitListenPort);
      if (used) throw new Error(`负载出口 ${host?.name || hostId} 端口 ${explicitListenPort} 已被转发规则占用`);
      const tunnelUsed = await db.isTunnelListenPortUsed(hostId, explicitListenPort, options.tunnelId);
      if (tunnelUsed) throw new Error(`负载出口 ${host?.name || hostId} 端口 ${explicitListenPort} 已被其他隧道占用`);
    }
    if (!listenPort) {
      listenPort = await db.findAvailableTunnelExitPort(hostId, (host as any)?.portRangeStart, (host as any)?.portRangeEnd) ?? 0;
      if (!listenPort) throw new Error(`出口 Agent ${host?.name || hostId} 已无可用隧道端口`);
    }
    nodes.push({
      seq: i + 1,
      hostId,
      listenPort,
      connectHost,
      isEnabled: true,
    });
  }
  return nodes;
}

async function attachTunnelEndpointHosts(tunnels: any[]) {
  const hostMap = new Map<number, any>();
  const hopHostIdsByTunnel = new Map<number, number[]>();
  const hopConnectHostsByTunnel = new Map<number, Array<string | null>>();
  const extraExitNodesByTunnel = new Map<number, any[]>();
  const hostIds = new Set<number>();
  for (const tunnel of tunnels) {
    const entryHostId = Number(tunnel.entryHostId || 0);
    const exitHostId = Number(tunnel.exitHostId || 0);
    if (entryHostId > 0) hostIds.add(entryHostId);
    if (exitHostId > 0) hostIds.add(exitHostId);
  }
  await Promise.all(tunnels.map(async (tunnel) => {
    const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
    const hopIds = (hops || []).map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0);
    if (hopIds.length >= 2) {
      hopHostIdsByTunnel.set(Number(tunnel.id), hopIds);
      for (const hostId of hopIds) hostIds.add(hostId);
    }
    const hopConnectHosts = (hops || []).map((hop: any) => {
      const value = String((hop as any).connectHost || "").trim();
      return value ? value : null;
    });
    if (hopConnectHosts.length >= 2) hopConnectHostsByTunnel.set(Number(tunnel.id), hopConnectHosts);
    const extraExitNodes = await hopRepo.getTunnelExitNodes(Number(tunnel.id));
    const normalizedExtraExitNodes = (extraExitNodes || [])
      .map((node: any) => ({
        id: Number(node.id),
        seq: Number(node.seq),
        hostId: Number(node.hostId),
        listenPort: Number(node.listenPort),
        connectHost: String(node.connectHost || "").trim() || null,
        isEnabled: node.isEnabled !== false,
      }))
      .filter((node) => node.hostId > 0);
    if (normalizedExtraExitNodes.length > 0) {
      extraExitNodesByTunnel.set(Number(tunnel.id), normalizedExtraExitNodes);
      for (const node of normalizedExtraExitNodes) hostIds.add(Number(node.hostId));
    }
  }));
  await Promise.all(tunnels.map(async (tunnel) => {
    const hopIds = hopHostIdsByTunnel.get(Number(tunnel.id));
    if (!hopIds || hopIds.length < 3) return;
    const aggregate = getTunnelAutoHopAggregate(Number(tunnel.id), hopIds.length - 1);
    if (!aggregate) return;
    const currentLatency = typeof (tunnel as any).lastLatencyMs === "number" ? Number((tunnel as any).lastLatencyMs) : null;
    const nextLatency = aggregate.success ? aggregate.latencyMs : null;
    const shouldUpdate = currentLatency !== nextLatency;
    const shouldMarkRunning = aggregate.success && !(tunnel as any).isRunning;
    if (!shouldUpdate && !shouldMarkRunning) return;
    if (shouldUpdate) {
      await db.insertTunnelLatencyStat({
        tunnelId: Number(tunnel.id),
        latencyMs: aggregate.success ? aggregate.latencyMs : null,
        isTimeout: !aggregate.success,
      }, { preserveMessage: true });
      (tunnel as any).lastLatencyMs = aggregate.success ? aggregate.latencyMs : null;
    }
    if (shouldMarkRunning) {
      await db.updateTunnelRunningStatus(Number(tunnel.id), true);
      (tunnel as any).isRunning = true;
    }
  }));
  const latestLatencyByTunnel = await db.getLatestTunnelLatencies(tunnels.map((tunnel) => Number(tunnel.id)));
  await Promise.all(Array.from(hostIds).map(async (hostId) => {
    const host = await db.getHostById(hostId);
    if (host) hostMap.set(hostId, host);
  }));
  const hostSummary = (host: any) => host ? {
    id: host.id,
    name: host.name,
    ip: host.ip,
    ipv4: (host as any).ipv4,
    ipv6: (host as any).ipv6,
    entryIp: (host as any).entryIp,
    tunnelEntryIp: (host as any).tunnelEntryIp,
    ddnsEnabled: (host as any).ddnsEnabled,
    ddnsDomain: (host as any).ddnsDomain,
    lastDdnsValue: (host as any).lastDdnsValue,
    portRangeStart: (host as any).portRangeStart,
    portRangeEnd: (host as any).portRangeEnd,
    portAllowlist: (host as any).portAllowlist,
  } : null;
  return tunnels.map((tunnel) => {
    const latestLatency = latestLatencyByTunnel.get(Number(tunnel.id));
    const fallbackLatency = typeof (tunnel as any).lastLatencyMs === "number" && Number.isFinite((tunnel as any).lastLatencyMs)
      ? Number((tunnel as any).lastLatencyMs)
      : null;
    const fallbackTimeout = !latestLatency && (tunnel as any).lastTestStatus === "failed" && fallbackLatency === null;
    return {
      ...tunnel,
      latestLatencyMs: latestLatency
        ? (latestLatency.isTimeout ? null : latestLatency.latencyMs)
        : fallbackLatency,
      latestLatencyIsTimeout: latestLatency ? latestLatency.isTimeout : fallbackTimeout,
      latestLatencyAt: latestLatency?.recordedAt ?? (tunnel as any).lastTestAt ?? null,
      hopHostIds: hopHostIdsByTunnel.get(Number(tunnel.id)) || [],
      hopConnectHosts: hopConnectHostsByTunnel.get(Number(tunnel.id)) || [],
      hopHosts: (hopHostIdsByTunnel.get(Number(tunnel.id)) || [])
        .map((hostId) => hostSummary(hostMap.get(Number(hostId))))
        .filter(Boolean),
      loadBalanceExits: (extraExitNodesByTunnel.get(Number(tunnel.id)) || [])
        .map((node) => ({
          ...node,
          host: hostSummary(hostMap.get(Number(node.hostId))),
        })),
      entryHost: hostSummary(hostMap.get(Number(tunnel.entryHostId || 0))),
      exitHost: hostSummary(hostMap.get(Number(tunnel.exitHostId || 0))),
    };
  });
}

async function getTunnelDeleteImpact(tunnelId: number) {
  const rules = ((await db.getForwardRulesByTunnel(tunnelId)) as any[])
    .filter((rule) => !rule.pendingDelete);
  return {
    forwardRuleCount: rules.length,
    forwardRules: rules.slice(0, 8).map((rule) => ({
      id: Number(rule.id),
      name: String(rule.name || `规则 #${rule.id}`),
      sourcePort: Number(rule.sourcePort || 0),
      targetIp: String(rule.targetIp || ""),
      targetPort: Number(rule.targetPort || 0),
    })),
  };
}

export const tunnelsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const tunnels = isAdmin ? await db.getTunnels() : await db.getTunnelsForUser(ctx.user.id);
      return attachTunnelEndpointHosts(tunnels as any[]);
    }),
    listAll: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new Error("鏃犳潈璁块棶");
      return attachTunnelEndpointHosts(await db.getTunnels() as any[]);
    }),
    latencySeries: protectedProcedure
      .input(z.object({
        tunnelId: z.number(),
        hours: z.number().min(1).max(48).default(24),
      }))
      .query(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.tunnelId);
        if (!tunnel) throw new Error("Tunnel not found");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) {
          throw new Error("No permission to view this tunnel");
        }
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        return tunnelQueryCache.get(
          `latencySeries:${ctx.user.id}:${input.tunnelId}:${input.hours}`,
          { ttlMs: 5_000, staleMs: 0 },
          () => db.getTunnelLatencySeries(input.tunnelId, { since }),
        );
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        entryGroupId: z.number().nullable().optional(),
        entryHostId: z.number(),
        exitHostId: z.number(),
        mode: tunnelModeSchema.default("forwardx"),
        listenPort: z.number().min(0).max(65535).optional().default(0),
        rateLimitMbps: z.number().int().min(0).max(1_000_000).optional().default(0),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        certDomain: z.string().max(253).nullable().optional(),
        certPem: z.string().max(MAX_NGINX_CERT_BYTES).nullable().optional(),
        certKeyPem: z.string().max(MAX_NGINX_CERT_BYTES).nullable().optional(),
        networkType: tunnelNetworkTypeSchema.optional().default("public"),
        connectHost: z.string().max(128).nullable().optional(),
        blockHttp: z.boolean().optional().default(false),
        blockSocks: z.boolean().optional().default(false),
        blockTls: z.boolean().optional().default(false),
        loadBalanceEnabled: z.boolean().optional().default(false),
        loadBalanceStrategy: tunnelLoadBalanceStrategySchema.optional().default("round_robin"),
        loadBalanceExits: z.array(tunnelLoadBalanceExitSchema).max(MAX_EXTRA_TUNNEL_EXITS).optional(),
        hopHostIds: z.array(z.number()).optional(),
        hopConnectHosts: z.array(z.string().max(128).nullable()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const normalizedMode = normalizeTunnelMode(input.mode);
        const certDomain = normalizedMode === "nginx_stream" ? normalizeCertDomain((input as any).certDomain) : null;
        const nginxCert = normalizeNginxCertInput(input as any, normalizedMode === "nginx_stream");
        const hopHostIds = (input.hopHostIds && input.hopHostIds.length >= 3) ? input.hopHostIds : null;
        const hopConnectHosts = Array.isArray((input as any).hopConnectHosts) ? (input as any).hopConnectHosts as Array<string | null> : [];
        if (hopHostIds) {
          // Multi-hop tunnel: validate hosts
          if (hopHostIds.length > MAX_TUNNEL_HOPS) throw new Error(`多级隧道最多支持 ${MAX_TUNNEL_HOPS} 级`);
          if (new Set(hopHostIds).size !== hopHostIds.length) throw new Error("多级隧道中的主机不能重复");
          for (const hostId of hopHostIds) await requireHostAccess(ctx, hostId);
          if (input.listenPort !== 0) throw new Error("多级隧道端口由系统自动分配");
        } else {
          if (input.portRangeStart != null && input.portRangeEnd != null && input.portRangeStart > input.portRangeEnd) {
            throw new Error("隧道可用端口范围起始值不能大于结束值");
          }
          if (input.entryHostId === input.exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
          const entry = await requireHostAccess(ctx, input.entryHostId);
          const exit = await requireHostAccess(ctx, input.exitHostId);
          if (!entry || !exit) throw new Error("主机不存在");
        }
        await requireTunnelProtocolEnabled({ ...input, mode: normalizedMode });
        await requireEntryGroupAccess(ctx, input.entryGroupId);

        // Determine entry/exit host IDs
        const entryHostId = hopHostIds ? hopHostIds[0] : input.entryHostId;
        const exitHostId = hopHostIds ? hopHostIds[hopHostIds.length - 1] : input.exitHostId;

        const requestedListenPort = Number(input.listenPort) || 0;
        let listenPort = requestedListenPort;
        {
          const exit = await db.getHostById(exitHostId) as any;
          if (listenPort > 0) {
            const policy = portPolicyFrom(exit);
            if (!isPortAllowedByPolicy(listenPort, policy)) {
              throw new Error(portPolicyErrorMessage(policy, "出口监听端口"));
            }
            const used = await db.isPortUsedOnHost(exitHostId, listenPort);
            if (used) throw new Error(`出口 Agent 端口 ${listenPort} 已被转发规则占用`);
            const tunnelUsed = await db.isTunnelListenPortUsed(exitHostId, listenPort);
            if (tunnelUsed) throw new Error(`出口 Agent 端口 ${listenPort} 已被其他隧道占用`);
          } else {
            listenPort = await db.findAvailableTunnelExitPort(exitHostId, exit?.portRangeStart, exit?.portRangeEnd) ?? 0;
            if (!listenPort) throw new Error("出口 Agent 已无可用隧道端口");
          }
        }
        const secret = crypto.randomBytes(32).toString("hex");
        const exitHostForConnect = await db.getHostById(exitHostId) as any;
        const connectHost = hopHostIds
          ? normalizeTunnelConnect(input.connectHost)
          : normalizeTunnelConnectForEndpoint(input.connectHost, input.networkType, exitHostForConnect);
        const loadBalanceEnabled = !!input.loadBalanceEnabled;
        const loadBalanceStrategy = loadBalanceEnabled ? normalizeTunnelLoadBalanceStrategy(input.loadBalanceStrategy) : "round_robin";
        const extraExitNodes = await buildExtraExitNodes(ctx, {
          primaryHostId: exitHostId,
          blockedHostIds: hopHostIds || [entryHostId, exitHostId],
          enabled: loadBalanceEnabled,
          mode: normalizedMode,
          exits: input.loadBalanceExits || [],
          explicitListenPort: requestedListenPort > 0 ? requestedListenPort : 0,
        });
        const {
          hopHostIds: _ignoredHopHostIds,
          hopConnectHosts: _ignoredHopConnectHosts,
          loadBalanceExits: _ignoredLoadBalanceExits,
          blockHttp: _ignoredBlockHttp,
          blockSocks: _ignoredBlockSocks,
          blockTls: _ignoredBlockTls,
          ...tunnelInput
        } = input as any;
        const id = await db.createTunnel({
          ...tunnelInput,
          entryGroupId: input.entryGroupId ?? null,
          entryHostId,
          exitHostId,
          mode: normalizedMode,
          certDomain,
          certPem: nginxCert.certPem,
          certKeyPem: nginxCert.certKeyPem,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          networkType: isHostPrivateConnectHost(connectHost, exitHostForConnect) ? "private" : "public",
          connectHost,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          loadBalanceEnabled: loadBalanceEnabled && extraExitNodes.length > 0,
          loadBalanceStrategy: loadBalanceEnabled && extraExitNodes.length > 0 ? loadBalanceStrategy : "round_robin",
          listenPort,
          secret,
          userId: ctx.user.id,
        } as any);
        if (loadBalanceEnabled && extraExitNodes.length > 0) {
          await hopRepo.replaceTunnelExitNodes(id, extraExitNodes);
        }
        // Create hops for multi-hop tunnels
        if (hopHostIds) {
          const hops: { hostId: number; listenPort: number; connectHost?: string | null }[] = [];
          for (let i = 0; i < hopHostIds.length; i++) {
            let port = 0;
            if (i === hopHostIds.length - 1) {
              port = listenPort; // Last hop = exit listen port (auto-assigned above)
            } else {
              const host = await db.getHostById(hopHostIds[i]) as any;
              port = await db.findAvailableTunnelExitPort(hopHostIds[i], host?.portRangeStart, host?.portRangeEnd) ?? 0;
              if (!port) throw new Error(`主机 ${host?.name || hopHostIds[i]} 已无可用端口`);
            }
            const rawConnectHost = i > 0 ? (hopConnectHosts[i] ?? null) : null;
            const hopHost = await db.getHostById(hopHostIds[i]) as any;
            const normalizedHopConnectHost = i > 0 ? normalizeHopConnectForHost(rawConnectHost, hopHost) : null;
            hops.push({ hostId: hopHostIds[i], listenPort: port, connectHost: normalizedHopConnectHost });
          }
          await hopRepo.createTunnelHops(id, hops);
        }
        if (hopHostIds) {
          await refreshTunnelRuntimeHosts(id, [...hopHostIds, ...extraExitNodes.map((node) => node.hostId)], "tunnel-created");
        } else {
          await pushTunnelEndpointRefresh({ id, entryHostId: input.entryHostId, exitHostId: input.exitHostId }, "tunnel-created");
        }
        return { id, listenPort };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        entryGroupId: z.number().nullable().optional(),
        entryHostId: z.number().optional(),
        exitHostId: z.number().optional(),
        mode: tunnelModeSchema.optional(),
        listenPort: z.number().min(0).max(65535).optional(),
        rateLimitMbps: z.number().int().min(0).max(1_000_000).optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        certDomain: z.string().max(253).nullable().optional(),
        certPem: z.string().max(MAX_NGINX_CERT_BYTES).nullable().optional(),
        certKeyPem: z.string().max(MAX_NGINX_CERT_BYTES).nullable().optional(),
        networkType: tunnelNetworkTypeSchema.optional(),
        connectHost: z.string().max(128).nullable().optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
        loadBalanceEnabled: z.boolean().optional(),
        loadBalanceStrategy: tunnelLoadBalanceStrategySchema.optional(),
        loadBalanceExits: z.array(tunnelLoadBalanceExitSchema).max(MAX_EXTRA_TUNNEL_EXITS).optional(),
        isEnabled: z.boolean().optional(),
        hopHostIds: z.array(z.number()).optional(),
        hopConnectHosts: z.array(z.string().max(128).nullable()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        const existingHops = await hopRepo.getTunnelHops(input.id);
        const existingExtraExitNodes = await hopRepo.getTunnelExitNodes(input.id);
        const existingHopHostIds = (existingHops || []).map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0);
        const existingHopConnectHosts = normalizeHopConnectHostsForCompare(existingHops || []);
        const nextModeForRuntime = normalizeTunnelMode(input.mode ?? (tunnel as any).mode);
        await requireTunnelProtocolEnabled({ ...tunnel, mode: nextModeForRuntime });
        if ((input as any).entryGroupId !== undefined) await requireEntryGroupAccess(ctx, (input as any).entryGroupId);
        const requestedHopHostIds = Array.isArray((input as any).hopHostIds)
          ? ((input as any).hopHostIds as number[]).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
          : undefined;
        const hopConnectHostsProvided = Array.isArray((input as any).hopConnectHosts);
        const rawHopConnectHosts = hopConnectHostsProvided
          ? ((input as any).hopConnectHosts as Array<string | null>)
          : [];
        const hopHostIds = requestedHopHostIds && requestedHopHostIds.length >= 3 ? requestedHopHostIds : null;
        const switchToRegular = requestedHopHostIds !== undefined && requestedHopHostIds.length <= 2;
        if (hopHostIds) {
          if (hopHostIds.length > MAX_TUNNEL_HOPS) throw new Error(`多级隧道最多支持 ${MAX_TUNNEL_HOPS} 级`);
          if (new Set(hopHostIds).size !== hopHostIds.length) throw new Error("多级隧道中的主机不能重复");
          for (const hostId of hopHostIds) await requireHostAccess(ctx, hostId);
        }
        const hopIdsForConnect = hopHostIds || (!switchToRegular && existingHopHostIds.length >= 3 ? existingHopHostIds : null);
        const hopConnectHosts = hopIdsForConnect
          ? hopIdsForConnect.map((_, index) => (
            hopConnectHostsProvided && rawHopConnectHosts[index] !== undefined
              ? rawHopConnectHosts[index]
              : hopHostIds
                ? null
                : existingHopConnectHosts[index] ?? null
          ))
          : rawHopConnectHosts;
        const normalizedRequestedHopConnectHosts = hopIdsForConnect
          ? await normalizeHopConnectHostsForHosts(hopIdsForConnect, hopConnectHosts)
          : normalizeHopConnectHostsForCompare(hopConnectHosts);
        const entryHostId = hopHostIds ? hopHostIds[0] : (input.entryHostId ?? tunnel.entryHostId);
        const exitHostId = hopHostIds ? hopHostIds[hopHostIds.length - 1] : (input.exitHostId ?? tunnel.exitHostId);
        if (entryHostId === exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        await requireHostAccess(ctx, entryHostId);
        const exit = await requireHostAccess(ctx, exitHostId);
        const {
          id,
          hopHostIds: _ignoredHopHostIds,
          hopConnectHosts: _ignoredHopConnectHosts,
          loadBalanceExits: _ignoredLoadBalanceExits,
          blockHttp: _ignoredBlockHttp,
          blockSocks: _ignoredBlockSocks,
          blockTls: _ignoredBlockTls,
          ...data
        } = input as any;
        if ((data as any).mode !== undefined) {
          (data as any).mode = normalizeTunnelMode((data as any).mode);
        }
        if ((data as any).certDomain !== undefined || (data as any).mode !== undefined) {
          const certSource = (data as any).certDomain !== undefined ? (data as any).certDomain : (tunnel as any).certDomain;
          (data as any).certDomain = nextModeForRuntime === "nginx_stream" ? normalizeCertDomain(certSource) : null;
        }
        if (
          (data as any).certPem !== undefined
          || (data as any).certKeyPem !== undefined
          || (data as any).mode !== undefined
        ) {
          const certPemSource = (data as any).certPem !== undefined ? (data as any).certPem : (tunnel as any).certPem;
          const certKeySource = (data as any).certKeyPem !== undefined ? (data as any).certKeyPem : (tunnel as any).certKeyPem;
          const nginxCert = normalizeNginxCertInput(
            { certPem: certPemSource, certKeyPem: certKeySource },
            nextModeForRuntime === "nginx_stream",
          );
          (data as any).certPem = nginxCert.certPem;
          (data as any).certKeyPem = nginxCert.certKeyPem;
        }
        const nextPortRangeStart = (data as any).portRangeStart !== undefined ? (data as any).portRangeStart : (tunnel as any).portRangeStart;
        const nextPortRangeEnd = (data as any).portRangeEnd !== undefined ? (data as any).portRangeEnd : (tunnel as any).portRangeEnd;
        if (nextPortRangeStart != null && nextPortRangeEnd != null && nextPortRangeStart > nextPortRangeEnd) {
          throw new Error("隧道可用端口范围起始值不能大于结束值");
        }
        if ((data as any).listenPort !== undefined || hopHostIds) {
          const listenPort = Number((data as any).listenPort) || 0;
          if (listenPort <= 0) {
            (data as any).listenPort = await db.findAvailableTunnelExitPort(
              exitHostId,
              (exit as any).portRangeStart,
              (exit as any).portRangeEnd,
            );
            if (!(data as any).listenPort) throw new Error("出口 Agent 已无可用隧道端口");
          } else {
            const policy = portPolicyFrom(exit as any);
            if (!isPortAllowedByPolicy(listenPort, policy)) {
              throw new Error(portPolicyErrorMessage(policy, "出口监听端口"));
            }
            const used = await db.isPortUsedOnHost(exitHostId, listenPort);
            if (used) throw new Error(`出口 Agent 端口 ${listenPort} 已被转发规则占用`);
            const tunnelUsed = await db.isTunnelListenPortUsed(exitHostId, listenPort, id);
            if (tunnelUsed) throw new Error(`出口 Agent 端口 ${listenPort} 已被其他隧道占用`);
            (data as any).listenPort = listenPort;
          }
        }
        if ((data as any).networkType !== undefined || (data as any).connectHost !== undefined) {
          const nextConnectHost = (data as any).connectHost !== undefined ? (data as any).connectHost : (tunnel as any).connectHost;
          const nextNetworkType = (data as any).networkType !== undefined ? (data as any).networkType : (tunnel as any).networkType;
          const hasExistingMultiHop = existingHopHostIds.length >= 3;
          const isMultiHopAfterUpdate = !!hopHostIds || (!switchToRegular && hasExistingMultiHop && requestedHopHostIds === undefined);
          const normalizedConnectHost = isMultiHopAfterUpdate
            ? normalizeTunnelConnect(nextConnectHost)
            : normalizeTunnelConnectForEndpoint(nextConnectHost, nextNetworkType, exit);
          (data as any).networkType = isHostPrivateConnectHost(normalizedConnectHost, exit) ? "private" : "public";
          (data as any).connectHost = normalizedConnectHost;
        }
        (data as any).entryHostId = entryHostId;
        (data as any).exitHostId = exitHostId;
        const normalizedRequestedHopIds = hopHostIds ? hopHostIds : (switchToRegular ? [] : existingHopHostIds);
        const nextLoadBalanceEnabled = (data as any).loadBalanceEnabled !== undefined ? !!(data as any).loadBalanceEnabled : !!(tunnel as any).loadBalanceEnabled;
        const nextLoadBalanceStrategy = nextLoadBalanceEnabled
          ? normalizeTunnelLoadBalanceStrategy((data as any).loadBalanceStrategy ?? (tunnel as any).loadBalanceStrategy)
          : "round_robin";
        const requestedExtraExits = (input as any).loadBalanceExits !== undefined
          ? ((input as any).loadBalanceExits as Array<{ hostId: number; connectHost?: string | null }>)
          : (existingExtraExitNodes || []).map((node: any) => ({
            hostId: Number(node.hostId),
            connectHost: String(node.connectHost || "").trim() || null,
          }));
        const extraExitNodes = await buildExtraExitNodes(ctx, {
          tunnelId: id,
          primaryHostId: exitHostId,
          blockedHostIds: normalizedRequestedHopIds.length > 0 ? normalizedRequestedHopIds : [entryHostId, exitHostId],
          enabled: nextLoadBalanceEnabled,
          mode: nextModeForRuntime,
          exits: requestedExtraExits,
          existingNodes: existingExtraExitNodes,
          explicitListenPort: Number((input as any).listenPort || 0) > 0 ? Number((input as any).listenPort || 0) : 0,
        });
        (data as any).loadBalanceEnabled = nextLoadBalanceEnabled && extraExitNodes.length > 0;
        (data as any).loadBalanceStrategy = (data as any).loadBalanceEnabled ? nextLoadBalanceStrategy : "round_robin";
        const hopChanged = (requestedHopHostIds !== undefined || (hopConnectHostsProvided && existingHopHostIds.length >= 3))
          ? (
            JSON.stringify(normalizedRequestedHopIds) !== JSON.stringify(existingHopHostIds)
            || JSON.stringify(normalizedRequestedHopConnectHosts) !== JSON.stringify(existingHopConnectHosts)
          )
          : false;
        const existingExtraSignature = JSON.stringify((existingExtraExitNodes || []).map((node: any) => ({
          hostId: Number(node.hostId),
          connectHost: String(node.connectHost || "").trim() || null,
          listenPort: Number(node.listenPort) || 0,
        })));
        const nextExtraSignature = JSON.stringify(extraExitNodes.map((node) => ({
          hostId: Number(node.hostId),
          connectHost: String(node.connectHost || "").trim() || null,
          listenPort: Number(node.listenPort) || 0,
        })));
        const loadBalanceChanged = (data as any).loadBalanceEnabled !== !!(tunnel as any).loadBalanceEnabled
          || (data as any).loadBalanceStrategy !== normalizeTunnelLoadBalanceStrategy((tunnel as any).loadBalanceStrategy)
          || existingExtraSignature !== nextExtraSignature;
        const keyChanged = ["entryGroupId", "entryHostId", "exitHostId", "mode", "certDomain", "certPem", "certKeyPem", "listenPort", "rateLimitMbps", "isEnabled", "portRangeStart", "portRangeEnd", "networkType", "connectHost"].some((key) => (data as any)[key] !== undefined && (data as any)[key] !== (tunnel as any)[key]) || hopChanged || loadBalanceChanged;
        const enabledChanged = (data as any).isEnabled !== undefined && (data as any).isEnabled !== (tunnel as any).isEnabled;
        if (keyChanged) (data as any).isRunning = false;
        await db.updateTunnel(id, data as any);
        const shouldWriteHops = !!hopHostIds || (hopConnectHostsProvided && !switchToRegular && existingHopHostIds.length >= 3);
        const hopIdsToWrite = hopHostIds || existingHopHostIds;
        if (shouldWriteHops && hopIdsToWrite.length >= 3) {
          const hops: { hostId: number; listenPort: number; connectHost?: string | null }[] = [];
          const existingPortByHostId = new Map<number, number>();
          for (const hop of existingHops || []) {
            const hostId = Number((hop as any).hostId);
            const listenPort = Number((hop as any).listenPort);
            if (hostId > 0 && listenPort > 0 && !existingPortByHostId.has(hostId)) {
              existingPortByHostId.set(hostId, listenPort);
            }
          }
          for (let i = 0; i < hopIdsToWrite.length; i++) {
            let port = 0;
            if (i === hopIdsToWrite.length - 1) {
              port = Number((data as any).listenPort) || Number((tunnel as any).listenPort) || 0;
            } else {
              port = existingPortByHostId.get(hopIdsToWrite[i]) || 0;
              if (!port) {
                const hopHost = await db.getHostById(hopIdsToWrite[i]) as any;
                port = await db.findAvailableTunnelExitPort(hopIdsToWrite[i], hopHost?.portRangeStart, hopHost?.portRangeEnd) ?? 0;
                if (!port) throw new Error(`主机 ${hopHost?.name || hopIdsToWrite[i]} 已无可用端口`);
              }
            }
            const normalizedHopConnectHost = i > 0 ? normalizedRequestedHopConnectHosts[i] : null;
            hops.push({ hostId: hopIdsToWrite[i], listenPort: port, connectHost: normalizedHopConnectHost });
          }
          await hopRepo.createTunnelHops(id, hops);
        } else if (switchToRegular) {
          await hopRepo.deleteTunnelHops(id);
        }
        if ((data as any).loadBalanceEnabled) {
          await hopRepo.replaceTunnelExitNodes(id, extraExitNodes);
          await hopRepo.reconcileTunnelRuleExitMappings(id);
        } else {
          await hopRepo.clearTunnelExitNodes(id);
          await hopRepo.clearForwardRuleTunnelExitsByTunnel(id);
        }
        if (enabledChanged) {
          if ((data as any).isEnabled) {
            await db.restoreForwardRulesByTunnel(id);
          } else {
            await db.disableForwardRulesByTunnel(id);
          }
        }
        if (keyChanged) {
          await db.resetForwardRulesByTunnel(id);
          await hopRepo.clearTunnelTestSnapshot(id);
        }
        if (keyChanged) {
          const existingExtraHostIds = (existingExtraExitNodes || []).map((node: any) => Number(node.hostId)).filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
          const nextExtraHostIds = extraExitNodes.map((node) => Number(node.hostId)).filter((hostId) => Number.isFinite(hostId) && hostId > 0);
          const affectedHopHostIds = Array.from(new Set([...existingHopHostIds, ...normalizedRequestedHopIds, ...existingExtraHostIds, ...nextExtraHostIds]));
          const hasMultiHopRuntime = existingHopHostIds.length >= 3 || normalizedRequestedHopIds.length >= 3;
          if (hasMultiHopRuntime) {
            await refreshTunnelRuntimeHosts(id, affectedHopHostIds, hopChanged ? "tunnel-hop-updated" : "tunnel-updated");
          } else {
            clearTunnelRuntimeStatus(id);
            await pushTunnelEndpointRefresh({ ...tunnel, entryHostId, exitHostId }, "tunnel-updated");
          }
          const endpointHostIds = [tunnel.entryHostId, tunnel.exitHostId, entryHostId, exitHostId, ...existingExtraHostIds, ...nextExtraHostIds]
            .map((hostId) => Number(hostId))
            .filter((hostId) => Number.isFinite(hostId) && hostId > 0);
          for (const hostId of Array.from(new Set(endpointHostIds))) {
            pushAgentRefresh(hostId, "tunnel-runtime-sync");
          }
          if (tunnel.entryHostId !== entryHostId) pushAgentRefresh(tunnel.entryHostId, "tunnel-updated-old-entry");
          if (tunnel.exitHostId !== exitHostId) pushAgentRefresh(tunnel.exitHostId, "tunnel-updated-old-exit");
        }
        return { success: true, reset: keyChanged };
      }),
    deleteImpact: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        return getTunnelDeleteImpact(input.id);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number(), confirmRules: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        const impact = await getTunnelDeleteImpact(input.id);
        if (impact.forwardRuleCount > 0 && !input.confirmRules) {
          throw new Error(`此链路仍有关联转发规则 ${impact.forwardRuleCount} 条，请确认后再删除`);
        }
        clearTunnelRuntimeStatus(input.id);
        await pushTunnelEndpointRefresh(tunnel, "tunnel-deleted");
        await db.deleteTunnel(input.id);
        return { success: true };
      }),
    test: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("Tunnel not found");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("No permission to test this tunnel");
        await requireTunnelProtocolEnabled(tunnel);
        const entry = await db.getHostById(tunnel.entryHostId);
        const exit = await db.getHostById(tunnel.exitHostId);
        if (!entry) throw new Error("Entry Agent not found");
        if (!exit) throw new Error("Exit Agent not found");
        appendPanelLog("info", `[TunnelTest] start tunnel=${tunnel.id} name=${tunnel.name} entryHost=${tunnel.entryHostId} exitHost=${tunnel.exitHostId} mode=${tunnel.mode} listenPort=${tunnel.listenPort}`);
        let tunnelHops = await hopRepo.getTunnelHops(Number(tunnel.id));
        const tunnelHopHostIds = Array.isArray(tunnelHops)
          ? tunnelHops.map((hop: any) => Number(hop.hostId)).filter((hostId: number) => Number.isFinite(hostId) && hostId > 0)
          : [];
        const tunnelExtraExitNodes = await hopRepo.getTunnelExitNodes(Number(tunnel.id));
        const tunnelExtraExitHostIds = (tunnelExtraExitNodes || [])
          .map((node: any) => Number(node.hostId))
          .filter((hostId: number) => Number.isFinite(hostId) && hostId > 0);
        const entryTestHostIds = await getTunnelEntryTestHostIds(tunnel);
        const hasEntryGroupTest = entryTestHostIds.length > 1;
        if (tunnelHopHostIds.length >= 3) {
          await refreshTunnelRuntimeHosts(Number(tunnel.id), [...entryTestHostIds, ...tunnelHopHostIds, ...tunnelExtraExitHostIds], "tunnel-test-refresh");
        } else if (tunnel.loadBalanceEnabled && tunnelExtraExitHostIds.length > 0) {
          await refreshTunnelRuntimeHosts(Number(tunnel.id), [...entryTestHostIds, Number(tunnel.exitHostId), ...tunnelExtraExitHostIds], "tunnel-load-balance-test-refresh");
        } else if (!tunnel.isRunning) {
          const testRefreshHostIds = Array.from(new Set([Number(tunnel.exitHostId), ...entryTestHostIds, ...tunnelExtraExitHostIds].filter((hostId) => Number.isFinite(hostId) && hostId > 0)));
          const pushedResults = testRefreshHostIds.map((hostId) => pushAgentRefresh(hostId, "tunnel-test-refresh"));
          const pushed = pushedResults.every(Boolean);
          appendPanelLog(
            pushed ? "info" : "warn",
            pushed
              ? `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; pushed refresh to exit Agent(s)`
              : `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; one or more exit Agent event streams unavailable, test will still be queued`
          );
        }
        const target = getTunnelDialHost(tunnel, exit);
        let targetPort = Number(tunnel.listenPort) || 0;
        if (targetPort <= 0) {
          if (Array.isArray(tunnelHops) && tunnelHops.length >= 2) {
            targetPort = Number((tunnelHops[tunnelHops.length - 1] as any).listenPort) || 0;
            if (targetPort > 0) {
              await db.updateTunnel(tunnel.id, { listenPort: targetPort } as any);
              appendPanelLog("warn", `[TunnelTest] tunnel=${tunnel.id} listenPort repaired from hops: ${targetPort}`);
            }
          } else {
            // Legacy/broken data fallback: allocate a valid exit listen port on demand.
            const allocated = await db.findAvailableTunnelExitPort(
              tunnel.exitHostId,
              (exit as any).portRangeStart,
              (exit as any).portRangeEnd,
            );
            if (allocated) {
              targetPort = Number(allocated) || 0;
              await db.updateTunnel(tunnel.id, { listenPort: targetPort, isRunning: false } as any);
              if (Array.isArray(tunnelHops) && tunnelHops.length > 0) {
                const repairedHops = tunnelHops.map((hop: any, idx: number) => ({
                  hostId: Number(hop.hostId),
                  listenPort: idx === tunnelHops.length - 1 ? targetPort : Number(hop.listenPort) || 0,
                  connectHost: String(hop.connectHost || "").trim() || null,
                }));
                await hopRepo.createTunnelHops(Number(tunnel.id), repairedHops);
                tunnelHops = await hopRepo.getTunnelHops(Number(tunnel.id));
              }
              appendPanelLog("warn", `[TunnelTest] tunnel=${tunnel.id} listenPort auto-assigned: ${targetPort}`);
              await pushTunnelEndpointRefresh(tunnel as any, "tunnel-test-port-repair");
            }
          }
        }
        if (!target || !targetPort) {
          const message = `TUNNEL_TEST_TARGET_INVALID target=${target || "-"} port=${targetPort || "-"}`;
          await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
          await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true }, { message });
          appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid test target. exitHost=${exit.id} target=${target || "-"} port=${targetPort || "-"}`);
          return { success: false, latencyMs: null, message };
        }
        if (!hasEntryGroupTest && Array.isArray(tunnelHops) && tunnelHops.length >= 3) {
          const batchId = createTunnelHopBatch(Number(tunnel.id));
          const pendingDetails: any[] = [];
          let queued = 0;
          for (let i = 0; i < tunnelHops.length - 1; i++) {
            const currentHop = tunnelHops[i] as any;
            const nextHop = tunnelHops[i + 1] as any;
            const fromHostId = Number(currentHop.hostId) || 0;
            const nextHost = await db.getHostById(Number(nextHop.hostId));
            const nextAddr = String(nextHop.connectHost || "").trim() || getHostPublicAddress(nextHost);
            const nextPort = Number(nextHop.listenPort) || 0;
            if (!fromHostId || !nextAddr || !nextPort) {
              const message = `TUNNEL_HOP_TEST_TARGET_INVALID hop=${i + 1} target=${nextAddr || "-"} port=${nextPort || "-"}`;
              await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
              await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true }, { message });
              appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid hop target hop=${i + 1} fromHost=${fromHostId} target=${nextAddr || "-"} port=${nextPort || "-"}`);
              return { success: false, latencyMs: null, message };
            }
            const hopLabel = `${i + 1}/${tunnelHops.length - 1} ${fromHostId}->${Number(nextHop.hostId)}`;
            const currentHost = await db.getHostById(fromHostId);
            const routeLabel = `第 ${i + 1} 跳 ${(currentHost as any)?.name || `主机${fromHostId}`} -> ${(nextHost as any)?.name || `主机${Number(nextHop.hostId)}`}`;
            pendingDetails.push({
              success: false,
              latencyMs: null,
              message: null,
              hopLabel,
              routeLabel,
              method: "tcp",
              pending: true,
            });
            const payload = {
              kind: "tunnel-hop",
              tunnelId: tunnel.id,
              targetIp: nextAddr,
              targetPort: nextPort,
              hopLabel,
              routeLabel,
              batchId,
            };
            const testId = await db.createForwardTest({
              ruleId: 0,
              hostId: fromHostId,
              userId: tunnel.userId,
              message: JSON.stringify(payload),
            } as any);
            pushAgentRefresh(fromHostId, "tunnel-hop-selftest");
            registerTunnelHopTest(batchId, Number(testId));
            queued += 1;
            appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued hop tcping ${hopLabel} target=${nextAddr}:${nextPort}`);
          }
          const message = structuredLinkTestMessage({
            kind: "tunnel-hop-pending",
            tunnelId: tunnel.id,
            message: `多级隧道逐跳探测中：${queued} 段`,
            details: pendingDetails,
            totalLatencyMs: null,
          });
          await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
          return { success: false, latencyMs: null, message, pending: true };
        }

        if (hasEntryGroupTest) {
          const nextHop = Array.isArray(tunnelHops) && tunnelHops.length >= 2 ? tunnelHops[1] as any : null;
          const nextHostId = Number(nextHop?.hostId || tunnel.exitHostId || 0);
          const nextHost = await db.getHostById(nextHostId);
          const firstTarget = String(nextHop?.connectHost || "").trim() || getHostPublicAddress(nextHost) || target;
          const firstTargetPort = Number(nextHop?.listenPort || targetPort) || 0;
          if (!nextHostId || !firstTarget || !firstTargetPort) {
            const message = `TUNNEL_ENTRY_GROUP_TEST_TARGET_INVALID target=${firstTarget || "-"} port=${firstTargetPort || "-"}`;
            await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
            await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true }, { message });
            appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid entry-group test target target=${firstTarget || "-"} port=${firstTargetPort || "-"}`);
            return { success: false, latencyMs: null, message };
          }
          const batchId = createTunnelHopBatch(Number(tunnel.id));
          const pendingDetails: any[] = [];
          let queued = 0;
          for (const entryHostId of entryTestHostIds) {
            const entryHost = await db.getHostById(entryHostId);
            const routeLabel = `${(entryHost as any)?.name || `主机${entryHostId}`} -> ${(nextHost as any)?.name || `主机${nextHostId}`}`;
            const hopLabel = `入口 ${queued + 1}/${entryTestHostIds.length} ${entryHostId}->${nextHostId}`;
            pendingDetails.push({
              success: false,
              latencyMs: null,
              message: null,
              hopLabel,
              routeLabel,
              method: "tcp",
              pending: true,
            });
            const payload = {
              kind: "tunnel-hop",
              tunnelId: tunnel.id,
              targetIp: firstTarget,
              targetPort: firstTargetPort,
              hopLabel,
              routeLabel,
              batchId,
              latencyMode: "multi-source",
            };
            const testId = await db.createForwardTest({
              ruleId: 0,
              hostId: entryHostId,
              userId: tunnel.userId,
              message: JSON.stringify(payload),
            } as any);
            pushAgentRefresh(entryHostId, "tunnel-entry-group-selftest");
            registerTunnelHopTest(batchId, Number(testId));
            queued += 1;
            appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-group TCPing ${hopLabel} target=${firstTarget}:${firstTargetPort}`);
          }
          if (Array.isArray(tunnelHops) && tunnelHops.length >= 3) {
            for (let i = 1; i < tunnelHops.length - 1; i++) {
              const currentHop = tunnelHops[i] as any;
              const nextHop = tunnelHops[i + 1] as any;
              const fromHostId = Number(currentHop.hostId) || 0;
              const currentHost = await db.getHostById(fromHostId);
              const nextHost = await db.getHostById(Number(nextHop.hostId));
              const nextAddr = String(nextHop.connectHost || "").trim() || getHostPublicAddress(nextHost);
              const nextPort = Number(nextHop.listenPort) || 0;
              if (!fromHostId || !nextAddr || !nextPort) {
                const message = `TUNNEL_HOP_TEST_TARGET_INVALID hop=${i + 1} target=${nextAddr || "-"} port=${nextPort || "-"}`;
                await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
                await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true }, { message });
                appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid entry-group hop target hop=${i + 1} fromHost=${fromHostId} target=${nextAddr || "-"} port=${nextPort || "-"}`);
                return { success: false, latencyMs: null, message };
              }
              const hopLabel = `${i + 1}/${tunnelHops.length - 1} ${fromHostId}->${Number(nextHop.hostId)}`;
              const routeLabel = `第 ${i + 1} 跳 ${(currentHost as any)?.name || `主机${fromHostId}`} -> ${(nextHost as any)?.name || `主机${Number(nextHop.hostId)}`}`;
              pendingDetails.push({
                success: false,
                latencyMs: null,
                message: null,
                hopLabel,
                routeLabel,
                method: "tcp",
                pending: true,
              });
              const payload = {
                kind: "tunnel-hop",
                tunnelId: tunnel.id,
                targetIp: nextAddr,
                targetPort: nextPort,
                hopLabel,
                routeLabel,
                batchId,
                latencyMode: "multi-source",
              };
              const testId = await db.createForwardTest({
                ruleId: 0,
                hostId: fromHostId,
                userId: tunnel.userId,
                message: JSON.stringify(payload),
              } as any);
              pushAgentRefresh(fromHostId, "tunnel-hop-selftest");
              registerTunnelHopTest(batchId, Number(testId));
              queued += 1;
              appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-group hop TCPing ${hopLabel} target=${nextAddr}:${nextPort}`);
            }
          }
          const message = structuredLinkTestMessage({
            kind: "tunnel-entry-group-pending",
            tunnelId: tunnel.id,
            message: `多入口隧道探测中：${entryTestHostIds.length} 个入口${queued > entryTestHostIds.length ? `，共 ${queued} 段` : ""}`,
            details: pendingDetails,
            totalLatencyMs: null,
          });
          await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
          appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-group TCPing entries=${entryTestHostIds.length} segments=${queued}`);
          return { success: false, latencyMs: null, message, pending: true };
        }
        const extraExitEndpoints = (tunnel.loadBalanceEnabled ? (tunnelExtraExitNodes || []) : [])
          .map((node: any) => ({
            seq: Number(node.seq) || 0,
            hostId: Number(node.hostId) || 0,
            listenPort: Number(node.listenPort) || 0,
            connectHost: String(node.connectHost || "").trim() || null,
          }))
          .filter((node: any) => node.hostId > 0 && node.listenPort > 0)
          .sort((a: any, b: any) => a.seq - b.seq);
        if (extraExitEndpoints.length > 0) {
          const batchId = createTunnelHopBatch(Number(tunnel.id));
          const pendingDetails: any[] = [];
          const branchGroupKey = `tunnel-${tunnel.id}-load-balance`;
          const branchGroupLabel = "多出口负载";
          const primaryRouteLabel = `${(entry as any)?.name || `主机${tunnel.entryHostId}`} -> ${(exit as any)?.name || `主机${tunnel.exitHostId}`}`;
          const primaryPayload = {
            kind: "tunnel-hop",
            tunnelId: tunnel.id,
            targetIp: target,
            targetPort,
            hopLabel: `出口 1/${extraExitEndpoints.length + 1} ${tunnel.entryHostId}->${tunnel.exitHostId}`,
            routeLabel: primaryRouteLabel,
            batchId,
            groupKey: branchGroupKey,
            groupLabel: branchGroupLabel,
            latencyMode: "max",
          };
          pendingDetails.push({
            success: false,
            latencyMs: null,
            message: null,
            hopLabel: primaryPayload.hopLabel,
            routeLabel: primaryRouteLabel,
            method: "tcp",
            pending: true,
            groupKey: branchGroupKey,
            groupLabel: branchGroupLabel,
          });
          const primaryTestId = await db.createForwardTest({
            ruleId: 0,
            hostId: tunnel.entryHostId,
            userId: tunnel.userId,
            message: JSON.stringify(primaryPayload),
          } as any);
          registerTunnelHopTest(batchId, Number(primaryTestId));
          let queued = 1;
          for (const endpoint of extraExitEndpoints) {
            const endpointHost = await db.getHostById(endpoint.hostId);
            const endpointTarget = String(endpoint.connectHost || "").trim() || getHostPublicAddress(endpointHost);
            const endpointPort = Number(endpoint.listenPort) || 0;
            if (!endpointTarget || !endpointPort) {
              const message = `TUNNEL_EXIT_TEST_TARGET_INVALID host=${endpoint.hostId} target=${endpointTarget || "-"} port=${endpointPort || "-"}`;
              await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
              await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true }, { message });
              appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid load-balance exit target host=${endpoint.hostId} target=${endpointTarget || "-"} port=${endpointPort || "-"}`);
              return { success: false, latencyMs: null, message };
            }
            const hopLabel = `出口 ${queued + 1}/${extraExitEndpoints.length + 1} ${tunnel.entryHostId}->${endpoint.hostId}`;
            const routeLabel = `${(entry as any)?.name || `主机${tunnel.entryHostId}`} -> ${(endpointHost as any)?.name || `主机${endpoint.hostId}`}`;
            pendingDetails.push({
              success: false,
              latencyMs: null,
              message: null,
              hopLabel,
              routeLabel,
              method: "tcp",
              pending: true,
              groupKey: branchGroupKey,
              groupLabel: branchGroupLabel,
            });
            const payload = {
              kind: "tunnel-hop",
              tunnelId: tunnel.id,
              targetIp: endpointTarget,
              targetPort: endpointPort,
              hopLabel,
              routeLabel,
              batchId,
              groupKey: branchGroupKey,
              groupLabel: branchGroupLabel,
              latencyMode: "max",
            };
            const testId = await db.createForwardTest({
              ruleId: 0,
              hostId: tunnel.entryHostId,
              userId: tunnel.userId,
              message: JSON.stringify(payload),
            } as any);
            registerTunnelHopTest(batchId, Number(testId));
            queued += 1;
            appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued load-balance TCPing ${hopLabel} target=${endpointTarget}:${endpointPort}`);
          }
          pushAgentRefresh(tunnel.entryHostId, "tunnel-selftest");
          const message = structuredLinkTestMessage({
            kind: "tunnel-load-balance-pending",
            tunnelId: tunnel.id,
            message: `多出口负载探测中：${queued} 个出口`,
            details: pendingDetails,
            totalLatencyMs: null,
          });
          await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
          appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued load-balance TCPing exits=${queued}`);
          return { success: false, latencyMs: null, message, pending: true };
        }

        const payload = {
          kind: "tunnel",
          tunnelId: tunnel.id,
          targetIp: target,
          targetPort,
        };
        await db.createForwardTest({
          ruleId: 0,
          hostId: tunnel.entryHostId,
          userId: tunnel.userId,
          message: JSON.stringify(payload),
        } as any);
        pushAgentRefresh(tunnel.entryHostId, "tunnel-selftest");
        const message = `TUNNEL_LINK_TEST_PENDING ${target}:${targetPort}`;
        await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
        appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-agent TCPing from entryHost=${entry.id} to exit ${target}:${targetPort}`);
        return { success: false, latencyMs: null, message, pending: true };
      }),
  });


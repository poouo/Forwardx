import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import crypto from "crypto";
const isValidHostOrIp = (value: string) => /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/.test(value) && value.length <= 253;
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

const tunnelNetworkTypeSchema = z.enum(["public", "private"]);
const MAX_TUNNEL_HOPS = 10;
const tunnelQueryCache = createQueryCache(300);

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
    const privateAddr = String((host as any)?.tunnelEntryIp || "").trim();
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

function normalizeHopConnectForHost(rawConnectHost: string | null | undefined, host: any) {
  const raw = String(rawConnectHost || "").trim();
  const publicAddr = getHostPublicAddress(host);
  const privateAddr = String((host as any)?.tunnelEntryIp || "").trim();
  if (!raw) return publicAddr || null;
  const normalized = normalizeTunnelConnect(raw);
  if (privateAddr && normalized === privateAddr) return privateAddr;
  if (publicAddr && normalized === publicAddr) return publicAddr;
  if (!privateAddr) return publicAddr || null;
  throw new Error(`主机 ${host?.name || host?.id || ""} 的连接地址只能使用入口地址或已配置的内网IP`);
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

async function attachTunnelEndpointHosts(tunnels: any[]) {
  const hostMap = new Map<number, any>();
  const hopHostIdsByTunnel = new Map<number, number[]>();
  const hopConnectHostsByTunnel = new Map<number, Array<string | null>>();
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
  }));
  await Promise.all(tunnels.map(async (tunnel) => {
    const hopIds = hopHostIdsByTunnel.get(Number(tunnel.id));
    if (!hopIds || hopIds.length < 3) return;
    const aggregate = getTunnelAutoHopAggregate(Number(tunnel.id), hopIds.length - 1);
    if (!aggregate) return;
    const currentLatency = typeof (tunnel as any).lastLatencyMs === "number" ? Number((tunnel as any).lastLatencyMs) : null;
    const nextLatency = aggregate.success ? aggregate.latencyMs : null;
    const shouldUpdate = currentLatency !== nextLatency;
    if (!shouldUpdate) return;
    await db.insertTunnelLatencyStat({
      tunnelId: Number(tunnel.id),
      latencyMs: aggregate.success ? aggregate.latencyMs : null,
      isTimeout: !aggregate.success,
    });
    (tunnel as any).lastLatencyMs = aggregate.success ? aggregate.latencyMs : null;
  }));
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
    portRangeStart: (host as any).portRangeStart,
    portRangeEnd: (host as any).portRangeEnd,
    portAllowlist: (host as any).portAllowlist,
  } : null;
  return tunnels.map((tunnel) => ({
    ...tunnel,
    hopHostIds: hopHostIdsByTunnel.get(Number(tunnel.id)) || [],
    hopConnectHosts: hopConnectHostsByTunnel.get(Number(tunnel.id)) || [],
    hopHosts: (hopHostIdsByTunnel.get(Number(tunnel.id)) || [])
      .map((hostId) => hostSummary(hostMap.get(Number(hostId))))
      .filter(Boolean),
    entryHost: hostSummary(hostMap.get(Number(tunnel.entryHostId || 0))),
    exitHost: hostSummary(hostMap.get(Number(tunnel.exitHostId || 0))),
  }));
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
        entryHostId: z.number(),
        exitHostId: z.number(),
        mode: z.enum(["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"]).default("forwardx"),
        listenPort: z.number().min(0).max(65535).optional().default(0),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        networkType: tunnelNetworkTypeSchema.optional().default("public"),
        connectHost: z.string().max(128).nullable().optional(),
        blockHttp: z.boolean().optional().default(false),
        blockSocks: z.boolean().optional().default(false),
        blockTls: z.boolean().optional().default(false),
        hopHostIds: z.array(z.number()).optional(),
        hopConnectHosts: z.array(z.string().max(128).nullable()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
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
        await requireTunnelProtocolEnabled(input);

        // Determine entry/exit host IDs
        const entryHostId = hopHostIds ? hopHostIds[0] : input.entryHostId;
        const exitHostId = hopHostIds ? hopHostIds[hopHostIds.length - 1] : input.exitHostId;

        let listenPort = Number(input.listenPort) || 0;
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
        const {
          hopHostIds: _ignoredHopHostIds,
          hopConnectHosts: _ignoredHopConnectHosts,
          blockHttp: _ignoredBlockHttp,
          blockSocks: _ignoredBlockSocks,
          blockTls: _ignoredBlockTls,
          ...tunnelInput
        } = input as any;
        const id = await db.createTunnel({
          ...tunnelInput,
          entryHostId,
          exitHostId,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          networkType: connectHost ? "private" : "public",
          connectHost,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          listenPort,
          secret,
          userId: ctx.user.id,
        } as any);
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
              if (!port) throw new Error(`涓绘満 ${host?.name || hopHostIds[i]} 宸叉棤鍙敤绔彛`);
            }
            const rawConnectHost = i > 0 ? (hopConnectHosts[i] ?? null) : null;
            const hopHost = await db.getHostById(hopHostIds[i]) as any;
            const normalizedHopConnectHost = i > 0 ? normalizeHopConnectForHost(rawConnectHost, hopHost) : null;
            hops.push({ hostId: hopHostIds[i], listenPort: port, connectHost: normalizedHopConnectHost });
          }
          await hopRepo.createTunnelHops(id, hops);
        }
        if (hopHostIds) {
          await refreshTunnelRuntimeHosts(id, hopHostIds, "tunnel-created");
        } else {
          await pushTunnelEndpointRefresh({ id, entryHostId: input.entryHostId, exitHostId: input.exitHostId }, "tunnel-created");
        }
        return { id, listenPort };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        entryHostId: z.number().optional(),
        exitHostId: z.number().optional(),
        mode: z.enum(["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"]).optional(),
        listenPort: z.number().min(0).max(65535).optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
        networkType: tunnelNetworkTypeSchema.optional(),
        connectHost: z.string().max(128).nullable().optional(),
        blockHttp: z.boolean().optional(),
        blockSocks: z.boolean().optional(),
        blockTls: z.boolean().optional(),
        isEnabled: z.boolean().optional(),
        hopHostIds: z.array(z.number()).optional(),
        hopConnectHosts: z.array(z.string().max(128).nullable()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        const existingHops = await hopRepo.getTunnelHops(input.id);
        const existingHopHostIds = (existingHops || []).map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0);
        const existingHopConnectHosts = normalizeHopConnectHostsForCompare(existingHops || []);
        const nextModeForRuntime = input.mode ?? (tunnel as any).mode;
        await requireTunnelProtocolEnabled({ ...tunnel, mode: nextModeForRuntime });
        const requestedHopHostIds = Array.isArray((input as any).hopHostIds)
          ? ((input as any).hopHostIds as number[]).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
          : undefined;
        const hopConnectHosts = Array.isArray((input as any).hopConnectHosts)
          ? ((input as any).hopConnectHosts as Array<string | null>)
          : [];
        const hopHostIds = requestedHopHostIds && requestedHopHostIds.length >= 3 ? requestedHopHostIds : null;
        const switchToRegular = requestedHopHostIds !== undefined && requestedHopHostIds.length <= 2;
        if (hopHostIds) {
          if (hopHostIds.length > MAX_TUNNEL_HOPS) throw new Error(`多级隧道最多支持 ${MAX_TUNNEL_HOPS} 级`);
          if (new Set(hopHostIds).size !== hopHostIds.length) throw new Error("多级隧道中的主机不能重复");
          for (const hostId of hopHostIds) await requireHostAccess(ctx, hostId);
        }
        const normalizedRequestedHopConnectHosts = hopHostIds
          ? await normalizeHopConnectHostsForHosts(hopHostIds, hopConnectHosts)
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
          blockHttp: _ignoredBlockHttp,
          blockSocks: _ignoredBlockSocks,
          blockTls: _ignoredBlockTls,
          ...data
        } = input as any;
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
          (data as any).networkType = normalizedConnectHost ? "private" : "public";
          (data as any).connectHost = normalizedConnectHost;
        }
        (data as any).entryHostId = entryHostId;
        (data as any).exitHostId = exitHostId;
        const normalizedRequestedHopIds = hopHostIds ? hopHostIds : (switchToRegular ? [] : existingHopHostIds);
        const hopChanged = requestedHopHostIds !== undefined
          && (
            JSON.stringify(normalizedRequestedHopIds) !== JSON.stringify(existingHopHostIds)
            || JSON.stringify(normalizedRequestedHopConnectHosts) !== JSON.stringify(existingHopConnectHosts)
          );
        const keyChanged = ["entryHostId", "exitHostId", "mode", "listenPort", "isEnabled", "portRangeStart", "portRangeEnd", "networkType", "connectHost"].some((key) => (data as any)[key] !== undefined && (data as any)[key] !== (tunnel as any)[key]) || hopChanged;
        const enabledChanged = (data as any).isEnabled !== undefined && (data as any).isEnabled !== (tunnel as any).isEnabled;
        if (keyChanged) (data as any).isRunning = false;
        await db.updateTunnel(id, data as any);
        if (hopHostIds) {
          const hops: { hostId: number; listenPort: number; connectHost?: string | null }[] = [];
          const existingPortByHostId = new Map<number, number>();
          for (const hop of existingHops || []) {
            const hostId = Number((hop as any).hostId);
            const listenPort = Number((hop as any).listenPort);
            if (hostId > 0 && listenPort > 0 && !existingPortByHostId.has(hostId)) {
              existingPortByHostId.set(hostId, listenPort);
            }
          }
          for (let i = 0; i < hopHostIds.length; i++) {
            let port = 0;
            if (i === hopHostIds.length - 1) {
              port = Number((data as any).listenPort) || Number((tunnel as any).listenPort) || 0;
            } else {
              port = existingPortByHostId.get(hopHostIds[i]) || 0;
              if (!port) {
                const hopHost = await db.getHostById(hopHostIds[i]) as any;
                port = await db.findAvailableTunnelExitPort(hopHostIds[i], hopHost?.portRangeStart, hopHost?.portRangeEnd) ?? 0;
                if (!port) throw new Error(`涓绘満 ${hopHost?.name || hopHostIds[i]} 宸叉棤鍙敤绔彛`);
              }
            }
            const normalizedHopConnectHost = i > 0 ? normalizedRequestedHopConnectHosts[i] : null;
            hops.push({ hostId: hopHostIds[i], listenPort: port, connectHost: normalizedHopConnectHost });
          }
          await hopRepo.createTunnelHops(id, hops);
        } else if (switchToRegular) {
          await hopRepo.deleteTunnelHops(id);
        }
        if (enabledChanged) {
          if ((data as any).isEnabled) {
            await db.restoreForwardRulesByTunnel(id);
          } else {
            await db.disableForwardRulesByTunnel(id);
          }
        }
        if (keyChanged) await db.resetForwardRulesByTunnel(id);
        if (keyChanged) {
          const affectedHopHostIds = Array.from(new Set([...existingHopHostIds, ...normalizedRequestedHopIds]));
          if (affectedHopHostIds.length >= 3) {
            await refreshTunnelRuntimeHosts(id, affectedHopHostIds, hopChanged ? "tunnel-hop-updated" : "tunnel-updated");
          } else {
            clearTunnelRuntimeStatus(id);
            await pushTunnelEndpointRefresh({ ...tunnel, entryHostId, exitHostId }, "tunnel-updated");
          }
          const endpointHostIds = [tunnel.entryHostId, tunnel.exitHostId, entryHostId, exitHostId]
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
        if (tunnelHopHostIds.length >= 3) {
          await refreshTunnelRuntimeHosts(Number(tunnel.id), tunnelHopHostIds, "tunnel-test-refresh");
        } else if (!tunnel.isRunning) {
          const pushed = pushAgentRefresh(tunnel.exitHostId, "tunnel-test-refresh");
          appendPanelLog(
            pushed ? "info" : "warn",
            pushed
              ? `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; pushed refresh to exit Agent`
              : `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; exit Agent event stream unavailable, test will still be queued`
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
        if (Array.isArray(tunnelHops) && tunnelHops.length >= 3) {
          const batchId = createTunnelHopBatch(Number(tunnel.id));
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
          const message = `TUNNEL_HOP_TEST_PENDING hops=${queued}`;
          await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
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


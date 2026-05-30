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

const tunnelNetworkTypeSchema = z.enum(["public", "private"]);
const fxpVersionSchema = z.union([z.literal(1), z.literal(2), z.literal("1"), z.literal("2")])
  .transform((value) => Number(value));

const normalizeTunnelConnect = (connectHost?: string | null) => {
  const host = String(connectHost || "").trim();
  if (!host) return null;
  if (!isValidHostOrIp(host)) throw new Error("指定出口地址无效，请输入有效的 IP 或域名");
  return host;
};

const getTunnelDialHost = (tunnel: any, exit: any) => {
  const connectHost = String(tunnel?.connectHost || "").trim();
  if (connectHost) return connectHost;
  return String((exit as any).tunnelEntryIp || (exit as any).entryIp || (exit as any).ipv4 || (exit as any).ipv6 || exit?.ip || "").trim();
};

async function attachTunnelEndpointHosts(tunnels: any[]) {
  const hostIds = Array.from(new Set(
    tunnels
      .flatMap((tunnel) => [Number(tunnel.entryHostId || 0), Number(tunnel.exitHostId || 0)])
      .filter(Boolean),
  ));
  const hostMap = new Map<number, any>();
  const hopHostIdsByTunnel = new Map<number, number[]>();
  const hopConnectHostsByTunnel = new Map<number, Array<string | null>>();
  await Promise.all(hostIds.map(async (hostId) => {
    const host = await db.getHostById(hostId);
    if (host) hostMap.set(hostId, host);
  }));
  await Promise.all(tunnels.map(async (tunnel) => {
    const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
    const hopIds = (hops || []).map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0);
    if (hopIds.length >= 2) hopHostIdsByTunnel.set(Number(tunnel.id), hopIds);
    const hopConnectHosts = (hops || []).map((hop: any) => {
      const value = String((hop as any).connectHost || "").trim();
      return value ? value : null;
    });
    if (hopConnectHosts.length >= 2) hopConnectHostsByTunnel.set(Number(tunnel.id), hopConnectHosts);
  }));
  return tunnels.map((tunnel) => ({
    ...tunnel,
    hopHostIds: hopHostIdsByTunnel.get(Number(tunnel.id)) || [],
    hopConnectHosts: hopConnectHostsByTunnel.get(Number(tunnel.id)) || [],
    entryHost: (() => {
      const host = hostMap.get(Number(tunnel.entryHostId || 0));
      if (!host) return null;
      return {
        id: host.id,
        name: host.name,
        ip: host.ip,
        ipv4: (host as any).ipv4,
        ipv6: (host as any).ipv6,
        entryIp: (host as any).entryIp,
        tunnelEntryIp: (host as any).tunnelEntryIp,
        portRangeStart: (host as any).portRangeStart,
        portRangeEnd: (host as any).portRangeEnd,
      };
    })(),
    exitHost: (() => {
      const host = hostMap.get(Number(tunnel.exitHostId || 0));
      if (!host) return null;
      return {
        id: host.id,
        name: host.name,
      };
    })(),
  }));
}

export const tunnelsRouter = router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const tunnels = isAdmin ? await db.getTunnels() : await db.getTunnelsForUser(ctx.user.id);
      return attachTunnelEndpointHosts(tunnels as any[]);
    }),
    listAll: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new Error("鏃犳潈璁块棶");
      return db.getTunnels();
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
        return db.getTunnelLatencySeries(input.tunnelId, { since });
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        entryHostId: z.number(),
        exitHostId: z.number(),
        mode: z.enum(["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"]).default("forwardx"),
        fxpVersion: fxpVersionSchema.optional().default("2"),
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
            const start = exit?.portRangeStart;
            const end = exit?.portRangeEnd;
            if (start != null && end != null && (listenPort < start || listenPort > end)) {
              throw new Error(`出口监听端口必须在 ${start}-${end} 区间内`);
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
        const connectHost = normalizeTunnelConnect(input.connectHost);
        const { hopHostIds: _ignoredHopHostIds, hopConnectHosts: _ignoredHopConnectHosts, ...tunnelInput } = input as any;
        const id = await db.createTunnel({
          ...tunnelInput,
          entryHostId,
          exitHostId,
          fxpVersion: input.mode === "forwardx" ? input.fxpVersion : 1,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          networkType: connectHost ? "private" : "public",
          connectHost,
          blockHttp: !!input.blockHttp,
          blockSocks: !!input.blockSocks,
          blockTls: !!input.blockTls,
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
            const normalizedHopConnectHost = rawConnectHost ? normalizeTunnelConnect(rawConnectHost) : null;
            hops.push({ hostId: hopHostIds[i], listenPort: port, connectHost: normalizedHopConnectHost });
          }
          await hopRepo.createTunnelHops(id, hops);
        }
        if (hopHostIds) {
          for (const hostId of hopHostIds) pushAgentRefresh(hostId, "tunnel-created");
        } else {
          pushTunnelEndpointRefresh({ id, entryHostId: input.entryHostId, exitHostId: input.exitHostId }, "tunnel-created");
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
        fxpVersion: fxpVersionSchema.optional(),
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
        await requireTunnelProtocolEnabled({ ...tunnel, mode: input.mode ?? tunnel.mode });
        const existingHops = await hopRepo.getTunnelHops(input.id);
        const existingHopHostIds = (existingHops || []).map((hop: any) => Number(hop.hostId)).filter((id: number) => Number.isFinite(id) && id > 0);
        const requestedHopHostIds = Array.isArray((input as any).hopHostIds)
          ? ((input as any).hopHostIds as number[]).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
          : undefined;
        const hopConnectHosts = Array.isArray((input as any).hopConnectHosts)
          ? ((input as any).hopConnectHosts as Array<string | null>)
          : [];
        const hopHostIds = requestedHopHostIds && requestedHopHostIds.length >= 3 ? requestedHopHostIds : null;
        const switchToRegular = requestedHopHostIds !== undefined && requestedHopHostIds.length <= 2;
        if (hopHostIds) {
          if (new Set(hopHostIds).size !== hopHostIds.length) throw new Error("多级隧道中的主机不能重复");
          for (const hostId of hopHostIds) await requireHostAccess(ctx, hostId);
        }
        const entryHostId = hopHostIds ? hopHostIds[0] : (input.entryHostId ?? tunnel.entryHostId);
        const exitHostId = hopHostIds ? hopHostIds[hopHostIds.length - 1] : (input.exitHostId ?? tunnel.exitHostId);
        if (entryHostId === exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        await requireHostAccess(ctx, entryHostId);
        const exit = await requireHostAccess(ctx, exitHostId);
        const { id, hopHostIds: _ignoredHopHostIds, hopConnectHosts: _ignoredHopConnectHosts, ...data } = input as any;
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
            const start = (exit as any).portRangeStart;
            const end = (exit as any).portRangeEnd;
            if (start != null && end != null && (listenPort < start || listenPort > end)) {
              throw new Error(`出口监听端口必须在 ${start}-${end} 区间内`);
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
          const normalizedConnectHost = normalizeTunnelConnect(nextConnectHost);
          (data as any).networkType = normalizedConnectHost ? "private" : "public";
          (data as any).connectHost = normalizedConnectHost;
        }
        const nextMode = (data as any).mode ?? (tunnel as any).mode;
        if ((data as any).fxpVersion !== undefined && nextMode !== "forwardx") {
          (data as any).fxpVersion = 1;
        }
        (data as any).entryHostId = entryHostId;
        (data as any).exitHostId = exitHostId;
        const normalizedRequestedHopIds = hopHostIds ? hopHostIds : (switchToRegular ? [] : existingHopHostIds);
        const hopChanged = requestedHopHostIds !== undefined
          && JSON.stringify(normalizedRequestedHopIds) !== JSON.stringify(existingHopHostIds);
        const keyChanged = ["entryHostId", "exitHostId", "mode", "fxpVersion", "listenPort", "isEnabled", "portRangeStart", "portRangeEnd", "networkType", "connectHost", "blockHttp", "blockSocks", "blockTls"].some((key) => (data as any)[key] !== undefined && (data as any)[key] !== (tunnel as any)[key]) || hopChanged;
        const enabledChanged = (data as any).isEnabled !== undefined && (data as any).isEnabled !== (tunnel as any).isEnabled;
        if (keyChanged) (data as any).isRunning = false;
        await db.updateTunnel(id, data as any);
        if (hopHostIds) {
          const hops: { hostId: number; listenPort: number; connectHost?: string | null }[] = [];
          for (let i = 0; i < hopHostIds.length; i++) {
            let port = 0;
            if (i === hopHostIds.length - 1) {
              port = Number((data as any).listenPort) || Number((tunnel as any).listenPort) || 0;
            } else {
              const hopHost = await db.getHostById(hopHostIds[i]) as any;
              port = await db.findAvailableTunnelExitPort(hopHostIds[i], hopHost?.portRangeStart, hopHost?.portRangeEnd) ?? 0;
              if (!port) throw new Error(`涓绘満 ${hopHost?.name || hopHostIds[i]} 宸叉棤鍙敤绔彛`);
            }
            const rawConnectHost = i > 0 ? (hopConnectHosts[i] ?? null) : null;
            const normalizedHopConnectHost = rawConnectHost ? normalizeTunnelConnect(rawConnectHost) : null;
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
          pushTunnelEndpointRefresh({ ...tunnel, entryHostId, exitHostId }, "tunnel-updated");
          if (hopChanged) {
            const affectedHostIds = new Set<number>([...existingHopHostIds, ...normalizedRequestedHopIds]);
            for (const hostId of affectedHostIds) pushAgentRefresh(hostId, "tunnel-hop-updated");
          }
          if (tunnel.entryHostId !== entryHostId) pushAgentRefresh(tunnel.entryHostId, "tunnel-updated-old-entry");
          if (tunnel.exitHostId !== exitHostId) pushAgentRefresh(tunnel.exitHostId, "tunnel-updated-old-exit");
        }
        return { success: true, reset: keyChanged };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        pushTunnelEndpointRefresh(tunnel, "tunnel-deleted");
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
        if (!tunnel.isRunning) {
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
          const hops = await hopRepo.getTunnelHops(Number(tunnel.id));
          if (Array.isArray(hops) && hops.length >= 2) {
            targetPort = Number((hops[hops.length - 1] as any).listenPort) || 0;
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
              if (Array.isArray(hops) && hops.length > 0) {
                const repairedHops = hops.map((hop: any, idx: number) => ({
                  hostId: Number(hop.hostId),
                  listenPort: idx === hops.length - 1 ? targetPort : Number(hop.listenPort) || 0,
                  connectHost: String(hop.connectHost || "").trim() || null,
                }));
                await hopRepo.createTunnelHops(Number(tunnel.id), repairedHops);
              }
              appendPanelLog("warn", `[TunnelTest] tunnel=${tunnel.id} listenPort auto-assigned: ${targetPort}`);
              pushTunnelEndpointRefresh(tunnel as any, "tunnel-test-port-repair");
            }
          }
        }
        if (!target || !targetPort) {
          const message = `TUNNEL_TEST_TARGET_INVALID target=${target || "-"} port=${targetPort || "-"}`;
          await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
          await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true });
          appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid test target. exitHost=${exit.id} target=${target || "-"} port=${targetPort || "-"}`);
          return { success: false, latencyMs: null, message };
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
        const message = `TUNNEL_LINK_TEST_PENDING ${target}:${targetPort}`;
        await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
        appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-agent TCPing from entryHost=${entry.id} to exit ${target}:${targetPort}`);
        return { success: false, latencyMs: null, message, pending: true };
      }),
  });


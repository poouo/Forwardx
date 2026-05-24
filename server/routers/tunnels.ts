import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import crypto from "crypto";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { pushTunnelEndpointRefresh, requireHostAccess } from "./helpers";
import { requireTunnelProtocolEnabled } from "../forwardProtocolSettings";

export const tunnelsRouter = router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return isAdmin ? db.getTunnels() : db.getTunnelsForUser(ctx.user.id);
    }),
    listAll: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") throw new Error("无权访问");
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
        listenPort: z.number().min(0).max(65535).optional().default(0),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        if (input.portRangeStart != null && input.portRangeEnd != null && input.portRangeStart > input.portRangeEnd) {
          throw new Error("隧道可用端口范围起始值不能大于结束值");
        }
        if (input.entryHostId === input.exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        const entry = await requireHostAccess(ctx, input.entryHostId);
        const exit = await requireHostAccess(ctx, input.exitHostId);
        if (!entry || !exit) throw new Error("主机不存在");
        await requireTunnelProtocolEnabled(input);
        let listenPort = Number(input.listenPort) || 0;
        if (listenPort > 0) {
          const start = (exit as any).portRangeStart;
          const end = (exit as any).portRangeEnd;
          if (start != null && end != null && (listenPort < start || listenPort > end)) {
            throw new Error(`出口监听端口必须在 ${start}-${end} 区间内`);
          }
          const used = await db.isPortUsedOnHost(input.exitHostId, listenPort);
          if (used) throw new Error(`出口 Agent 端口 ${listenPort} 已被转发规则占用`);
          const tunnelUsed = await db.isTunnelListenPortUsed(input.exitHostId, listenPort);
          if (tunnelUsed) throw new Error(`出口 Agent 端口 ${listenPort} 已被其他隧道占用`);
        } else {
          listenPort = await db.findAvailableTunnelExitPort(
            input.exitHostId,
            (exit as any).portRangeStart,
            (exit as any).portRangeEnd,
          ) ?? 0;
          if (!listenPort) throw new Error("出口 Agent 已无可用隧道端口");
        }
        const secret = crypto.randomBytes(32).toString("hex");
        const id = await db.createTunnel({ ...input, portRangeStart: input.portRangeStart ?? null, portRangeEnd: input.portRangeEnd ?? null, listenPort, secret, userId: ctx.user.id } as any);
        pushTunnelEndpointRefresh({ id, entryHostId: input.entryHostId, exitHostId: input.exitHostId }, "tunnel-created");
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
        isEnabled: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        await requireTunnelProtocolEnabled({ ...tunnel, mode: input.mode ?? tunnel.mode });
        const entryHostId = input.entryHostId ?? tunnel.entryHostId;
        const exitHostId = input.exitHostId ?? tunnel.exitHostId;
        if (entryHostId === exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        await requireHostAccess(ctx, entryHostId);
        const exit = await requireHostAccess(ctx, exitHostId);
        const { id, ...data } = input;
        const nextPortRangeStart = (data as any).portRangeStart !== undefined ? (data as any).portRangeStart : (tunnel as any).portRangeStart;
        const nextPortRangeEnd = (data as any).portRangeEnd !== undefined ? (data as any).portRangeEnd : (tunnel as any).portRangeEnd;
        if (nextPortRangeStart != null && nextPortRangeEnd != null && nextPortRangeStart > nextPortRangeEnd) {
          throw new Error("隧道可用端口范围起始值不能大于结束值");
        }
        if ((data as any).listenPort !== undefined) {
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
        const keyChanged = ["entryHostId", "exitHostId", "mode", "listenPort", "isEnabled", "portRangeStart", "portRangeEnd"].some((key) => (data as any)[key] !== undefined && (data as any)[key] !== (tunnel as any)[key]);
        const enabledChanged = (data as any).isEnabled !== undefined && (data as any).isEnabled !== (tunnel as any).isEnabled;
        if (keyChanged) (data as any).isRunning = false;
        await db.updateTunnel(id, data as any);
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
        const target = String((exit as any).entryIp || (exit as any).ipv4 || (exit as any).ipv6 || exit.ip || "").trim();
        const targetPort = Number(tunnel.listenPort);
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

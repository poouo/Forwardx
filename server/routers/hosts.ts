import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "../db";
import { markHostMetricsWatching, pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { requireHostAccess } from "./helpers";

export const hostsRouter = router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      if (isAdmin) return db.getHosts();
      // 普通用户：返回自己创建的主机 + 普通授权主机 + 已授权的流量计费主机
      const [allowedHostIds, billingResourceIds] = await Promise.all([
        db.getUserAllowedHostIds(ctx.user.id),
        db.getUserUsableTrafficBillingResourceIds(ctx.user.id),
      ]);
      const allHosts = await db.getHosts();
      const allowedSet = new Set([...allowedHostIds, ...billingResourceIds.hostIds]);
      return allHosts.filter(h => allowedSet.has(h.id) || h.userId === ctx.user.id);
    }),
    /** 获取所有主机列表（管理员用，用于权限分配） */
    listAll: adminProcedure.query(async () => {
      return db.getHosts();
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) return null;
        if (ctx.user.role !== "admin") {
          if (host.userId !== ctx.user.id) {
            const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
            if (!hasPermission) return null;
          }
        }
        return host;
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: z.string().min(1).max(64),
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: z.string().max(32).optional(),
        entryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 验证端口区间
        if (input.portRangeStart != null && input.portRangeEnd != null) {
          if (input.portRangeStart > input.portRangeEnd) {
            throw new Error("端口区间起始值不能大于结束值");
          }
        }
        const agentToken = nanoid(32);
        const id = await db.createHost({
          ...input,
          agentToken,
          networkInterface: input.networkInterface || null,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: z.string().min(1).max(64).optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: z.string().max(32).nullable().optional(),
        entryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 验证端口区间
        const pStart = input.portRangeStart !== undefined ? input.portRangeStart : (host as any).portRangeStart;
        const pEnd = input.portRangeEnd !== undefined ? input.portRangeEnd : (host as any).portRangeEnd;
        if (pStart != null && pEnd != null && pStart > pEnd) {
          throw new Error("端口区间起始值不能大于结束值");
        }
        const { id, ...data } = input;
        await db.updateHost(id, data as any);
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 检查是否存在转发规则
        const ruleCount = await db.getHostRuleCount(input.id);
        if (ruleCount > 0) {
          throw new Error(`该主机下还有 ${ruleCount} 条转发规则，请先删除所有规则后再删除主机`);
        }
        await db.deleteHostPermissions(input.id);
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      .input(z.object({ hostId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return db.getLatestHostMetrics(input.hostId, input.limit);
      }),
    watchMetrics: protectedProcedure
      .input(z.object({ hostIds: z.array(z.number()).max(200) }))
      .mutation(async ({ input, ctx }) => {
        const allowed: number[] = [];
        for (const hostId of input.hostIds) {
          await requireHostAccess(ctx, hostId);
          allowed.push(hostId);
        }
        markHostMetricsWatching(allowed);
        for (const hostId of allowed) pushAgentRefresh(hostId, "metrics-watch");
        return { success: true, count: allowed.length };
      }),
    requestAgentUpgrade: adminProcedure
      .input(z.object({ hostId: z.number(), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        await db.requestHostAgentUpgrade(input.hostId, input.targetVersion ?? null);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        const pushed = pushAgentUpgrade(input.hostId, input.targetVersion ?? null, panelUrl);
        return { success: true, pushed };
      }),
  });

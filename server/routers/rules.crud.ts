import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { forwardTypeSchema } from "./schemas";
import { pushTunnelEndpointRefresh, requireHostUseAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";

export const crudRulesRouter = router({
  create: protectedProcedure
    .input(z.object({
      hostId: z.number(),
      name: z.string().min(1).max(128),
      forwardType: forwardTypeSchema.default("iptables"),
      protocol: z.enum(["tcp", "udp", "both"]).default("both"),
      gostMode: z.enum(["direct", "reverse"]).default("direct"),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      sourcePort: z.number().min(0).max(65535), // 0 = 随机分配
      targetIp: z.string().min(1).max(64),
      targetPort: z.number().min(1).max(65535),
    }))
    .mutation(async ({ input, ctx }) => {
      // 权限检查：管理员或有 canAddRules 权限的用户
      if (ctx.user.role !== "admin" && !ctx.user.canAddRules) {
        throw new Error("您没有添加转发规则的权限，请联系管理员开通");
      }
      // 转发方式权限检查：非管理员需在 allowedForwardTypes 列表中
      if (ctx.user.role !== "admin") {
        const allowedRaw = (ctx.user as any).allowedForwardTypes as string | null | undefined;
        if (allowedRaw !== null && allowedRaw !== undefined) {
          const allowed = new Set(allowedRaw.split(",").map(s => s.trim()).filter(Boolean));
          if (!allowed.has(input.forwardType)) throw new Error(`您没有使用 ${input.forwardType} 转发方式的权限，请联系管理员`);
        }
      }
      // 检查用户是否已到期
      if (ctx.user.expiresAt && new Date(ctx.user.expiresAt) <= new Date()) {
        throw new Error("您的账户已到期，无法添加规则");
      }

      // 检查用户规则数量限制
      const currentUser = await db.getUserById(ctx.user.id);
      if (currentUser && currentUser.maxRules > 0) {
        const ruleCount = await db.getUserRuleCount(ctx.user.id);
        if (ruleCount >= currentUser.maxRules) {
          throw new Error(`您已达到最大规则数量限制（${currentUser.maxRules} 条）`);
        }
      }
      // 检查用户端口数量限制
      if (currentUser && currentUser.maxPorts > 0) {
        const portCount = await db.getUserPortCount(ctx.user.id);
        if (portCount >= currentUser.maxPorts) {
          throw new Error(`您已达到最大端口数量限制（${currentUser.maxPorts} 个）`);
        }
      }

      const tunnelId = input.forwardType === "gost" && input.gostMode === "direct" ? input.tunnelId ?? null : null;
      let selectedTunnelForRule: any = null;
      let isTrafficBillingRule = false;
      if (tunnelId) {
        const access = await requireTunnelUseOrTrafficBillingAccess(ctx, tunnelId);
        selectedTunnelForRule = access.tunnel;
        isTrafficBillingRule = access.isTrafficBillingResource;
        if (!selectedTunnelForRule.isEnabled) throw new Error("Selected tunnel is disabled");
        if (selectedTunnelForRule.entryHostId !== input.hostId) {
          throw new Error("Tunnel entry host must match the rule host");
        }
        if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode).toLowerCase() === "forwardx" && !(currentUser as any)?.canAddRules) {
          throw new Error("No permission to use custom encrypted tunnels");
        }
      } else {
        const access = await requireHostUseAccess(ctx, input.hostId);
        isTrafficBillingRule = access.isTrafficBillingResource;
      }
      await requireRuleProtocolEnabled({ forwardType: input.forwardType, tunnelId }, selectedTunnelForRule);
      if (!isTrafficBillingRule && ctx.user.trafficLimit > 0 && ctx.user.trafficUsed >= ctx.user.trafficLimit) {
        throw new Error("您的流量已用完，无法添加规则");
      }
      const host = await db.getHostById(input.hostId);
      if (!host) throw new Error("主机不存在");
      const entryRangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : (host as any).portRangeStart;
      const entryRangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : (host as any).portRangeEnd;
      const planRange = ctx.user.role !== "admin"
        ? await db.getUserPlanPortRange(ctx.user.id, input.hostId, tunnelId ?? undefined)
        : null;
      const effectiveRangeStart = planRange ? Math.max(Number(entryRangeStart || planRange.start), planRange.start) : entryRangeStart;
      const effectiveRangeEnd = planRange ? Math.min(Number(entryRangeEnd || planRange.end), planRange.end) : entryRangeEnd;

      let sourcePort = input.sourcePort;
      // 源端口为 0 时随机分配
      if (sourcePort === 0) {
        const randomPort = await db.findAvailablePort(input.hostId, effectiveRangeStart, effectiveRangeEnd);
        if (!randomPort) throw new Error("该主机端口区间内已无可用端口");
        sourcePort = randomPort;
      } else {
        // 检查端口区间限制
        const rangeStart = effectiveRangeStart;
        const rangeEnd = effectiveRangeEnd;
        if (rangeStart != null && rangeEnd != null) {
          if (sourcePort < rangeStart || sourcePort > rangeEnd) {
            throw new Error(`源端口必须在 ${rangeStart}-${rangeEnd} 区间内`);
          }
        }
        // 检查端口是否已被占用
        const used = await db.isPortUsedOnHost(input.hostId, sourcePort);
        if (used) {
          throw new Error(`端口 ${sourcePort} 已被其他规则占用`);
        }
      }

      const gostRelayHost = input.forwardType === "gost" && input.gostMode === "reverse" ? (input.gostRelayHost || "").trim() : null;
      const gostRelayPort = input.forwardType === "gost" && input.gostMode === "reverse" ? input.gostRelayPort : null;
      let tunnelExitPort: number | null = null;
      if (input.forwardType === "gost" && input.gostMode === "reverse") {
        if (!gostRelayHost) throw new Error("反向隧道需要填写中继地址");
        if (!gostRelayPort) throw new Error("反向隧道需要填写中继端口");
      }

      if (tunnelId) {
        const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, tunnelId)).tunnel;
        if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
        if (tunnel.entryHostId !== input.hostId) {
          throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
        }
        const exit = await db.getHostById(tunnel.exitHostId);
        tunnelExitPort = await db.findAvailableTunnelExitPort(
          tunnel.exitHostId,
          (exit as any)?.portRangeStart,
          (exit as any)?.portRangeEnd,
        );
        if (!tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
      }

      const id = await db.createForwardRule({ ...input, sourcePort, gostRelayHost, gostRelayPort, tunnelId, tunnelExitPort, userId: ctx.user.id });
      if (tunnelId) {
        const tunnel = await db.getTunnelById(tunnelId);
        await db.updateTunnel(tunnelId, { isRunning: false } as any);
        if (tunnel) pushTunnelEndpointRefresh(tunnel, "forward-rule-created");
      }
      return { id, sourcePort };
    }),
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(128).optional(),
      forwardType: forwardTypeSchema.optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
      gostMode: z.enum(["direct", "reverse"]).optional(),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      tunnelExitPort: z.number().min(1).max(65535).nullable().optional(),
      sourcePort: z.number().min(1).max(65535).optional(),
      targetIp: z.string().min(1).max(64).optional(),
      targetPort: z.number().min(1).max(65535).optional(),
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      await requireRuleProtocolEnabled(rule);

      // 如果修改了源端口，检查端口区间和占用
      let selectedTunnelForRule: any = null;
      let nextTunnelIdForRule: number | null = null;
      let nextForwardTypeForRule = rule.forwardType;
      {
        const nextForwardType = input.forwardType ?? rule.forwardType;
        nextForwardTypeForRule = nextForwardType;
        const nextGostMode = input.gostMode ?? (rule as any).gostMode ?? "direct";
        nextTunnelIdForRule = nextForwardType === "gost" && nextGostMode === "direct"
          ? (input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId)
          : null;
        if (nextTunnelIdForRule) {
          const access = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelIdForRule);
          selectedTunnelForRule = access.tunnel;
          if (!selectedTunnelForRule.isEnabled) throw new Error("Selected tunnel is disabled");
          if (selectedTunnelForRule.entryHostId !== rule.hostId) {
            throw new Error("Tunnel entry host must match the rule host");
          }
          if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode).toLowerCase() === "forwardx") {
            const currentUser = await db.getUserById(ctx.user.id);
            if (!(currentUser as any)?.canAddRules) {
              throw new Error("No permission to use custom encrypted tunnels");
            }
          }
        }
      }
      await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardTypeForRule, tunnelId: nextTunnelIdForRule }, selectedTunnelForRule);
      if (!nextTunnelIdForRule) {
        await requireHostUseAccess(ctx, rule.hostId);
      }

      if (input.sourcePort && input.sourcePort !== rule.sourcePort) {
        const host = await db.getHostById(rule.hostId);
        if (host) {
          const rangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : (host as any).portRangeStart;
          const rangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : (host as any).portRangeEnd;
          if (rangeStart != null && rangeEnd != null) {
            if (input.sourcePort < rangeStart || input.sourcePort > rangeEnd) {
              throw new Error(`源端口必须在 ${rangeStart}-${rangeEnd} 区间内`);
            }
          }
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, rule.hostId, nextTunnelIdForRule || undefined);
            if (planRange && (input.sourcePort < planRange.start || input.sourcePort > planRange.end)) {
              throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 区间内`);
            }
          }
          const used = await db.isPortUsedOnHost(rule.hostId, input.sourcePort, rule.id);
          if (used) {
            throw new Error(`端口 ${input.sourcePort} 已被其他规则占用`);
          }
        }
      }

      const { id, ...data } = input;
      if ((data.forwardType ?? rule.forwardType) !== "gost") {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        (data as any).tunnelId = null;
      } else if ((data.gostMode ?? (rule as any).gostMode ?? "direct") === "reverse") {
        const relayHost = data.gostRelayHost !== undefined ? data.gostRelayHost : (rule as any).gostRelayHost;
        const relayPort = data.gostRelayPort !== undefined ? data.gostRelayPort : (rule as any).gostRelayPort;
        if (!relayHost) throw new Error("反向隧道需要填写中继地址");
        if (!relayPort) throw new Error("反向隧道需要填写中继端口");
        (data as any).tunnelId = null;
      } else {
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        const nextTunnelId = data.tunnelId !== undefined ? data.tunnelId : (rule as any).tunnelId;
        if (nextTunnelId) {
          const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId)).tunnel;
          if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
          if (tunnel.entryHostId !== rule.hostId) {
            throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
          }
          if (nextTunnelId !== (rule as any).tunnelId || !(rule as any).tunnelExitPort) {
            const exit = await db.getHostById(tunnel.exitHostId);
            (data as any).tunnelExitPort = await db.findAvailableTunnelExitPort(
              tunnel.exitHostId,
              (exit as any)?.portRangeStart,
              (exit as any)?.portRangeEnd,
            );
            if (!(data as any).tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
          }
        } else {
          (data as any).tunnelExitPort = null;
        }
      }
      // 关键字段变更时重置 isRunning
      const watchedFields: (keyof typeof data)[] = [
        "sourcePort",
        "targetIp",
        "targetPort",
        "forwardType",
        "protocol",
        "gostMode",
        "gostRelayHost",
        "gostRelayPort",
        "tunnelId",
        "tunnelExitPort",
      ];
      const keyFieldChanged = watchedFields.some((f) => {
        const v = data[f];
        return v !== undefined && v !== (rule as any)[f];
      });
      if (keyFieldChanged) {
        (data as any).isRunning = false;
        const affectedTunnelIds = new Set<number>();
        if ((rule as any).tunnelId) affectedTunnelIds.add((rule as any).tunnelId);
        if ((data as any).tunnelId) affectedTunnelIds.add((data as any).tunnelId);
        for (const affectedTunnelId of affectedTunnelIds) {
          const affectedTunnel = await db.getTunnelById(affectedTunnelId);
          await db.updateTunnel(affectedTunnelId, { isRunning: false } as any);
          if (affectedTunnel) pushTunnelEndpointRefresh(affectedTunnel, "forward-rule-updated");
        }
      }
      await db.updateForwardRule(id, data);
      return { success: true, reset: keyFieldChanged };
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (tunnel) pushTunnelEndpointRefresh(tunnel, "forward-rule-deleted");
      }
      await db.markForwardRulePendingDelete(input.id);
      pushAgentRefresh(rule.hostId, "forward-rule-deleted");
      return { success: true };
    }),
  toggle: protectedProcedure
    .input(z.object({ id: z.number(), isEnabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      await requireRuleProtocolEnabled(rule);
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (tunnel) pushTunnelEndpointRefresh(tunnel, "forward-rule-toggled");
      }
      if (input.isEnabled) {
        if (ctx.user.role !== "admin") {
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          if (activeTunnelId) {
            await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId);
          } else {
            await requireHostUseAccess(ctx, rule.hostId);
          }
        }
        await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false });
      } else {
        await db.toggleForwardRule(input.id, false);
      }
      return { success: true };
    })
});

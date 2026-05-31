import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { forwardTypeSchema } from "./schemas";
import { pushTunnelEndpointRefresh, requireHostUseAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";

async function requireForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  const check = await db.ensureUserForwardAccessReady(userId, options);
  if (!check.allowed) {
    throw new Error(check.message || "转发权限已暂停，请续费后再启用规则");
  }
  return check.user || await db.getUserById(userId);
}

export const crudRulesRouter = router({
  create: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      name: z.string().min(1).max(128),
      forwardType: forwardTypeSchema.default("iptables"),
      protocol: z.enum(["tcp", "udp", "both"]).default("both"),
      gostMode: z.enum(["direct", "reverse"]).default("direct"),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().min(0).max(65535), // 0 = 随机分配
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ),
      targetPort: z.number().min(1).max(65535),
    }))
    .mutation(async ({ input, ctx }) => {
      // 权限检查：管理员或有 canAddRules 权限的用户
      let currentUser = await db.getUserById(ctx.user.id);
      // 转发方式权限检查：非管理员需在 allowedForwardTypes 列表中
      if (ctx.user.role !== "admin") {
        const allowedRaw = (ctx.user as any).allowedForwardTypes as string | null | undefined;
        if (allowedRaw !== null && allowedRaw !== undefined) {
          const allowed = new Set(allowedRaw.split(",").map(s => s.trim()).filter(Boolean));
          if (!allowed.has(input.forwardType)) throw new Error(`您没有使用 ${input.forwardType} 转发方式的权限，请联系管理员`);
        }
      }
      if (input.forwardGroupId) {
        if (input.sourcePort === 0) throw new Error("转发组规则需要指定固定入口端口");
        const sourcePort = input.sourcePort;
        if (ctx.user.role !== "admin") {
          currentUser = await requireForwardAccessReady(ctx.user.id);
          if (currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
            throw new Error("您的账户已到期，无法添加规则");
          }
          if (currentUser && currentUser.maxRules > 0) {
            const ruleCount = await db.getUserRuleCount(ctx.user.id);
            if (ruleCount >= currentUser.maxRules) {
              throw new Error(`您已达到最大规则数量限制（${currentUser.maxRules} 条）`);
            }
          }
          if (currentUser && currentUser.maxPorts > 0) {
            const portCount = await db.getUserPortCount(ctx.user.id);
            if (portCount >= currentUser.maxPorts) {
              throw new Error(`您已达到最大端口数量限制（${currentUser.maxPorts} 个）`);
            }
          }
        }
        if (ctx.user.role !== "admin") {
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, input.forwardGroupId);
          if (!hasPermission) throw new Error("无权使用该转发组");
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
          if (planRange && (sourcePort < planRange.start || sourcePort > planRange.end)) {
            throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(input.forwardGroupId, { sourcePort });
        const hostId = await db.getForwardGroupDefaultHostId(input.forwardGroupId);
        const forwardType = (group as any).groupType === "tunnel" ? "gost" : input.forwardType;
        if (ctx.user.role !== "admin") {
          const allowedRaw = (ctx.user as any).allowedForwardTypes as string | null | undefined;
          if (allowedRaw !== null && allowedRaw !== undefined) {
            const allowed = new Set(allowedRaw.split(",").map(s => s.trim()).filter(Boolean));
            if (!allowed.has(forwardType)) throw new Error(`您没有使用 ${forwardType} 转发方式的权限，请联系管理员`);
          }
        }
        await requireRuleProtocolEnabled({ forwardType, tunnelId: null });
        const id = await db.createForwardRule({
          hostId,
          name: input.name,
          forwardType,
          protocol: input.protocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId: input.forwardGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          targetIp: input.targetIp.trim(),
          targetPort: input.targetPort,
          isRunning: false,
          userId: ctx.user.id,
        } as any);
        await db.syncForwardGroupRules(input.forwardGroupId);
        return { id, sourcePort };
      }

      if (!input.hostId) throw new Error("请选择所属主机");
      const tunnelId = input.forwardType === "gost" ? input.tunnelId ?? null : null;
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
      } else {
        const access = await requireHostUseAccess(ctx, input.hostId);
        isTrafficBillingRule = access.isTrafficBillingResource;
      }
      if (ctx.user.role !== "admin") {
        currentUser = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
        if (String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx" && !(currentUser as any)?.canAddRules) {
          throw new Error("No permission to use custom encrypted tunnels");
        }
      }
      // 检查用户是否已到期
      if (ctx.user.role !== "admin" && currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
        throw new Error("您的账户已到期，无法添加规则");
      }

      // 检查用户规则数量限制
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
      await requireRuleProtocolEnabled({ forwardType: input.forwardType, tunnelId }, selectedTunnelForRule);
      if (!isTrafficBillingRule && Number((currentUser as any)?.trafficLimit || 0) > 0 && Number((currentUser as any)?.trafficUsed || 0) >= Number((currentUser as any)?.trafficLimit || 0)) {
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

      const gostRelayHost = null;
      const gostRelayPort = null;
      let tunnelExitPort: number | null = null;

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

      const id = await db.createForwardRule({ ...input, sourcePort, gostMode: "direct", gostRelayHost, gostRelayPort, tunnelId, tunnelExitPort, userId: ctx.user.id });
      if (tunnelId) {
        const tunnel = await db.getTunnelById(tunnelId);
        await db.updateTunnel(tunnelId, { isRunning: false } as any);
        if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-created");
      }
      return { id, sourcePort };
    }),
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      hostId: z.number().optional(),
      name: z.string().min(1).max(128).optional(),
      forwardType: forwardTypeSchema.optional(),
      protocol: z.enum(["tcp", "udp", "both"]).optional(),
      gostMode: z.enum(["direct", "reverse"]).optional(),
      gostRelayHost: z.string().max(128).nullable().optional(),
      gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
      tunnelId: z.number().nullable().optional(),
      tunnelExitPort: z.number().min(1).max(65535).nullable().optional(),
      forwardGroupId: z.number().nullable().optional(),
      sourcePort: z.number().min(1).max(65535).optional(),
      targetIp: z.string().min(1).max(253).refine(
        (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
        "请输入有效的 IP 地址或域名"
      ).optional(),
      targetPort: z.number().min(1).max(65535).optional(),
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接修改");

      if ((rule as any).isForwardGroupTemplate) {
        const groupId = Number((rule as any).forwardGroupId || 0);
        if (!groupId) throw new Error("转发组不存在");
        if (ctx.user.role !== "admin") {
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, groupId);
          if (!hasPermission) throw new Error("无权修改该转发组规则");
          const nextSourcePort = input.sourcePort ?? rule.sourcePort;
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, groupId);
          if (planRange && (nextSourcePort < planRange.start || nextSourcePort > planRange.end)) {
            throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(groupId, {
          sourcePort: input.sourcePort ?? rule.sourcePort,
          excludeTemplateRuleId: rule.id,
        });
        const nextForwardType = (group as any).groupType === "tunnel" ? "gost" : (input.forwardType ?? rule.forwardType);
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const data: any = {
          ...input,
          forwardType: nextForwardType,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId: groupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
        };
        delete data.id;
        delete data.hostId;
        const watchedFields = ["sourcePort", "targetIp", "targetPort", "forwardType", "protocol"] as const;
        const keyFieldChanged = watchedFields.some((field) => data[field] !== undefined && data[field] !== (rule as any)[field]);
        if (keyFieldChanged || data.isEnabled !== undefined) data.isRunning = false;
        await db.updateForwardRule(input.id, data);
        await db.syncForwardGroupRules(groupId);
        return { success: true, reset: keyFieldChanged };
      }

      await requireRuleProtocolEnabled(rule);

      // 如果修改了源端口，检查端口区间和占用
      let selectedTunnelForRule: any = null;
      let nextTunnelIdForRule: number | null = null;
      let nextForwardTypeForRule = rule.forwardType;
      let nextHostIdForRule = Number(input.hostId ?? rule.hostId);
      {
        const nextForwardType = input.forwardType ?? rule.forwardType;
        nextForwardTypeForRule = nextForwardType;
        nextTunnelIdForRule = nextForwardType === "gost"
          ? (input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId)
          : null;
        if (nextTunnelIdForRule) {
          const access = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelIdForRule);
          selectedTunnelForRule = access.tunnel;
          if (!selectedTunnelForRule.isEnabled) throw new Error("Selected tunnel is disabled");
          nextHostIdForRule = Number(selectedTunnelForRule.entryHostId);
          if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode).toLowerCase() === "forwardx") {
            const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!access.isTrafficBillingResource });
            if (!(owner as any)?.canAddRules) {
              throw new Error("No permission to use custom encrypted tunnels");
            }
          }
        }
      }
      const nextIsTunnelForward = nextForwardTypeForRule === "gost" && Number(nextTunnelIdForRule || 0) > 0;
      const currentIsTunnelForward = rule.forwardType === "gost" && Number((rule as any).tunnelId || 0) > 0;
      if (currentIsTunnelForward !== nextIsTunnelForward) {
        throw new Error("端口转发和隧道转发不能相互切换，请新建规则");
      }
      await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardTypeForRule, tunnelId: nextTunnelIdForRule }, selectedTunnelForRule);
      if (!nextTunnelIdForRule) {
        await requireHostUseAccess(ctx, nextHostIdForRule);
      }

      if (input.isEnabled === true && ctx.user.role !== "admin") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        const resourceAccess = activeTunnelId
          ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
          : await requireHostUseAccess(ctx, nextHostIdForRule);
        const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
        if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
          throw new Error("套餐已到期，请续费后再启用规则");
        }
      }

      const nextSourcePortForRule = input.sourcePort ?? rule.sourcePort;
      const shouldCheckSourcePort = input.sourcePort !== undefined
        || Number(nextHostIdForRule) !== Number(rule.hostId)
        || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      if (shouldCheckSourcePort) {
        const host = await db.getHostById(nextHostIdForRule);
        if (host) {
          const rangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : (host as any).portRangeStart;
          const rangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : (host as any).portRangeEnd;
          if (rangeStart != null && rangeEnd != null) {
            if (nextSourcePortForRule < rangeStart || nextSourcePortForRule > rangeEnd) {
              throw new Error(`源端口必须在 ${rangeStart}-${rangeEnd} 区间内`);
            }
          }
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostIdForRule, nextTunnelIdForRule || undefined);
            if (planRange && (nextSourcePortForRule < planRange.start || nextSourcePortForRule > planRange.end)) {
              throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 区间内`);
            }
          }
          const used = await db.isPortUsedOnHost(nextHostIdForRule, nextSourcePortForRule, rule.id);
          if (used) {
            throw new Error(`端口 ${nextSourcePortForRule} 已被其他规则占用`);
          }
        }
      }

      const { id, ...data } = input;
      (data as any).hostId = nextHostIdForRule;
      if ((data.forwardType ?? rule.forwardType) !== "gost") {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        (data as any).tunnelId = null;
        (data as any).tunnelExitPort = null;
      } else {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        const nextTunnelId = data.tunnelId !== undefined ? data.tunnelId : (rule as any).tunnelId;
        if (nextTunnelId) {
          const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId)).tunnel;
          if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
          if (Number(tunnel.entryHostId) !== Number(nextHostIdForRule)) {
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
      if (data.isEnabled === true) {
        const sourcePort = Number(data.sourcePort ?? rule.sourcePort);
        const used = await db.isPortUsedOnHost(nextHostIdForRule, sourcePort, rule.id);
        if (used) throw new Error(`端口 ${sourcePort} 已被占用，请更换端口后再启用`);
        (data as any).disabledByUser = false;
        (data as any).disabledByTunnel = false;
        (data as any).protocolBlockReason = null;
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
        "hostId",
      ];
      const keyFieldChanged = watchedFields.some((f) => {
        const v = data[f];
        return v !== undefined && v !== (rule as any)[f];
      });
      const oldHostIdForRule = Number(rule.hostId);
      const hostChanged = Number(oldHostIdForRule) !== Number(nextHostIdForRule);
      if (keyFieldChanged) {
        (data as any).isRunning = false;
        const affectedTunnelIds = new Set<number>();
        if ((rule as any).tunnelId) affectedTunnelIds.add((rule as any).tunnelId);
        if ((data as any).tunnelId) affectedTunnelIds.add((data as any).tunnelId);
        for (const affectedTunnelId of affectedTunnelIds) {
          const affectedTunnel = await db.getTunnelById(affectedTunnelId);
          await db.updateTunnel(affectedTunnelId, { isRunning: false } as any);
          if (affectedTunnel) await pushTunnelEndpointRefresh(affectedTunnel, "forward-rule-updated");
        }
      }
      await db.updateForwardRule(id, data);
      if (keyFieldChanged) {
        if (hostChanged) {
          pushAgentRefresh(oldHostIdForRule, "forward-rule-updated-old-host");
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated-new-host");
        } else if (!nextTunnelIdForRule) {
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated");
        }
      }
      return { success: true, reset: keyFieldChanged };
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接删除");
      if ((rule as any).isForwardGroupTemplate) {
        const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
        for (const child of childRules as any[]) {
          if ((child as any).tunnelId) {
            const tunnel = await db.getTunnelById((child as any).tunnelId);
            await db.updateTunnel((child as any).tunnelId, { isRunning: false } as any);
            if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-group-rule-deleted");
          }
          await db.markForwardRulePendingDelete(Number(child.id));
          pushAgentRefresh(Number(child.hostId), "forward-group-rule-deleted");
        }
        await db.markForwardRulePendingDelete(input.id);
        return { success: true };
      }
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-deleted");
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
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接开关");
      if ((rule as any).isForwardGroupTemplate) {
        if (ctx.user.role !== "admin") {
          const groupId = Number((rule as any).forwardGroupId || 0);
          const hasPermission = groupId ? await db.checkUserForwardGroupPermission(ctx.user.id, groupId) : false;
          if (!hasPermission) throw new Error("无权操作该转发组规则");
          if (input.isEnabled) {
            const owner = await requireForwardAccessReady(ctx.user.id);
            if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("套餐已到期，请续费后再启用规则");
            }
          }
        }
        if (input.isEnabled) {
          const groupId = Number((rule as any).forwardGroupId || 0);
          await db.validateForwardGroupRuleConfig(groupId, {
            sourcePort: rule.sourcePort,
            excludeTemplateRuleId: rule.id,
          });
          await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, protocolBlockReason: null } as any);
        } else {
          await db.toggleForwardRule(input.id, false);
        }
        await db.syncForwardGroupRules(Number((rule as any).forwardGroupId));
        return { success: true };
      }
      await requireRuleProtocolEnabled(rule);
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-toggled");
      }
      if (input.isEnabled) {
        if (ctx.user.role !== "admin") {
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          const resourceAccess = activeTunnelId
            ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
            : await requireHostUseAccess(ctx, rule.hostId);
          const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
          if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
            throw new Error("套餐已到期，请续费后再启用规则");
          }
        }
        const used = await db.isPortUsedOnHost(rule.hostId, rule.sourcePort, rule.id);
        if (used) throw new Error(`端口 ${rule.sourcePort} 已被占用，请更换端口后再启用`);
        await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, protocolBlockReason: null } as any);
      } else {
        await db.toggleForwardRule(input.id, false);
      }
      return { success: true };
    })
});

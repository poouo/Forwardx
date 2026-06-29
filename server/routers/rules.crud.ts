import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { forwardTypeSchema } from "./schemas";
import { pushTunnelEndpointRefresh, refreshUserForwardEndpoints, requireHostUseAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { isTelegramBotReady } from "../telegramReady";

const targetHostSchema = z.string().min(1).max(253).refine(
  (v) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(v.trim()),
  "请输入有效的 IP 地址或域名"
);

const failoverTargetSchema = z.object({
  targetIp: z.string().max(253).optional().default(""),
  targetPort: z.number().int().min(0).max(65535).optional().default(0),
});
const strictFailoverTargetSchema = z.object({
  targetIp: targetHostSchema,
  targetPort: z.number().int().min(1).max(65535),
});
const failoverStrategySchema = z.enum(["fallback", "round_robin", "random", "ip_hash"]);
const MAX_FAILOVER_TARGETS = 10;

const failoverInputShape = {
  failoverEnabled: z.boolean().optional(),
  failoverStrategy: failoverStrategySchema.optional(),
  failoverTargets: z.array(failoverTargetSchema).max(MAX_FAILOVER_TARGETS).optional(),
  failoverSeconds: z.number().int().min(10).max(3600).optional(),
  recoverSeconds: z.number().int().min(10).max(3600).optional(),
  autoFailback: z.boolean().optional(),
} as const;

const proxyProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);

const proxyProtocolInputShape = {
  proxyProtocolReceive: z.boolean().optional(),
  proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(),
  proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: proxyProtocolVersionSchema.optional(),
} as const;

const transportTuningInputShape = {
  tcpFastOpen: z.boolean().optional(),
  zeroCopy: z.boolean().optional(),
  udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: z.number().int().min(0).max(65535).nullable().optional(),
} as const;

async function requireRuleTelegramNotifyReady(enabled?: boolean) {
  if (!enabled) return;
  if (!(await isTelegramBotReady())) {
    throw new Error("请先在系统设置中配置并启用 Telegram 机器人，再开启异常TG提醒");
  }
}

type FailoverInput = {
  failoverEnabled?: boolean;
  failoverStrategy?: z.infer<typeof failoverStrategySchema>;
  failoverTargets?: Array<{ targetIp?: string; targetPort?: number }>;
  failoverSeconds?: number;
  recoverSeconds?: number;
  autoFailback?: boolean;
};

function parseFailoverTargets(raw: unknown) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target) => ({ targetIp: String(target?.targetIp || "").trim(), targetPort: Number(target?.targetPort) }))
      .filter((target) => target.targetIp && target.targetPort >= 1 && target.targetPort <= 65535)
      .slice(0, MAX_FAILOVER_TARGETS);
  } catch {
    return [];
  }
}

function normalizeFailoverInput(input: FailoverInput, protocol?: string | null) {
  const enabled = !!input.failoverEnabled;
  const targets: Array<{ targetIp: string; targetPort: number }> = [];
  if (enabled && protocol && protocol !== "tcp") {
    throw new Error("主备模式当前仅支持 TCP 协议");
  }
  if (enabled) {
    for (const target of input.failoverTargets || []) {
      const targetIp = String(target.targetIp || "").trim();
      const targetPort = Number(target.targetPort || 0);
      if (!targetIp && !targetPort) continue;
      if (!targetIp || !targetPort) {
        throw new Error("备用出站需要同时填写地址和端口，完全空白的行可以保留");
      }
      const parsed = strictFailoverTargetSchema.safeParse({ targetIp, targetPort });
      if (!parsed.success) throw new Error("备用出站地址或端口格式不正确");
      targets.push(parsed.data);
      if (targets.length >= MAX_FAILOVER_TARGETS) break;
    }
  }
  if (enabled && targets.length === 0) {
    throw new Error("开启主备模式后至少需要配置一个备用出站");
  }
  return {
    failoverEnabled: enabled,
    failoverStrategy: input.failoverStrategy || "fallback",
    failoverTargets: enabled ? JSON.stringify(targets) : null,
    failoverSeconds: input.failoverSeconds ?? 60,
    recoverSeconds: input.recoverSeconds ?? 120,
    autoFailback: input.autoFailback ?? true,
  };
}

function normalizeProxyProtocolInput(input: {
  proxyProtocolReceive?: boolean;
  proxyProtocolSend?: boolean;
  proxyProtocolExitReceive?: boolean;
  proxyProtocolExitSend?: boolean;
  proxyProtocolVersion?: number;
  failoverEnabled?: boolean;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const forwardTypeSupported = forwardType === "gost" || forwardType === "realm";
  const tunnelRoute = !!options?.tunnelRoute;
  const receive = !isForwardChain && protocolSupported && forwardTypeSupported && !!input.proxyProtocolReceive;
  const send = !isForwardChain && protocolSupported && forwardTypeSupported && !!input.proxyProtocolSend;
  const tunnelProxySupported = tunnelRoute && forwardType === "gost";
  const exitReceive = tunnelProxySupported && !isForwardChain && protocolSupported && !!input.proxyProtocolExitReceive;
  const exitSend = tunnelProxySupported && !isForwardChain && protocolSupported && !!input.proxyProtocolExitSend;
  const version = Number(input.proxyProtocolVersion) === 2 ? 2 : 1;
  if (!receive && !send && !exitReceive && !exitSend) {
    if (clearUnsupported) return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
    if ((input.proxyProtocolReceive || input.proxyProtocolSend || input.proxyProtocolExitReceive || input.proxyProtocolExitSend) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("PROXY Protocol 仅支持 TCP 协议");
    }
    if ((input.proxyProtocolReceive || input.proxyProtocolSend || input.proxyProtocolExitReceive || input.proxyProtocolExitSend) && !forwardTypeSupported) {
      throw new Error("PROXY Protocol 仅支持 GOST 端口转发、GOST 隧道和自定义加密隧道");
    }
    return {
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
    };
  }
  return {
    proxyProtocolReceive: receive,
    proxyProtocolSend: send,
    proxyProtocolExitReceive: exitReceive,
    proxyProtocolExitSend: exitSend,
    proxyProtocolVersion: version,
  };
}
function normalizeTransportTuningInput(input: {
  tcpFastOpen?: boolean;
  zeroCopy?: boolean;
  udpOverTcp?: boolean;
  udpOverTcpPort?: number | null;
}, protocol?: string | null, forwardType?: string | null, isForwardChain?: boolean, options?: { clearUnsupported?: boolean; tunnelRoute?: boolean; forwardxTunnel?: boolean }) {
  const clearUnsupported = options?.clearUnsupported ?? false;
  const protocolSupported = !protocol || protocol === "tcp" || protocol === "both";
  const udpOverTcpProtocolSupported = protocol === "udp" || protocol === "both";
  const tunnelRoute = !!options?.tunnelRoute;
  const forwardxTunnel = !!options?.forwardxTunnel;
  const fastOpenSupported = !isForwardChain && protocolSupported && (
    forwardType === "realm" || (forwardType === "gost" && tunnelRoute && forwardxTunnel)
  );
  const zeroCopySupported = !isForwardChain && protocolSupported && forwardType === "realm" && !tunnelRoute;
  const udpOverTcpSupported = !isForwardChain && udpOverTcpProtocolSupported && forwardType === "gost" && tunnelRoute && forwardxTunnel;
  const tcpFastOpen = fastOpenSupported && !!input.tcpFastOpen;
  const zeroCopy = zeroCopySupported && !!input.zeroCopy;
  const udpOverTcp = udpOverTcpSupported && !!input.udpOverTcp;
  if (input.udpOverTcp && !udpOverTcpSupported && !clearUnsupported) {
    if (protocol !== "udp" && protocol !== "both") {
      throw new Error("UDP 混淆仅支持 UDP 或 TCP+UDP 规则");
    }
    throw new Error("UDP 混淆仅支持 ForwardX 自定义加密隧道的 UDP/TCP+UDP 规则");
  }
  if (!tcpFastOpen && !zeroCopy && !udpOverTcp) {
    if (clearUnsupported) return { tcpFastOpen: false, zeroCopy: false, udpOverTcp: false, udpOverTcpPort: null };
    if ((input.tcpFastOpen || input.zeroCopy) && protocol && protocol !== "tcp" && protocol !== "both") {
      throw new Error("TCP Fast Open 和 zero-copy 仅支持 TCP 协议");
    }
    if (input.tcpFastOpen && !fastOpenSupported) {
      throw new Error("当前转发方式不支持 TCP Fast Open");
    }
    if (input.zeroCopy && !zeroCopySupported) {
      throw new Error("当前转发方式不支持 zero-copy");
    }
  }
  return { tcpFastOpen, zeroCopy, udpOverTcp, udpOverTcpPort: null };
}

function normalizeRuleTargetIp(input: string, _options: { tunnelId?: number | null }) {
  return String(input || "").trim();
}

function isNginxTLSTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "nginx_tls";
}

function assertNginxTunnelProtocolAllowed(tunnel: any, protocol: string | null | undefined) {
  if (!isNginxTLSTunnel(tunnel)) return;
  if (String(protocol || "tcp").toLowerCase() !== "tcp") {
    throw new Error("Nginx TLS 隧道仅支持 TCP，UDP 请使用 Nginx Stream 隧道");
  }
}

function isFailoverHotUpdate(input: Record<string, unknown>, rule: any, nextHostId: number, nextTunnelId: number | null) {
  const changedFields = [
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
    "failoverEnabled",
    "failoverStrategy",
    "failoverTargets",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
  ].filter((field) => input[field] !== undefined && input[field] !== rule?.[field]);
  if (changedFields.length === 0) return false;
  if (!rule?.isEnabled || !rule?.isRunning || !rule?.failoverEnabled) return false;
  if (input.failoverEnabled === false) return false;
  if (String(input.forwardType ?? rule.forwardType) !== "gost") return false;
  if (String(input.protocol ?? rule.protocol) !== "tcp") return false;
  if (Number(nextHostId) !== Number(rule.hostId)) return false;
  if (Number(nextTunnelId || 0) !== Number(rule.tunnelId || 0)) return false;

  const hotFields = new Set([
    "targetIp",
    "targetPort",
    "failoverStrategy",
    "failoverTargets",
    "failoverSeconds",
    "recoverSeconds",
    "autoFailback",
  ]);
  return changedFields.every((field) => hotFields.has(field));
}

export function requireMainBackupAllowed(options: {
  enabled?: boolean;
  protocol?: string | null;
  forwardType?: string | null;
  tunnelId?: number | null;
  isTunnelRoute?: boolean;
  isAdmin: boolean;
}) {
  if (!options.enabled) return;
  if (options.protocol && options.protocol !== "tcp") {
    throw new Error("主备模式当前仅支持 TCP 协议");
  }
  if (options.forwardType !== "gost") {
    throw new Error("主备模式仅支持 GOST 端口转发、GOST 隧道和自定义加密隧道");
  }
  const isTunnelRoute = !!options.isTunnelRoute || Number(options.tunnelId || 0) > 0;
  if (!options.isAdmin && !isTunnelRoute) {
    throw new Error("普通用户的普通端口转发不支持主备模式，请使用隧道转发或联系管理员");
  }
}

async function requireForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  const check = await db.ensureUserForwardAccessReady(userId, options);
  if (!check.allowed) {
    throw new Error(check.message || "转发权限已暂停，请续费后再启用规则");
  }
  return check.user || await db.getUserById(userId);
}

async function requireTrafficBillingBalanceForRule(userId: number, isTrafficBillingRule: boolean, message = "流量计费余额不足，请充值后再使用该计费资源") {
  if (!isTrafficBillingRule) return;
  const user = await db.getUserById(userId);
  if (Number((user as any)?.balanceCents || 0) <= 0) {
    throw new Error(message);
  }
}

async function isForwardGroupTrafficBillingRule(group: any, userId: number) {
  if (!group || String((group as any).groupMode || "failover") === "chain") return false;
  const members = Array.isArray((group as any).members) ? (group as any).members : [];
  for (const member of members) {
    if (!member?.isEnabled) continue;
    const resourceType = member.memberType === "tunnel" ? "tunnel" : member.memberType === "host" ? "host" : null;
    const resourceId = resourceType === "tunnel" ? Number(member.tunnelId || 0) : resourceType === "host" ? Number(member.hostId || 0) : 0;
    if (!resourceType || resourceId <= 0) continue;
    const config = await db.findTrafficBillingConfig(resourceType, resourceId);
    if (config) return true;
  }
  return false;
}

async function assertRulePortWithinEntryPolicy(options: {
  hostId: number;
  sourcePort: number;
  tunnelId?: number | null;
  tunnel?: any;
}) {
  const port = Number(options.sourcePort || 0);
  if (!port) return;
  let policy = portPolicyFrom(null);
  if (Number(options.tunnelId || 0) > 0) {
    const tunnel = options.tunnel || await db.getTunnelById(Number(options.tunnelId));
    const entryHost = await db.getHostById(Number((tunnel as any)?.entryHostId || options.hostId));
    policy = combinePortPolicies(
      portPolicyFrom(entryHost as any),
      portPolicyFrom({
        portRangeStart: (tunnel as any)?.portRangeStart,
        portRangeEnd: (tunnel as any)?.portRangeEnd,
      }),
    );
  } else {
    const host = await db.getHostById(Number(options.hostId));
    policy = portPolicyFrom(host as any);
  }
  if (!isPortAllowedByPolicy(port, policy)) {
    throw new Error(portPolicyErrorMessage(policy, "入口端口"));
  }
}

async function settleTrafficBillingForDeletedRule(rule: any) {
  const tunnelId = Number(rule?.tunnelId || 0);
  const billed = await db.settleTrafficBillingRuleOnDelete({
    userId: Number(rule.userId),
    ruleId: Number(rule.id),
    resourceType: tunnelId > 0 ? "tunnel" : "host",
    resourceId: tunnelId > 0 ? tunnelId : Number(rule.hostId),
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await db.setUserForwardAccess(Number(rule.userId), false, "traffic_billing_balance");
    await refreshUserForwardEndpoints(Number(rule.userId), "traffic-billing-delete-balance-negative");
  }
  return billed;
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
      telegramErrorNotifyEnabled: z.boolean().optional().default(false),
      blockHttp: z.boolean().optional(),
      blockSocks: z.boolean().optional(),
      blockTls: z.boolean().optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);
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
        const isForwardChain = (group as any).groupMode === "chain";
        if (ctx.user.role !== "admin") {
          const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
          await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
        }
        if (isForwardChain && input.failoverEnabled) {
          throw new Error("端口转发链不支持出站策略");
        }
        const hostId = await db.getForwardGroupDefaultHostId(input.forwardGroupId);
        const forwardType = !isForwardChain && (group as any).groupType === "tunnel" ? "gost" : input.forwardType;
        requireMainBackupAllowed({
          enabled: isForwardChain ? false : input.failoverEnabled,
          protocol: input.protocol,
          forwardType,
          isTunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
          isAdmin: ctx.user.role === "admin",
        });
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
          targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: forwardType === "gost" && !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }),
          targetPort: input.targetPort,
          telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          ...normalizeProxyProtocolInput(
            input,
            input.protocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" },
          ),
          ...normalizeTransportTuningInput(
            input,
            input.protocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false },
          ),
          ...normalizeFailoverInput(isForwardChain ? { failoverEnabled: false, failoverTargets: [] } : input, input.protocol),
          isRunning: false,
          userId: ctx.user.id,
        } as any);
        await db.syncForwardGroupRules(input.forwardGroupId);
        await db.runForwardGroupFailover(input.forwardGroupId);
        return { id, sourcePort };
      }

      if (!input.hostId) throw new Error("请选择所属主机");
      const tunnelId = input.forwardType === "gost" ? input.tunnelId ?? null : null;
      requireMainBackupAllowed({
        enabled: input.failoverEnabled,
        protocol: input.protocol,
        forwardType: input.forwardType,
        tunnelId,
        isAdmin: ctx.user.role === "admin",
      });
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
        assertNginxTunnelProtocolAllowed(selectedTunnelForRule, input.protocol);
      } else {
        const access = await requireHostUseAccess(ctx, input.hostId);
        isTrafficBillingRule = access.isTrafficBillingResource;
      }
      if (ctx.user.role !== "admin") {
        currentUser = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
        await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
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
      const entryPolicy = selectedTunnelForRule
        ? combinePortPolicies(
          portPolicyFrom(host as any),
          portPolicyFrom({
            portRangeStart: (selectedTunnelForRule as any).portRangeStart,
            portRangeEnd: (selectedTunnelForRule as any).portRangeEnd,
          }),
        )
        : portPolicyFrom(host as any);
      const planRange = ctx.user.role !== "admin"
        ? await db.getUserPlanPortRange(ctx.user.id, input.hostId, tunnelId ?? undefined)
        : null;
      const effectivePolicy = planRange
        ? combinePortPolicies(entryPolicy, portPolicyFrom({ portRangeStart: planRange.start, portRangeEnd: planRange.end }))
        : entryPolicy;

      let sourcePort = input.sourcePort;
      // 源端口为 0 时随机分配
      if (sourcePort === 0) {
        let randomRangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : null;
        let randomRangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : null;
        if (planRange) {
          randomRangeStart = Math.max(Number(randomRangeStart || planRange.start), planRange.start);
          randomRangeEnd = Math.min(Number(randomRangeEnd || planRange.end), planRange.end);
        }
        const randomPort = await db.findAvailablePort(input.hostId, randomRangeStart, randomRangeEnd);
        if (!randomPort) throw new Error("该主机端口区间内已无可用端口");
        sourcePort = randomPort;
      } else {
        if (!isPortAllowedByPolicy(sourcePort, effectivePolicy)) {
          throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
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

      const transportTuning = normalizeTransportTuningInput(input, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId, forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx" });

      const id = await db.createForwardRule({
        ...input,
        ...normalizeFailoverInput(input, input.protocol),
        ...normalizeProxyProtocolInput(input, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId }),
        ...transportTuning,
        telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
        blockHttp: false,
        blockSocks: false,
        blockTls: false,
        sourcePort,
        targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId }),
        gostMode: "direct",
        gostRelayHost,
        gostRelayPort,
        tunnelId,
        tunnelExitPort,
        userId: ctx.user.id,
      });
      if (tunnelId) {
        const tunnel = await db.getTunnelById(tunnelId);
        if (tunnel) await db.reconcileForwardRuleTunnelExits({ ...input, id, tunnelExitPort, sourcePort, tunnelId }, tunnel);
      }
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
      telegramErrorNotifyEnabled: z.boolean().optional(),
      blockHttp: z.boolean().optional(),
      blockSocks: z.boolean().optional(),
      blockTls: z.boolean().optional(),
      ...failoverInputShape,
      ...proxyProtocolInputShape,
      ...transportTuningInputShape,
      isEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接修改");
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);

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
        const isForwardChain = (group as any).groupMode === "chain";
        if (ctx.user.role !== "admin" && (input.isEnabled === true || (rule as any).isEnabled)) {
          const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
          await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
        }
        if (isForwardChain && input.failoverEnabled) {
          throw new Error("端口转发链不支持出站策略");
        }
        const nextForwardType = !isForwardChain && (group as any).groupType === "tunnel" ? "gost" : (input.forwardType ?? rule.forwardType);
        const nextMainBackupEnabled = isForwardChain ? false : input.failoverEnabled ?? (rule as any).failoverEnabled;
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: input.protocol ?? (rule as any).protocol,
          forwardType: nextForwardType,
          isTunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const data: any = {
          ...input,
          ...(isForwardChain ? normalizeFailoverInput({
              failoverEnabled: false,
              failoverTargets: [],
            }, input.protocol ?? (rule as any).protocol)
            : input.failoverEnabled !== undefined ||
            input.failoverStrategy !== undefined ||
            input.failoverTargets !== undefined ||
            input.failoverSeconds !== undefined ||
            input.recoverSeconds !== undefined ||
            input.autoFailback !== undefined
            ? normalizeFailoverInput({
                failoverEnabled: input.failoverEnabled ?? (rule as any).failoverEnabled,
                failoverStrategy: input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
                failoverTargets: input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets),
                failoverSeconds: input.failoverSeconds ?? (rule as any).failoverSeconds,
                recoverSeconds: input.recoverSeconds ?? (rule as any).recoverSeconds,
                autoFailback: input.autoFailback ?? (rule as any).autoFailback,
              }, input.protocol ?? (rule as any).protocol)
            : {}),
          ...(input.targetIp !== undefined ? { targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }) } : {}),
          forwardType: nextForwardType,
          ...(
            input.proxyProtocolReceive !== undefined ||
            input.proxyProtocolSend !== undefined ||
            input.proxyProtocolExitReceive !== undefined ||
            input.proxyProtocolExitSend !== undefined ||
            input.proxyProtocolVersion !== undefined ||
            input.tcpFastOpen !== undefined ||
            input.zeroCopy !== undefined ||
            input.udpOverTcp !== undefined ||
            input.udpOverTcpPort !== undefined ||
            input.protocol !== undefined ||
            input.forwardType !== undefined ||
            input.failoverEnabled !== undefined
              ? normalizeProxyProtocolInput({
                  proxyProtocolReceive: input.proxyProtocolReceive ?? (rule as any).proxyProtocolReceive,
                  proxyProtocolSend: input.proxyProtocolSend ?? (rule as any).proxyProtocolSend,
                  proxyProtocolExitReceive: input.proxyProtocolExitReceive ?? (rule as any).proxyProtocolExitReceive,
                  proxyProtocolExitSend: input.proxyProtocolExitSend ?? (rule as any).proxyProtocolExitSend,
                  proxyProtocolVersion: input.proxyProtocolVersion ?? (rule as any).proxyProtocolVersion,
                  failoverEnabled: nextMainBackupEnabled,
                }, input.protocol ?? (rule as any).protocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" })
              : {}
          ),
          ...(
            input.tcpFastOpen !== undefined ||
            input.zeroCopy !== undefined ||
            input.udpOverTcp !== undefined ||
            input.udpOverTcpPort !== undefined ||
            input.protocol !== undefined ||
            input.forwardType !== undefined
              ? normalizeTransportTuningInput({
                  tcpFastOpen: input.tcpFastOpen ?? (rule as any).tcpFastOpen,
                  zeroCopy: input.zeroCopy ?? (rule as any).zeroCopy,
                  udpOverTcp: input.udpOverTcp ?? (rule as any).udpOverTcp,
                  udpOverTcpPort: input.udpOverTcpPort ?? (rule as any).udpOverTcpPort,
                }, input.protocol ?? (rule as any).protocol, nextForwardType, isForwardChain, {
                  clearUnsupported: true,
                  tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
                  forwardxTunnel: false,
                })
              : {}
          ),
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
        delete data.blockHttp;
        delete data.blockSocks;
        delete data.blockTls;
        const watchedFields = ["sourcePort", "targetIp", "targetPort", "forwardType", "protocol", "proxyProtocolReceive", "proxyProtocolSend", "proxyProtocolExitReceive", "proxyProtocolExitSend", "proxyProtocolVersion", "tcpFastOpen", "zeroCopy", "udpOverTcp", "udpOverTcpPort", "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback"] as const;
        const keyFieldChanged = watchedFields.some((field) => data[field] !== undefined && data[field] !== (rule as any)[field]);
        if (keyFieldChanged || data.isEnabled !== undefined) data.isRunning = false;
        await db.updateForwardRule(input.id, data);
        await db.syncForwardGroupRules(groupId);
        await db.runForwardGroupFailover(groupId);
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
            await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
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
      assertNginxTunnelProtocolAllowed(selectedTunnelForRule, input.protocol ?? (rule as any).protocol);
      const nextMainBackupEnabled = input.failoverEnabled ?? (rule as any).failoverEnabled;
      requireMainBackupAllowed({
        enabled: nextMainBackupEnabled,
        protocol: input.protocol ?? (rule as any).protocol,
        forwardType: nextForwardTypeForRule,
        tunnelId: nextTunnelIdForRule,
        isAdmin: ctx.user.role === "admin",
      });
      const nextRuleEnabled = input.isEnabled ?? (rule as any).isEnabled;
      if (!nextTunnelIdForRule) {
        const access = await requireHostUseAccess(ctx, nextHostIdForRule);
        if (ctx.user.role !== "admin" && nextRuleEnabled) {
          await requireTrafficBillingBalanceForRule(ctx.user.id, !!access.isTrafficBillingResource);
        }
      }

      if (nextRuleEnabled && ctx.user.role !== "admin") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        const resourceAccess = activeTunnelId
          ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
          : await requireHostUseAccess(ctx, nextHostIdForRule);
        const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
        await requireTrafficBillingBalanceForRule(ctx.user.id, !!resourceAccess.isTrafficBillingResource);
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
          let effectivePolicy = selectedTunnelForRule
            ? combinePortPolicies(
              portPolicyFrom(host as any),
              portPolicyFrom({
                portRangeStart: (selectedTunnelForRule as any).portRangeStart,
                portRangeEnd: (selectedTunnelForRule as any).portRangeEnd,
              }),
            )
            : portPolicyFrom(host as any);
          if (!isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
            throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
          }
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostIdForRule, nextTunnelIdForRule || undefined);
            if (planRange) {
              effectivePolicy = combinePortPolicies(effectivePolicy, portPolicyFrom({ portRangeStart: planRange.start, portRangeEnd: planRange.end }));
            }
            if (planRange && !isPortAllowedByPolicy(nextSourcePortForRule, effectivePolicy)) {
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
      delete (data as any).blockHttp;
      delete (data as any).blockSocks;
      delete (data as any).blockTls;
      (data as any).hostId = nextHostIdForRule;
      if (input.targetIp !== undefined) (data as any).targetIp = normalizeRuleTargetIp(input.targetIp, { tunnelId: nextTunnelIdForRule });
      if (
        input.failoverEnabled !== undefined ||
        input.failoverStrategy !== undefined ||
        input.failoverTargets !== undefined ||
        input.failoverSeconds !== undefined ||
        input.recoverSeconds !== undefined ||
        input.autoFailback !== undefined
      ) {
        Object.assign(data as any, normalizeFailoverInput({
          failoverEnabled: input.failoverEnabled ?? (rule as any).failoverEnabled,
          failoverStrategy: input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
          failoverTargets: input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets),
          failoverSeconds: input.failoverSeconds ?? (rule as any).failoverSeconds,
          recoverSeconds: input.recoverSeconds ?? (rule as any).recoverSeconds,
          autoFailback: input.autoFailback ?? (rule as any).autoFailback,
        }, input.protocol ?? (rule as any).protocol));
      }
      if (
        input.proxyProtocolReceive !== undefined ||
        input.proxyProtocolSend !== undefined ||
        input.proxyProtocolExitReceive !== undefined ||
        input.proxyProtocolExitSend !== undefined ||
        input.proxyProtocolVersion !== undefined ||
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        input.failoverEnabled !== undefined
      ) {
        Object.assign(data as any, normalizeProxyProtocolInput({
          proxyProtocolReceive: input.proxyProtocolReceive ?? (rule as any).proxyProtocolReceive,
          proxyProtocolSend: input.proxyProtocolSend ?? (rule as any).proxyProtocolSend,
          proxyProtocolExitReceive: input.proxyProtocolExitReceive ?? (rule as any).proxyProtocolExitReceive,
          proxyProtocolExitSend: input.proxyProtocolExitSend ?? (rule as any).proxyProtocolExitSend,
          proxyProtocolVersion: input.proxyProtocolVersion ?? (rule as any).proxyProtocolVersion,
          failoverEnabled: nextMainBackupEnabled,
        }, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelIdForRule }));
      }
      if (
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined
      ) {
        const transportTuning = normalizeTransportTuningInput({
          tcpFastOpen: input.tcpFastOpen ?? (rule as any).tcpFastOpen,
          zeroCopy: input.zeroCopy ?? (rule as any).zeroCopy,
          udpOverTcp: input.udpOverTcp ?? (rule as any).udpOverTcp,
          udpOverTcpPort: input.udpOverTcpPort ?? (rule as any).udpOverTcpPort,
        }, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, {
          clearUnsupported: true,
          tunnelRoute: !!nextTunnelIdForRule,
          forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
        });
        Object.assign(data as any, transportTuning);
      }
      if ((data.forwardType ?? rule.forwardType) !== "gost") {
        (data as any).gostMode = "direct";
        (data as any).gostRelayHost = null;
        (data as any).gostRelayPort = null;
        (data as any).tunnelId = null;
        (data as any).tunnelExitPort = null;
        if ((data.forwardType ?? rule.forwardType) !== "realm") {
          (data as any).proxyProtocolReceive = false;
          (data as any).proxyProtocolSend = false;
        }
        (data as any).proxyProtocolExitReceive = false;
        (data as any).proxyProtocolExitSend = false;
        if (!(data as any).proxyProtocolReceive && !(data as any).proxyProtocolSend) {
          (data as any).proxyProtocolVersion = 1;
        }
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
          await db.clearForwardRuleTunnelExits(id);
        }
      }
      if (data.isEnabled === true) {
        const sourcePort = Number(data.sourcePort ?? rule.sourcePort);
        await assertRulePortWithinEntryPolicy({
          hostId: nextHostIdForRule,
          sourcePort,
          tunnelId: nextTunnelIdForRule,
          tunnel: selectedTunnelForRule,
        });
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
        "proxyProtocolReceive",
        "proxyProtocolSend",
        "proxyProtocolExitReceive",
        "proxyProtocolExitSend",
        "proxyProtocolVersion",
        "tcpFastOpen",
        "zeroCopy",
        "udpOverTcp",
        "udpOverTcpPort",
        "failoverEnabled",
        "failoverStrategy",
        "failoverTargets",
        "failoverSeconds",
        "recoverSeconds",
        "autoFailback",
      ];
      const keyFieldChanged = watchedFields.some((f) => {
        const v = data[f];
        return v !== undefined && v !== (rule as any)[f];
      });
      const failoverHotUpdate = keyFieldChanged
        && isFailoverHotUpdate(data as any, rule as any, nextHostIdForRule, nextTunnelIdForRule);
      const oldHostIdForRule = Number(rule.hostId);
      const hostChanged = Number(oldHostIdForRule) !== Number(nextHostIdForRule);
      if (keyFieldChanged && !failoverHotUpdate) {
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
      if ((data.forwardType ?? rule.forwardType) === "gost") {
        const activeTunnelId = Number(nextTunnelIdForRule || 0);
        if (activeTunnelId) {
          const tunnel = selectedTunnelForRule ?? await db.getTunnelById(activeTunnelId);
          if (tunnel) {
            await db.reconcileForwardRuleTunnelExits(
              { ...rule, ...data, id, tunnelId: activeTunnelId, tunnelExitPort: (data as any).tunnelExitPort ?? (rule as any).tunnelExitPort },
              tunnel,
            );
          }
        } else {
          await db.clearForwardRuleTunnelExits(id);
        }
      } else {
        await db.clearForwardRuleTunnelExits(id);
      }
      if (keyFieldChanged) {
        if (hostChanged) {
          pushAgentRefresh(oldHostIdForRule, "forward-rule-updated-old-host");
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated-new-host");
        } else if (!nextTunnelIdForRule) {
          pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-updated");
        } else if (failoverHotUpdate) {
          const tunnel = await db.getTunnelById(nextTunnelIdForRule);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-failover-hot-update");
          else pushAgentRefresh(Number(nextHostIdForRule), "forward-rule-failover-hot-update");
        }
      }
      return { success: true, reset: keyFieldChanged && !failoverHotUpdate, hotUpdated: failoverHotUpdate };
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
          await settleTrafficBillingForDeletedRule(child);
          if ((child as any).tunnelId) {
            const tunnel = await db.getTunnelById((child as any).tunnelId);
            await db.updateTunnel((child as any).tunnelId, { isRunning: false } as any);
            if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-group-rule-deleted");
          }
          await db.markForwardRulePendingDelete(Number(child.id));
          pushAgentRefresh(Number(child.hostId), "forward-group-rule-deleted");
        }
        await settleTrafficBillingForDeletedRule(rule);
        await db.markForwardRulePendingDelete(input.id);
        await db.runForwardGroupFailover(Number((rule as any).forwardGroupId || 0));
        return { success: true };
      }
      await settleTrafficBillingForDeletedRule(rule);
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
            const group = await db.getForwardGroupById(groupId);
            const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
            await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
            if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("套餐已到期，请续费后再启用规则");
            }
          }
        }
        if (input.isEnabled) {
          const groupId = Number((rule as any).forwardGroupId || 0);
          const group = await db.validateForwardGroupRuleConfig(groupId, {
            sourcePort: rule.sourcePort,
            excludeTemplateRuleId: rule.id,
          });
          const isForwardChain = (group as any).groupMode === "chain";
          requireMainBackupAllowed({
            enabled: isForwardChain ? false : (rule as any).failoverEnabled,
            protocol: (rule as any).protocol,
            forwardType: !isForwardChain && (group as any).groupType === "tunnel" ? "gost" : (rule as any).forwardType,
            isTunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
            isAdmin: ctx.user.role === "admin",
          });
          await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, protocolBlockReason: null } as any);
        } else {
          await db.toggleForwardRule(input.id, false);
        }
        await db.syncForwardGroupRules(Number((rule as any).forwardGroupId));
        await db.runForwardGroupFailover(Number((rule as any).forwardGroupId));
        return { success: true };
      }
      await requireRuleProtocolEnabled(rule);
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (tunnel) await pushTunnelEndpointRefresh(tunnel, "forward-rule-toggled");
      }
      if (input.isEnabled) {
        if ((rule as any).tunnelId) {
          const tunnel = await db.getTunnelById((rule as any).tunnelId);
          assertNginxTunnelProtocolAllowed(tunnel, (rule as any).protocol);
        }
        requireMainBackupAllowed({
          enabled: (rule as any).failoverEnabled,
          protocol: (rule as any).protocol,
          forwardType: (rule as any).forwardType,
          tunnelId: (rule as any).tunnelId,
          isAdmin: ctx.user.role === "admin",
        });
        await assertRulePortWithinEntryPolicy({
          hostId: Number(rule.hostId),
          sourcePort: Number(rule.sourcePort),
          tunnelId: Number((rule as any).tunnelId || 0) || null,
        });
        if (ctx.user.role !== "admin") {
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          const resourceAccess = activeTunnelId
            ? await requireTunnelUseOrTrafficBillingAccess(ctx, activeTunnelId)
            : await requireHostUseAccess(ctx, rule.hostId);
          const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
          await requireTrafficBillingBalanceForRule(ctx.user.id, !!resourceAccess.isTrafficBillingResource);
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

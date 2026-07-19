import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { isIP } from "node:net";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { forwardTypeSchema } from "./schemas";
import { pushTunnelEndpointRefresh, refreshUserForwardEndpoints, requireHostUseAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";
import { isTelegramBotReady } from "../telegramReady";
import {
  releaseHostPortReservations,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  tryReserveHostPort,
  type HostPortReservation,
} from "../portReservations";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { mapWithConcurrency } from "../asyncPool";

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
const mainBackupGostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);

function isMainBackupGostTunnelMode(mode: unknown) {
  return mainBackupGostTunnelModes.has(String(mode || "").toLowerCase());
}

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

export function normalizeFailoverInput(input: FailoverInput, protocol?: string | null) {
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

export function normalizeProxyProtocolInput(input: {
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
export function normalizeTransportTuningInput(input: {
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

function tunnelRuntimeOptionInput(tunnel: any | null | undefined) {
  if (!tunnel) return {};
  return {
    proxyProtocolReceive: !!tunnel.proxyProtocolReceive,
    proxyProtocolSend: !!tunnel.proxyProtocolSend,
    proxyProtocolExitReceive: !!tunnel.proxyProtocolExitReceive,
    proxyProtocolExitSend: !!tunnel.proxyProtocolExitSend,
    proxyProtocolVersion: Number(tunnel.proxyProtocolVersion) === 2 ? 2 : 1,
    tcpFastOpen: !!tunnel.tcpFastOpen,
    zeroCopy: false,
    udpOverTcp: !!tunnel.udpOverTcp,
    udpOverTcpPort: null,
  };
}

function normalizeRuleTargetIp(input: string, _options: { tunnelId?: number | null }) {
  return String(input || "").trim();
}

function normalizeAddressToken(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isLoopbackAddress(value: unknown) {
  const target = normalizeAddressToken(value);
  if (!target) return false;
  if (target === "localhost" || target === "ip6-localhost") return true;
  if (target === "0.0.0.0" || target === "::" || target === "0:0:0:0:0:0:0:0") return true;
  if (target === "::1" || target === "0:0:0:0:0:0:0:1") return true;
  if (isIP(target) === 4) return target.startsWith("127.");
  return false;
}

function hostAddressTokens(host: any) {
  return new Set(
    [
      host?.ip,
      host?.ipv4,
      host?.ipv6,
      host?.entryIp,
      host?.tunnelEntryIp,
      host?.ddnsDomain,
    ]
      .map(normalizeAddressToken)
      .filter(Boolean),
  );
}

function assertNoDirectSelfForwardLoop(options: {
  host?: any;
  sourcePort: number;
  targetIp: unknown;
  targetPort: number;
  tunnelId?: number | null;
}) {
  const sourcePort = Number(options.sourcePort || 0);
  const targetPort = Number(options.targetPort || 0);
  if (sourcePort <= 0 || sourcePort !== targetPort) return;
  if (Number(options.tunnelId || 0) > 0) return;
  const target = normalizeAddressToken(options.targetIp);
  if (!target) return;
  if (isLoopbackAddress(target) || hostAddressTokens(options.host).has(target)) {
    throw new Error(`禁止将本机 ${sourcePort} 端口转发回自身同端口，这会造成转发死循环`);
  }
}

function normalizeLockedForwardType(value: unknown) {
  const parsed = forwardTypeSchema.safeParse(String(value || ""));
  return parsed.success ? parsed.data : "iptables";
}

function lockedForwardTypeForGroup(group: any, fallback: unknown = "iptables") {
  const groupMode = String(group?.groupMode || "failover");
  const groupType = String(group?.groupType || "host");
  if (groupMode !== "chain" && groupType === "tunnel") return "gost";
  return normalizeLockedForwardType(group?.forwardType || fallback);
}

async function forwardGroupTunnelMembersSupportMainBackup(group: any) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const tunnelMembers = members.filter((member: any) => member?.isEnabled !== false && Number(member?.tunnelId || 0) > 0);
  if (tunnelMembers.length === 0) return false;
  for (const member of tunnelMembers) {
    const tunnel = await db.getTunnelById(Number(member.tunnelId));
    if (!isMainBackupGostTunnelMode((tunnel as any)?.mode)) return false;
  }
  return true;
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
  tunnelMode?: string | null;
  isTunnelRoute?: boolean;
  isPortForwardGroup?: boolean;
  isAdmin: boolean;
}) {
  if (!options.enabled) return;
  if (options.protocol && options.protocol !== "tcp") {
    throw new Error("出站策略当前仅支持 TCP 协议");
  }
  if (options.forwardType !== "gost") {
    throw new Error("出站策略仅支持 GOST 端口转发和 GOST 隧道");
  }
  const isTunnelRoute = !!options.isTunnelRoute || Number(options.tunnelId || 0) > 0;
  if (isTunnelRoute && options.tunnelMode !== undefined && !isMainBackupGostTunnelMode(options.tunnelMode)) {
    throw new Error("出站策略仅支持 GOST 隧道");
  }
  if (!options.isAdmin && !isTunnelRoute && !options.isPortForwardGroup) {
    throw new Error("普通用户的普通端口转发不支持出站策略，请使用 GOST 隧道转发或联系管理员");
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
  if (!group) return false;
  const groupId = Number((group as any).id || 0);
  if (groupId > 0) {
    const groupConfig = await db.findTrafficBillingConfig("forward_group", groupId);
    if (groupConfig) return true;
  }
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
  const billingResource = await db.findTrafficBillingResourceForRule(rule);
  const fallback = db.trafficBillingResourceCandidatesForRule(rule)[0];
  const resource = billingResource || fallback;
  if (!resource) return null;
  const billed = await db.settleTrafficBillingRuleOnDelete({
    userId: Number(rule.userId),
    ruleId: Number(rule.id),
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
  });
  if (billed && Number(billed.balanceAfterCents) < 0) {
    await db.setUserForwardAccess(Number(rule.userId), false, "traffic_billing_balance");
    await refreshUserForwardEndpoints(Number(rule.userId), "traffic-billing-delete-balance-negative");
  }
  return billed;
}

async function markTemplateChildrenPendingDelete(templateRuleId: number, reason: string) {
  const childRules = await db.getForwardGroupChildRulesForTemplate(templateRuleId);
  for (const child of childRules as any[]) {
    await settleTrafficBillingForDeletedRule(child);
    const tunnelId = Number((child as any).tunnelId || 0);
    if (tunnelId) {
      const tunnel = await db.getTunnelById(tunnelId);
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, reason);
    }
    await db.markForwardRulePendingDelete(Number(child.id));
    if (Number(child.hostId || 0) > 0) pushAgentRefresh(Number(child.hostId), reason);
  }
  return childRules;
}

export async function deleteForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  options: { reasonPrefix?: string } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    const rule = await db.getForwardRuleById(ruleId);
    if (!rule || (rule as any).pendingDelete) throw new Error("规则不存在或已删除");
    if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
    if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接删除");
    const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
    let chargedCents = 0;
    let balanceAfterCents: number | null = null;
    const collectBilling = (billed: any) => {
      if (!billed) return;
      chargedCents += Math.max(0, Number(billed.amountCents || 0));
      if (Number.isFinite(Number(billed.balanceAfterCents))) balanceAfterCents = Number(billed.balanceAfterCents);
    };

    if ((rule as any).isForwardGroupTemplate) {
      const childRules = await db.getForwardGroupChildRulesForTemplate(ruleId);
      for (const child of childRules as any[]) {
        collectBilling(await settleTrafficBillingForDeletedRule(child));
        const childTunnelId = Number((child as any).tunnelId || 0);
        if (childTunnelId > 0) {
          const tunnel = await db.getTunnelById(childTunnelId);
          await db.updateTunnel(childTunnelId, { isRunning: false } as any);
          if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-group-deleted`);
        }
        await db.markForwardRulePendingDelete(Number(child.id));
        pushAgentRefresh(Number(child.hostId), `${reasonPrefix}-group-deleted`);
      }
      collectBilling(await settleTrafficBillingForDeletedRule(rule));
      await db.markForwardRulePendingDelete(ruleId);
      await db.runForwardGroupFailover(Number((rule as any).forwardGroupId || 0));
      // Templates never run on an Agent, so they cannot receive a runtime stop ACK.
      // Their managed children remain pending until each Agent confirms removal.
      await db.finalizeForwardRuleDelete(ruleId);
      return { success: true, rule, childRules, chargedCents, balanceAfterCents };
    }

    collectBilling(await settleTrafficBillingForDeletedRule(rule));
    if ((rule as any).tunnelId) {
      const tunnel = await db.getTunnelById((rule as any).tunnelId);
      await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${reasonPrefix}-deleted`);
    }
    await db.markForwardRulePendingDelete(ruleId);
    pushAgentRefresh(rule.hostId, `${reasonPrefix}-deleted`);
    return { success: true, rule, childRules: [] as any[], chargedCents, balanceAfterCents };
  });
}

export async function toggleForwardRuleForActor(
  actor: { id: number; role: string },
  ruleId: number,
  isEnabled: boolean,
  options: { reasonPrefix?: string } = {},
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    let sourcePortReservation: HostPortReservation | null = null;
    try {
      const rule = await db.getForwardRuleById(ruleId);
      if (!rule) throw new Error("规则不存在");
      if (actor.role !== "admin" && rule.userId !== actor.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接开关");
      if ((rule as any).isForwardGroupTemplate) {
        if (actor.role !== "admin") {
          const groupId = Number((rule as any).forwardGroupId || 0);
          const hasPermission = groupId ? await db.checkUserForwardGroupPermission(actor.id, groupId) : false;
          if (!hasPermission) throw new Error("无权操作该转发组规则");
          if (isEnabled) {
            const owner = await requireForwardAccessReady(actor.id);
            const group = await db.getForwardGroupById(groupId);
            const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, actor.id);
            await requireTrafficBillingBalanceForRule(actor.id, isTrafficBillingRule);
            if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("套餐已到期，请续费后再启用规则");
            }
          }
        }
        if (isEnabled) {
          const groupId = Number((rule as any).forwardGroupId || 0);
          const group = await db.validateForwardGroupRuleConfig(groupId, {
            sourcePort: rule.sourcePort,
            protocol: (rule as any).protocol,
            excludeTemplateRuleId: rule.id,
          });
          const isForwardChain = (group as any).groupMode === "chain";
          const isPortGroup = (group as any).groupMode === "port";
          const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
          const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
          requireMainBackupAllowed({
            enabled: isForwardChain || (groupIsTunnel && !groupTunnelSupportsFailover) ? false : (rule as any).failoverEnabled,
            protocol: (rule as any).protocol,
            forwardType: !isForwardChain && (group as any).groupType === "tunnel" ? "gost" : (rule as any).forwardType,
            isTunnelRoute: groupIsTunnel,
            isPortForwardGroup: isPortGroup,
            isAdmin: actor.role === "admin",
          });
          await db.updateForwardRule(ruleId, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, disabledByGroup: false, protocolBlockReason: null } as any);
        } else {
          await db.toggleForwardRule(ruleId, false);
        }
        await db.syncForwardGroupRules(Number((rule as any).forwardGroupId));
        await db.runForwardGroupFailover(Number((rule as any).forwardGroupId));
        return { success: true, rule };
      }

      await requireRuleProtocolEnabled(rule);
      let toggleTunnelForRule: any = null;
      const reasonPrefix = String(options.reasonPrefix || "forward-rule").trim() || "forward-rule";
      if ((rule as any).tunnelId) {
        toggleTunnelForRule = await db.getTunnelById((rule as any).tunnelId);
        await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (toggleTunnelForRule) await pushTunnelEndpointRefresh(toggleTunnelForRule, `${reasonPrefix}-toggled`);
      }
      if (isEnabled) {
        requireMainBackupAllowed({
          enabled: (rule as any).failoverEnabled,
          protocol: (rule as any).protocol,
          forwardType: (rule as any).forwardType,
          tunnelId: (rule as any).tunnelId,
          tunnelMode: toggleTunnelForRule?.mode,
          isAdmin: actor.role === "admin",
        });
        await assertRulePortWithinEntryPolicy({
          hostId: Number(rule.hostId),
          sourcePort: Number(rule.sourcePort),
          tunnelId: Number((rule as any).tunnelId || 0) || null,
        });
        if (actor.role !== "admin") {
          const activeTunnelId = Number((rule as any).tunnelId || 0);
          const actorContext = { user: actor };
          const resourceAccess = activeTunnelId
            ? await requireTunnelUseOrTrafficBillingAccess(actorContext, activeTunnelId)
            : await requireHostUseAccess(actorContext, rule.hostId);
          const owner = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: !!resourceAccess.isTrafficBillingResource });
          await requireTrafficBillingBalanceForRule(actor.id, !!resourceAccess.isTrafficBillingResource);
          if (owner.expiresAt && new Date(owner.expiresAt) <= new Date()) {
            throw new Error("套餐已到期，请续费后再启用规则");
          }
        }
        sourcePortReservation = await reserveSpecificHostPort({
          hostId: Number(rule.hostId),
          port: Number(rule.sourcePort),
          protocol: (rule as any).protocol,
          isUsed: (port) => db.isPortUsedOnHost(Number(rule.hostId), port, Number(rule.id), (rule as any).protocol),
        });
        if (!sourcePortReservation) throw new Error(`端口 ${rule.sourcePort} 已被占用，请更换端口后再启用`);
        await db.updateForwardRule(ruleId, { isEnabled: true, isRunning: false, disabledByUser: false, disabledByTunnel: false, disabledByGroup: false, protocolBlockReason: null } as any);
      } else {
        await db.toggleForwardRule(ruleId, false);
      }
      pushAgentRefresh(Number(rule.hostId), `${reasonPrefix}-${isEnabled ? "enabled" : "disabled"}`);
      return { success: true, rule };
    } finally {
      sourcePortReservation?.release();
    }
  });
}

export async function createDirectForwardRuleForActor(
  actor: { id: number; role: string; allowedForwardTypes?: string | null },
  input: any,
  options: { reasonPrefix?: string } = {},
) {
  await requireRuleTelegramNotifyReady(!!input.telegramErrorNotifyEnabled);
  let currentUser = await db.getUserById(actor.id);
  if (actor.role !== "admin") {
    const allowedRaw = actor.allowedForwardTypes;
    if (allowedRaw !== null && allowedRaw !== undefined) {
      const allowed = new Set(allowedRaw.split(",").map((value) => value.trim()).filter(Boolean));
      if (!allowed.has(input.forwardType)) throw new Error(`您没有使用 ${input.forwardType} 转发方式的权限，请联系管理员`);
    }
  }
  if (input.tunnelId && input.forwardType !== "gost") {
    throw new Error("隧道转发必须使用已创建的隧道协议，请先创建隧道后再选择使用。");
  }
  const tunnelId = input.forwardType === "gost" ? input.tunnelId ?? null : null;
  if (!input.hostId) throw new Error("请选择所属主机");
  const actorContext = { user: actor };
  let selectedTunnelForRule: any = null;
  let isTrafficBillingRule = false;
  if (tunnelId) {
    const access = await requireTunnelUseOrTrafficBillingAccess(actorContext, tunnelId);
    selectedTunnelForRule = access.tunnel;
    isTrafficBillingRule = access.isTrafficBillingResource;
    if (!selectedTunnelForRule.isEnabled) throw new Error("所选隧道已停用");
    if (selectedTunnelForRule.entryHostId !== input.hostId) {
      throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
    }
  } else {
    const access = await requireHostUseAccess(actorContext, input.hostId);
    isTrafficBillingRule = access.isTrafficBillingResource;
    if (actor.role !== "admin" && !isTrafficBillingRule) {
      throw new Error("普通端口转发请先创建转发组或转发链后再新增规则。");
    }
  }
  requireMainBackupAllowed({
    enabled: input.failoverEnabled,
    protocol: input.protocol,
    forwardType: input.forwardType,
    tunnelId,
    tunnelMode: selectedTunnelForRule?.mode,
    isAdmin: actor.role === "admin",
  });
  if (actor.role !== "admin") {
    currentUser = await requireForwardAccessReady(actor.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
    await requireTrafficBillingBalanceForRule(actor.id, isTrafficBillingRule);
    if (String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx" && !(currentUser as any)?.canAddRules) {
      throw new Error("无权使用 ForwardX 加密隧道");
    }
  }
  if (actor.role !== "admin" && currentUser?.expiresAt && new Date(currentUser.expiresAt) <= new Date()) {
    throw new Error("您的账户已到期，无法添加规则");
  }
  if (currentUser && currentUser.maxRules > 0) {
    const ruleCount = await db.getUserRuleCount(actor.id);
    if (ruleCount >= currentUser.maxRules) throw new Error(`您已达到最大规则数量限制（${currentUser.maxRules} 条）`);
  }
  if (currentUser && currentUser.maxPorts > 0) {
    const portCount = await db.getUserPortCount(actor.id);
    if (portCount >= currentUser.maxPorts) throw new Error(`您已达到最大端口数量限制（${currentUser.maxPorts} 个）`);
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
  const planRange = actor.role !== "admin"
    ? await db.getUserPlanPortRange(actor.id, input.hostId, tunnelId ?? undefined)
    : null;
  const effectivePolicy = planRange
    ? combinePortPolicies(entryPolicy, portPolicyFrom({ portRangeStart: planRange.start, portRangeEnd: planRange.end }))
    : entryPolicy;

  let sourcePort = Number(input.sourcePort || 0);
  let sourcePortReservation: HostPortReservation | null = null;
  let tunnelExitPortReservation: HostPortReservation | null = null;
  if (sourcePort === 0) {
    let randomRangeStart = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeStart : null;
    let randomRangeEnd = selectedTunnelForRule ? (selectedTunnelForRule as any).portRangeEnd : null;
    if (planRange) {
      randomRangeStart = Math.max(Number(randomRangeStart || planRange.start), planRange.start);
      randomRangeEnd = Math.min(Number(randomRangeEnd || planRange.end), planRange.end);
    }
    sourcePortReservation = await reserveAvailableHostPort({
      hostId: input.hostId,
      protocol: input.protocol,
      findPort: (reservedPorts) => db.findAvailablePort(input.hostId, randomRangeStart, randomRangeEnd, input.protocol, reservedPorts),
      isUsed: (port) => db.isPortUsedOnHost(input.hostId, port, undefined, input.protocol),
    });
    if (!sourcePortReservation) throw new Error("该主机端口区间内已无可用端口");
    sourcePort = sourcePortReservation.port;
  } else {
    if (!isPortAllowedByPolicy(sourcePort, effectivePolicy)) throw new Error(portPolicyErrorMessage(effectivePolicy, "源端口"));
    sourcePortReservation = tryReserveHostPort(input.hostId, sourcePort, input.protocol);
    if (!sourcePortReservation) throw new Error(`端口 ${sourcePort} 正在被其他请求分配，请稍后重试`);
    const used = await db.isPortUsedOnHost(input.hostId, sourcePort, undefined, input.protocol);
    if (used) {
      sourcePortReservation.release();
      sourcePortReservation = null;
      throw new Error(`端口 ${sourcePort} 已被其他规则占用`);
    }
  }

  try {
    let tunnelExitPort: number | null = null;
    assertNoDirectSelfForwardLoop({ host, sourcePort, targetIp: input.targetIp, targetPort: input.targetPort, tunnelId });
    if (tunnelId) {
      const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(actorContext, tunnelId)).tunnel;
      if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
      if (tunnel.entryHostId !== input.hostId) throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
      const exit = await db.getHostById(tunnel.exitHostId);
      tunnelExitPortReservation = await reserveAvailableHostPort({
        hostId: Number(tunnel.exitHostId),
        protocol: "both",
        findPort: (reservedPorts) => db.findAvailableTunnelExitPort(tunnel.exitHostId, (exit as any)?.portRangeStart, (exit as any)?.portRangeEnd, reservedPorts),
        isUsed: (port) => db.isPortUsedOnHost(Number(tunnel.exitHostId), port, undefined, "both"),
      });
      if (!tunnelExitPortReservation) throw new Error("出口 Agent 已无可用隧道端口");
      tunnelExitPort = tunnelExitPortReservation.port;
    }
    const runtimeOptionInput = tunnelId ? tunnelRuntimeOptionInput(selectedTunnelForRule) : input;
    const proxyProtocol = normalizeProxyProtocolInput(runtimeOptionInput, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId, clearUnsupported: !!tunnelId });
    const transportTuning = normalizeTransportTuningInput(runtimeOptionInput, input.protocol, input.forwardType, false, { tunnelRoute: !!tunnelId, forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx", clearUnsupported: !!tunnelId });
    const id = await db.createForwardRule({
      ...input,
      ...normalizeFailoverInput(input, input.protocol),
      ...proxyProtocol,
      ...transportTuning,
      telegramErrorNotifyEnabled: !!input.telegramErrorNotifyEnabled,
      blockHttp: false,
      blockSocks: false,
      blockTls: false,
      sourcePort,
      targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId }),
      gostMode: "direct",
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId,
      tunnelExitPort,
      userId: actor.id,
    });
    if (tunnelId) {
      const tunnel = await db.getTunnelById(tunnelId);
      if (tunnel) await db.reconcileForwardRuleTunnelExits({ ...input, id, tunnelExitPort, sourcePort, tunnelId }, tunnel);
      await db.updateTunnel(tunnelId, { isRunning: false } as any);
      if (tunnel) await pushTunnelEndpointRefresh(tunnel, `${options.reasonPrefix || "forward-rule"}-created`);
    } else {
      pushAgentRefresh(Number(input.hostId), `${options.reasonPrefix || "forward-rule"}-created`);
    }
    return { id, sourcePort };
  } finally {
    tunnelExitPortReservation?.release();
    sourcePortReservation?.release();
  }
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
        const forwardGroupId = Number(input.forwardGroupId);
        return withKeyedTaskLock(`forward-group:${forwardGroupId}`, async () => {
        const groupReservations: HostPortReservation[] = [];
        try {
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
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, forwardGroupId);
          if (!hasPermission) throw new Error("无权使用该转发组");
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, forwardGroupId);
          if (planRange && (sourcePort < planRange.start || sourcePort > planRange.end)) {
            throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(forwardGroupId, { sourcePort, protocol: input.protocol });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin") {
          const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
          await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
        }
        const hostId = await db.getForwardGroupDefaultHostId(forwardGroupId);
        const forwardType = lockedForwardTypeForGroup(group, input.forwardType);
        const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
        if (!isForwardChain && !groupIsTunnel) {
          const host = await db.getHostById(hostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort,
            targetIp: input.targetIp,
            targetPort: input.targetPort,
            tunnelId: null,
          });
        }
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && input.protocol === "tcp" && forwardType === "gost" && (!groupIsTunnel || groupTunnelSupportsFailover);
        const createFailoverEnabled = groupSupportsFailover ? input.failoverEnabled : false;
        requireMainBackupAllowed({
          enabled: createFailoverEnabled,
          protocol: input.protocol,
          forwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
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
        const entryHostIds = await db.getForwardGroupRuleEntryHostIds(forwardGroupId);
        for (const entryHostId of entryHostIds) {
          const reservation = await reserveSpecificHostPort({
            hostId: entryHostId,
            port: sourcePort,
            protocol: input.protocol,
            isUsed: (port) => db.isPortUsedOnHost(entryHostId, port, undefined, input.protocol),
          });
          if (!reservation) throw new Error(`入口 Agent 端口 ${sourcePort} 已被占用或正在分配`);
          groupReservations.push(reservation);
        }
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
          forwardGroupId,
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
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", clearUnsupported: true },
          ),
          ...normalizeTransportTuningInput(
            input,
            input.protocol,
            forwardType,
            isForwardChain,
            { tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false, clearUnsupported: true },
          ),
          ...normalizeFailoverInput({
            ...input,
            failoverEnabled: createFailoverEnabled,
            failoverTargets: createFailoverEnabled ? input.failoverTargets : [],
          }, input.protocol),
          isRunning: false,
          userId: ctx.user.id,
        } as any);
        await db.syncForwardGroupRules(forwardGroupId);
        await db.runForwardGroupFailover(forwardGroupId);
        return { id, sourcePort };
        } finally {
          releaseHostPortReservations(groupReservations);
        }
        });
      }

      return createDirectForwardRuleForActor(ctx.user, input);
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
    .mutation(async ({ input, ctx }) => withKeyedTaskLock(`rule:${input.id}`, async () => {
      const heldReservations: HostPortReservation[] = [];
      const reserveRulePort = async (hostId: number, port: number, protocol: "tcp" | "udp" | "both", excludeRuleIds: number | number[]) => {
        const existing = heldReservations.find((reservation) => (
          reservation.hostId === Number(hostId)
          && reservation.port === Number(port)
          && reservation.protocol === protocol
        ));
        if (existing) return existing;
        const reservation = await reserveSpecificHostPort({
          hostId,
          port,
          protocol,
          isUsed: (candidate) => db.isPortUsedOnHost(hostId, candidate, excludeRuleIds, protocol),
        });
        if (reservation) heldReservations.push(reservation);
        return reservation;
      };
      const reserveForwardGroupEntryPorts = async (
        groupId: number,
        port: number,
        protocol: "tcp" | "udp" | "both",
        excludeRuleIds: number[],
      ) => {
        const hostIds = await db.getForwardGroupRuleEntryHostIds(groupId);
        const outcomes = await Promise.allSettled(hostIds.map((hostId) => (
          reserveRulePort(hostId, port, protocol, excludeRuleIds)
        )));
        const failed = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult | undefined;
        if (failed) throw failed.reason;
        if (outcomes.some((outcome) => outcome.status === "fulfilled" && !outcome.value)) {
          throw new Error(`Port ${port} is already used or being allocated on a forward-group entry host`);
        }
      };
      try {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
      if ((rule as any).forwardGroupRuleId) throw new Error("转发组成员规则由系统维护，不能直接修改");
      await requireRuleTelegramNotifyReady(input.telegramErrorNotifyEnabled);

      if ((rule as any).isForwardGroupTemplate) {
        const groupId = Number((rule as any).forwardGroupId || 0);
        if (input.forwardGroupId === null) {
          if (!groupId) throw new Error("Forward group does not exist");
          const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
          const excludeRuleIds = [
            Number(rule.id),
            ...(childRules as any[]).map((child: any) => Number(child.id)),
          ].filter((id) => Number.isInteger(id) && id > 0);
          const nextForwardType = input.forwardType ?? (rule as any).forwardType;
          const nextTunnelId = nextForwardType === "gost"
            ? Number(input.tunnelId !== undefined ? input.tunnelId : (rule as any).tunnelId) || null
            : null;
          let selectedTunnelForRule: any = null;
          let nextHostId = Number(input.hostId ?? (rule as any).hostId);
          let isTrafficBillingRule = false;
          if (nextTunnelId) {
            const access = await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId);
            selectedTunnelForRule = access.tunnel;
            isTrafficBillingRule = !!access.isTrafficBillingResource;
            if (!selectedTunnelForRule.isEnabled) throw new Error("Selected tunnel is disabled");
            nextHostId = Number(selectedTunnelForRule.entryHostId);
            if (input.hostId !== undefined && Number(input.hostId) !== nextHostId) {
              throw new Error("Tunnel entry host must match the rule host");
            }
            if (ctx.user.role !== "admin" && String(selectedTunnelForRule.mode || "").toLowerCase() === "forwardx") {
              const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
              if (!(owner as any)?.canAddRules) {
                throw new Error("No permission to use custom encrypted tunnels");
              }
            }
          } else {
            if (!nextHostId) throw new Error("Please select a host");
            const access = await requireHostUseAccess(ctx, nextHostId);
            isTrafficBillingRule = !!access.isTrafficBillingResource;
          }

          if (ctx.user.role !== "admin") {
            const owner = await requireForwardAccessReady(ctx.user.id, { allowTrafficBillingRecovery: isTrafficBillingRule });
            await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
            if (owner?.expiresAt && new Date(owner.expiresAt) <= new Date()) {
              throw new Error("Plan expired, please renew before enabling rules");
            }
          }

          const nextProtocol = input.protocol ?? (rule as any).protocol;
          const nextSourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
          const nextMainBackupEnabled = false;
          requireMainBackupAllowed({
            enabled: nextMainBackupEnabled,
            protocol: nextProtocol,
            forwardType: nextForwardType,
            tunnelId: nextTunnelId,
            isAdmin: ctx.user.role === "admin",
          });
          await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: nextTunnelId }, selectedTunnelForRule);
          await assertRulePortWithinEntryPolicy({
            hostId: nextHostId,
            sourcePort: nextSourcePort,
            tunnelId: nextTunnelId,
            tunnel: selectedTunnelForRule,
          });
          if (ctx.user.role !== "admin") {
            const planRange = await db.getUserPlanPortRange(ctx.user.id, nextHostId, nextTunnelId || undefined);
            if (planRange && (nextSourcePort < planRange.start || nextSourcePort > planRange.end)) {
              throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 区间内`);
            }
          }
          const sourceReservation = await reserveRulePort(nextHostId, nextSourcePort, nextProtocol, excludeRuleIds);
          if (!sourceReservation) throw new Error(`Port ${nextSourcePort} is already used or being allocated`);
          if (!nextTunnelId) {
            const host = await db.getHostById(nextHostId);
            assertNoDirectSelfForwardLoop({
              host,
              sourcePort: nextSourcePort,
              targetIp: input.targetIp ?? (rule as any).targetIp,
              targetPort: Number(input.targetPort ?? (rule as any).targetPort),
              tunnelId: nextTunnelId,
            });
          }

          let tunnelExitPort: number | null = null;
          if (nextTunnelId) {
            const tunnel = selectedTunnelForRule ?? (await requireTunnelUseOrTrafficBillingAccess(ctx, nextTunnelId)).tunnel;
            const exit = await db.getHostById(tunnel.exitHostId);
            const existingExitPort = Number((rule as any).tunnelExitPort || 0);
            const exitReservation = existingExitPort > 0
              ? await reserveSpecificHostPort({
                  hostId: Number(tunnel.exitHostId),
                  port: existingExitPort,
                  protocol: "both",
                  isUsed: (port) => db.isPortUsedOnHost(Number(tunnel.exitHostId), port, excludeRuleIds, "both"),
                })
              : await reserveAvailableHostPort({
                  hostId: Number(tunnel.exitHostId),
                  protocol: "both",
                  findPort: (reservedPorts) => db.findAvailableTunnelExitPort(
                    tunnel.exitHostId,
                    (exit as any)?.portRangeStart,
                    (exit as any)?.portRangeEnd,
                    reservedPorts,
                    excludeRuleIds,
                  ),
                  isUsed: (port) => db.isPortUsedOnHost(Number(tunnel.exitHostId), port, excludeRuleIds, "both"),
                });
            if (!exitReservation) throw new Error("Tunnel exit agent has no available port");
            heldReservations.push(exitReservation);
            tunnelExitPort = exitReservation.port;
          }

          const failoverData = normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol);
          const data: any = {
            name: input.name ?? (rule as any).name,
            hostId: nextHostId,
            forwardType: nextForwardType,
            protocol: nextProtocol,
            gostMode: "direct",
            gostRelayHost: null,
            gostRelayPort: null,
            tunnelId: nextTunnelId,
            tunnelExitPort,
            forwardGroupId: null,
            forwardGroupRuleId: null,
            forwardGroupMemberId: null,
            isForwardGroupTemplate: false,
            sourcePort: nextSourcePort,
            targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: nextTunnelId }),
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
            blockHttp: false,
            blockSocks: false,
            blockTls: false,
            ...normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelId }),
            ...normalizeTransportTuningInput({}, nextProtocol, nextForwardType, false, {
              clearUnsupported: true,
              tunnelRoute: !!nextTunnelId,
              forwardxTunnel: String(selectedTunnelForRule?.mode || "").toLowerCase() === "forwardx",
            }),
            ...failoverData,
            isEnabled: input.isEnabled ?? (rule as any).isEnabled,
            isRunning: false,
            pendingDelete: false,
          };
          if (data.isEnabled) {
            data.disabledByUser = false;
            data.disabledByTunnel = false;
            data.disabledByGroup = false;
            data.protocolBlockReason = null;
          }

          await db.updateForwardRule(input.id, data);
          if (nextTunnelId && selectedTunnelForRule) {
            await db.reconcileForwardRuleTunnelExits({ ...rule, ...data, id: input.id, tunnelId: nextTunnelId, tunnelExitPort }, selectedTunnelForRule);
            await db.updateTunnel(nextTunnelId, { isRunning: false } as any);
            await pushTunnelEndpointRefresh(selectedTunnelForRule, "forward-group-rule-converted");
          } else {
            await db.clearForwardRuleTunnelExits(input.id);
            pushAgentRefresh(nextHostId, "forward-group-rule-converted");
          }
          await markTemplateChildrenPendingDelete(input.id, "forward-group-rule-converted");
          await db.runForwardGroupFailover(groupId);
          return { success: true, reset: true };
        }
        if (!groupId) throw new Error("转发组不存在");
        const activeGroupId = input.forwardGroupId === undefined ? groupId : Number(input.forwardGroupId || 0);
        if (!activeGroupId) throw new Error("转发组不存在");
        const groupChanged = activeGroupId !== groupId;
        if (ctx.user.role !== "admin") {
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, activeGroupId);
          if (!hasPermission) throw new Error("无权修改该转发组规则");
          const nextSourcePort = input.sourcePort ?? rule.sourcePort;
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, activeGroupId);
          if (planRange && (nextSourcePort < planRange.start || nextSourcePort > planRange.end)) {
            throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(activeGroupId, {
          sourcePort: input.sourcePort ?? rule.sourcePort,
          protocol: input.protocol ?? (rule as any).protocol,
          excludeTemplateRuleId: rule.id,
        });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin" && (input.isEnabled === true || (rule as any).isEnabled)) {
          const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
          await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        const nextProtocol = input.protocol ?? (rule as any).protocol;
        const childRules = await db.getForwardGroupChildRulesForTemplate(input.id);
        await reserveForwardGroupEntryPorts(
          activeGroupId,
          Number(input.sourcePort ?? (rule as any).sourcePort),
          nextProtocol,
          [Number(rule.id), ...(childRules as any[]).map((child: any) => Number(child.id))].filter(Boolean),
        );
        const groupIsTunnel = !isForwardChain && (group as any).groupType === "tunnel";
        const groupTunnelSupportsFailover = groupIsTunnel ? await forwardGroupTunnelMembersSupportMainBackup(group) : true;
        const groupSupportsFailover = !isForwardChain && nextProtocol === "tcp" && nextForwardType === "gost" && (!groupIsTunnel || groupTunnelSupportsFailover);
        const nextMainBackupEnabled = groupChanged ? false : (groupSupportsFailover ? input.failoverEnabled ?? (rule as any).failoverEnabled : false);
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: groupIsTunnel,
          isPortForwardGroup: isPortGroup,
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const activeHostId = await db.getForwardGroupDefaultHostId(activeGroupId);
        if (!isForwardChain && !groupIsTunnel) {
          const host = await db.getHostById(activeHostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort: Number(input.sourcePort ?? (rule as any).sourcePort),
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            tunnelId: null,
          });
        }
        const data: any = {
          ...input,
          ...(groupChanged || isForwardChain || isPortGroup || !nextMainBackupEnabled ||
            input.failoverEnabled !== undefined ||
            input.failoverStrategy !== undefined ||
            input.failoverTargets !== undefined ||
            input.failoverSeconds !== undefined ||
            input.recoverSeconds !== undefined ||
            input.autoFailback !== undefined
            ? normalizeFailoverInput({
                failoverEnabled: nextMainBackupEnabled,
                failoverStrategy: groupChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
                failoverTargets: nextMainBackupEnabled && !groupChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
                failoverSeconds: groupChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
                recoverSeconds: groupChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
                autoFailback: groupChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
              }, nextProtocol)
            : {}),
          ...(input.targetIp !== undefined ? { targetIp: normalizeRuleTargetIp(input.targetIp, { tunnelId: !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }) } : {}),
          forwardType: nextForwardType,
          ...(groupChanged ? normalizeProxyProtocolInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" }) : normalizeProxyProtocolInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" },
          )),
          ...(groupChanged ? normalizeTransportTuningInput({}, nextProtocol, nextForwardType, isForwardChain, { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false }) : normalizeTransportTuningInput(
            { ...rule, ...input },
            nextProtocol,
            nextForwardType,
            isForwardChain,
            {
              clearUnsupported: true,
              tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
              forwardxTunnel: false,
            },
          )),
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          hostId: activeHostId,
          forwardGroupId: activeGroupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
        };
        delete data.id;
        delete data.blockHttp;
        delete data.blockSocks;
        delete data.blockTls;
        const watchedFields = ["sourcePort", "targetIp", "targetPort", "forwardType", "protocol", "proxyProtocolReceive", "proxyProtocolSend", "proxyProtocolExitReceive", "proxyProtocolExitSend", "proxyProtocolVersion", "tcpFastOpen", "zeroCopy", "udpOverTcp", "udpOverTcpPort", "failoverEnabled", "failoverStrategy", "failoverTargets", "failoverSeconds", "recoverSeconds", "autoFailback"] as const;
        const keyFieldChanged = watchedFields.some((field) => data[field] !== undefined && data[field] !== (rule as any)[field]);
        if (keyFieldChanged || groupChanged || data.isEnabled !== undefined) data.isRunning = false;
        if (groupChanged) await markTemplateChildrenPendingDelete(input.id, "forward-group-rule-route-changed");
        await db.updateForwardRule(input.id, data);
        if (groupChanged) {
          await db.syncForwardGroupRules(groupId);
          await db.runForwardGroupFailover(groupId);
        }
        await db.syncForwardGroupRules(activeGroupId);
        await db.runForwardGroupFailover(activeGroupId);
        return { success: true, reset: keyFieldChanged || groupChanged };
      }

      if (input.forwardGroupId !== undefined && input.forwardGroupId !== null) {
        const groupId = Number(input.forwardGroupId);
        const sourcePort = Number(input.sourcePort ?? (rule as any).sourcePort);
        if (!groupId) throw new Error("请选择转发链或转发组");
        if (ctx.user.role !== "admin") {
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, groupId);
          if (!hasPermission) throw new Error("无权使用该转发组");
          const planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, groupId);
          if (planRange && (sourcePort < planRange.start || sourcePort > planRange.end)) {
            throw new Error(`套餐端口必须在 ${planRange.start}-${planRange.end} 内`);
          }
        }
        const group = await db.validateForwardGroupRuleConfig(groupId, {
          sourcePort,
          protocol: input.protocol ?? (rule as any).protocol,
          excludeTemplateRuleId: rule.id,
        });
        const isForwardChain = (group as any).groupMode === "chain";
        const isPortGroup = (group as any).groupMode === "port";
        if (ctx.user.role !== "admin" && (input.isEnabled === true || (rule as any).isEnabled)) {
          const isTrafficBillingRule = await isForwardGroupTrafficBillingRule(group, ctx.user.id);
          await requireTrafficBillingBalanceForRule(ctx.user.id, isTrafficBillingRule);
        }
        const nextForwardType = lockedForwardTypeForGroup(group, input.forwardType ?? (rule as any).forwardType);
        const nextProtocol = input.protocol ?? (rule as any).protocol;
        await reserveForwardGroupEntryPorts(groupId, sourcePort, nextProtocol, [Number(rule.id)]);
        const nextMainBackupEnabled = false;
        requireMainBackupAllowed({
          enabled: nextMainBackupEnabled,
          protocol: nextProtocol,
          forwardType: nextForwardType,
          isTunnelRoute: !isForwardChain && (group as any).groupType === "tunnel",
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardType, tunnelId: null });
        const hostId = await db.getForwardGroupDefaultHostId(groupId);
        if (!isForwardChain && (group as any).groupType !== "tunnel") {
          const host = await db.getHostById(hostId);
          assertNoDirectSelfForwardLoop({
            host,
            sourcePort,
            targetIp: input.targetIp ?? (rule as any).targetIp,
            targetPort: Number(input.targetPort ?? (rule as any).targetPort),
            tunnelId: null,
          });
        }
        const data: any = {
          name: input.name ?? (rule as any).name,
          hostId,
          forwardType: nextForwardType,
          protocol: nextProtocol,
          gostMode: "direct",
          gostRelayHost: null,
          gostRelayPort: null,
          tunnelId: null,
          tunnelExitPort: null,
          forwardGroupId: groupId,
          forwardGroupRuleId: null,
          forwardGroupMemberId: null,
          isForwardGroupTemplate: true,
          sourcePort,
          targetIp: normalizeRuleTargetIp(input.targetIp ?? (rule as any).targetIp, { tunnelId: !isForwardChain && (group as any).groupType === "tunnel" ? 1 : null }),
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          telegramErrorNotifyEnabled: input.telegramErrorNotifyEnabled ?? (rule as any).telegramErrorNotifyEnabled,
          blockHttp: false,
          blockSocks: false,
          blockTls: false,
          ...normalizeProxyProtocolInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel" },
          ),
          ...normalizeTransportTuningInput(
            {},
            nextProtocol,
            nextForwardType,
            isForwardChain,
            { clearUnsupported: true, tunnelRoute: !isForwardChain && (group as any).groupType === "tunnel", forwardxTunnel: false },
          ),
          ...normalizeFailoverInput({
            failoverEnabled: false,
            failoverTargets: [],
          }, nextProtocol),
          isEnabled: input.isEnabled ?? (rule as any).isEnabled,
          isRunning: false,
          pendingDelete: false,
        };
        if (data.isEnabled) {
          data.disabledByUser = false;
          data.disabledByTunnel = false;
          data.disabledByGroup = false;
          data.protocolBlockReason = null;
        }
        await db.updateForwardRule(input.id, data);
        await db.clearForwardRuleTunnelExits(input.id);
        if ((rule as any).tunnelId) {
          const oldTunnel = await db.getTunnelById((rule as any).tunnelId);
          await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
          if (oldTunnel) await pushTunnelEndpointRefresh(oldTunnel, "forward-rule-route-changed");
        } else if (Number((rule as any).hostId || 0) > 0) {
          pushAgentRefresh(Number((rule as any).hostId), "forward-rule-route-changed");
        }
        await db.syncForwardGroupRules(groupId);
        await db.runForwardGroupFailover(groupId);
        return { success: true, reset: true };
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
      const routeChanged = String(nextForwardTypeForRule) !== String((rule as any).forwardType) || Number(nextTunnelIdForRule || 0) !== Number((rule as any).tunnelId || 0);
      await requireRuleProtocolEnabled({ ...rule, forwardType: nextForwardTypeForRule, tunnelId: nextTunnelIdForRule }, selectedTunnelForRule);
      const requestedMainBackupEnabled = input.failoverEnabled ?? (rule as any).failoverEnabled;
      const nextProtocolForRule = input.protocol ?? (rule as any).protocol;
      const nextMainBackupEnabled = routeChanged ? false : (nextProtocolForRule === "tcp" && nextForwardTypeForRule === "gost" ? requestedMainBackupEnabled : false);
      requireMainBackupAllowed({
        enabled: nextMainBackupEnabled,
        protocol: nextProtocolForRule,
        forwardType: nextForwardTypeForRule,
        tunnelId: nextTunnelIdForRule,
        tunnelMode: selectedTunnelForRule?.mode,
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
      if (!nextTunnelIdForRule) {
        const host = await db.getHostById(nextHostIdForRule);
        assertNoDirectSelfForwardLoop({
          host,
          sourcePort: nextSourcePortForRule,
          targetIp: input.targetIp ?? (rule as any).targetIp,
          targetPort: Number(input.targetPort ?? (rule as any).targetPort),
          tunnelId: nextTunnelIdForRule,
        });
      }
      const shouldCheckSourcePort = input.sourcePort !== undefined
        || input.protocol !== undefined
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
          const sourceReservation = await reserveRulePort(nextHostIdForRule, nextSourcePortForRule, nextProtocolForRule, rule.id);
          if (!sourceReservation) {
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
        input.autoFailback !== undefined ||
        routeChanged ||
        nextMainBackupEnabled !== requestedMainBackupEnabled
      ) {
        Object.assign(data as any, normalizeFailoverInput({
          failoverEnabled: nextMainBackupEnabled,
          failoverStrategy: routeChanged ? "fallback" : input.failoverStrategy ?? (rule as any).failoverStrategy ?? "fallback",
          failoverTargets: nextMainBackupEnabled && !routeChanged ? (input.failoverTargets ?? parseFailoverTargets((rule as any).failoverTargets)) : [],
          failoverSeconds: routeChanged ? 60 : input.failoverSeconds ?? (rule as any).failoverSeconds,
          recoverSeconds: routeChanged ? 120 : input.recoverSeconds ?? (rule as any).recoverSeconds,
          autoFailback: routeChanged ? true : input.autoFailback ?? (rule as any).autoFailback,
        }, nextProtocolForRule));
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
        input.failoverEnabled !== undefined ||
        routeChanged
      ) {
        const proxySource = routeChanged
          ? {}
          : nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : {
              proxyProtocolReceive: input.proxyProtocolReceive ?? (rule as any).proxyProtocolReceive,
              proxyProtocolSend: input.proxyProtocolSend ?? (rule as any).proxyProtocolSend,
              proxyProtocolExitReceive: input.proxyProtocolExitReceive ?? (rule as any).proxyProtocolExitReceive,
              proxyProtocolExitSend: input.proxyProtocolExitSend ?? (rule as any).proxyProtocolExitSend,
              proxyProtocolVersion: input.proxyProtocolVersion ?? (rule as any).proxyProtocolVersion,
              failoverEnabled: nextMainBackupEnabled,
            };
        Object.assign(data as any, normalizeProxyProtocolInput({
          ...proxySource,
          failoverEnabled: nextMainBackupEnabled,
        }, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, { clearUnsupported: true, tunnelRoute: !!nextTunnelIdForRule }));
      }
      if (
        input.tcpFastOpen !== undefined ||
        input.zeroCopy !== undefined ||
        input.udpOverTcp !== undefined ||
        input.udpOverTcpPort !== undefined ||
        input.protocol !== undefined ||
        input.forwardType !== undefined ||
        routeChanged
      ) {
        const transportSource = routeChanged
          ? {}
          : nextTunnelIdForRule && selectedTunnelForRule
          ? tunnelRuntimeOptionInput(selectedTunnelForRule)
          : {
              tcpFastOpen: input.tcpFastOpen ?? (rule as any).tcpFastOpen,
              zeroCopy: input.zeroCopy ?? (rule as any).zeroCopy,
              udpOverTcp: input.udpOverTcp ?? (rule as any).udpOverTcp,
              udpOverTcpPort: input.udpOverTcpPort ?? (rule as any).udpOverTcpPort,
            };
        const transportTuning = normalizeTransportTuningInput(transportSource, input.protocol ?? (rule as any).protocol, nextForwardTypeForRule, false, {
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
            const reservation = await reserveAvailableHostPort({
              hostId: Number(tunnel.exitHostId),
              protocol: "both",
              findPort: (reservedPorts) => db.findAvailableTunnelExitPort(
                tunnel.exitHostId,
                (exit as any)?.portRangeStart,
                (exit as any)?.portRangeEnd,
                reservedPorts,
                [Number(rule.id)],
              ),
              isUsed: (port) => db.isPortUsedOnHost(Number(tunnel.exitHostId), port, [Number(rule.id)], "both"),
            });
            if (!reservation) throw new Error("出口 Agent 已无可用隧道端口");
            heldReservations.push(reservation);
            (data as any).tunnelExitPort = reservation.port;
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
        const sourceReservation = await reserveRulePort(nextHostIdForRule, sourcePort, nextProtocolForRule, rule.id);
        if (!sourceReservation) throw new Error(`端口 ${sourcePort} 已被占用，请更换端口后再启用`);
        (data as any).disabledByUser = false;
        (data as any).disabledByTunnel = false;
        (data as any).disabledByGroup = false;
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
      } finally {
        releaseHostPortReservations(heldReservations);
      }
    })),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => deleteForwardRuleForActor(ctx.user, input.id)),
  deleteBatch: protectedProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const ids = Array.from(new Set(input.ids.map(Number)));
      const results = await mapWithConcurrency(ids, 8, async (id) => {
        try {
          await deleteForwardRuleForActor(ctx.user, id, { reasonPrefix: "batch-forward-rule" });
          return { id, success: true as const };
        } catch (error) {
          return {
            id,
            success: false as const,
            error: error instanceof Error ? error.message : String(error || "删除失败"),
          };
        }
      });
      const deletedIds = results.filter((item) => item.success).map((item) => item.id);
      const failures = results.filter((item): item is Extract<typeof item, { success: false }> => !item.success);
      return {
        success: failures.length === 0,
        requested: ids.length,
        deletedIds,
        failures,
      };
    }),
  toggle: protectedProcedure
    .input(z.object({ id: z.number(), isEnabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => toggleForwardRuleForActor(ctx.user, input.id, input.isEnabled))
});

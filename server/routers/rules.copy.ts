import { z } from "zod";
import * as db from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { pushAgentRefresh } from "../agentEvents";
import { requireHostUseAccess, requireRuleAccess } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { FORWARD_TYPES } from "../../shared/forwardTypes";
import { requireMainBackupAllowed } from "./rules.crud";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";

const conflictStrategySchema = z.enum(["skip", "auto", "error"]);

async function requireForwardAccessReady(userId: number) {
  const check = await db.ensureUserForwardAccessReady(userId);
  if (!check.allowed) {
    throw new Error(check.message || "您没有添加转发规则的权限，请联系管理员开通");
  }
  return check.user || await db.getUserById(userId);
}

async function requireTrafficBillingBalanceForCopy(userId: number, isTrafficBillingResource: boolean) {
  if (!isTrafficBillingResource) return;
  const user = await db.getUserById(userId);
  if (Number((user as any)?.balanceCents || 0) <= 0) {
    throw new Error("流量计费余额不足，请充值后再复制到该计费资源");
  }
}

function isDirectHostRuleCopyDisabled() {
  return true;
}

export const copyRulesRouter = router({
  copyToHosts: protectedProcedure
    .input(z.object({
      ruleIds: z.array(z.number().int().positive()).min(1),
      targetHostIds: z.array(z.number().int().positive()).min(1),
      conflictStrategy: conflictStrategySchema.default("skip"),
    }))
    .mutation(async ({ input, ctx }) => {
      if (isDirectHostRuleCopyDisabled()) {
        throw new Error("直接复制到主机已停用，请先创建转发组或转发链后再新增规则。");
      }
      let currentUser = await db.getUserById(ctx.user.id);
      if (ctx.user.role !== "admin") {
        currentUser = await requireForwardAccessReady(ctx.user.id);
      }
      if (!currentUser) throw new Error("用户不存在");
      const allowedForwardTypes = (() => {
        if (ctx.user.role === "admin") return null;
        const allowedRaw = (ctx.user as any).allowedForwardTypes as string | null | undefined;
        if (allowedRaw === null || allowedRaw === undefined) return null;
        return new Set(allowedRaw.split(",").map((item) => item.trim()).filter(Boolean));
      })();

      const uniqueRuleIds = Array.from(new Set(input.ruleIds));
      const uniqueTargetHostIds = Array.from(new Set(input.targetHostIds));
      const rules: any[] = [];
      for (const ruleId of uniqueRuleIds) {
        const rule = await requireRuleAccess(ctx, ruleId);
        if ((rule as any).tunnelId) {
          throw new Error("隧道转发规则暂不支持直接复制，请在目标隧道上重新创建");
        }
        if (!(FORWARD_TYPES as readonly string[]).includes(String(rule.forwardType))) {
          throw new Error(`规则 ${rule.name || rule.id} 的转发方式不支持复制`);
        }
        if (allowedForwardTypes && !allowedForwardTypes.has(String(rule.forwardType))) {
          throw new Error(`您没有使用 ${rule.forwardType} 转发方式的权限，请联系管理员`);
        }
        requireMainBackupAllowed({
          enabled: !!(rule as any).failoverEnabled,
          protocol: (rule as any).protocol,
          forwardType: (rule as any).forwardType,
          tunnelId: null,
          isAdmin: ctx.user.role === "admin",
        });
        await requireRuleProtocolEnabled(rule);
        rules.push(rule);
      }

      const targetHosts: Array<{ host: any; isTrafficBillingResource: boolean }> = [];
      for (const hostId of uniqueTargetHostIds) {
        const access = await requireHostUseAccess(ctx, hostId);
        targetHosts.push(access);
      }

      const copied: Array<{ sourceRuleId: number; targetHostId: number; newRuleId: number; sourcePort: number }> = [];
      const skipped: Array<{ sourceRuleId: number; targetHostId: number; reason: string }> = [];

      for (const { host, isTrafficBillingResource } of targetHosts) {
        for (const rule of rules) {
          if (Number(rule.hostId) === Number(host.id)) {
            skipped.push({ sourceRuleId: rule.id, targetHostId: host.id, reason: "源主机与目标主机相同" });
            continue;
          }

          if (ctx.user.role !== "admin") {
            await requireTrafficBillingBalanceForCopy(ctx.user.id, isTrafficBillingResource);
            if (currentUser.maxRules > 0) {
              const ruleCount = await db.getUserRuleCount(ctx.user.id);
              if (ruleCount >= currentUser.maxRules) {
                skipped.push({ sourceRuleId: rule.id, targetHostId: host.id, reason: `已达到最大规则数量限制（${currentUser.maxRules} 条）` });
                continue;
              }
            }
            if (currentUser.maxPorts > 0) {
              const portCount = await db.getUserPortCount(ctx.user.id);
              if (portCount >= currentUser.maxPorts) {
                skipped.push({ sourceRuleId: rule.id, targetHostId: host.id, reason: `已达到最大端口数量限制（${currentUser.maxPorts} 个）` });
                continue;
              }
            }
            if (!isTrafficBillingResource && Number((currentUser as any).trafficLimit || 0) > 0 && Number((currentUser as any).trafficUsed || 0) >= Number((currentUser as any).trafficLimit || 0)) {
              throw new Error("您的流量已用完，无法复制规则");
            }
          }

          let sourcePort = Number(rule.sourcePort);
          let effectivePolicy = portPolicyFrom(host as any);
          const planRange = ctx.user.role !== "admin"
            ? await db.getUserPlanPortRange(ctx.user.id, Number(host.id))
            : null;
          if (planRange) {
            effectivePolicy = combinePortPolicies(effectivePolicy, portPolicyFrom({ portRangeStart: planRange.start, portRangeEnd: planRange.end }));
          }
          const outOfRange = !isPortAllowedByPolicy(sourcePort, effectivePolicy);
          const used = await db.isPortUsedOnHost(Number(host.id), sourcePort);
          if (used || outOfRange) {
            if (input.conflictStrategy === "skip") {
              skipped.push({
                sourceRuleId: rule.id,
                targetHostId: host.id,
                reason: outOfRange ? portPolicyErrorMessage(effectivePolicy, `端口 ${sourcePort}`) : `端口 ${sourcePort} 已被占用`,
              });
              continue;
            }
            if (input.conflictStrategy === "error") {
              throw new Error(outOfRange
                ? `${host.name} ${portPolicyErrorMessage(effectivePolicy, `端口 ${sourcePort}`)}`
                : `${host.name} 的端口 ${sourcePort} 已被占用`);
            }
            const nextPort = await db.findAvailablePort(Number(host.id), planRange?.start ?? null, planRange?.end ?? null);
            if (!nextPort) {
              skipped.push({ sourceRuleId: rule.id, targetHostId: host.id, reason: "目标主机无可用端口" });
              continue;
            }
            sourcePort = nextPort;
          }

          const id = await db.createForwardRule({
            hostId: Number(host.id),
            name: rule.name,
            forwardType: rule.forwardType,
            protocol: rule.protocol,
            gostMode: "direct",
            gostRelayHost: null,
            gostRelayPort: null,
            tunnelId: null,
            tunnelExitPort: null,
            sourcePort,
            targetIp: rule.targetIp,
            targetPort: Number(rule.targetPort),
            blockHttp: false,
            blockSocks: false,
            blockTls: false,
            proxyProtocolReceive: !!(rule as any).proxyProtocolReceive,
            proxyProtocolSend: !!(rule as any).proxyProtocolSend,
            proxyProtocolExitReceive: false,
            proxyProtocolExitSend: false,
            proxyProtocolVersion: Number((rule as any).proxyProtocolVersion) === 2 ? 2 : 1,
            tcpFastOpen: !!(rule as any).tcpFastOpen,
            zeroCopy: !!(rule as any).zeroCopy,
            udpOverTcp: false,
            udpOverTcpPort: null,
            failoverEnabled: !!(rule as any).failoverEnabled,
            failoverStrategy: (rule as any).failoverStrategy || "fallback",
            failoverTargets: (rule as any).failoverTargets || null,
            failoverSeconds: Number((rule as any).failoverSeconds || 60),
            recoverSeconds: Number((rule as any).recoverSeconds || 120),
            autoFailback: (rule as any).autoFailback !== false,
            isEnabled: !!rule.isEnabled,
            isRunning: false,
            pendingDelete: false,
            userId: ctx.user.id,
          } as any);
          copied.push({ sourceRuleId: rule.id, targetHostId: Number(host.id), newRuleId: id, sourcePort });
          pushAgentRefresh(Number(host.id), "forward-rule-copied");
        }
      }

      return { copied, skipped };
    }),
});

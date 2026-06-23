import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { pushTunnelEndpointRefresh } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { createQueryCache } from "../queryCache";

const selfTestQueryCache = createQueryCache(300);

function sortedEnabledHostMembers(group: any) {
  return [...(group?.members || [])]
    .filter((member: any) => member.memberType === "host" && !!member.isEnabled)
    .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
}

async function resolveForwardChainSelfTestEntry(group: any, chainMembers: any[], fallbackHostId: number) {
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
    if (!entryGroup || String(entryGroup.groupMode || "failover") !== "entry" || !entryGroup.isEnabled) {
      throw new Error("端口转发链入口组不可用");
    }
    const entryMembers = sortedEnabledHostMembers(entryGroup);
    if (entryMembers.length < 1) throw new Error("端口转发链入口组没有可用入口主机");
    if (chainMembers.length < 1) throw new Error("端口转发链至少需要一台已启用主机");
    const firstEntry = entryMembers[0];
    const hostId = Number(firstEntry.hostId || fallbackHostId);
    const entryIp = String(firstEntry.entryAddress || "").trim();
    if (!hostId) throw new Error("端口转发链入口组主机不可用");
    if (!entryIp) throw new Error("端口转发链入口组主机未配置入口地址");
    return { hostId, entryIp, entryGroupId };
  }

  if (chainMembers.length < 2) throw new Error("端口转发链至少需要两台已启用主机");
  const first = chainMembers[0];
  const hostId = Number(first.hostId || fallbackHostId);
  const entryIp = String(first.entryAddress || "").trim();
  if (!entryIp) throw new Error("端口转发链第一台主机未配置入口地址");
  return { hostId, entryIp, entryGroupId: null };
}

export const selfTestRulesRouter = router({
  tcpingSeries: protectedProcedure
    .input(z.object({
      ruleId: z.number(),
      hours: z.number().min(1).max(48).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return selfTestQueryCache.get(
        `tcpingSeries:${ctx.user.id}:${input.ruleId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getTcpingSeriesByRule(input.ruleId, { since }),
      );
    }),

  startSelfTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权操作此规则");
      }
      await requireRuleProtocolEnabled(rule);
      let hostId = rule.hostId;
      let message: string | null = null;
      if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
        const group = await db.getForwardGroupById(Number((rule as any).forwardGroupId)) as any;
        if (String(group?.groupMode || "failover") === "chain") {
          const members = sortedEnabledHostMembers(group);
          const entry = await resolveForwardChainSelfTestEntry(group, members, Number(rule.hostId || 0));
          hostId = entry.hostId;
          await db.syncForwardGroupRules(Number(group.id));
          message = JSON.stringify({
            kind: "forward-chain",
            groupId: group.id,
            entryGroupId: entry.entryGroupId,
            entryIp: entry.entryIp,
            entrySourcePort: rule.sourcePort,
            targetIp: rule.targetIp,
            targetPort: rule.targetPort,
          });
          appendPanelLog("info", `[SelfTest] rule=${rule.id} forward-chain=${group.id} queued entry-port test from host=${hostId} entry=${entry.entryIp}:${rule.sourcePort} target=${rule.targetIp}:${rule.targetPort}${entry.entryGroupId ? ` entryGroup=${entry.entryGroupId}` : ""}`);
        }
      }
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        if (!tunnel) throw new Error("隧道不存在");
        hostId = tunnel.exitHostId;
        const targetIp = rule.targetIp;
        if (!targetIp) throw new Error("目标地址不可用，请检查规则目标地址");
        const pushed = await pushTunnelEndpointRefresh(tunnel, "forward-selftest-via-tunnel");
        message = JSON.stringify({
          kind: "forward-via-tunnel",
          tunnelId: tunnel.id,
          entryHostId: tunnel.entryHostId,
          exitHostId: tunnel.exitHostId,
          targetIp,
          targetPort: rule.targetPort,
          refreshPushed: pushed,
        });
        appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} queued tunnel+target test from exitHost=${tunnel.exitHostId} to target=${targetIp}:${rule.targetPort}`);
      }
      const id = await db.createForwardTest({
        ruleId: rule.id,
        hostId,
        userId: rule.userId,
        status: "pending",
        listenOk: false,
        targetReachable: false,
        forwardOk: false,
        message,
      });
      pushAgentRefresh(hostId, "forward-selftest");
      if (!(rule as any).tunnelId) {
        appendPanelLog("info", `[SelfTest] rule=${rule.id} queued direct test=${id} from host=${hostId} to target=${rule.targetIp}:${rule.targetPort}`);
      }
      return { id };
    }),

  latestTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        return null;
      }
      const t = await db.getLatestForwardTest(input.ruleId);
      return t || null;
    })
});

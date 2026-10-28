import { z } from "zod";
import { nanoid } from "nanoid";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskToken } from "./helpers";
import { isHostStatusOnline } from "../hostStatusNotifier";

function ruleOwnerSummary(owners: Array<{ userId: number; username: string | null; name: string | null; ruleCount: number }>) {
  const visibleOwners = owners.slice(0, 5);
  const labels = visibleOwners.map((owner) => {
    const username = owner.username || `用户 ID ${owner.userId}`;
    const label = owner.name && owner.name !== username ? `${owner.name}（${username}）` : username;
    return `用户 ${label}：${owner.ruleCount} 条`;
  });
  const hiddenRuleCount = owners.slice(visibleOwners.length)
    .reduce((total, owner) => total + owner.ruleCount, 0);
  if (hiddenRuleCount > 0) labels.push(`其他用户 ${hiddenRuleCount} 条`);
  return labels.join("、");
}

export const agentTokensRouter = router({
  list: adminProcedure.query(async () => {
    const tokens = await db.getAgentTokens();
    return tokens.map((token: any) => ({
      ...token,
      token: maskToken(token.token),
    }));
  }),
  create: adminProcedure
    .input(z.object({ description: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const token = nanoid(32);
      const id = await db.createAgentToken({
        token,
        description: input.description ?? null,
        userId: ctx.user.id,
      });
      return { id, token };
    }),
  update: adminProcedure
    .input(z.object({ id: z.number(), description: z.string().max(200).nullable().optional() }))
    .mutation(async ({ input }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      const description = input.description?.trim() || null;
      await db.updateAgentTokenDescription(input.id, description);
      return { success: true };
    }),
  reorder: adminProcedure
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000) }))
    .mutation(async ({ input }) => {
      await db.reorderAgentTokens(input.ids);
      return { success: true };
    }),
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      let releasedPendingCleanup = 0;
      const hostIds = new Set<number>();
      if (token.hostId) hostIds.add(Number(token.hostId));
      if (token.token) {
        const boundHost = await db.getHostByAgentToken(token.token);
        if (boundHost?.id) hostIds.add(Number(boundHost.id));
      }
      for (const hostId of hostIds) {
        const blockers = await db.getHostRuleDeleteBlockers(hostId);
        if (blockers.ruleCount > 0) {
          const ownerSummary = ctx.user.role === "admin" ? ruleOwnerSummary(blockers.ruleOwners) : "";
          const ownerHint = ownerSummary ? `：${ownerSummary}` : "";
          throw new Error(`该 Token 关联主机下还有 ${blockers.ruleCount} 条未删除的转发规则${ownerHint}。请先删除这些规则后再删除 Token`);
        }
        if (blockers.managedRuleCount > 0) {
          const ownerSummary = ctx.user.role === "admin" ? ruleOwnerSummary(blockers.managedRuleOwners) : "";
          const ownerHint = ownerSummary ? `：${ownerSummary}` : "";
          throw new Error(`该 Token 关联主机仍被 ${blockers.managedRuleCount} 条未删除的转发组/转发链规则引用${ownerHint}。请先移除引用后再删除 Token`);
        }
        releasedPendingCleanup += await db.releaseHostPendingRuleCleanup(hostId);
      }
      await db.deleteAgentToken(input.id);
      let removedHosts = 0;
      for (const hostId of hostIds) {
        if (await db.deleteHostIfUnreferenced(hostId)) removedHosts += 1;
      }
      return { success: true, releasedPendingCleanup, removedHosts };
    }),
  getInstallToken: adminProcedure
    .input(z.object({ id: z.number().optional(), token: z.string().optional() }))
    .query(async ({ input }) => {
      if (!input.id && !input.token) throw new Error("缺少 Token 参数");
      const token = input.id
        ? await db.getAgentTokenById(input.id)
        : await db.getAgentTokenByToken(input.token!);
      if (!token) throw new Error("Token 不存在");
      const host = await db.getHostByAgentToken(token.token);
      return { token: token.token, boundHost: host ? { id: host.id, name: host.name, isOnline: isHostStatusOnline(host) } : null };
    }),
});

import { z } from "zod";
import { nanoid } from "nanoid";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskToken } from "./helpers";
import { isHostStatusOnline } from "../hostStatusNotifier";
import { hostAgentPanelUrlOverride } from "../../shared/agentPanelUrl";

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
    .input(z.object({
      description: z.string().max(200).optional(),
      registrationMode: z.enum(["single", "batch"]).optional().default("single"),
      maxRegistrations: z.number().int().min(0).max(1000).optional().default(1),
      registrationExpiryDays: z.number().int().min(0).max(365).optional().default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const token = nanoid(32);
      const registrationMode = input.registrationMode === "batch" ? "batch" : "single";
      const maxRegistrations = registrationMode === "batch" ? Math.max(0, Number(input.maxRegistrations || 0)) : 1;
      const expiryDays = registrationMode === "batch" ? Math.max(0, Number(input.registrationExpiryDays || 0)) : 0;
      const id = await db.createAgentToken({
        token,
        description: input.description ?? null,
        registrationMode,
        maxRegistrations,
        registrationExpiresAt: expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400 * 1000) : null,
        usedRegistrations: 0,
        userId: ctx.user.id,
      });
      return { id, token };
    }),
  update: adminProcedure
    .input(z.object({
      id: z.number(),
      description: z.string().max(200).nullable().optional(),
      maxRegistrations: z.number().int().min(0).max(1000).optional(),
      registrationExpiryDays: z.number().int().min(0).max(365).optional(),
    }))
    .mutation(async ({ input }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      const description = input.description?.trim() || null;
      if (token.registrationMode === "batch" && (input.maxRegistrations !== undefined || input.registrationExpiryDays !== undefined)) {
        const maxRegistrations = Math.max(Number(token.usedRegistrations || 0), Math.max(0, Number(input.maxRegistrations ?? token.maxRegistrations ?? 0)));
        const expiryDays = input.registrationExpiryDays === undefined
          ? null
          : Math.max(0, Number(input.registrationExpiryDays));
        await db.updateBatchAgentToken(input.id, {
          description: input.description === undefined ? token.description : description,
          maxRegistrations,
          registrationExpiresAt: expiryDays === null
            ? token.registrationExpiresAt
            : expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400 * 1000) : null,
        });
      } else {
        await db.updateAgentTokenDescription(input.id, description);
      }
      return { success: true };
    }),
  removeHost: adminProcedure
    .input(z.object({ id: z.number().int().positive(), hostId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      await db.detachHostFromAgentToken(token.token, input.hostId);
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
        const boundHosts = await db.getHostsByAgentToken(token.token);
        for (const boundHost of boundHosts) if (boundHost?.id) hostIds.add(Number(boundHost.id));
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
      const host = token.hostId ? await db.getHostById(token.hostId) : await db.getHostByAgentToken(token.token);
      return { token: token.token, agentPanelUrl: hostAgentPanelUrlOverride(host), boundHost: host ? { id: host.id, name: host.name, isOnline: isHostStatusOnline(host) } : null };
    }),
});

import { z } from "zod";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { maskToken } from "./helpers";

export const agentTokensRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.user.role === "admin";
    const tokens = await db.getAgentTokens(isAdmin ? undefined : ctx.user.id);
    return tokens.map((token: any) => ({
      ...token,
      token: maskToken(token.token),
    }));
  }),
  create: protectedProcedure
    .input(z.object({ description: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const token = nanoid(32);
      const id = await db.createAgentToken({
        token,
        description: input.description ?? null,
        userId: ctx.user.id,
      });
      return { id, token };
    }),
  update: protectedProcedure
    .input(z.object({ id: z.number(), description: z.string().max(200).nullable().optional() }))
    .mutation(async ({ input, ctx }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权修改该 Token");
      }
      const description = input.description?.trim() || null;
      await db.updateAgentTokenDescription(input.id, description);
      return { success: true };
    }),
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const token = await db.getAgentTokenById(input.id);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权删除该 Token");
      }
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
          throw new Error(`该 Token 关联主机下还有 ${blockers.ruleCount} 条转发规则，请先删除所有规则后再删除 Token`);
        }
        if (blockers.managedRuleCount > 0) {
          throw new Error(`该 Token 关联主机仍被 ${blockers.managedRuleCount} 条转发组/转发链规则引用，请先移除引用后再删除 Token`);
        }
        releasedPendingCleanup += await db.releaseHostPendingRuleCleanup(hostId);
      }
      await db.deleteAgentToken(input.id);
      return { success: true, releasedPendingCleanup };
    }),
  getInstallToken: protectedProcedure
    .input(z.object({ id: z.number().optional(), token: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      if (!input.id && !input.token) throw new Error("缺少 Token 参数");
      const token = input.id
        ? await db.getAgentTokenById(input.id)
        : await db.getAgentTokenByToken(input.token!);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权使用该 Token");
      }
      return { token: token.token };
    }),
});

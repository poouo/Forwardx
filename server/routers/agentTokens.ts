import { z } from "zod";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import { generateInstallScript } from "../agentInstallScripts";
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
      await db.deleteAgentToken(input.id);
      return { success: true };
    }),
  getInstallScript: protectedProcedure
    .input(z.object({ id: z.number().optional(), token: z.string().optional(), panelUrl: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      if (!input.id && !input.token) throw new Error("缺少 Token 参数");
      const token = input.id
        ? await db.getAgentTokenById(input.id)
        : await db.getAgentTokenByToken(input.token!);
      if (!token) throw new Error("Token 不存在");
      if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
        throw new Error("无权使用该 Token");
      }
      const reqAny = ctx.req as any;
      const fallbackHost = reqAny?.get?.("host") || "localhost:3000";
      const fallbackProto = reqAny?.protocol || "http";
      const panelUrl = input.panelUrl || `${fallbackProto}://${fallbackHost}`;
      const script = generateInstallScript(panelUrl, token.token);
      return { script, token: token.token };
    }),
});

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "../mcpTokens";

export const mcpRouter = router({
  tokens: adminProcedure.query(({ ctx }) => listMcpTokens(ctx.user.id)),
  createToken: adminProcedure.input(z.object({ name: z.string().trim().min(1).max(80), days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }).strict())
    .mutation(({ ctx, input }) => createMcpToken(ctx.user.id, input.name, input.days)),
  revokeToken: adminProcedure.input(z.object({ id: z.number().int().positive() }).strict())
    .mutation(async ({ ctx, input }) => { await revokeMcpToken(ctx.user.id, input.id); return { success: true }; }),
});

import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { copyRulesRouter } from "./rules.copy";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";

export const rulesRouter = router({
  list: protectedProcedure
    .input(z.object({ hostId: z.number().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getForwardRules(isAdmin ? undefined : ctx.user.id, input?.hostId);
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      return rule;
    }),
  ...portsRulesRouter._def.procedures,
  ...copyRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});

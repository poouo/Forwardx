import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { requireRuleAccess } from "./helpers";

export const trafficRulesRouter = router({
  traffic: protectedProcedure
    .input(z.object({ ruleId: z.number(), limit: z.number().default(60) }))
    .query(async ({ input, ctx }) => {
      await requireRuleAccess(ctx, input.ruleId);
      return db.getTrafficStats(input.ruleId, input.limit);
    }),
  trafficSummary: protectedProcedure
    .input(
      z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        hostId: z.number().optional(),
        ruleIds: z.array(z.number()).max(1000).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      const isAdmin = ctx.user.role === "admin";
      return db.getTrafficSummaryByRule({
        userId: isAdmin ? undefined : ctx.user.id,
        hostId: input.hostId,
        since,
        ruleIds: input.ruleIds,
      });
    }),
  trafficSeries: protectedProcedure
    .input(
      z.object({
        ruleId: z.number(),
        hours: z.number().min(1).max(24 * 30).default(1),
        bucketMinutes: z.number().min(1).max(60).default(1),
      })
    )
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return db.getTrafficSeriesByRule(input.ruleId, {
        bucketMinutes: input.bucketMinutes,
        since,
      });
    })
});

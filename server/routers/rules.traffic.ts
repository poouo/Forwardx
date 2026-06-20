import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { lookupAddressGeo } from "../hostGeo";
import { requireRuleAccess } from "./helpers";
import { createQueryCache } from "../queryCache";

const trafficQueryCache = createQueryCache(500);

export const trafficRulesRouter = router({
  traffic: protectedProcedure
    .input(z.object({ ruleId: z.number(), limit: z.number().default(60) }))
    .query(async ({ input, ctx }) => {
      await requireRuleAccess(ctx, input.ruleId);
      return trafficQueryCache.get(
        `traffic:${ctx.user.id}:${input.ruleId}:${input.limit}`,
        { ttlMs: 10_000, staleMs: 60_000 },
        () => db.getTrafficStats(input.ruleId, input.limit),
      );
    }),
  targetGeoBatch: protectedProcedure
    .input(z.object({ targets: z.array(z.string().trim().min(1).max(253)).max(100) }))
    .query(async ({ input, ctx }) => {
      const uniqueTargets = Array.from(new Set(input.targets.map((target) => target.trim()).filter(Boolean)));
      const rules = await db.getForwardRules(ctx.user.role === "admin" ? undefined : ctx.user.id);
      const allowedTargets = new Set(rules.map((rule: any) => String(rule.targetIp || "").trim().toLowerCase()).filter(Boolean));
      const visibleTargets = uniqueTargets.filter((target) => allowedTargets.has(target.toLowerCase()));
      const rows: Array<{ target: string; geo: Awaited<ReturnType<typeof lookupAddressGeo>> }> = [];

      for (let index = 0; index < visibleTargets.length; index += 4) {
        const batch = visibleTargets.slice(index, index + 4);
        const results = await Promise.all(batch.map(async (target) => ({
          target,
          geo: await lookupAddressGeo(target),
        })));
        rows.push(...results);
      }

      return rows;
    }),
  trafficSummary: protectedProcedure
    .input(
      z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        range: z.enum(["24h", "total"]).default("24h"),
        hostId: z.number().optional(),
        ruleIds: z.array(z.number()).max(1000).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const since = input.range === "total" ? undefined : new Date(Date.now() - input.hours * 3600 * 1000);
      const isAdmin = ctx.user.role === "admin";
      const ruleIds = Array.from(new Set((input.ruleIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)))
        .sort((a, b) => a - b);
      const ruleKey = ruleIds.join(",");
      return trafficQueryCache.get(
        `summary:${ctx.user.id}:${input.range}:${input.hours}:${input.hostId || 0}:${ruleKey}`,
        { ttlMs: 15_000, staleMs: 2 * 60_000 },
        () => db.getTrafficSummaryByRule({
          userId: isAdmin ? undefined : ctx.user.id,
          hostId: input.hostId,
          since,
          ruleIds,
        }),
      );
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
      return trafficQueryCache.get(
        `series:${ctx.user.id}:${input.ruleId}:${input.hours}:${input.bucketMinutes}`,
        { ttlMs: 15_000, staleMs: 2 * 60_000 },
        () => db.getTrafficSeriesByRule(input.ruleId, {
          bucketMinutes: input.bucketMinutes,
          since,
        }),
      );
    })
});

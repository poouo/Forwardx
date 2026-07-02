import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { lookupAddressGeo } from "../hostGeo";
import { requireRuleAccess } from "./helpers";
import { appendPanelLog } from "../_core/panelLogger";
import { createQueryCache } from "../queryCache";

const trafficQueryCache = createQueryCache(500);
const TRAFFIC_RETENTION_HOURS = 24 * 3;

function ruleResetLogItem(rule: any) {
  const id = Number(rule?.id || 0) || "-";
  const name = String(rule?.name || "").trim() || "-";
  const host = Number(rule?.hostId || 0) || "-";
  const tunnel = Number(rule?.tunnelId || 0) || "-";
  const sourcePort = Number(rule?.sourcePort || 0) || "-";
  const target = `${String(rule?.targetIp || "-").trim() || "-"}:${Number(rule?.targetPort || 0) || "-"}`;
  return `${id}:${name} host=${host} tunnel=${tunnel} type=${rule?.forwardType || "-"} proto=${rule?.protocol || "-"} port=${sourcePort} target=${target}`;
}

export const trafficRulesRouter = router({
  resetTraffic: protectedProcedure
    .input(z.object({
      scope: z.enum(["rule", "all"]),
      ruleId: z.number().optional(),
      ruleIds: z.array(z.number()).max(5000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      let targetRuleIds: number[] = [];
      if (input.scope === "rule") {
        const ruleId = Number(input.ruleId || 0);
        if (!Number.isInteger(ruleId) || ruleId <= 0) throw new Error("请选择要重置的规则");
        await requireRuleAccess(ctx, ruleId);
        targetRuleIds = [ruleId];
      } else {
        const requestedRuleIds = Array.from(new Set<number>((input.ruleIds || [])
          .map((id) => Number(id))
          .filter((id): id is number => Number.isInteger(id) && id > 0)));
        const visibleRules = await db.getForwardRules(ctx.user.role === "admin" ? undefined : ctx.user.id);
        const visibleRuleIds = new Set<number>((visibleRules || [])
          .map((rule: any) => Number(rule.id || 0))
          .filter((id: number): id is number => Number.isInteger(id) && id > 0));
        targetRuleIds = requestedRuleIds.length > 0
          ? requestedRuleIds.filter((id) => visibleRuleIds.has(id))
          : Array.from(visibleRuleIds);
      }
      targetRuleIds = Array.from(new Set(targetRuleIds)).sort((a, b) => a - b);
      if (targetRuleIds.length === 0) throw new Error("没有可重置的规则流量");
      const rules = await Promise.all(targetRuleIds.slice(0, 20).map((ruleId) => db.getForwardRuleById(ruleId).catch(() => null)));
      const omitted = Math.max(0, targetRuleIds.length - rules.filter(Boolean).length);
      appendPanelLog(
        "info",
        `[RuleTraffic] reset scope=${input.scope} count=${targetRuleIds.length} rules=${rules.filter(Boolean).map(ruleResetLogItem).join(" | ") || "-"}${omitted > 0 ? ` omitted=${omitted}` : ""}`,
      );
      const result = await db.resetRuleTrafficStats(targetRuleIds);
      trafficQueryCache.clear();
      return result;
    }),
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
        hours: z.number().min(1).max(TRAFFIC_RETENTION_HOURS).default(24),
        range: z.enum(["24h", "total"]).default("24h"),
        hostId: z.number().optional(),
        ruleIds: z.array(z.number()).max(1000).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const hours = input.range === "total" ? 0 : Math.min(input.hours, TRAFFIC_RETENTION_HOURS);
      const since = input.range === "total" ? undefined : new Date(Date.now() - hours * 3600 * 1000);
      const isAdmin = ctx.user.role === "admin";
      const ruleIds = Array.from(new Set((input.ruleIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)))
        .sort((a, b) => a - b);
      const ruleKey = ruleIds.join(",");
      return trafficQueryCache.get(
        `summary:${ctx.user.id}:${input.range}:${hours}:${input.hostId || 0}:${ruleKey}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => input.range === "total"
          ? db.getTrafficCounterSummaryByRule({
            userId: isAdmin ? undefined : ctx.user.id,
            hostId: input.hostId,
            ruleIds,
          })
          : db.getTrafficSummaryByRule({
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
        hours: z.number().min(1).max(TRAFFIC_RETENTION_HOURS).default(1),
        bucketMinutes: z.number().min(1).max(60).default(1),
      })
    )
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const hours = Math.min(input.hours, TRAFFIC_RETENTION_HOURS);
      const since = new Date(Date.now() - hours * 3600 * 1000);
      return trafficQueryCache.get(
        `series:${ctx.user.id}:${input.ruleId}:${hours}:${input.bucketMinutes}`,
        { ttlMs: 15_000, staleMs: 2 * 60_000 },
        () => db.getTrafficSeriesByRule(input.ruleId, {
          bucketMinutes: input.bucketMinutes,
          since,
        }),
      );
    })
});

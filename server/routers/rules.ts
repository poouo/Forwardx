import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";

function isVisibleForwardGroupRuleForUser(rule: any, allowedForwardGroupIds: Set<number>) {
  return !!rule?.isForwardGroupTemplate
    && !!rule?.forwardGroupId
    && !rule?.forwardGroupRuleId
    && !rule?.forwardGroupMemberId
    && allowedForwardGroupIds.has(Number(rule.forwardGroupId));
}


type RuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleListFilters = {
  userId?: number;
  scope?: "self" | "all";
  entryHostId?: number | null;
  category: RuleListCategory;
  search: string;
};

async function getRuleListRepositoryInput(
  input: RuleListFilters,
  user: { id: number; role: string },
) {
  const isAdmin = user.role === "admin";
  const ownerUserId = isAdmin
    ? input.scope === "all"
      ? undefined
      : input.userId ?? user.id
    : user.id;
  return {
    ownerUserId,
    allowedForwardGroupIds: isAdmin
      ? undefined
      : await db.getUserAllowedForwardGroupIds(user.id),
    entryHostId: input.entryHostId,
    category: input.category,
    search: input.search,
  };
}

export const rulesRouter = router({
  list: protectedProcedure
    .input(z.object({
      hostId: z.number().optional(),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      tunnelId: z.number().nullable().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const requestedUserId = isAdmin
        ? input?.scope === "all"
          ? undefined
          : input?.userId ?? ctx.user.id
        : ctx.user.id;
      const rules = await db.getForwardRules(requestedUserId, input?.hostId);
      const allowedForwardGroupIds = isAdmin ? new Set<number>() : new Set(await db.getUserAllowedForwardGroupIds(ctx.user.id));
      const visibleRules = isAdmin
        ? rules
        : rules.filter((rule: any) => {
          const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
          return !isForwardGroupRule || isVisibleForwardGroupRuleForUser(rule, allowedForwardGroupIds);
        });
      if (input?.tunnelId === undefined) return visibleRules;
      if (input.tunnelId === null) return visibleRules.filter((rule: any) => !rule.tunnelId);
      return visibleRules.filter((rule: any) => Number(rule.tunnelId || 0) === Number(input.tunnelId));
    }),
  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      return db.getForwardRulesPage({ ...repositoryInput, page: input.page, pageSize: input.pageSize });
    }),
  mapItems: protectedProcedure
    .input(z.object({
      cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(20).max(250).default(100),
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      return db.getForwardRuleMapBatch(repositoryInput, input.cursor || 0, input.limit);
    }),
  listSummary: protectedProcedure
    .input(z.object({
      userId: z.number().optional(),
      scope: z.enum(["self", "all"]).optional(),
      entryHostId: z.number().int().positive().nullable().optional(),
      category: z.enum(["all", "local", "tunnel", "chain", "group"]).default("all"),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const repositoryInput = await getRuleListRepositoryInput(input, ctx.user);
      const selection = await db.getForwardRuleSummarySelection(repositoryInput);
      const [totalRows, dailyRows] = selection.ruleIds.length > 0
        ? await Promise.all([
          db.getTrafficCounterSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
          }),
          db.getTrafficSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds: selection.ruleIds,
            since: new Date(Date.now() - 24 * 60 * 60 * 1000),
          }),
        ])
        : [[], []];
      const sumRows = (rows: any[]) => rows.reduce((total, row) => ({
        bytesIn: total.bytesIn + Math.max(0, Number(row?.bytesIn) || 0),
        bytesOut: total.bytesOut + Math.max(0, Number(row?.bytesOut) || 0),
        connections: total.connections + Math.max(0, Number(row?.connections) || 0),
      }), { bytesIn: 0, bytesOut: 0, connections: 0 });
      return {
        totalItems: selection.totalItems,
        activeItems: selection.activeItems,
        totalTraffic: sumRows(totalRows as any[]),
        dailyTraffic: sumRows(dailyRows as any[]),
      };
    }),
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.id);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
      if (ctx.user.role !== "admin") {
        const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
        if (isForwardGroupRule) {
          const allowedForwardGroupIds = new Set(await db.getUserAllowedForwardGroupIds(ctx.user.id));
          if (!isVisibleForwardGroupRuleForUser(rule, allowedForwardGroupIds)) return null;
        }
      }
      return rule;
    }),
  reorder: protectedProcedure
    .input(z.object({
      category: z.enum(["local", "tunnel", "chain", "group"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.reorderForwardRules(input.category, input.ids, ctx.user.role === "admin" ? undefined : ctx.user.id, input.startIndex);
      return { success: true };
    }),
  ...portsRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});

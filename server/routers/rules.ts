import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { crudRulesRouter } from "./rules.crud";
import { copyRulesRouter } from "./rules.copy";
import { portsRulesRouter } from "./rules.ports";
import { selfTestRulesRouter } from "./rules.selfTest";
import { trafficRulesRouter } from "./rules.traffic";
import { paginateItems } from "../../shared/pagination";

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

async function getFilteredRuleList(input: RuleListFilters, user: { id: number; role: string }) {
  const isAdmin = user.role === "admin";
  const requestedUserId = isAdmin
    ? input.scope === "all"
      ? undefined
      : input.userId ?? user.id
    : user.id;
  const rules = await db.getForwardRules(requestedUserId);
  const allowedForwardGroupIds = isAdmin ? new Set<number>() : new Set(await db.getUserAllowedForwardGroupIds(user.id));
  const visibleRules = isAdmin
    ? rules
    : rules.filter((rule: any) => {
      const isForwardGroupRule = !!(rule?.forwardGroupId || rule?.isForwardGroupTemplate || rule?.forwardGroupRuleId || rule?.forwardGroupMemberId);
      return !isForwardGroupRule || isVisibleForwardGroupRuleForUser(rule, allowedForwardGroupIds);
    });
  const [groups, tunnels, hosts, users] = await Promise.all([
    db.getForwardGroups(undefined, { includeRuntime: false }),
    db.getTunnels(),
    input.search || input.entryHostId ? db.getHosts() : Promise.resolve([]),
    isAdmin && input.search ? db.getAllUsers() : Promise.resolve([]),
  ]);
  const groupById = new Map((groups as any[]).map((group: any) => [Number(group.id), group]));
  const tunnelById = new Map((tunnels as any[]).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const hostById = new Map((hosts as any[]).map((host: any) => [Number(host.id), host]));
  const userById = new Map((users as any[]).map((owner: any) => [Number(owner.id), owner]));
  const categoryOf = (rule: any): Exclude<RuleListCategory, "all"> => {
    const group = groupById.get(Number(rule.forwardGroupId || 0)) as any;
    const mode = String(group?.groupMode || "");
    if (mode === "port") return "local";
    if (mode === "chain") return "chain";
    if (group) return "group";
    return rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local";
  };
  const entryHostIdOf = (rule: any) => {
    const group = groupById.get(Number(rule.forwardGroupId || 0)) as any;
    if (group) {
      const member = [...(group.members || [])]
        .filter((item: any) => item.isEnabled !== false)
        .sort((a: any, b: any) => Number(a.priority || 0) - Number(b.priority || 0))
        .find((item: any) => Number(item.hostId || 0) > 0 || Number(item.tunnelId || 0) > 0);
      if (Number(member?.hostId || 0) > 0) return Number(member.hostId);
      const memberTunnel = tunnelById.get(Number(member?.tunnelId || 0)) as any;
      if (Number(memberTunnel?.entryHostId || 0) > 0) return Number(memberTunnel.entryHostId);
    }
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0)) as any;
    if (Number(tunnel?.entryHostId || 0) > 0) return Number(tunnel.entryHostId);
    return Number(rule.hostId || 0);
  };
  const tokens = input.search.toLowerCase().split(/\s+/).filter(Boolean);
  const baseFiltered = visibleRules.filter((rule: any) => {
    if (input.entryHostId && entryHostIdOf(rule) !== input.entryHostId) return false;
    if (tokens.length === 0) return true;
    const group = groupById.get(Number(rule.forwardGroupId || 0)) as any;
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0)) as any;
    const relatedTunnels = [
      tunnel,
      ...(group?.members || []).map((member: any) => tunnelById.get(Number(member.tunnelId || 0))),
    ].filter(Boolean) as any[];
    const relatedHostIds = new Set<number>([
      Number(rule.hostId || 0),
      entryHostIdOf(rule),
      ...(group?.members || []).map((member: any) => Number(member.hostId || 0)),
      ...relatedTunnels.flatMap((item: any) => [
        Number(item.entryHostId || 0),
        Number(item.exitHostId || 0),
        ...(Array.isArray(item.hopHostIds) ? item.hopHostIds.map(Number) : []),
      ]),
    ].filter((id: number) => id > 0));
    const relatedHosts = Array.from(relatedHostIds).map((hostId) => hostById.get(hostId)).filter(Boolean);
    const owner = userById.get(Number(rule.userId || 0));
    const category = categoryOf(rule);
    const categoryLabels = {
      local: "端口转发 本地转发",
      tunnel: "隧道转发",
      chain: "转发链 端口转发链",
      group: "转发组",
    };
    const searchText = JSON.stringify([
      rule,
      group,
      groupById.get(Number(group?.entryGroupId || 0)),
      ...relatedTunnels,
      ...relatedHosts,
      owner,
      categoryLabels[category],
    ]).toLowerCase();
    return tokens.every((token) => searchText.includes(token));
  });
  const categoryCounts = { all: baseFiltered.length, local: 0, tunnel: 0, chain: 0, group: 0 };
  for (const rule of baseFiltered as any[]) categoryCounts[categoryOf(rule)] += 1;
  const filtered = (input.category === "all"
    ? baseFiltered
    : baseFiltered.filter((rule: any) => categoryOf(rule) === input.category)) as any[];
  const rank = { local: 0, tunnel: 1, chain: 2, group: 3 } as const;
  filtered.sort((a: any, b: any) => {
    if (input.category === "all") {
      const categoryCompare = rank[categoryOf(a)] - rank[categoryOf(b)];
      if (categoryCompare !== 0) return categoryCompare;
    }
    const sortCompare = Number(a.sortOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sortOrder ?? Number.MAX_SAFE_INTEGER);
    if (sortCompare !== 0) return sortCompare;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime() || Number(b.id || 0) - Number(a.id || 0);
  });
  return { filtered, visibleRules, categoryCounts };
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
      const { filtered, visibleRules, categoryCounts } = await getFilteredRuleList(input, ctx.user);
      return {
        ...paginateItems(filtered, input),
        scopeTotalItems: visibleRules.length,
        activeItems: filtered.filter((rule: any) => rule.isEnabled).length,
        categoryCounts,
      };
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
      const { filtered } = await getFilteredRuleList(input, ctx.user);
      const cursor = Math.max(0, Number(input.cursor || 0));
      const items = filtered.slice(cursor, cursor + input.limit);
      return {
        items,
        totalItems: filtered.length,
        nextCursor: cursor + items.length < filtered.length ? cursor + items.length : undefined,
      };
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
      const { filtered } = await getFilteredRuleList(input, ctx.user);
      const ruleIds = filtered.map((rule: any) => Number(rule.id)).filter((id: number) => Number.isInteger(id) && id > 0);
      const [totalRows, dailyRows] = ruleIds.length > 0
        ? await Promise.all([
          db.getTrafficCounterSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds,
          }),
          db.getTrafficSummaryByRule({
            userId: ctx.user.role === "admin" ? undefined : ctx.user.id,
            ruleIds,
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
        totalItems: filtered.length,
        activeItems: filtered.filter((rule: any) => rule.isEnabled).length,
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
  ...copyRulesRouter._def.procedures,
  ...crudRulesRouter._def.procedures,
  ...trafficRulesRouter._def.procedures,
  ...selfTestRulesRouter._def.procedures,
});

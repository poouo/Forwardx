import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { createQueryCache } from "../queryCache";
import { displayQueries } from "../displayQueryCache";
import { latencyHistoryQueryCache } from "../ruleLatencyQueryCache";
import { latencyChartBucketSeconds } from "../../shared/latencyHistory";
import { latencyHistoryWindowInput, resolveLatencyHistoryWindow } from "../latencyHistoryWindow";
import {
  createForwardGroupFromInput,
  deleteForwardGroupWithImpact,
  getForwardGroupDeleteImpact,
  runForwardGroupChainSelfTest,
  updateForwardGroupFromInput,
} from "../services/forwardGroupService";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { EXIT_GROUP_STRATEGIES } from "../../shared/exitStrategy";
import { MAX_FORWARD_GROUP_MEMBERS } from "../../shared/forwardGroup";
import { portForwardToolPreflight } from "../portForwardToolPreflight";
import { appendPanelLog } from "../_core/panelLogger";
import { getLinkAccessScope, visibleForwardGroupMemberIds, type LinkAccessScope } from "../linkAccessView";
import {
  buildForwardGroupAvailabilitySummaryIndex,
  publicLinkAvailabilitySummary,
  type LinkAvailabilitySummaryIndex,
} from "../linkAvailabilitySummary";

const failoverStrategySchema = z.enum(["fallback", "round_robin", "random", "ip_hash"]);
const exitGroupStrategySchema = z.enum(EXIT_GROUP_STRATEGIES);
const failoverTargetSchema = z.object({
  targetIp: z.string().min(1).max(253),
  targetPort: z.number().int().min(1).max(65535),
});

const memberSchema = z.object({
  memberType: z.enum(["host", "tunnel"]),
  hostId: z.number().nullable().optional(),
  tunnelId: z.number().nullable().optional(),
  connectHost: z.string().max(253).nullable().optional(),
  priority: z.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
});

const forwardGroupQueryCache = createQueryCache(300);

const baseSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(255).nullable().optional(),
  groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]).default("failover"),
  exitStrategy: exitGroupStrategySchema.optional().default("round_robin"),
  entryGroupId: z.number().nullable().optional(),
  groupType: z.enum(["host", "tunnel"]),
  protocol: z.enum(["tcp", "udp", "both"]).optional().default("both"),
  forwardType: z.enum(["iptables", "nftables", "realm", "socat", "gost", "nginx"]).optional(),
  proxyProtocolReceive: z.boolean().optional(),
  proxyProtocolSend: z.boolean().optional(),
  proxyProtocolExitReceive: z.boolean().optional(),
  proxyProtocolExitSend: z.boolean().optional(),
  proxyProtocolVersion: z.number().int().min(1).max(2).optional(),
  tcpFastOpen: z.boolean().optional(),
  zeroCopy: z.boolean().optional(),
  udpOverTcp: z.boolean().optional(),
  udpOverTcpPort: z.number().int().min(0).max(65535).nullable().optional(),
  failoverEnabled: z.boolean().optional(),
  failoverStrategy: failoverStrategySchema.optional(),
  failoverTargets: z.array(failoverTargetSchema).max(10).optional(),
  domain: z.string().max(255).nullable().optional(),
  recordType: z.enum(["A", "AAAA", "CNAME"]).default("A"),
  failoverSeconds: z.number().int().min(10).max(3600).default(60),
  recoverSeconds: z.number().int().min(10).max(3600).default(120),
  rateLimitMbps: z.number().int().min(0).max(1_000_000).optional().default(0),
  trafficMultiplier: z.number().int().min(1).max(5000).optional().default(100),
  chinaHealthCheckEnabled: z.boolean().default(false),
  chinaHealthCheckTarget: z.string().max(253).nullable().optional(),
  telegramSwitchNotifyEnabled: z.boolean().default(false),
  ddnsAutoResolveEnabled: z.boolean().default(true),
  autoFailback: z.boolean().default(true),
  isEnabled: z.boolean().default(true),
  members: z.array(memberSchema).max(MAX_FORWARD_GROUP_MEMBERS),
});

async function assertForwardGroupAccess(
  groupId: number,
  user: { id: number; role: string },
  options: { allowNull?: boolean; silentUnauthorized?: boolean } = {},
) {
  const group = await db.getForwardGroupById(groupId) as any;
  if (!group) {
    if (options.allowNull) return null;
    throw new Error("转发组不存在");
  }
  if (user.role !== "admin" && Number(group.userId) !== Number(user.id)) {
    const allowed = await db.checkUserForwardGroupPermission(user.id, groupId);
    if (!allowed && options.silentUnauthorized) return null;
    if (!allowed) throw new Error("无权访问此转发组");
  }
  return group;
}

function attachForwardGroupAvailability(
  groups: any[],
  availabilityIndex: LinkAvailabilitySummaryIndex,
  accessScope: LinkAccessScope | null,
) {
  return groups.map((group) => ({
    ...group,
    availability: publicLinkAvailabilitySummary(
      availabilityIndex.groupAvailabilityById.get(Number(group.id)),
      visibleForwardGroupMemberIds(group, accessScope),
    ),
  }));
}

function availabilityIndexForGroups(groups: any[], supportingGroups: any[] = []) {
  return buildForwardGroupAvailabilitySummaryIndex(groups, supportingGroups);
}

export const forwardGroupsRouter = router({
  toolPreflight: adminProcedure.input(z.object({
    entryGroupId:z.number().int().positive().nullable().optional(),
    hostIds:z.array(z.number().int().positive()).max(MAX_FORWARD_GROUP_MEMBERS).default([]),
    forwardType:z.enum(["iptables","nftables","realm","socat","gost","nginx"]),
  })).query(async ({input}) => {
    const entry = input.entryGroupId ? await db.getForwardGroupById(input.entryGroupId) as any : null;
    if (input.entryGroupId && (!entry || entry.groupMode !== "entry")) throw new Error("入口组不存在或类型不正确");
    const hostIds = entry ? entry.members.filter((member: any) => member.isEnabled).map((member: any) => Number(member.hostId)) : input.hostIds;
    const hosts = (await Promise.all(Array.from(new Set<number>(hostIds)).map((id) => db.getHostById(id)))).filter(Boolean);
    return portForwardToolPreflight(hosts,input.forwardType);
  }),
  list: protectedProcedure.query(async ({ ctx }) => {
    const [groups, accessScope] = await Promise.all([
      db.getForwardGroups(undefined, { includeRuntime: true }) as Promise<any[]>,
      getLinkAccessScope(ctx.user),
    ]);
    const availabilityIndex = await availabilityIndexForGroups(groups);
    if (!accessScope) return attachForwardGroupAvailability(groups, availabilityIndex, null);
    const visible = groups.filter((group: any) => accessScope.groupIds.has(Number(group.id)));
    return db.filterForwardGroupFieldsForUse(
      attachForwardGroupAvailability(visible, availabilityIndex, accessScope),
      accessScope,
    );
  }),

  options: protectedProcedure.query(async ({ ctx }) => {
    const accessScope = await getLinkAccessScope(ctx.user);
    const allowedGroupIds = accessScope
      ? Array.from(accessScope.useGroupIds || accessScope.groupIds)
      : undefined;
    const groups = await db.getForwardGroupOptions(allowedGroupIds);
    const itemIds = new Set((groups as any[]).map((group) => Number(group.id)));
    const relatedIds = Array.from(new Set((groups as any[])
      .map((group) => Number(group.entryGroupId || 0))
      .filter((id) => id > 0 && !itemIds.has(id))));
    const supportingGroups = relatedIds.length > 0
      ? await db.getForwardGroups(undefined, { includeRuntime: false, ids: relatedIds }) as any[]
      : [];
    const availabilityIndex = await availabilityIndexForGroups(groups as any[], supportingGroups);
    const withAvailability = attachForwardGroupAvailability(groups as any[], availabilityIndex, accessScope);
    if (!accessScope) return withAvailability;
    const visibleGroups = db.filterForwardGroupFieldsForUse(withAvailability, accessScope);
    if (supportingGroups.length === 0) return visibleGroups;

    // A chain's entry group is loaded above for availability, but it is not
    // itself a selectable root resource and therefore is intentionally not
    // included in `groups`. Keep a sanitized copy nested on the chain so
    // users can still see the configured entry domain in rule displays.
    const allowedSupportingGroups = supportingGroups
      .filter((group: any) => accessScope.groupIds.has(Number(group?.id || 0)));
    const visibleSupportingGroups = db.filterForwardGroupFieldsForUse(
      attachForwardGroupAvailability(allowedSupportingGroups, availabilityIndex, accessScope),
      accessScope,
    );
    const supportingById = new Map(visibleSupportingGroups.map((group: any) => [Number(group.id), group]));
    return visibleGroups.map((group: any) => {
      const entryGroupId = Number(group?.entryGroupId || 0);
      const entryGroup = entryGroupId > 0 ? supportingById.get(entryGroupId) : null;
      return entryGroup ? { ...group, entryGroup } : group;
    });
  }),

  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const accessScope = await getLinkAccessScope(ctx.user);
      const allowedGroupIds = accessScope ? Array.from(accessScope.groupIds) : undefined;
      const result = await db.getForwardGroupsPage({
        ...input,
        allowedGroupIds,
      });
      const itemIds = new Set((result.items as any[]).map((group: any) => Number(group.id)));
      const relatedGroupIds = Array.from(new Set((result.items as any[])
        .map((group: any) => Number(group.entryGroupId || 0))
        .filter((id: number) => id > 0
          && !itemIds.has(id))));
      const relatedRows = relatedGroupIds.length > 0
        ? await db.getForwardGroups(undefined, {
          includeRuntime: false,
          ids: relatedGroupIds,
        })
        : [];
      const availabilityIndex = await availabilityIndexForGroups(result.items as any[], relatedRows as any[]);
      const hydratedItems = attachForwardGroupAvailability(result.items as any[], availabilityIndex, accessScope);
      const visibleItems = accessScope
        ? db.filterForwardGroupFieldsForUse(hydratedItems, accessScope)
        : hydratedItems;
      const visibleIds = visibleItems.map((group: any) => Number(group.id)).sort((a, b) => a - b);
      const trafficByGroupId = await displayQueries.get(ctx.user, "groups.traffic",
        [visibleIds, Math.floor((Date.now() + 8 * 3600000) / 86400000)],
        () => db.getForwardGroupTrafficSummaries(visibleIds, ctx.user.role === "admin" ? undefined : ctx.user.id));
      const items = visibleItems.map((group: any) => ({
        ...group,
        trafficSummary: trafficByGroupId.get(Number(group.id)),
      }));
      const visibleRelatedRows = accessScope
        ? (relatedRows as any[]).filter((group) => accessScope.groupIds.has(Number(group.id)))
        : relatedRows as any[];
      const hydratedRelated = attachForwardGroupAvailability(visibleRelatedRows, availabilityIndex, accessScope);
      const relatedGroups = accessScope
        ? db.filterForwardGroupFieldsForUse(hydratedRelated, accessScope)
        : hydratedRelated;
      return {
        ...result,
        items,
        relatedGroups,
      };
    }),

  reorderGroups: adminProcedure
    .input(z.object({
      groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]),
      ids: z.array(z.number().int().positive()).min(1),
      startIndex: z.number().int().min(0).max(1_000_000).optional().default(0),
    }))
    .mutation(async ({ input }) => {
      await db.reorderForwardGroups(input.groupMode, input.ids, input.startIndex);
      return { success: true };
    }),

  probeStatistics: protectedProcedure
    .input(z.object({ groupId: z.number().int().positive(), ...latencyHistoryWindowInput }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路探测统计");
      const window = resolveLatencyHistoryWindow(input);
      return (window.longHistory ? latencyHistoryQueryCache : forwardGroupQueryCache).get(`groupProbeStatistics:${ctx.user.id}:${input.groupId}:${window.cacheKey}`,
        window.cacheOptions,
        () => db.getProbeCounterStatistics("forwardGroup", input.groupId, window.since, window.until));
    }),

  latencySeries: protectedProcedure
    .input(z.object({
      groupId: z.number(),
      ...latencyHistoryWindowInput,
    }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路延迟图表");
      const window = resolveLatencyHistoryWindow(input);
      return (window.longHistory ? latencyHistoryQueryCache : forwardGroupQueryCache).get(
        `groupLatencySeries:${ctx.user.id}:${input.groupId}:${window.cacheKey}`,
        window.cacheOptions,
        () => db.getForwardGroupLatencySeries(input.groupId, { ...window, bucketSeconds: latencyChartBucketSeconds(window.hours) }),
      );
    }),

  latestTest: protectedProcedure
    .input(z.object({ groupId: z.number(), includeActive: z.boolean().optional().default(true) }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user, { allowNull: true, silentUnauthorized: true });
      if (!group) return null;
      return await db.getLatestForwardGroupTest(input.groupId, { includeActive: input.includeActive }) || null;
    }),

  test: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路自测");
      return runForwardGroupChainSelfTest(input.groupId);
    }),

  events: adminProcedure
    .input(z.object({ groupId: z.number(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      return db.getForwardGroupEvents(input.groupId, input.limit);
    }),

  create: adminProcedure
    .input(baseSchema)
    .mutation(async ({ input, ctx }) => {
      const id = await createForwardGroupFromInput(input, ctx.user.id);
      return { id };
    }),

  update: adminProcedure
    .input(baseSchema.extend({ id: z.number() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      const group = await updateForwardGroupFromInput(input.id, input);
      return { success: true, group };
    })),

  // Automation sends a patch, not a stale copy of the entire edit form.
  updateFields: adminProcedure
    .input(baseSchema.partial().extend({ id: z.number().int().positive() }).strict())
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      const existing = await db.getForwardGroupById(input.id) as any;
      if (!existing) throw new Error("转发资源不存在");
      const current = Object.fromEntries(Object.keys(baseSchema.shape).filter(key => existing[key] !== undefined && existing[key] !== null).map(key => [key, existing[key]]));
      if (typeof current.failoverTargets === "string") current.failoverTargets = JSON.parse(current.failoverTargets);
      const merged = baseSchema.parse({ ...current, ...input });
      const group = await updateForwardGroupFromInput(input.id, merged);
      return { success: true, group };
    })),

  toggle: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isEnabled: z.boolean() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      return db.setForwardGroupEnabled(input.id, input.isEnabled);
    })),

  deleteImpact: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const group = await db.getForwardGroupById(input.id);
      if (!group) throw new Error("转发组不存在");
      return getForwardGroupDeleteImpact(input.id);
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number(), confirmRules: z.boolean().optional() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      return deleteForwardGroupWithImpact(input.id, input.confirmRules);
    })),

  reorder: adminProcedure
    .input(z.object({ groupId: z.number(), memberIds: z.array(z.number()).min(1) }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.groupId}`, async () => {
      await db.reorderForwardGroupMembers(input.groupId, input.memberIds);
      await db.runForwardGroupFailover(input.groupId, { forcePriority: true, forceSync: true });
      return { success: true };
    })),

  resetTraffic: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      const result = await db.resetPortForwardResourceTraffic(input.id);
      appendPanelLog("info", `[ResourceTraffic] reset group=${input.id} actor=${ctx.user.id} rules=${result.ruleCount} scope=display-only`);
      return result;
    })),

  sync: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => withKeyedTaskLock(`forward-group:${input.id}`, async () => {
      await db.syncForwardGroupRules(input.id);
      await db.runForwardGroupFailover(input.id, { forcePriority: true, forceSync: true });
      return { success: true };
    })),

  runFailover: adminProcedure.mutation(async () => {
    await db.runForwardGroupFailoverSweep({ manual: true });
    return { success: true };
  }),
});

import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { createQueryCache } from "../queryCache";
import {
  createForwardGroupFromInput,
  deleteForwardGroupWithImpact,
  getForwardGroupDeleteImpact,
  runForwardGroupChainSelfTest,
  updateForwardGroupFromInput,
} from "../services/forwardGroupService";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { EXIT_GROUP_STRATEGIES } from "../../shared/exitStrategy";

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
  trafficMultiplier: z.number().int().min(1).max(5000).optional().default(100),
  chinaHealthCheckEnabled: z.boolean().default(false),
  chinaHealthCheckTarget: z.string().max(253).nullable().optional(),
  telegramSwitchNotifyEnabled: z.boolean().default(false),
  ddnsAutoResolveEnabled: z.boolean().default(true),
  autoFailback: z.boolean().default(true),
  isEnabled: z.boolean().default(true),
  members: z.array(memberSchema).min(1),
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

export const forwardGroupsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "admin") return db.getForwardGroups(undefined, { includeRuntime: true });
    const groupIds = await db.getUserAllowedForwardGroupIds(ctx.user.id);
    if (groupIds.length === 0) return [];
    const groups = await db.getForwardGroups(undefined, { includeRuntime: true });
    const allowed = new Set(groupIds);
    return db.filterForwardGroupFieldsForUse((groups as any[]).filter((group: any) => allowed.has(Number(group.id))));
  }),

  options: protectedProcedure.query(async ({ ctx }) => {
    const allowedGroupIds = ctx.user.role === "admin"
      ? undefined
      : await db.getUserAllowedForwardGroupIds(ctx.user.id);
    const groups = await db.getForwardGroupOptions(allowedGroupIds);
    return ctx.user.role === "admin"
      ? groups
      : db.filterForwardGroupFieldsForUse(groups as any[]);
  }),

  listPage: protectedProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().min(1).max(100).default(12),
      groupMode: z.enum(["port", "failover", "chain", "entry", "exit"]),
      search: z.string().trim().max(200).optional().default(""),
    }))
    .query(async ({ input, ctx }) => {
      const allowedGroupIds = ctx.user.role === "admin"
        ? undefined
        : await db.getUserAllowedForwardGroupIds(ctx.user.id);
      const result = await db.getForwardGroupsPage({
        ...input,
        allowedGroupIds,
      });
      const items = ctx.user.role === "admin"
        ? result.items
        : db.filterForwardGroupFieldsForUse(result.items as any[]);
      const itemIds = new Set((items as any[]).map((group: any) => Number(group.id)));
      const allowedGroupSet = allowedGroupIds ? new Set(allowedGroupIds.map(Number)) : null;
      const relatedGroupIds = Array.from(new Set((items as any[])
        .map((group: any) => Number(group.entryGroupId || 0))
        .filter((id: number) => id > 0
          && !itemIds.has(id)
          && (!allowedGroupSet || allowedGroupSet.has(id)))));
      const relatedRows = relatedGroupIds.length > 0
        ? await db.getForwardGroups(undefined, {
          includeRuntime: false,
          ids: relatedGroupIds,
        })
        : [];
      const relatedGroups = ctx.user.role === "admin"
        ? relatedRows
        : db.filterForwardGroupFieldsForUse(relatedRows as any[]);
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

  latencySeries: protectedProcedure
    .input(z.object({
      groupId: z.number(),
      hours: z.number().min(0.5).max(24 * 3).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅转发链支持链路延迟图表");
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return forwardGroupQueryCache.get(
        `latencySeries:${ctx.user.id}:${input.groupId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getForwardGroupLatencySeries(input.groupId, { since }),
      );
    }),

  latestTest: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user, { allowNull: true, silentUnauthorized: true });
      if (!group) return null;
      return await db.getLatestForwardGroupTest(input.groupId) || null;
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

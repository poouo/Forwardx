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
  groupMode: z.enum(["failover", "chain", "entry", "exit"]).default("failover"),
  entryGroupId: z.number().nullable().optional(),
  groupType: z.enum(["host", "tunnel"]),
  domain: z.string().max(255).nullable().optional(),
  recordType: z.enum(["A", "AAAA", "CNAME"]).default("A"),
  failoverSeconds: z.number().int().min(10).max(3600).default(60),
  recoverSeconds: z.number().int().min(10).max(3600).default(120),
  chinaHealthCheckEnabled: z.boolean().default(false),
  chinaHealthCheckTarget: z.string().max(253).nullable().optional(),
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
    if (ctx.user.role === "admin") return db.getForwardGroups();
    const groupIds = await db.getUserAllowedForwardGroupIds(ctx.user.id);
    if (groupIds.length === 0) return [];
    const groups = await db.getForwardGroups();
    const allowed = new Set(groupIds);
    return db.filterForwardGroupFieldsForUse((groups as any[]).filter((group: any) => allowed.has(Number(group.id))));
  }),

  latencySeries: protectedProcedure
    .input(z.object({
      groupId: z.number(),
      hours: z.number().min(1).max(48).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const group = await assertForwardGroupAccess(input.groupId, ctx.user);
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅端口转发链支持链路延迟图表");
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
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅端口转发链支持链路自测");
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
    .mutation(async ({ input }) => {
      await updateForwardGroupFromInput(input.id, input);
      return { success: true };
    }),

  deleteImpact: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const group = await db.getForwardGroupById(input.id);
      if (!group) throw new Error("转发组不存在");
      return getForwardGroupDeleteImpact(input.id);
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number(), confirmRules: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      return deleteForwardGroupWithImpact(input.id, input.confirmRules);
    }),

  reorder: adminProcedure
    .input(z.object({ groupId: z.number(), memberIds: z.array(z.number()).min(1) }))
    .mutation(async ({ input }) => {
      await db.reorderForwardGroupMembers(input.groupId, input.memberIds);
      await db.runForwardGroupFailover(input.groupId);
      return { success: true };
    }),

  sync: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await db.syncForwardGroupRules(input.id);
      await db.runForwardGroupFailover(input.id);
      return { success: true };
    }),

  runFailover: adminProcedure.mutation(async () => {
    await db.runForwardGroupFailoverSweep();
    return { success: true };
  }),
});

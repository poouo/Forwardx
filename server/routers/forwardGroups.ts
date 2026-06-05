import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";

const memberSchema = z.object({
  memberType: z.enum(["host", "tunnel"]),
  hostId: z.number().nullable().optional(),
  tunnelId: z.number().nullable().optional(),
  priority: z.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
});

const baseSchema = z.object({
  name: z.string().min(1).max(128),
  groupMode: z.enum(["failover", "chain"]).default("failover"),
  groupType: z.enum(["host", "tunnel"]),
  domain: z.string().max(255).nullable().optional(),
  recordType: z.enum(["A", "AAAA", "CNAME"]).default("A"),
  failoverSeconds: z.number().int().min(10).max(3600).default(60),
  recoverSeconds: z.number().int().min(10).max(3600).default(120),
  autoFailback: z.boolean().default(true),
  isEnabled: z.boolean().default(true),
  members: z.array(memberSchema).min(1),
});

function normalizeMembers(groupMode: "failover" | "chain", groupType: "host" | "tunnel", members: z.infer<typeof memberSchema>[]) {
  const effectiveGroupType = groupMode === "chain" ? "host" : groupType;
  if (groupMode === "chain" && (members.length < 2 || members.length > 5)) {
    throw new Error("端口转发链需要配置 2-5 台主机");
  }
  const seen = new Set<string>();
  return members.map((member, index) => {
    if (member.memberType !== effectiveGroupType) throw new Error(groupMode === "chain" ? "端口转发链仅支持主机成员" : "成员类型必须与转发组类型一致");
    const id = effectiveGroupType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0);
    if (!id) throw new Error(effectiveGroupType === "host" ? "请选择成员主机" : "请选择成员隧道");
    const key = `${effectiveGroupType}:${id}`;
    if (seen.has(key)) throw new Error("成员不能重复");
    seen.add(key);
    return {
      memberType: effectiveGroupType,
      hostId: effectiveGroupType === "host" ? id : null,
      tunnelId: effectiveGroupType === "tunnel" ? id : null,
      priority: member.priority ?? index,
      isEnabled: groupMode === "chain" ? true : member.isEnabled ?? true,
    };
  });
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

  events: adminProcedure
    .input(z.object({ groupId: z.number(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      return db.getForwardGroupEvents(input.groupId, input.limit);
    }),

  create: adminProcedure
    .input(baseSchema)
    .mutation(async ({ input, ctx }) => {
      const groupMode = input.groupMode === "chain" ? "chain" : "failover";
      const groupType = groupMode === "chain" ? "host" : input.groupType;
      const members = normalizeMembers(groupMode, groupType, input.members);
      const id = await db.createForwardGroup({
        name: input.name,
        groupMode,
        groupType,
        forwardType: groupType === "tunnel" ? "gost" : "iptables",
        domain: groupMode === "chain" ? null : input.domain?.trim() || null,
        recordType: groupMode === "chain" ? "A" : input.recordType,
        sourcePort: 1,
        protocol: "both",
        targetIp: "0.0.0.0",
        targetPort: 1,
        failoverSeconds: input.failoverSeconds,
        recoverSeconds: input.recoverSeconds,
        autoFailback: input.autoFailback,
        isEnabled: input.isEnabled,
        userId: ctx.user.id,
      } as any, members);
      return { id };
    }),

  update: adminProcedure
    .input(baseSchema.extend({ id: z.number() }))
    .mutation(async ({ input }) => {
      const groupMode = input.groupMode === "chain" ? "chain" : "failover";
      const groupType = groupMode === "chain" ? "host" : input.groupType;
      const members = normalizeMembers(groupMode, groupType, input.members);
      await db.updateForwardGroup(input.id, {
        name: input.name,
        groupMode,
        groupType,
        forwardType: groupType === "tunnel" ? "gost" : "iptables",
        domain: groupMode === "chain" ? null : input.domain?.trim() || null,
        recordType: groupMode === "chain" ? "A" : input.recordType,
        failoverSeconds: input.failoverSeconds,
        recoverSeconds: input.recoverSeconds,
        autoFailback: input.autoFailback,
        isEnabled: input.isEnabled,
      } as any, { skipSync: true });
      await db.replaceForwardGroupMembers(input.id, members);
      return { success: true };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await db.deleteForwardGroup(input.id);
      return { success: true };
    }),

  reorder: adminProcedure
    .input(z.object({ groupId: z.number(), memberIds: z.array(z.number()).min(1) }))
    .mutation(async ({ input }) => {
      await db.reorderForwardGroupMembers(input.groupId, input.memberIds);
      return { success: true };
    }),

  sync: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await db.syncForwardGroupRules(input.id);
      return { success: true };
    }),

  runFailover: adminProcedure.mutation(async () => {
    await db.runForwardGroupFailoverSweep();
    return { success: true };
  }),
});

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { forwardTypeSchema } from "./schemas";

const memberSchema = z.object({
  memberType: z.enum(["host", "tunnel"]),
  hostId: z.number().nullable().optional(),
  tunnelId: z.number().nullable().optional(),
  priority: z.number().int().min(0).optional(),
  isEnabled: z.boolean().optional(),
});

const baseSchema = z.object({
  name: z.string().min(1).max(128),
  groupType: z.enum(["host", "tunnel"]),
  forwardType: forwardTypeSchema.default("iptables"),
  domain: z.string().max(255).nullable().optional(),
  recordType: z.enum(["A", "AAAA", "CNAME"]).default("A"),
  sourcePort: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp", "both"]).default("tcp"),
  targetIp: z.string().min(1).max(128),
  targetPort: z.number().int().min(1).max(65535),
  failoverSeconds: z.number().int().min(10).max(3600).default(60),
  recoverSeconds: z.number().int().min(10).max(3600).default(120),
  autoFailback: z.boolean().default(true),
  isEnabled: z.boolean().default(true),
  members: z.array(memberSchema).min(1),
});

function normalizeMembers(groupType: "host" | "tunnel", members: z.infer<typeof memberSchema>[]) {
  const seen = new Set<string>();
  return members.map((member, index) => {
    if (member.memberType !== groupType) throw new Error("成员类型必须与转发组类型一致");
    const id = groupType === "host" ? Number(member.hostId || 0) : Number(member.tunnelId || 0);
    if (!id) throw new Error(groupType === "host" ? "请选择成员主机" : "请选择成员隧道");
    const key = `${groupType}:${id}`;
    if (seen.has(key)) throw new Error("成员不能重复");
    seen.add(key);
    return {
      memberType: groupType,
      hostId: groupType === "host" ? id : null,
      tunnelId: groupType === "tunnel" ? id : null,
      priority: member.priority ?? index,
      isEnabled: member.isEnabled ?? true,
    };
  });
}

export const forwardGroupsRouter = router({
  list: adminProcedure.query(async () => {
    return db.getForwardGroups();
  }),

  events: adminProcedure
    .input(z.object({ groupId: z.number(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      return db.getForwardGroupEvents(input.groupId, input.limit);
    }),

  create: adminProcedure
    .input(baseSchema)
    .mutation(async ({ input, ctx }) => {
      const members = normalizeMembers(input.groupType, input.members);
      const id = await db.createForwardGroup({
        name: input.name,
        groupType: input.groupType,
        forwardType: input.groupType === "tunnel" ? "gost" : input.forwardType,
        domain: input.domain?.trim() || null,
        recordType: input.recordType,
        sourcePort: input.sourcePort,
        protocol: input.protocol,
        targetIp: input.targetIp.trim(),
        targetPort: input.targetPort,
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
      const members = normalizeMembers(input.groupType, input.members);
      await db.updateForwardGroup(input.id, {
        name: input.name,
        groupType: input.groupType,
        forwardType: input.groupType === "tunnel" ? "gost" : input.forwardType,
        domain: input.domain?.trim() || null,
        recordType: input.recordType,
        sourcePort: input.sourcePort,
        protocol: input.protocol,
        targetIp: input.targetIp.trim(),
        targetPort: input.targetPort,
        failoverSeconds: input.failoverSeconds,
        recoverSeconds: input.recoverSeconds,
        autoFailback: input.autoFailback,
        isEnabled: input.isEnabled,
      } as any);
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

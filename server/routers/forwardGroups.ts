import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { createHopTestBatch, registerHopTest } from "../hopTestState";

const memberSchema = z.object({
  memberType: z.enum(["host", "tunnel"]),
  hostId: z.number().nullable().optional(),
  tunnelId: z.number().nullable().optional(),
  connectHost: z.string().max(253).nullable().optional(),
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
      connectHost: groupMode === "chain" ? String(member.connectHost || "").trim() || null : null,
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

  latencySeries: protectedProcedure
    .input(z.object({
      groupId: z.number(),
      hours: z.number().min(1).max(48).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const group = await db.getForwardGroupById(input.groupId) as any;
      if (!group) throw new Error("转发链不存在");
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅端口转发链支持链路延迟图表");
      if (ctx.user.role !== "admin" && Number(group.userId) !== Number(ctx.user.id)) {
        const allowed = await db.checkUserForwardGroupPermission(ctx.user.id, input.groupId);
        if (!allowed) throw new Error("无权查看此转发链");
      }
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return db.getForwardGroupLatencySeries(input.groupId, { since });
    }),

  latestTest: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .query(async ({ input, ctx }) => {
      const group = await db.getForwardGroupById(input.groupId) as any;
      if (!group) return null;
      if (ctx.user.role !== "admin" && Number(group.userId) !== Number(ctx.user.id)) {
        const allowed = await db.checkUserForwardGroupPermission(ctx.user.id, input.groupId);
        if (!allowed) return null;
      }
      return await db.getLatestForwardGroupTest(input.groupId) || null;
    }),

  test: protectedProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await db.getForwardGroupById(input.groupId) as any;
      if (!group) throw new Error("转发链不存在");
      if (String(group.groupMode || "failover") !== "chain") throw new Error("仅端口转发链支持链路自测");
      if (ctx.user.role !== "admin" && Number(group.userId) !== Number(ctx.user.id)) {
        const allowed = await db.checkUserForwardGroupPermission(ctx.user.id, input.groupId);
        if (!allowed) throw new Error("无权测试此转发链");
      }
      await db.syncForwardGroupRules(input.groupId, { validatePorts: false, createMissing: false });
      const template = await db.getForwardGroupPrimaryTemplateRule(input.groupId) as any;
      const probes = await db.getForwardGroupChainProbes(input.groupId, { includeFinalTarget: true });
      if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");
      const batchId = createHopTestBatch("fg", input.groupId);
      let queued = 0;
      for (const probe of probes) {
        const message = JSON.stringify({
          kind: "forward-chain",
          groupId: input.groupId,
          entryIp: probe.targetIp,
          entrySourcePort: probe.targetPort,
          targetIp: probe.targetIp,
          targetPort: probe.targetPort,
          method: probe.method,
          hopLabel: probe.hopLabel,
          routeLabel: probe.routeLabel,
          batchId,
        });
        const testId = await db.createForwardTest({
          ruleId: Number(template?.id || 0),
          hostId: probe.fromHostId,
          userId: Number(group.userId),
          status: "pending",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          message,
        } as any);
        registerHopTest(batchId, Number(testId));
        pushAgentRefresh(probe.fromHostId, "forward-chain-selftest");
        queued += 1;
        appendPanelLog("info", `[SelfTest] forward-chain=${input.groupId} queued hop=${probe.hopLabel} method=${probe.method} target=${probe.targetIp}:${probe.targetPort}`);
      }
      return { success: false, pending: true, queued };
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

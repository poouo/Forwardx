import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { planManualTunnelProbes } from "../tunnelManualProbe";
import { queueRuleTunnelProbeBatch } from "../ruleTunnelManualProbe";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { randomUUID } from "node:crypto";
import { linkProbeMethodForRule } from "@shared/latencyProbe";
import { ruleLatencySeriesQueryCache as selfTestQueryCache } from "../ruleLatencyQueryCache";
import { latencyHistoryQueryCache } from "../ruleLatencyQueryCache";
import { latencyChartBucketSeconds } from "../../shared/latencyHistory";
import { latencyHistoryWindowInput, resolveLatencyHistoryWindow } from "../latencyHistoryWindow";

export const selfTestRulesRouter = router({
  probeStatistics: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive(), ...latencyHistoryWindowInput }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权查看此规则");
      const window = resolveLatencyHistoryWindow(input);
      return (window.longHistory ? latencyHistoryQueryCache : selfTestQueryCache).get(`ruleProbeStatistics:${ctx.user.id}:${input.ruleId}:${window.cacheKey}`,
        window.cacheOptions,
        () => db.getTcpingProbeStatisticsByRule(input.ruleId, window.since, window.until));
    }),
  tcpingSeries: protectedProcedure
      .input(z.object({
        ruleId: z.number(),
        ...latencyHistoryWindowInput,
      }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const window = resolveLatencyHistoryWindow(input);
      return (window.longHistory ? latencyHistoryQueryCache : selfTestQueryCache).get(
        `tcpingSeries:${ctx.user.id}:${input.ruleId}:${window.cacheKey}`,
        window.cacheOptions,
        () => db.getTcpingSeriesByRule(input.ruleId, { ...window, bucketSeconds: latencyChartBucketSeconds(window.hours) }),
      );
    }),

  startSelfTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权操作此规则");
      }
      await requireRuleProtocolEnabled(rule);
      let hostId = rule.hostId;
      let runtimeRule: any = rule;
      let message: string | null = null;
      if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
        const group = await db.getForwardGroupById(Number((rule as any).forwardGroupId)) as any;
        if (String(group?.groupMode || "failover") === "chain") {
          await db.syncForwardGroupRules(Number(group.id));
          const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule });
          const chainLatencyMode = probes.some((probe) => probe.method === "tcp")
            && ["iptables", "nftables"].includes(String(group.forwardType || "").trim().toLowerCase())
            ? Number(group.entryGroupId || 0) > 0
              ? "multi-source-remaining-path"
              : "remaining-path"
            : "sum";
          if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");
          const batchId = `fc-${randomUUID()}`;
          const testHostIds = new Set<number>();
          let firstTestId = 0;
          let queued = 0;
          await db.withDatabaseTransaction(async () => {
            for (const probe of probes) {
              const probeMessage = JSON.stringify({
                kind: "forward-chain",
                groupId: group.id,
                ruleId: rule.id,
                entryIp: probe.targetIp,
                entrySourcePort: probe.targetPort,
                targetIp: probe.targetIp,
                targetPort: probe.targetPort,
                method: probe.method,
                hopLabel: probe.hopLabel,
                routeLabel: probe.routeLabel,
                batchId,
                latencyMode: chainLatencyMode,
                runtimeDependent: probe.runtimeDependent,
              });
              const testId = await db.createForwardTest({
                ruleId: rule.id,
                hostId: probe.fromHostId,
                userId: rule.userId,
                status: "pending",
                listenOk: false,
                targetReachable: false,
                forwardOk: false,
                message: probeMessage,
                batchId,
              });
              if (!firstTestId) firstTestId = Number(testId);
              testHostIds.add(probe.fromHostId);
              queued += 1;
            }
          });
          appendPanelLog("info", `[SelfTest] rule=${rule.id} forward-chain=${group.id} batch=${batchId} queued segments=${queued} sourceHosts=${testHostIds.size}`);
          for (const hostId of testHostIds) {
            pushAgentRefresh(hostId, "forward-chain-rule-selftest", { urgent: true });
          }
          return { id: firstTestId, queued };
        }
        const selected = await db.getForwardGroupRuleForSelfTest(rule, group);
        runtimeRule = selected.rule;
        await requireRuleProtocolEnabled(runtimeRule);
        hostId = runtimeRule.hostId;
        const sourceHost = await db.getHostById(hostId);
        // Persist the selected listener/target at click time. Both Agent pull
        // paths must execute the same test even if failover occurs afterward.
        message = JSON.stringify({
          kind: "forward-group",
          groupId: selected.groupId,
          memberId: selected.memberId,
          runtimeRuleId: runtimeRule.id,
          forwardType: runtimeRule.forwardType,
          sourcePort: runtimeRule.sourcePort,
          targetIp: runtimeRule.targetIp,
          targetPort: runtimeRule.targetPort,
          method: linkProbeMethodForRule(runtimeRule),
          sourceLabel: sourceHost?.name || `主机 #${hostId}`,
          targetLabel: rule.name,
        });
      }
      if (runtimeRule.tunnelId) {
        const tunnel = await db.getTunnelById(runtimeRule.tunnelId);
        if (!tunnel) throw new Error("隧道不存在");
        const targetIp = runtimeRule.targetIp;
        if (!targetIp) throw new Error("目标地址不可用，请检查规则目标地址");
        const [hops, exits, entryGroup] = await Promise.all([
          db.getTunnelHops(Number(tunnel.id)), db.getTunnelExitNodes(Number(tunnel.id)),
          tunnel.entryGroupId ? db.getForwardGroupById(Number(tunnel.entryGroupId)) : null,
        ]);
        const enabled = (value: unknown) => value === true || Number(value) === 1;
        const entryHostIds = [...new Set<number>(enabled(entryGroup?.isEnabled) && entryGroup?.groupMode === "entry"
          ? (entryGroup.members || []).filter((member: any) => member.memberType === "host"
            && (member.isEnabled == null || enabled(member.isEnabled))).map((member: any) => Number(member.hostId)).filter((id: number) => id > 0)
          : [])];
        if (!entryHostIds.length) entryHostIds.push(Number(tunnel.entryHostId));
        const hostIds = [...new Set([...entryHostIds, Number(tunnel.exitHostId),
          ...hops.map((hop: any) => Number(hop.hostId)), ...exits.map((exit: any) => Number(exit.hostId))])];
        const hostRows = await Promise.all(hostIds.map(id => db.getHostById(id)));
        const hosts = new Map(hostIds.map((id, index) => [id, hostRows[index]]));
        const probes = planManualTunnelProbes({ tunnel, hops, exits, entryHostIds, hosts });
        const queued = await queueRuleTunnelProbeBatch({ ...runtimeRule, id: rule.id, userId: rule.userId }, tunnel, probes, hosts);
        for (const id of queued.hostIds) pushAgentRefresh(id, "forward-selftest-via-tunnel", { urgent: true });
        return { id: queued.id, queued: queued.queued };
      }
      const id = await db.createForwardTest({
        ruleId: rule.id,
        hostId,
        userId: rule.userId,
        status: "pending",
        listenOk: false,
        targetReachable: false,
        forwardOk: false,
        message,
      });
      pushAgentRefresh(hostId, "forward-selftest", { urgent: true });
      if (!runtimeRule.tunnelId) {
        appendPanelLog("info", `[SelfTest] rule=${rule.id} queued direct test=${id} from host=${hostId} to target=${rule.targetIp}:${rule.targetPort}`);
      }
      return { id };
    }),

  latestTest: protectedProcedure
    .input(z.object({ ruleId: z.number(), includeActive: z.boolean().optional().default(true) }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        return null;
      }
      const t = await db.getLatestForwardTest(input.ruleId, { includeActive: input.includeActive });
      return t || null;
    })
});

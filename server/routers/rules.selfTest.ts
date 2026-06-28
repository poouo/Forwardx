import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushAgentRefresh } from "../agentEvents";
import { pushTunnelEndpointRefresh } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";
import { createQueryCache } from "../queryCache";
import { createHopTestBatch, registerHopTest } from "../hopTestState";
import { linkProbeMethodForRule } from "@shared/latencyProbe";

const selfTestQueryCache = createQueryCache(300);

export const selfTestRulesRouter = router({
  tcpingSeries: protectedProcedure
    .input(z.object({
      ruleId: z.number(),
      hours: z.number().min(1).max(48).default(24),
    }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) throw new Error("规则不存在");
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        throw new Error("无权查看此规则");
      }
      const since = new Date(Date.now() - input.hours * 3600 * 1000);
      return selfTestQueryCache.get(
        `tcpingSeries:${ctx.user.id}:${input.ruleId}:${input.hours}`,
        { ttlMs: 5_000, staleMs: 0 },
        () => db.getTcpingSeriesByRule(input.ruleId, { since }),
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
      let message: string | null = null;
      if ((rule as any).isForwardGroupTemplate && (rule as any).forwardGroupId) {
        const group = await db.getForwardGroupById(Number((rule as any).forwardGroupId)) as any;
        if (String(group?.groupMode || "failover") === "chain") {
          await db.syncForwardGroupRules(Number(group.id));
          const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule });
          if (probes.length === 0) throw new Error("转发链没有可测试的有效链路");
          const batchId = createHopTestBatch("fgr", Number(group.id));
          let firstTestId = 0;
          let queued = 0;
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
            });
            if (!firstTestId) firstTestId = Number(testId);
            registerHopTest(batchId, Number(testId));
            pushAgentRefresh(probe.fromHostId, "forward-chain-rule-selftest");
            queued += 1;
            appendPanelLog("info", `[SelfTest] rule=${rule.id} forward-chain=${group.id} queued hop=${probe.hopLabel} method=${probe.method} target=${probe.targetIp}:${probe.targetPort}`);
          }
          return { id: firstTestId, queued };
        }
      }
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        if (!tunnel) throw new Error("隧道不存在");
        hostId = tunnel.exitHostId;
        const targetIp = rule.targetIp;
        if (!targetIp) throw new Error("目标地址不可用，请检查规则目标地址");
        const pushed = await pushTunnelEndpointRefresh(tunnel, "forward-selftest-via-tunnel");
        message = JSON.stringify({
          kind: "forward-via-tunnel",
          tunnelId: tunnel.id,
          entryHostId: tunnel.entryHostId,
          exitHostId: tunnel.exitHostId,
          targetIp,
          targetPort: rule.targetPort,
          method: linkProbeMethodForRule(rule),
          refreshPushed: pushed,
        });
        appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} queued tunnel+target test from exitHost=${tunnel.exitHostId} to target=${targetIp}:${rule.targetPort}`);
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
      pushAgentRefresh(hostId, "forward-selftest");
      if (!(rule as any).tunnelId) {
        appendPanelLog("info", `[SelfTest] rule=${rule.id} queued direct test=${id} from host=${hostId} to target=${rule.targetIp}:${rule.targetPort}`);
      }
      return { id };
    }),

  latestTest: protectedProcedure
    .input(z.object({ ruleId: z.number() }))
    .query(async ({ input, ctx }) => {
      const rule = await db.getForwardRuleById(input.ruleId);
      if (!rule) return null;
      if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
        return null;
      }
      const t = await db.getLatestForwardTest(input.ruleId);
      return t || null;
    })
});

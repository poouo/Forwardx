import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { appendPanelLog } from "../_core/panelLogger";
import { pushTunnelEndpointRefresh } from "./helpers";
import { requireRuleProtocolEnabled } from "../forwardProtocolSettings";

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
      return db.getTcpingSeriesByRule(input.ruleId, { since });
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
      if ((rule as any).tunnelId) {
        const tunnel = await db.getTunnelById((rule as any).tunnelId);
        if (!tunnel) throw new Error("隧道不存在");
        hostId = tunnel.exitHostId;
        const pushed = pushTunnelEndpointRefresh(tunnel, "forward-selftest-via-tunnel");
        message = JSON.stringify({
          kind: "forward-via-tunnel",
          tunnelId: tunnel.id,
          entryHostId: tunnel.entryHostId,
          exitHostId: tunnel.exitHostId,
          targetIp: rule.targetIp,
          targetPort: rule.targetPort,
          refreshPushed: pushed,
        });
        appendPanelLog("info", `[SelfTest] rule=${rule.id} tunnel=${tunnel.id} queued tunnel+target test from exitHost=${tunnel.exitHostId} to target=${rule.targetIp}:${rule.targetPort}`);
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

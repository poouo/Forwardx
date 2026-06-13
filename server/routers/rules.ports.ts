import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { requireHostUseAccess, requireRuleAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";
import { combinePortPolicies, isPortAllowedByPolicy, portPolicyErrorMessage, portPolicyFrom } from "../portPolicy";

const randomPortInputSchema = z.object({
  hostId: z.number().optional(),
  tunnelId: z.number().nullable().optional(),
  forwardGroupId: z.number().optional(),
  excludeRuleId: z.number().optional(),
});

export const portsRulesRouter = router({
  checkPort: protectedProcedure
    .input(z.object({
      hostId: z.number(),
      tunnelId: z.number().nullable().optional(),
      sourcePort: z.number().min(1).max(65535),
      excludeRuleId: z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      let policy = portPolicyFrom(null);
      if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        if (tunnel.entryHostId !== input.hostId) throw new Error("隧道入口主机与规则主机不一致");
        const host = await db.getHostById(input.hostId);
        policy = combinePortPolicies(
          portPolicyFrom(host as any),
          portPolicyFrom({
            portRangeStart: (tunnel as any).portRangeStart,
            portRangeEnd: (tunnel as any).portRangeEnd,
          }),
        );
      } else {
        const { host } = await requireHostUseAccess(ctx, input.hostId);
        policy = portPolicyFrom(host as any);
      }
      if (!isPortAllowedByPolicy(input.sourcePort, policy)) {
        return { used: true, reason: portPolicyErrorMessage(policy) };
      }
      if (ctx.user.role !== "admin") {
        const planRange = await db.getUserPlanPortRange(ctx.user.id, input.hostId, input.tunnelId ?? undefined);
        if (planRange) {
          policy = combinePortPolicies(policy, portPolicyFrom({ portRangeStart: planRange.start, portRangeEnd: planRange.end }));
        }
        if (planRange && !isPortAllowedByPolicy(input.sourcePort, policy)) {
          return { used: true, reason: portPolicyErrorMessage(policy, "套餐端口") };
        }
      }
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      const used = await db.isPortUsedOnHost(input.hostId, input.sourcePort, input.excludeRuleId);
      return { used };
    }),
  randomPort: protectedProcedure
    .input(randomPortInputSchema)
    .query(async ({ input, ctx }) => {
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      if (input.forwardGroupId) {
        let planRange: { start: number; end: number } | null = null;
        if (ctx.user.role !== "admin") {
          const hasPermission = await db.checkUserForwardGroupPermission(ctx.user.id, input.forwardGroupId);
          if (!hasPermission) throw new Error("无权使用该转发组");
          planRange = await db.getUserForwardGroupPlanPortRange(ctx.user.id, input.forwardGroupId);
        }
        const port = await db.findAvailableForwardGroupPort(input.forwardGroupId, input.excludeRuleId, planRange);
        if (!port) throw new Error("转发组成员端口区间内已无共同可用端口");
        return { port };
      }
      if (!input.hostId) throw new Error("请选择主机");
      let rangeStart: number | null | undefined;
      let rangeEnd: number | null | undefined;
      if (input.tunnelId) {
        const { tunnel } = await requireTunnelUseOrTrafficBillingAccess(ctx, input.tunnelId);
        if (tunnel.entryHostId !== input.hostId) throw new Error("隧道入口主机与规则主机不一致");
        rangeStart = (tunnel as any).portRangeStart;
        rangeEnd = (tunnel as any).portRangeEnd;
      } else {
        await requireHostUseAccess(ctx, input.hostId);
      }
      if (ctx.user.role !== "admin") {
        const planRange = await db.getUserPlanPortRange(ctx.user.id, input.hostId, input.tunnelId ?? undefined);
        if (planRange) {
          rangeStart = Math.max(Number(rangeStart || planRange.start), planRange.start);
          rangeEnd = Math.min(Number(rangeEnd || planRange.end), planRange.end);
        }
      }
      const port = await db.findAvailablePort(input.hostId, rangeStart, rangeEnd);
      if (!port) throw new Error("该主机端口区间内已无可用端口");
      return { port };
    }),
});

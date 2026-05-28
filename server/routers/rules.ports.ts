import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { requireHostUseAccess, requireRuleAccess, requireTunnelUseOrTrafficBillingAccess } from "./helpers";

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
      if (rangeStart != null && rangeEnd != null && (input.sourcePort < rangeStart || input.sourcePort > rangeEnd)) {
        return { used: true, reason: `端口必须在隧道允许范围 ${rangeStart}-${rangeEnd} 内` };
      }
      if (ctx.user.role !== "admin") {
        const planRange = await db.getUserPlanPortRange(ctx.user.id, input.hostId, input.tunnelId ?? undefined);
        if (planRange && (input.sourcePort < planRange.start || input.sourcePort > planRange.end)) {
          return { used: true, reason: `套餐端口必须在 ${planRange.start}-${planRange.end} 内` };
        }
      }
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      const used = await db.isPortUsedOnHost(input.hostId, input.sourcePort, input.excludeRuleId);
      return { used };
    }),
  /** 获取随机可用端口 */
  randomPort: protectedProcedure
    .input(randomPortInputSchema)
    .query(async ({ input, ctx }) => {
      if (input.excludeRuleId) {
        await requireRuleAccess(ctx, input.excludeRuleId);
      }
      if (input.forwardGroupId) {
        if (ctx.user.role !== "admin") throw new Error("只有管理员可以使用转发组");
        const port = await db.findAvailableForwardGroupPort(input.forwardGroupId, input.excludeRuleId);
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
        const { host } = await requireHostUseAccess(ctx, input.hostId);
        rangeStart = (host as any).portRangeStart;
        rangeEnd = (host as any).portRangeEnd;
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
    })
});

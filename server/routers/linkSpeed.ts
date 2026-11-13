import crypto from "node:crypto";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { getLinkAccessScope } from "../linkAccessView";
import { buildLinkSpeedPlan } from "../linkSpeedPlan";
import {
  cancelLinkSpeedJob,
  createLinkSpeedJob,
  getLinkSpeedJob,
  latestLinkSpeedJob,
  linkSpeedHostSupported,
} from "../linkSpeedTasks";
import { releaseHostPortReservations } from "../portReservations";
import { withKeyedTaskLock } from "../keyedTaskLock";

// 测速会产生不计入套餐的真实流量，仅管理员可用。
export const linkSpeedRouter = router({
  start: adminProcedure
    .input(
      z.object({
        resourceType: z.enum(["tunnel", "chain"]),
        resourceId: z.number().int().positive(),
        protocol: z.enum(["tcp", "udp"]).default("tcp"),
        duration: z.number().int().min(3).max(30).default(10),
        rateMbps: z.number().min(1).max(1000).default(100),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withKeyedTaskLock("link-speed-start", async () => {
        const resource =
          input.resourceType === "tunnel"
            ? await db.getTunnelById(input.resourceId)
            : await db.getForwardGroupById(input.resourceId);
        if (!resource) throw new Error("链路不存在");
        const scope = await getLinkAccessScope(ctx.user);
        if (
          scope &&
          !(
            input.resourceType === "tunnel" ? scope.tunnelIds : scope.groupIds
          ).has(input.resourceId)
        )
          throw new Error("无权使用此链路");
        const token = crypto.randomBytes(32).toString("hex");
        const plan = await buildLinkSpeedPlan(
          resource,
          input.resourceType,
          input.protocol,
          token,
        );
        try {
          const missing = plan.route.filter(
            (node) => !linkSpeedHostSupported(node.hostId),
          );
          if (missing.length)
            throw new Error(
              `请更新链路中所有 Agent 后重试：${missing.map((node) => node.name).join("、")}`,
            );
          const user = await db.getUserById(ctx.user.id);
          const userLimits = [
            Number(user?.gostRateLimitIn),
            Number(user?.gostRateLimitOut),
          ].filter((n) => Number.isFinite(n) && n > 0);
          if (userLimits.length)
            plan.limitMbps = Math.min(
              plan.limitMbps || Infinity,
              ...userLimits,
            );
          return createLinkSpeedJob(
            ctx.user.id,
            {
              resourceType: input.resourceType,
              resourceId: input.resourceId,
              name: resource.name,
              protocol: input.protocol,
              duration: input.duration,
              rateMbps:
                input.protocol === "udp"
                  ? Math.min(input.rateMbps, plan.limitMbps || Infinity)
                  : plan.limitMbps,
            },
            plan,
            token,
          );
        } catch (error) {
          releaseHostPortReservations(plan.reservations);
          throw error;
        }
      }),
    ),
  status: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input, ctx }) => getLinkSpeedJob(input.id, ctx.user).status),
  latest: adminProcedure
    .input(
      z.object({
        resourceType: z.enum(["tunnel", "chain"]),
        resourceId: z.number().int().positive(),
      }),
    )
    .query(({ input, ctx }) =>
      latestLinkSpeedJob(input.resourceType, input.resourceId, ctx.user.id),
    ),
  cancel: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input, ctx }) => cancelLinkSpeedJob(input.id, ctx.user)),
});

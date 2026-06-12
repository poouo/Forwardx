import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";

export const dashboardRouter = router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      return db.getDashboardStats(ctx.user.id, { includeTraffic: false });
    }),
    trafficTotals: protectedProcedure.query(async ({ ctx }) => {
      const traffic = await db.getTotalTraffic(ctx.user.id);
      return {
        totalTrafficIn: traffic.totalIn,
        totalTrafficOut: traffic.totalOut,
      };
    }),
    /** 当前用户流量走势（仪表盘图表） */
    trafficSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(5),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 5;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return db.getGlobalTrafficSeries({
          bucketMinutes,
          since,
          userId: ctx.user.id,
        });
      }),
    /** 当前用户按转发类型划分的规则流量消耗分布 */
    trafficBreakdown: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(168),
        limit: z.number().min(1).max(100).default(30),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 168;
        const limit = input?.limit ?? 30;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return db.getDashboardTrafficBreakdown({
          userId: ctx.user.id,
          since,
          limit,
        });
      }),
    /** 当前用户 TCPing 延迟走势（仪表盘图表） */
    tcpingSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(1),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 1;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        return db.getGlobalTcpingSeries({
          bucketMinutes,
          since,
          userId: ctx.user.id,
        });
      }),
    /** 用户流量汇总（首页始终只看当前登录用户） */
    userTraffic: protectedProcedure.query(async ({ ctx }) => {
      const user = await db.getUserById(ctx.user.id);
      if (!user) return [];
      return [{
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        role: user.role,
        trafficLimit: user.trafficLimit,
        trafficUsed: user.trafficUsed,
        canAddRules: user.canAddRules,
        gostRateLimitIn: user.gostRateLimitIn,
        gostRateLimitOut: user.gostRateLimitOut,
        expiresAt: user.expiresAt,
        trafficAutoReset: user.trafficAutoReset,
        trafficResetDay: user.trafficResetDay,
      }];
    }),
  });

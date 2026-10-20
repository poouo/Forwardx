import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { dashboardSummaries } from "../backgroundSummaryCache";

export const dashboardRouter = router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.user.id;
      return dashboardSummaries.get(
        `${userId}:stats`,
        async () => ({ ...await db.getDashboardStats(userId, { includeTraffic: false }), summaryUpdatedAt: new Date() }),
      );
    }),
    trafficTotals: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.user.id;
      return dashboardSummaries.get(`${userId}:trafficTotals`, async () => {
        const traffic = await db.getTotalTraffic(userId);
        return {
          totalTrafficIn: traffic.totalIn,
          totalTrafficOut: traffic.totalOut,
        };
      });
    }),
    /** 当前用户流量走势（仪表盘图表） */
    trafficSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        bucketMinutes: z.number().min(1).max(60).default(60),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 60;
        const userId = ctx.user.id;
        return dashboardSummaries.get(
          `${userId}:trafficSeries:${hours}:${bucketMinutes}`,
          () => db.getGlobalTrafficSeries({
            bucketMinutes,
            since: new Date(Date.now() - hours * 3600 * 1000),
            userId,
          }),
        );
      }),
    /** 当前用户按转发类型划分的规则流量消耗分布 */
    trafficBreakdown: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        limit: z.number().min(1).max(100).default(30),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const limit = input?.limit ?? 30;
        const userId = ctx.user.id;
        return dashboardSummaries.get(
          `${userId}:trafficBreakdown:${hours}:${limit}`,
          () => db.getDashboardTrafficBreakdown({
            userId,
            since: new Date(Date.now() - hours * 3600 * 1000),
            limit,
          }),
        );
      }),
    /** 当前用户 TCPing 延迟走势（仪表盘图表） */
    tcpingSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(0.5).max(24 * 3).default(24),
        bucketMinutes: z.number().min(1).max(60).default(1),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 1;
        const userId = ctx.user.id;
        return dashboardSummaries.get(
          `${userId}:tcpingSeries:${hours}:${bucketMinutes}`,
          () => db.getGlobalTcpingSeries({
            bucketMinutes,
            since: new Date(Date.now() - hours * 3600 * 1000),
            userId,
          }),
        );
      }),
    /** 用户流量汇总（首页始终只看当前登录用户） */
    userTraffic: protectedProcedure.query(({ ctx }) => {
      // Auth already loaded and validated this exact user in this request.
      const user = ctx.user;
      return [{
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
        role: user.role,
        trafficLimit: user.trafficLimit,
        trafficUsed: user.trafficUsed,
        manualCanAddRules: user.manualCanAddRules,
        manualTrafficLimit: user.manualTrafficLimit,
        canAddRules: user.canAddRules,
        gostRateLimitIn: user.gostRateLimitIn,
        gostRateLimitOut: user.gostRateLimitOut,
        expiresAt: user.expiresAt,
        trafficAutoReset: user.trafficAutoReset,
        trafficResetDay: user.trafficResetDay,
      }];
    }),
  });

import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";

export const dashboardRouter = router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getDashboardStats(isAdmin ? undefined : ctx.user.id);
    }),
    /** 全局流量走势（仪表盘图表） */
    trafficSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(5),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 5;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getGlobalTrafficSeries({
          bucketMinutes,
          since,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),
    /** 各规则、主机、隧道的流量消耗分布 */
    trafficBreakdown: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(168),
        limit: z.number().min(1).max(100).default(30),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 168;
        const limit = input?.limit ?? 30;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getDashboardTrafficBreakdown({
          userId: isAdmin ? undefined : ctx.user.id,
          since,
          limit,
        });
      }),
    /** 全局 TCPing 延迟走势（仪表盘图表） */
    tcpingSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(1),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 1;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getGlobalTcpingSeries({
          bucketMinutes,
          since,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),
    /** 用户流量汇总（管理员看全部，普通用户看自己） */
    userTraffic: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      if (isAdmin) {
        return db.getUserTrafficSummaries();
      }
      const user = await db.getUserById(ctx.user.id);
      if (!user) return [];
      return [{
        id: user.id,
        username: user.username,
        name: user.name,
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

import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";

type DashboardCacheEntry<T> = {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
};

const dashboardCache = new Map<string, DashboardCacheEntry<unknown>>();
const DASHBOARD_CACHE_MAX_ENTRIES = 200;

function pruneDashboardCache(now = Date.now()) {
  for (const [key, entry] of dashboardCache.entries()) {
    if (!entry.promise && entry.expiresAt <= now) dashboardCache.delete(key);
  }
  if (dashboardCache.size <= DASHBOARD_CACHE_MAX_ENTRIES) return;
  const removable = Array.from(dashboardCache.entries())
    .filter(([, entry]) => !entry.promise)
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of removable.slice(0, dashboardCache.size - DASHBOARD_CACHE_MAX_ENTRIES)) {
    dashboardCache.delete(key);
  }
}

function cachedDashboardQuery<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = dashboardCache.get(key) as DashboardCacheEntry<T> | undefined;
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }
  if (cached?.promise) return cached.promise;

  const promise = load()
    .then((value) => {
      dashboardCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      pruneDashboardCache();
      return value;
    })
    .catch((error) => {
      if (dashboardCache.get(key)?.promise === promise) dashboardCache.delete(key);
      throw error;
    });
  dashboardCache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

export const dashboardRouter = router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      return cachedDashboardQuery(
        `stats:${ctx.user.id}`,
        4_000,
        () => db.getDashboardStats(ctx.user.id, { includeTraffic: false }),
      );
    }),
    trafficTotals: protectedProcedure.query(async ({ ctx }) => {
      return cachedDashboardQuery(`trafficTotals:${ctx.user.id}`, 8_000, async () => {
        const traffic = await db.getTotalTraffic(ctx.user.id);
        return {
          totalTrafficIn: traffic.totalIn,
          totalTrafficOut: traffic.totalOut,
        };
      });
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
        const cacheBucket = Math.floor(Date.now() / 30_000);
        return cachedDashboardQuery(
          `trafficSeries:${ctx.user.id}:${hours}:${bucketMinutes}:${cacheBucket}`,
          30_000,
          () => db.getGlobalTrafficSeries({
            bucketMinutes,
            since,
            userId: ctx.user.id,
          }),
        );
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
        const cacheBucket = Math.floor(Date.now() / 10_000);
        return cachedDashboardQuery(
          `trafficBreakdown:${ctx.user.id}:${hours}:${limit}:${cacheBucket}`,
          10_000,
          () => db.getDashboardTrafficBreakdown({
            userId: ctx.user.id,
            since,
            limit,
          }),
        );
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
        const cacheBucket = Math.floor(Date.now() / 10_000);
        return cachedDashboardQuery(
          `tcpingSeries:${ctx.user.id}:${hours}:${bucketMinutes}:${cacheBucket}`,
          10_000,
          () => db.getGlobalTcpingSeries({
            bucketMinutes,
            since,
            userId: ctx.user.id,
          }),
        );
      }),
    /** 用户流量汇总（首页始终只看当前登录用户） */
    userTraffic: protectedProcedure.query(async ({ ctx }) => cachedDashboardQuery(`userTraffic:${ctx.user.id}`, 5_000, async () => {
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
    })),
  });

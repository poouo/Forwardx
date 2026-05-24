import { eq, sql } from "drizzle-orm";
import { forwardRules, hosts } from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { getTotalTraffic } from "./metricsRepository";

// ==================== Dashboard Stats ====================

export async function getDashboardStats(userId?: number) {
  const db = await getDb();
  if (!db) return { totalHosts: 0, onlineHosts: 0, totalRules: 0, activeRules: 0, totalTrafficIn: 0, totalTrafficOut: 0 };

  const hostConditions = userId ? eq(hosts.userId, userId) : undefined;
  const ruleConditions = userId ? eq(forwardRules.userId, userId) : undefined;

  const hostStatsRows = await db
    .select({
      totalHosts: sql<number>`COUNT(*)`,
      onlineHosts: sql<number>`SUM(CASE WHEN isOnline = 1 THEN 1 ELSE 0 END)`,
    })
    .from(hosts)
    .where(hostConditions as any);

  const ruleStatsRows = await db
    .select({
      totalRules: sql<number>`COUNT(*)`,
      activeRules: sql<number>`SUM(CASE WHEN isEnabled = 1 AND isRunning = 1 THEN 1 ELSE 0 END)`,
    })
    .from(forwardRules)
    .where(ruleConditions as any);

  const hostStats = hostStatsRows[0];
  const ruleStats = ruleStatsRows[0];
  const traffic = await getTotalTraffic(userId);
  const freshOnlineHosts = (await db.select().from(hosts).where(hostConditions as any))
    .filter((host: any) => {
      if (!host.isOnline || !host.lastHeartbeat) return false;
      const time = new Date(host.lastHeartbeat).getTime();
      return Number.isFinite(time) && Date.now() - time <= 90 * 1000;
    }).length;

  return {
    totalHosts: Number(hostStats?.totalHosts) || 0,
    onlineHosts: freshOnlineHosts,
    totalRules: Number(ruleStats?.totalRules) || 0,
    activeRules: Number(ruleStats?.activeRules) || 0,
    totalTrafficIn: traffic.totalIn,
    totalTrafficOut: traffic.totalOut,
  };
}

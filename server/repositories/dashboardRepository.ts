import { eq, sql } from "drizzle-orm";
import { forwardRules, hosts, tunnels } from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { getTotalTraffic, getTrafficSummaryByRule } from "./metricsRepository";
import { clampPositiveInt } from "./repositoryUtils";

type DashboardTrafficBreakdownItem = {
  id: number;
  name: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
};

type TrafficSummaryItem = {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

function emptyTrafficBreakdown() {
  return {
    rules: [] as DashboardTrafficBreakdownItem[],
    hosts: [] as DashboardTrafficBreakdownItem[],
    tunnels: [] as DashboardTrafficBreakdownItem[],
  };
}

function addTraffic(
  map: Map<number, DashboardTrafficBreakdownItem>,
  id: number,
  name: string,
  bytesIn: number,
  bytesOut: number,
) {
  if (!id) return;
  const totalBytes = bytesIn + bytesOut;
  if (totalBytes <= 0) return;
  const prev = map.get(id);
  if (prev) {
    prev.bytesIn += bytesIn;
    prev.bytesOut += bytesOut;
    prev.totalBytes += totalBytes;
    return;
  }
  map.set(id, { id, name, bytesIn, bytesOut, totalBytes });
}

function sortTrafficItems(map: Map<number, DashboardTrafficBreakdownItem>, limit: number) {
  return Array.from(map.values())
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, limit);
}

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

// ==================== Dashboard Traffic Breakdown ====================

export async function getDashboardTrafficBreakdown(opts: {
  userId?: number;
  since?: Date;
  limit?: number;
} = {}) {
  const db = await getDb();
  if (!db) return emptyTrafficBreakdown();

  const limit = clampPositiveInt(opts.limit, 30, 100);
  const since = opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const summaries = await getTrafficSummaryByRule({ userId: opts.userId, since }) as TrafficSummaryItem[];
  if (summaries.length === 0) return emptyTrafficBreakdown();

  const ruleIds = Array.from(new Set(summaries.map((item) => Number(item.ruleId)).filter(Boolean)));
  const hostIds = Array.from(new Set(summaries.map((item) => Number(item.hostId)).filter(Boolean)));

  const ruleRows = ruleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
        tunnelId: forwardRules.tunnelId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const hostRows = hostIds.length
    ? await db
      .select({
        id: hosts.id,
        name: hosts.name,
      })
      .from(hosts)
      .where(sql`${hosts.id} IN (${sql.join(hostIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];

  const ruleMeta = new Map<number, { name: string; tunnelId: number | null }>();
  for (const row of ruleRows as any[]) {
    ruleMeta.set(Number(row.id), {
      name: row.name || `规则 #${row.id}`,
      tunnelId: row.tunnelId ? Number(row.tunnelId) : null,
    });
  }

  const hostNameById = new Map<number, string>();
  for (const row of hostRows as any[]) {
    hostNameById.set(Number(row.id), row.name || `主机 #${row.id}`);
  }

  const tunnelIds = Array.from(new Set(Array.from(ruleMeta.values()).map((item) => item.tunnelId).filter(Boolean))) as number[];
  const tunnelRows = tunnelIds.length
    ? await db
      .select({
        id: tunnels.id,
        name: tunnels.name,
      })
      .from(tunnels)
      .where(sql`${tunnels.id} IN (${sql.join(tunnelIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];

  const tunnelNameById = new Map<number, string>();
  for (const row of tunnelRows as any[]) {
    tunnelNameById.set(Number(row.id), row.name || `隧道 #${row.id}`);
  }

  const ruleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const hostTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const tunnelTotals = new Map<number, DashboardTrafficBreakdownItem>();

  for (const item of summaries) {
    const ruleId = Number(item.ruleId);
    const hostId = Number(item.hostId);
    const bytesIn = Number(item.bytesIn) || 0;
    const bytesOut = Number(item.bytesOut) || 0;
    const rule = ruleMeta.get(ruleId);

    addTraffic(ruleTotals, ruleId, rule?.name || `规则 #${ruleId}`, bytesIn, bytesOut);
    addTraffic(hostTotals, hostId, hostNameById.get(hostId) || `主机 #${hostId}`, bytesIn, bytesOut);

    if (rule?.tunnelId) {
      addTraffic(tunnelTotals, rule.tunnelId, tunnelNameById.get(rule.tunnelId) || `隧道 #${rule.tunnelId}`, bytesIn, bytesOut);
    }
  }

  return {
    rules: sortTrafficItems(ruleTotals, limit),
    hosts: sortTrafficItems(hostTotals, limit),
    tunnels: sortTrafficItems(tunnelTotals, limit),
  };
}

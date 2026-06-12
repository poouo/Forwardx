import { and, eq, sql } from "drizzle-orm";
import { forwardRules, hosts } from "../../drizzle/schema";
import { getDb, quoteDbIdentifier } from "../dbRuntime";
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

type RuleTrafficBucket = "tunnelRules" | "portRules" | "forwardGroupRules";

type RuleTrafficMeta = {
  name: string;
  forwardType: string;
  tunnelId: number | null;
  forwardGroupId: number | null;
  forwardGroupRuleId: number | null;
  forwardGroupMemberId: number | null;
  isForwardGroupTemplate: boolean;
};

function emptyTrafficBreakdown() {
  return {
    tunnelRules: [] as DashboardTrafficBreakdownItem[],
    portRules: [] as DashboardTrafficBreakdownItem[],
    forwardGroupRules: [] as DashboardTrafficBreakdownItem[],
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

function getRuleTrafficBucket(rule: RuleTrafficMeta | undefined): RuleTrafficBucket {
  if (
    rule?.isForwardGroupTemplate ||
    rule?.forwardGroupId ||
    rule?.forwardGroupRuleId ||
    rule?.forwardGroupMemberId
  ) {
    return "forwardGroupRules";
  }
  if (rule?.tunnelId) return "tunnelRules";
  return "portRules";
}

function qualified(alias: string, column: string) {
  return sql.raw(`${alias}.${quoteDbIdentifier(column)}`);
}

// ==================== Dashboard Stats ====================

export async function getDashboardStats(userId?: number, opts: { includeTraffic?: boolean } = {}) {
  const db = await getDb();
  if (!db) return { totalHosts: 0, onlineHosts: 0, totalRules: 0, activeRules: 0, totalTrafficIn: 0, totalTrafficOut: 0 };

  const heartbeatFreshSince = new Date(Date.now() - 90 * 1000);
  const hostConditions = userId ? eq(hosts.userId, userId) : undefined;
  const ruleConditions = [
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    ...(userId ? [eq(forwardRules.userId, userId)] : []),
  ];

  const hostStatsQuery = db
    .select({
      totalHosts: sql<number>`COUNT(*)`,
      onlineHosts: sql<number>`COALESCE(SUM(CASE WHEN ${hosts.isOnline} = ${true} AND ${hosts.lastHeartbeat} >= ${heartbeatFreshSince} THEN 1 ELSE 0 END), 0)`,
    })
    .from(hosts)
    .where(hostConditions as any);

  const ruleStatsQuery = db
    .select({
      totalRules: sql<number>`COUNT(*)`,
      activeRules: sql<number>`SUM(CASE WHEN ${forwardRules.isEnabled} = ${true} AND (${forwardRules.isRunning} = ${true} OR (${forwardRules.isForwardGroupTemplate} = ${true} AND EXISTS (SELECT 1 FROM ${sql.raw(quoteDbIdentifier("forward_rules"))} child WHERE ${qualified("child", "forwardGroupRuleId")} = ${forwardRules.id} AND ${qualified("child", "pendingDelete")} = ${false} AND ${qualified("child", "isEnabled")} = ${true} AND ${qualified("child", "isRunning")} = ${true}))) THEN 1 ELSE 0 END)`,
    })
    .from(forwardRules)
    .where(and(...ruleConditions));

  const [hostStatsRows, ruleStatsRows, traffic] = await Promise.all([
    hostStatsQuery,
    ruleStatsQuery,
    opts.includeTraffic === false ? Promise.resolve({ totalIn: 0, totalOut: 0 }) : getTotalTraffic(userId),
  ]);
  const hostStats = hostStatsRows[0];
  const ruleStats = ruleStatsRows[0];

  return {
    totalHosts: Number(hostStats?.totalHosts) || 0,
    onlineHosts: Number(hostStats?.onlineHosts) || 0,
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
  const summaries = await getTrafficSummaryByRule({ userId: opts.userId, since, includeLatency: false }) as TrafficSummaryItem[];
  if (summaries.length === 0) return emptyTrafficBreakdown();

  const ruleIds = Array.from(new Set(summaries.map((item) => Number(item.ruleId)).filter(Boolean)));
  const ruleRows = ruleIds.length
    ? await db
      .select({
        id: forwardRules.id,
        name: forwardRules.name,
        forwardType: forwardRules.forwardType,
        tunnelId: forwardRules.tunnelId,
        forwardGroupId: forwardRules.forwardGroupId,
        forwardGroupRuleId: forwardRules.forwardGroupRuleId,
        forwardGroupMemberId: forwardRules.forwardGroupMemberId,
        isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];

  const ruleMeta = new Map<number, RuleTrafficMeta>();
  for (const row of ruleRows as any[]) {
    ruleMeta.set(Number(row.id), {
      name: row.name || `规则 #${row.id}`,
      forwardType: String(row.forwardType || ""),
      tunnelId: row.tunnelId ? Number(row.tunnelId) : null,
      forwardGroupId: row.forwardGroupId ? Number(row.forwardGroupId) : null,
      forwardGroupRuleId: row.forwardGroupRuleId ? Number(row.forwardGroupRuleId) : null,
      forwardGroupMemberId: row.forwardGroupMemberId ? Number(row.forwardGroupMemberId) : null,
      isForwardGroupTemplate: !!row.isForwardGroupTemplate,
    });
  }

  const tunnelRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const portRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const forwardGroupRuleTotals = new Map<number, DashboardTrafficBreakdownItem>();
  const totalsByBucket: Record<RuleTrafficBucket, Map<number, DashboardTrafficBreakdownItem>> = {
    tunnelRules: tunnelRuleTotals,
    portRules: portRuleTotals,
    forwardGroupRules: forwardGroupRuleTotals,
  };

  for (const item of summaries) {
    const ruleId = Number(item.ruleId);
    const bytesIn = Number(item.bytesIn) || 0;
    const bytesOut = Number(item.bytesOut) || 0;
    const rule = ruleMeta.get(ruleId);
    const bucket = getRuleTrafficBucket(rule);
    addTraffic(totalsByBucket[bucket], ruleId, rule?.name || `规则 #${ruleId}`, bytesIn, bytesOut);
  }

  return {
    tunnelRules: sortTrafficItems(tunnelRuleTotals, limit),
    portRules: sortTrafficItems(portRuleTotals, limit),
    forwardGroupRules: sortTrafficItems(forwardGroupRuleTotals, limit),
  };
}

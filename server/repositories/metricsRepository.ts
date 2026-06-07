import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  hostMetrics, InsertHostMetric,
  trafficStats, InsertTrafficStat,
  forwardRules,
  forwardGroups,
  forwardGroupMembers,
  hosts,
  tunnels,
  forwardTests, InsertForwardTest,
  tcpingStats, InsertTcpingStat,
  tunnelLatencyStats, InsertTunnelLatencyStat,
  forwardGroupLatencyStats, InsertForwardGroupLatencyStat,
} from "../../drizzle/schema";
import { executeRaw, getDb, getDatabaseKind, nowDate, queryRaw } from "../dbRuntime";
import { clampPositiveInt } from "./repositoryUtils";

// ==================== Host Metrics Queries ====================

export async function insertHostMetric(metric: InsertHostMetric) {
  const db = await getDb();
  if (!db) return;
  await db.insert(hostMetrics).values(metric);
}

export async function getLatestHostMetrics(hostId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostMetrics).where(eq(hostMetrics.hostId, hostId)).orderBy(desc(hostMetrics.recordedAt)).limit(limit);
}

// ==================== Traffic Stats Queries ====================

export async function insertTrafficStat(stat: InsertTrafficStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(trafficStats).values(stat);
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  const rule = await getRuleWithCreatedAt(ruleId);
  const conds: any[] = [eq(trafficStats.ruleId, ruleId)];
  if (rule?.createdAt) conds.push(gte(trafficStats.recordedAt, rule.createdAt));
  return db.select().from(trafficStats).where(and(...conds)).orderBy(desc(trafficStats.recordedAt)).limit(limit);
}

async function getRuleIdsByUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(eq(forwardRules.userId, userId));
  return rows.map((r: { id: unknown }) => Number(r.id));
}

async function getRuleWithCreatedAt(ruleId: number): Promise<{ id: number; createdAt: Date } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: forwardRules.id, createdAt: forwardRules.createdAt })
    .from(forwardRules)
    .where(eq(forwardRules.id, ruleId))
    .limit(1);
  const row = rows[0] as any;
  return row ? { id: Number(row.id), createdAt: row.createdAt } : null;
}

type RuleTrafficIdentity = {
  id: number;
  hostId: number;
  sourcePort: number;
  userId: number;
};

type TrafficSummaryRow = {
  ruleId: number;
  hostId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
};

function ruleTrafficIdentityKey(rule: RuleTrafficIdentity | undefined | null) {
  if (!rule) return "";
  return `${Number(rule.userId) || 0}:${Number(rule.hostId) || 0}:${Number(rule.sourcePort) || 0}`;
}

function mergeTrafficSummaryRows(rows: TrafficSummaryRow[]) {
  const merged = new Map<string, TrafficSummaryRow>();
  for (const item of rows) {
    const key = `${item.ruleId}:${item.hostId}`;
    const prev = merged.get(key);
    if (prev) {
      prev.bytesIn += item.bytesIn;
      prev.bytesOut += item.bytesOut;
      prev.connections += item.connections;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

async function getForwardGroupModeMap(groupIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, string>();
  if (!db || ids.length === 0) return map;
  const rows = await db
    .select({
      id: forwardGroups.id,
      groupMode: forwardGroups.groupMode,
    })
    .from(forwardGroups)
    .where(sql`${forwardGroups.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  for (const row of rows as any[]) {
    map.set(Number(row.id), String(row.groupMode || "failover"));
  }
  return map;
}

export async function getTotalTraffic(userId?: number) {
  const db = await getDb();
  if (!db) return { totalIn: 0, totalOut: 0 };

  if (userId) {
    const ruleIds = await getRuleIdsByUser(userId);
    if (ruleIds.length === 0) return { totalIn: 0, totalOut: 0 };
    const r = await db.select({
      totalIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      totalOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    }).from(trafficStats)
      .where(sql`${trafficStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
    const row = r[0];
    return {
      totalIn: Number(row?.totalIn) || 0,
      totalOut: Number(row?.totalOut) || 0,
    };
  }

  const r = await db.select({
    totalIn: sql<number>`COALESCE(SUM(bytesIn), 0)`,
    totalOut: sql<number>`COALESCE(SUM(bytesOut), 0)`,
  }).from(trafficStats);
  const row = r[0];
  return {
    totalIn: Number(row?.totalIn) || 0,
    totalOut: Number(row?.totalOut) || 0,
  };
}

/** 鎸夎鍒欐眹鎬绘祦閲?*/
export async function getTrafficSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
  ruleIds?: number[];
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number; latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | null }>;
  const requestedRuleIds = Array.from(new Set((opts.ruleIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const conds: any[] = [];
  if (opts.hostId) conds.push(eq(trafficStats.hostId, opts.hostId));
  if (opts.since) conds.push(gte(trafficStats.recordedAt, opts.since));
  const baseQuery = db
    .select({
      ruleId: trafficStats.ruleId,
      hostId: trafficStats.hostId,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats)
    .innerJoin(forwardRules, eq(forwardRules.id, trafficStats.ruleId));
  const rows = await (conds.length ? baseQuery.where(and(...conds)) : baseQuery).groupBy(trafficStats.ruleId, trafficStats.hostId);

  let result: TrafficSummaryRow[] = rows.map((r: any) => ({
    ruleId: Number((r as any).ruleId),
    hostId: Number((r as any).hostId),
    bytesIn: Number((r as any).bytesIn) || 0,
    bytesOut: Number((r as any).bytesOut) || 0,
    connections: Number((r as any).connections) || 0,
  }));

  const groupChildIds = Array.from(new Set(result.map((r) => r.ruleId)));
  if (groupChildIds.length > 0) {
    const childRows = await db
      .select({
        id: forwardRules.id,
        parentId: forwardRules.forwardGroupRuleId,
        groupId: forwardRules.forwardGroupId,
        memberId: forwardRules.forwardGroupMemberId,
        hostId: forwardRules.hostId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(groupChildIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.forwardGroupRuleId} IS NOT NULL`);
    const groupModeById = await getForwardGroupModeMap((childRows as any[]).map((row: any) => Number(row.groupId || 0)));
    const chainMemberRows = (childRows as any[]).filter((row: any) => groupModeById.get(Number(row.groupId || 0)) === "chain");
    const chainMemberPriority = new Map<number, number>();
    if (chainMemberRows.length > 0) {
      const memberIds = Array.from(new Set(chainMemberRows.map((row: any) => Number(row.memberId || 0)).filter((id: number) => id > 0)));
      if (memberIds.length > 0) {
        const memberRows = await db
          .select({
            id: forwardGroupMembers.id,
            priority: forwardGroupMembers.priority,
          })
          .from(forwardGroupMembers)
          .where(sql`${forwardGroupMembers.id} IN (${sql.join(memberIds.map((id) => sql`${id}`), sql`, `)})`);
        for (const row of memberRows as any[]) {
          chainMemberPriority.set(Number(row.id), Number(row.priority || 0));
        }
      }
    }
    const parentByChild = new Map<number, { parentId: number; hostId: number }>();
    for (const row of childRows as any[]) {
      const groupMode = groupModeById.get(Number(row.groupId || 0));
      if (groupMode === "chain" && Number(chainMemberPriority.get(Number(row.memberId || 0)) || 0) !== 0) {
        continue;
      }
      parentByChild.set(Number(row.id), { parentId: Number(row.parentId), hostId: Number(row.hostId) });
    }
    if (parentByChild.size > 0) {
      const merged = new Map<string, { ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number }>();
      for (const item of result) {
        const parent = parentByChild.get(item.ruleId);
        const ruleId = parent?.parentId || item.ruleId;
        const hostId = parent?.hostId || item.hostId;
        const key = `${ruleId}:${hostId}`;
        const prev = merged.get(key);
        if (prev) {
          prev.bytesIn += item.bytesIn;
          prev.bytesOut += item.bytesOut;
          prev.connections += item.connections;
        } else {
          merged.set(key, { ...item, ruleId, hostId });
        }
      }
      result = Array.from(merged.values());
    }
  }

  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    const ok = new Set(ruleIds);
    result = result.filter((r) => ok.has(r.ruleId));
  }

  let visibleRequestedRows: RuleTrafficIdentity[] = [];
  if (requestedRuleIds.length > 0) {
    const requestedConds: any[] = [
      sql`${forwardRules.id} IN (${sql.join(requestedRuleIds.map(id => sql`${id}`), sql`, `)})`,
      eq(forwardRules.pendingDelete, false),
    ];
    if (opts.userId) requestedConds.push(eq(forwardRules.userId, opts.userId));
    if (opts.hostId) requestedConds.push(eq(forwardRules.hostId, opts.hostId));
    const rows = await db
      .select({
        id: forwardRules.id,
        hostId: forwardRules.hostId,
        sourcePort: forwardRules.sourcePort,
        userId: forwardRules.userId,
      })
      .from(forwardRules)
      .where(and(...requestedConds));
    visibleRequestedRows = (rows as any[]).map((row) => ({
      id: Number(row.id),
      hostId: Number(row.hostId),
      sourcePort: Number(row.sourcePort),
      userId: Number(row.userId),
    }));
    const visibleRequestedIds = new Set(visibleRequestedRows.map((row) => row.id));
    // Deleted/recreated rules get new IDs; fold preserved same-entry traffic into the visible rule.
    const requestedByIdentity = new Map<string, RuleTrafficIdentity>();
    for (const row of visibleRequestedRows) {
      const key = ruleTrafficIdentityKey(row);
      if (key) requestedByIdentity.set(key, row);
    }
    const resultRuleIds = Array.from(new Set(result.map((item) => item.ruleId).filter((id) => id > 0)));
    const resultRuleRows = resultRuleIds.length > 0
      ? await db
        .select({
          id: forwardRules.id,
          hostId: forwardRules.hostId,
          sourcePort: forwardRules.sourcePort,
          userId: forwardRules.userId,
        })
        .from(forwardRules)
        .where(sql`${forwardRules.id} IN (${sql.join(resultRuleIds.map(id => sql`${id}`), sql`, `)})`)
      : [];
    const identityByRuleId = new Map<number, RuleTrafficIdentity>();
    for (const row of resultRuleRows as any[]) {
      identityByRuleId.set(Number(row.id), {
        id: Number(row.id),
        hostId: Number(row.hostId),
        sourcePort: Number(row.sourcePort),
        userId: Number(row.userId),
      });
    }
    result = result.map((item) => {
      if (visibleRequestedIds.has(item.ruleId)) return item;
      const currentRule = requestedByIdentity.get(ruleTrafficIdentityKey(identityByRuleId.get(item.ruleId)));
      if (!currentRule) return item;
      return {
        ...item,
        ruleId: currentRule.id,
        hostId: currentRule.hostId,
      };
    });
    result = mergeTrafficSummaryRows(result);
    result = result.filter((item) => visibleRequestedIds.has(item.ruleId));
    const existingKeys = new Set(result.map((item) => `${item.ruleId}:${item.hostId}`));
    for (const row of visibleRequestedRows) {
      const key = `${row.id}:${row.hostId}`;
      if (!existingKeys.has(key)) {
        result.push({
          ruleId: row.id,
          hostId: row.hostId,
          bytesIn: 0,
          bytesOut: 0,
          connections: 0,
        });
        existingKeys.add(key);
      }
    }
  }

  if (result.length === 0) return result.map((item) => ({ ...item, latestLatencyMs: null, latestLatencyIsTimeout: false, latestLatencyAt: null }));

  const ruleIds = Array.from(new Set(result.map((r) => r.ruleId)));
  const childLatencyRows = ruleIds.length > 0
    ? await db
      .select({
        id: forwardRules.id,
        groupId: forwardRules.forwardGroupId,
        parentId: forwardRules.forwardGroupRuleId,
        memberId: forwardRules.forwardGroupMemberId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.forwardGroupRuleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = 0`)
    : [];
  const latencyGroupModeById = await getForwardGroupModeMap((childLatencyRows as any[]).map((row: any) => Number(row.groupId || 0)));
  const parentChainChildren = new Map<number, number[]>();
  const parentByChildRule = new Map<number, number>();
  for (const row of childLatencyRows as any[]) {
    const childId = Number(row.id);
    const parentId = Number(row.parentId);
    if (childId <= 0 || parentId <= 0) continue;
    if (latencyGroupModeById.get(Number(row.groupId || 0)) === "chain") {
      const children = parentChainChildren.get(parentId) || [];
      children.push(childId);
      parentChainChildren.set(parentId, children);
      continue;
    }
    parentByChildRule.set(childId, parentId);
  }
  const latencyRuleIds = Array.from(new Set([
    ...ruleIds,
    ...Array.from(parentByChildRule.keys()),
    ...Array.from(parentChainChildren.values()).flat(),
  ]));
  const latestRows = await db
    .select({
      ruleId: tcpingStats.ruleId,
      latencyMs: tcpingStats.latencyMs,
      isTimeout: tcpingStats.isTimeout,
      recordedAt: tcpingStats.recordedAt,
    })
    .from(tcpingStats)
    .where(sql`${tcpingStats.ruleId} IN (${sql.join(latencyRuleIds.map(id => sql`${id}`), sql`, `)})`)
    .orderBy(desc(tcpingStats.recordedAt));
  const latestByRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    const rowRuleId = Number(row.ruleId);
    const ruleId = parentByChildRule.get(rowRuleId) || rowRuleId;
    if (!latestByRule.has(ruleId)) latestByRule.set(ruleId, row);
  }
  const latestByRawRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    const rowRuleId = Number(row.ruleId);
    if (!latestByRawRule.has(rowRuleId)) latestByRawRule.set(rowRuleId, row);
  }
  for (const [parentId, childIds] of parentChainChildren.entries()) {
    let latencySum = 0;
    let recordedAt: Date | null = null;
    let isTimeout = childIds.length === 0;
    let hasLatency = false;
    for (const childId of childIds) {
      const latest = latestByRawRule.get(childId);
      if (!latest) {
        isTimeout = true;
        continue;
      }
      if (!recordedAt || new Date(latest.recordedAt).getTime() > new Date(recordedAt).getTime()) {
        recordedAt = latest.recordedAt;
      }
      if (latest.isTimeout || latest.latencyMs === null || latest.latencyMs === undefined) {
        isTimeout = true;
        continue;
      }
      latencySum += Number(latest.latencyMs) || 0;
      hasLatency = true;
    }
    latestByRule.set(parentId, {
      ruleId: parentId,
      latencyMs: !isTimeout && hasLatency ? latencySum : null,
      isTimeout,
      recordedAt,
    });
  }
  return result.map((item) => {
    const latest = latestByRule.get(item.ruleId);
    return {
      ...item,
      latestLatencyMs: latest && latest.isTimeout ? null : latest?.latencyMs ?? null,
      latestLatencyIsTimeout: !!latest?.isTimeout,
      latestLatencyAt: latest?.recordedAt ?? null,
    };
  });
}

/** 按时间分桶聚合某条规则的流量序列 */
export async function getTrafficSeriesByRule(
  ruleId: number,
  opts: { bucketMinutes?: number; since?: Date } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number; connections: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 60 * 60 * 1000);
  const rule = await getRuleWithCreatedAt(ruleId);
  const effectiveSince = rule?.createdAt && rule.createdAt > since ? rule.createdAt : since;
  const sinceSec = Math.floor(effectiveSince.getTime() / 1000);
  const bucketSec = bucket * 60;

  const bucketExpr = sql.raw(`(FLOOR(recordedAt / ${bucketSec}) * ${bucketSec})`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
      connections: sql<number>`COALESCE(SUM(${trafficStats.connections}), 0)`,
    })
    .from(trafficStats)
    .where(and(eq(trafficStats.ruleId, ruleId), gte(trafficStats.recordedAt, effectiveSince)))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  })).filter((r: { bucket: Date }) => r.bucket.getTime() / 1000 >= sinceSec);
}

/** 鑾峰彇鍏ㄥ眬娴侀噺璧板娍锛堟寜鏃堕棿鍒嗘《锛岀敤浜庝华琛ㄧ洏锛?*/
export async function getGlobalTrafficSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; bytesIn: number; bytesOut: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 5, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(trafficStats.recordedAt, since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conds.push(sql`${trafficStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`(FLOOR(recordedAt / ${bucketSec}) * ${bucketSec})`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      bytesIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      bytesOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    })
    .from(trafficStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
  }));
}

// ==================== TCPing Stats ====================

export async function insertTcpingStat(stat: InsertTcpingStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tcpingStats).values(stat);
}

export async function insertTcpingStats(stats: InsertTcpingStat[]) {
  const db = await getDb();
  if (!db) return;
  if (stats.length === 0) return;
  await db.insert(tcpingStats).values(stats);
}

/** 获取某条规则的 TCPing 延迟序列（按时间升序） */
export async function insertTunnelLatencyStat(
  stat: InsertTunnelLatencyStat,
  options: { message?: string | null } = {},
) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tunnelLatencyStats).values(stat);
  const status = stat.isTimeout ? "failed" : "success";
  const message = options.message ?? (stat.isTimeout
    ? "隧道自动延迟检测失败"
    : `隧道自动延迟检测成功${typeof stat.latencyMs === "number" ? `，延迟 ${stat.latencyMs}ms` : ""}`);
  await db.update(tunnels).set({
    lastLatencyMs: stat.isTimeout ? null : (stat.latencyMs ?? null),
    lastTestStatus: status,
    lastTestMessage: message,
    lastTestAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(tunnels.id, stat.tunnelId));
}

export async function getTunnelLatencySeries(
  tunnelId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880;
  return db
    .select({
      latencyMs: tunnelLatencyStats.latencyMs,
      isTimeout: tunnelLatencyStats.isTimeout,
      recordedAt: tunnelLatencyStats.recordedAt,
    })
    .from(tunnelLatencyStats)
    .where(and(eq(tunnelLatencyStats.tunnelId, tunnelId), gte(tunnelLatencyStats.recordedAt, since)))
    .orderBy(asc(tunnelLatencyStats.recordedAt))
    .limit(limit);
}

export async function insertForwardGroupLatencyStat(stat: InsertForwardGroupLatencyStat) {
  const db = await getDb();
  if (!db) return;
  await db.insert(forwardGroupLatencyStats).values(stat);
}

export async function getForwardGroupLatencySeries(
  groupId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880;
  return db
    .select({
      latencyMs: forwardGroupLatencyStats.latencyMs,
      isTimeout: forwardGroupLatencyStats.isTimeout,
      recordedAt: forwardGroupLatencyStats.recordedAt,
    })
    .from(forwardGroupLatencyStats)
    .where(and(eq(forwardGroupLatencyStats.groupId, groupId), gte(forwardGroupLatencyStats.recordedAt, since)))
    .orderBy(asc(forwardGroupLatencyStats.recordedAt))
    .limit(limit);
}

export async function getTcpingSeriesByRule(
  ruleId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 2880; // 24h * 120 per hour max
  const childRows = await db
    .select({
      id: forwardRules.id,
      groupId: forwardRules.forwardGroupId,
      parentId: forwardRules.forwardGroupRuleId,
    })
    .from(forwardRules)
    .where(and(eq(forwardRules.forwardGroupRuleId, ruleId), eq(forwardRules.pendingDelete, false)))
    .orderBy(asc(forwardRules.id));
  if (childRows.length > 0) {
    const groupModeById = await getForwardGroupModeMap((childRows as any[]).map((row: any) => Number(row.groupId || 0)));
    const chainChildren = (childRows as any[]).filter((row: any) => groupModeById.get(Number(row.groupId || 0)) === "chain");
    if (chainChildren.length > 0) {
      const childIds = chainChildren.map((row: any) => Number(row.id)).filter((id: number) => id > 0);
      const rawRows = await db
        .select({
          ruleId: tcpingStats.ruleId,
          latencyMs: tcpingStats.latencyMs,
          isTimeout: tcpingStats.isTimeout,
          recordedAt: tcpingStats.recordedAt,
        })
        .from(tcpingStats)
        .where(sql`${tcpingStats.ruleId} IN (${sql.join(childIds.map((id) => sql`${id}`), sql`, `)}) AND ${tcpingStats.recordedAt} >= ${since}`)
        .orderBy(asc(tcpingStats.recordedAt))
        .limit(Math.max(limit * childIds.length, limit));
      const bucketMs = 30_000;
      const byBucket = new Map<number, { latencyMs: number; timeoutCount: number; count: number; recordedAt: Date }>();
      for (const row of rawRows as any[]) {
        const at = new Date(row.recordedAt);
        const key = Math.floor(at.getTime() / bucketMs) * bucketMs;
        const prev = byBucket.get(key) || { latencyMs: 0, timeoutCount: 0, count: 0, recordedAt: at };
        if (row.isTimeout || row.latencyMs === null || row.latencyMs === undefined) {
          prev.timeoutCount += 1;
        } else {
          prev.latencyMs += Number(row.latencyMs) || 0;
        }
        prev.count += 1;
        if (at.getTime() > new Date(prev.recordedAt).getTime()) prev.recordedAt = at;
        byBucket.set(key, prev);
      }
      return Array.from(byBucket.entries())
        .sort((a, b) => a[0] - b[0])
        .slice(-limit)
        .map(([, bucket]) => ({
          latencyMs: bucket.timeoutCount > 0 || bucket.count < childIds.length ? null : bucket.latencyMs,
          isTimeout: bucket.timeoutCount > 0 || bucket.count < childIds.length,
          recordedAt: bucket.recordedAt,
        }));
    }
  }
  const rows = await db
    .select({
      latencyMs: tcpingStats.latencyMs,
      isTimeout: tcpingStats.isTimeout,
      recordedAt: tcpingStats.recordedAt,
    })
    .from(tcpingStats)
    .where(and(eq(tcpingStats.ruleId, ruleId), gte(tcpingStats.recordedAt, since)))
    .orderBy(asc(tcpingStats.recordedAt))
    .limit(limit);
  return rows;
}

/** 获取全局 TCPing 延迟序列（所有规则的平均延迟，按时间分桶） */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;

  const conds: any[] = [gte(tcpingStats.recordedAt, since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conds.push(sql`${tcpingStats.ruleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)})`);
  }

  const bucketExpr = sql.raw(`(FLOOR(recordedAt / ${bucketSec}) * ${bucketSec})`);

  const rows = await db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      avgLatency: sql<number>`COALESCE(AVG(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      maxLatency: sql<number>`COALESCE(MAX(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      minLatency: sql<number>`COALESCE(MIN(CASE WHEN ${tcpingStats.isTimeout} = 0 AND ${tcpingStats.latencyMs} IS NOT NULL THEN ${tcpingStats.latencyMs} END), 0)`,
      timeoutCount: sql<number>`SUM(CASE WHEN ${tcpingStats.isTimeout} = 1 THEN 1 ELSE 0 END)`,
      totalCount: sql<number>`COUNT(*)`,
    })
    .from(tcpingStats)
    .where(and(...conds))
    .groupBy(bucketExpr)
    .orderBy(asc(bucketExpr));

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    avgLatency: Math.round(Number(r.avgLatency) || 0),
    maxLatency: Number(r.maxLatency) || 0,
    minLatency: Number(r.minLatency) || 0,
    timeoutCount: Number(r.timeoutCount) || 0,
    totalCount: Number(r.totalCount) || 0,
  }));
}

/** 清理过期的 TCPing 数据（保留最近 N 小时） */
export async function cleanOldTcpingStats(retainHours: number = 48) {
  const db = await getDb();
  if (!db) return;
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await db.delete(tcpingStats).where(sql`${tcpingStats.recordedAt} < ${cutoff}`);
  await db.delete(forwardGroupLatencyStats).where(sql`${forwardGroupLatencyStats.recordedAt} < ${cutoff}`);
}

export type TimedOutForwardTest = {
  id: number;
  ruleId: number;
  hostId: number;
  message: string | null;
};

export async function timeoutStaleForwardTests(ttlSeconds: number = 60): Promise<TimedOutForwardTest[]> {
  const db = await getDb();
  if (!db) return [];
  const cutoffSec = Math.floor((Date.now() - ttlSeconds * 1000) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const staleTests = await queryRaw<TimedOutForwardTest>(
    `SELECT id, ruleId, hostId, message
     FROM forward_tests
     WHERE status IN ('pending', 'running')
       AND updatedAt < ?`,
    [cutoffSec],
  );
  if (staleTests.length === 0) return [];
  const messageExpr = getDatabaseKind() === "sqlite"
    ? "('自测超时：Agent 未在' || ? || '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')"
    : "CONCAT('自测超时：Agent 未在', ?, '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')";
  const ids = staleTests.map((test) => Number(test.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const info: any = await executeRaw(
    `UPDATE forward_tests
     SET status = 'timeout',
         message = COALESCE(NULLIF(message, ''), ${messageExpr}),
         updatedAt = ?
     WHERE id IN (${placeholders})
       AND status IN ('pending', 'running')
       AND updatedAt < ?`,
    [ttlSeconds, nowSec, ...ids, cutoffSec],
  );
  const changed = Number(info?.affectedRows ?? info?.changes ?? 0);
  if (changed <= 0) return [];
  return queryRaw<TimedOutForwardTest>(
    `SELECT id, ruleId, hostId, message
     FROM forward_tests
     WHERE id IN (${placeholders})
       AND status = 'timeout'
       AND updatedAt = ?`,
    [...ids, nowSec],
  );
}

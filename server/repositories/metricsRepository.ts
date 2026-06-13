import { and, asc, desc, eq, sql } from "drizzle-orm";
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
import { executeRaw, getDb, getDatabaseKind, nowDate, queryRaw, rawAffectedRows, quoteDbIdentifier } from "../dbRuntime";
import { clampPositiveInt, epochSeconds, sqlBool } from "./repositoryUtils";
import { getSetting, setSetting } from "./settingsRepository";

const TRAFFIC_BUCKET_MINUTES = 30;
const TRAFFIC_BUCKET_SECONDS = TRAFFIC_BUCKET_MINUTES * 60;
const TRAFFIC_BUCKET_BACKFILL_MARKER = "v2";
const TRAFFIC_BUCKET_BACKFILL_SETTING = "trafficStatBucketsBackfilled";
let trafficBucketUpsertWarned = false;

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const n = Number(value || 0);
  return new Date(n * 1000);
}

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function numeric(value: unknown) {
  return Number(value) || 0;
}

function trafficBucketFor(seconds: number, bucketSeconds: number) {
  return Math.floor(seconds / bucketSeconds) * bucketSeconds;
}

function bucketStartFor(seconds: number) {
  return trafficBucketFor(seconds, TRAFFIC_BUCKET_SECONDS);
}

function intCastSql(expr: string) {
  return getDatabaseKind() === "mysql" ? `CAST(${expr} AS SIGNED)` : `CAST(${expr} AS INTEGER)`;
}

function bucketExprSql(alias: string, bucketSec: number) {
  const q = quoteDbIdentifier;
  const divided = getDatabaseKind() === "sqlite"
    ? `(${alias}.${q("recordedAt")} / ${bucketSec})`
    : `FLOOR(${alias}.${q("recordedAt")} / ${bucketSec})`;
  return `${intCastSql(divided)} * ${bucketSec}`;
}

function rawBoolSql(value: boolean) {
  return getDatabaseKind() === "postgresql" ? (value ? "TRUE" : "FALSE") : (value ? "1" : "0");
}

function warnTrafficBucketOnce(error: unknown) {
  if (trafficBucketUpsertWarned) return;
  trafficBucketUpsertWarned = true;
  console.warn("[TrafficSummary] Bucket update skipped:", error instanceof Error ? error.message : String(error));
}

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

export async function insertTrafficStat(stat: InsertTrafficStat, options: { userId?: number } = {}) {
  const db = await getDb();
  if (!db) return;
  await db.insert(trafficStats).values(stat);
  const ruleId = Number(stat.ruleId);
  const hostId = Number(stat.hostId);
  const bytesIn = numeric(stat.bytesIn);
  const bytesOut = numeric(stat.bytesOut);
  const connections = Math.max(0, Math.floor(numeric(stat.connections)));
  if (ruleId <= 0 || hostId <= 0 || (bytesIn <= 0 && bytesOut <= 0 && connections <= 0)) return;
  try {
    const userId = Number(options.userId || 0) || await getRuleUserId(ruleId);
    if (userId > 0) {
      await upsertTrafficStatBucket({
        ruleId,
        hostId,
        userId,
        bytesIn,
        bytesOut,
        connections,
        recordedAt: stat.recordedAt instanceof Date ? stat.recordedAt : nowDate(),
      });
    }
  } catch (error) {
    warnTrafficBucketOnce(error);
  }
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  const rule = await getRuleWithCreatedAt(ruleId);
  const q = quoteDbIdentifier;
  const conditions = [`${q("ruleId")} = ?`];
  const params: any[] = [ruleId];
  if (rule?.createdAt) {
    conditions.push(`${q("recordedAt")} >= ?`);
    params.push(epochSeconds(rule.createdAt));
  }
  params.push(clampPositiveInt(limit, 60, 500));
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("ruleId")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("recordedAt")}
       FROM ${q("traffic_stats")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${q("recordedAt")} DESC
      LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    recordedAt: rowDate(row.recordedAt),
  }));
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

async function getRuleUserId(ruleId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ userId: forwardRules.userId })
    .from(forwardRules)
    .where(eq(forwardRules.id, ruleId))
    .limit(1);
  return Number((rows[0] as any)?.userId || 0);
}

let trafficBucketsReadyState: boolean | null = null;

async function trafficBucketsReady() {
  if (trafficBucketsReadyState !== null) return trafficBucketsReadyState;
  trafficBucketsReadyState = (await getSetting(TRAFFIC_BUCKET_BACKFILL_SETTING).catch(() => null)) === TRAFFIC_BUCKET_BACKFILL_MARKER;
  return trafficBucketsReadyState;
}

async function upsertTrafficStatBucket(input: {
  ruleId: number;
  hostId: number;
  userId: number;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  recordedAt: Date;
}) {
  const kind = getDatabaseKind();
  const q = quoteDbIdentifier;
  const table = q("traffic_stat_buckets");
  const cols = ["bucketStart", "bucketMinutes", "userId", "ruleId", "hostId", "bytesIn", "bytesOut", "connections", "updatedAt"];
  const recordedSec = epochSeconds(input.recordedAt);
  const nowSec = epochSeconds(nowDate());
  const values = [
    bucketStartFor(recordedSec),
    TRAFFIC_BUCKET_MINUTES,
    input.userId,
    input.ruleId,
    input.hostId,
    input.bytesIn,
    input.bytesOut,
    input.connections,
    nowSec,
  ];
  if (kind === "mysql") {
    await executeRaw(
      `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE
         ${q("userId")} = VALUES(${q("userId")}),
         ${q("bytesIn")} = ${q("bytesIn")} + VALUES(${q("bytesIn")}),
         ${q("bytesOut")} = ${q("bytesOut")} + VALUES(${q("bytesOut")}),
         ${q("connections")} = ${q("connections")} + VALUES(${q("connections")}),
         ${q("updatedAt")} = VALUES(${q("updatedAt")})`,
      values,
    );
    return;
  }
  const excluded = kind === "postgresql" ? "EXCLUDED" : "excluded";
  await executeRaw(
    `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
     ON CONFLICT (${q("bucketStart")}, ${q("bucketMinutes")}, ${q("ruleId")}, ${q("hostId")})
     DO UPDATE SET
       ${q("userId")} = ${excluded}.${q("userId")},
       ${q("bytesIn")} = ${q("bytesIn")} + ${excluded}.${q("bytesIn")},
       ${q("bytesOut")} = ${q("bytesOut")} + ${excluded}.${q("bytesOut")},
       ${q("connections")} = ${q("connections")} + ${excluded}.${q("connections")},
       ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`,
    values,
  );
}

export async function ensureTrafficStatBucketsBackfilled(options: { force?: boolean; logger?: Pick<typeof console, "info" | "warn"> } = {}) {
  const db = await getDb();
  const logger = options.logger ?? console;
  if (!db) return { skipped: true, rows: 0 };
  const marker = await getSetting(TRAFFIC_BUCKET_BACKFILL_SETTING).catch(() => null);
  if (!options.force && marker === TRAFFIC_BUCKET_BACKFILL_MARKER) {
    trafficBucketsReadyState = true;
    logger.info?.(`[TrafficSummary] Bucket backfill already completed marker=${TRAFFIC_BUCKET_BACKFILL_MARKER}; skipping`);
    return { skipped: true, rows: 0 };
  }
  const startedAt = Date.now();
  const q = quoteDbIdentifier;
  const bucketSql = bucketExprSql("ts", TRAFFIC_BUCKET_SECONDS);
  await executeRaw(`DELETE FROM ${q("traffic_stat_buckets")}`);
  const result = await executeRaw(
    `INSERT INTO ${q("traffic_stat_buckets")}
       (${q("bucketStart")}, ${q("bucketMinutes")}, ${q("userId")}, ${q("ruleId")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("updatedAt")})
     SELECT ${bucketSql} AS ${q("bucketStart")},
            ? AS ${q("bucketMinutes")},
            fr.${q("userId")} AS ${q("userId")},
            ts.${q("ruleId")} AS ${q("ruleId")},
            ts.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")},
            ? AS ${q("updatedAt")}
       FROM ${q("traffic_stats")} ts
       INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
      GROUP BY ${bucketSql}, fr.${q("userId")}, ts.${q("ruleId")}, ts.${q("hostId")}`,
    [TRAFFIC_BUCKET_MINUTES, epochSeconds(nowDate())],
  );
  const rows = rawAffectedRows(result);
  await setSetting(TRAFFIC_BUCKET_BACKFILL_SETTING, TRAFFIC_BUCKET_BACKFILL_MARKER);
  await setSetting("trafficStatBucketsBackfilledAt", String(epochSeconds(nowDate())));
  trafficBucketsReadyState = true;
  logger.info?.(`[TrafficSummary] Bucket backfill complete marker=${TRAFFIC_BUCKET_BACKFILL_MARKER} rows=${rows} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, rows };
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

function mapTrafficSummaryRows(rows: any[]): TrafficSummaryRow[] {
  return rows.map((r: any) => ({
    ruleId: Number(r.ruleId),
    hostId: Number(r.hostId),
    bytesIn: numeric(r.bytesIn),
    bytesOut: numeric(r.bytesOut),
    connections: numeric(r.connections),
  })).filter((row) => row.ruleId > 0 && row.hostId > 0);
}

async function getTrafficSummaryRowsFromBuckets(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
  ruleIds?: number[];
}) {
  if (!await trafficBucketsReady()) return null;
  const q = quoteDbIdentifier;
  const conditions = [`b.${q("bucketMinutes")} = ?`];
  const params: any[] = [TRAFFIC_BUCKET_MINUTES];
  if (opts.hostId) {
    conditions.push(`b.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.since) {
    conditions.push(`b.${q("bucketStart")} >= ?`);
    params.push(bucketStartFor(epochSeconds(opts.since)));
  }
  if (opts.userId) {
    conditions.push(`b.${q("userId")} = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    conditions.push(`b.${q("ruleId")} IN (${opts.ruleIds.map(() => "?").join(",")})`);
    params.push(...opts.ruleIds);
  }
  const rows = await queryRaw<TrafficSummaryRow>(
    `SELECT b.${q("ruleId")} AS ${q("ruleId")},
            b.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")}
       FROM ${q("traffic_stat_buckets")} b
      WHERE ${conditions.join(" AND ")}
      GROUP BY b.${q("ruleId")}, b.${q("hostId")}`,
    params,
  ).catch(() => null);
  if (!rows) return null;
  const mapped = mapTrafficSummaryRows(rows as any[]);
  return mapped.length > 0 ? mapped : null;
}

async function getTrafficSummaryRowsFromStats(opts: {
  userId?: number;
  hostId?: number;
  since?: Date;
  ruleIds?: number[];
}) {
  const q = quoteDbIdentifier;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hostId) {
    conditions.push(`ts.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.since) {
    conditions.push(`ts.${q("recordedAt")} >= ?`);
    params.push(epochSeconds(opts.since));
  }
  if (opts.userId) {
    conditions.push(`fr.${q("userId")} = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    conditions.push(`ts.${q("ruleId")} IN (${opts.ruleIds.map(() => "?").join(",")})`);
    params.push(...opts.ruleIds);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await queryRaw<TrafficSummaryRow>(
    `SELECT ts.${q("ruleId")} AS ${q("ruleId")},
            ts.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")}
       FROM ${q("traffic_stats")} ts
       INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
      ${where}
      GROUP BY ts.${q("ruleId")}, ts.${q("hostId")}`,
    params,
  );
  return mapTrafficSummaryRows(rows as any[]);
}

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
  const q = quoteDbIdentifier;
  if (await trafficBucketsReady()) {
    const where = userId ? `WHERE ${q("userId")} = ?` : "";
    const rows = await queryRaw<{ totalIn: number; totalOut: number }>(
      `SELECT COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("totalIn")},
              COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("totalOut")}
         FROM ${q("traffic_stat_buckets")}
        ${where}`,
      userId ? [userId] : [],
    ).catch(() => []);
    if (rows.length > 0) {
      return {
        totalIn: numeric(rows[0]?.totalIn),
        totalOut: numeric(rows[0]?.totalOut),
      };
    }
  }

  if (userId) {
    const r = await db.select({
      totalIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
      totalOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
    }).from(trafficStats)
      .innerJoin(forwardRules, eq(forwardRules.id, trafficStats.ruleId))
      .where(eq(forwardRules.userId, userId));
    const row = r[0];
    return {
      totalIn: Number(row?.totalIn) || 0,
      totalOut: Number(row?.totalOut) || 0,
    };
  }

  const r = await db.select({
    totalIn: sql<number>`COALESCE(SUM(${trafficStats.bytesIn}), 0)`,
    totalOut: sql<number>`COALESCE(SUM(${trafficStats.bytesOut}), 0)`,
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
  includeLatency?: boolean;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number; latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | null }>;
  const requestedRuleIds = Array.from(new Set((opts.ruleIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  let result: TrafficSummaryRow[] =
    await getTrafficSummaryRowsFromBuckets({ ...opts, ruleIds: requestedRuleIds }) ??
    await getTrafficSummaryRowsFromStats({ ...opts, ruleIds: requestedRuleIds });

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
  if (opts.includeLatency === false) {
    return result.map((item) => ({
      ...item,
      latestLatencyMs: null,
      latestLatencyIsTimeout: false,
      latestLatencyAt: null,
    }));
  }

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
      .where(sql`${forwardRules.forwardGroupRuleId} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`)
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
  const q = quoteDbIdentifier;
  const latestRows = latencyRuleIds.length > 0
    ? await queryRaw<any>(
      `SELECT s.${q("ruleId")} AS ${q("ruleId")},
              s.${q("latencyMs")} AS ${q("latencyMs")},
              s.${q("isTimeout")} AS ${q("isTimeout")},
              s.${q("recordedAt")} AS ${q("recordedAt")}
         FROM ${q("tcping_stats")} s
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("recordedAt")}) AS ${q("recordedAt")}
             FROM ${q("tcping_stats")}
            WHERE ${q("ruleId")} IN (${latencyRuleIds.map(() => "?").join(",")})
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = s.${q("ruleId")} AND latest.${q("recordedAt")} = s.${q("recordedAt")}
        ORDER BY s.${q("recordedAt")} DESC`,
      latencyRuleIds,
    )
    : [];
  const latestByRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    row.isTimeout = rowBool(row.isTimeout);
    row.recordedAt = rowDate(row.recordedAt);
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

  const q = quoteDbIdentifier;
  const useBuckets = bucket === TRAFFIC_BUCKET_MINUTES && await trafficBucketsReady();
  const rows = useBuckets
    ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT b.${q("bucketStart")} AS ${q("bucket")},
              COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stat_buckets")} b
        WHERE b.${q("bucketMinutes")} = ?
          AND b.${q("ruleId")} = ?
          AND b.${q("bucketStart")} >= ?
        GROUP BY b.${q("bucketStart")}
        ORDER BY b.${q("bucketStart")} ASC`,
      [TRAFFIC_BUCKET_MINUTES, ruleId, bucketStartFor(sinceSec)],
    ).catch(() => [])
    : await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
              COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stats")} ts
        WHERE ts.${q("ruleId")} = ?
          AND ts.${q("recordedAt")} >= ?
        GROUP BY ${bucketExprSql("ts", bucketSec)}
        ORDER BY ${q("bucket")} ASC`,
      [ruleId, sinceSec],
    );

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
  const sinceSec = epochSeconds(since);
  const nowSec = epochSeconds(nowDate());
  const startBucketSec = Math.floor(sinceSec / bucketSec) * bucketSec;
  const endBucketSec = Math.floor(nowSec / bucketSec) * bucketSec;
  const q = quoteDbIdentifier;
  const trafficTable = q("traffic_stats");
  const rulesTable = q("forward_rules");
  const canUseBuckets = bucket === TRAFFIC_BUCKET_MINUTES && await trafficBucketsReady();
  const rows = canUseBuckets
    ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
      `SELECT b.${q("bucketStart")} AS ${q("bucket")},
              COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")}
         FROM ${q("traffic_stat_buckets")} b
        WHERE b.${q("bucketMinutes")} = ?
          AND b.${q("bucketStart")} >= ?
          ${opts.userId ? `AND b.${q("userId")} = ?` : ""}
        GROUP BY b.${q("bucketStart")}
        ORDER BY b.${q("bucketStart")} ASC`,
      opts.userId ? [TRAFFIC_BUCKET_MINUTES, startBucketSec, opts.userId] : [TRAFFIC_BUCKET_MINUTES, startBucketSec],
    ).catch(() => [])
    : opts.userId
      ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
        `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
                COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")}
           FROM ${trafficTable} ts
           INNER JOIN ${rulesTable} fr ON fr.${q("id")} = ts.${q("ruleId")}
          WHERE ts.${q("recordedAt")} >= ? AND fr.${q("userId")} = ?
          GROUP BY ${bucketExprSql("ts", bucketSec)}
          ORDER BY ${q("bucket")} ASC`,
        [sinceSec, opts.userId],
      )
      : await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number }>(
        `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
                COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")}
           FROM ${trafficTable} ts
          WHERE ts.${q("recordedAt")} >= ?
          GROUP BY ${bucketExprSql("ts", bucketSec)}
          ORDER BY ${q("bucket")} ASC`,
        [sinceSec],
      );

  if (rows.length === 0) return [];

  const byBucket = new Map<number, { bytesIn: number; bytesOut: number }>();
  for (const row of rows as any[]) {
    const bucketValue = Number(row.bucket);
    if (!Number.isFinite(bucketValue)) continue;
    byBucket.set(bucketValue, {
      bytesIn: Number(row.bytesIn) || 0,
      bytesOut: Number(row.bytesOut) || 0,
    });
  }

  const result: Array<{ bucket: Date; bytesIn: number; bytesOut: number }> = [];
  for (let bucketValue = startBucketSec; bucketValue <= endBucketSec; bucketValue += bucketSec) {
    const point = byBucket.get(bucketValue);
    result.push({
      bucket: new Date(bucketValue * 1000),
      bytesIn: point?.bytesIn ?? 0,
      bytesOut: point?.bytesOut ?? 0,
    });
  }
  return result;
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
  const updates: any = {
    lastLatencyMs: stat.isTimeout ? null : (stat.latencyMs ?? null),
    updatedAt: nowDate(),
  };
  if (options.message !== undefined) {
    updates.lastTestStatus = status;
    updates.lastTestMessage = options.message;
    updates.lastTestAt = nowDate();
  }
  await db.update(tunnels).set(updates).where(eq(tunnels.id, stat.tunnelId));
}

export async function getTunnelLatencySeries(
  tunnelId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 2880, 10_000);
  const q = quoteDbIdentifier;
  const startedAt = Date.now();
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; recordedAt: unknown }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("tunnel_latency_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      LIMIT ?`,
    [tunnelId, epochSeconds(since), limit],
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[TunnelLatency] slow tunnel=${tunnelId} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
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
  const limit = clampPositiveInt(opts.limit, 2880, 10_000);
  const q = quoteDbIdentifier;
  const startedAt = Date.now();
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; recordedAt: unknown }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("forward_group_latency_stats")}
      WHERE ${q("groupId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      LIMIT ?`,
    [groupId, epochSeconds(since), limit],
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[ForwardGroupLatency] slow group=${groupId} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function getTcpingSeriesByRule(
  ruleId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 2880, 10_000); // 24h * 120 per hour max
  const q = quoteDbIdentifier;
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
      const rawRows = await queryRaw<any>(
        `SELECT ${q("ruleId")}, ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
           FROM ${q("tcping_stats")}
         WHERE ${q("ruleId")} IN (${childIds.map(() => "?").join(",")})
           AND ${q("recordedAt")} >= ?
          ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
          LIMIT ?`,
        [...childIds, epochSeconds(since), Math.max(limit * childIds.length, limit)],
      );
      const bucketMs = 30_000;
      const byBucket = new Map<number, { latencyMs: number; timeoutCount: number; count: number; recordedAt: Date }>();
      for (const row of (rawRows as any[]).reverse()) {
        const at = rowDate(row.recordedAt);
        const key = Math.floor(at.getTime() / bucketMs) * bucketMs;
        const prev = byBucket.get(key) || { latencyMs: 0, timeoutCount: 0, count: 0, recordedAt: at };
        if (rowBool(row.isTimeout) || row.latencyMs === null || row.latencyMs === undefined) {
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
  const rows = await queryRaw<any>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("tcping_stats")}
      WHERE ${q("ruleId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      LIMIT ?`,
    [ruleId, epochSeconds(since), limit],
  );
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
}

/** 获取全局 TCPing 延迟序列（所有规则的平均延迟，按时间分桶） */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;
  const q = quoteDbIdentifier;
  const conditions = [`s.${q("recordedAt")} >= ?`];
  const params: any[] = [epochSeconds(since)];
  if (opts.userId) {
    const ruleIds = await getRuleIdsByUser(opts.userId);
    if (ruleIds.length === 0) return [];
    conditions.push(`s.${q("ruleId")} IN (${ruleIds.map(() => "?").join(",")})`);
    params.push(...ruleIds);
  }
  const bucketExpr = bucketExprSql("s", bucketSec);
  const rows = await queryRaw<any>(
    `SELECT ${bucketExpr} AS ${q("bucket")},
            COALESCE(AVG(CASE WHEN s.${q("isTimeout")} = ${rawBoolSql(false)} AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("avgLatency")},
            COALESCE(MAX(CASE WHEN s.${q("isTimeout")} = ${rawBoolSql(false)} AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("maxLatency")},
            COALESCE(MIN(CASE WHEN s.${q("isTimeout")} = ${rawBoolSql(false)} AND s.${q("latencyMs")} IS NOT NULL THEN s.${q("latencyMs")} END), 0) AS ${q("minLatency")},
            SUM(CASE WHEN s.${q("isTimeout")} = ${rawBoolSql(true)} THEN 1 ELSE 0 END) AS ${q("timeoutCount")},
            COUNT(*) AS ${q("totalCount")}
       FROM ${q("tcping_stats")} s
      WHERE ${conditions.join(" AND ")}
      GROUP BY ${bucketExpr}
      ORDER BY ${q("bucket")} ASC`,
    params,
  );

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
    `SELECT ${quoteDbIdentifier("id")}, ${quoteDbIdentifier("ruleId")}, ${quoteDbIdentifier("hostId")}, ${quoteDbIdentifier("message")}
     FROM ${quoteDbIdentifier("forward_tests")}
     WHERE ${quoteDbIdentifier("status")} IN ('pending', 'running')
       AND ${quoteDbIdentifier("updatedAt")} < ?`,
    [cutoffSec],
  );
  if (staleTests.length === 0) return [];
  const kind = getDatabaseKind();
  const messageExpr = kind === "mysql"
    ? "CONCAT('自测超时：Agent 未在', ?, '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')"
    : "('自测超时：Agent 未在' || ? || '秒内上报结果，请检查 Agent 是否在线或已升级到最新版本')";
  const ids = staleTests.map((test) => Number(test.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const info: any = await executeRaw(
    `UPDATE ${quoteDbIdentifier("forward_tests")}
     SET ${quoteDbIdentifier("status")} = 'timeout',
         ${quoteDbIdentifier("message")} = COALESCE(NULLIF(${quoteDbIdentifier("message")}, ''), ${messageExpr}),
         ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("id")} IN (${placeholders})
       AND ${quoteDbIdentifier("status")} IN ('pending', 'running')
       AND ${quoteDbIdentifier("updatedAt")} < ?`,
    [ttlSeconds, nowSec, ...ids, cutoffSec],
  );
  const changed = rawAffectedRows(info);
  if (changed <= 0) return [];
  return queryRaw<TimedOutForwardTest>(
    `SELECT ${quoteDbIdentifier("id")}, ${quoteDbIdentifier("ruleId")}, ${quoteDbIdentifier("hostId")}, ${quoteDbIdentifier("message")}
     FROM ${quoteDbIdentifier("forward_tests")}
     WHERE ${quoteDbIdentifier("id")} IN (${placeholders})
       AND ${quoteDbIdentifier("status")} = 'timeout'
       AND ${quoteDbIdentifier("updatedAt")} = ?`,
    [...ids, nowSec],
  );
}

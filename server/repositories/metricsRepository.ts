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
import { executeRaw, getDb, getDatabaseKind, nowDate, queryRaw, rawAffectedRows } from "../dbRuntime";
import { boolLiteral, bucketExpression, limitOffset, quoteIdentifier } from "../dbCompat";
import { clampPositiveInt, epochSeconds, sqlBool } from "./repositoryUtils";
import { getSetting, setSetting } from "./settingsRepository";
import { appendPanelLog } from "../_core/panelLogger";

const TRAFFIC_BUCKET_MINUTES = 30;
const TRAFFIC_BUCKET_SECONDS = TRAFFIC_BUCKET_MINUTES * 60;
const TRAFFIC_BUCKET_RETENTION_HOURS = 72;
const TRAFFIC_BUCKET_BACKFILL_MARKER = "v2";
const TRAFFIC_BUCKET_BACKFILL_SETTING = "trafficStatBucketsBackfilled";
const TRAFFIC_BILLING_RULE_USAGE_BACKFILL_SETTING = "traffic-billing-rule-usage-v1";
const USER_TRAFFIC_COUNTER_BACKFILL_SETTING = "user-traffic-counters-v1";
let trafficBucketUpsertWarned = false;
let userTrafficCounterUpsertWarned = false;

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

function bucketExprSql(alias: string, bucketSec: number) {
  return bucketExpression(alias, "recordedAt", bucketSec);
}

function rawBoolSql(value: boolean) {
  return boolLiteral(value);
}

function warnTrafficBucketOnce(error: unknown, context?: { ruleId?: number; hostId?: number; userId?: number }) {
  if (trafficBucketUpsertWarned) return;
  trafficBucketUpsertWarned = true;
  const details = [
    context?.ruleId ? `rule=${context.ruleId}` : "",
    context?.hostId ? `host=${context.hostId}` : "",
    context?.userId ? `user=${context.userId}` : "",
  ].filter(Boolean).join(" ");
  console.warn(`[TrafficSummary] Bucket update skipped${details ? ` ${details}` : ""}:`, error instanceof Error ? error.message : String(error));
}

function warnUserTrafficCounterOnce(error: unknown, context?: { ruleId?: number; userId?: number }) {
  if (userTrafficCounterUpsertWarned) return;
  userTrafficCounterUpsertWarned = true;
  const details = [
    context?.ruleId ? `rule=${context.ruleId}` : "",
    context?.userId ? `user=${context.userId}` : "",
  ].filter(Boolean).join(" ");
  console.warn(`[TrafficCounter] User counter update skipped${details ? ` ${details}` : ""}:`, error instanceof Error ? error.message : String(error));
}

function retentionCutoffSeconds(retainHours: number) {
  const hours = Math.max(1, Math.floor(Number(retainHours) || 0));
  return Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
}

async function upsertUserTrafficCounter(input: { userId: number; bytesIn: number; bytesOut: number; connections: number }) {
  const userId = Number(input.userId || 0);
  if (!Number.isInteger(userId) || userId <= 0) return;
  const bytesIn = nonNegativeCounter(input.bytesIn);
  const bytesOut = nonNegativeCounter(input.bytesOut);
  const connections = Math.max(0, Math.floor(numeric(input.connections)));
  if (bytesIn <= 0 && bytesOut <= 0 && connections <= 0) return;
  const kind = getDatabaseKind();
  const q = quoteIdentifier;
  const table = q("user_traffic_counters");
  const nowSec = epochSeconds(nowDate());
  const cols = ["userId", "bytesIn", "bytesOut", "connections", "createdAt", "updatedAt"];
  const values = [userId, bytesIn, bytesOut, connections, nowSec, nowSec];
  if (kind === "mysql") {
    await executeRaw(
      `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE
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
     ON CONFLICT (${q("userId")})
     DO UPDATE SET
       ${q("bytesIn")} = ${q("bytesIn")} + ${excluded}.${q("bytesIn")},
       ${q("bytesOut")} = ${q("bytesOut")} + ${excluded}.${q("bytesOut")},
       ${q("connections")} = ${q("connections")} + ${excluded}.${q("connections")},
       ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`,
    values,
  );
}

async function upsertForwardRuleTrafficCounter(input: { ruleId: number; hostId: number; userId: number; bytesIn: number; bytesOut: number; connections: number }) {
  const ruleId = Number(input.ruleId || 0);
  const hostId = Number(input.hostId || 0);
  const userId = Number(input.userId || 0);
  if (!Number.isInteger(ruleId) || ruleId <= 0 || !Number.isInteger(hostId) || hostId <= 0 || !Number.isInteger(userId) || userId <= 0) return;
  const bytesIn = nonNegativeCounter(input.bytesIn);
  const bytesOut = nonNegativeCounter(input.bytesOut);
  const connections = Math.max(0, Math.floor(numeric(input.connections)));
  if (bytesIn <= 0 && bytesOut <= 0 && connections <= 0) return;
  const kind = getDatabaseKind();
  const q = quoteIdentifier;
  const table = q("forward_rule_traffic_counters");
  const nowSec = epochSeconds(nowDate());
  const cols = ["ruleId", "hostId", "userId", "bytesIn", "bytesOut", "connections", "createdAt", "updatedAt"];
  const values = [ruleId, hostId, userId, bytesIn, bytesOut, connections, nowSec, nowSec];
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
     ON CONFLICT (${q("ruleId")}, ${q("hostId")})
     DO UPDATE SET
       ${q("userId")} = ${excluded}.${q("userId")},
       ${q("bytesIn")} = ${q("bytesIn")} + ${excluded}.${q("bytesIn")},
       ${q("bytesOut")} = ${q("bytesOut")} + ${excluded}.${q("bytesOut")},
       ${q("connections")} = ${q("connections")} + ${excluded}.${q("connections")},
       ${q("updatedAt")} = ${excluded}.${q("updatedAt")}`,
    values,
  );
}

function canUseTrafficBuckets(since?: Date) {
  if (!since) return false;
  return epochSeconds(since) >= retentionCutoffSeconds(TRAFFIC_BUCKET_RETENTION_HOURS);
}

// ==================== Host Metrics Queries ====================

export async function insertHostMetric(metric: InsertHostMetric) {
  const db = await getDb();
  if (!db) return;
  await db.insert(hostMetrics).values(metric);
}

export async function cleanOldHostMetrics(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("host_metrics")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
}

export async function getLatestHostMetrics(hostId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(hostMetrics).where(eq(hostMetrics.hostId, hostId)).orderBy(desc(hostMetrics.recordedAt)).limit(limit);
}

export async function getLatestHostMetricRows(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  const q = quoteIdentifier;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await queryRaw<any>(
    `SELECT ranked.${q("id")},
            ranked.${q("hostId")},
            ranked.${q("cpuUsage")},
            ranked.${q("memoryUsage")},
            ranked.${q("memoryUsed")},
            ranked.${q("swapUsage")},
            ranked.${q("swapUsed")},
            ranked.${q("swapTotal")},
            ranked.${q("networkIn")},
            ranked.${q("networkOut")},
            ranked.${q("diskUsage")},
            ranked.${q("diskUsed")},
            ranked.${q("diskTotal")},
            ranked.${q("uptime")},
            ranked.${q("recordedAt")},
            ranked.rn
       FROM (
         SELECT hm.${q("id")},
                hm.${q("hostId")},
                hm.${q("cpuUsage")},
                hm.${q("memoryUsage")},
                hm.${q("memoryUsed")},
                hm.${q("swapUsage")},
                hm.${q("swapUsed")},
                hm.${q("swapTotal")},
                hm.${q("networkIn")},
                hm.${q("networkOut")},
                hm.${q("diskUsage")},
                hm.${q("diskUsed")},
                hm.${q("diskTotal")},
                hm.${q("uptime")},
                hm.${q("recordedAt")},
                ROW_NUMBER() OVER (
                  PARTITION BY hm.${q("hostId")}
                  ORDER BY hm.${q("recordedAt")} DESC, hm.${q("id")} DESC
                ) AS rn
           FROM ${q("host_metrics")} hm
          WHERE hm.${q("hostId")} IN (${placeholders})
       ) ranked
      WHERE ranked.rn <= 2
      ORDER BY ranked.${q("hostId")} ASC, ranked.rn ASC`,
    ids,
  ).catch(() => []);
  const mapped = (rows as any[])
    .map((row) => ({
      id: Number(row?.id || 0),
      hostId: Number(row?.hostId || 0),
      cpuUsage: row?.cpuUsage == null ? null : numeric(row.cpuUsage),
      memoryUsage: row?.memoryUsage == null ? null : numeric(row.memoryUsage),
      memoryUsed: row?.memoryUsed == null ? null : numeric(row.memoryUsed),
      swapUsage: row?.swapUsage == null ? null : numeric(row.swapUsage),
      swapUsed: row?.swapUsed == null ? null : numeric(row.swapUsed),
      swapTotal: row?.swapTotal == null ? null : numeric(row.swapTotal),
      networkIn: row?.networkIn == null ? null : numeric(row.networkIn),
      networkOut: row?.networkOut == null ? null : numeric(row.networkOut),
      diskUsage: row?.diskUsage == null ? null : numeric(row.diskUsage),
      diskUsed: row?.diskUsed == null ? null : numeric(row.diskUsed),
      diskTotal: row?.diskTotal == null ? null : numeric(row.diskTotal),
      uptime: row?.uptime == null ? null : numeric(row.uptime),
      recordedAt: rowDate(row?.recordedAt),
      rn: Math.max(1, Math.floor(Number(row?.rn || 0))),
    }))
    .filter((row) => row.hostId > 0);
  const byHost = new Map<number, typeof mapped>();
  for (const row of mapped) {
    const bucket = byHost.get(row.hostId);
    if (bucket) bucket.push(row);
    else byHost.set(row.hostId, [row]);
  }
  return Array.from(byHost.values()).map((bucket) => {
    const sorted = bucket.sort((a, b) => a.rn - b.rn);
    const latest = sorted[0];
    const previous = sorted[1];
    if (!latest) return null;
    let networkSpeedIn: number | null = null;
    let networkSpeedOut: number | null = null;
    if (latest && previous) {
      const elapsedSeconds = Math.max(1, (latest.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000);
      networkSpeedIn = Math.max(0, numeric(latest.networkIn) - numeric(previous.networkIn)) / elapsedSeconds;
      networkSpeedOut = Math.max(0, numeric(latest.networkOut) - numeric(previous.networkOut)) / elapsedSeconds;
    }
    return {
      ...latest,
      networkSpeedIn,
      networkSpeedOut,
    };
  }).filter(Boolean);
}

type LatestHostMetricSnapshot = {
  id: number;
  hostId: number;
  networkIn: number;
  networkOut: number;
  recordedAt: Date;
  rn: number;
};

function mapLatestHostMetricSnapshot(row: any): LatestHostMetricSnapshot {
  return {
    id: Number(row?.id || 0),
    hostId: Number(row?.hostId || 0),
    networkIn: numeric(row?.networkIn),
    networkOut: numeric(row?.networkOut),
    recordedAt: rowDate(row?.recordedAt),
    rn: Math.max(1, Math.floor(Number(row?.rn || 0))),
  };
}

export async function getLatestHostMetricSnapshots(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [] as LatestHostMetricSnapshot[];
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  const q = quoteIdentifier;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await queryRaw<any>(
    `SELECT ranked.${q("id")},
            ranked.${q("hostId")},
            ranked.${q("networkIn")},
            ranked.${q("networkOut")},
            ranked.${q("recordedAt")},
            ranked.rn
       FROM (
         SELECT hm.${q("id")},
                hm.${q("hostId")},
                hm.${q("networkIn")},
                hm.${q("networkOut")},
                hm.${q("recordedAt")},
                ROW_NUMBER() OVER (
                  PARTITION BY hm.${q("hostId")}
                  ORDER BY hm.${q("recordedAt")} DESC, hm.${q("id")} DESC
                ) AS rn
           FROM ${q("host_metrics")} hm
          WHERE hm.${q("hostId")} IN (${placeholders})
       ) ranked
      WHERE ranked.rn <= 2
      ORDER BY ranked.${q("hostId")} ASC, ranked.rn ASC`,
    ids,
  ).catch(() => []);
  return (rows as any[]).map(mapLatestHostMetricSnapshot).filter((row) => row.hostId > 0);
}

export function summarizeHostInstantTraffic(rows: LatestHostMetricSnapshot[]) {
  const byHost = new Map<number, LatestHostMetricSnapshot[]>();
  for (const row of rows) {
    const bucket = byHost.get(row.hostId);
    if (bucket) {
      bucket.push(row);
    } else {
      byHost.set(row.hostId, [row]);
    }
  }

  let currentTrafficIn = 0;
  let currentTrafficOut = 0;
  let measuredHosts = 0;

  for (const bucket of byHost.values()) {
    if (bucket.length < 2) continue;
    const [latest, previous] = bucket;
    const elapsedSeconds = Math.max(1, (new Date(latest.recordedAt).getTime() - new Date(previous.recordedAt).getTime()) / 1000);
    const inDelta = Math.max(0, Number(latest.networkIn || 0) - Number(previous.networkIn || 0));
    const outDelta = Math.max(0, Number(latest.networkOut || 0) - Number(previous.networkOut || 0));
    currentTrafficIn += inDelta / elapsedSeconds;
    currentTrafficOut += outDelta / elapsedSeconds;
    if (inDelta > 0 || outDelta > 0) measuredHosts += 1;
  }

  return {
    currentTrafficIn,
    currentTrafficOut,
    currentTrafficTotal: currentTrafficIn + currentTrafficOut,
    measuredHosts,
  };
}


type HostTrafficSample = {
  bytesIn?: number;
  bytesOut?: number;
  reportedAt?: Date;
};

function nonNegativeCounter(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function hostTrafficDelta(current: number, previous: number | null) {
  if (previous === null) return 0;
  return current >= previous ? current - previous : 0;
}

function nullableRowDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (value instanceof Date) return value;
  return new Date(n * 1000);
}

function zeroHostTraffic(hostId: number) {
  return {
    id: 0,
    hostId,
    bytesIn: 0,
    bytesOut: 0,
    lastSystemIn: null as number | null,
    lastSystemOut: null as number | null,
    lastDeltaIn: 0,
    lastDeltaOut: 0,
    lastReportedAt: null as Date | null,
    resetAt: null as Date | null,
    createdAt: null as Date | null,
    updatedAt: null as Date | null,
  };
}

function mapHostTrafficRow(row: any, fallbackHostId = 0) {
  const hostId = Number(row?.hostId || fallbackHostId || 0);
  return {
    id: Number(row?.id || 0),
    hostId,
    bytesIn: nonNegativeCounter(row?.bytesIn),
    bytesOut: nonNegativeCounter(row?.bytesOut),
    lastSystemIn: row?.lastSystemIn === null || row?.lastSystemIn === undefined ? null : nonNegativeCounter(row.lastSystemIn),
    lastSystemOut: row?.lastSystemOut === null || row?.lastSystemOut === undefined ? null : nonNegativeCounter(row.lastSystemOut),
    lastDeltaIn: nonNegativeCounter(row?.lastDeltaIn),
    lastDeltaOut: nonNegativeCounter(row?.lastDeltaOut),
    lastReportedAt: nullableRowDate(row?.lastReportedAt),
    resetAt: nullableRowDate(row?.resetAt),
    createdAt: nullableRowDate(row?.createdAt),
    updatedAt: nullableRowDate(row?.updatedAt),
  };
}

async function getHostTrafficRow(hostId: number) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("lastSystemIn")}, ${q("lastSystemOut")}, ${q("lastDeltaIn")}, ${q("lastDeltaOut")}, ${q("lastReportedAt")}, ${q("resetAt")}, ${q("createdAt")}, ${q("updatedAt")}
       FROM ${q("host_traffic_counters")}
      WHERE ${q("hostId")} = ?
      LIMIT 1`,
    [hostId],
  ).catch(() => []);
  return rows[0] || null;
}

export async function recordHostTrafficSample(hostId: number, sample: HostTrafficSample) {
  const db = await getDb();
  if (!db) return null;
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const systemIn = nonNegativeCounter(sample.bytesIn);
  const systemOut = nonNegativeCounter(sample.bytesOut);
  const now = sample.reportedAt || nowDate();
  const nowSec = epochSeconds(now);
  const q = quoteIdentifier;
  const table = q("host_traffic_counters");
  const existing = await getHostTrafficRow(id);
  const prevIn = existing?.lastSystemIn === null || existing?.lastSystemIn === undefined ? null : nonNegativeCounter(existing.lastSystemIn);
  const prevOut = existing?.lastSystemOut === null || existing?.lastSystemOut === undefined ? null : nonNegativeCounter(existing.lastSystemOut);
  const deltaIn = hostTrafficDelta(systemIn, prevIn);
  const deltaOut = hostTrafficDelta(systemOut, prevOut);
  const counterReset = (prevIn !== null && systemIn < prevIn) || (prevOut !== null && systemOut < prevOut);
  if (counterReset) {
    appendPanelLog(
      "warn",
      `[HostTraffic] counter baseline reset host=${id} prevIn=${prevIn ?? "-"} nextIn=${systemIn} prevOut=${prevOut ?? "-"} nextOut=${systemOut}`,
    );
  }

  if (existing) {
    await executeRaw(
      `UPDATE ${table}
          SET ${q("bytesIn")} = ${q("bytesIn")} + ?,
              ${q("bytesOut")} = ${q("bytesOut")} + ?,
              ${q("lastSystemIn")} = ?,
              ${q("lastSystemOut")} = ?,
              ${q("lastDeltaIn")} = ?,
              ${q("lastDeltaOut")} = ?,
              ${q("lastReportedAt")} = ?,
              ${q("updatedAt")} = ?
        WHERE ${q("hostId")} = ?`,
      [deltaIn, deltaOut, systemIn, systemOut, deltaIn, deltaOut, nowSec, nowSec, id],
    );
    return getHostTraffic(id);
  }

  const cols = ["hostId", "bytesIn", "bytesOut", "lastSystemIn", "lastSystemOut", "lastDeltaIn", "lastDeltaOut", "lastReportedAt", "createdAt", "updatedAt"];
  await executeRaw(
    `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    [id, 0, 0, systemIn, systemOut, 0, 0, nowSec, nowSec, nowSec],
  ).catch(async () => {
    await executeRaw(
      `UPDATE ${table}
          SET ${q("lastSystemIn")} = ?,
              ${q("lastSystemOut")} = ?,
              ${q("lastReportedAt")} = ?,
              ${q("updatedAt")} = ?
        WHERE ${q("hostId")} = ?`,
      [systemIn, systemOut, nowSec, nowSec, id],
    );
  });
  return getHostTraffic(id);
}

export async function getHostTraffic(hostId: number) {
  const db = await getDb();
  if (!db) return zeroHostTraffic(Number(hostId) || 0);
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return zeroHostTraffic(0);
  const row = await getHostTrafficRow(id);
  return row ? mapHostTrafficRow(row, id) : zeroHostTraffic(id);
}

export async function getHostTrafficSummary(hostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const hasHostFilter = Array.isArray(hostIds);
  const ids = Array.from(new Set((hostIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (hasHostFilter && ids.length === 0) return [];
  const q = quoteIdentifier;
  const where = hasHostFilter ? `WHERE ${q("hostId")} IN (${ids.map(() => "?").join(",")})` : "";
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("lastSystemIn")}, ${q("lastSystemOut")}, ${q("lastDeltaIn")}, ${q("lastDeltaOut")}, ${q("lastReportedAt")}, ${q("resetAt")}, ${q("createdAt")}, ${q("updatedAt")}
       FROM ${q("host_traffic_counters")}
      ${where}
      ORDER BY ${q("hostId")} ASC`,
    ids,
  ).catch(() => []);
  const mapped = (rows as any[]).map((row) => mapHostTrafficRow(row));
  if (!hasHostFilter) return mapped;
  const byHost = new Map(mapped.map((row) => [row.hostId, row]));
  return ids.map((id) => byHost.get(id) || zeroHostTraffic(id));
}

export async function resetHostTraffic(hostId: number) {
  const db = await getDb();
  if (!db) return zeroHostTraffic(Number(hostId) || 0);
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return zeroHostTraffic(0);
  const nowSec = epochSeconds(nowDate());
  const q = quoteIdentifier;
  const table = q("host_traffic_counters");
  const existing = await getHostTrafficRow(id);
  if (existing) {
    await executeRaw(
      `UPDATE ${table}
          SET ${q("bytesIn")} = 0,
              ${q("bytesOut")} = 0,
              ${q("lastDeltaIn")} = 0,
              ${q("lastDeltaOut")} = 0,
              ${q("resetAt")} = ?,
              ${q("updatedAt")} = ?
        WHERE ${q("hostId")} = ?`,
      [nowSec, nowSec, id],
    );
    return getHostTraffic(id);
  }
  const cols = ["hostId", "bytesIn", "bytesOut", "lastDeltaIn", "lastDeltaOut", "resetAt", "createdAt", "updatedAt"];
  await executeRaw(
    `INSERT INTO ${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    [id, 0, 0, 0, 0, nowSec, nowSec, nowSec],
  ).catch(() => undefined);
  return getHostTraffic(id);
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
  let userId = Number(options.userId || 0) || 0;
  if (userId <= 0) userId = await getRuleUserId(ruleId);
  if (userId > 0) {
    try {
      await upsertUserTrafficCounter({ userId, bytesIn, bytesOut, connections });
      await upsertForwardRuleTrafficCounter({ ruleId, hostId, userId, bytesIn, bytesOut, connections });
    } catch (error) {
      warnUserTrafficCounterOnce(error, { ruleId, userId });
    }
  }
  try {
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
    warnTrafficBucketOnce(error, { ruleId, hostId, userId: userId || undefined });
  }
}

export async function cleanOldTrafficStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const billingBackfilled = await getSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_SETTING).catch(() => null);
  if (!billingBackfilled) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("traffic_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
}

async function tableRowCount(tableName: string) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(
    `SELECT COUNT(*) AS ${q("count")} FROM ${q(tableName)}`,
  ).catch(() => []);
  return Number(rows[0]?.count || 0);
}

async function getCounterUserIdsForRuleIds(ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const result = new Set<number>();
  if (ids.length === 0) return [];
  const q = quoteIdentifier;
  for (let index = 0; index < ids.length; index += 500) {
    const batch = ids.slice(index, index + 500);
    const rows = await queryRaw<any>(
      `SELECT DISTINCT ${q("userId")} FROM ${q("forward_rule_traffic_counters")}
        WHERE ${q("ruleId")} IN (${batch.map(() => "?").join(",")})`,
      batch,
    ).catch(() => []);
    for (const row of rows as any[]) {
      const userId = Number(row.userId || 0);
      if (Number.isInteger(userId) && userId > 0) result.add(userId);
    }
  }
  return Array.from(result);
}

async function rebuildUserTrafficCountersFromRuleCounters(userIds?: number[]) {
  const ids = Array.from(new Set((userIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  if (ids.length > 0) {
    await executeRaw(
      `DELETE FROM ${q("user_traffic_counters")}
        WHERE ${q("userId")} IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
  } else {
    await executeRaw(`DELETE FROM ${q("user_traffic_counters")}`);
  }
  const where = ids.length > 0
    ? `WHERE ${q("userId")} IN (${ids.map(() => "?").join(",")})`
    : "";
  const result = await executeRaw(
    `INSERT INTO ${q("user_traffic_counters")}
       (${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
     SELECT ${q("userId")} AS ${q("userId")},
            COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(${q("connections")}), 0) AS ${q("connections")},
            ? AS ${q("createdAt")},
            ? AS ${q("updatedAt")}
       FROM ${q("forward_rule_traffic_counters")}
      ${where}
      GROUP BY ${q("userId")}`,
    [nowSec, nowSec, ...ids],
  );
  return rawAffectedRows(result);
}

export async function getTrafficStats(ruleId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];
  const rule = await getRuleWithCreatedAt(ruleId);
  const { queryRuleIds, parentByChildRuleId } = await expandTrafficQueryRuleIds([ruleId]);
  const effectiveRuleIds = queryRuleIds.length > 0 ? queryRuleIds : [ruleId];
  const q = quoteIdentifier;
  const conditions = [`${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})`];
  const params: any[] = [...effectiveRuleIds];
  if (rule?.createdAt) {
    conditions.push(`${q("recordedAt")} >= ?`);
    params.push(epochSeconds(rule.createdAt));
  }
  const limitSql = limitOffset(clampPositiveInt(limit, 60, 500));
  const rows = await queryRaw<any>(
    `SELECT ${q("id")}, ${q("ruleId")}, ${q("hostId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("recordedAt")}
       FROM ${q("traffic_stats")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${q("recordedAt")} DESC
      ${limitSql.sql}`,
    [...params, ...limitSql.params],
  );
  return rows.map((row) => ({
    ...row,
    ruleId: parentByChildRuleId.get(Number(row.ruleId)) || Number(row.ruleId),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function resetRuleTrafficStats(ruleIds: number[]) {
  const db = await getDb();
  if (!db) return { requestedRuleIds: [], clearedRuleIds: [], deletedStats: 0, deletedBuckets: 0, deletedCounters: 0, deletedTcping: 0, deletedForwardTests: 0, deletedGroupLatency: 0 };
  const requestedRuleIds = Array.from(new Set(ruleIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (requestedRuleIds.length === 0) {
    return { requestedRuleIds: [], clearedRuleIds: [], deletedStats: 0, deletedBuckets: 0, deletedCounters: 0, deletedTcping: 0, deletedForwardTests: 0, deletedGroupLatency: 0 };
  }
  const { queryRuleIds } = await expandTrafficQueryRuleIds(requestedRuleIds);
  const clearedRuleIds = queryRuleIds.length > 0 ? queryRuleIds : requestedRuleIds;
  const q = quoteIdentifier;
  const affectedCounterUserIds = await getCounterUserIdsForRuleIds(clearedRuleIds);
  let deletedStats = 0;
  let deletedBuckets = 0;
  let deletedCounters = 0;
  let deletedTcping = 0;
  let deletedForwardTests = 0;
  let deletedGroupLatency = 0;
  for (let index = 0; index < clearedRuleIds.length; index += 500) {
    const batch = clearedRuleIds.slice(index, index + 500);
    const placeholders = batch.map(() => "?").join(",");
    const statsResult = await executeRaw(
      `DELETE FROM ${q("traffic_stats")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const bucketsResult = await executeRaw(
      `DELETE FROM ${q("traffic_stat_buckets")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const countersResult = await executeRaw(
      `DELETE FROM ${q("forward_rule_traffic_counters")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const tcpingResult = await executeRaw(
      `DELETE FROM ${q("tcping_stats")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    const forwardTestsResult = await executeRaw(
      `DELETE FROM ${q("forward_tests")} WHERE ${q("ruleId")} IN (${placeholders})`,
      batch,
    );
    deletedStats += rawAffectedRows(statsResult);
    deletedBuckets += rawAffectedRows(bucketsResult);
    deletedCounters += rawAffectedRows(countersResult);
    deletedTcping += rawAffectedRows(tcpingResult);
    deletedForwardTests += rawAffectedRows(forwardTestsResult);
  }
  if (affectedCounterUserIds.length > 0) {
    await rebuildUserTrafficCountersFromRuleCounters(affectedCounterUserIds).catch((error) => {
      console.warn("[TrafficCounter] User counter rebuild after rule reset skipped:", error instanceof Error ? error.message : String(error));
    });
  }
  if (clearedRuleIds.length > 0) {
    const forwardGroupIds = Array.from(new Set((await queryRaw<any>(
      `SELECT DISTINCT ${q("forwardGroupId")} AS ${q("forwardGroupId")}
         FROM ${q("forward_rules")}
        WHERE ${q("id")} IN (${clearedRuleIds.map(() => "?").join(",")})
          AND ${q("forwardGroupId")} IS NOT NULL`,
      clearedRuleIds,
    )).map((row: any) => Number(row.forwardGroupId)).filter((id: number) => Number.isInteger(id) && id > 0)));
    for (let index = 0; index < forwardGroupIds.length; index += 500) {
      const batch = forwardGroupIds.slice(index, index + 500);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      const groupLatencyResult = await executeRaw(
        `DELETE FROM ${q("forward_group_latency_stats")} WHERE ${q("groupId")} IN (${placeholders})`,
        batch,
      );
      deletedGroupLatency += rawAffectedRows(groupLatencyResult);
    }
  }
  return {
    requestedRuleIds,
    clearedRuleIds,
    deletedStats,
    deletedBuckets,
    deletedCounters,
    deletedTcping,
    deletedForwardTests,
    deletedGroupLatency,
  };
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
  const q = quoteIdentifier;
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

export async function cleanOldTrafficStatBuckets(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  const safeCutoff = Math.max(0, cutoff - TRAFFIC_BUCKET_SECONDS);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("traffic_stat_buckets")}
      WHERE ${quoteIdentifier("bucketMinutes")} = ?
        AND ${quoteIdentifier("bucketStart")} < ?`,
    [TRAFFIC_BUCKET_MINUTES, safeCutoff],
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
  const q = quoteIdentifier;
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

export async function ensureUserTrafficCountersBackfilled(options: { force?: boolean; logger?: Pick<typeof console, "info" | "warn"> } = {}) {
  const db = await getDb();
  const logger = options.logger ?? console;
  if (!db) return { skipped: true, rows: 0 };
  const marker = await getSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING).catch(() => null);
  if (!options.force && marker === "v1") {
    logger.info?.("[TrafficCounter] User/rule counter backfill already completed; skipping");
    return { skipped: true, rows: 0 };
  }
  const existingCounterRows = await tableRowCount("forward_rule_traffic_counters");
  if (!options.force && existingCounterRows > 0) {
    const rebuiltUserRows = await rebuildUserTrafficCountersFromRuleCounters().catch((error) => {
      logger.warn?.("[TrafficCounter] User counter rebuild from existing rule counters skipped:", error instanceof Error ? error.message : String(error));
      return 0;
    });
    await setSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING, "v1");
    logger.info?.(`[TrafficCounter] Existing cumulative counters detected rows=${existingCounterRows}; preserving`);
    return { skipped: true, rows: existingCounterRows + rebuiltUserRows };
  }

  const startedAt = Date.now();
  const q = quoteIdentifier;
  const nowSec = epochSeconds(nowDate());
  await executeRaw(`DELETE FROM ${q("forward_rule_traffic_counters")}`);
  await executeRaw(`DELETE FROM ${q("user_traffic_counters")}`);

  let ruleRows = 0;
  const statRows = await tableRowCount("traffic_stats");
  if (statRows > 0) {
    const result = await executeRaw(
      `INSERT INTO ${q("forward_rule_traffic_counters")}
         (${q("ruleId")}, ${q("hostId")}, ${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
       SELECT ts.${q("ruleId")} AS ${q("ruleId")},
              ts.${q("hostId")} AS ${q("hostId")},
              fr.${q("userId")} AS ${q("userId")},
              COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")},
              ? AS ${q("createdAt")},
              ? AS ${q("updatedAt")}
         FROM ${q("traffic_stats")} ts
         INNER JOIN ${q("forward_rules")} fr ON fr.${q("id")} = ts.${q("ruleId")}
        GROUP BY ts.${q("ruleId")}, ts.${q("hostId")}, fr.${q("userId")}`,
      [nowSec, nowSec],
    );
    ruleRows = rawAffectedRows(result);
  } else {
    const bucketRows = await tableRowCount("traffic_stat_buckets");
    if (bucketRows > 0) {
      const result = await executeRaw(
        `INSERT INTO ${q("forward_rule_traffic_counters")}
           (${q("ruleId")}, ${q("hostId")}, ${q("userId")}, ${q("bytesIn")}, ${q("bytesOut")}, ${q("connections")}, ${q("createdAt")}, ${q("updatedAt")})
         SELECT b.${q("ruleId")} AS ${q("ruleId")},
                b.${q("hostId")} AS ${q("hostId")},
                b.${q("userId")} AS ${q("userId")},
                COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
                COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
                COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")},
                ? AS ${q("createdAt")},
                ? AS ${q("updatedAt")}
           FROM ${q("traffic_stat_buckets")} b
          WHERE b.${q("bucketMinutes")} = ?
          GROUP BY b.${q("ruleId")}, b.${q("hostId")}, b.${q("userId")}`,
        [nowSec, nowSec, TRAFFIC_BUCKET_MINUTES],
      );
      ruleRows = rawAffectedRows(result);
    }
  }
  const userRows = await rebuildUserTrafficCountersFromRuleCounters();
  await setSetting(USER_TRAFFIC_COUNTER_BACKFILL_SETTING, "v1");
  await setSetting("userTrafficCountersBackfilledAt", String(epochSeconds(nowDate())));
  logger.info?.(`[TrafficCounter] User/rule counter backfill complete ruleRows=${ruleRows} userRows=${userRows} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, rows: ruleRows + userRows };
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
  if (opts.since && !canUseTrafficBuckets(opts.since)) return null;
  const q = quoteIdentifier;
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
  const q = quoteIdentifier;
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

async function getChainGroupIdForTemplateRule(ruleId: number) {
  const db = await getDb();
  const id = Number(ruleId || 0);
  if (!db || !Number.isInteger(id) || id <= 0) return null;
  const rows = await db
    .select({
      forwardGroupId: forwardRules.forwardGroupId,
      groupMode: forwardGroups.groupMode,
    })
    .from(forwardRules)
    .innerJoin(forwardGroups, eq(forwardGroups.id, forwardRules.forwardGroupId))
    .where(and(
      eq(forwardRules.id, id),
      eq(forwardRules.pendingDelete, false),
      eq(forwardGroups.groupMode, "chain"),
    ))
    .limit(1);
  const groupId = Number((rows as any[])[0]?.forwardGroupId || 0);
  return groupId > 0 ? groupId : null;
}

type ForwardGroupTrafficChildRow = {
  id: number;
  parentId: number;
  groupId: number;
  memberId: number;
  hostId: number;
};

async function getFirstEnabledMemberByGroup(groupIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(groupIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const map = new Map<number, { id: number; priority: number }>();
  if (!db || ids.length === 0) return map;
  const rows = await db
    .select({
      id: forwardGroupMembers.id,
      groupId: forwardGroupMembers.groupId,
      priority: forwardGroupMembers.priority,
    })
    .from(forwardGroupMembers)
    .where(sql`${forwardGroupMembers.groupId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}`);
  for (const row of rows as any[]) {
    const groupId = Number(row.groupId || 0);
    const id = Number(row.id || 0);
    if (groupId <= 0 || id <= 0) continue;
    const priority = Number(row.priority || 0);
    const prev = map.get(groupId);
    if (!prev || priority < prev.priority || (priority === prev.priority && id < prev.id)) {
      map.set(groupId, { id, priority });
    }
  }
  return map;
}

async function getForwardGroupTrafficChildRows(parentRuleIds: number[]) {
  const db = await getDb();
  const parentIds = Array.from(new Set(parentRuleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (!db || parentIds.length === 0) return [] as ForwardGroupTrafficChildRow[];
  const rows = await db
    .select({
      id: forwardRules.id,
      parentId: forwardRules.forwardGroupRuleId,
      groupId: forwardRules.forwardGroupId,
      memberId: forwardRules.forwardGroupMemberId,
      hostId: forwardRules.hostId,
    })
    .from(forwardRules)
    .where(sql`${forwardRules.forwardGroupRuleId} IN (${sql.join(parentIds.map((id) => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`);
  const childRows = (rows as any[]).map((row) => ({
    id: Number(row.id || 0),
    parentId: Number(row.parentId || 0),
    groupId: Number(row.groupId || 0),
    memberId: Number(row.memberId || 0),
    hostId: Number(row.hostId || 0),
  })).filter((row) => row.id > 0 && row.parentId > 0);
  const groupModeById = await getForwardGroupModeMap(childRows.map((row) => row.groupId));
  const chainGroupIds = childRows
    .filter((row) => groupModeById.get(row.groupId) === "chain")
    .map((row) => row.groupId);
  const firstMemberByGroup = await getFirstEnabledMemberByGroup(chainGroupIds);
  return childRows.filter((row) => {
    if (groupModeById.get(row.groupId) !== "chain") return true;
    return Number(firstMemberByGroup.get(row.groupId)?.id || 0) === row.memberId;
  });
}

async function expandTrafficQueryRuleIds(ruleIds: number[]) {
  const requestedRuleIds = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (requestedRuleIds.length === 0) {
    return { queryRuleIds: [] as number[], parentByChildRuleId: new Map<number, number>() };
  }
  const childRows = await getForwardGroupTrafficChildRows(requestedRuleIds);
  const parentByChildRuleId = new Map<number, number>();
  for (const row of childRows) {
    parentByChildRuleId.set(row.id, row.parentId);
  }
  return {
    queryRuleIds: Array.from(new Set([...requestedRuleIds, ...childRows.map((row) => row.id)])),
    parentByChildRuleId,
  };
}

async function getTrafficSummaryRowsFromCounters(opts: {
  userId?: number;
  hostId?: number;
  ruleIds?: number[];
}) {
  const q = quoteIdentifier;
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.hostId) {
    conditions.push(`c.${q("hostId")} = ?`);
    params.push(opts.hostId);
  }
  if (opts.userId) {
    conditions.push(`c.${q("userId")} = ?`);
    params.push(opts.userId);
  }
  if (opts.ruleIds?.length) {
    conditions.push(`c.${q("ruleId")} IN (${opts.ruleIds.map(() => "?").join(",")})`);
    params.push(...opts.ruleIds);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await queryRaw<TrafficSummaryRow>(
    `SELECT c.${q("ruleId")} AS ${q("ruleId")},
            c.${q("hostId")} AS ${q("hostId")},
            COALESCE(SUM(c.${q("bytesIn")}), 0) AS ${q("bytesIn")},
            COALESCE(SUM(c.${q("bytesOut")}), 0) AS ${q("bytesOut")},
            COALESCE(SUM(c.${q("connections")}), 0) AS ${q("connections")}
       FROM ${q("forward_rule_traffic_counters")} c
      ${where}
      GROUP BY c.${q("ruleId")}, c.${q("hostId")}`,
    params,
  ).catch(() => [] as TrafficSummaryRow[]);
  return mapTrafficSummaryRows(rows as any[]);
}

async function normalizeTrafficSummaryRowsForRules(
  rows: TrafficSummaryRow[],
  opts: { userId?: number; hostId?: number },
  requestedRuleIds: number[],
) {
  const db = await getDb();
  if (!db) return rows;
  let result = rows;
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
    const firstChainMemberByGroup = new Map<number, number>();
    if (chainMemberRows.length > 0) {
      const groupIds = Array.from(new Set(chainMemberRows.map((row: any) => Number(row.groupId || 0)).filter((id: number) => id > 0)));
      if (groupIds.length > 0) {
        const memberRows = await db
          .select({
            id: forwardGroupMembers.id,
            groupId: forwardGroupMembers.groupId,
            priority: forwardGroupMembers.priority,
            isEnabled: forwardGroupMembers.isEnabled,
          })
          .from(forwardGroupMembers)
          .where(sql`${forwardGroupMembers.groupId} IN (${sql.join(groupIds.map((id) => sql`${id}`), sql`, `)})`);
        for (const row of memberRows as any[]) {
          if (!rowBool((row as any).isEnabled)) continue;
          const groupId = Number((row as any).groupId || 0);
          const previousId = firstChainMemberByGroup.get(groupId);
          if (!previousId) {
            firstChainMemberByGroup.set(groupId, Number(row.id));
            continue;
          }
          const previous = (memberRows as any[]).find((item: any) => Number(item.id) === previousId);
          if (Number((row as any).priority || 0) < Number(previous?.priority || 0)) {
            firstChainMemberByGroup.set(groupId, Number(row.id));
          }
        }
      }
    }
    const parentByChild = new Map<number, { parentId: number; hostId: number }>();
    for (const row of childRows as any[]) {
      const groupMode = groupModeById.get(Number(row.groupId || 0));
      if (groupMode === "chain" && Number(firstChainMemberByGroup.get(Number(row.groupId || 0)) || 0) !== Number(row.memberId || 0)) {
        continue;
      }
      parentByChild.set(Number(row.id), { parentId: Number(row.parentId), hostId: Number(row.hostId) });
    }
    if (parentByChild.size > 0) {
      const merged = new Map<string, TrafficSummaryRow>();
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
    const requestedRows = await db
      .select({
        id: forwardRules.id,
        hostId: forwardRules.hostId,
        sourcePort: forwardRules.sourcePort,
        userId: forwardRules.userId,
      })
      .from(forwardRules)
      .where(and(...requestedConds));
    visibleRequestedRows = (requestedRows as any[]).map((row) => ({
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

  return result;
}

function withEmptyTrafficLatency(rows: TrafficSummaryRow[]) {
  return rows.map((item) => ({
    ...item,
    latestLatencyMs: null as number | null,
    latestLatencyIsTimeout: false,
    latestLatencyAt: null as Date | null,
  }));
}

export async function getTotalTraffic(userId?: number) {
  const db = await getDb();
  if (!db) return { totalIn: 0, totalOut: 0 };
  const q = quoteIdentifier;
  if (userId) {
    const rows = await queryRaw<any>(
      `SELECT COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("totalIn")},
              COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("totalOut")}
         FROM ${q("user_traffic_counters")}
        WHERE ${q("userId")} = ?`,
      [userId],
    ).catch(() => []);
    const row = rows[0];
    return {
      totalIn: Number(row?.totalIn) || 0,
      totalOut: Number(row?.totalOut) || 0,
    };
  }

  const rows = await queryRaw<any>(
    `SELECT COALESCE(SUM(${q("bytesIn")}), 0) AS ${q("totalIn")},
            COALESCE(SUM(${q("bytesOut")}), 0) AS ${q("totalOut")}
       FROM ${q("user_traffic_counters")}`,
  ).catch(() => []);
  const row = rows[0];
  return {
    totalIn: Number(row?.totalIn) || 0,
    totalOut: Number(row?.totalOut) || 0,
  };
}

/** Summarize cumulative traffic by rule from bounded counter rows. */
export async function getTrafficCounterSummaryByRule(opts: {
  userId?: number;
  hostId?: number;
  ruleIds?: number[];
  includeLatency?: boolean;
} = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ ruleId: number; hostId: number; bytesIn: number; bytesOut: number; connections: number; latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | null }>;
  const requestedRuleIds = Array.from(new Set((opts.ruleIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  const expandedRuleIds = requestedRuleIds.length > 0
    ? (await expandTrafficQueryRuleIds(requestedRuleIds)).queryRuleIds
    : requestedRuleIds;
  const rows = await getTrafficSummaryRowsFromCounters({ ...opts, ruleIds: expandedRuleIds });
  const result = await normalizeTrafficSummaryRowsForRules(rows, opts, requestedRuleIds);
  const output = withEmptyTrafficLatency(result);
  if (!opts.includeLatency || output.length === 0) return output;
  const latencyRuleIds = requestedRuleIds.length > 0
    ? requestedRuleIds
    : Array.from(new Set(output.map((row) => row.ruleId).filter((id) => id > 0)));
  if (latencyRuleIds.length === 0) return output;
  const latencyRows = await getTrafficSummaryByRule({
    userId: opts.userId,
    hostId: opts.hostId,
    ruleIds: latencyRuleIds,
    includeLatency: true,
  }).catch(() => [] as any[]);
  const latestByRuleId = new Map<number, { latestLatencyMs: number | null; latestLatencyIsTimeout: boolean; latestLatencyAt: Date | string | null }>();
  for (const row of latencyRows as any[]) {
    const ruleId = Number(row.ruleId || 0);
    if (ruleId <= 0) continue;
    const prev = latestByRuleId.get(ruleId);
    const prevAt = prev?.latestLatencyAt ? new Date(prev.latestLatencyAt).getTime() : 0;
    const nextAt = row.latestLatencyAt ? new Date(row.latestLatencyAt).getTime() : 0;
    if (!prev || nextAt >= prevAt) {
      latestByRuleId.set(ruleId, {
        latestLatencyMs: row.latestLatencyMs === null || row.latestLatencyMs === undefined ? null : Number(row.latestLatencyMs),
        latestLatencyIsTimeout: !!row.latestLatencyIsTimeout,
        latestLatencyAt: row.latestLatencyAt || null,
      });
    }
  }
  return output.map((row) => {
    const latency = latestByRuleId.get(row.ruleId);
    return latency ? { ...row, ...latency } : row;
  });
}

/** Summarize traffic by rule. */
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
  const expandedRuleIds = requestedRuleIds.length > 0
    ? (await expandTrafficQueryRuleIds(requestedRuleIds)).queryRuleIds
    : requestedRuleIds;
  const since = opts.since ?? new Date(Date.now() - TRAFFIC_BUCKET_RETENTION_HOURS * 60 * 60 * 1000);
  let result: TrafficSummaryRow[] =
    await getTrafficSummaryRowsFromBuckets({ ...opts, since, ruleIds: expandedRuleIds }) ??
    await getTrafficSummaryRowsFromStats({ ...opts, since, ruleIds: expandedRuleIds });
  result = await normalizeTrafficSummaryRowsForRules(result, opts, requestedRuleIds);

  if (result.length === 0) return withEmptyTrafficLatency(result);
  if (opts.includeLatency === false) {
    return withEmptyTrafficLatency(result);
  }

  const ruleIds = Array.from(new Set(result.map((r) => r.ruleId)));
  const ruleLatencyRows = ruleIds.length > 0
    ? await db
      .select({
        id: forwardRules.id,
        tunnelId: forwardRules.tunnelId,
      })
      .from(forwardRules)
      .where(sql`${forwardRules.id} IN (${sql.join(ruleIds.map(id => sql`${id}`), sql`, `)}) AND ${forwardRules.pendingDelete} = ${sqlBool(false)}`)
    : [];
  const tunnelRuleIds = new Set((ruleLatencyRows as any[])
    .filter((row: any) => Number(row.tunnelId || 0) > 0)
    .map((row: any) => Number(row.id)));
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
  const parentFailoverChildren = new Map<number, number[]>();
  const parentByChildRule = new Map<number, number>();
  const chainParentRuleIds = new Set<number>();
  for (const row of childLatencyRows as any[]) {
    const childId = Number(row.id);
    const parentId = Number(row.parentId);
    if (childId <= 0 || parentId <= 0) continue;
    if (latencyGroupModeById.get(Number(row.groupId || 0)) === "chain") {
      chainParentRuleIds.add(parentId);
      const children = parentChainChildren.get(parentId) || [];
      children.push(childId);
      parentChainChildren.set(parentId, children);
      continue;
    }
    parentByChildRule.set(childId, parentId);
    const children = parentFailoverChildren.get(parentId) || [];
    children.push(childId);
    parentFailoverChildren.set(parentId, children);
  }
  const latencyRuleIds = Array.from(new Set([
    ...ruleIds,
    ...Array.from(parentByChildRule.keys()),
    ...Array.from(parentChainChildren.values()).flat(),
  ]));
  const q = quoteIdentifier;
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
    const parentId = parentByChildRule.get(rowRuleId) || 0;
    if (!parentId && parentFailoverChildren.has(rowRuleId)) continue;
    if (parentId && parentFailoverChildren.has(parentId)) continue;
    const ruleId = parentId || rowRuleId;
    if (!latestByRule.has(ruleId)) latestByRule.set(ruleId, row);
  }
  const latestByRawRule = new Map<number, any>();
  for (const row of latestRows as any[]) {
    const rowRuleId = Number(row.ruleId);
    if (!latestByRawRule.has(rowRuleId)) latestByRawRule.set(rowRuleId, row);
  }
  for (const [parentId, childIds] of parentFailoverChildren.entries()) {
    let recordedAt: Date | null = null;
    const healthyLatencies: number[] = [];
    let hasAnyResult = false;
    for (const childId of childIds) {
      const latest = latestByRawRule.get(childId);
      if (!latest) continue;
      hasAnyResult = true;
      if (!recordedAt || new Date(latest.recordedAt).getTime() > new Date(recordedAt).getTime()) {
        recordedAt = latest.recordedAt;
      }
      if (!latest.isTimeout && latest.latencyMs !== null && latest.latencyMs !== undefined) {
        const latency = Number(latest.latencyMs);
        if (Number.isFinite(latency) && latency > 0) healthyLatencies.push(latency);
      }
    }
    if (healthyLatencies.length > 0) {
      latestByRule.set(parentId, {
        ruleId: parentId,
        latencyMs: Math.min(...healthyLatencies),
        isTimeout: false,
        recordedAt,
      });
    } else if (hasAnyResult) {
      latestByRule.set(parentId, {
        ruleId: parentId,
        latencyMs: null,
        isTimeout: true,
        recordedAt,
      });
    } else {
      latestByRule.delete(parentId);
    }
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
  const chainParentIds = Array.from(chainParentRuleIds);
  const latestChainTestRows = chainParentIds.length > 0
    ? await queryRaw<any>(
      `SELECT ft.${q("ruleId")} AS ${q("ruleId")},
              ft.${q("latencyMs")} AS ${q("latencyMs")},
              ft.${q("status")} AS ${q("status")},
              ft.${q("updatedAt")} AS ${q("updatedAt")},
              ft.${q("createdAt")} AS ${q("createdAt")}
         FROM ${q("forward_tests")} ft
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("updatedAt")}) AS ${q("updatedAt")}
             FROM ${q("forward_tests")}
            WHERE ${q("ruleId")} IN (${chainParentIds.map(() => "?").join(",")})
              AND ${q("status")} IN ('success', 'failed', 'timeout')
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = ft.${q("ruleId")} AND latest.${q("updatedAt")} = ft.${q("updatedAt")}
        ORDER BY ft.${q("updatedAt")} DESC, CASE WHEN ft.${q("message")} LIKE '%forward-chain-hop-summary%' THEN 0 ELSE 1 END, ft.${q("createdAt")} DESC`,
      chainParentIds,
    )
    : [];
  for (const row of latestChainTestRows as any[]) {
    const ruleId = Number(row.ruleId);
    if (!chainParentRuleIds.has(ruleId) || latestByRule.get(ruleId)?.source === "forward_test") continue;
    const status = String(row.status || "").toLowerCase();
    latestByRule.set(ruleId, {
      ruleId,
      latencyMs: status === "success" && row.latencyMs !== null && row.latencyMs !== undefined ? Number(row.latencyMs) : null,
      isTimeout: status !== "success",
      recordedAt: rowDate(row.updatedAt || row.createdAt),
      source: "forward_test",
    });
  }
  const tunnelRuleIdsForTests = Array.from(tunnelRuleIds);
  const latestTunnelTestRows = tunnelRuleIdsForTests.length > 0
    ? await queryRaw<any>(
      `SELECT ft.${q("ruleId")} AS ${q("ruleId")},
              ft.${q("latencyMs")} AS ${q("latencyMs")},
              ft.${q("status")} AS ${q("status")},
              ft.${q("updatedAt")} AS ${q("updatedAt")},
              ft.${q("createdAt")} AS ${q("createdAt")}
         FROM ${q("forward_tests")} ft
         INNER JOIN (
           SELECT ${q("ruleId")}, MAX(${q("updatedAt")}) AS ${q("updatedAt")}
             FROM ${q("forward_tests")}
            WHERE ${q("ruleId")} IN (${tunnelRuleIdsForTests.map(() => "?").join(",")})
              AND ${q("status")} IN ('success', 'failed', 'timeout')
              AND ${q("message")} LIKE '%"kind":"forward-via-tunnel"%'
            GROUP BY ${q("ruleId")}
         ) latest ON latest.${q("ruleId")} = ft.${q("ruleId")} AND latest.${q("updatedAt")} = ft.${q("updatedAt")}
        WHERE ft.${q("status")} IN ('success', 'failed', 'timeout')
          AND ft.${q("message")} LIKE '%"kind":"forward-via-tunnel"%'
        ORDER BY ft.${q("updatedAt")} DESC, ft.${q("createdAt")} DESC`,
      tunnelRuleIdsForTests,
    )
    : [];
  for (const row of latestTunnelTestRows as any[]) {
    const ruleId = Number(row.ruleId);
    if (!tunnelRuleIds.has(ruleId) || latestByRule.get(ruleId)?.source === "forward_test") continue;
    const status = String(row.status || "").toLowerCase();
    latestByRule.set(ruleId, {
      ruleId,
      latencyMs: status === "success" && row.latencyMs !== null && row.latencyMs !== undefined ? Number(row.latencyMs) : null,
      isTimeout: status !== "success",
      recordedAt: rowDate(row.updatedAt || row.createdAt),
      source: "forward_test",
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

/** Aggregate traffic series for one rule by time bucket. */
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
  const { queryRuleIds } = await expandTrafficQueryRuleIds([ruleId]);
  const effectiveRuleIds = queryRuleIds.length > 0 ? queryRuleIds : [ruleId];

  const q = quoteIdentifier;
  const useBuckets = bucket === TRAFFIC_BUCKET_MINUTES && await trafficBucketsReady() && canUseTrafficBuckets(since);
  const rows = useBuckets
    ? await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT b.${q("bucketStart")} AS ${q("bucket")},
              COALESCE(SUM(b.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(b.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(b.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stat_buckets")} b
        WHERE b.${q("bucketMinutes")} = ?
          AND b.${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})
          AND b.${q("bucketStart")} >= ?
        GROUP BY b.${q("bucketStart")}
        ORDER BY b.${q("bucketStart")} ASC`,
      [TRAFFIC_BUCKET_MINUTES, ...effectiveRuleIds, bucketStartFor(sinceSec)],
    ).catch(() => [])
    : await queryRaw<{ bucket: number; bytesIn: number; bytesOut: number; connections: number }>(
      `SELECT ${bucketExprSql("ts", bucketSec)} AS ${q("bucket")},
              COALESCE(SUM(ts.${q("bytesIn")}), 0) AS ${q("bytesIn")},
              COALESCE(SUM(ts.${q("bytesOut")}), 0) AS ${q("bytesOut")},
              COALESCE(SUM(ts.${q("connections")}), 0) AS ${q("connections")}
         FROM ${q("traffic_stats")} ts
        WHERE ts.${q("ruleId")} IN (${effectiveRuleIds.map(() => "?").join(",")})
          AND ts.${q("recordedAt")} >= ?
        GROUP BY ${bucketExprSql("ts", bucketSec)}
        ORDER BY ${q("bucket")} ASC`,
      [...effectiveRuleIds, sinceSec],
    );

  return rows.map((r: any) => ({
    bucket: new Date(Number(r.bucket) * 1000),
    bytesIn: Number(r.bytesIn) || 0,
    bytesOut: Number(r.bytesOut) || 0,
    connections: Number(r.connections) || 0,
  })).filter((r: { bucket: Date }) => r.bucket.getTime() / 1000 >= sinceSec);
}

/** Aggregate global traffic trend by time bucket for the dashboard. */
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
  const q = quoteIdentifier;
  const trafficTable = q("traffic_stats");
  const rulesTable = q("forward_rules");
  const canUseBuckets = bucket === TRAFFIC_BUCKET_MINUTES && await trafficBucketsReady() && canUseTrafficBuckets(since);
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

/** Insert a tunnel latency sample and update latest tunnel test state. */
export async function insertTunnelLatencyStat(
  stat: InsertTunnelLatencyStat,
  options: { message?: string | null; preserveMessage?: boolean; updateTunnel?: boolean } = {},
) {
  const db = await getDb();
  if (!db) return;
  await db.insert(tunnelLatencyStats).values(stat);
  if (options.updateTunnel === false) return;
  const status = stat.isTimeout ? "failed" : "success";
  const now = nowDate();
  const updates: any = {
    lastLatencyMs: stat.isTimeout ? null : (stat.latencyMs ?? null),
    lastTestStatus: status,
    lastTestAt: now,
    updatedAt: now,
  };
  if (options.message !== undefined) {
    updates.lastTestMessage = options.message;
  } else if (!options.preserveMessage) {
    updates.lastTestMessage = null;
  }
  await db.update(tunnels).set(updates).where(eq(tunnels.id, stat.tunnelId));
}

export async function getLatestTunnelLatencies(tunnelIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(tunnelIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (!db || ids.length === 0) {
    return new Map<number, { latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>();
  }
  const q = quoteIdentifier;
  const rows = await queryRaw<{ tunnelId: number; latencyMs: number | null; isTimeout: unknown; recordedAt: unknown; seriesKey: string | null }>(
    `SELECT s.${q("tunnelId")} AS ${q("tunnelId")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("recordedAt")} AS ${q("recordedAt")},
            s.${q("seriesKey")} AS ${q("seriesKey")}
       FROM ${q("tunnel_latency_stats")} s
       INNER JOIN (
         SELECT ${q("tunnelId")},
                MAX(CASE WHEN ${q("seriesKey")} IS NULL OR ${q("seriesKey")} = '' OR ${q("seriesKey")} = 'total' THEN ${q("id")} ELSE NULL END) AS ${q("id")}
           FROM ${q("tunnel_latency_stats")}
          WHERE ${q("tunnelId")} IN (${ids.map(() => "?").join(",")})
          GROUP BY ${q("tunnelId")}
       ) latest ON latest.${q("tunnelId")} = s.${q("tunnelId")} AND latest.${q("id")} = s.${q("id")}`,
    ids,
  );
  const latest = new Map<number, { latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>();
  for (const row of rows) {
    latest.set(Number(row.tunnelId), {
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      recordedAt: rowDate(row.recordedAt),
    });
  }
  return latest;
}

function normalizeTunnelLatencySeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key || "total";
}

function tunnelLatencySeriesSortRank(key: string) {
  if (key === "total") return [0, 0];
  if (key === "primary") return [1, 0];
  const match = key.match(/^exit-(\d+)$/);
  if (match) return [2, Number(match[1]) || 0];
  return [3, 0];
}

export async function getLatestTunnelLatencySeries(tunnelIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(tunnelIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)));
  if (!db || ids.length === 0) {
    return new Map<number, Array<{ seriesKey: string; seriesLabel: string | null; latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>>();
  }
  const q = quoteIdentifier;
  const seriesExpr = `COALESCE(NULLIF(s.${q("seriesKey")}, ''), 'total')`;
  const rows = await queryRaw<{ tunnelId: number; seriesKey: string | null; seriesLabel: string | null; latencyMs: number | null; isTimeout: unknown; recordedAt: unknown }>(
    `SELECT s.${q("tunnelId")} AS ${q("tunnelId")},
            ${seriesExpr} AS ${q("seriesKey")},
            s.${q("seriesLabel")} AS ${q("seriesLabel")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("recordedAt")} AS ${q("recordedAt")}
       FROM ${q("tunnel_latency_stats")} s
       INNER JOIN (
         SELECT ${q("tunnelId")},
                COALESCE(NULLIF(${q("seriesKey")}, ''), 'total') AS ${q("seriesKey")},
                MAX(${q("id")}) AS ${q("id")}
           FROM ${q("tunnel_latency_stats")}
          WHERE ${q("tunnelId")} IN (${ids.map(() => "?").join(",")})
          GROUP BY ${q("tunnelId")}, COALESCE(NULLIF(${q("seriesKey")}, ''), 'total')
       ) latest ON latest.${q("tunnelId")} = s.${q("tunnelId")} AND latest.${q("id")} = s.${q("id")}` ,
    ids,
  );
  const grouped = new Map<number, Array<{ seriesKey: string; seriesLabel: string | null; latencyMs: number | null; isTimeout: boolean; recordedAt: Date }>>();
  for (const row of rows) {
    const tunnelId = Number(row.tunnelId);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0) continue;
    const seriesKey = normalizeTunnelLatencySeriesKey(row.seriesKey);
    const series = grouped.get(tunnelId) || [];
    series.push({
      seriesKey,
      seriesLabel: row.seriesLabel ? String(row.seriesLabel) : null,
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      recordedAt: rowDate(row.recordedAt),
    });
    grouped.set(tunnelId, series);
  }
  for (const series of grouped.values()) {
    series.sort((a, b) => {
      const [rankA, tieA] = tunnelLatencySeriesSortRank(a.seriesKey);
      const [rankB, tieB] = tunnelLatencySeriesSortRank(b.seriesKey);
      if (rankA !== rankB) return rankA - rankB;
      if (tieA !== tieB) return tieA - tieB;
      return a.seriesKey.localeCompare(b.seriesKey, "en");
    });
  }
  return grouped;
}

export async function getTunnelLatencySeries(
  tunnelId: number,
  opts: { since?: Date; limit?: number } = {}
) {
  const db = await getDb();
  if (!db) return [] as Array<{ latencyMs: number | null; isTimeout: boolean; recordedAt: Date; seriesKey: string; seriesLabel: string | null }>;
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = clampPositiveInt(opts.limit, 20_000, 50_000);
  const q = quoteIdentifier;
  const startedAt = Date.now();
  const page = limitOffset(limit);
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; recordedAt: unknown; seriesKey: string | null; seriesLabel: string | null }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}, ${q("seriesKey")}, ${q("seriesLabel")}
       FROM ${q("tunnel_latency_stats")}
      WHERE ${q("tunnelId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [tunnelId, epochSeconds(since), ...page.params],
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 800) {
    console.warn(`[TunnelLatency] slow tunnel=${tunnelId} rows=${rows.length} elapsedMs=${elapsedMs}`);
  }
  return rows.reverse().map((row) => {
    const key = String(row.seriesKey || "").trim();
    return {
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      recordedAt: rowDate(row.recordedAt),
      seriesKey: key || "total",
      seriesLabel: row.seriesLabel ? String(row.seriesLabel) : null,
    };
  });
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
  const q = quoteIdentifier;
  const startedAt = Date.now();
  const page = limitOffset(limit);
  const rows = await queryRaw<{ latencyMs: number | null; isTimeout: unknown; recordedAt: unknown }>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("forward_group_latency_stats")}
      WHERE ${q("groupId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [groupId, epochSeconds(since), ...page.params],
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
  const q = quoteIdentifier;
  const chainGroupId = await getChainGroupIdForTemplateRule(ruleId);
  if (chainGroupId) {
    const groupSeries = await getForwardGroupLatencySeries(chainGroupId, { since, limit });
    if (groupSeries.length > 0) return groupSeries;
  }
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
      const page = limitOffset(Math.max(limit * childIds.length, limit));
      const rawRows = await queryRaw<any>(
        `SELECT ${q("ruleId")}, ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
           FROM ${q("tcping_stats")}
         WHERE ${q("ruleId")} IN (${childIds.map(() => "?").join(",")})
           AND ${q("recordedAt")} >= ?
          ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
          ${page.sql}`,
        [...childIds, epochSeconds(since), ...page.params],
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
  const page = limitOffset(limit);
  const rows = await queryRaw<any>(
    `SELECT ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("tcping_stats")}
      WHERE ${q("ruleId")} = ? AND ${q("recordedAt")} >= ?
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      ${page.sql}`,
    [ruleId, epochSeconds(since), ...page.params],
  );
  return rows.reverse().map((row) => ({
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
}

/** Aggregate global TCPing latency trend by time bucket. */
export async function getGlobalTcpingSeries(opts: { bucketMinutes?: number; since?: Date; userId?: number } = {}) {
  const db = await getDb();
  if (!db) return [] as Array<{ bucket: Date; avgLatency: number; maxLatency: number; minLatency: number; timeoutCount: number; totalCount: number }>;
  const bucket = clampPositiveInt(opts.bucketMinutes, 1, 60);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const bucketSec = bucket * 60;
  const q = quoteIdentifier;
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

/** Clean expired TCPing data, keeping the most recent N hours. */
export async function cleanOldTcpingStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("tcping_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_group_latency_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
}

export async function cleanOldTunnelLatencyStats(retainHours: number = 72) {
  const db = await getDb();
  if (!db) return;
  const cutoff = retentionCutoffSeconds(retainHours);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("tunnel_latency_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
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
    `SELECT ${quoteIdentifier("id")}, ${quoteIdentifier("ruleId")}, ${quoteIdentifier("hostId")}, ${quoteIdentifier("message")}
     FROM ${quoteIdentifier("forward_tests")}
     WHERE ${quoteIdentifier("status")} IN ('pending', 'running')
       AND ${quoteIdentifier("updatedAt")} < ?`,
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
    `UPDATE ${quoteIdentifier("forward_tests")}
     SET ${quoteIdentifier("status")} = 'timeout',
         ${quoteIdentifier("message")} = COALESCE(NULLIF(${quoteIdentifier("message")}, ''), ${messageExpr}),
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("id")} IN (${placeholders})
       AND ${quoteIdentifier("status")} IN ('pending', 'running')
       AND ${quoteIdentifier("updatedAt")} < ?`,
    [ttlSeconds, nowSec, ...ids, cutoffSec],
  );
  const changed = rawAffectedRows(info);
  if (changed <= 0) return [];
  return queryRaw<TimedOutForwardTest>(
    `SELECT ${quoteIdentifier("id")}, ${quoteIdentifier("ruleId")}, ${quoteIdentifier("hostId")}, ${quoteIdentifier("message")}
     FROM ${quoteIdentifier("forward_tests")}
     WHERE ${quoteIdentifier("id")} IN (${placeholders})
       AND ${quoteIdentifier("status")} = 'timeout'
       AND ${quoteIdentifier("updatedAt")} = ?`,
    [...ids, nowSec],
  );
}

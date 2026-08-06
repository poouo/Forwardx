import { asc, desc, eq } from "drizzle-orm";
import {
  hostProbeServices,
  hostProbeServiceStats,
  type InsertHostProbeService,
  type InsertHostProbeServiceStat,
} from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { boolLiteral, bucketExpression, inList, quoteIdentifier } from "../dbCompat";
import { clampPositiveInt, epochSeconds } from "./repositoryUtils";

export type HostProbeMethod = "tcping" | "ping";
export type HostProbeScope = "all" | "exclude" | "specific";

export type HostProbeServiceInput = {
  name: string;
  method: HostProbeMethod;
  targetIp: string;
  targetPort?: number | null;
  hostScope: HostProbeScope;
  hostIds?: number[];
  excludeHostIds?: number[];
  intervalSeconds?: number;
  isEnabled?: boolean;
  sortOrder?: number;
  userId: number;
};

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const n = Number(value || 0);
  return new Date(n * 1000);
}

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function serializeIds(ids: number[] | undefined) {
  const normalized = Array.from(new Set((ids || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0)))
    .sort((a, b) => a - b);
  return normalized.length > 0 ? normalized.join(",") : null;
}

function parseIds(value: unknown) {
  return String(value || "")
    .split(",")
    .map((item) => Math.floor(Number(item.trim())))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function normalizeIntervalSeconds(value: unknown) {
  return Math.max(5, Math.floor(Number(value) || 30));
}

function normalizeSortOrder(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeServiceInput(input: HostProbeServiceInput): InsertHostProbeService {
  const method = input.method === "ping" ? "ping" : "tcping";
  const hostScope = input.hostScope === "exclude" || input.hostScope === "specific" ? input.hostScope : "all";
  const payload = {
    name: input.name.trim(),
    method,
    targetIp: input.targetIp.trim(),
    targetPort: method === "tcping" ? Number(input.targetPort) : null,
    hostScope,
    hostIds: hostScope === "specific" ? serializeIds(input.hostIds) : null,
    excludeHostIds: hostScope === "exclude" ? serializeIds(input.excludeHostIds) : null,
    intervalSeconds: normalizeIntervalSeconds(input.intervalSeconds),
    isEnabled: input.isEnabled !== false,
    userId: input.userId,
    createdAt: nowDate(),
    updatedAt: nowDate(),
  } as InsertHostProbeService;
  if (input.sortOrder !== undefined) (payload as any).sortOrder = normalizeSortOrder(input.sortOrder);
  return payload;
}

export function mapHostProbeService(row: any) {
  return {
    ...row,
    id: Number(row?.id || 0),
    targetPort: row?.targetPort == null ? null : Number(row.targetPort),
    intervalSeconds: normalizeIntervalSeconds(row?.intervalSeconds),
    isEnabled: rowBool(row?.isEnabled),
    sortOrder: normalizeSortOrder(row?.sortOrder),
    userId: Number(row?.userId || 0),
    hostIds: parseIds(row?.hostIds),
    excludeHostIds: parseIds(row?.excludeHostIds),
    createdAt: rowDate(row?.createdAt),
    updatedAt: rowDate(row?.updatedAt),
  };
}

export async function getHostProbeServices(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = userId
    ? await db.select().from(hostProbeServices).where(eq(hostProbeServices.userId, userId)).orderBy(asc(hostProbeServices.sortOrder), desc(hostProbeServices.createdAt), desc(hostProbeServices.id))
    : await db.select().from(hostProbeServices).orderBy(asc(hostProbeServices.sortOrder), desc(hostProbeServices.createdAt), desc(hostProbeServices.id));
  return rows.map(mapHostProbeService);
}

export async function getHostProbeServiceById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(hostProbeServices).where(eq(hostProbeServices.id, id)).limit(1);
  return rows[0] ? mapHostProbeService(rows[0]) : null;
}

export async function createHostProbeService(input: HostProbeServiceInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("host_probe_services", normalizeServiceInput(input) as any);
}

export async function updateHostProbeService(id: number, input: Omit<HostProbeServiceInput, "userId">) {
  const db = await getDb();
  if (!db) return;
  const payload = normalizeServiceInput({ ...input, userId: 0 });
  delete (payload as any).userId;
  delete (payload as any).createdAt;
  await db.update(hostProbeServices).set({ ...payload, updatedAt: nowDate() }).where(eq(hostProbeServices.id, id));
}

export async function deleteHostProbeService(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(hostProbeServiceStats).where(eq(hostProbeServiceStats.serviceId, id));
  await db.delete(hostProbeServices).where(eq(hostProbeServices.id, id));
}

export async function reorderHostProbeServices(ids: number[], userId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = Array.from(ids || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const q = quoteIdentifier;
  const list = inList(orderedIds);
  const params: any[] = [...list.params];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} FROM ${q("host_probe_services")} WHERE ${q("id")} IN ${list.sql}${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error("排序中包含无权操作或不存在的服务");
  const now = Math.floor(Date.now() / 1000);
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(
      `UPDATE ${q("host_probe_services")}
          SET ${q("sortOrder")} = ?, ${q("updatedAt")} = ?
        WHERE ${q("id")} = ?`,
      [index, now, id],
    );
  }
}

function serviceAppliesToHost(service: any, hostId: number) {
  const id = Number(hostId);
  if (!id || !service?.isEnabled) return false;
  const scope = String(service.hostScope || "all");
  if (scope === "specific") return parseIds(service.hostIds).includes(id);
  if (scope === "exclude") return !parseIds(service.excludeHostIds).includes(id);
  return true;
}

export async function getHostProbeTasksForHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(hostProbeServices).where(eq(hostProbeServices.isEnabled, true)).orderBy(asc(hostProbeServices.sortOrder), desc(hostProbeServices.createdAt), desc(hostProbeServices.id));
  return rows
    .map(mapHostProbeService)
    .filter((service: any) => serviceAppliesToHost(service, hostId))
    .map((service: any) => ({
      serviceId: service.id,
      method: service.method === "ping" ? "ping" : "tcping",
      targetIp: service.targetIp,
      targetPort: service.method === "tcping" ? Number(service.targetPort || 0) : 0,
      intervalSeconds: service.intervalSeconds,
    }))
    .filter((task: any) => task.serviceId > 0 && task.targetIp && (task.method === "ping" || task.targetPort > 0));
}

export async function insertHostProbeServiceStats(stats: InsertHostProbeServiceStat[]) {
  const db = await getDb();
  if (!db || stats.length === 0) return;
  await db.insert(hostProbeServiceStats).values(stats);
}

export async function getLatestHostProbeServiceStats(serviceIds: number[], hostId?: number) {
  const ids = Array.from(new Set(serviceIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return new Map<number, any>();
  const scopedHostId = Number(hostId || 0);
  const q = quoteIdentifier;
  const list = inList(ids);
  const hostCondition = Number.isInteger(scopedHostId) && scopedHostId > 0
    ? ` AND ${q("hostId")} = ?`
    : "";
  const params = hostCondition ? [...list.params, scopedHostId] : list.params;
  const rows = await queryRaw<any>(
    `SELECT s.${q("serviceId")} AS ${q("serviceId")},
            s.${q("hostId")} AS ${q("hostId")},
            s.${q("latencyMs")} AS ${q("latencyMs")},
            s.${q("isTimeout")} AS ${q("isTimeout")},
            s.${q("recordedAt")} AS ${q("recordedAt")}
       FROM ${q("host_probe_service_stats")} s
       INNER JOIN (
         SELECT ${q("serviceId")}, MAX(${q("id")}) AS ${q("id")}
           FROM ${q("host_probe_service_stats")}
          WHERE ${q("serviceId")} IN ${list.sql}
            ${hostCondition}
          GROUP BY ${q("serviceId")}
       ) latest ON latest.${q("serviceId")} = s.${q("serviceId")} AND latest.${q("id")} = s.${q("id")}`,
    params,
  );
  const latest = new Map<number, any>();
  for (const row of rows) {
    latest.set(Number(row.serviceId), {
      serviceId: Number(row.serviceId),
      hostId: Number(row.hostId),
      latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
      isTimeout: rowBool(row.isTimeout),
      recordedAt: rowDate(row.recordedAt),
    });
  }
  return latest;
}

export async function getHostProbeServiceSeries(opts: { serviceIds?: number[]; hostId?: number; hours?: number; limit?: number } = {}) {
  const ids = Array.from(new Set((opts.serviceIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const hostId = Number(opts.hostId || 0);
  const requestedHours = Number(opts.hours);
  const hours = Number.isFinite(requestedHours) && requestedHours > 0
    ? Math.max(0.5, Math.min(requestedHours, 24 * 3))
    : 24;
  const limit = clampPositiveInt(opts.limit, 20_000, 100_000);
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const q = quoteIdentifier;
  const conditions = [`s.${q("recordedAt")} >= ?`];
  const params: any[] = [epochSeconds(since)];
  if (ids.length > 0) {
    const list = inList(ids);
    conditions.push(`s.${q("serviceId")} IN ${list.sql}`);
    params.push(...list.params);
  }
  if (Number.isInteger(hostId) && hostId > 0) {
    conditions.push(`s.${q("hostId")} = ?`);
    params.push(hostId);
  }
  // The client already renders one point per minute.  Coarser buckets for
  // longer ranges keep a busy panel from returning millions of raw probes,
  // while retaining the complete requested time window.
  const baseBucketSeconds = hours <= 1
    ? 60
    : hours <= 6
      ? 120
      : hours <= 24
        ? 300
        : 600;
  // `limit` used to be applied to the raw rows globally, which made a 24h
  // request contain only the last few hours when several services reported
  // frequently. Use it to choose a safe bucket width instead. Host-scoped
  // requests with explicit services can be estimated directly; for all other
  // calls count the actual service/host series so the response stays bounded
  // without truncating the beginning of the requested window.
  let seriesCount = hostId > 0 && ids.length > 0 ? ids.length : 0;
  if (seriesCount === 0) {
    const countRows = await queryRaw<{ count: unknown }>(
      `SELECT COUNT(*) AS ${q("count")}
         FROM (
           SELECT s.${q("serviceId")}, s.${q("hostId")}
             FROM ${q("host_probe_service_stats")} s
            WHERE ${conditions.join(" AND ")}
            GROUP BY s.${q("serviceId")}, s.${q("hostId")}
         ) series_scope`,
      params,
    );
    seriesCount = Math.max(1, Number(countRows[0]?.count) || 1);
  }
  const maxBucketsPerSeries = Math.max(1, Math.floor(limit / seriesCount));
  const durationSeconds = hours * 3600;
  const bucketForLimit = Math.ceil(durationSeconds / Math.max(1, maxBucketsPerSeries - 1));
  const bucketSeconds = Math.max(
    baseBucketSeconds,
    Math.max(1, Math.ceil(bucketForLimit / 60) * 60),
  );
  const bucketExpr = bucketExpression("s", "recordedAt", bucketSeconds);
  const successful = boolLiteral(false);
  const timedOut = boolLiteral(true);
  const rows = await queryRaw<any>(
    `SELECT s.${q("serviceId")},
            s.${q("hostId")},
            ${bucketExpr} AS ${q("bucketStart")},
            AVG(CASE WHEN s.${q("isTimeout")} = ${successful}
                          AND s.${q("latencyMs")} IS NOT NULL
                     THEN s.${q("latencyMs")} END) AS ${q("avgLatency")},
            SUM(CASE WHEN s.${q("isTimeout")} = ${successful}
                          AND s.${q("latencyMs")} IS NOT NULL
                     THEN 1 ELSE 0 END) AS ${q("sampleCount")},
            SUM(CASE WHEN s.${q("isTimeout")} = ${timedOut}
                     THEN 1 ELSE 0 END) AS ${q("timeoutCount")}
       FROM ${q("host_probe_service_stats")} s
      WHERE ${conditions.join(" AND ")}
      GROUP BY s.${q("serviceId")}, s.${q("hostId")}, ${bucketExpr}
      ORDER BY ${q("bucketStart")} ASC, s.${q("serviceId")} ASC, s.${q("hostId")} ASC`,
    params,
  );
  return rows.map((row) => {
    const sampleCount = Number(row.sampleCount) || 0;
    const timeoutCount = Number(row.timeoutCount) || 0;
    const hasLatency = sampleCount > 0 && row.avgLatency != null;
    return {
      serviceId: Number(row.serviceId),
      hostId: Number(row.hostId),
      latencyMs: hasLatency ? Math.round(Number(row.avgLatency)) : null,
      // A bucket is a timeout only when it has no successful latency sample.
      // This keeps a single transient timeout from hiding otherwise good data.
      isTimeout: !hasLatency && timeoutCount > 0,
      recordedAt: rowDate(row.bucketStart),
    };
  });
}
export async function cleanOldHostProbeServiceStats(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("host_probe_service_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
}

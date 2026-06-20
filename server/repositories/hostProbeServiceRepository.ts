import { desc, eq } from "drizzle-orm";
import {
  hostProbeServices,
  hostProbeServiceStats,
  type InsertHostProbeService,
  type InsertHostProbeServiceStat,
} from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { inList, limitOffset, quoteIdentifier } from "../dbCompat";
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

function normalizeServiceInput(input: HostProbeServiceInput): InsertHostProbeService {
  const method = input.method === "ping" ? "ping" : "tcping";
  const hostScope = input.hostScope === "exclude" || input.hostScope === "specific" ? input.hostScope : "all";
  return {
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
}

export function mapHostProbeService(row: any) {
  return {
    ...row,
    id: Number(row?.id || 0),
    targetPort: row?.targetPort == null ? null : Number(row.targetPort),
    intervalSeconds: normalizeIntervalSeconds(row?.intervalSeconds),
    isEnabled: rowBool(row?.isEnabled),
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
    ? await db.select().from(hostProbeServices).where(eq(hostProbeServices.userId, userId)).orderBy(desc(hostProbeServices.createdAt))
    : await db.select().from(hostProbeServices).orderBy(desc(hostProbeServices.createdAt));
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
  const rows = await db.select().from(hostProbeServices).where(eq(hostProbeServices.isEnabled, true)).orderBy(desc(hostProbeServices.createdAt));
  return rows
    .map(mapHostProbeService)
    .filter((service) => serviceAppliesToHost(service, hostId))
    .map((service) => ({
      serviceId: service.id,
      method: service.method === "ping" ? "ping" : "tcping",
      targetIp: service.targetIp,
      targetPort: service.method === "tcping" ? Number(service.targetPort || 0) : 0,
      intervalSeconds: service.intervalSeconds,
    }))
    .filter((task) => task.serviceId > 0 && task.targetIp && (task.method === "ping" || task.targetPort > 0));
}

export async function insertHostProbeServiceStats(stats: InsertHostProbeServiceStat[]) {
  const db = await getDb();
  if (!db || stats.length === 0) return;
  await db.insert(hostProbeServiceStats).values(stats);
}

export async function getLatestHostProbeServiceStats(serviceIds: number[]) {
  const ids = Array.from(new Set(serviceIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return new Map<number, any>();
  const q = quoteIdentifier;
  const list = inList(ids);
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
          GROUP BY ${q("serviceId")}
       ) latest ON latest.${q("serviceId")} = s.${q("serviceId")} AND latest.${q("id")} = s.${q("id")}`,
    list.params,
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

export async function getHostProbeServiceSeries(opts: { serviceIds?: number[]; hours?: number; limit?: number } = {}) {
  const ids = Array.from(new Set((opts.serviceIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const hours = clampPositiveInt(opts.hours, 24, 24 * 30);
  const limit = clampPositiveInt(opts.limit, 20_000, 100_000);
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const q = quoteIdentifier;
  const conditions = [`${q("recordedAt")} >= ?`];
  const params: any[] = [epochSeconds(since)];
  if (ids.length > 0) {
    const list = inList(ids);
    conditions.push(`${q("serviceId")} IN ${list.sql}`);
    params.push(...list.params);
  }
  const page = limitOffset(limit);
  const rows = await queryRaw<any>(
    `SELECT ${q("serviceId")}, ${q("hostId")}, ${q("latencyMs")}, ${q("isTimeout")}, ${q("recordedAt")}
       FROM ${q("host_probe_service_stats")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${q("recordedAt")} ASC, ${q("id")} ASC
      ${page.sql}`,
    [...params, ...page.params],
  );
  return rows.map((row) => ({
    serviceId: Number(row.serviceId),
    hostId: Number(row.hostId),
    latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
    isTimeout: rowBool(row.isTimeout),
    recordedAt: rowDate(row.recordedAt),
  }));
}

export async function cleanOldHostProbeServiceStats(retainHours = 48) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("host_probe_service_stats")} WHERE ${quoteIdentifier("recordedAt")} < ?`,
    [cutoff],
  );
}

import { asc, desc, eq, sql } from "drizzle-orm";
import { hosts, InsertHost, forwardRules, forwardGroupMembers, hostMetrics, hostTrafficCounters, trafficStats } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { boolValue, inList, quoteIdentifier, sqlCountAll } from "../dbCompat";
import { sqlBool } from "./repositoryUtils";

// ==================== Host Queries ====================

export const HOST_ONLINE_TTL_MS = 90 * 1000;

export function isFreshHostHeartbeat(lastHeartbeat: unknown) {
  if (!lastHeartbeat) return false;
  const time = new Date(lastHeartbeat as any).getTime();
  return Number.isFinite(time) && Date.now() - time <= HOST_ONLINE_TTL_MS;
}

function withComputedOnline<T extends { isOnline?: boolean; lastHeartbeat?: unknown }>(host: T): T {
  return { ...host, isOnline: !!host.isOnline && isFreshHostHeartbeat(host.lastHeartbeat) };
}

export async function getHosts(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) {
    const rows = await db.select().from(hosts).where(eq(hosts.userId, userId)).orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id));
    return rows.map(withComputedOnline);
  }
  const rows = await db.select().from(hosts).orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id));
  return rows.map(withComputedOnline);
}

export async function getHostById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return r[0] ? withComputedOnline(r[0]) : undefined;
}

export async function createHost(host: InsertHost) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("hosts", host as any);
}

export async function updateHost(id: number, data: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ ...data, updatedAt: nowDate() }).where(eq(hosts.id, id));
}

export async function deleteHost(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRules).where(eq(forwardRules.hostId, id));
  await db.delete(hostMetrics).where(eq(hostMetrics.hostId, id));
  await db.delete(hostTrafficCounters).where(eq(hostTrafficCounters.hostId, id));
  await db.delete(trafficStats).where(eq(trafficStats.hostId, id));
  await db.delete(hosts).where(eq(hosts.id, id));
}

export async function updateHostHeartbeat(id: number, metrics?: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ isOnline: true, lastHeartbeat: nowDate(), updatedAt: nowDate(), ...(metrics ?? {}) }).where(eq(hosts.id, id));
}

export async function getStaleOnlineHosts(timeoutMs = HOST_ONLINE_TTL_MS) {
  const db = await getDb();
  if (!db) return [];
  const cutoffSec = Math.floor((Date.now() - timeoutMs) / 1000);
  return db.select().from(hosts).where(sql`
    ${hosts.isOnline} = ${sqlBool(true)}
    AND ${hosts.lastHeartbeat} IS NOT NULL
    AND ${hosts.lastHeartbeat} < ${cutoffSec}
  `);
}

export async function markHostsOffline(hostIds: number[]) {
  const ids = Array.from(new Set(hostIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const idList = inList(ids);
  await executeRaw(
    `UPDATE ${quoteIdentifier("hosts")}
     SET ${quoteIdentifier("isOnline")} = ?,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("id")} IN ${idList.sql}`,
    [boolValue(false), nowSec, ...idList.params],
  );
  return ids.length;
}

export async function markHostOffline(hostId: number) {
  return markHostsOffline([hostId]);
}

export async function requestHostAgentUpgrade(hostId: number, targetVersion: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: true,
    agentUpgradeTargetVersion: targetVersion,
    agentUpgradeRequestedAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(hosts.id, hostId));
}

export async function clearHostAgentUpgradeRequest(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: false,
    agentUpgradeTargetVersion: null,
    updatedAt: nowDate(),
  }).where(eq(hosts.id, hostId));
}

export async function clearStaleHostAgentUpgradeRequests(timeoutMs = 10 * 60 * 1000) {
  const db = await getDb();
  if (!db) return;
  const cutoffSec = Math.floor((Date.now() - timeoutMs) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  await executeRaw(
    `UPDATE ${quoteIdentifier("hosts")}
     SET ${quoteIdentifier("agentUpgradeRequested")} = ?,
         ${quoteIdentifier("agentUpgradeTargetVersion")} = NULL,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("agentUpgradeRequested")} = ?
       AND ${quoteIdentifier("agentUpgradeRequestedAt")} IS NOT NULL
       AND ${quoteIdentifier("agentUpgradeRequestedAt")} < ?`,
    [boolValue(false), nowSec, boolValue(true), cutoffSec],
  );
}

function dateTimeMs(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  }
  const text = String(value).trim();
  const numericText = typeof value === "number" || /^\d+(\.\d+)?$/.test(text);
  const numberValue = Number(value);
  if (numericText) {
    return Number.isFinite(numberValue) && numberValue > 0
      ? (numberValue < 100_000_000_000 ? numberValue * 1000 : numberValue)
      : null;
  }
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hostResetDueToday(host: any, now: Date) {
  const resetDay = Math.min(31, Math.max(1, Math.floor(Number(host?.trafficResetDay || 1))));
  const dueDay = Math.min(resetDay, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  if (now.getDate() < dueDay) return false;

  const nowMs = now.getTime();
  const purchasedAt = dateTimeMs(host?.purchasedAt);
  if (purchasedAt != null && nowMs < purchasedAt) return false;
  const stoppedAt = dateTimeMs(host?.stoppedAt);
  if (stoppedAt != null && nowMs >= stoppedAt) return false;

  const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastResetAt = dateTimeMs(host?.lastTrafficReset);
  return lastResetAt == null || lastResetAt < monthStartMs;
}

export async function getHostsForTrafficAutoReset(now = new Date()) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(hosts).where(eq(hosts.trafficAutoReset, true));
  return rows.filter((host: any) => hostResetDueToday(host, now));
}

export async function markHostTrafficReset(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ lastTrafficReset: nowDate(), updatedAt: nowDate() }).where(eq(hosts.id, hostId));
}
export async function getHostByAgentToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(hosts).where(eq(hosts.agentToken, token)).limit(1);
  return r[0];
}

export async function getHostRuleDeleteBlockers(hostId: number) {
  const db = await getDb();
  if (!db) return { ruleCount: 0, managedRuleCount: 0, pendingCleanupCount: 0 };
  const managedRuleSql = sql`${forwardRules.forwardGroupRuleId} IS NOT NULL OR ${forwardRules.id} IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)`;
  const [ruleRows, managedRows, pendingRows] = await Promise.all([
    db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = ${sqlBool(false)}
      AND ${forwardRules.forwardGroupRuleId} IS NULL
      AND ${forwardRules.id} NOT IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)
    `),
    db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = ${sqlBool(false)}
      AND (${managedRuleSql})
    `),
    db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
      AND ${forwardRules.isRunning} = ${sqlBool(true)}
    `),
  ]);
  return {
    ruleCount: Number(ruleRows[0]?.count) || 0,
    managedRuleCount: Number(managedRows[0]?.count) || 0,
    pendingCleanupCount: Number(pendingRows[0]?.count) || 0,
  };
}

export async function releaseHostPendingRuleCleanup(hostId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
    AND ${forwardRules.isRunning} = ${sqlBool(true)}
  `);
  const count = Number(rows[0]?.count) || 0;
  if (count <= 0) return 0;
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    updatedAt: nowDate(),
  }).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = ${sqlBool(true)}
    AND ${forwardRules.isRunning} = ${sqlBool(true)}
  `);
  return count;
}

/** 获取主机下未删除的转发规则数量 */
export async function getHostRuleCount(hostId: number): Promise<number> {
  const blockers = await getHostRuleDeleteBlockers(hostId);
  return blockers.ruleCount + blockers.managedRuleCount + blockers.pendingCleanupCount;
}

import { desc, eq, sql } from "drizzle-orm";
import { hosts, InsertHost, forwardRules, hostMetrics, trafficStats } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate } from "../dbRuntime";

// ==================== Host Queries ====================

const HOST_ONLINE_TTL_MS = 90 * 1000;

function isFreshHeartbeat(lastHeartbeat: unknown) {
  if (!lastHeartbeat) return false;
  const time = new Date(lastHeartbeat as any).getTime();
  return Number.isFinite(time) && Date.now() - time <= HOST_ONLINE_TTL_MS;
}

function withComputedOnline<T extends { isOnline?: boolean; lastHeartbeat?: unknown }>(host: T): T {
  return { ...host, isOnline: !!host.isOnline && isFreshHeartbeat(host.lastHeartbeat) };
}

export async function getHosts(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) {
    const rows = await db.select().from(hosts).where(eq(hosts.userId, userId)).orderBy(desc(hosts.createdAt));
    return rows.map(withComputedOnline);
  }
  const rows = await db.select().from(hosts).orderBy(desc(hosts.createdAt));
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
  await db.delete(trafficStats).where(eq(trafficStats.hostId, id));
  await db.delete(hosts).where(eq(hosts.id, id));
}

export async function updateHostHeartbeat(id: number, metrics?: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({ isOnline: true, lastHeartbeat: nowDate(), updatedAt: nowDate(), ...(metrics ?? {}) }).where(eq(hosts.id, id));
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
  const q = getDatabaseKind() === "mysql" ? "`" : "\"";
  await executeRaw(
    `UPDATE ${q}hosts${q}
     SET ${q}agentUpgradeRequested${q} = 0,
         ${q}agentUpgradeTargetVersion${q} = NULL,
         ${q}updatedAt${q} = ?
     WHERE ${q}agentUpgradeRequested${q} = 1
       AND ${q}agentUpgradeRequestedAt${q} IS NOT NULL
       AND ${q}agentUpgradeRequestedAt${q} < ?`,
    [nowSec, cutoffSec],
  );
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
  const managedRuleSql = sql`${forwardRules.forwardGroupRuleId} IS NOT NULL OR ${forwardRules.id} IN (SELECT ruleId FROM forward_group_members WHERE ruleId IS NOT NULL)`;
  const [ruleRows, managedRows, pendingRows] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = 0
      AND ${forwardRules.forwardGroupRuleId} IS NULL
      AND ${forwardRules.id} NOT IN (SELECT ruleId FROM forward_group_members WHERE ruleId IS NOT NULL)
    `),
    db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = 0
      AND (${managedRuleSql})
    `),
    db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = 1
      AND ${forwardRules.isRunning} = 1
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
  const rows = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = 1
    AND ${forwardRules.isRunning} = 1
  `);
  const count = Number(rows[0]?.count) || 0;
  if (count <= 0) return 0;
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    updatedAt: nowDate(),
  }).where(sql`
    ${forwardRules.hostId} = ${hostId}
    AND ${forwardRules.pendingDelete} = 1
    AND ${forwardRules.isRunning} = 1
  `);
  return count;
}

/** 获取主机下未删除的转发规则数量 */
export async function getHostRuleCount(hostId: number): Promise<number> {
  const blockers = await getHostRuleDeleteBlockers(hostId);
  return blockers.ruleCount + blockers.managedRuleCount + blockers.pendingCleanupCount;
}


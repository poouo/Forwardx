import { and, eq, sql } from "drizzle-orm";
import {
  forwardRules,
  hosts,
  tunnels,
  userHostPermissions,
  userSubscriptions,
  userTunnelPermissions,
} from "../../drizzle/schema";
import { getDb } from "../dbRuntime";
import { sqlCountAll, sqlCountDistinct } from "../dbCompat";
import { getActiveUserSubscriptions } from "./billingRepository";
import { getUserUsableTrafficBillingResourceIds } from "./trafficBillingRepository";

// ==================== User-Host Permissions ====================

/** 获取某用户被授权的主机ID列表 */
export async function getUserAllowedHostIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  return rows.map((r: any) => r.hostId);
}

export async function getUserEffectiveAllowedHostIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  const planRows = await _getActiveSubscriptionHostIds(userId);
  return Array.from(new Set([...rows.map((r: any) => r.hostId), ...planRows]));
}

async function _getActiveSubscriptionHostIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const hostId of sub.hostIds || []) ids.add(Number(hostId));
  }
  return Array.from(ids);
}

async function _getActiveSubscriptionTunnelIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const tunnelId of sub.tunnelIds || []) ids.add(Number(tunnelId));
  }
  return Array.from(ids);
}

async function _getActiveSubscriptionForwardGroupIds(userId: number): Promise<number[]> {
  const active = await getActiveUserSubscriptions(userId);
  const ids = new Set<number>();
  for (const sub of active as any[]) {
    for (const forwardGroupId of sub.forwardGroupIds || []) ids.add(Number(forwardGroupId));
  }
  return Array.from(ids);
}

/** 获取某用户被授权的主机列表（含主机信息） */
export async function getUserAllowedHosts(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const hostIds = await getUserEffectiveAllowedHostIds(userId);
  if (hostIds.length === 0) return [];
  const allHosts = await db.select().from(hosts);
  return allHosts.filter((h: any) => hostIds.includes(h.id));
}

/** 设置某用户的主机权限（全量替换） */
export async function setUserHostPermissions(userId: number, hostIds: number[]) {
  const db = await getDb();
  if (!db) return;
  // 先删除旧权限
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  // 插入新权限
    if (hostIds.length > 0) {
      await db.insert(userHostPermissions).values(hostIds.map(hostId => ({ userId, hostId })));
    }
}

/** 获取某主机被授权的用户ID列表 */
export async function getHostAllowedUserIds(hostId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ userId: userHostPermissions.userId }).from(userHostPermissions).where(eq(userHostPermissions.hostId, hostId));
  return rows.map((r: any) => r.userId);
}

/** 检查用户是否有某主机的使用权限 */
export async function checkUserHostPermission(userId: number, hostId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(userHostPermissions).where(
    and(eq(userHostPermissions.userId, userId), eq(userHostPermissions.hostId, hostId))
  ).limit(1);
  if (rows.length > 0) return true;
  const planHostIds = await _getActiveSubscriptionHostIds(userId);
  return planHostIds.includes(hostId);
}

/** 删除主机时清理相关权限 */
export async function deleteHostPermissions(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.hostId, hostId));
}

/** 删除用户时清理相关权限 */
export async function deleteUserPermissions(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userHostPermissions).where(eq(userHostPermissions.userId, userId));
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
}

// ==================== User Rule/Port Count ====================

/** 获取某用户的规则数量 */
export async function getUserRuleCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sqlCountAll() }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
  ));
  return Number(r[0]?.count) || 0;
}

/** 获取某用户使用的端口数量（去重） */
export async function getUserPortCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select({ count: sqlCountDistinct(forwardRules.sourcePort) }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
  ));
  return Number(r[0]?.count) || 0;
}

/** 获取所有用户的主机权限映射 */
export async function getAllUserHostPermissions(): Promise<Array<{ userId: number; hostId: number }>> {
  const db = await getDb();
  if (!db) return [];
  return db.select({ userId: userHostPermissions.userId, hostId: userHostPermissions.hostId }).from(userHostPermissions);
}

export async function getAllUserTunnelPermissions(): Promise<Array<{ userId: number; tunnelId: number }>> {
  const db = await getDb();
  if (!db) return [];
  const manual = await db.select({ userId: userTunnelPermissions.userId, tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions);
  const active = await getActiveUserSubscriptions();
  const out = [...manual];
  for (const sub of active) {
    for (const tunnelId of (sub as any).tunnelIds || []) out.push({ userId: sub.userId, tunnelId });
  }
  return out;
}

export async function getUserAllowedTunnelIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  return rows.map((r: any) => r.tunnelId);
}

export async function getUserEffectiveAllowedTunnelIds(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  const planRows = await _getActiveSubscriptionTunnelIds(userId);
  return Array.from(new Set([...rows.map((r: any) => r.tunnelId), ...planRows]));
}

export async function getUserAllowedForwardGroupIds(userId: number): Promise<number[]> {
  return _getActiveSubscriptionForwardGroupIds(userId);
}

export async function checkUserForwardGroupPermission(userId: number, forwardGroupId: number): Promise<boolean> {
  const planForwardGroupIds = await _getActiveSubscriptionForwardGroupIds(userId);
  return planForwardGroupIds.includes(forwardGroupId);
}

export async function getTunnelsForUser(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const owned = await db.select().from(tunnels).where(eq(tunnels.userId, userId));
  const [allowedTunnelIds, billingResourceIds] = await Promise.all([
    getUserEffectiveAllowedTunnelIds(userId),
    getUserUsableTrafficBillingResourceIds(userId),
  ]);
  const allAllowedTunnelIds = Array.from(new Set([...allowedTunnelIds, ...billingResourceIds.tunnelIds]));
  if (allAllowedTunnelIds.length === 0) return owned.sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
  const ids = new Set(allAllowedTunnelIds);
  const all = await db.select().from(tunnels);
  const merged = new Map<number, any>();
  for (const tunnel of owned) merged.set(tunnel.id, tunnel);
  for (const tunnel of all) {
    if (ids.has(tunnel.id)) merged.set(tunnel.id, tunnel);
  }
  return Array.from(merged.values()).sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
}

export async function setUserTunnelPermissions(userId: number, tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId));
  if (tunnelIds.length > 0) {
    await db.insert(userTunnelPermissions).values(tunnelIds.map(tunnelId => ({ userId, tunnelId })));
  }
}

export async function checkUserTunnelPermission(userId: number, tunnelId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(userTunnelPermissions).where(
    and(eq(userTunnelPermissions.userId, userId), eq(userTunnelPermissions.tunnelId, tunnelId))
  ).limit(1);
  if (rows.length > 0) return true;
  const planTunnelIds = await _getActiveSubscriptionTunnelIds(userId);
  return planTunnelIds.includes(tunnelId);
}

export async function deleteTunnelPermissions(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.tunnelId, tunnelId));
}

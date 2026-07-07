import crypto from "crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  balanceTransactions, InsertBalanceTransaction,
  discountCodePlans,
  discountCodes, InsertDiscountCode,
  forwardRules,
  paymentOrders, InsertPaymentOrder,
  redemptionCodes, InsertRedemptionCode,
  subscriptionPlans, InsertSubscriptionPlan,
  subscriptionPlanForwardGroups,
  subscriptionPlanHosts,
  subscriptionPlanTrafficAddons,
  subscriptionPlanTunnels,
  userTrafficAddons,
  userSubscriptions, InsertUserSubscription,
  users,
} from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, getPool, getPostgresPool, getSqlite, insertAndGetId, nowDate, quoteDbIdentifier, rawAffectedRows } from "../dbRuntime";
import { getForwardRulesForUserSync } from "./forwardRuleRepository";
import { getForwardGroupEntryPortRange } from "./forwardGroupRepository";
import { getHostById } from "./hostRepository";
import { getTunnelById, updateTunnel } from "./tunnelRepository";
import {
  disableAllUserRules,
  getAllUsers,
  getUserById,
  resetUserTraffic,
  setUserForwardAccess,
  updateUserTrafficSettings,
  type ForwardAccessPauseReason,
} from "./userRepository";
import { addMonthsClamped, nextMonthlyTrafficReset } from "./repositoryUtils";
import { pushAgentRefresh } from "../agentEvents";
import { getUserUsableTrafficBillingResourceIds } from "./trafficBillingRepository";
import { getSetting, setSetting } from "./settingsRepository";

// ==================== Payment Orders ====================

export async function createPaymentOrder(order: InsertPaymentOrder) {
  const db = await getDb();
  if (!db) return undefined;
  await db.insert(paymentOrders).values(order);
  return getPaymentOrderByOutTradeNo(order.outTradeNo);
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

const BILLING_CODE_BODY_LENGTH = 24;

export function generateBillingCode(prefix = "") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bodyLength = BILLING_CODE_BODY_LENGTH;
  const raw = crypto.randomBytes(bodyLength);
  let body = "";
  for (let i = 0; i < bodyLength; i++) {
    body += chars[raw[i] % chars.length];
  }
  return `${prefix}${body}`.slice(0, 64).toUpperCase();
}

type RedemptionAttemptEntry = {
  count: number;
  lastFailAt: number;
};

const redemptionAttemptStore = new Map<string, RedemptionAttemptEntry>();
const redemptionCodeLocks = new Map<string, Promise<void>>();
const redemptionScopeLocks = new Map<string, Promise<void>>();
const REDEMPTION_ATTEMPT_WINDOW_MS = 30 * 60 * 1000;
const REDEMPTION_ATTEMPT_BLOCK_MS = 15 * 60 * 1000;
const REDEMPTION_ATTEMPT_THRESHOLD = 8;
const REDEMPTION_ATTEMPT_SOURCE_THRESHOLD = 20;

function redemptionAttemptUserKey(userId: number) {
  return `user:${userId}`;
}

function redemptionAttemptSourceKey(scope?: string | null) {
  const normalized = String(scope || "").trim().slice(0, 128);
  return normalized ? `source:${normalized}` : null;
}

function getActiveRedemptionAttemptEntry(key: string) {
  const entry = redemptionAttemptStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastFailAt < REDEMPTION_ATTEMPT_WINDOW_MS) return entry;
  redemptionAttemptStore.delete(key);
  return null;
}

function recordRedemptionAttemptFailureForKey(key: string) {
  const entry = getActiveRedemptionAttemptEntry(key);
  const now = Date.now();
  if (entry) {
    entry.count += 1;
    entry.lastFailAt = now;
  } else {
    redemptionAttemptStore.set(key, { count: 1, lastFailAt: now });
  }
}

function redemptionAttemptKeys(userId: number, scope?: string | null) {
  const keys = [redemptionAttemptUserKey(userId)];
  const sourceKey = redemptionAttemptSourceKey(scope);
  if (sourceKey) keys.push(sourceKey);
  return keys;
}

function recordRedemptionAttemptFailure(userId: number, scope?: string | null) {
  for (const key of redemptionAttemptKeys(userId, scope)) {
    recordRedemptionAttemptFailureForKey(key);
  }
}

function clearRedemptionAttemptFailures(userId: number, scope?: string | null) {
  for (const key of redemptionAttemptKeys(userId, scope)) {
    redemptionAttemptStore.delete(key);
  }
}

function redemptionAttemptRateLimitState(userId: number, scope?: string | null) {
  const checks = [
    { key: redemptionAttemptUserKey(userId), threshold: REDEMPTION_ATTEMPT_THRESHOLD },
    ...(redemptionAttemptSourceKey(scope) ? [{ key: redemptionAttemptSourceKey(scope)!, threshold: REDEMPTION_ATTEMPT_SOURCE_THRESHOLD }] : []),
  ];
  let retryAfterSeconds = 0;
  for (const check of checks) {
    const entry = getActiveRedemptionAttemptEntry(check.key);
    if (!entry || entry.count < check.threshold) {
      continue;
    }
    const now = Date.now();
    const retryAt = entry.lastFailAt + REDEMPTION_ATTEMPT_BLOCK_MS;
    if (retryAt <= now) {
      redemptionAttemptStore.delete(check.key);
      continue;
    }
    retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((retryAt - now) / 1000));
  }
  return retryAfterSeconds > 0
    ? { limited: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
    : { limited: false, retryAfterSeconds: 0 };
}

async function withRedemptionLock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => Promise<T>) {
  const previous = locks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  if (previous) await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

function redemptionAttemptLockKey(userId: number, scope?: string | null) {
  return redemptionAttemptSourceKey(scope) || redemptionAttemptUserKey(userId);
}

async function withRedemptionScopeLock<T>(userId: number, scope: string | null | undefined, fn: () => Promise<T>) {
  return withRedemptionLock(redemptionScopeLocks, redemptionAttemptLockKey(userId, scope), fn);
}

async function withRedemptionCodeLock<T>(code: string, fn: () => Promise<T>) {
  return withRedemptionLock(redemptionCodeLocks, code, fn);
}

export async function getPaymentOrderByOutTradeNo(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(paymentOrders).where(eq(paymentOrders.outTradeNo, outTradeNo)).limit(1);
  return r[0];
}

// ==================== Subscription Plans ====================

async function getPlanHostIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ hostId: subscriptionPlanHosts.hostId }).from(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  return rows.map((r: any) => r.hostId);
}

async function getPlanTunnelIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: subscriptionPlanTunnels.tunnelId }).from(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  return rows.map((r: any) => r.tunnelId);
}

async function getPlanForwardGroupIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ forwardGroupId: subscriptionPlanForwardGroups.forwardGroupId })
    .from(subscriptionPlanForwardGroups)
    .where(eq(subscriptionPlanForwardGroups.planId, planId));
  return rows.map((r: any) => Number(r.forwardGroupId)).filter(Boolean);
}

async function getPlanTrafficAddons(planId: number, includeInactive = true) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(subscriptionPlanTrafficAddons.planId, planId)];
  if (!includeInactive) conds.push(eq(subscriptionPlanTrafficAddons.isActive, true));
  return db
    .select()
    .from(subscriptionPlanTrafficAddons)
    .where(and(...conds))
    .orderBy(asc(subscriptionPlanTrafficAddons.sortOrder), asc(subscriptionPlanTrafficAddons.priceCents));
}

function normalizeTrafficAddons(addons: any[] = []) {
  return addons
    .map((addon, index) => ({
      trafficBytes: Math.max(0, Math.floor(Number(addon?.trafficBytes || 0))),
      priceCents: Math.max(0, Math.floor(Number(addon?.priceCents || 0))),
      isActive: addon?.isActive !== false,
      sortOrder: Math.max(0, Math.floor(Number(addon?.sortOrder ?? index))),
    }))
    .filter((addon) => addon.trafficBytes > 0)
    .slice(0, 20);
}

function normalizeNumericIds(values: any[] = []) {
  return Array.from(new Set(values.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
}

function buildPlanSnapshot(plan: any) {
  return {
    name: plan?.name || null,
    portCount: Number(plan?.portCount ?? 20),
    trafficLimit: Number(plan?.trafficLimit || 0),
    rateLimitMbps: Number(plan?.rateLimitMbps || 0),
    maxRules: Number(plan?.maxRules ?? 20),
    maxConnections: Number(plan?.maxConnections ?? 2000),
    maxIPs: Number(plan?.maxIPs ?? 10),
    hostIds: normalizeNumericIds(plan?.hostIds || []),
    tunnelIds: normalizeNumericIds(plan?.tunnelIds || []),
    forwardGroupIds: normalizeNumericIds(plan?.forwardGroupIds || []),
  };
}

function parsePlanSnapshot(value: unknown) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      portCount: Number(parsed.portCount ?? 20),
      trafficLimit: Number(parsed.trafficLimit || 0),
      rateLimitMbps: Number(parsed.rateLimitMbps || 0),
      maxRules: Number(parsed.maxRules ?? 20),
      maxConnections: Number(parsed.maxConnections ?? 2000),
      maxIPs: Number(parsed.maxIPs ?? 10),
      hostIds: normalizeNumericIds(Array.isArray(parsed.hostIds) ? parsed.hostIds : []),
      tunnelIds: normalizeNumericIds(Array.isArray(parsed.tunnelIds) ? parsed.tunnelIds : []),
      forwardGroupIds: normalizeNumericIds(Array.isArray(parsed.forwardGroupIds) ? parsed.forwardGroupIds : []),
    };
  } catch {
    return null;
  }
}

async function snapshotForPlanId(planId: number) {
  const plan = await getSubscriptionPlanById(planId);
  return plan ? buildPlanSnapshot(plan) : null;
}

async function attachSubscriptionSnapshots<T extends { planId: number; planSnapshot?: string | null }>(subscriptions: T[]) {
  return Promise.all(subscriptions.map(async (subscription: any) => {
    const snapshot = parsePlanSnapshot(subscription.planSnapshot);
    return {
      ...subscription,
      planName: snapshot?.name || subscription.planName,
      portCount: snapshot?.portCount ?? subscription.portCount,
      trafficLimit: snapshot?.trafficLimit ?? subscription.trafficLimit,
      rateLimitMbps: snapshot?.rateLimitMbps ?? subscription.rateLimitMbps,
      maxRules: snapshot?.maxRules ?? subscription.maxRules,
      maxConnections: snapshot?.maxConnections ?? subscription.maxConnections,
      maxIPs: snapshot?.maxIPs ?? subscription.maxIPs,
      hostIds: snapshot ? snapshot.hostIds : await getPlanHostIds(Number(subscription.planId)),
      tunnelIds: snapshot ? snapshot.tunnelIds : await getPlanTunnelIds(Number(subscription.planId)),
      forwardGroupIds: snapshot ? snapshot.forwardGroupIds : await getPlanForwardGroupIds(Number(subscription.planId)),
      trafficAddons: await getPlanTrafficAddons(Number(subscription.planId), false),
      activeTrafficAddonBytes: await getActiveTrafficAddonBytesForSubscription(Number(subscription.id)),
    };
  }));
}

async function attachPlanResources<T extends { id: number }>(plans: T[]) {
  return Promise.all(plans.map(async (plan) => ({
    ...plan,
    hostIds: await getPlanHostIds(plan.id),
    tunnelIds: await getPlanTunnelIds(plan.id),
    forwardGroupIds: await getPlanForwardGroupIds(plan.id),
    trafficAddons: await getPlanTrafficAddons(plan.id),
  })));
}

export async function listSubscriptionPlans(includeHidden = true) {
  const db = await getDb();
  if (!db) return [];
  const rows = includeHidden
    ? await db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt))
    : await db.select().from(subscriptionPlans).where(and(eq(subscriptionPlans.isActive, true), eq(subscriptionPlans.isStoreVisible, true))).orderBy(asc(subscriptionPlans.sortOrder), desc(subscriptionPlans.createdAt));
  return attachPlanResources(rows);
}

export async function getSubscriptionPlanById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, id)).limit(1);
  if (!rows[0]) return undefined;
  return (await attachPlanResources([rows[0]]))[0];
}

export async function createSubscriptionPlan(data: InsertSubscriptionPlan, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = [], trafficAddons: any[] = []) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = await insertAndGetId("subscription_plans", data as any);
  await setSubscriptionPlanResources(id, hostIds, tunnelIds, forwardGroupIds);
  await setSubscriptionPlanTrafficAddons(id, trafficAddons);
  return getSubscriptionPlanById(id);
}

export async function updateSubscriptionPlan(id: number, data: Partial<InsertSubscriptionPlan>, hostIds?: number[], tunnelIds?: number[], forwardGroupIds?: number[], trafficAddons?: any[]) {
  const db = await getDb();
  if (!db) return undefined;
  await db.update(subscriptionPlans).set({ ...data, updatedAt: nowDate() } as any).where(eq(subscriptionPlans.id, id));
  if (hostIds || tunnelIds || forwardGroupIds) {
    await setSubscriptionPlanResources(
      id,
      hostIds ?? await getPlanHostIds(id),
      tunnelIds ?? await getPlanTunnelIds(id),
      forwardGroupIds ?? await getPlanForwardGroupIds(id),
    );
  }
  if (trafficAddons) await setSubscriptionPlanTrafficAddons(id, trafficAddons);
  return getSubscriptionPlanById(id);
}

export async function freezePlanSubscriberSnapshots(planId: number) {
  const db = await getDb();
  if (!db) return [];
  const currentSnapshot = await snapshotForPlanId(planId);
  if (!currentSnapshot) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      planSnapshot: userSubscriptions.planSnapshot,
    })
    .from(userSubscriptions)
    .where(and(
      eq(userSubscriptions.planId, planId),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  const userIds = new Set<number>();
  for (const row of rows as any[]) {
    const userId = Number(row.userId || 0);
    if (userId > 0) userIds.add(userId);
    if (parsePlanSnapshot(row.planSnapshot)) continue;
    await updateUserSubscription(Number(row.id), { planSnapshot: JSON.stringify(currentSnapshot) } as any);
  }
  return Array.from(userIds);
}

export async function syncPlanSubscribers(planId: number) {
  const db = await getDb();
  if (!db) return [];
  const snapshot = await snapshotForPlanId(planId);
  if (!snapshot) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
    })
    .from(userSubscriptions)
    .where(and(
      eq(userSubscriptions.planId, planId),
      eq(userSubscriptions.status, "active"),
      sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
    ));
  const userIds = new Set<number>();
  for (const row of rows as any[]) {
    const subscriptionId = Number(row.id || 0);
    const userId = Number(row.userId || 0);
    if (subscriptionId <= 0) continue;
    await updateUserSubscription(subscriptionId, { planSnapshot: JSON.stringify(snapshot) } as any);
    if (userId > 0) userIds.add(userId);
  }
  const affectedUserIds = Array.from(userIds);
  for (const userId of affectedUserIds) {
    await syncUserSubscriptionEntitlements(userId);
  }
  return affectedUserIds;
}

export async function deleteSubscriptionPlan(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, id));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, id));
  await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.planId, id));
  await db.delete(subscriptionPlanTrafficAddons).where(eq(subscriptionPlanTrafficAddons.planId, id));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
}

export async function setSubscriptionPlanResources(planId: number, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  await db.delete(subscriptionPlanForwardGroups).where(eq(subscriptionPlanForwardGroups.planId, planId));
  const uniqueHostIds = Array.from(new Set(hostIds.filter(id => id > 0)));
  const uniqueTunnelIds = Array.from(new Set(tunnelIds.filter(id => id > 0)));
  const uniqueForwardGroupIds = Array.from(new Set(forwardGroupIds.filter(id => id > 0)));
  if (uniqueHostIds.length > 0) await db.insert(subscriptionPlanHosts).values(uniqueHostIds.map(hostId => ({ planId, hostId })));
  if (uniqueTunnelIds.length > 0) await db.insert(subscriptionPlanTunnels).values(uniqueTunnelIds.map(tunnelId => ({ planId, tunnelId })));
  if (uniqueForwardGroupIds.length > 0) await db.insert(subscriptionPlanForwardGroups).values(uniqueForwardGroupIds.map(forwardGroupId => ({ planId, forwardGroupId })));
}

export async function setSubscriptionPlanTrafficAddons(planId: number, addons: any[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanTrafficAddons).where(eq(subscriptionPlanTrafficAddons.planId, planId));
  const rows = normalizeTrafficAddons(addons);
  if (rows.length === 0) return;
  await db.insert(subscriptionPlanTrafficAddons).values(rows.map((addon) => ({
    planId,
    trafficBytes: addon.trafficBytes,
    priceCents: addon.priceCents,
    isActive: addon.isActive,
    sortOrder: addon.sortOrder,
  })));
}

export async function listUserSubscriptions(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      username: users.username,
      name: users.name,
      planId: userSubscriptions.planId,
      planName: subscriptionPlans.name,
      priceCents: subscriptionPlans.priceCents,
      currency: subscriptionPlans.currency,
      durationDays: subscriptionPlans.durationDays,
      portCount: subscriptionPlans.portCount,
      trafficLimit: subscriptionPlans.trafficLimit,
      rateLimitMbps: subscriptionPlans.rateLimitMbps,
      maxRules: subscriptionPlans.maxRules,
      maxConnections: subscriptionPlans.maxConnections,
      maxIPs: subscriptionPlans.maxIPs,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
      planSnapshot: userSubscriptions.planSnapshot,
      portRangeStart: userSubscriptions.portRangeStart,
      portRangeEnd: userSubscriptions.portRangeEnd,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
      startedAt: userSubscriptions.startedAt,
      expiresAt: userSubscriptions.expiresAt,
      createdAt: userSubscriptions.createdAt,
      updatedAt: userSubscriptions.updatedAt,
    })
    .from(userSubscriptions)
    .leftJoin(users, eq(userSubscriptions.userId, users.id))
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id));
  const rows = userId !== undefined
    ? await base.where(eq(userSubscriptions.userId, userId)).orderBy(desc(userSubscriptions.createdAt))
    : await base.orderBy(desc(userSubscriptions.createdAt));
  return attachUserSubscriptionDetails(rows);
}

async function attachUserSubscriptionDetails<T extends { id: number; planId: number }>(subscriptions: T[]) {
  return attachSubscriptionSnapshots(subscriptions as any);
}

async function getActiveTrafficAddonBytesForSubscription(subscriptionId: number) {
  const db = await getDb();
  if (!db || !subscriptionId) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${userTrafficAddons.trafficBytes}), 0)` })
    .from(userTrafficAddons)
    .where(and(
      eq(userTrafficAddons.subscriptionId, subscriptionId),
      eq(userTrafficAddons.status, "active"),
      sql`(${userTrafficAddons.expiresAt} IS NULL OR ${userTrafficAddons.expiresAt} > ${nowSec})`,
    ));
  return Number(rows?.[0]?.total || 0);
}

export async function getActiveUserTrafficAddonBytes(userId: number) {
  const db = await getDb();
  if (!db || !userId) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${userTrafficAddons.trafficBytes}), 0)` })
    .from(userTrafficAddons)
    .where(and(
      eq(userTrafficAddons.userId, userId),
      eq(userTrafficAddons.status, "active"),
      sql`(${userTrafficAddons.expiresAt} IS NULL OR ${userTrafficAddons.expiresAt} > ${nowSec})`,
    ));
  return Number(rows?.[0]?.total || 0);
}

export async function getActiveUserSubscriptions(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const conds: any[] = [
    eq(userSubscriptions.status, "active"),
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
  ];
  if (userId !== undefined) conds.push(eq(userSubscriptions.userId, userId));
  const rows = await db
    .select({
      id: userSubscriptions.id,
      userId: userSubscriptions.userId,
      planId: userSubscriptions.planId,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
      planSnapshot: userSubscriptions.planSnapshot,
      portRangeStart: userSubscriptions.portRangeStart,
      portRangeEnd: userSubscriptions.portRangeEnd,
      nextTrafficResetAt: userSubscriptions.nextTrafficResetAt,
      startedAt: userSubscriptions.startedAt,
      expiresAt: userSubscriptions.expiresAt,
      planName: subscriptionPlans.name,
      portCount: subscriptionPlans.portCount,
      trafficLimit: subscriptionPlans.trafficLimit,
      rateLimitMbps: subscriptionPlans.rateLimitMbps,
      maxRules: subscriptionPlans.maxRules,
      maxConnections: subscriptionPlans.maxConnections,
      maxIPs: subscriptionPlans.maxIPs,
    })
    .from(userSubscriptions)
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(and(...conds))
    .orderBy(desc(userSubscriptions.createdAt));
  return attachSubscriptionSnapshots(rows as any);
}

export async function createUserSubscription(data: InsertUserSubscription) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("user_subscriptions", data as any);
}

export async function updateUserSubscription(id: number, data: Partial<InsertUserSubscription>) {
  const db = await getDb();
  if (!db) return;
  await db.update(userSubscriptions).set({ ...data, updatedAt: nowDate() } as any).where(eq(userSubscriptions.id, id));
}

async function expireTrafficAddonsForSubscriptionIds(subscriptionIds: number[]) {
  const db = await getDb();
  const ids = Array.from(new Set(subscriptionIds.map(Number).filter((id) => id > 0)));
  if (!db || ids.length === 0) return [];
  const now = nowDate();
  const rows = await db
    .select({ userId: userTrafficAddons.userId })
    .from(userTrafficAddons)
    .where(and(
      eq(userTrafficAddons.status, "active"),
      inArray(userTrafficAddons.subscriptionId, ids),
    ));
  await db.update(userTrafficAddons).set({
    status: "expired",
    expiredAt: now,
    updatedAt: now,
  } as any).where(and(
    eq(userTrafficAddons.status, "active"),
    inArray(userTrafficAddons.subscriptionId, ids),
  ));
  return Array.from(new Set((rows as any[]).map((row: any) => Number(row.userId)).filter((id: number) => id > 0)));
}

export async function expireDueTrafficAddons(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const now = nowDate();
  const nowSec = Math.floor(now.getTime() / 1000);
  const conds: any[] = [
    eq(userTrafficAddons.status, "active"),
    sql`${userTrafficAddons.expiresAt} IS NOT NULL`,
    sql`${userTrafficAddons.expiresAt} <= ${nowSec}`,
  ];
  if (userId !== undefined) conds.push(eq(userTrafficAddons.userId, userId));
  const rows = await db
    .select({ userId: userTrafficAddons.userId })
    .from(userTrafficAddons)
    .where(and(...conds));
  await db.update(userTrafficAddons).set({
    status: "expired",
    expiredAt: now,
    updatedAt: now,
  } as any).where(and(...conds));
  return Array.from(new Set((rows as any[]).map((row: any) => Number(row.userId)).filter((id: number) => id > 0)));
}

export async function cancelUserSubscription(id: number) {
  await updateUserSubscription(id, { status: "cancelled" } as any);
  await expireTrafficAddonsForSubscriptionIds([id]);
}

export async function setUserSubscriptionExpiresAt(id: number, expiresAt: Date | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  const subscription = rows[0] as any;
  if (!subscription) throw new Error("订阅不存在");
  if (subscription.status === "cancelled") throw new Error("已取消的订阅不能更改到期时间");
  const nextExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (nextExpiresAt && !Number.isFinite(nextExpiresAt.getTime())) throw new Error("到期时间无效");
  const now = nowDate();
  const expired = !!nextExpiresAt && nextExpiresAt.getTime() <= now.getTime();
  let nextTrafficResetAt = subscription.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  const plan = await getSubscriptionPlanById(Number(subscription.planId));
  const subscriptionSnapshot = parsePlanSnapshot((subscription as any).planSnapshot);
  const subscriptionTrafficLimit = Number(subscriptionSnapshot?.trafficLimit ?? plan?.trafficLimit ?? 0);
  if (subscriptionTrafficLimit > 0 && !expired) {
    if (
      !nextTrafficResetAt ||
      !Number.isFinite(nextTrafficResetAt.getTime()) ||
      nextTrafficResetAt.getTime() <= now.getTime() ||
      (nextExpiresAt && nextTrafficResetAt.getTime() >= nextExpiresAt.getTime())
    ) {
      nextTrafficResetAt = nextMonthlyTrafficReset(now, nextExpiresAt);
    }
    if (nextTrafficResetAt && nextExpiresAt && nextTrafficResetAt.getTime() >= nextExpiresAt.getTime()) {
      nextTrafficResetAt = null;
    }
  } else {
    nextTrafficResetAt = null;
  }
  await updateUserSubscription(id, {
    status: expired ? "expired" : "active",
    expiresAt: nextExpiresAt,
    nextTrafficResetAt,
  } as any);
  if (expired) await expireTrafficAddonsForSubscriptionIds([id]);
  const limits = await syncUserSubscriptionEntitlements(Number(subscription.userId));
  return {
    id,
    userId: Number(subscription.userId),
    expiresAt: nextExpiresAt,
    nextTrafficResetAt,
    trafficLimit: limits.trafficLimit,
  };
}

export async function extendUserSubscription(id: number, days: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const extraDays = Math.floor(Number(days || 0));
  if (!Number.isFinite(extraDays) || extraDays <= 0) throw new Error("延长天数必须大于 0");
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, id)).limit(1);
  const subscription = rows[0] as any;
  if (!subscription) throw new Error("订阅不存在");
  if (subscription.status === "cancelled") throw new Error("已取消的订阅不能延长");
  if (!subscription.expiresAt) throw new Error("永久订阅无需延长");
  const now = nowDate();
  const currentExpiresAt = new Date(subscription.expiresAt);
  const base = Number.isFinite(currentExpiresAt.getTime()) && currentExpiresAt.getTime() > now.getTime()
    ? currentExpiresAt
    : now;
  const expiresAt = new Date(base.getTime() + extraDays * 24 * 3600 * 1000);
  let nextTrafficResetAt = subscription.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  const plan = await getSubscriptionPlanById(Number(subscription.planId));
  const subscriptionSnapshot = parsePlanSnapshot((subscription as any).planSnapshot);
  const subscriptionTrafficLimit = Number(subscriptionSnapshot?.trafficLimit ?? plan?.trafficLimit ?? 0);
  if (subscriptionTrafficLimit > 0) {
    if (!nextTrafficResetAt || !Number.isFinite(nextTrafficResetAt.getTime()) || nextTrafficResetAt.getTime() <= now.getTime()) {
      nextTrafficResetAt = nextMonthlyTrafficReset(now, expiresAt);
    }
    if (nextTrafficResetAt && nextTrafficResetAt.getTime() >= expiresAt.getTime()) nextTrafficResetAt = null;
  } else {
    nextTrafficResetAt = null;
  }
  await updateUserSubscription(id, {
    status: "active",
    expiresAt,
    nextTrafficResetAt,
  } as any);
  const limits = await syncUserSubscriptionEntitlements(Number(subscription.userId));
  return {
    id,
    userId: Number(subscription.userId),
    expiresAt,
    nextTrafficResetAt,
    trafficLimit: limits.trafficLimit,
  };
}

export async function expireUserSubscriptions() {
  const db = await getDb();
  if (!db) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const dueAddonUserIds = await expireDueTrafficAddons();
  const expiredRows = await db.select({
    id: userSubscriptions.id,
    userId: userSubscriptions.userId,
  }).from(userSubscriptions).where(and(
    eq(userSubscriptions.status, "active"),
    sql`${userSubscriptions.expiresAt} IS NOT NULL`,
    sql`${userSubscriptions.expiresAt} <= ${nowSec}`,
  ));
  const result: any = await executeRaw(
    `UPDATE ${quoteDbIdentifier("user_subscriptions")}
     SET ${quoteDbIdentifier("status")} = 'expired', ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("status")} = 'active'
       AND ${quoteDbIdentifier("expiresAt")} IS NOT NULL
       AND ${quoteDbIdentifier("expiresAt")} <= ?`,
    [nowSec, nowSec],
  );
  const expiredSubscriptionIds = (expiredRows as any[]).map((row: any) => Number(row.id)).filter((id: number) => id > 0);
  const addonUserIds = await expireTrafficAddonsForSubscriptionIds(expiredSubscriptionIds);
  const userIds = Array.from(new Set([
    ...(expiredRows as any[]).map((row: any) => Number(row.userId)).filter((id: number) => id > 0),
    ...dueAddonUserIds,
    ...addonUserIds,
  ]));
  for (const userId of userIds) {
    const rules = await getForwardRulesForUserSync(userId);
    const active = await getActiveUserSubscriptions(userId);
    await syncUserSubscriptionEntitlements(userId);
    if (active.length === 0) {
      const hostIds = new Set<number>();
      const tunnelIds = new Set<number>();
      for (const rule of rules as any[]) {
        if (rule.hostId) hostIds.add(Number(rule.hostId));
        if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
      }
      for (const tunnelId of tunnelIds) {
        const tunnel = await getTunnelById(tunnelId);
        if (tunnel) {
          await updateTunnel(tunnelId, { isRunning: false } as any);
          hostIds.add(Number(tunnel.entryHostId));
          hostIds.add(Number(tunnel.exitHostId));
        }
      }
      for (const hostId of hostIds) {
        if (hostId > 0) pushAgentRefresh(hostId, "subscription-expired");
      }
    }
  }
  return Number(result?.affectedRows ?? result?.changes ?? 0);
}

export async function getEffectiveUserPlanLimits(userId: number) {
  const active = await getActiveUserSubscriptions(userId);
  if (active.length === 0) {
    return {
      canAddRules: false,
      allowForwardXTunnel: false,
      maxPorts: 0,
      maxRules: 0,
      maxConnections: 0,
      maxIPs: 0,
      trafficLimit: 0,
      gostRateLimitIn: 0,
      gostRateLimitOut: 0,
      expiresAt: null as Date | null,
    };
  }

  let expiresAt: Date | null = null;
  const maxOf = (field: string) => Math.max(...active.map((sub: any) => Number(sub[field] || 0)));
  for (const sub of active as any[]) {
    const subExpiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    if (!subExpiresAt) {
      expiresAt = null;
      break;
    }
    if (!expiresAt || subExpiresAt.getTime() > expiresAt.getTime()) expiresAt = subExpiresAt;
  }

  const hasUnlimitedTraffic = (active as any[]).some((sub: any) => Number(sub.trafficLimit || 0) === 0);
  const baseTrafficLimit = hasUnlimitedTraffic ? 0 : maxOf("trafficLimit");
  const addonTrafficLimit = baseTrafficLimit > 0 ? await getActiveUserTrafficAddonBytes(userId) : 0;

  return {
    canAddRules: true,
    allowForwardXTunnel: true,
    maxPorts: maxOf("portCount"),
    maxRules: maxOf("maxRules"),
    maxConnections: maxOf("maxConnections"),
    maxIPs: maxOf("maxIPs"),
    trafficLimit: baseTrafficLimit > 0 ? baseTrafficLimit + addonTrafficLimit : baseTrafficLimit,
    gostRateLimitIn: maxOf("rateLimitMbps"),
    gostRateLimitOut: maxOf("rateLimitMbps"),
    expiresAt,
  };
}

function normalizeForwardAccessPauseReason(value: unknown): ForwardAccessPauseReason {
  const reason = String(value || "").trim();
  if (reason === "manual" || reason === "traffic_billing_balance" || reason === "traffic_limit" || reason === "expired") {
    return reason;
  }
  return null;
}

function isExpiredAt(value: unknown) {
  return !!value && new Date(value as any).getTime() <= Date.now();
}

function isTrafficLimitExceeded(trafficUsed: unknown, trafficLimit: unknown) {
  const limit = Number(trafficLimit || 0);
  return limit > 0 && Number(trafficUsed || 0) >= limit;
}

function positiveInt(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function mergeLimitValue(sources: Array<{ active: boolean; value: unknown }>) {
  let hasSource = false;
  let max = 0;
  for (const source of sources) {
    if (!source.active) continue;
    hasSource = true;
    const value = positiveInt(source.value);
    if (value === 0) return 0;
    max = Math.max(max, value);
  }
  return hasSource ? max : 0;
}

function mergeTrafficLimitValue(sources: Array<{ active: boolean; value: unknown }>) {
  let hasSource = false;
  let total = 0;
  for (const source of sources) {
    if (!source.active) continue;
    hasSource = true;
    const value = positiveInt(source.value);
    if (value === 0) return 0;
    total += value;
  }
  return hasSource ? total : 0;
}

function latestExpiresAtValue(sources: Array<{ active: boolean; value: unknown }>): Date | null {
  let latest: Date | null = null;
  for (const source of sources) {
    if (!source.active) continue;
    if (!source.value) return null;
    const date = new Date(source.value as any);
    if (!Number.isFinite(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

export function mergeManualAndPlanLimits(user: any, planLimits: any) {
  const manualCanAddRules = !!user?.manualCanAddRules;
  const planCanAddRules = !!planLimits?.canAddRules;
  const manualAllowForwardXTunnel = !!user?.manualAllowForwardXTunnel;
  const planAllowForwardXTunnel = !!planLimits?.allowForwardXTunnel;
  const manualDefaultActive = manualCanAddRules && !planCanAddRules;
  const manualMaxRules = positiveInt(user?.manualMaxRules);
  const manualMaxPorts = positiveInt(user?.manualMaxPorts);
  const manualMaxConnections = positiveInt(user?.manualMaxConnections);
  const manualMaxIPs = positiveInt(user?.manualMaxIPs);
  const manualTrafficLimit = positiveInt(user?.manualTrafficLimit);
  const manualGostRateLimitIn = positiveInt(user?.manualGostRateLimitIn);
  const manualGostRateLimitOut = positiveInt(user?.manualGostRateLimitOut);
  return {
    canAddRules: manualCanAddRules || planCanAddRules,
    allowForwardXTunnel: manualAllowForwardXTunnel || planAllowForwardXTunnel,
    maxPorts: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxPorts },
      { active: manualDefaultActive || manualMaxPorts > 0, value: manualMaxPorts },
    ]),
    maxRules: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxRules },
      { active: manualDefaultActive || manualMaxRules > 0, value: manualMaxRules },
    ]),
    maxConnections: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxConnections },
      { active: manualDefaultActive || manualMaxConnections > 0, value: manualMaxConnections },
    ]),
    maxIPs: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.maxIPs },
      { active: manualDefaultActive || manualMaxIPs > 0, value: manualMaxIPs },
    ]),
    trafficLimit: mergeTrafficLimitValue([
      { active: planCanAddRules, value: planLimits?.trafficLimit },
      { active: manualDefaultActive || manualTrafficLimit > 0, value: manualTrafficLimit },
    ]),
    gostRateLimitIn: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.gostRateLimitIn },
      { active: manualDefaultActive || manualGostRateLimitIn > 0, value: manualGostRateLimitIn },
    ]),
    gostRateLimitOut: mergeLimitValue([
      { active: planCanAddRules, value: planLimits?.gostRateLimitOut },
      { active: manualDefaultActive || manualGostRateLimitOut > 0, value: manualGostRateLimitOut },
    ]),
    expiresAt: latestExpiresAtValue([
      { active: planCanAddRules, value: planLimits?.expiresAt },
      { active: manualDefaultActive || !!user?.manualExpiresAt, value: user?.manualExpiresAt },
    ]),
  };
}

export type ForwardAccessCheckResult = {
  allowed: boolean;
  restored: boolean;
  user: any | null;
  reason?: ForwardAccessPauseReason | "not_found" | "no_access";
  message?: string;
};

export async function recoverUserForwardAccessIfEligible(
  userId: number,
  options: { allowTrafficBillingRecovery?: boolean } = {},
): Promise<ForwardAccessCheckResult> {
  await expireDueTrafficAddons(userId);
  const user = await getUserById(userId);
  if (!user) {
    return { allowed: false, restored: false, user: null, reason: "not_found", message: "用户不存在" };
  }
  if ((user as any).role === "admin") {
    return { allowed: true, restored: false, user };
  }

  const pauseReason = normalizeForwardAccessPauseReason((user as any).forwardAccessPauseReason);
  if (pauseReason === "manual") {
    return {
      allowed: false,
      restored: false,
      user,
      reason: "manual",
      message: "转发权限已由管理员暂停，请联系管理员开启",
    };
  }

  const limits = await getEffectiveUserPlanLimits(userId);
  const billingResources = await getUserUsableTrafficBillingResourceIds(userId);
  const effectiveLimits = mergeManualAndPlanLimits(user, limits);
  const hasTrafficBillingResource = billingResources.hostIds.length > 0 || billingResources.tunnelIds.length > 0;
  const hasTrafficBillingBalance = Number((user as any).balanceCents || 0) > 0;
  if (pauseReason === "traffic_billing_balance" && hasTrafficBillingResource && !hasTrafficBillingBalance) {
    return {
      allowed: false,
      restored: false,
      user,
      reason: "traffic_billing_balance",
      message: "流量计费余额不足，请充值后再启用规则",
    };
  }

  if (effectiveLimits.canAddRules) {
    if (isTrafficLimitExceeded((user as any).trafficUsed, effectiveLimits.trafficLimit)) {
      if (options.allowTrafficBillingRecovery && hasTrafficBillingResource && hasTrafficBillingBalance) {
        const restored = !(user as any).canAddRules || !!pauseReason;
        await updateUserTrafficSettings(userId, {
          ...effectiveLimits,
          canAddRules: true,
          allowForwardXTunnel: true,
          forwardAccessPauseReason: null,
        });
        return {
          allowed: true,
          restored,
          user: await getUserById(userId) ?? user,
        };
      }
      if ((user as any).canAddRules || pauseReason !== "traffic_limit") {
        await setUserForwardAccess(userId, false, "traffic_limit");
      }
      return {
        allowed: false,
        restored: false,
        user: await getUserById(userId) ?? user,
        reason: "traffic_limit",
        message: "套餐流量已用完，请购买附加流量包或等待下个周期重置后再启用规则",
      };
    }

    const restored = !(user as any).canAddRules || !!pauseReason;
    await updateUserTrafficSettings(userId, {
      ...effectiveLimits,
      canAddRules: true,
      allowForwardXTunnel: true,
      forwardAccessPauseReason: null,
    });
    return {
      allowed: true,
      restored,
      user: await getUserById(userId) ?? user,
    };
  }

  if (isExpiredAt((user as any).expiresAt) && !hasTrafficBillingResource) {
    if ((user as any).canAddRules || pauseReason !== "expired") {
      await setUserForwardAccess(userId, false, "expired");
    }
    return {
      allowed: false,
      restored: false,
      user: await getUserById(userId) ?? user,
      reason: "expired",
      message: "账户已到期，请续费后再启用规则",
    };
  }

  if (hasTrafficBillingResource) {
    if (hasTrafficBillingBalance) {
      const restored = !(user as any).canAddRules || !!pauseReason;
      await updateUserTrafficSettings(userId, {
        canAddRules: true,
        allowForwardXTunnel: true,
        expiresAt: null,
        trafficLimit: 0,
        forwardAccessPauseReason: null,
      });
      return {
        allowed: true,
        restored,
        user: await getUserById(userId) ?? user,
      };
    }
    if ((user as any).canAddRules || pauseReason !== "traffic_billing_balance") {
      await setUserForwardAccess(userId, false, "traffic_billing_balance");
    }
    return {
      allowed: false,
      restored: false,
      user: await getUserById(userId) ?? user,
      reason: "traffic_billing_balance",
      message: "流量计费余额不足，请充值后再启用规则",
    };
  }

  if ((user as any).canAddRules && !pauseReason) {
    return { allowed: true, restored: false, user };
  }
  return {
    allowed: false,
    restored: false,
    user,
    reason: "no_access",
    message: "转发权限已暂停，请续费后再启用规则",
  };
}

export async function ensureUserForwardAccessReady(userId: number, options?: { allowTrafficBillingRecovery?: boolean }) {
  return recoverUserForwardAccessIfEligible(userId, options);
}

export async function syncUserSubscriptionEntitlements(userId: number) {
  await expireDueTrafficAddons(userId);
  const limits = await getEffectiveUserPlanLimits(userId);
  const user = await getUserById(userId);
  const pauseReason = normalizeForwardAccessPauseReason((user as any)?.forwardAccessPauseReason);
  const effectiveLimits = mergeManualAndPlanLimits(user, limits);
  const trafficExceeded = effectiveLimits.canAddRules && isTrafficLimitExceeded((user as any)?.trafficUsed, effectiveLimits.trafficLimit);
  const manualPaused = pauseReason === "manual";
  const nextLimits = {
    ...effectiveLimits,
    canAddRules: effectiveLimits.canAddRules && !manualPaused && !trafficExceeded,
    allowForwardXTunnel: effectiveLimits.allowForwardXTunnel && !manualPaused && !trafficExceeded,
    forwardAccessPauseReason: (effectiveLimits.canAddRules && !manualPaused && !trafficExceeded
      ? null
      : manualPaused
      ? "manual"
      : trafficExceeded
      ? "traffic_limit"
      : pauseReason) as ForwardAccessPauseReason,
  };
  await updateUserTrafficSettings(userId, nextLimits);
  if (!nextLimits.canAddRules) {
    await disableAllUserRules(userId);
  }
  return nextLimits;
}

export async function updateUserManualEntitlements(userId: number, data: {
  manualTrafficLimit?: number;
  manualGostRateLimitIn?: number;
  manualGostRateLimitOut?: number;
  manualExpiresAt?: Date | null;
  manualCanAddRules?: boolean;
  manualMaxRules?: number;
  manualMaxPorts?: number;
  manualMaxConnections?: number;
  manualMaxIPs?: number;
  manualAllowForwardXTunnel?: boolean;
  allowedForwardTypes?: string | null;
  displayRemark?: string | null;
  trafficAutoReset?: boolean;
  trafficResetDay?: number;
  forwardAccessPauseReason?: ForwardAccessPauseReason;
}) {
  await updateUserTrafficSettings(userId, data as any);
  return syncUserSubscriptionEntitlements(userId);
}

export async function backfillManualEntitlementsFromEffectiveUsers() {
  if (await getSetting("manual-entitlements-backfill-v1")) return;
  const allUsers = await getAllUsers();
  for (const user of allUsers as any[]) {
    if (user.role === "admin") continue;
    const planLimits = await getEffectiveUserPlanLimits(Number(user.id));
    const hasPlan = !!planLimits.canAddRules;
    const manualCanAddRules = !!user.canAddRules && !hasPlan;
    const overPlan = (effective: unknown, plan: unknown) => {
      const current = positiveInt(effective);
      const planValue = positiveInt(plan);
      if (!hasPlan) return current;
      if (current === 0) return planValue === 0 ? 0 : 0;
      if (planValue === 0) return 0;
      return current > planValue ? current : 0;
    };
    const manualExpiresAt = hasPlan ? null : (user.expiresAt ? new Date(user.expiresAt) : null);
    await updateUserTrafficSettings(Number(user.id), {
      manualCanAddRules,
      manualAllowForwardXTunnel: manualCanAddRules && !!user.allowForwardXTunnel,
      manualMaxRules: overPlan(user.maxRules, planLimits.maxRules),
      manualMaxPorts: overPlan(user.maxPorts, planLimits.maxPorts),
      manualMaxConnections: overPlan(user.maxConnections, planLimits.maxConnections),
      manualMaxIPs: overPlan(user.maxIPs, planLimits.maxIPs),
      manualGostRateLimitIn: overPlan(user.gostRateLimitIn, planLimits.gostRateLimitIn),
      manualGostRateLimitOut: overPlan(user.gostRateLimitOut, planLimits.gostRateLimitOut),
      manualTrafficLimit: overPlan(user.trafficLimit, planLimits.trafficLimit),
      manualExpiresAt,
    } as any);
    await syncUserSubscriptionEntitlements(Number(user.id));
  }
  await setSetting("manual-entitlements-backfill-v1", String(Math.floor(Date.now() / 1000)));
}

export async function rechargeSubscriptionTrafficCycles() {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const due = await db.select().from(userSubscriptions).where(and(
    eq(userSubscriptions.status, "active"),
    sql`${userSubscriptions.nextTrafficResetAt} IS NOT NULL`,
    sql`${userSubscriptions.nextTrafficResetAt} <= ${nowSec}`,
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${nowSec})`,
  ));
  const resetUserIds = new Set<number>();
  for (const sub of due as any[]) {
    const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    let next = sub.nextTrafficResetAt ? new Date(sub.nextTrafficResetAt) : null;
    if (!next) continue;
    while (next && next.getTime() <= now.getTime()) {
      next = addMonthsClamped(next, 1);
    }
    const boundedNext = next && (!expiresAt || next.getTime() < expiresAt.getTime()) ? next : null;
    await updateUserSubscription(sub.id, {
      nextTrafficResetAt: boundedNext,
      lastTrafficResetAt: now,
    } as any);
    resetUserIds.add(Number(sub.userId));
  }
  await expireTrafficAddonsForSubscriptionIds((due as any[]).map((sub: any) => Number(sub.id)).filter((id: number) => id > 0));
  for (const userId of resetUserIds) {
    await resetUserTraffic(userId);
    await syncUserSubscriptionEntitlements(userId);
  }
  return resetUserIds.size;
}

export async function getUserPlanPortRange(userId: number, hostId?: number, tunnelId?: number): Promise<{ start: number; end: number } | null> {
  const active = await getActiveUserSubscriptions(userId);
  for (const sub of active as any[]) {
    if (!sub.portRangeStart || !sub.portRangeEnd) continue;
    if (tunnelId && Array.isArray(sub.tunnelIds) && sub.tunnelIds.includes(tunnelId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
    if (!tunnelId && hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
    if (hostId && Array.isArray(sub.hostIds) && sub.hostIds.includes(hostId)) return { start: sub.portRangeStart, end: sub.portRangeEnd };
  }
  return null;
}

export async function getUserForwardGroupPlanPortRange(userId: number, forwardGroupId: number): Promise<{ start: number; end: number } | null> {
  const active = await getActiveUserSubscriptions(userId);
  for (const sub of active as any[]) {
    if (!sub.portRangeStart || !sub.portRangeEnd) continue;
    if (Array.isArray(sub.forwardGroupIds) && sub.forwardGroupIds.includes(forwardGroupId)) {
      return { start: sub.portRangeStart, end: sub.portRangeEnd };
    }
  }
  return null;
}

export async function findAvailableSubscriptionPortBlock(portCount: number, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = []) {
  const db = await getDb();
  if (!db) return null;
  const count = Math.max(1, portCount);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const hostId of hostIds) {
    const host = await getHostById(hostId);
    if (!host) continue;
    const start = Number((host as any).portRangeStart || 10000);
    const end = Number((host as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId);
    if (!tunnel) continue;
    const start = Number((tunnel as any).portRangeStart || 10000);
    const end = Number((tunnel as any).portRangeEnd || 65535);
    ranges.push({ start, end });
  }
  for (const forwardGroupId of forwardGroupIds) {
    const range = await getForwardGroupEntryPortRange(forwardGroupId);
    if (!range) continue;
    ranges.push(range);
  }
  const start = ranges.length ? Math.max(...ranges.map((r) => r.start)) : 10000;
  const end = ranges.length ? Math.min(...ranges.map((r) => r.end)) : 65535;
  if (start <= 0 || end < start || end - start + 1 < count) return null;

  const used = new Set<number>();
  const ruleRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  (ruleRows as any[]).forEach((row: any) => used.add(Number(row.port)));
  const subRows = await db.select({
    portRangeStart: userSubscriptions.portRangeStart,
    portRangeEnd: userSubscriptions.portRangeEnd,
  }).from(userSubscriptions).where(and(
    eq(userSubscriptions.status, "active"),
    sql`(${userSubscriptions.expiresAt} IS NULL OR ${userSubscriptions.expiresAt} > ${Math.floor(Date.now() / 1000)})`,
  ));
  (subRows as any[]).forEach((row: any) => {
    const s = Number(row.portRangeStart || 0);
    const e = Number(row.portRangeEnd || 0);
    for (let p = s; p > 0 && p <= e; p++) used.add(p);
  });

  for (let port = start; port <= end - count + 1; port++) {
    let ok = true;
    for (let p = port; p < port + count; p++) {
      if (used.has(p)) {
        ok = false;
        port = p;
        break;
      }
    }
    if (ok) return { start: port, end: port + count - 1 };
  }
  return null;
}

function pickSameActiveSubscription(subscriptions: any[], planId: number) {
  const samePlan = subscriptions.filter((sub: any) => Number(sub.planId) === Number(planId));
  if (samePlan.length === 0) return null;
  return samePlan.sort((a: any, b: any) => {
    const aExpires = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    const bExpires = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    if (aExpires !== bExpires) return bExpires - aExpires;
    return Number(b.id || 0) - Number(a.id || 0);
  })[0];
}

function addSubscriptionDays(base: Date, days: number) {
  return new Date(base.getTime() + days * 24 * 3600 * 1000);
}

export async function applySubscriptionToUser(userId: number, planId: number, source: "admin" | "payment" | "redeem" | "balance", paymentOrderNo?: string | null, startsAt?: Date, overrideDurationDays?: number | null) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) throw new Error("套餐不存在");
  if (!plan.isActive) throw new Error("套餐已停用");
  const hostIds = (plan as any).hostIds || [];
  const tunnelIds = (plan as any).tunnelIds || [];
  const forwardGroupIds = (plan as any).forwardGroupIds || [];
  if (hostIds.length === 0 && tunnelIds.length === 0 && forwardGroupIds.length === 0) throw new Error("套餐未绑定任何端口转发、隧道、转发链或转发组");
  const now = startsAt || new Date();
  const durationDays = overrideDurationDays === null || overrideDurationDays === undefined
    ? Number(plan.durationDays)
    : Number(overrideDurationDays);
  const activeSubscriptions = await getActiveUserSubscriptions(userId);
  const user = await getUserById(userId);
  const hadActiveSubscription = activeSubscriptions.length > 0;
  const sameActiveSubscription = pickSameActiveSubscription(activeSubscriptions as any[], planId);
  if (sameActiveSubscription) {
    const currentExpiresAt = sameActiveSubscription.expiresAt ? new Date(sameActiveSubscription.expiresAt) : null;
    const baseExpiresAt = currentExpiresAt && Number.isFinite(currentExpiresAt.getTime()) && currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;
    const expiresAt = !currentExpiresAt
      ? null
      : durationDays > 0
        ? addSubscriptionDays(baseExpiresAt, durationDays)
        : null;
    const existingNextTrafficResetAt = sameActiveSubscription.nextTrafficResetAt ? new Date(sameActiveSubscription.nextTrafficResetAt) : null;
    let nextTrafficResetAt = existingNextTrafficResetAt && Number.isFinite(existingNextTrafficResetAt.getTime())
      ? existingNextTrafficResetAt
      : null;
    if (Number(plan.trafficLimit || 0) > 0) {
      if (!nextTrafficResetAt || !Number.isFinite(nextTrafficResetAt.getTime()) || nextTrafficResetAt.getTime() <= now.getTime()) {
        nextTrafficResetAt = !existingNextTrafficResetAt && currentExpiresAt && expiresAt && currentExpiresAt.getTime() > now.getTime() && currentExpiresAt.getTime() < expiresAt.getTime()
          ? currentExpiresAt
          : nextMonthlyTrafficReset(now, expiresAt);
      }
      if (expiresAt && nextTrafficResetAt && nextTrafficResetAt.getTime() >= expiresAt.getTime()) {
        nextTrafficResetAt = null;
      }
    } else {
      nextTrafficResetAt = null;
    }

    let portRangeStart = Number(sameActiveSubscription.portRangeStart || 0);
    let portRangeEnd = Number(sameActiveSubscription.portRangeEnd || 0);
    const updateData: Partial<InsertUserSubscription> = {
      status: "active",
      expiresAt,
      nextTrafficResetAt,
      planSnapshot: JSON.stringify(buildPlanSnapshot(plan)),
    } as any;
    if (paymentOrderNo) {
      (updateData as any).paymentOrderNo = paymentOrderNo;
    }
    if (!portRangeStart || !portRangeEnd) {
      const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds, forwardGroupIds);
      if (!block) throw new Error("套餐可用端口不足，无法分配连续端口段");
      portRangeStart = block.start;
      portRangeEnd = block.end;
      (updateData as any).portRangeStart = block.start;
      (updateData as any).portRangeEnd = block.end;
    }
    await updateUserSubscription(Number(sameActiveSubscription.id), updateData);
    await syncUserSubscriptionEntitlements(userId);
    return {
      subscriptionId: Number(sameActiveSubscription.id),
      portRangeStart,
      portRangeEnd,
      expiresAt,
      extended: true,
    };
  }

  const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds, forwardGroupIds);
  if (!block) throw new Error("套餐可用端口不足，无法分配连续端口段");
  const expiresAt = durationDays > 0 ? addSubscriptionDays(now, durationDays) : null;
  const nextTrafficResetAt = Number(plan.trafficLimit || 0) > 0 ? nextMonthlyTrafficReset(now, expiresAt) : null;
  const subscriptionId = await createUserSubscription({
    userId,
    planId,
    status: "active",
    source,
    paymentOrderNo: paymentOrderNo ?? null,
    planSnapshot: JSON.stringify(buildPlanSnapshot(plan)),
    portRangeStart: block.start,
    portRangeEnd: block.end,
    nextTrafficResetAt,
    startedAt: now,
    expiresAt,
  } as any);
  await syncUserSubscriptionEntitlements(userId);
  if (!hadActiveSubscription && Number(user?.trafficUsed || 0) >= Number(user?.trafficLimit || 0) && Number(user?.trafficLimit || 0) > 0) {
    await resetUserTraffic(userId);
    await syncUserSubscriptionEntitlements(userId);
  }
  return { subscriptionId, portRangeStart: block.start, portRangeEnd: block.end, expiresAt };
}

function getTrafficAddonCycleEnd(subscription: any) {
  const now = new Date();
  const nextTrafficResetAt = subscription?.nextTrafficResetAt ? new Date(subscription.nextTrafficResetAt) : null;
  if (nextTrafficResetAt && nextTrafficResetAt.getTime() > now.getTime()) return nextTrafficResetAt;
  const expiresAt = subscription?.expiresAt ? new Date(subscription.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() > now.getTime()) return expiresAt;
  return addMonthsClamped(now, 1);
}

function formatAddonTraffic(bytes: number) {
  const gb = bytes / 1024 / 1024 / 1024;
  return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(2)}GB`;
}

async function getTrafficAddonById(addonId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({
      id: subscriptionPlanTrafficAddons.id,
      planId: subscriptionPlanTrafficAddons.planId,
      planName: subscriptionPlans.name,
      planTrafficLimit: subscriptionPlans.trafficLimit,
      trafficBytes: subscriptionPlanTrafficAddons.trafficBytes,
      priceCents: subscriptionPlanTrafficAddons.priceCents,
      isActive: subscriptionPlanTrafficAddons.isActive,
      sortOrder: subscriptionPlanTrafficAddons.sortOrder,
    })
    .from(subscriptionPlanTrafficAddons)
    .leftJoin(subscriptionPlans, eq(subscriptionPlanTrafficAddons.planId, subscriptionPlans.id))
    .where(eq(subscriptionPlanTrafficAddons.id, addonId))
    .limit(1);
  return rows[0] as any;
}

function pickActiveFiniteTrafficSubscription(activeSubscriptions: any[], planId?: number, subscriptionId?: number) {
  const matched = activeSubscriptions.filter((sub: any) => {
    if (planId && Number(sub.planId) !== Number(planId)) return false;
    if (subscriptionId && Number(sub.id) !== Number(subscriptionId)) return false;
    return Number(sub.trafficLimit || 0) > 0;
  });
  return matched
    .sort((a: any, b: any) => {
      const aEnd = getTrafficAddonCycleEnd(a).getTime();
      const bEnd = getTrafficAddonCycleEnd(b).getTime();
      return aEnd - bEnd;
    })[0];
}

export async function purchaseTrafficAddonWithBalance(userId: number, addonId: number, subscriptionId?: number | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await expireDueTrafficAddons(userId);
  const addon = await getTrafficAddonById(addonId);
  if (!addon || !addon.isActive || Number(addon.trafficBytes || 0) <= 0) throw new Error("流量包不可购买");
  if (Number(addon.planTrafficLimit || 0) <= 0) throw new Error("不限流量套餐无需购买流量包");
  const activeSubscriptions = await getActiveUserSubscriptions(userId);
  const subscription = pickActiveFiniteTrafficSubscription(activeSubscriptions as any[], Number(addon.planId), subscriptionId || undefined);
  if (!subscription) throw new Error("当前没有可购买流量包的生效套餐");
  const amountCents = Number(addon.priceCents || 0);
  const balance = await getUserBalance(userId);
  if (balance < amountCents) throw new Error("余额不足");
  const expiresAt = getTrafficAddonCycleEnd(subscription);
  const description = `购买附加流量：${addon.planName || `套餐 #${addon.planId}`} ${formatAddonTraffic(Number(addon.trafficBytes || 0))}`;
  if (amountCents > 0) {
    await addUserBalance(userId, -amountCents, {
      type: "traffic_addon_purchase",
      description,
    } as any);
  }
  const now = nowDate();
  const id = await insertAndGetId("user_traffic_addons", {
    userId,
    subscriptionId: subscription.id,
    planId: addon.planId,
    addonId: addon.id,
    trafficBytes: Number(addon.trafficBytes || 0),
    priceCents: amountCents,
    source: "user",
    status: "active",
    description,
    cycleResetAt: expiresAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const limits = await syncUserSubscriptionEntitlements(userId);
  return {
    id,
    subscriptionId: subscription.id,
    trafficBytes: Number(addon.trafficBytes || 0),
    priceCents: amountCents,
    expiresAt,
    trafficLimit: limits.trafficLimit,
  };
}

export async function adminAddUserTrafficAddon(input: {
  userId: number;
  trafficBytes: number;
  subscriptionId?: number | null;
  operatorUserId?: number | null;
  description?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const trafficBytes = Math.floor(Number(input.trafficBytes || 0));
  if (!Number.isFinite(trafficBytes) || trafficBytes <= 0) throw new Error("附加流量必须大于 0");
  await expireDueTrafficAddons(input.userId);
  const activeSubscriptions = await getActiveUserSubscriptions(input.userId);
  const subscription = pickActiveFiniteTrafficSubscription(activeSubscriptions as any[], undefined, input.subscriptionId || undefined);
  if (!subscription) throw new Error("该用户没有可附加流量的生效流量套餐");
  const expiresAt = getTrafficAddonCycleEnd(subscription);
  const description = input.description?.trim() || `管理员附加本周期流量：${formatAddonTraffic(trafficBytes)}`;
  const now = nowDate();
  const id = await insertAndGetId("user_traffic_addons", {
    userId: input.userId,
    subscriptionId: subscription.id,
    planId: subscription.planId,
    addonId: null,
    trafficBytes,
    priceCents: 0,
    source: "admin",
    status: "active",
    operatorUserId: input.operatorUserId || null,
    description,
    cycleResetAt: expiresAt,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  const limits = await syncUserSubscriptionEntitlements(input.userId);
  return {
    id,
    subscriptionId: subscription.id,
    trafficBytes,
    expiresAt,
    trafficLimit: limits.trafficLimit,
  };
}

// ==================== Balance ====================

export async function getUserBalance(userId: number) {
  const user = await getUserById(userId);
  return Number((user as any)?.balanceCents || 0);
}

async function addUserBalanceMysql(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const pool = getPool();
  if (!pool) throw new Error("Database not available");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<any[]>("SELECT balanceCents FROM users WHERE id = ? FOR UPDATE", [userId]);
    const row = rows?.[0];
    if (!row) throw new Error("用户不存在");
    const current = Number(row.balanceCents || 0);
    const next = current + Math.round(amountCents);
    if (next < 0) throw new Error("余额不足");
    const now = Math.floor(Date.now() / 1000);
    await conn.execute("UPDATE users SET balanceCents = ?, updatedAt = ? WHERE id = ?", [next, now, userId]);
    await conn.execute(
      "INSERT INTO balance_transactions (userId, type, amountCents, balanceAfterCents, description, operatorUserId, paymentOrderNo, redemptionCodeId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        userId,
        meta.type,
        Math.round(amountCents),
        next,
        meta.description ?? null,
        meta.operatorUserId ?? null,
        meta.paymentOrderNo ?? null,
        meta.redemptionCodeId ?? null,
        now,
      ],
    );
    await conn.commit();
    return { balanceCents: next };
  } catch (error) {
    await conn.rollback().catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

function addUserBalanceSqlite(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error("Database not available");
  const tx = sqlite.transaction(() => {
    const user = sqlite.prepare("SELECT balanceCents FROM users WHERE id = ?").get(userId) as any;
    if (!user) throw new Error("用户不存在");
    const current = Number(user.balanceCents || 0);
    const next = current + Math.round(amountCents);
    if (next < 0) throw new Error("余额不足");
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("UPDATE users SET balanceCents = ?, updatedAt = ? WHERE id = ?").run(next, now, userId);
    sqlite.prepare(
      "INSERT INTO balance_transactions (userId, type, amountCents, balanceAfterCents, description, operatorUserId, paymentOrderNo, redemptionCodeId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      meta.type,
      Math.round(amountCents),
      next,
      meta.description ?? null,
      meta.operatorUserId ?? null,
      meta.paymentOrderNo ?? null,
      meta.redemptionCodeId ?? null,
      now,
    );
    return { balanceCents: next };
  });
  return tx();
}

async function addUserBalancePostgresql(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Database not available");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query('SELECT "balanceCents" FROM "users" WHERE "id" = $1 FOR UPDATE', [userId]);
    const row = rows.rows?.[0];
    if (!row) throw new Error("用户不存在");
    const current = Number(row.balanceCents || 0);
    const next = current + Math.round(amountCents);
    if (next < 0) throw new Error("余额不足");
    const now = Math.floor(Date.now() / 1000);
    await client.query('UPDATE "users" SET "balanceCents" = $1, "updatedAt" = $2 WHERE "id" = $3', [next, now, userId]);
    await client.query(
      'INSERT INTO "balance_transactions" ("userId", "type", "amountCents", "balanceAfterCents", "description", "operatorUserId", "paymentOrderNo", "redemptionCodeId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        userId,
        meta.type,
        Math.round(amountCents),
        next,
        meta.description ?? null,
        meta.operatorUserId ?? null,
        meta.paymentOrderNo ?? null,
        meta.redemptionCodeId ?? null,
        now,
      ],
    );
    await client.query("COMMIT");
    return { balanceCents: next };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listBalanceTransactions(userId?: number, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: balanceTransactions.id,
      userId: balanceTransactions.userId,
      username: users.username,
      name: users.name,
      type: balanceTransactions.type,
      amountCents: balanceTransactions.amountCents,
      balanceAfterCents: balanceTransactions.balanceAfterCents,
      description: balanceTransactions.description,
      operatorUserId: balanceTransactions.operatorUserId,
      paymentOrderNo: balanceTransactions.paymentOrderNo,
      redemptionCodeId: balanceTransactions.redemptionCodeId,
      createdAt: balanceTransactions.createdAt,
    })
    .from(balanceTransactions)
    .leftJoin(users, eq(balanceTransactions.userId, users.id));
  const rows = userId !== undefined
    ? await base.where(eq(balanceTransactions.userId, userId)).orderBy(desc(balanceTransactions.createdAt)).limit(limit)
    : await base.orderBy(desc(balanceTransactions.createdAt)).limit(limit);
  return (rows as any[]).map((row) => ({
    ...row,
    typeLabel: balanceTypeLabel(row.type),
  }));
}

function normalizeBillingLimit(limit = 100) {
  return Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
}

function billingTime(value: unknown) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function paymentStatusLabel(status: string) {
  if (status === "pending") return "待支付";
  if (status === "paid") return "已支付";
  if (status === "processing") return "处理中";
  if (status === "completed") return "已完成";
  if (status === "expired") return "已过期";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return status || "-";
}

function paymentOrderTypeLabel(type: string | null | undefined) {
  if (type === "plan") return "套餐订单";
  if (type === "test") return "测试订单";
  return "余额充值";
}

function balanceTypeLabel(type: string) {
  if (type === "admin_recharge") return "管理员充值";
  if (type === "admin_adjust") return "管理员修改";
  if (type === "payment") return "在线充值入账";
  if (type === "purchase") return "余额消费";
  if (type === "redeem") return "兑换入账";
  if (type === "traffic_billing") return "流量计费";
  if (type === "traffic_addon_purchase") return "购买附加流量";
  return type || "余额变动";
}

function subscriptionSourceLabel(source: string) {
  if (source === "admin") return "管理员分配";
  if (source === "payment") return "在线购买";
  if (source === "redeem") return "兑换套餐";
  if (source === "balance") return "余额购买";
  return source || "套餐变更";
}

export async function listBillingLedger(options?: {
  viewerUserId?: number;
  isAdmin?: boolean;
  userId?: number;
  limit?: number;
}) {
  const limit = normalizeBillingLimit(options?.limit);
  const targetUserId = options?.isAdmin ? options?.userId : options?.viewerUserId;
  if (!options?.isAdmin && !targetUserId) return [];

  const [transactions, orders, subscriptions] = await Promise.all([
    listBalanceTransactions(targetUserId, limit),
    listPaymentOrders(limit, targetUserId),
    listUserSubscriptions(targetUserId),
  ]);

  const items = [
    ...transactions.map((tx: any) => ({
      id: `balance-${tx.id}`,
      sourceId: tx.id,
      kind: "balance",
      category: balanceTypeLabel(tx.type),
      title: balanceTypeLabel(tx.type),
      description: tx.description || "-",
      userId: tx.userId,
      username: tx.username,
      name: tx.name,
      amountCents: Number(tx.amountCents || 0),
      currency: "CNY",
      balanceAfterCents: Number(tx.balanceAfterCents || 0),
      status: "completed",
      statusLabel: "已完成",
      paymentOrderNo: tx.paymentOrderNo,
      redemptionCodeId: tx.redemptionCodeId,
      operatorUserId: tx.operatorUserId,
      createdAt: tx.createdAt,
    })),
    ...orders.map((order: any) => ({
      id: `payment-${order.id}`,
      sourceId: order.id,
      kind: "payment",
      category: paymentOrderTypeLabel(order.orderType),
      title: order.subject || paymentOrderTypeLabel(order.orderType),
      description: order.outTradeNo,
      userId: order.userId,
      username: order.username,
      name: order.name,
      amountCents: Number(order.amountCents || 0),
      currency: order.currency || "CNY",
      status: order.status,
      statusLabel: paymentStatusLabel(order.status),
      paymentType: order.paymentType,
      provider: order.provider,
      paymentOrderNo: order.outTradeNo,
      tradeNo: order.tradeNo,
      planId: order.planId,
      subscriptionId: order.subscriptionId,
      discountAmountCents: Number(order.discountAmountCents || 0),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    })),
    ...subscriptions.map((sub: any) => ({
      id: `subscription-${sub.id}`,
      sourceId: sub.id,
      kind: "subscription",
      category: "套餐记录",
      title: `${subscriptionSourceLabel(sub.source)}：${sub.planName || `套餐 #${sub.planId}`}`,
      description: sub.portRangeStart && sub.portRangeEnd ? `端口段 ${sub.portRangeStart}-${sub.portRangeEnd}` : "-",
      userId: sub.userId,
      username: sub.username,
      name: sub.name,
      amountCents: sub.source === "admin" || sub.source === "redeem" ? 0 : Number(sub.priceCents || 0),
      currency: "CNY",
      status: sub.status,
      statusLabel: sub.status === "active" ? "生效中" : sub.status === "expired" ? "已过期" : sub.status === "cancelled" ? "已取消" : sub.status,
      planId: sub.planId,
      planName: sub.planName,
      paymentOrderNo: sub.paymentOrderNo,
      portRangeStart: sub.portRangeStart,
      portRangeEnd: sub.portRangeEnd,
      startedAt: sub.startedAt,
      expiresAt: sub.expiresAt,
      createdAt: sub.createdAt,
    })),
  ];

  return items
    .sort((a, b) => billingTime(b.createdAt) - billingTime(a.createdAt))
    .slice(0, limit);
}

export async function addUserBalance(userId: number, amountCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!Number.isFinite(amountCents) || amountCents === 0) throw new Error("金额无效");
  const kind = getDatabaseKind();
  if (kind === "mysql") return addUserBalanceMysql(userId, amountCents, meta);
  if (kind === "postgresql") return addUserBalancePostgresql(userId, amountCents, meta);
  if (kind === "sqlite") return addUserBalanceSqlite(userId, amountCents, meta);
  throw new Error("Database not available");
}

export async function setUserBalance(userId: number, balanceCents: number, meta: Omit<InsertBalanceTransaction, "userId" | "amountCents" | "balanceAfterCents">) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (!Number.isFinite(balanceCents) || balanceCents < 0) throw new Error("金额无效");
  const user = await getUserById(userId);
  if (!user) throw new Error("用户不存在");
  const previous = Number((user as any).balanceCents || 0);
  const next = Math.round(balanceCents);
  const delta = next - previous;
  if (delta === 0) {
    return { balanceCents: next, previousBalanceCents: previous, amountCents: 0, changed: false };
  }
  const result = await addUserBalance(userId, delta, meta);
  return { ...result, previousBalanceCents: previous, amountCents: delta, changed: true };
}

export async function purchasePlanWithBalance(userId: number, planId: number, discountCodeId?: number | null) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan || !plan.isActive || !plan.isStoreVisible) throw new Error("套餐不可购买");
  const discount = discountCodeId ? await getDiscountCodeById(discountCodeId) : null;
  if (discount) {
    const allowedPlanIds = Array.isArray((discount as any).planIds) ? (discount as any).planIds.map(Number) : [];
    if (allowedPlanIds.length > 0 && !allowedPlanIds.includes(Number(planId))) {
      throw new Error("折扣码不适用于该套餐");
    }
  }
  const amountCents = calculateDiscountedAmount(Number(plan.priceCents || 0), discount);
  const balance = await getUserBalance(userId);
  if (balance < amountCents) throw new Error("余额不足");
  const result = await applySubscriptionToUser(userId, planId, "balance", null);
  if (amountCents > 0) {
    await addUserBalance(userId, -amountCents, {
      type: "purchase",
      description: `购买套餐：${plan.name}`,
    } as any);
  }
  if (discount) await consumeDiscountCode(discount.id);
  return result;
}

// ==================== Redemption Codes ====================

export async function listRedemptionCodes() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: redemptionCodes.id,
      code: redemptionCodes.code,
      type: redemptionCodes.type,
      planId: redemptionCodes.planId,
      planName: subscriptionPlans.name,
      durationDays: redemptionCodes.durationDays,
      amountCents: redemptionCodes.amountCents,
      startsAt: redemptionCodes.startsAt,
      expiresAt: redemptionCodes.expiresAt,
      isActive: redemptionCodes.isActive,
      usedByUserId: redemptionCodes.usedByUserId,
      usedByUsername: users.username,
      usedAt: redemptionCodes.usedAt,
      createdByUserId: redemptionCodes.createdByUserId,
      createdAt: redemptionCodes.createdAt,
      updatedAt: redemptionCodes.updatedAt,
    })
    .from(redemptionCodes)
    .leftJoin(subscriptionPlans, eq(redemptionCodes.planId, subscriptionPlans.id))
    .leftJoin(users, eq(redemptionCodes.usedByUserId, users.id))
    .orderBy(desc(redemptionCodes.createdAt));
}

export async function createRedemptionCodes(data: Omit<InsertRedemptionCode, "code"> & { code?: string }, count = 1) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const created: string[] = [];
  const total = Math.max(1, Math.min(500, Math.floor(count)));
  for (let i = 0; i < total; i++) {
    const code = normalizeCode(i === 0 && data.code ? data.code : generateBillingCode("FXR"));
    await db.insert(redemptionCodes).values({ ...data, code } as any);
    created.push(code);
  }
  return created;
}

export async function deleteRedemptionCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(redemptionCodes).where(eq(redemptionCodes.id, id));
}

export async function redeemCode(userId: number, code: string, attemptScope?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return withRedemptionScopeLock(userId, attemptScope, async () => {
    const limited = redemptionAttemptRateLimitState(userId, attemptScope);
    if (limited.limited) {
      throw new Error(`兑换过于频繁，请 ${limited.retryAfterSeconds} 秒后再试`);
    }
    const normalized = normalizeCode(code);
    try {
      return await withRedemptionCodeLock(normalized, async () => {
        const rows = await db.select().from(redemptionCodes).where(eq(redemptionCodes.code, normalized)).limit(1);
        const item = rows[0] as any;
        if (!item || !item.isActive) throw new Error("兑换码无效");
        if (item.usedAt || item.usedByUserId) throw new Error("兑换码已被使用");
        const now = new Date();
        if (item.startsAt && new Date(item.startsAt).getTime() > now.getTime()) throw new Error("兑换码尚未生效");
        if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) throw new Error("兑换码已过期");
        if (item.type === "balance") {
          if (Number(item.amountCents) <= 0) throw new Error("兑换码金额无效");
          const balance = await addUserBalance(userId, Number(item.amountCents), {
            type: "redeem",
            description: `兑换余额：${normalized}`,
            redemptionCodeId: item.id,
          } as any);
          await db.update(redemptionCodes).set({ usedByUserId: userId, usedAt: nowDate(), updatedAt: nowDate() } as any).where(eq(redemptionCodes.id, item.id));
          clearRedemptionAttemptFailures(userId, attemptScope);
          return {
            success: true,
            type: item.type,
            amountCents: Number(item.amountCents),
            balanceCents: Number((balance as any)?.balanceCents || 0),
          };
        } else if (item.type === "plan") {
          if (!item.planId) throw new Error("兑换码套餐无效");
          const subscription = await applySubscriptionToUser(userId, Number(item.planId), "redeem", null, now, item.durationDays || null);
          const plan = await getSubscriptionPlanById(Number(item.planId));
          await db.update(redemptionCodes).set({ usedByUserId: userId, usedAt: nowDate(), updatedAt: nowDate() } as any).where(eq(redemptionCodes.id, item.id));
          clearRedemptionAttemptFailures(userId, attemptScope);
          return {
            success: true,
            type: item.type,
            planId: Number(item.planId),
            planName: (plan as any)?.name || null,
            durationDays: Number(item.durationDays || 0),
            expiresAt: subscription.expiresAt,
            portRangeStart: subscription.portRangeStart,
            portRangeEnd: subscription.portRangeEnd,
          };
        } else {
          throw new Error("兑换码类型无效");
        }
      });
    } catch (error) {
      const message = String((error as any)?.message || error || "");
      if (message !== "Database not available" && !message.includes("兑换过于频繁")) {
        recordRedemptionAttemptFailure(userId, attemptScope);
      }
      throw error;
    }
  });
}

// ==================== Discount Codes ====================

export async function listDiscountCodes() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(discountCodes).orderBy(desc(discountCodes.createdAt));
  return attachDiscountPlans(rows);
}

async function getDiscountPlanIds(discountCodeId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ planId: discountCodePlans.planId }).from(discountCodePlans).where(eq(discountCodePlans.discountCodeId, discountCodeId));
  return rows.map((row: any) => Number(row.planId)).filter(Boolean);
}

async function attachDiscountPlans<T extends { id: number }>(codes: T[]) {
  return Promise.all(codes.map(async (code) => ({
    ...code,
    planIds: await getDiscountPlanIds(code.id),
  })));
}

export async function setDiscountCodePlans(discountCodeId: number, planIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(discountCodePlans).where(eq(discountCodePlans.discountCodeId, discountCodeId));
  const uniquePlanIds = Array.from(new Set(planIds.filter(id => Number(id) > 0).map(Number)));
  if (uniquePlanIds.length > 0) {
    await db.insert(discountCodePlans).values(uniquePlanIds.map(planId => ({ discountCodeId, planId })));
  }
}

export async function createDiscountCode(data: InsertDiscountCode, planIds: number[] = []) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const code = normalizeCode(data.code || generateBillingCode("FXD"));
  await db.insert(discountCodes).values({ ...data, code } as any);
  const created = await getDiscountCodeByCode(code);
  if (created) await setDiscountCodePlans(created.id, planIds);
  return getDiscountCodeByCode(code);
}

export async function deleteDiscountCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(discountCodePlans).where(eq(discountCodePlans.discountCodeId, id));
  await db.delete(discountCodes).where(eq(discountCodes.id, id));
}

export async function getDiscountCodeById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(discountCodes).where(eq(discountCodes.id, id)).limit(1);
  if (!rows[0]) return undefined;
  return (await attachDiscountPlans([rows[0]]))[0];
}

export async function getDiscountCodeByCode(code: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(discountCodes).where(eq(discountCodes.code, normalizeCode(code))).limit(1);
  if (!rows[0]) return undefined;
  return (await attachDiscountPlans([rows[0]]))[0];
}

export function discountCodeStatus(code: any) {
  const now = Date.now();
  if (!code?.isActive) return "disabled";
  if (code.startsAt && new Date(code.startsAt).getTime() > now) return "pending";
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now) return "expired";
  if (Number(code.maxUses || 0) > 0 && Number(code.usedCount || 0) >= Number(code.maxUses)) return "used_up";
  return "active";
}

export function calculateDiscountedAmount(amountCents: number, code: any | null | undefined) {
  const amount = Math.max(0, Math.round(amountCents));
  if (!code) return amount;
  if (discountCodeStatus(code) !== "active") throw new Error("折扣码不可用");
  if (code.discountType === "percent") {
    const pct = Math.max(0, Math.min(100, Number(code.discountValue || 0)));
    return Math.max(0, Math.round(amount * (100 - pct) / 100));
  }
  const discount = Math.max(0, Number(code.discountValue || 0));
  return Math.max(0, amount - discount);
}

export async function previewDiscount(code: string, amountCents: number, planId?: number | null) {
  const item = await getDiscountCodeByCode(code);
  if (!item) throw new Error("折扣码不存在");
  const allowedPlanIds = Array.isArray((item as any).planIds) ? (item as any).planIds.map(Number) : [];
  if (allowedPlanIds.length > 0 && (!planId || !allowedPlanIds.includes(Number(planId)))) {
    throw new Error("折扣码不适用于该套餐");
  }
  const finalAmountCents = calculateDiscountedAmount(amountCents, item);
  return {
    discountCodeId: item.id,
    code: item.code,
    originalAmountCents: amountCents,
    finalAmountCents,
    discountAmountCents: Math.max(0, amountCents - finalAmountCents),
    status: discountCodeStatus(item),
  };
}

export async function consumeDiscountCode(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(discountCodes).set({
    usedCount: sql`${discountCodes.usedCount} + 1`,
    updatedAt: nowDate(),
  } as any).where(eq(discountCodes.id, id));
}

export async function listPaymentOrders(limit = 100, userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const base = db
    .select({
      id: paymentOrders.id,
      outTradeNo: paymentOrders.outTradeNo,
      userId: paymentOrders.userId,
      username: users.username,
      name: users.name,
      provider: paymentOrders.provider,
      paymentType: paymentOrders.paymentType,
      status: paymentOrders.status,
      subject: paymentOrders.subject,
      amountCents: paymentOrders.amountCents,
      currency: paymentOrders.currency,
      tradeNo: paymentOrders.tradeNo,
      payUrl: paymentOrders.payUrl,
      qrCode: paymentOrders.qrCode,
      orderType: paymentOrders.orderType,
      planId: paymentOrders.planId,
      subscriptionId: paymentOrders.subscriptionId,
      discountCodeId: paymentOrders.discountCodeId,
      discountAmountCents: paymentOrders.discountAmountCents,
      expiresAt: paymentOrders.expiresAt,
      paidAt: paymentOrders.paidAt,
      createdAt: paymentOrders.createdAt,
      updatedAt: paymentOrders.updatedAt,
    })
    .from(paymentOrders)
    .leftJoin(users, eq(paymentOrders.userId, users.id));
  if (userId !== undefined) {
    return base.where(eq(paymentOrders.userId, userId)).orderBy(desc(paymentOrders.createdAt)).limit(limit);
  }
  return base.orderBy(desc(paymentOrders.createdAt)).limit(limit);
}

export async function updatePaymentOrder(outTradeNo: string, data: Partial<InsertPaymentOrder>) {
  const db = await getDb();
  if (!db) return undefined;
  await db
    .update(paymentOrders)
    .set({ ...data, updatedAt: nowDate() } as Partial<InsertPaymentOrder>)
    .where(eq(paymentOrders.outTradeNo, outTradeNo));
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

function affectedRows(result: any) {
  return rawAffectedRows(result);
}

export async function claimPaidPaymentOrder(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const result = await executeRaw(
    `UPDATE ${quoteDbIdentifier("payment_orders")}
     SET ${quoteDbIdentifier("status")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("outTradeNo")} = ? AND ${quoteDbIdentifier("status")} = ?`,
    ["processing", now, outTradeNo, "paid"],
  );
  if (affectedRows(result) <= 0) return undefined;
  return getPaymentOrderByOutTradeNo(outTradeNo);
}

export async function resetStaleProcessingPaymentOrder(outTradeNo: string, before: Date) {
  const db = await getDb();
  if (!db) return false;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = Math.floor(before.getTime() / 1000);
  const result = await executeRaw(
    `UPDATE ${quoteDbIdentifier("payment_orders")}
     SET ${quoteDbIdentifier("status")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("outTradeNo")} = ?
       AND ${quoteDbIdentifier("status")} = ?
       AND ${quoteDbIdentifier("updatedAt")} < ?`,
    ["paid", now, outTradeNo, "processing", cutoff],
  );
  return affectedRows(result) > 0;
}

export async function markPaymentOrderPaid(outTradeNo: string, data: { tradeNo?: string | null; rawNotify?: string | null; amountCents?: number; currency?: string }) {
  const existing = await getPaymentOrderByOutTradeNo(outTradeNo);
  if (!existing) return undefined;
  if (existing.status === "paid" || existing.status === "processing" || existing.status === "completed") {
    return updatePaymentOrder(outTradeNo, {
      tradeNo: data.tradeNo || existing.tradeNo,
      rawNotify: data.rawNotify || existing.rawNotify,
    } as Partial<InsertPaymentOrder>);
  }
  return updatePaymentOrder(outTradeNo, {
    status: "paid",
    tradeNo: data.tradeNo || existing.tradeNo,
    rawNotify: data.rawNotify || existing.rawNotify,
    currency: data.currency || existing.currency,
    paidAt: nowDate(),
  } as Partial<InsertPaymentOrder>);
}

export async function getBalanceTransactionByPaymentOrderNo(paymentOrderNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(balanceTransactions).where(eq(balanceTransactions.paymentOrderNo, paymentOrderNo)).limit(1);
  return rows[0];
}

export async function getUserSubscriptionByPaymentOrderNo(paymentOrderNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(userSubscriptions).where(eq(userSubscriptions.paymentOrderNo, paymentOrderNo)).limit(1);
  return rows[0];
}

export async function getPaymentOrderStats() {
  const db = await getDb();
  if (!db) return { totalOrders: 0, pendingOrders: 0, paidOrders: 0, paidAmountCents: 0 };
  const rows = await db
    .select({
      totalOrders: sql<number>`COUNT(*)`,
      pendingOrders: sql<number>`SUM(CASE WHEN ${paymentOrders.status} = 'pending' THEN 1 ELSE 0 END)`,
      paidOrders: sql<number>`SUM(CASE WHEN ${paymentOrders.status} IN ('paid', 'processing', 'completed') THEN 1 ELSE 0 END)`,
      paidAmountCents: sql<number>`COALESCE(SUM(CASE WHEN ${paymentOrders.status} IN ('paid', 'processing', 'completed') THEN ${paymentOrders.amountCents} ELSE 0 END), 0)`,
    })
    .from(paymentOrders);
  const row = rows[0];
  return {
    totalOrders: Number(row?.totalOrders || 0),
    pendingOrders: Number(row?.pendingOrders || 0),
    paidOrders: Number(row?.paidOrders || 0),
    paidAmountCents: Number(row?.paidAmountCents || 0),
  };
}



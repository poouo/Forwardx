import crypto from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  balanceTransactions, InsertBalanceTransaction,
  discountCodePlans,
  discountCodes, InsertDiscountCode,
  forwardRules,
  paymentOrders, InsertPaymentOrder,
  redemptionCodes, InsertRedemptionCode,
  subscriptionPlans, InsertSubscriptionPlan,
  subscriptionPlanHosts,
  subscriptionPlanTunnels,
  userSubscriptions, InsertUserSubscription,
  users,
} from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, getPool, getSqlite, insertAndGetId, nowDate } from "../dbRuntime";
import { getHostById } from "./hostRepository";
import { getTunnelById } from "./tunnelRepository";
import { getUserById, resetUserTraffic, updateUserTrafficSettings } from "./userRepository";
import { addMonthsClamped, nextMonthlyTrafficReset } from "./repositoryUtils";

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

export function generateBillingCode(prefix = "") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = crypto.randomBytes(10);
  const bodyLength = Math.max(6, 10 - prefix.length);
  let body = "";
  for (let i = 0; i < bodyLength; i++) {
    body += chars[raw[i] % chars.length];
  }
  return `${prefix}${body}`.slice(0, 10).toUpperCase();
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
  return rows.map(r => r.hostId);
}

async function getPlanTunnelIds(planId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: subscriptionPlanTunnels.tunnelId }).from(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  return rows.map(r => r.tunnelId);
}

async function attachPlanResources<T extends { id: number }>(plans: T[]) {
  return Promise.all(plans.map(async (plan) => ({
    ...plan,
    hostIds: await getPlanHostIds(plan.id),
    tunnelIds: await getPlanTunnelIds(plan.id),
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

export async function createSubscriptionPlan(data: InsertSubscriptionPlan, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = await insertAndGetId("subscription_plans", data as any);
  await setSubscriptionPlanResources(id, hostIds, tunnelIds);
  return getSubscriptionPlanById(id);
}

export async function updateSubscriptionPlan(id: number, data: Partial<InsertSubscriptionPlan>, hostIds?: number[], tunnelIds?: number[]) {
  const db = await getDb();
  if (!db) return undefined;
  await db.update(subscriptionPlans).set({ ...data, updatedAt: nowDate() } as any).where(eq(subscriptionPlans.id, id));
  if (hostIds || tunnelIds) {
    await setSubscriptionPlanResources(id, hostIds ?? await getPlanHostIds(id), tunnelIds ?? await getPlanTunnelIds(id));
  }
  return getSubscriptionPlanById(id);
}

export async function deleteSubscriptionPlan(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, id));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, id));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
}

export async function setSubscriptionPlanResources(planId: number, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.planId, planId));
  await db.delete(subscriptionPlanTunnels).where(eq(subscriptionPlanTunnels.planId, planId));
  const uniqueHostIds = Array.from(new Set(hostIds.filter(id => id > 0)));
  const uniqueTunnelIds = Array.from(new Set(tunnelIds.filter(id => id > 0)));
  if (uniqueHostIds.length > 0) await db.insert(subscriptionPlanHosts).values(uniqueHostIds.map(hostId => ({ planId, hostId })));
  if (uniqueTunnelIds.length > 0) await db.insert(subscriptionPlanTunnels).values(uniqueTunnelIds.map(tunnelId => ({ planId, tunnelId })));
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
      durationDays: subscriptionPlans.durationDays,
      portCount: subscriptionPlans.portCount,
      status: userSubscriptions.status,
      source: userSubscriptions.source,
      paymentOrderNo: userSubscriptions.paymentOrderNo,
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
  if (userId !== undefined) return base.where(eq(userSubscriptions.userId, userId)).orderBy(desc(userSubscriptions.createdAt));
  return base.orderBy(desc(userSubscriptions.createdAt));
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
  return Promise.all(rows.map(async (row) => ({
    ...row,
    hostIds: await getPlanHostIds(row.planId),
    tunnelIds: await getPlanTunnelIds(row.planId),
  })));
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

export async function cancelUserSubscription(id: number) {
  return updateUserSubscription(id, { status: "cancelled" } as any);
}

export async function expireUserSubscriptions() {
  const db = await getDb();
  if (!db) return 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const result: any = await executeRaw(
    "UPDATE user_subscriptions SET status='expired', updatedAt=? WHERE status='active' AND expiresAt IS NOT NULL AND expiresAt <= ?",
    [nowSec, nowSec],
  );
  return Number(result?.affectedRows ?? result?.changes ?? 0);
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
  for (const userId of resetUserIds) {
    await resetUserTraffic(userId);
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

export async function findAvailableSubscriptionPortBlock(portCount: number, hostIds: number[], tunnelIds: number[]) {
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
  const start = ranges.length ? Math.max(...ranges.map(r => r.start)) : 10000;
  const end = ranges.length ? Math.min(...ranges.map(r => r.end)) : 65535;
  if (start <= 0 || end < start || end - start + 1 < count) return null;

  const used = new Set<number>();
  const ruleRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules);
  ruleRows.forEach(row => used.add(Number(row.port)));
  const subRows = await db.select({
    portRangeStart: userSubscriptions.portRangeStart,
    portRangeEnd: userSubscriptions.portRangeEnd,
  }).from(userSubscriptions).where(eq(userSubscriptions.status, "active"));
  subRows.forEach(row => {
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

export async function applySubscriptionToUser(userId: number, planId: number, source: "admin" | "payment" | "redeem" | "balance", paymentOrderNo?: string | null, startsAt?: Date, overrideDurationDays?: number | null) {
  const plan = await getSubscriptionPlanById(planId);
  if (!plan) throw new Error("套餐不存在");
  if (!plan.isActive) throw new Error("套餐已停用");
  const hostIds = (plan as any).hostIds || [];
  const tunnelIds = (plan as any).tunnelIds || [];
  if (hostIds.length === 0 && tunnelIds.length === 0) throw new Error("套餐未绑定任何主机或隧道");
  const block = await findAvailableSubscriptionPortBlock(Number(plan.portCount) || 1, hostIds, tunnelIds);
  if (!block) throw new Error("套餐可用端口不足，无法分配连续端口段");
  const now = startsAt || new Date();
  const durationDays = Number(overrideDurationDays || plan.durationDays);
  const expiresAt = durationDays > 0 ? new Date(now.getTime() + durationDays * 24 * 3600 * 1000) : null;
  const nextTrafficResetAt = Number(plan.trafficLimit || 0) > 0 ? nextMonthlyTrafficReset(now, expiresAt) : null;
  const subscriptionId = await createUserSubscription({
    userId,
    planId,
    status: "active",
    source,
    paymentOrderNo: paymentOrderNo ?? null,
    portRangeStart: block.start,
    portRangeEnd: block.end,
    nextTrafficResetAt,
    startedAt: now,
    expiresAt,
  } as any);
  const user = await getUserById(userId);
  await updateUserTrafficSettings(userId, {
    canAddRules: true,
    allowForwardXTunnel: true,
    maxPorts: Math.max(Number(user?.maxPorts || 0), Number(plan.portCount || 0)),
    maxRules: Math.max(Number(user?.maxRules || 0), Number(plan.maxRules || 0)),
    maxConnections: Math.max(Number((user as any)?.maxConnections || 0), Number((plan as any).maxConnections || 0)),
    maxIPs: Math.max(Number((user as any)?.maxIPs || 0), Number((plan as any).maxIPs || 0)),
    trafficLimit: Math.max(Number(user?.trafficLimit || 0), Number(plan.trafficLimit || 0)),
    gostRateLimitIn: Number(plan.rateLimitMbps || 0) > 0 ? Number(plan.rateLimitMbps) : Number(user?.gostRateLimitIn || 0),
    gostRateLimitOut: Number(plan.rateLimitMbps || 0) > 0 ? Number(plan.rateLimitMbps) : Number(user?.gostRateLimitOut || 0),
    expiresAt: expiresAt && (!user?.expiresAt || new Date(user.expiresAt).getTime() < expiresAt.getTime()) ? expiresAt : user?.expiresAt ?? null,
  });
  return { subscriptionId, portRangeStart: block.start, portRangeEnd: block.end, expiresAt };
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
  if (userId !== undefined) return base.where(eq(balanceTransactions.userId, userId)).orderBy(desc(balanceTransactions.createdAt)).limit(limit);
  return base.orderBy(desc(balanceTransactions.createdAt)).limit(limit);
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
  if (type === "payment") return "在线充值入账";
  if (type === "purchase") return "余额消费";
  if (type === "redeem") return "兑换入账";
  if (type === "traffic_billing") return "流量计费";
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
  if (kind === "sqlite") return addUserBalanceSqlite(userId, amountCents, meta);
  throw new Error("Database not available");
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

export async function redeemCode(userId: number, code: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const normalized = normalizeCode(code);
  const rows = await db.select().from(redemptionCodes).where(eq(redemptionCodes.code, normalized)).limit(1);
  const item = rows[0] as any;
  if (!item || !item.isActive) throw new Error("兑换码无效");
  if (item.usedAt || item.usedByUserId) throw new Error("兑换码已被使用");
  const now = new Date();
  if (item.startsAt && new Date(item.startsAt).getTime() > now.getTime()) throw new Error("兑换码尚未生效");
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= now.getTime()) throw new Error("鍏戞崲鐮佸凡杩囨湡");
  if (item.type === "balance") {
    if (Number(item.amountCents) <= 0) throw new Error("兑换码金额无效");
    await addUserBalance(userId, Number(item.amountCents), {
      type: "redeem",
      description: `兑换余额：${normalized}`,
      redemptionCodeId: item.id,
    } as any);
  } else if (item.type === "plan") {
    if (!item.planId) throw new Error("兑换码套餐无效");
    await applySubscriptionToUser(userId, Number(item.planId), "redeem", null, now, item.durationDays || null);
  } else {
    throw new Error("兑换码类型无效");
  }
  await db.update(redemptionCodes).set({ usedByUserId: userId, usedAt: nowDate(), updatedAt: nowDate() } as any).where(eq(redemptionCodes.id, item.id));
  return { success: true, type: item.type };
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
  return rows.map(row => Number(row.planId)).filter(Boolean);
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
  return Number(result?.affectedRows ?? result?.changes ?? 0);
}

export async function claimPaidPaymentOrder(outTradeNo: string) {
  const db = await getDb();
  if (!db) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const result = await executeRaw(
    "UPDATE payment_orders SET status = ?, updatedAt = ? WHERE outTradeNo = ? AND status = ?",
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
    "UPDATE payment_orders SET status = ?, updatedAt = ? WHERE outTradeNo = ? AND status = ? AND updatedAt < ?",
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



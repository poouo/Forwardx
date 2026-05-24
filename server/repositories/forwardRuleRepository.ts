import { and, desc, eq, sql } from "drizzle-orm";
import { forwardRules, InsertForwardRule, trafficStats } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";

// ==================== Forward Rule Queries ====================

export async function getForwardRules(userId?: number, hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [eq(forwardRules.pendingDelete, false)];
  if (userId) conds.push(eq(forwardRules.userId, userId));
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  return db.select().from(forwardRules).where(and(...conds)).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardRulesForAgent(hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (hostId) {
    return db.select().from(forwardRules).where(eq(forwardRules.hostId, hostId)).orderBy(desc(forwardRules.createdAt));
  }
  return db.select().from(forwardRules).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardRuleById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(forwardRules).where(eq(forwardRules.id, id)).limit(1);
  return r[0];
}

export async function getForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(eq(forwardRules.tunnelId, tunnelId)).orderBy(desc(forwardRules.createdAt));
}

export async function createForwardRule(rule: InsertForwardRule) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("forward_rules", rule as any);
}

export async function updateForwardRule(id: number, data: Partial<InsertForwardRule>) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ ...data, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function deleteForwardRule(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trafficStats).where(eq(trafficStats.ruleId, id));
  await db.delete(forwardRules).where(eq(forwardRules.id, id));
}

export async function markForwardRulePendingDelete(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: true,
    pendingDelete: true,
    updatedAt: nowDate(),
  }).where(eq(forwardRules.id, id));
}

export async function toggleForwardRule(id: number, isEnabled: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled,
    disabledByTunnel: false,
    disabledByUser: false,
    ...(isEnabled ? { protocolBlockReason: null } : {}),
    updatedAt: nowDate(),
  } as any).where(eq(forwardRules.id, id));
}

export async function updateRuleRunningStatus(id: number, isRunning: boolean) {
  const db = await getDb();
  if (!db) return;
  const rule = await getForwardRuleById(id);
  if (rule && (rule as any).pendingDelete && !isRunning) {
    await db.delete(trafficStats).where(eq(trafficStats.ruleId, id));
    await db.delete(forwardRules).where(eq(forwardRules.id, id));
    return;
  }
  await db.update(forwardRules).set({ isRunning, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function disableForwardRuleByProtocolBlock(id: number, reason: string) {
  const db = await getDb();
  if (!db) return;
  const message = String(reason || "Protocol blocked").slice(0, 300);
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    protocolBlockReason: message,
    updatedAt: nowDate(),
  } as any).where(eq(forwardRules.id, id));
}


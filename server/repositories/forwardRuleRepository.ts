import { and, desc, eq, sql } from "drizzle-orm";
import { forwardGroupMembers, forwardRuleTunnelExits, forwardRules, InsertForwardRule } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { boolValue, inList, quoteIdentifier } from "../dbCompat";
import { describePortPolicy, isPortAllowedByPolicy, portPolicyFrom, portPolicyHasRestriction, type PortPolicySource } from "../portPolicy";
import { sqlBool } from "./repositoryUtils";

// ==================== Forward Rule Queries ====================

export async function getForwardRules(userId?: number, hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [
    eq(forwardRules.pendingDelete, false),
    sql`${forwardRules.forwardGroupRuleId} IS NULL`,
    sql`${forwardRules.id} NOT IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)`,
  ];
  if (userId) conds.push(eq(forwardRules.userId, userId));
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  return db.select().from(forwardRules).where(and(...conds)).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardRulesForUserSync(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    eq(forwardRules.isForwardGroupTemplate, false),
  )).orderBy(desc(forwardRules.createdAt));
}

export async function getForwardRulesForAgent(hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [
    eq(forwardRules.isForwardGroupTemplate, false),
    sql`(${forwardRules.pendingDelete} = ${sqlBool(false)} OR ${forwardRules.isRunning} = ${sqlBool(true)})`,
  ];
  if (hostId) {
    conds.push(eq(forwardRules.hostId, hostId));
    return db.select().from(forwardRules).where(and(...conds)).orderBy(desc(forwardRules.createdAt));
  }
  return db.select().from(forwardRules).where(and(...conds)).orderBy(desc(forwardRules.createdAt));
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

export async function getForwardGroupTemplateRules(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupId, groupId),
      eq(forwardRules.isForwardGroupTemplate, true),
      eq(forwardRules.pendingDelete, false),
    ))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRules(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupId, groupId),
      sql`${forwardRules.forwardGroupRuleId} IS NOT NULL`,
    ))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRulesForTemplate(templateRuleId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(eq(forwardRules.forwardGroupRuleId, templateRuleId))
    .orderBy(desc(forwardRules.createdAt));
}

export async function getForwardGroupChildRulesForMember(memberId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(forwardRules)
    .where(and(
      eq(forwardRules.forwardGroupMemberId, memberId),
      eq(forwardRules.pendingDelete, false),
    ))
    .orderBy(desc(forwardRules.createdAt));
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
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    pendingDelete: true,
    updatedAt: nowDate(),
  }).where(eq(forwardRules.id, id));
}

export async function markForwardRulePendingDelete(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
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
    ...(isEnabled ? { isRunning: false, protocolBlockReason: null } : {}),
    updatedAt: nowDate(),
  } as any).where(eq(forwardRules.id, id));
}

export async function updateRuleRunningStatus(id: number, isRunning: boolean) {
  const db = await getDb();
  if (!db) return;
  const rule = await getForwardRuleById(id);
  if (rule && (rule as any).pendingDelete && !isRunning) {
    await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
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

export async function disableForwardRulesOutsideHostPortRange(
  hostId: number,
  policySource?: PortPolicySource | null,
  reason?: string,
) {
  const id = Number(hostId);
  const policy = portPolicyFrom(policySource);
  if (!Number.isFinite(id) || id <= 0 || !portPolicyHasRestriction(policy)) return 0;
  const rows = await getForwardRulesForAgent(id);
  const affected = rows.filter((rule: any) => {
    const port = Number(rule?.sourcePort || 0);
    return port > 0 && !isPortAllowedByPolicy(port, policy);
  });
  if (affected.length === 0) return 0;
  const message = String(reason || `入口端口不在当前主机允许范围 ${describePortPolicy(policy)} 内，请修改端口后再启用。`).slice(0, 300);
  const now = Math.floor(Date.now() / 1000);
  const ids = affected.map((rule: any) => Number(rule.id)).filter((ruleId: number) => Number.isInteger(ruleId) && ruleId > 0);
  if (ids.length === 0) return 0;
  await executeRaw(
    `UPDATE ${quoteIdentifier("forward_rules")}
     SET ${quoteIdentifier("isEnabled")} = ?,
         ${quoteIdentifier("isRunning")} = ?,
         ${quoteIdentifier("protocolBlockReason")} = ?,
         ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("id")} IN ${inList(ids).sql}`,
    [boolValue(false), boolValue(false), message, now, ...ids],
  );
  return affected.length;
}


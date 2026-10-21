import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { forwardGroupMembers, forwardRules, ruleGroups, ruleGroupMembers } from "../../drizzle/schema";
import { MAX_PERSONAL_RULE_GROUPS, type PersonalRuleGroup } from "../../shared/ruleGroups";
import { getDb, getDatabaseKind, insertAndGetId, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { sqlBool } from "./repositoryUtils";
import { quoteIdentifier } from "../dbCompat";

// Drizzle removes column qualifiers in single-table projections. Keep the
// outer reference explicit inside correlated subqueries (not the inner id).
const outerRuleId = () => sql.raw(`${quoteIdentifier("forward_rules")}.${quoteIdentifier("id")}`);

export const withPersonalRuleGroupLock = <T>(userId: number, work: () => Promise<T>) => withDatabaseTransaction(async () => {
  // Use the database's transaction lock, not a JS lock acquired inside an
  // existing forwarding transaction (which can invert SQLite lock order).
  // The owner row also serializes group writes across multiple panel instances.
  const q = quoteIdentifier;
  const rows = await queryRaw(`SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} = ?${getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE"}`, [userId]);
  if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  return work();
});

function visibleOwnRules(userId: number) {
  return and(eq(forwardRules.userId, userId),
    sql`COALESCE(${forwardRules.pendingDelete}, ${sqlBool(false)}) = ${sqlBool(false)}`,
    sql`COALESCE(${forwardRules.forwardGroupRuleId}, 0) = 0`,
    sql`NOT EXISTS (SELECT 1 FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} = ${outerRuleId()})`);
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db;
}

export async function assertPersonalRuleGroups(userId: number, ids: number[]) {
  if (ids.length === 0) return;
  const db = await database();
  const groups = await db.select({ id: ruleGroups.id }).from(ruleGroups).where(and(eq(ruleGroups.userId, userId), inArray(ruleGroups.id, ids)));
  if (groups.length !== new Set(ids).size) throw new TRPCError({ code: "NOT_FOUND", message: "分组不存在或无权访问" });
}

export async function getRulePersonalGroupIds(userId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, number[]>();
  const db = await database();
  const rows = await db.select({ ruleId: ruleGroupMembers.ruleId, groupId: ruleGroupMembers.groupId }).from(ruleGroupMembers)
    .innerJoin(ruleGroups, and(eq(ruleGroups.id, ruleGroupMembers.groupId), eq(ruleGroups.userId, userId)))
    .where(and(eq(ruleGroupMembers.userId, userId), inArray(ruleGroupMembers.ruleId, ids))).orderBy(ruleGroups.sortOrder, ruleGroups.id);
  const result = new Map<number, number[]>();
  for (const row of rows) result.set(Number(row.ruleId), [...(result.get(Number(row.ruleId)) || []), Number(row.groupId)]);
  return result;
}

/** Call only inside the owner's group lock and a database transaction. */
export async function replacePersonalRuleGroups(userId: number, ruleId: number, groupIds: number[]) {
  const db = await database();
  await assertPersonalRuleGroups(userId, groupIds);
  await db.delete(ruleGroupMembers).where(and(eq(ruleGroupMembers.userId, userId), eq(ruleGroupMembers.ruleId, ruleId)));
  if (groupIds.length) await db.insert(ruleGroupMembers).values([...new Set(groupIds)].map(groupId => ({ userId, ruleId, groupId })));
}

export async function getPersonalRuleGroups(userId: number): Promise<{ groups: PersonalRuleGroup[]; total: number; ungrouped: number }> {
  const db = await database();
  const [groups, counts, totals] = await Promise.all([
    db.select().from(ruleGroups).where(eq(ruleGroups.userId, userId)).orderBy(ruleGroups.sortOrder, ruleGroups.id),
    db.select({ groupId: ruleGroupMembers.groupId, count: sql<number>`count(*)` }).from(ruleGroupMembers)
      .innerJoin(forwardRules, eq(forwardRules.id, ruleGroupMembers.ruleId))
      .where(and(eq(ruleGroupMembers.userId, userId), visibleOwnRules(userId))).groupBy(ruleGroupMembers.groupId),
    db.select({ total: sql<number>`count(*)`, ungrouped: sql<number>`COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM ${ruleGroupMembers} WHERE ${ruleGroupMembers.ruleId} = ${outerRuleId()} AND ${ruleGroupMembers.userId} = ${userId}) THEN 1 ELSE 0 END), 0)` })
      .from(forwardRules).where(visibleOwnRules(userId)),
  ]);
  const byGroup = new Map(counts.map((row: any) => [Number(row.groupId || 0), Number(row.count)]));
  return { groups: groups.map((group: any) => ({ id: group.id, name: group.name, sortOrder: group.sortOrder, count: byGroup.get(Number(group.id)) || 0 })),
    total: Number(totals[0]?.total || 0), ungrouped: Number(totals[0]?.ungrouped || 0) };
}

export async function savePersonalRuleGroup(userId: number, name: string, id?: number, changes?: { addRuleIds: number[]; removeRuleIds: number[] }) {
  return withPersonalRuleGroupLock(userId, () => withDatabaseTransaction(async () => {
    const db = await database();
    if (id) await assertPersonalRuleGroups(userId, [id]);
    const groups = await db.select().from(ruleGroups).where(eq(ruleGroups.userId, userId));
    if (groups.some((group: any) => group.id !== id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new TRPCError({ code: "CONFLICT", message: "分组名称已存在" });
    }
    if (id) await db.update(ruleGroups).set({ name }).where(and(eq(ruleGroups.userId, userId), eq(ruleGroups.id, id)));
    else {
      if (groups.length >= MAX_PERSONAL_RULE_GROUPS) throw new TRPCError({ code: "BAD_REQUEST", message: "最多创建 100 个分组" });
      id = await insertAndGetId("rule_groups", { userId, name, sortOrder: groups.reduce((max: number, group: any) => Math.max(max, Number(group.sortOrder)), -1) + 1 });
    }
    // Save the name and only the explicitly changed memberships atomically.
    // Never replace the full member list: the editor loads rules page by page.
    if (changes?.addRuleIds.length) await moveRulesToPersonalGroups(userId, changes.addRuleIds, [id!], "add");
    if (changes?.removeRuleIds.length) await moveRulesToPersonalGroups(userId, changes.removeRuleIds, [id!], "remove");
    return { id: id! };
  }));
}

export async function deletePersonalRuleGroup(userId: number, id: number) {
  return withPersonalRuleGroupLock(userId, () => withDatabaseTransaction(async () => {
    const db = await database();
    await assertPersonalRuleGroups(userId, [id]);
    // Metadata only: never restart, disable or delete forwarding rules.
    await db.delete(ruleGroupMembers).where(and(eq(ruleGroupMembers.userId, userId), eq(ruleGroupMembers.groupId, id)));
    await db.delete(ruleGroups).where(and(eq(ruleGroups.userId, userId), eq(ruleGroups.id, id)));
    return { success: true };
  }));
}

export async function reorderPersonalRuleGroups(userId: number, ids: number[]) {
  return withPersonalRuleGroupLock(userId, () => withDatabaseTransaction(async () => {
    const db = await database();
    const groups = await db.select({ id: ruleGroups.id }).from(ruleGroups).where(eq(ruleGroups.userId, userId));
    if (ids.length !== groups.length || new Set(ids).size !== ids.length || groups.some((group: any) => !ids.includes(Number(group.id)))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "分组列表已变化，请刷新后重试" });
    }
    for (const [sortOrder, id] of ids.entries()) await db.update(ruleGroups).set({ sortOrder }).where(and(eq(ruleGroups.userId, userId), eq(ruleGroups.id, id)));
    return { success: true };
  }));
}

export async function moveRulesToPersonalGroups(userId: number, ids: number[], groupIds: number[], mode: "replace" | "add" | "remove") {
  return withPersonalRuleGroupLock(userId, () => withDatabaseTransaction(async () => {
    const db = await database();
    await assertPersonalRuleGroups(userId, groupIds);
    const uniqueIds = [...new Set(ids)];
    const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(visibleOwnRules(userId), inArray(forwardRules.id, uniqueIds)));
    if (rows.length !== uniqueIds.length) throw new TRPCError({ code: "FORBIDDEN", message: "只能移动自己的规则，且规则必须仍然存在" });
    const current = await getRulePersonalGroupIds(userId, uniqueIds);
    const memberships: { userId: number; ruleId: number; groupId: number }[] = [];
    for (const ruleId of uniqueIds) {
      const before = current.get(ruleId) || [];
      const next = mode === "replace" ? groupIds : mode === "add" ? [...new Set([...before, ...groupIds])] : before.filter(id => !groupIds.includes(id));
      for (const groupId of new Set(next)) memberships.push({ userId, ruleId, groupId });
    }
    await db.delete(ruleGroupMembers).where(and(eq(ruleGroupMembers.userId, userId), inArray(ruleGroupMembers.ruleId, uniqueIds)));
    // Bound SQL parameters for SQLite as well as the server database drivers.
    for (let offset = 0; offset < memberships.length; offset += 200) await db.insert(ruleGroupMembers).values(memberships.slice(offset, offset + 200));
    return { success: true, count: rows.length };
  }));
}

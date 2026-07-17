﻿import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRuleTunnelExits, forwardRules, InsertForwardRule, tunnels } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { queryRaw } from "../dbRuntime";
import { boolValue, inList, quoteIdentifier } from "../dbCompat";
import { describePortPolicy, isPortAllowedByPolicy, portPolicyFrom, portPolicyHasRestriction, type PortPolicySource } from "../portPolicy";
import { sqlBool } from "./repositoryUtils";

// ==================== Forward Rule Queries ====================

export type ForwardRuleSortCategory = "local" | "tunnel" | "chain" | "group";

function forwardRuleCategoryFromRow(row: any): ForwardRuleSortCategory {
  const groupMode = String(row?.groupMode || "").toLowerCase();
  if (groupMode === "port") return "local";
  if (groupMode === "chain") return "chain";
  if (Number(row?.forwardGroupId || 0) > 0) return "group";
  if (Number(row?.tunnelId || 0) > 0) return "tunnel";
  return "local";
}

function forwardRuleCategorySql(ruleAlias = "r", groupAlias = "g") {
  const q = quoteIdentifier;
  return `CASE
    WHEN ${groupAlias}.${q("groupMode")} = 'port' THEN 'local'
    WHEN ${groupAlias}.${q("groupMode")} = 'chain' THEN 'chain'
    WHEN ${ruleAlias}.${q("forwardGroupId")} IS NOT NULL AND ${ruleAlias}.${q("forwardGroupId")} <> 0 THEN 'group'
    WHEN ${ruleAlias}.${q("tunnelId")} IS NOT NULL AND ${ruleAlias}.${q("tunnelId")} <> 0 THEN 'tunnel'
    ELSE 'local'
  END`;
}

async function forwardRuleCategoryForPayload(rule: Partial<InsertForwardRule>): Promise<ForwardRuleSortCategory> {
  const groupId = Number((rule as any).forwardGroupId || 0);
  if (groupId > 0) {
    const q = quoteIdentifier;
    const rows = await queryRaw<{ groupMode: string }>(
      `SELECT ${q("groupMode")} AS ${q("groupMode")} FROM ${q("forward_groups")} WHERE ${q("id")} = ? LIMIT 1`,
      [groupId],
    ).catch(() => []);
    const mode = String(rows[0]?.groupMode || "").toLowerCase();
    if (mode === "port") return "local";
    if (mode === "chain") return "chain";
    return "group";
  }
  return Number((rule as any).tunnelId || 0) > 0 ? "tunnel" : "local";
}

async function nextForwardRuleSortOrder(userId: number, category: ForwardRuleSortCategory) {
  const q = quoteIdentifier;
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(r.${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
      WHERE r.${q("userId")} = ?
        AND r.${q("pendingDelete")} = ?
        AND r.${q("forwardGroupRuleId")} IS NULL
        AND r.${q("id")} NOT IN (
          SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
        )
        AND ${forwardRuleCategorySql("r", "g")} = ?`,
    [userId, boolValue(false), category],
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

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
  return db.select().from(forwardRules).where(and(...conds)).orderBy(sql`${forwardRules.sortOrder} ASC`, desc(forwardRules.createdAt), desc(forwardRules.id));
}

export async function getForwardRulesForUserSync(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.pendingDelete, false),
    eq(forwardRules.isForwardGroupTemplate, false),
  )).orderBy(sql`${forwardRules.sortOrder} ASC`, desc(forwardRules.createdAt), desc(forwardRules.id));
}

export async function getForwardRulesForAgent(hostId?: number) {
  const db = await getDb();
  if (!db) return [];
  const conds: any[] = [
    eq(forwardRules.isForwardGroupTemplate, false),
    sql`(${forwardRules.pendingDelete} = ${sqlBool(false)} OR ${forwardRules.isRunning} = ${sqlBool(true)})`,
  ];
  if (hostId) {
    conds.push(sql`(
      ${forwardRules.hostId} = ${hostId}
      OR ${forwardRules.tunnelId} IN (
        SELECT ${tunnels.id}
        FROM ${tunnels}
        WHERE ${tunnels.entryGroupId} IN (
          SELECT ${forwardGroups.id}
          FROM ${forwardGroups}
          INNER JOIN ${forwardGroupMembers} ON ${forwardGroupMembers.groupId} = ${forwardGroups.id}
          WHERE ${forwardGroups.groupMode} = 'entry'
            AND ${forwardGroups.isEnabled} = ${sqlBool(true)}
            AND ${forwardGroupMembers.memberType} = 'host'
            AND ${forwardGroupMembers.hostId} = ${hostId}
            AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}
        )
      )
    )`);
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
  const payload = { ...(rule as any) };
  if (payload.sortOrder === undefined && !payload.forwardGroupRuleId && !payload.forwardGroupMemberId) {
    payload.sortOrder = await nextForwardRuleSortOrder(Number(payload.userId || 0), await forwardRuleCategoryForPayload(payload));
  }
  return insertAndGetId("forward_rules", payload);
}

export async function reorderForwardRules(category: ForwardRuleSortCategory, ids: number[], userId?: number, startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const idList = inList(orderedIds);
  const q = quoteIdentifier;
  const params: any[] = [...idList.params, boolValue(false)];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND r.${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<any>(
    `SELECT
        r.${q("id")} AS ${q("id")},
        r.${q("userId")} AS ${q("userId")},
        r.${q("tunnelId")} AS ${q("tunnelId")},
        r.${q("forwardGroupId")} AS ${q("forwardGroupId")},
        g.${q("groupMode")} AS ${q("groupMode")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
      WHERE r.${q("id")} IN ${idList.sql}
        AND r.${q("pendingDelete")} = ?
        AND r.${q("forwardGroupRuleId")} IS NULL
        AND r.${q("id")} NOT IN (
          SELECT ${q("ruleId")} FROM ${q("forward_group_members")} WHERE ${q("ruleId")} IS NOT NULL
        )
        ${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在或无权访问的规则");
  if (rows.some((row: any) => forwardRuleCategoryFromRow(row) !== category)) throw new Error("排序规则类型不一致");
  const normalizedStartIndex = Math.max(0, Math.floor(Number(startIndex) || 0));
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(`UPDATE ${q("forward_rules")} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [normalizedStartIndex + index, id]);
  }
}

export async function updateForwardRule(id: number, data: Partial<InsertForwardRule>) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ ...data, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function resetForwardRulesForUserSync(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isRunning: false,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
    eq(forwardRules.isForwardGroupTemplate, false),
  ));
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

export async function finalizeForwardRuleDelete(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  await db.update(forwardGroupMembers).set({
    ruleId: null,
    updatedAt: nowDate(),
  } as any).where(eq(forwardGroupMembers.ruleId, id));
  await db.delete(forwardRules).where(and(
    eq(forwardRules.id, id),
    eq(forwardRules.pendingDelete, true),
  ));
}

export async function purgeSettledPendingForwardRuleDeletes() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({ id: forwardRules.id })
    .from(forwardRules)
    .where(and(
      eq(forwardRules.pendingDelete, true),
      eq(forwardRules.isRunning, false),
    ));
  let count = 0;
  for (const row of rows as any[]) {
    const id = Number(row?.id || 0);
    if (id <= 0) continue;
    await finalizeForwardRuleDelete(id);
    count += 1;
  }
  return count;
}

export async function markOrphanedForwardGroupTemplatesPendingDelete(hostId?: number) {
  const db = await getDb();
  if (!db) return 0;
  const conds: any[] = [
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
    sql`(${forwardRules.forwardGroupId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM ${forwardGroups} WHERE ${forwardGroups.id} = ${forwardRules.forwardGroupId}
    ))`,
  ];
  if (hostId) conds.push(eq(forwardRules.hostId, hostId));
  const templates = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(...conds));
  let count = 0;
  for (const template of templates as any[]) {
    const id = Number(template.id || 0);
    if (id <= 0) continue;
    const children = await db
      .select({ id: forwardRules.id, pendingDelete: forwardRules.pendingDelete })
      .from(forwardRules)
      .where(eq(forwardRules.forwardGroupRuleId, id));
    if ((children as any[]).some((child: any) => !boolValue(child.pendingDelete))) continue;
    await deleteForwardRule(id);
    count += 1;
  }
  return count;
}

export async function toggleForwardRule(id: number, isEnabled: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled,
    disabledByTunnel: false,
    disabledByGroup: false,
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
    await finalizeForwardRuleDelete(id);
    return;
  }
  await db.update(forwardRules).set({ isRunning, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
}

export async function markForwardRulesNotRunning(ids: number[]) {
  const db = await getDb();
  if (!db) return 0;
  const ruleIds = Array.from(new Set(ids
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (ruleIds.length === 0) return 0;
  await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(inArray(forwardRules.id, ruleIds));
  return ruleIds.length;
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


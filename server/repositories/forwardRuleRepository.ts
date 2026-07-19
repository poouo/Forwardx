import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRuleTunnelExits, forwardRules, InsertForwardRule, tunnels } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { queryRaw } from "../dbRuntime";
import { boolLiteral, boolValue, inList, quoteIdentifier } from "../dbCompat";
import { describePortPolicy, isPortAllowedByPolicy, portPolicyFrom, portPolicyHasRestriction, type PortPolicySource } from "../portPolicy";
import { sqlBool } from "./repositoryUtils";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { recordConfigAuditEvent, shouldAuditConfigPatch } from "../configAudit";

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


export type ForwardRuleListCategory = "all" | "local" | "tunnel" | "chain" | "group";

export type ForwardRuleListQuery = PageRequest & {
  ownerUserId?: number;
  allowedForwardGroupIds?: number[];
  entryHostId?: number | null;
  category: ForwardRuleListCategory;
  search?: string;
};

type ForwardRuleFilterControls = {
  includeEntryHost?: boolean;
  includeSearch?: boolean;
  includeCategory?: boolean;
};

type ForwardRuleSqlFilter = {
  fromSql: string;
  whereSql: string;
  params: any[];
  categorySql: string;
};

function normalizeForwardRuleIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeForwardRuleSearchToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function ruleColumn(alias: string, column: string) {
  return alias + "." + quoteIdentifier(column);
}

function forwardRuleListCategorySql() {
  const groupMode = ruleColumn("g", "groupMode");
  return [
    "CASE",
    "  WHEN " + groupMode + " = 'port' THEN 'local'",
    "  WHEN " + groupMode + " = 'chain' THEN 'chain'",
    "  WHEN " + ruleColumn("g", "id") + " IS NOT NULL THEN 'group'",
    "  WHEN " + ruleColumn("r", "forwardType") + " = 'gost'",
    "    AND COALESCE(" + ruleColumn("r", "tunnelId") + ", 0) <> 0 THEN 'tunnel'",
    "  ELSE 'local'",
    "END",
  ].join("\n");
}

function forwardRuleEntryHostSql() {
  return [
    "COALESCE(",
    "  CASE WHEN " + ruleColumn("g", "id") + " IS NOT NULL THEN (",
    "    SELECT COALESCE(" + ruleColumn("gm_entry", "hostId") + ", " + ruleColumn("mt_entry", "entryHostId") + ")",
    "      FROM " + quoteIdentifier("forward_group_members") + " gm_entry",
    "      LEFT JOIN " + quoteIdentifier("tunnels") + " mt_entry",
    "        ON " + ruleColumn("mt_entry", "id") + " = " + ruleColumn("gm_entry", "tunnelId"),
    "     WHERE " + ruleColumn("gm_entry", "groupId") + " = " + ruleColumn("g", "id"),
    "       AND " + ruleColumn("gm_entry", "isEnabled") + " = " + boolLiteral(true),
    "       AND (COALESCE(" + ruleColumn("gm_entry", "hostId") + ", 0) <> 0",
    "         OR COALESCE(" + ruleColumn("gm_entry", "tunnelId") + ", 0) <> 0)",
    "     ORDER BY " + ruleColumn("gm_entry", "priority") + " ASC, " + ruleColumn("gm_entry", "id") + " ASC",
    "     LIMIT 1",
    "  ) END,",
    "  " + ruleColumn("t", "entryHostId") + ",",
    "  " + ruleColumn("r", "hostId"),
    ")",
  ].join("\n");
}

function forwardRuleListFromSql() {
  return [
    "FROM " + quoteIdentifier("forward_rules") + " r",
    "LEFT JOIN " + quoteIdentifier("forward_groups") + " g",
    "  ON " + ruleColumn("g", "id") + " = " + ruleColumn("r", "forwardGroupId"),
    "LEFT JOIN " + quoteIdentifier("tunnels") + " t",
    "  ON " + ruleColumn("t", "id") + " = " + ruleColumn("r", "tunnelId"),
    "LEFT JOIN " + quoteIdentifier("users") + " u",
    "  ON " + ruleColumn("u", "id") + " = " + ruleColumn("r", "userId"),
  ].join("\n");
}

function pushForwardRuleLike(clauses: string[], params: any[], expression: string, pattern: string) {
  clauses.push("LOWER(COALESCE(" + expression + ", '')) LIKE ? ESCAPE '!'");
  params.push(pattern);
}

function buildForwardRuleSqlFilter(
  input: ForwardRuleListQuery,
  controls: ForwardRuleFilterControls = {},
): ForwardRuleSqlFilter {
  const includeEntryHost = controls.includeEntryHost !== false;
  const includeSearch = controls.includeSearch !== false;
  const includeCategory = controls.includeCategory !== false;
  const conditions = [
    ruleColumn("r", "pendingDelete") + " = " + boolLiteral(false),
    ruleColumn("r", "forwardGroupRuleId") + " IS NULL",
    "NOT EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_group_members") + " linked_member"
      + " WHERE " + ruleColumn("linked_member", "ruleId") + " = " + ruleColumn("r", "id") + ")",
  ];
  const params: any[] = [];

  const ownerUserId = Math.floor(Number(input.ownerUserId || 0));
  if (ownerUserId > 0) {
    conditions.push(ruleColumn("r", "userId") + " = ?");
    params.push(ownerUserId);
  }

  if (input.allowedForwardGroupIds !== undefined) {
    const allowedIds = normalizeForwardRuleIds(input.allowedForwardGroupIds);
    const allowed = inList(allowedIds);
    const directRule = [
      "COALESCE(" + ruleColumn("r", "forwardGroupId") + ", 0) = 0",
      ruleColumn("r", "isForwardGroupTemplate") + " = " + boolLiteral(false),
      "COALESCE(" + ruleColumn("r", "forwardGroupMemberId") + ", 0) = 0",
    ].join(" AND ");
    const groupTemplate = allowedIds.length > 0
      ? [
        ruleColumn("r", "isForwardGroupTemplate") + " = " + boolLiteral(true),
        ruleColumn("r", "forwardGroupId") + " IN " + allowed.sql,
        "COALESCE(" + ruleColumn("r", "forwardGroupMemberId") + ", 0) = 0",
      ].join(" AND ")
      : "1 = 0";
    conditions.push("((" + directRule + ") OR (" + groupTemplate + "))");
    params.push(...allowed.params);
  }

  if (includeEntryHost && Number(input.entryHostId || 0) > 0) {
    conditions.push(forwardRuleEntryHostSql() + " = ?");
    params.push(Number(input.entryHostId));
  }

  const categorySql = forwardRuleListCategorySql();
  const tokens = includeSearch
    ? String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
    : [];
  for (const token of tokens) {
    const pattern = "%" + escapeForwardRuleSearchToken(token) + "%";
    const tokenClauses: string[] = [];
    const tokenParams: any[] = [];

    for (const expression of [
      ruleColumn("r", "name"),
      ruleColumn("r", "forwardType"),
      ruleColumn("r", "protocol"),
      ruleColumn("r", "gostMode"),
      ruleColumn("r", "gostRelayHost"),
      ruleColumn("r", "targetIp"),
      ruleColumn("r", "protocolBlockReason"),
      ruleColumn("r", "failoverStrategy"),
      ruleColumn("r", "failoverTargets"),
      ruleColumn("g", "name"),
      ruleColumn("g", "remark"),
      ruleColumn("g", "groupType"),
      ruleColumn("g", "groupMode"),
      ruleColumn("g", "forwardType"),
      ruleColumn("g", "domain"),
      ruleColumn("g", "recordType"),
      ruleColumn("g", "targetIp"),
      ruleColumn("g", "lastDdnsValue"),
      ruleColumn("g", "lastStatus"),
      ruleColumn("g", "lastMessage"),
      ruleColumn("t", "name"),
      ruleColumn("t", "mode"),
      ruleColumn("t", "forwardxVersion"),
      ruleColumn("t", "networkType"),
      ruleColumn("t", "connectHost"),
      ruleColumn("t", "certDomain"),
      ruleColumn("u", "username"),
      ruleColumn("u", "name"),
      ruleColumn("u", "email"),
      ruleColumn("u", "displayRemark"),
    ]) {
      pushForwardRuleLike(tokenClauses, tokenParams, expression, pattern);
    }

    const entryGroupClauses: string[] = [];
    for (const expression of [
      ruleColumn("entry_group", "name"),
      ruleColumn("entry_group", "remark"),
      ruleColumn("entry_group", "domain"),
    ]) {
      pushForwardRuleLike(entryGroupClauses, tokenParams, expression, pattern);
    }
    tokenClauses.push(
      "EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_groups") + " entry_group"
      + " WHERE " + ruleColumn("entry_group", "id") + " = " + ruleColumn("g", "entryGroupId")
      + " AND (" + entryGroupClauses.join(" OR ") + "))",
    );

    const directHostClauses: string[] = [];
    for (const expression of [
      ruleColumn("direct_host", "name"),
      ruleColumn("direct_host", "ip"),
      ruleColumn("direct_host", "ipv4"),
      ruleColumn("direct_host", "ipv6"),
      ruleColumn("direct_host", "entryIp"),
      ruleColumn("direct_host", "tunnelEntryIp"),
    ]) {
      pushForwardRuleLike(directHostClauses, tokenParams, expression, pattern);
    }
    tokenClauses.push(
      "EXISTS (SELECT 1 FROM " + quoteIdentifier("hosts") + " direct_host"
      + " WHERE " + ruleColumn("direct_host", "id") + " IN ("
      + ruleColumn("r", "hostId") + ", " + ruleColumn("t", "entryHostId") + ", " + ruleColumn("t", "exitHostId") + ")"
      + " AND (" + directHostClauses.join(" OR ") + "))",
    );

    const memberClauses: string[] = [];
    for (const expression of [
      ruleColumn("group_member", "connectHost"),
      ruleColumn("member_host", "name"),
      ruleColumn("member_host", "ip"),
      ruleColumn("member_host", "ipv4"),
      ruleColumn("member_host", "ipv6"),
      ruleColumn("member_tunnel", "name"),
      ruleColumn("member_tunnel", "mode"),
      ruleColumn("member_tunnel", "connectHost"),
      ruleColumn("member_entry_host", "name"),
      ruleColumn("member_entry_host", "ip"),
      ruleColumn("member_exit_host", "name"),
      ruleColumn("member_exit_host", "ip"),
    ]) {
      pushForwardRuleLike(memberClauses, tokenParams, expression, pattern);
    }
    tokenClauses.push(
      "EXISTS (SELECT 1 FROM " + quoteIdentifier("forward_group_members") + " group_member"
      + " LEFT JOIN " + quoteIdentifier("hosts") + " member_host"
      + " ON " + ruleColumn("member_host", "id") + " = " + ruleColumn("group_member", "hostId")
      + " LEFT JOIN " + quoteIdentifier("tunnels") + " member_tunnel"
      + " ON " + ruleColumn("member_tunnel", "id") + " = " + ruleColumn("group_member", "tunnelId")
      + " LEFT JOIN " + quoteIdentifier("hosts") + " member_entry_host"
      + " ON " + ruleColumn("member_entry_host", "id") + " = " + ruleColumn("member_tunnel", "entryHostId")
      + " LEFT JOIN " + quoteIdentifier("hosts") + " member_exit_host"
      + " ON " + ruleColumn("member_exit_host", "id") + " = " + ruleColumn("member_tunnel", "exitHostId")
      + " WHERE " + ruleColumn("group_member", "groupId") + " = " + ruleColumn("g", "id")
      + " AND (" + memberClauses.join(" OR ") + "))",
    );

    const numeric = /^\d+$/.test(token) ? Number(token) : 0;
    if (Number.isSafeInteger(numeric) && numeric > 0) {
      for (const expression of [
        ruleColumn("r", "id"),
        ruleColumn("r", "hostId"),
        ruleColumn("r", "userId"),
        ruleColumn("r", "sourcePort"),
        ruleColumn("r", "targetPort"),
        ruleColumn("r", "gostRelayPort"),
        ruleColumn("r", "tunnelId"),
        ruleColumn("r", "forwardGroupId"),
        ruleColumn("g", "id"),
        ruleColumn("g", "sourcePort"),
        ruleColumn("g", "targetPort"),
        ruleColumn("t", "id"),
        ruleColumn("t", "listenPort"),
        ruleColumn("t", "mimicPort"),
      ]) {
        tokenClauses.push(expression + " = ?");
        tokenParams.push(numeric);
      }
    }

    const categoryLabels: Array<[Exclude<ForwardRuleListCategory, "all">, string]> = [
      ["local", "端口转发 本地转发 local port"],
      ["tunnel", "隧道转发 tunnel"],
      ["chain", "转发链 端口转发链 chain"],
      ["group", "转发组 group"],
    ];
    for (const [category, labels] of categoryLabels) {
      if (!labels.toLowerCase().includes(token)) continue;
      tokenClauses.push(categorySql + " = ?");
      tokenParams.push(category);
    }

    conditions.push("(" + tokenClauses.join(" OR ") + ")");
    params.push(...tokenParams);
  }

  if (includeCategory && input.category !== "all") {
    conditions.push(categorySql + " = ?");
    params.push(input.category);
  }

  return {
    fromSql: forwardRuleListFromSql(),
    whereSql: conditions.join("\n  AND "),
    params,
    categorySql,
  };
}

async function hydrateForwardRuleListIds(ids: number[]) {
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  const rows = await db.select().from(forwardRules).where(inArray(forwardRules.id, ids));
  const byId = new Map((rows as any[]).map((row: any) => [Number(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function emptyForwardRuleCategoryCounts() {
  return { all: 0, local: 0, tunnel: 0, chain: 0, group: 0 };
}

export async function getForwardRulesPage(input: ForwardRuleListQuery) {
  const db = await getDb();
  if (!db) {
    return {
      ...pageResult([], 0, input),
      scopeTotalItems: 0,
      activeItems: 0,
      categoryCounts: emptyForwardRuleCategoryCounts(),
    };
  }
  const scopeFilter = buildForwardRuleSqlFilter(input, {
    includeEntryHost: false,
    includeSearch: false,
    includeCategory: false,
  });
  const categoryFilter = buildForwardRuleSqlFilter(input, { includeCategory: false });
  const filtered = buildForwardRuleSqlFilter(input);
  const [scopeRows, totalRows, categoryRows] = await Promise.all([
    queryRaw<{ totalItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems") + "\n"
        + scopeFilter.fromSql + "\nWHERE " + scopeFilter.whereSql,
      scopeFilter.params,
    ),
    queryRaw<{ totalItems: number; activeItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems")
        + ", COALESCE(SUM(CASE WHEN " + ruleColumn("r", "isEnabled") + " = " + boolLiteral(true)
        + " THEN 1 ELSE 0 END), 0) AS " + quoteIdentifier("activeItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ category: string; count: number }>(
      "SELECT " + categoryFilter.categorySql + " AS " + quoteIdentifier("category")
        + ", COUNT(*) AS " + quoteIdentifier("count") + "\n"
        + categoryFilter.fromSql + "\nWHERE " + categoryFilter.whereSql
        + "\nGROUP BY " + categoryFilter.categorySql,
      categoryFilter.params,
    ),
  ]);
  const totalItems = Number(totalRows[0]?.totalItems || 0);
  const activeItems = Number(totalRows[0]?.activeItems || 0);
  const window = pageWindowForTotal(input, totalItems);
  const categoryOrder = input.category === "all" ? filtered.categorySql + " ASC, " : "";
  const idRows = totalItems > 0
    ? await queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql
        + "\nORDER BY " + categoryOrder + ruleColumn("r", "sortOrder") + " ASC, "
        + ruleColumn("r", "createdAt") + " DESC, " + ruleColumn("r", "id") + " DESC"
        + "\nLIMIT ? OFFSET ?",
      [...filtered.params, window.pageSize, window.offset],
    )
    : [];
  const ids = idRows.map((row) => Number(row.id)).filter((id) => id > 0);
  const items = await hydrateForwardRuleListIds(ids);
  const categoryCounts = emptyForwardRuleCategoryCounts();
  for (const row of categoryRows) {
    const category = String(row.category || "") as Exclude<ForwardRuleListCategory, "all">;
    if (!(category in categoryCounts)) continue;
    categoryCounts[category] = Number(row.count || 0);
  }
  categoryCounts.all = categoryCounts.local + categoryCounts.tunnel + categoryCounts.chain + categoryCounts.group;
  return {
    ...pageResult(items, totalItems, window),
    scopeTotalItems: Number(scopeRows[0]?.totalItems || 0),
    activeItems,
    categoryCounts,
  };
}

export async function getForwardRuleMapBatch(
  input: ForwardRuleListQuery,
  cursor: number,
  limit: number,
) {
  const filtered = buildForwardRuleSqlFilter(input);
  const normalizedCursor = Math.max(0, Math.floor(Number(cursor) || 0));
  const normalizedLimit = Math.min(250, Math.max(1, Math.floor(Number(limit) || 100)));
  const [totalRows, idRows] = await Promise.all([
    queryRaw<{ totalItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql
        + "\nORDER BY " + (input.category === "all" ? filtered.categorySql + " ASC, " : "")
        + ruleColumn("r", "sortOrder") + " ASC, " + ruleColumn("r", "createdAt") + " DESC, "
        + ruleColumn("r", "id") + " DESC\nLIMIT ? OFFSET ?",
      [...filtered.params, normalizedLimit, normalizedCursor],
    ),
  ]);
  const totalItems = Number(totalRows[0]?.totalItems || 0);
  const ids = normalizedCursor < totalItems
    ? idRows.map((row) => Number(row.id)).filter((id) => id > 0)
    : [];
  const items = await hydrateForwardRuleListIds(ids);
  return {
    items,
    totalItems,
    nextCursor: normalizedCursor + items.length < totalItems
      ? normalizedCursor + items.length
      : undefined,
  };
}

export async function getForwardRuleSummarySelection(input: ForwardRuleListQuery) {
  const filtered = buildForwardRuleSqlFilter(input);
  const [summaryRows, idRows] = await Promise.all([
    queryRaw<{ totalItems: number; activeItems: number }>(
      "SELECT COUNT(*) AS " + quoteIdentifier("totalItems")
        + ", COALESCE(SUM(CASE WHEN " + ruleColumn("r", "isEnabled") + " = " + boolLiteral(true)
        + " THEN 1 ELSE 0 END), 0) AS " + quoteIdentifier("activeItems") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
    queryRaw<{ id: number }>(
      "SELECT " + ruleColumn("r", "id") + " AS " + quoteIdentifier("id") + "\n"
        + filtered.fromSql + "\nWHERE " + filtered.whereSql,
      filtered.params,
    ),
  ]);
  return {
    totalItems: Number(summaryRows[0]?.totalItems || 0),
    activeItems: Number(summaryRows[0]?.activeItems || 0),
    ruleIds: idRows.map((row) => Number(row.id)).filter((id) => id > 0),
  };
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

export async function getForwardRulesForAgentScope(hostId: number, tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set(tunnelIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  const scope = ids.length > 0
    ? sql`(${forwardRules.hostId} = ${hostId} OR ${forwardRules.tunnelId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`
    : eq(forwardRules.hostId, hostId);
  return db.select().from(forwardRules).where(and(
    eq(forwardRules.isForwardGroupTemplate, false),
    sql`(${forwardRules.pendingDelete} = ${sqlBool(false)} OR ${forwardRules.isRunning} = ${sqlBool(true)})`,
    scope,
  )).orderBy(desc(forwardRules.createdAt));
}

export async function repairConflictingProtocolPortRules() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(forwardRules).where(and(
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  )).orderBy(forwardRules.hostId, forwardRules.sourcePort, forwardRules.id);
  const byPort = new Map<string, any[]>();
  for (const row of rows as any[]) {
    const key = `${Number(row.hostId)}:${Number(row.sourcePort)}`;
    const items = byPort.get(key) || [];
    items.push(row);
    byPort.set(key, items);
  }
  const repaired: Array<{ keptRuleId: number; disabledRuleId: number; hostId: number; sourcePort: number }> = [];
  for (const items of byPort.values()) {
    if (items.length <= 1) continue;
    const [kept, ...duplicates] = items.sort((left, right) => Number(left.id) - Number(right.id));
    for (const duplicate of duplicates) {
      await db.update(forwardRules).set({
        isEnabled: false,
        isRunning: false,
        protocolBlockReason: `同一主机端口只能由一条规则管理；与规则 #${kept.id} 冲突，请合并为 TCP + UDP 后重新启用`,
        updatedAt: nowDate(),
      } as any).where(eq(forwardRules.id, Number(duplicate.id)));
      repaired.push({
        keptRuleId: Number(kept.id),
        disabledRuleId: Number(duplicate.id),
        hostId: Number(duplicate.hostId),
        sourcePort: Number(duplicate.sourcePort),
      });
    }
  }
  return repaired;
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
  const id = await insertAndGetId("forward_rules", payload);
  const created = await getForwardRuleById(id).catch(() => undefined);
  await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((created as any)?.hostId || 0), action: "create", after: created });
  return id;
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
  const audit = shouldAuditConfigPatch(data as any);
  const before = audit ? await getForwardRuleById(id).catch(() => undefined) : undefined;
  await db.update(forwardRules).set({ ...data, updatedAt: nowDate() }).where(eq(forwardRules.id, id));
  if (audit && before) {
    const after = await getForwardRuleById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((after as any)?.hostId || (before as any)?.hostId || 0), action: "update", before, after });
  }
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
  const before = await getForwardRuleById(id).catch(() => undefined);
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, id));
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    pendingDelete: true,
    updatedAt: nowDate(),
  }).where(eq(forwardRules.id, id));
  if (before) await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((before as any).hostId || 0), action: "delete", before });
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
  const before = await getForwardRuleById(id).catch(() => undefined);
  await db.update(forwardRules).set({
    isEnabled,
    disabledByTunnel: false,
    disabledByGroup: false,
    disabledByUser: false,
    ...(isEnabled ? { isRunning: false, protocolBlockReason: null } : {}),
    updatedAt: nowDate(),
  } as any).where(eq(forwardRules.id, id));
  if (before) {
    const after = await getForwardRuleById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "forward_rule", resourceId: id, hostId: Number((after as any)?.hostId || (before as any).hostId || 0), action: "update", before, after });
  }
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


import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  agentTokens,
  forwardGroupMembers,
  forwardRuleTunnelExits,
  forwardRules,
  hostGroupMembers,
  hostGroups,
  hostMetrics,
  hostProbeServiceStats,
  hosts,
  hostTrafficCounters,
  InsertHost,
  subscriptionPlanHosts,
  trafficBillingConfigs,
  trafficStats,
  trafficStatBuckets,
  tunnelExitNodes,
  tunnelHops,
  tunnels,
  userHostPermissions,
} from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw, refreshDatabasePoolSettings } from "../dbRuntime";
import { boolValue, inList, quoteIdentifier, sqlCountAll } from "../dbCompat";
import { repairPortForwardRuleHostReferences } from "../portForwardRuleHosts";
import { sqlBool } from "./repositoryUtils";
import { markOrphanedForwardGroupTemplatesPendingDelete } from "./forwardRuleRepository";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { recordConfigAuditEvent, shouldAuditConfigPatch } from "../configAudit";

// ==================== Host Queries ====================

export const HOST_ONLINE_TTL_MS = 150 * 1000;

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

export type HostListQuery = PageRequest & {
  ownerUserId?: number;
  allowedHostIds?: number[];
  search?: string;
  groupId?: number | null;
  orderByGroups?: boolean;
};

function normalizeIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeLikeToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function hostListCondition(input: Omit<HostListQuery, keyof PageRequest>) {
  const conditions: any[] = [];
  if (Number(input.ownerUserId || 0) > 0) {
    const allowedIds = normalizeIds(input.allowedHostIds);
    conditions.push(allowedIds.length > 0
      ? or(eq(hosts.userId, Number(input.ownerUserId)), inArray(hosts.id, allowedIds))
      : eq(hosts.userId, Number(input.ownerUserId)));
  }
  if (Number(input.groupId || 0) > 0) {
    conditions.push(sql`EXISTS (
      SELECT 1
      FROM ${hostGroupMembers}
      INNER JOIN ${hostGroups} ON ${hostGroups.id} = ${hostGroupMembers.groupId}
      WHERE ${hostGroupMembers.hostId} = ${hosts.id}
        AND ${hostGroupMembers.groupId} = ${Number(input.groupId)}
        AND ${hostGroups.isEnabled} = ${sqlBool(true)}
    )`);
  }
  const tokens = String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const pattern = `%${escapeLikeToken(token)}%`;
    const textConditions = [
      hosts.name,
      hosts.ip,
      hosts.ipv4,
      hosts.ipv6,
      hosts.entryIp,
      hosts.tunnelEntryIp,
      hosts.osInfo,
      hosts.cpuInfo,
      hosts.agentVersion,
      hosts.hostType,
    ].map((column) => sql`LOWER(COALESCE(${column}, '')) LIKE ${pattern} ESCAPE '!'`);
    const numericId = /^\d+$/.test(token) ? Number(token) : 0;
    conditions.push(or(
      ...textConditions,
      ...(numericId > 0 ? [eq(hosts.id, numericId)] : []),
    ));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function hostListOrder(input: Omit<HostListQuery, keyof PageRequest>) {
  if (Number(input.groupId || 0) > 0) {
    return [
      sql`(
        SELECT ${hostGroupMembers.sortOrder}
        FROM ${hostGroupMembers}
        WHERE ${hostGroupMembers.groupId} = ${Number(input.groupId)}
          AND ${hostGroupMembers.hostId} = ${hosts.id}
        ORDER BY ${hostGroupMembers.sortOrder} ASC, ${hostGroupMembers.id} ASC
        LIMIT 1
      ) ASC`,
      asc(hosts.sortOrder),
      desc(hosts.createdAt),
      desc(hosts.id),
    ];
  }
  if (input.orderByGroups) {
    const firstGroupSort = sql`(
      SELECT ${hostGroups.sortOrder}
      FROM ${hostGroupMembers}
      INNER JOIN ${hostGroups} ON ${hostGroups.id} = ${hostGroupMembers.groupId}
      WHERE ${hostGroupMembers.hostId} = ${hosts.id}
        AND ${hostGroups.isEnabled} = ${sqlBool(true)}
      ORDER BY ${hostGroups.sortOrder} ASC, ${hostGroups.id} ASC, ${hostGroupMembers.sortOrder} ASC, ${hostGroupMembers.id} ASC
      LIMIT 1
    )`;
    const firstMemberSort = sql`(
      SELECT ${hostGroupMembers.sortOrder}
      FROM ${hostGroupMembers}
      INNER JOIN ${hostGroups} ON ${hostGroups.id} = ${hostGroupMembers.groupId}
      WHERE ${hostGroupMembers.hostId} = ${hosts.id}
        AND ${hostGroups.isEnabled} = ${sqlBool(true)}
      ORDER BY ${hostGroups.sortOrder} ASC, ${hostGroups.id} ASC, ${hostGroupMembers.sortOrder} ASC, ${hostGroupMembers.id} ASC
      LIMIT 1
    )`;
    return [
      sql`CASE WHEN ${firstGroupSort} IS NULL THEN 1 ELSE 0 END ASC`,
      sql`${firstGroupSort} ASC`,
      sql`${firstMemberSort} ASC`,
      asc(hosts.sortOrder),
      desc(hosts.createdAt),
      desc(hosts.id),
    ];
  }
  return [asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id)];
}

export async function getHostsPage(input: HostListQuery) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), scopeTotalItems: 0, onlineItems: 0, versionCounts: [] };
  const condition = hostListCondition(input);
  const cutoffSeconds = Math.floor((Date.now() - HOST_ONLINE_TTL_MS) / 1000);
  const onlineExpression = sql<number>`CASE
    WHEN ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
    THEN 1 ELSE 0 END`;
  const aggregateQuery = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      onlineItems: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  const [totals] = condition ? await aggregateQuery.where(condition) : await aggregateQuery;
  const totalItems = Number(totals?.totalItems || 0);
  const onlineItems = Number(totals?.onlineItems || 0);
  const scopeCondition = hostListCondition({
    ownerUserId: input.ownerUserId,
    allowedHostIds: input.allowedHostIds,
  });
  let scopeTotalItems = totalItems;
  if (String(input.search || "").trim() || Number(input.groupId || 0) > 0) {
    const scopeQuery = db.select({ count: sql<number>`COUNT(*)` }).from(hosts);
    const [scopeTotals] = scopeCondition ? await scopeQuery.where(scopeCondition) : await scopeQuery;
    scopeTotalItems = Number(scopeTotals?.count || 0);
  }
  const window = pageWindowForTotal(input, totalItems);
  const listQuery = db.select().from(hosts);
  const pageRows = condition
    ? await listQuery.where(condition).orderBy(...hostListOrder(input)).limit(window.pageSize).offset(window.offset)
    : await listQuery.orderBy(...hostListOrder(input)).limit(window.pageSize).offset(window.offset);
  const versionQuery = db
    .select({
      agentVersion: hosts.agentVersion,
      count: sql<number>`COUNT(*)`,
      onlineCount: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  const versionRows = condition
    ? await versionQuery.where(condition).groupBy(hosts.agentVersion)
    : await versionQuery.groupBy(hosts.agentVersion);
  const versionCounts = versionRows.flatMap((row: any) => {
    const count = Math.max(0, Number(row.count || 0));
    const onlineCount = Math.min(count, Math.max(0, Number(row.onlineCount || 0)));
    const offlineCount = count - onlineCount;
    return [
      ...(onlineCount > 0 ? [{ agentVersion: row.agentVersion || null, online: true, count: onlineCount }] : []),
      ...(offlineCount > 0 ? [{ agentVersion: row.agentVersion || null, online: false, count: offlineCount }] : []),
    ];
  });
  return {
    ...pageResult(pageRows.map(withComputedOnline), totalItems, window),
    scopeTotalItems,
    onlineItems,
    versionCounts,
  };
}

export async function getHostSummaryScope(input: Omit<HostListQuery, keyof PageRequest>) {
  const db = await getDb();
  if (!db) return { hostIds: [] as number[], totalHosts: 0, onlineHosts: 0 };
  const condition = hostListCondition(input);
  const cutoffSeconds = Math.floor((Date.now() - HOST_ONLINE_TTL_MS) / 1000);
  const onlineExpression = sql<number>`CASE
    WHEN ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
    THEN 1 ELSE 0 END`;
  const aggregate = db
    .select({
      totalHosts: sql<number>`COUNT(*)`,
      onlineHosts: sql<number>`COALESCE(SUM(${onlineExpression}), 0)`,
    })
    .from(hosts);
  const idsQuery = db.select({ id: hosts.id }).from(hosts);
  const [totals, idRows] = await Promise.all([
    condition ? aggregate.where(condition) : aggregate,
    condition ? idsQuery.where(condition) : idsQuery,
  ]);
  return {
    hostIds: idRows.map((row: any) => Number(row.id)).filter((id: number) => id > 0),
    totalHosts: Number(totals[0]?.totalHosts || 0),
    onlineHosts: Number(totals[0]?.onlineHosts || 0),
  };
}

export async function getHostStatusRows(input: Omit<HostListQuery, keyof PageRequest> & { hostIds: number[] }) {
  const db = await getDb();
  if (!db) return [];
  const requestedIds = normalizeIds(input.hostIds);
  if (requestedIds.length === 0) return [];
  const scopeCondition = hostListCondition(input);
  const idCondition = inArray(hosts.id, requestedIds);
  const condition = scopeCondition ? and(scopeCondition, idCondition) : idCondition;
  const rows = await db
    .select({
      id: hosts.id,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
      agentVersion: hosts.agentVersion,
      agentUpgradeRequested: hosts.agentUpgradeRequested,
      agentUpgradeTargetVersion: hosts.agentUpgradeTargetVersion,
      agentUpgradeRequestedAt: hosts.agentUpgradeRequestedAt,
      updatedAt: hosts.updatedAt,
    })
    .from(hosts)
    .where(condition);
  return rows.map(withComputedOnline);
}

export async function getHostUpgradeCandidates(input: Omit<HostListQuery, keyof PageRequest>) {
  const db = await getDb();
  if (!db) return [];
  const condition = hostListCondition(input);
  const query = db
    .select({
      id: hosts.id,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
      agentVersion: hosts.agentVersion,
      agentUpgradeRequested: hosts.agentUpgradeRequested,
      agentUpgradeTargetVersion: hosts.agentUpgradeTargetVersion,
      agentUpgradeRequestedAt: hosts.agentUpgradeRequestedAt,
    })
    .from(hosts);
  const rows = condition ? await query.where(condition) : await query;
  return rows.map(withComputedOnline);
}

export async function getHostOptions(ownerUserId?: number, allowedHostIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const condition = hostListCondition({ ownerUserId, allowedHostIds });
  const query = db
    .select({
      id: hosts.id,
      userId: hosts.userId,
      name: hosts.name,
      ip: hosts.ip,
      ipv4: hosts.ipv4,
      ipv6: hosts.ipv6,
      entryIp: hosts.entryIp,
      tunnelEntryIp: hosts.tunnelEntryIp,
      hostType: hosts.hostType,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
      agentVersion: hosts.agentVersion,
      ddnsEnabled: hosts.ddnsEnabled,
      ddnsDomain: hosts.ddnsDomain,
      portRangeStart: hosts.portRangeStart,
      portRangeEnd: hosts.portRangeEnd,
      portAllowlist: hosts.portAllowlist,
      blockHttp: hosts.blockHttp,
      blockSocks: hosts.blockSocks,
      blockTls: hosts.blockTls,
      geoCountryCode: hosts.geoCountryCode,
      geoCountryName: hosts.geoCountryName,
      geoRegion: hosts.geoRegion,
      geoEmoji: hosts.geoEmoji,
      geoLatitudeMicro: hosts.geoLatitudeMicro,
      geoLongitudeMicro: hosts.geoLongitudeMicro,
      geoUpdatedAt: hosts.geoUpdatedAt,
    })
    .from(hosts);
  const rows = condition
    ? await query.where(condition).orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id))
    : await query.orderBy(asc(hosts.sortOrder), desc(hosts.createdAt), desc(hosts.id));
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
  const id = await insertAndGetId("hosts", host as any);
  const created = await getHostById(id).catch(() => undefined);
  await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "create", after: created });
  await refreshDatabasePoolSettings().catch(() => undefined);
  return id;
}

export async function updateHost(id: number, data: Partial<InsertHost>) {
  const db = await getDb();
  if (!db) return;
  const audit = shouldAuditConfigPatch(data as any);
  const before = audit ? await getHostById(id).catch(() => undefined) : undefined;
  await db.update(hosts).set({ ...data, updatedAt: nowDate() }).where(eq(hosts.id, id));
  if (audit && before) {
    const after = await getHostById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "update", before, after });
  }
}

export async function reorderHosts(ids: number[], userId?: number, startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = Array.from(ids)
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const idList = inList(orderedIds);
  const q = quoteIdentifier;
  const params: any[] = [...idList.params];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} FROM ${q("hosts")} WHERE ${q("id")} IN ${idList.sql}${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error("排序中包含无权操作或不存在的主机");
  const normalizedStartIndex = Math.max(0, Math.floor(Number(startIndex) || 0));
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(`UPDATE ${q("hosts")} SET ${q("sortOrder")} = ?, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [normalizedStartIndex + index, Math.floor(Date.now() / 1000), id]);
  }
}

export async function deleteHost(id: number) {
  const db = await getDb();
  if (!db) return;
  const before = await getHostById(id).catch(() => undefined);
  await repairPortForwardRuleHostReferences();
  await db.delete(forwardRules).where(eq(forwardRules.hostId, id));
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.exitHostId, id));
  await db.delete(agentTokens).where(eq(agentTokens.hostId, id));
  await db.delete(userHostPermissions).where(eq(userHostPermissions.hostId, id));
  await db.delete(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.hostId, id));
  await db.delete(hostGroupMembers).where(eq(hostGroupMembers.hostId, id));
  await db.delete(hostMetrics).where(eq(hostMetrics.hostId, id));
  await db.delete(hostProbeServiceStats).where(eq(hostProbeServiceStats.hostId, id));
  await db.delete(hostTrafficCounters).where(eq(hostTrafficCounters.hostId, id));
  await db.delete(trafficStats).where(eq(trafficStats.hostId, id));
  await db.delete(trafficStatBuckets).where(eq(trafficStatBuckets.hostId, id));
  await db.delete(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, "host"),
    eq(trafficBillingConfigs.resourceId, id),
  ));
  await db.delete(hosts).where(eq(hosts.id, id));
  if (before) await recordConfigAuditEvent({ resourceType: "host", resourceId: id, hostId: id, action: "delete", before });
  await refreshDatabasePoolSettings().catch(() => undefined);
}

async function hostHasLiveReferences(hostId: number) {
  const db = await getDb();
  if (!db) return true;
  const [ruleBlockers, forwardGroupRows, tunnelRows, tunnelHopRows, tunnelExitRows, planRows, tokenRows] = await Promise.all([
    getHostRuleDeleteBlockers(hostId),
    db.select({ count: sqlCountAll() }).from(forwardGroupMembers).where(and(
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.hostId, hostId),
    )),
    db.select({ count: sqlCountAll() }).from(tunnels).where(sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`),
    db.select({ count: sqlCountAll() }).from(tunnelHops).where(eq(tunnelHops.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(subscriptionPlanHosts).where(eq(subscriptionPlanHosts.hostId, hostId)),
    db.select({ count: sqlCountAll() }).from(agentTokens).where(eq(agentTokens.hostId, hostId)),
  ]);
  return ruleBlockers.ruleCount > 0
    || ruleBlockers.managedRuleCount > 0
    || Number(forwardGroupRows[0]?.count) > 0
    || Number(tunnelRows[0]?.count) > 0
    || Number(tunnelHopRows[0]?.count) > 0
    || Number(tunnelExitRows[0]?.count) > 0
    || Number(planRows[0]?.count) > 0
    || Number(tokenRows[0]?.count) > 0;
}

export async function deleteHostIfUnreferenced(hostId: number) {
  const id = Number(hostId || 0);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (await hostHasLiveReferences(id)) return false;
  await deleteHost(id);
  return true;
}

export async function purgeOrphanedAgentHosts() {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select({ id: hosts.id }).from(hosts).where(sql`
    (${hosts.agentToken} IS NULL OR ${hosts.agentToken} = '')
    AND ${hosts.agentVersion} IS NOT NULL
  `);
  let removed = 0;
  for (const row of rows as any[]) {
    if (await deleteHostIfUnreferenced(Number(row.id || 0))) removed += 1;
  }
  return removed;
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

export async function requestHostAgentUpgrade(
  hostId: number,
  targetVersion: string | null,
  releaseVersion?: string | null,
  requestedAt?: Date | null,
) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: true,
    agentUpgradeTargetVersion: targetVersion,
    agentUpgradeReleaseVersion: releaseVersion || null,
    agentUpgradeRequestedAt: requestedAt || nowDate(),
    updatedAt: nowDate(),
  }).where(eq(hosts.id, hostId));
}

export async function clearHostAgentUpgradeRequest(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(hosts).set({
    agentUpgradeRequested: false,
    agentUpgradeTargetVersion: null,
    agentUpgradeReleaseVersion: null,
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
         ${quoteIdentifier("agentUpgradeReleaseVersion")} = NULL,
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
  await repairPortForwardRuleHostReferences();
  await markOrphanedForwardGroupTemplatesPendingDelete(hostId);
  const managedRuleSql = sql`
    ${forwardRules.forwardGroupId} IS NOT NULL
    OR ${forwardRules.forwardGroupRuleId} IS NOT NULL
    OR ${forwardRules.forwardGroupMemberId} IS NOT NULL
    OR ${forwardRules.isForwardGroupTemplate} = ${sqlBool(true)}
    OR ${forwardRules.id} IN (SELECT ${forwardGroupMembers.ruleId} FROM ${forwardGroupMembers} WHERE ${forwardGroupMembers.ruleId} IS NOT NULL)
  `;
  const [ruleRows, managedRows, pendingRows] = await Promise.all([
    db.select({ count: sqlCountAll() }).from(forwardRules).where(sql`
      ${forwardRules.hostId} = ${hostId}
      AND ${forwardRules.pendingDelete} = ${sqlBool(false)}
      AND NOT (${managedRuleSql})
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

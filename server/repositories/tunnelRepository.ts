import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  tunnels,
  hosts,
  InsertTunnel,
  forwardRules,
  userTunnelPermissions,
  tunnelHops,
  tunnelExitNodes,
  InsertTunnelExitNode,
  forwardRuleTunnelExits,
  InsertForwardRuleTunnelExit,
  forwardGroupMembers,
  forwardGroups,
  tunnelLatencyStats,
} from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { boolValue, quoteIdentifier, sqlCountAll } from "../dbCompat";
import { combineHostPortPolicyWithRange, combinePortPolicies, isPortAllowedByPolicy, pickAvailablePort, portPolicyFrom } from "../portPolicy";
import { releaseHostPortReservations, reserveAvailableHostPort, reserveSpecificHostPort, type HostPortReservation } from "../portReservations";
import { getHostById } from "./hostRepository";
import { getForwardRulesByTunnel } from "./forwardRuleRepository";
import { sqlBool } from "./repositoryUtils";
import { mapWithConcurrency } from "../asyncPool";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { pageResult, pageWindowForTotal, type PageRequest } from "../../shared/pagination";
import { normalizeExitGroupStrategy } from "../../shared/exitStrategy";
import { recordConfigAuditEvent, shouldAuditConfigPatch } from "../configAudit";
import {
  planExitGroupTunnelEndpoints,
  type ExitGroupTunnelMember,
} from "../tunnelExitStrategy";
import { resolveRuleProxyProtocolOptions } from "../gostProxyProtocol";
import { HOST_ONLINE_TTL_MS } from "../hostHeartbeatPolicy";
import { LINK_PROBE_FRESH_MS, LINK_PROBE_MAX_FUTURE_SKEW_MS } from "../../shared/linkProbePolicy";

function databaseBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

// The Agent uses the tunnel row's listener for the lowest-id active GOST
// rule. Nginx Stream follows the same convention. Keep this predicate local
// to the allocation repository so every writer applies the same ownership
// rule; ForwardX has a separate endpoint allocator and is intentionally not
// included here.
const SHARED_TUNNEL_PRIMARY_LISTENER_MODES = new Set([
  "tls",
  "wss",
  "tcp",
  "mtls",
  "mwss",
  "mtcp",
  "nginx_stream",
]);

export function usesSharedTunnelPrimaryListener(tunnel: any) {
  return SHARED_TUNNEL_PRIMARY_LISTENER_MODES.has(String(tunnel?.mode || "").trim().toLowerCase());
}

/**
 * A port may be shared only with the exact tunnel resource that owns it.
 *
 * Historically the allocator accepted just `{ tunnelId, port }` and treated
 * every row belonging to that tunnel as self-owned.  That is unsafe for
 * multi-exit/multi-hop tunnels: an extra listener (or a hop) could then be
 * silently reused as the primary listener.  Keep the old shape compatible by
 * defaulting it to the primary tunnel row, while allowing callers that are
 * replacing an extra/hop row to identify that exact row.
 */
export type TunnelListenerResourceKind = "primary" | "extra" | "hop";

export type TunnelListenerExemption = {
  tunnelId: number;
  port: number;
  kind?: TunnelListenerResourceKind;
  resourceId?: number;
};

type TunnelListenerExemptionInput = TunnelListenerExemption | TunnelListenerExemption[];

function normalizeTunnelListenerExemption(value: unknown): TunnelListenerExemption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as any;
  const tunnelId = Number(candidate.tunnelId || 0);
  const port = Number(candidate.port || 0);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const rawKind = String(candidate.kind || "primary").trim().toLowerCase();
  const kind: TunnelListenerResourceKind = rawKind === "extra" || rawKind === "hop" ? rawKind : "primary";
  const resourceId = Number(candidate.resourceId || 0);
  // Extra/hop rows have their own identities.  Requiring that identity keeps
  // a malformed or partially migrated descriptor from exempting every row of
  // the same kind that happens to use the same port.
  if ((kind === "extra" || kind === "hop") && (!Number.isInteger(resourceId) || resourceId <= 0)) return undefined;
  return {
    tunnelId,
    port,
    kind,
    ...(Number.isInteger(resourceId) && resourceId > 0 ? { resourceId } : {}),
  };
}

function normalizeTunnelListenerExemptions(value: unknown): TunnelListenerExemption[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeTunnelListenerExemption(item))
      .filter((item): item is TunnelListenerExemption => !!item);
  }
  const normalized = normalizeTunnelListenerExemption(value);
  return normalized ? [normalized] : undefined;
}

// ==================== Tunnel Queries ====================

export async function getTunnels(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) return db.select().from(tunnels).where(eq(tunnels.userId, userId)).orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id));
  return db.select().from(tunnels).orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id));
}

export type TunnelListQuery = PageRequest & {
  ownerUserId?: number;
  allowedTunnelIds?: number[];
  search?: string;
};

function normalizeTunnelIds(values: unknown[] | undefined) {
  return Array.from(new Set((values || [])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function escapeTunnelSearchToken(value: string) {
  return value.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_");
}

function tunnelListCondition(input: Omit<TunnelListQuery, keyof PageRequest>) {
  const conditions: any[] = [];
  if (Number(input.ownerUserId || 0) > 0) {
    const allowedIds = normalizeTunnelIds(input.allowedTunnelIds);
    conditions.push(allowedIds.length > 0
      ? or(eq(tunnels.userId, Number(input.ownerUserId)), inArray(tunnels.id, allowedIds))
      : eq(tunnels.userId, Number(input.ownerUserId)));
  }
  const tokens = String(input.search || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const pattern = `%${escapeTunnelSearchToken(token)}%`;
    const numeric = /^\d+$/.test(token) ? Number(token) : 0;
    conditions.push(or(
      ...[
        tunnels.name,
        tunnels.mode,
        tunnels.forwardxVersion,
        tunnels.networkType,
        tunnels.connectHost,
        tunnels.certDomain,
      ].map((column) => sql`LOWER(COALESCE(${column}, '')) LIKE ${pattern} ESCAPE '!'`),
      ...(numeric > 0 ? [
        eq(tunnels.id, numeric),
        eq(tunnels.listenPort, numeric),
        eq(tunnels.mimicPort, numeric),
      ] : []),
      sql`EXISTS (
        SELECT 1 FROM ${hosts}
        WHERE ${hosts.id} IN (${tunnels.entryHostId}, ${tunnels.exitHostId})
          AND (
            LOWER(COALESCE(${hosts.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ip}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv4}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ipv6}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${tunnelHops}
        INNER JOIN ${hosts} ON ${hosts.id} = ${tunnelHops.hostId}
        WHERE ${tunnelHops.tunnelId} = ${tunnels.id}
          AND (
            LOWER(COALESCE(${hosts.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ip}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnelHops.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1
        FROM ${tunnelExitNodes}
        INNER JOIN ${hosts} ON ${hosts.id} = ${tunnelExitNodes.hostId}
        WHERE ${tunnelExitNodes.tunnelId} = ${tunnels.id}
          AND (
            LOWER(COALESCE(${hosts.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${hosts.ip}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${tunnelExitNodes.connectHost}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${forwardGroups}
        WHERE ${forwardGroups.id} IN (${tunnels.entryGroupId}, ${tunnels.exitGroupId})
          AND (
            LOWER(COALESCE(${forwardGroups.name}, '')) LIKE ${pattern} ESCAPE '!'
            OR LOWER(COALESCE(${forwardGroups.remark}, '')) LIKE ${pattern} ESCAPE '!'
          )
      )`,
    ));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getTunnelsPage(input: TunnelListQuery) {
  const db = await getDb();
  if (!db) return { ...pageResult([], 0, input), scopeTotalItems: 0, enabledItems: 0, availableItems: 0 };
  const condition = tunnelListCondition(input);
  const cutoffSeconds = Math.floor((Date.now() - HOST_ONLINE_TTL_MS) / 1000);
  const probeCutoffSeconds = Math.floor((Date.now() - LINK_PROBE_FRESH_MS) / 1000);
  const probeFutureSeconds = Math.floor((Date.now() + LINK_PROBE_MAX_FUTURE_SKEW_MS) / 1000);
  const freshProbe = sql`
    ${tunnels.lastTestAt} IS NOT NULL
    AND ${tunnels.lastTestAt} >= ${probeCutoffSeconds}
    AND ${tunnels.lastTestAt} <= ${probeFutureSeconds}
  `;
  const freshProbeAvailable = sql`
    ${freshProbe}
    AND LOWER(COALESCE(${tunnels.lastTestStatus}, '')) = 'success'
    AND ${tunnels.lastLatencyMs} IS NOT NULL
  `;
  const freshProbeUnavailable = sql`
    ${freshProbe}
    AND LOWER(COALESCE(${tunnels.lastTestStatus}, '')) = 'failed'
  `;
  const primaryEntryAvailable = sql`EXISTS (
    SELECT 1 FROM ${hosts}
    WHERE ${hosts.id} = ${tunnels.entryHostId}
      AND ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
  )`;
  const entryGroupAvailable = sql`EXISTS (
    SELECT 1 FROM ${forwardGroupMembers}
    INNER JOIN ${hosts} ON ${hosts.id} = ${forwardGroupMembers.hostId}
    WHERE ${forwardGroupMembers.groupId} = ${tunnels.entryGroupId}
      AND ${forwardGroupMembers.memberType} = 'host'
      AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}
      AND ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
  )`;
  const primaryExitAvailable = sql`EXISTS (
    SELECT 1 FROM ${hosts}
    WHERE ${hosts.id} = ${tunnels.exitHostId}
      AND ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
  )`;
  const extraExitAvailable = sql`EXISTS (
    SELECT 1 FROM ${tunnelExitNodes}
    INNER JOIN ${hosts} ON ${hosts.id} = ${tunnelExitNodes.hostId}
    WHERE ${tunnelExitNodes.tunnelId} = ${tunnels.id}
      AND ${tunnelExitNodes.isEnabled} = ${sqlBool(true)}
      AND ${hosts.isOnline} = ${sqlBool(true)}
      AND ${hosts.lastHeartbeat} IS NOT NULL
      AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
  )`;
  const relayHostsAvailable = sql`(
    NOT EXISTS (SELECT 1 FROM ${tunnelHops} WHERE ${tunnelHops.tunnelId} = ${tunnels.id})
    OR (
      LOWER(COALESCE(${tunnels.relayMode}, 'chain')) = 'failover'
      AND EXISTS (
        SELECT 1 FROM ${tunnelHops}
        INNER JOIN ${hosts} ON ${hosts.id} = ${tunnelHops.hostId}
        WHERE ${tunnelHops.tunnelId} = ${tunnels.id}
          AND ${tunnelHops.seq} > 0
          AND ${tunnelHops.seq} < (SELECT COUNT(*) - 1 FROM ${tunnelHops} WHERE ${tunnelHops.tunnelId} = ${tunnels.id})
          AND ${hosts.isOnline} = ${sqlBool(true)}
          AND ${hosts.lastHeartbeat} IS NOT NULL
          AND ${hosts.lastHeartbeat} >= ${cutoffSeconds}
      )
    )
    OR (
      LOWER(COALESCE(${tunnels.relayMode}, 'chain')) <> 'failover'
      AND NOT EXISTS (
        SELECT 1 FROM ${tunnelHops}
        INNER JOIN ${hosts} ON ${hosts.id} = ${tunnelHops.hostId}
        WHERE ${tunnelHops.tunnelId} = ${tunnels.id}
          AND ${tunnelHops.seq} > 0
          AND ${tunnelHops.seq} < (SELECT COUNT(*) - 1 FROM ${tunnelHops} WHERE ${tunnelHops.tunnelId} = ${tunnels.id})
          AND (${hosts.isOnline} <> ${sqlBool(true)} OR ${hosts.lastHeartbeat} IS NULL OR ${hosts.lastHeartbeat} < ${cutoffSeconds})
      )
    )
  )`;
  const routeHostsAvailable = sql`(
    (${primaryEntryAvailable} OR (${tunnels.entryGroupId} IS NOT NULL AND ${entryGroupAvailable}))
    AND (
      ${primaryExitAvailable}
      OR (
        ${tunnels.loadBalanceEnabled} = ${sqlBool(true)}
        AND LOWER(COALESCE(${tunnels.loadBalanceStrategy}, 'none')) <> 'none'
        AND ${extraExitAvailable}
      )
    )
    AND ${relayHostsAvailable}
  )`;
  const availableExpression = sql<number>`CASE WHEN
    ${tunnels.isEnabled} = ${sqlBool(true)}
    AND (
      ${freshProbeAvailable}
      OR (
        NOT (${freshProbeUnavailable})
        AND ${routeHostsAvailable}
      )
    )
    THEN 1 ELSE 0 END`;
  const aggregate = db
    .select({
      totalItems: sql<number>`COUNT(*)`,
      enabledItems: sql<number>`COALESCE(SUM(CASE WHEN ${tunnels.isEnabled} = ${sqlBool(true)} THEN 1 ELSE 0 END), 0)`,
      availableItems: sql<number>`COALESCE(SUM(${availableExpression}), 0)`,
    })
    .from(tunnels);
  const [totals] = condition ? await aggregate.where(condition) : await aggregate;
  const totalItems = Number(totals?.totalItems || 0);
  const enabledItems = Number(totals?.enabledItems || 0);
  const availableItems = Number(totals?.availableItems || 0);
  const scopeCondition = tunnelListCondition({
    ownerUserId: input.ownerUserId,
    allowedTunnelIds: input.allowedTunnelIds,
  });
  let scopeTotalItems = totalItems;
  if (String(input.search || "").trim()) {
    const scopeQuery = db.select({ count: sql<number>`COUNT(*)` }).from(tunnels);
    const [scopeTotals] = scopeCondition ? await scopeQuery.where(scopeCondition) : await scopeQuery;
    scopeTotalItems = Number(scopeTotals?.count || 0);
  }
  const window = pageWindowForTotal(input, totalItems);
  const list = db.select().from(tunnels);
  const items = condition
    ? await list.where(condition).orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id)).limit(window.pageSize).offset(window.offset)
    : await list.orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id)).limit(window.pageSize).offset(window.offset);
  return {
    ...pageResult(items, totalItems, window),
    scopeTotalItems,
    enabledItems,
    availableItems,
  };
}

export async function getTunnelOptionRows(ownerUserId?: number, allowedTunnelIds?: number[]) {
  const db = await getDb();
  if (!db) return [];
  const condition = tunnelListCondition({ ownerUserId, allowedTunnelIds });
  const list = db.select().from(tunnels);
  return condition
    ? list.where(condition).orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id))
    : list.orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id));
}

export async function getTunnelsByHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const direct = await db.select({ id: tunnels.id }).from(tunnels).where(
    sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`
  );
  const hopRows = await db.select({ tunnelId: tunnelHops.tunnelId }).from(tunnelHops).where(eq(tunnelHops.hostId, hostId));
  const extraExitRows = await db.select({ tunnelId: tunnelExitNodes.tunnelId }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, hostId));
  const entryGroupRows = await db.select({ id: tunnels.id }).from(tunnels).where(sql`
    ${tunnels.entryGroupId} IN (
      SELECT ${forwardGroups.id}
      FROM ${forwardGroups}
      INNER JOIN ${forwardGroupMembers} ON ${forwardGroupMembers.groupId} = ${forwardGroups.id}
      WHERE ${forwardGroups.groupMode} = 'entry'
        AND ${forwardGroups.isEnabled} = ${sqlBool(true)}
        AND ${forwardGroupMembers.memberType} = 'host'
        AND ${forwardGroupMembers.hostId} = ${hostId}
        AND ${forwardGroupMembers.isEnabled} = ${sqlBool(true)}
    )
  `);
  const ids = Array.from(new Set([
    ...direct.map((row: any) => Number(row.id)),
    ...hopRows.map((row: any) => Number(row.tunnelId)),
    ...extraExitRows.map((row: any) => Number(row.tunnelId)),
    ...entryGroupRows.map((row: any) => Number(row.id)),
  ].filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return [];
  return db.select().from(tunnels).where(sql`${tunnels.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).orderBy(asc(tunnels.sortOrder), desc(tunnels.createdAt), desc(tunnels.id));
}

export async function getTunnelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(tunnels).where(eq(tunnels.id, id)).limit(1);
  return r[0];
}

export async function getTunnelsByIds(tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return [];
  const ids = Array.from(new Set(tunnelIds
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)));
  const rows: any[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    rows.push(...await db.select().from(tunnels).where(inArray(tunnels.id, ids.slice(index, index + 400))));
  }
  return rows;
}

export async function backfillTunnelExitGroupReferences() {
  const db = await getDb();
  if (!db) return 0;
  const exitGroups = await db
    .select({ id: forwardGroups.id })
    .from(forwardGroups)
    .where(eq(forwardGroups.groupMode, "exit"));
  if (exitGroups.length === 0) return 0;

  const groupIds: number[] = exitGroups.map((group: any) => Number(group.id)).filter((id: number) => id > 0);
  const members = await db
    .select({
      groupId: forwardGroupMembers.groupId,
      hostId: forwardGroupMembers.hostId,
      priority: forwardGroupMembers.priority,
      isEnabled: forwardGroupMembers.isEnabled,
    })
    .from(forwardGroupMembers)
    .where(sql`${forwardGroupMembers.groupId} IN (${sql.join(groupIds.map((id: number) => sql`${id}`), sql`, `)})`);
  const groupIdsBySignature = new Map<string, number[]>();
  for (const group of exitGroups as any[]) {
    const signature = (members as any[])
      .filter((member) => Number(member.groupId) === Number(group.id) && databaseBool(member.isEnabled, true) && Number(member.hostId || 0) > 0)
      .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))
      .map((member) => Number(member.hostId))
      .join(",");
    if (!signature) continue;
    const ids = groupIdsBySignature.get(signature) || [];
    ids.push(Number(group.id));
    groupIdsBySignature.set(signature, ids);
  }

  const legacyTunnels = await db
    .select({ id: tunnels.id, exitHostId: tunnels.exitHostId })
    .from(tunnels)
    .where(sql`${tunnels.exitGroupId} IS NULL`);
  let updated = 0;
  for (const tunnel of legacyTunnels as any[]) {
    const exitNodes = await getTunnelExitNodes(Number(tunnel.id));
    const signature = [
      Number(tunnel.exitHostId || 0),
      ...(exitNodes as any[])
        .filter((node) => databaseBool(node.isEnabled, true) && Number(node.hostId || 0) > 0)
        .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
        .map((node) => Number(node.hostId)),
    ].filter((id) => id > 0).join(",");
    const matches = groupIdsBySignature.get(signature) || [];
    if (matches.length !== 1) continue;
    await db.update(tunnels).set({ exitGroupId: matches[0], updatedAt: nowDate() } as any).where(eq(tunnels.id, Number(tunnel.id)));
    updated += 1;
  }
  return updated;
}

export async function createTunnel(data: InsertTunnel) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const payload = { ...data } as any;
  if (payload.sortOrder === undefined) {
    payload.sortOrder = await nextTunnelSortOrder(Number(payload.userId || 0));
  }
  const id = await insertAndGetId("tunnels", payload);
  const created = await getTunnelById(id).catch(() => undefined);
  await recordConfigAuditEvent({ resourceType: "tunnel", resourceId: id, hostId: Number((created as any)?.entryHostId || 0), action: "create", after: created });
  return id;
}

export async function updateTunnel(id: number, data: Partial<InsertTunnel>) {
  const db = await getDb();
  if (!db) return;
  const audit = shouldAuditConfigPatch(data as any);
  const before = audit ? await getTunnelById(id).catch(() => undefined) : undefined;
  await db.update(tunnels).set({ ...data, updatedAt: nowDate() }).where(eq(tunnels.id, id));
  if (audit && before) {
    const after = await getTunnelById(id).catch(() => undefined);
    await recordConfigAuditEvent({ resourceType: "tunnel", resourceId: id, hostId: Number((after as any)?.entryHostId || (before as any).entryHostId || 0), action: "update", before, after });
  }
}

async function nextTunnelSortOrder(userId: number) {
  const q = quoteIdentifier;
  const where = userId > 0 ? ` WHERE ${q("userId")} = ?` : "";
  const params = userId > 0 ? [userId] : [];
  const rows = await queryRaw<{ nextSortOrder: number }>(
    `SELECT COALESCE(MAX(${q("sortOrder")}), -1) + 1 AS ${q("nextSortOrder")} FROM ${q("tunnels")}${where}`,
    params,
  ).catch(() => []);
  const value = Number(rows[0]?.nextSortOrder || 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function reorderTunnels(ids: number[], startIndex = 0) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = ids.map((id) => Math.floor(Number(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const rows = await db.select({ id: tunnels.id }).from(tunnels).where(sql`${tunnels.id} IN (${sql.join(orderedIds.map((id) => sql`${id}`), sql`, `)})`);
  if (rows.length !== orderedIds.length) throw new Error("排序中包含不存在的隧道");
  const q = quoteIdentifier;
  const normalizedStartIndex = Math.max(0, Math.floor(Number(startIndex) || 0));
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(`UPDATE ${q("tunnels")} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [normalizedStartIndex + index, id]);
  }
}

function hostEntryAddress(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function hostPrivateAddress(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function hostIpv6Address(host: any) {
  return String(host?.ipv6 || "").trim();
}

function nextStoredConnectHost(stored: unknown, currentHost: any, previousHost?: any) {
  const value = String(stored || "").trim();
  const currentPrivate = hostPrivateAddress(currentHost);
  const currentIpv6 = hostIpv6Address(currentHost);
  const previousPrivate = hostPrivateAddress(previousHost);
  const previousIpv6 = hostIpv6Address(previousHost);
  const previousPublic = hostEntryAddress(previousHost);
  if (previousPrivate && value === previousPrivate) return currentPrivate || null;
  if (previousIpv6 && value === previousIpv6) return currentIpv6 || null;
  if (previousPublic && value === previousPublic) return null;
  return undefined;
}

export async function syncTunnelsForHostAddress(hostId: number, previousHost?: any) {
  const db = await getDb();
  if (!db) return;
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  const currentHost = await getHostById(id);
  if (!currentHost) return;
  const now = nowDate();

  const directTunnels = await getTunnelsByHost(id);
  for (const tunnel of directTunnels as any[]) {
    if (Number(tunnel.exitHostId || 0) !== id) continue;
    const stored = String(tunnel.connectHost || "").trim();
    const privateAddr = hostPrivateAddress(currentHost);
    const migrated = nextStoredConnectHost(stored, currentHost, previousHost);
    const legacyPrivate = String(tunnel.networkType || "public") === "private" && !stored;
    const nextConnectHost = migrated !== undefined
      ? migrated
      : legacyPrivate
        ? privateAddr || null
        : undefined;
    if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
      await db.update(tunnels).set({
        connectHost: nextConnectHost,
        networkType: nextConnectHost && privateAddr && nextConnectHost === privateAddr ? "private" : "public",
        isRunning: false,
        updatedAt: now,
      } as any).where(eq(tunnels.id, Number(tunnel.id)));
    }
  }

  const hopRows = await db.select().from(tunnelHops).where(eq(tunnelHops.hostId, id));
  for (const hop of hopRows as any[]) {
    const stored = String(hop.connectHost || "").trim();
    const nextConnectHost = nextStoredConnectHost(stored, currentHost, previousHost);
    if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
      await db.update(tunnelHops).set({
        connectHost: nextConnectHost,
      } as any).where(eq(tunnelHops.id, Number(hop.id)));
    }
  }

  const exitRows = await db.select().from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, id));
  for (const node of exitRows as any[]) {
    const stored = String(node.connectHost || "").trim();
    const nextConnectHost = nextStoredConnectHost(stored, currentHost, previousHost);
    if (nextConnectHost !== undefined && (stored || null) !== nextConnectHost) {
      await db.update(tunnelExitNodes).set({
        connectHost: nextConnectHost,
        updatedAt: now,
      } as any).where(eq(tunnelExitNodes.id, Number(node.id)));
    }
  }
}

export async function clearTunnelTestSnapshot(id: number, options: { clearHistory?: boolean } = {}) {
  const db = await getDb();
  if (!db) return;
  if (options.clearHistory) {
    // Measurements from a previous topology have different labels and are no
    // longer comparable (for example, an exit group changed to a direct exit).
    await db.delete(tunnelLatencyStats).where(eq(tunnelLatencyStats.tunnelId, id));
  }
  await db.update(tunnels).set({
    lastLatencyMs: null,
    lastTestStatus: null,
    lastTestMessage: null,
    lastTestAt: null,
    updatedAt: nowDate(),
  } as any).where(eq(tunnels.id, id));
}

export async function deleteTunnel(id: number) {
  return withDatabaseTransaction(async () => {
  const db = await getDb();
  if (!db) return;
  const before = await getTunnelById(id).catch(() => undefined);
  await db.update(forwardRules).set({ tunnelId: null, isEnabled: false, isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.tunnelId, id));
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.tunnelId, id));
  await db.delete(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, id));
  await db.delete(tunnelHops).where(eq(tunnelHops.tunnelId, id));
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.tunnelId, id));
  await db.delete(tunnels).where(eq(tunnels.id, id));
  if (before) await recordConfigAuditEvent({ resourceType: "tunnel", resourceId: id, hostId: Number((before as any).entryHostId || 0), action: "delete", before });
  });
}

export async function resetForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.tunnelId, tunnelId));
}

export async function updateForwardRuleRuntimeOptionsByTunnel(tunnelId: number, data: Partial<InsertTunnel>) {
  const db = await getDb();
  if (!db) return 0;
  const storedTunnel = await getTunnelById(tunnelId) as any;
  if (!storedTunnel) return 0;
  const tunnel = { ...storedTunnel } as any;
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) tunnel[key] = value;
  }
  const mode = String(tunnel.mode || "").toLowerCase();
  const forwardx = mode === "forwardx";
  const rules = await db
    .select({
      id: forwardRules.id,
      protocol: forwardRules.protocol,
      proxyProtocolReceive: forwardRules.proxyProtocolReceive,
      proxyProtocolSend: forwardRules.proxyProtocolSend,
      proxyProtocolExitReceive: forwardRules.proxyProtocolExitReceive,
      proxyProtocolExitSend: forwardRules.proxyProtocolExitSend,
      proxyProtocolVersion: forwardRules.proxyProtocolVersion,
      tcpFastOpen: forwardRules.tcpFastOpen,
      zeroCopy: forwardRules.zeroCopy,
      udpOverTcp: forwardRules.udpOverTcp,
      udpOverTcpPort: forwardRules.udpOverTcpPort,
    })
    .from(forwardRules)
    .where(eq(forwardRules.tunnelId, tunnelId));
  let changedCount = 0;
  for (const rule of rules as any[]) {
    const protocol = String(rule.protocol || "both");
    const tcpSupported = protocol === "tcp" || protocol === "both";
    const udpSupported = protocol === "udp" || protocol === "both";
    const proxyOptions = resolveRuleProxyProtocolOptions(rule, tunnel);
    const desired = {
      ...proxyOptions,
      tcpFastOpen: forwardx && tcpSupported && databaseBool(tunnel.tcpFastOpen),
      zeroCopy: false,
      udpOverTcp: forwardx && udpSupported && databaseBool(tunnel.udpOverTcp),
      udpOverTcpPort: null,
    };
    const changed = (
      databaseBool(rule.proxyProtocolReceive) !== desired.proxyProtocolReceive
      || databaseBool(rule.proxyProtocolSend) !== desired.proxyProtocolSend
      || databaseBool(rule.proxyProtocolExitReceive) !== desired.proxyProtocolExitReceive
      || databaseBool(rule.proxyProtocolExitSend) !== desired.proxyProtocolExitSend
      || Number(rule.proxyProtocolVersion || 1) !== desired.proxyProtocolVersion
      || databaseBool(rule.tcpFastOpen) !== desired.tcpFastOpen
      || databaseBool(rule.zeroCopy) !== desired.zeroCopy
      || databaseBool(rule.udpOverTcp) !== desired.udpOverTcp
      || rule.udpOverTcpPort != null
    );
    if (!changed) continue;
    await db.update(forwardRules).set({
      ...desired,
      isRunning: false,
      updatedAt: nowDate(),
    } as any).where(eq(forwardRules.id, Number(rule.id)));
    changedCount += 1;
  }
  return changedCount;
}

export async function resetAgentRuntimeStateForHost(hostId: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  const db = await getDb();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);

  await executeRaw(
    `UPDATE ${quoteIdentifier("tunnels")}
     SET ${quoteIdentifier("isRunning")} = ?, ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("isRunning")} = ?
       AND (
         ${quoteIdentifier("entryHostId")} = ?
         OR ${quoteIdentifier("exitHostId")} = ?
         OR ${quoteIdentifier("id")} IN (
           SELECT ${quoteIdentifier("tunnelId")}
           FROM ${quoteIdentifier("tunnel_hops")}
           WHERE ${quoteIdentifier("hostId")} = ?
         )
         OR ${quoteIdentifier("id")} IN (
           SELECT ${quoteIdentifier("tunnelId")}
           FROM ${quoteIdentifier("tunnel_exit_nodes")}
           WHERE ${quoteIdentifier("hostId")} = ?
         )
         OR ${quoteIdentifier("entryGroupId")} IN (
           SELECT g.${quoteIdentifier("id")}
           FROM ${quoteIdentifier("forward_groups")} g
           INNER JOIN ${quoteIdentifier("forward_group_members")} m ON m.${quoteIdentifier("groupId")} = g.${quoteIdentifier("id")}
           WHERE g.${quoteIdentifier("groupMode")} = ?
             AND g.${quoteIdentifier("isEnabled")} = ?
             AND m.${quoteIdentifier("memberType")} = ?
             AND m.${quoteIdentifier("hostId")} = ?
             AND m.${quoteIdentifier("isEnabled")} = ?
         )
       )`,
    [boolValue(false), now, boolValue(true), id, id, id, id, "entry", boolValue(true), "host", id, boolValue(true)],
  );

  await executeRaw(
    `UPDATE ${quoteIdentifier("forward_rules")}
     SET ${quoteIdentifier("isRunning")} = ?, ${quoteIdentifier("updatedAt")} = ?
     WHERE ${quoteIdentifier("isRunning")} = ?
       AND (
         ${quoteIdentifier("hostId")} = ?
         OR ${quoteIdentifier("tunnelId")} IN (
           SELECT ${quoteIdentifier("id")}
           FROM ${quoteIdentifier("tunnels")}
           WHERE ${quoteIdentifier("entryHostId")} = ?
             OR ${quoteIdentifier("exitHostId")} = ?
             OR ${quoteIdentifier("id")} IN (
               SELECT ${quoteIdentifier("tunnelId")}
               FROM ${quoteIdentifier("tunnel_hops")}
               WHERE ${quoteIdentifier("hostId")} = ?
             )
             OR ${quoteIdentifier("id")} IN (
               SELECT ${quoteIdentifier("tunnelId")}
               FROM ${quoteIdentifier("tunnel_exit_nodes")}
               WHERE ${quoteIdentifier("hostId")} = ?
             )
             OR ${quoteIdentifier("entryGroupId")} IN (
               SELECT g.${quoteIdentifier("id")}
               FROM ${quoteIdentifier("forward_groups")} g
               INNER JOIN ${quoteIdentifier("forward_group_members")} m ON m.${quoteIdentifier("groupId")} = g.${quoteIdentifier("id")}
               WHERE g.${quoteIdentifier("groupMode")} = ?
                 AND g.${quoteIdentifier("isEnabled")} = ?
                 AND m.${quoteIdentifier("memberType")} = ?
                 AND m.${quoteIdentifier("hostId")} = ?
                 AND m.${quoteIdentifier("isEnabled")} = ?
             )
         )
       )`,
    [boolValue(false), now, boolValue(true), id, id, id, id, id, "entry", boolValue(true), "host", id, boolValue(true)],
  );
}

export async function disableForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled: false,
    isRunning: false,
    disabledByTunnel: true,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.tunnelId, tunnelId),
    eq(forwardRules.pendingDelete, false),
    or(
      eq(forwardRules.isEnabled, true),
      eq(forwardRules.disabledByGroup, true),
      eq(forwardRules.disabledByTunnel, true),
    ),
  ));
}

async function isForwardGroupRuntimeEnabled(groupId: number) {
  const db = await getDb();
  if (!db || groupId <= 0) return true;
  const group = (await db.select({
    isEnabled: forwardGroups.isEnabled,
    groupMode: forwardGroups.groupMode,
    entryGroupId: forwardGroups.entryGroupId,
  }).from(forwardGroups).where(eq(forwardGroups.id, groupId)).limit(1))[0] as any;
  if (!group || !databaseBool(group.isEnabled)) return false;
  if (String(group.groupMode || "") !== "chain" || Number(group.entryGroupId || 0) <= 0) return true;
  const entryGroup = (await db.select({
    isEnabled: forwardGroups.isEnabled,
    groupMode: forwardGroups.groupMode,
  }).from(forwardGroups).where(eq(forwardGroups.id, Number(group.entryGroupId))).limit(1))[0] as any;
  return databaseBool(entryGroup?.isEnabled) && String(entryGroup.groupMode || "") === "entry";
}

async function canRestoreForwardRuleAfterTunnel(rule: any) {
  if (databaseBool(rule.disabledByUser) || databaseBool(rule.disabledByGroup) || String(rule.protocolBlockReason || "").trim()) return false;
  const groupId = Number(rule.forwardGroupId || 0);
  if (groupId > 0 && !(await isForwardGroupRuntimeEnabled(groupId))) return false;

  const db = await getDb();
  if (!db) return false;
  const templateId = Number(rule.forwardGroupRuleId || 0);
  if (templateId > 0) {
    const template = (await db.select({
      isEnabled: forwardRules.isEnabled,
      pendingDelete: forwardRules.pendingDelete,
      disabledByGroup: forwardRules.disabledByGroup,
      disabledByUser: forwardRules.disabledByUser,
      protocolBlockReason: forwardRules.protocolBlockReason,
    }).from(forwardRules).where(eq(forwardRules.id, templateId)).limit(1))[0] as any;
    if (
      !template
      || databaseBool(template.pendingDelete)
      || !databaseBool(template.isEnabled)
      || databaseBool(template.disabledByGroup)
      || databaseBool(template.disabledByUser)
      || String(template.protocolBlockReason || "").trim()
    ) return false;
  }

  const memberId = Number(rule.forwardGroupMemberId || 0);
  if (memberId > 0) {
    const member = (await db.select({ isEnabled: forwardGroupMembers.isEnabled })
      .from(forwardGroupMembers)
      .where(eq(forwardGroupMembers.id, memberId))
      .limit(1))[0] as any;
    if (!databaseBool(member?.isEnabled)) return false;
  }
  return true;
}

export async function restoreForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  const rules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.tunnelId, tunnelId),
    eq(forwardRules.pendingDelete, false),
    or(
      eq(forwardRules.disabledByTunnel, true),
      and(
        sql`${forwardRules.forwardGroupRuleId} IS NOT NULL`,
        eq(forwardRules.isEnabled, false),
      ),
    ),
  ));
  for (const rule of rules as any[]) {
    const isEnabled = await canRestoreForwardRuleAfterTunnel(rule);
    await db.update(forwardRules).set({
      isEnabled,
      disabledByTunnel: false,
      isRunning: false,
      updatedAt: nowDate(),
    }).where(eq(forwardRules.id, Number(rule.id)));
  }
}

export async function findAvailableTunnelExitPort(
  exitHostId: number,
  preferredStart?: number | null,
  preferredEnd?: number | null,
  reservedPorts: number[] = [],
  excludeRuleIds: number[] = [],
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const excludedIds = Array.from(new Set(excludeRuleIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
  const excludeRulesSql = excludedIds.length > 0
    ? sql`${forwardRules.id} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`
    : undefined;
  const excludeMappingsSql = excludedIds.length > 0
    ? sql`${forwardRuleTunnelExits.ruleId} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`
    : undefined;
  const host = await getHostById(exitHostId) as any;
  // Exit ports must always satisfy the host's NAT policy.  The optional
  // preferred range (normally supplied by a tunnel) is an additional
  // restriction, not a replacement for the host policy.  In particular,
  // legacy rows may contain 0 for an unset range; passing that value through
  // used to turn a restricted host into an unrestricted 20k-65k allocation.
  const policy = combineHostPortPolicyWithRange(host, preferredStart, preferredEnd);
  const usedRuleConds: any[] = [
    eq(forwardRules.hostId, exitHostId),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRulesSql) usedRuleConds.push(excludeRulesSql);
  const usedRulePorts = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(...usedRuleConds));
  const usedTunnelPorts = await db.select({ port: tunnels.listenPort }).from(tunnels).where(eq(tunnels.exitHostId, exitHostId));
  const usedTunnelMimicPorts = await db.select({ port: tunnels.mimicPort }).from(tunnels).where(eq(tunnels.exitHostId, exitHostId));
  const usedExtraTunnelPorts = await db.select({ port: tunnelExitNodes.listenPort }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, exitHostId));
  const usedExtraTunnelMimicPorts = await db.select({ port: tunnelExitNodes.mimicPort }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, exitHostId));
  const usedHopPorts = await db.select({ port: tunnelHops.listenPort }).from(tunnelHops).where(eq(tunnelHops.hostId, exitHostId));
  const usedHopMimicPorts = await db.select({ port: tunnelHops.mimicPort }).from(tunnelHops).where(eq(tunnelHops.hostId, exitHostId));
  const usedExitConds: any[] = [
    eq(tunnels.exitHostId, exitHostId),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRulesSql) usedExitConds.push(excludeRulesSql);
  const usedExitPorts = await db.select({ port: forwardRules.tunnelExitPort })
    .from(forwardRules)
    .innerJoin(tunnels, eq(forwardRules.tunnelId, tunnels.id))
    .where(and(...usedExitConds));
  const usedMappedExitConds: any[] = [eq(forwardRuleTunnelExits.exitHostId, exitHostId)];
  if (excludeMappingsSql) usedMappedExitConds.push(excludeMappingsSql);
  const usedMappedExitPorts = await db.select({ port: forwardRuleTunnelExits.tunnelExitPort }).from(forwardRuleTunnelExits).where(and(...usedMappedExitConds));
  const used = new Set<number>();
  reservedPorts.forEach((port) => {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0) used.add(n);
  });
  usedRulePorts.forEach((r: any) => used.add(Number(r.port)));
  usedTunnelPorts.forEach((r: any) => used.add(Number(r.port)));
  usedTunnelMimicPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExtraTunnelPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExtraTunnelMimicPorts.forEach((r: any) => used.add(Number(r.port)));
  usedHopPorts.forEach((r: any) => used.add(Number(r.port)));
  usedHopMimicPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExitPorts.forEach((r: any) => {
    if (r.port != null) used.add(Number(r.port));
  });
  usedMappedExitPorts.forEach((r: any) => {
    if (r.port != null) used.add(Number(r.port));
  });
  return pickAvailablePort(policy, used, { start: 20000, end: 65535 });
}

/**
 * Reserve a tunnel exit port while enforcing the destination Agent's port
 * policy.  Existing tunnel rows are deliberately treated as a preference:
 * an out-of-policy value (for example a stale high port after moving to a
 * NAT-only host) is discarded and replaced with a valid allocation.
 */
export async function reserveTunnelExitPort(options: {
  hostId: number;
  preferredStart?: number | null;
  preferredEnd?: number | null;
  currentPort?: unknown;
  reservedPorts?: number[];
  excludeRuleIds?: number | number[];
  /**
   * A primary tunnel rule may intentionally reuse the listener owned by the
   * same tunnel.  This must be opt-in: secondary rules and extra-exit
   * mappings must treat that listener as occupied, otherwise a stale mapping
   * can silently bind on top of the tunnel service.
  */
  allowSameTunnelListener?: boolean;
  /**
   * Optional precise resource to exempt while replacing an existing row.
   * `allowSameTunnelListener` remains as a backwards-compatible shorthand
   * for the primary tunnel listener.
   */
  sameTunnelResource?: TunnelListenerExemptionInput;
  excludeTunnelId?: number;
  protocol?: unknown;
}): Promise<HostPortReservation | null> {
  const hostId = Number(options.hostId || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  const host = await getHostById(hostId) as any;
  if (!host) return null;
  const preferredStart = options.preferredStart;
  const preferredEnd = options.preferredEnd;
  const hasPreferredRange = Number.isInteger(Number(preferredStart))
    && Number.isInteger(Number(preferredEnd))
    && Number(preferredStart) >= 1
    && Number(preferredEnd) <= 65535
    && Number(preferredStart) <= Number(preferredEnd);
  const policy = combineHostPortPolicyWithRange(host, preferredStart, preferredEnd);
  const protocol = options.protocol ?? "both";
  const currentPort = Number(options.currentPort || 0);
  const reservedPorts = Array.isArray(options.reservedPorts) ? options.reservedPorts : [];
  const excludeRuleIds = options.excludeRuleIds;
  // When a caller is repairing/reusing a tunnel listener, exempt only that
  // exact listener row.  Excluding the whole tunnel would also hide its
  // other listeners/mimic ports and can create a same-tunnel collision.
  const sameTunnelListener = options.sameTunnelResource !== undefined
    ? normalizeTunnelListenerExemptions(options.sameTunnelResource)
    : (options.allowSameTunnelListener
      && Number(options.excludeTunnelId || 0) > 0
      && currentPort > 0
      ? [{ tunnelId: Number(options.excludeTunnelId), port: currentPort, kind: "primary" as const }]
      : undefined);
  const explicitlyReserved = new Set(reservedPorts
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535));
  const isUsed = (port: number) => isPortUsedOnHost(
    hostId,
    port,
    excludeRuleIds,
    protocol,
    // A tunnel id by itself is not a sufficient ownership identity when a
    // tunnel has multiple listeners (primary, extra exits and hops).  The
    // generic allocator therefore never applies the legacy "exclude the
    // whole tunnel" shortcut.  Reuse is allowed only through the precise
    // `sameTunnelResource` descriptor above; callers that need a same-tunnel
    // exemption must provide that descriptor explicitly.
    undefined,
    true,
    sameTunnelListener,
  );

  // Reuse a stored port only when it still belongs to the effective policy.
  // An invalid old value is intentionally not returned as a hard conflict;
  // callers can transparently repair it by taking the allocation path below.
  if (currentPort > 0
    && !explicitlyReserved.has(currentPort)
    && isPortAllowedByPolicy(currentPort, policy)) {
    const preserved = await reserveSpecificHostPort({
      hostId,
      port: currentPort,
      protocol,
      isUsed,
    });
    if (preserved) return preserved;
  }

  return reserveAvailableHostPort({
    hostId,
    protocol,
    findPort: (processReservedPorts) => findAvailableTunnelExitPort(
      hostId,
      hasPreferredRange ? Number(preferredStart) : undefined,
      hasPreferredRange ? Number(preferredEnd) : undefined,
      [...reservedPorts, ...processReservedPorts],
      Array.isArray(excludeRuleIds) ? excludeRuleIds : excludeRuleIds == null ? [] : [Number(excludeRuleIds)],
    ),
    isUsed,
  });
}

/**
 * Reserve a tunnel's shared listener port while treating the tunnel's own
 * rows as self-owned.  This is useful when repairing legacy data after an
 * Agent NAT policy changes: a stale listener is only a preference, and a new
 * in-policy port can be selected without making the caller manually duplicate
 * the rule/mapping exclusion logic.
 */
export async function reserveTunnelListenerPort(
  tunnelInput: any,
  options: {
    hostId?: number;
    currentPort?: unknown;
    reservedPorts?: number[];
    excludeRuleIds?: number | number[];
    protocol?: unknown;
  } = {},
): Promise<HostPortReservation | null> {
  const tunnelId = Number(tunnelInput?.id || 0);
  const hostId = Number(options.hostId || tunnelInput?.exitHostId || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  let excludeRuleIds = options.excludeRuleIds;
  if (excludeRuleIds == null && tunnelId > 0) {
    const db = await getDb();
    if (db) {
      // A tunnel listener may be shared by the Agent's primary GOST rule,
      // but secondary rules still own independent exit ports.  Excluding all
      // rules here (the old fallback) made a stale secondary exit port
      // invisible during listener allocation and allowed a collision.  Only
      // exempt the lowest-id active GOST rule, which is the same primary
      // convention used by the Agent runtime.
      const rows = await db.select({
        id: forwardRules.id,
        isEnabled: forwardRules.isEnabled,
        pendingDelete: forwardRules.pendingDelete,
        isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
        forwardType: forwardRules.forwardType,
      })
        .from(forwardRules)
        .where(eq(forwardRules.tunnelId, tunnelId));
      const primaryId = (rows as any[])
        .filter((row) => (
          !databaseBool(row.pendingDelete)
          && !databaseBool(row.isForwardGroupTemplate)
          && databaseBool(row.isEnabled)
          && String(row.forwardType || "").trim().toLowerCase() === "gost"
        ))
        .map((row) => Number(row.id || 0))
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((left, right) => left - right)[0];
      excludeRuleIds = primaryId ? [primaryId] : [];
    }
  }
  const host = await getHostById(hostId) as any;
  const listenerPort = Number(options.currentPort ?? tunnelInput?.listenPort ?? 0);
  let sameTunnelResource: TunnelListenerExemptionInput | undefined;
  if (tunnelId > 0 && listenerPort > 0) {
    const resources: TunnelListenerExemption[] = [{
      tunnelId,
      port: listenerPort,
      kind: "primary",
      resourceId: tunnelId,
    }];
    // A multi-hop tunnel persists the final hop as a mirror of the primary
    // listener. Exempt that exact hop row as well; exempting the whole
    // tunnel would incorrectly hide unrelated extra/hop listeners.
    const finalHop = (await getTunnelHops(tunnelId))
      .filter((hop: any) => Number(hop?.hostId || 0) === hostId)
      .sort((left: any, right: any) => Number(right?.seq || 0) - Number(left?.seq || 0))[0];
    if (finalHop
      && Number(finalHop.listenPort || 0) === listenerPort
      && Number(finalHop.id || 0) > 0) {
      resources.push({
        tunnelId,
        port: listenerPort,
        kind: "hop",
        resourceId: Number(finalHop.id),
      });
    }
    sameTunnelResource = resources;
  }
  return reserveTunnelExitPort({
    hostId,
    preferredStart: host?.portRangeStart,
    preferredEnd: host?.portRangeEnd,
    currentPort: listenerPort,
    reservedPorts: options.reservedPorts,
    excludeRuleIds,
    // The listener belongs to this tunnel.  Without this opt-in the generic
    // exit-port helper sees the tunnel's own listen row as a conflict and
    // reallocates a new port on every update that omits listenPort.
    allowSameTunnelListener: true,
    sameTunnelResource,
    excludeTunnelId: tunnelId > 0 ? tunnelId : undefined,
    protocol: options.protocol ?? "both",
  });
}

/**
 * Ensure a persisted tunnel listener still belongs to the destination Agent's
 * effective port policy.  Tunnel rows can outlive a NAT range change (and
 * older releases could save a high, unrestricted port).  Callers that create
 * a rule must repair the tunnel row first; changing only the rule's
 * `tunnelExitPort` would leave an nginx-stream listener on the old port while
 * the rule points at the new one.
 *
 * The returned reservation is intentionally kept by the caller until its
 * related rule/tunnel write has completed.  This closes the small race in
 * which another concurrent allocator could claim the repaired listener.
 */
export async function ensureTunnelListenerPortPolicy(
  tunnelInput: any,
  options: {
    hostId?: number;
    currentPort?: unknown;
    excludeRuleIds?: number | number[];
    protocol?: unknown;
    syncSharedPrimaryRule?: boolean;
  } = {},
): Promise<{
  tunnel: any;
  port: number;
  changed: boolean;
  reservation: HostPortReservation;
} | null> {
  const tunnelId = Number(tunnelInput?.id || 0);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return null;
  const currentTunnel = await getTunnelById(tunnelId) || tunnelInput;
  const hostId = Number(options.hostId || currentTunnel?.exitHostId || 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  const currentPort = Number(options.currentPort ?? currentTunnel?.listenPort ?? 0);
  const reservation = await reserveTunnelListenerPort(currentTunnel, {
    hostId,
    currentPort,
    excludeRuleIds: options.excludeRuleIds,
    protocol: options.protocol ?? "both",
  });
  if (!reservation) return null;

  const nextPort = Number(reservation.port);
  const changed = nextPort !== currentPort
    || Number(currentTunnel?.exitHostId || 0) !== hostId;
  const syncSharedPrimaryRule = options.syncSharedPrimaryRule ?? usesSharedTunnelPrimaryListener(currentTunnel);
  try {
    if (changed) {
      await updateTunnel(tunnelId, {
        listenPort: nextPort,
        // A listener repair invalidates the previous runtime state.  The
        // normal refresh path will reapply the tunnel and its rules.
        isRunning: false,
      } as any);
      await syncTunnelListenerPortReferences(tunnelId, nextPort, {
        syncSharedPrimaryRule,
        hostId,
      });
    }
    // Keep the object consumed by the current request in sync with the row we
    // just repaired; otherwise the subsequent rule allocation would still
    // use the stale listener value.
    tunnelInput.listenPort = nextPort;
    if (Number(tunnelInput.exitHostId || 0) === hostId) tunnelInput.exitHostId = hostId;
    return {
      tunnel: tunnelInput,
      port: nextPort,
      changed,
      reservation,
    };
  } catch (error) {
    reservation.release();
    throw error;
  }
}

/**
 * Keep the persisted references that share a tunnel listener in sync after a
 * listener repair. The final multi-hop row always follows the tunnel
 * listener. The Agent also uses the listener for the lowest-id active GOST
 * rule (for every GOST transport, plus nginx_stream), so that primary rule
 * must follow it as well.
 */
export async function syncTunnelListenerPortReferences(
  tunnelIdValue: number,
  listenPortValue: number,
  options: { syncSharedPrimaryRule?: boolean; hostId?: number } = {},
) {
  const tunnelId = Number(tunnelIdValue || 0);
  const listenPort = Number(listenPortValue || 0);
  const db = await getDb();
  if (!db || !Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isInteger(listenPort) || listenPort <= 0) return;

  const hops = await db.select({ id: tunnelHops.id, seq: tunnelHops.seq, hostId: tunnelHops.hostId })
    .from(tunnelHops)
    .where(eq(tunnelHops.tunnelId, tunnelId))
    .orderBy(desc(tunnelHops.seq));
  const finalHop = hops[0];
  if (finalHop && (!options.hostId || Number(finalHop.hostId) === Number(options.hostId))) {
    await db.update(tunnelHops).set({ listenPort, updatedAt: nowDate() } as any)
      .where(eq(tunnelHops.id, Number(finalHop.id)));
  }

  if (!options.syncSharedPrimaryRule) return;
  const rules = await db.select({
    id: forwardRules.id,
    isEnabled: forwardRules.isEnabled,
    pendingDelete: forwardRules.pendingDelete,
    isForwardGroupTemplate: forwardRules.isForwardGroupTemplate,
    forwardType: forwardRules.forwardType,
  }).from(forwardRules).where(eq(forwardRules.tunnelId, tunnelId));
  const primary = (rules as any[])
    .filter((rule) => (
      !databaseBool(rule.pendingDelete)
      && !databaseBool(rule.isForwardGroupTemplate)
      && databaseBool(rule.isEnabled)
      && String(rule.forwardType || "").trim().toLowerCase() === "gost"
    ))
    .sort((left, right) => Number(left.id) - Number(right.id))[0];
  if (primary) {
    await db.update(forwardRules).set({
      tunnelExitPort: listenPort,
      isRunning: false,
      updatedAt: nowDate(),
    } as any).where(eq(forwardRules.id, Number(primary.id)));
  }
}

/**
 * Revalidate the primary exit-port fields after a tunnel endpoint changes.
 *
 * `tunnelExitPort` is persisted on the entry rule, but it is a listener on
 * the tunnel's exit Agent.  Moving a tunnel to another Agent (or repairing
 * its listener after a NAT policy change) therefore makes the old value only
 * a preference.  Keep disabled, pending-delete and template rows untouched;
 * they are not part of the Agent data plane and rotating them can create
 * surprising conflicts when they are restored later.
 *
 * GOST and Nginx Stream have one shared primary listener per tunnel. The
 * lowest-id active GOST rule is the runtime primary and must point at
 * `tunnel.listenPort`; all other active GOST rules receive independent exit
 * ports. Load-balanced mapping rows are reconciled separately.
 */
export async function reconcileTunnelRulePrimaryExitPorts(
  tunnelInput: any,
  options: {
    hostId?: number;
    listenPort?: number;
    /**
     * Reservations held by the surrounding tunnel update. The primary
     * managed GOST/Nginx rule may reuse the tunnel listener reservation;
     * all other rules must treat those ports as occupied while they are
     * allocated.  Reservations acquired by this helper are released here,
     * while caller-owned reservations remain held until its transaction ends.
     */
    reservations?: readonly HostPortReservation[];
  } = {},
) {
  const tunnelId = Number(tunnelInput?.id || 0);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return { processed: 0, changed: 0 };
  const tunnel = await getTunnelById(tunnelId) || tunnelInput;
  const mode = String(tunnel?.mode || "").trim().toLowerCase();
  // ForwardX does not use forwardRules.tunnelExitPort for its transport; its
  // endpoint/mimic state is reconciled by the dedicated ForwardX paths.
  if (!tunnel || mode === "forwardx") return { processed: 0, changed: 0 };
  const hostId = Number(options.hostId || tunnel?.exitHostId || 0);
  const listenPort = Number(options.listenPort ?? tunnel?.listenPort ?? 0);
  if (!Number.isInteger(hostId) || hostId <= 0) return { processed: 0, changed: 0 };
  const host = await getHostById(hostId) as any;
  if (!host) return { processed: 0, changed: 0 };
  const rules = (await getForwardRulesByTunnel(tunnelId) as any[])
    .filter((rule) => (
      rule
      && !databaseBool(rule.pendingDelete)
      && !databaseBool(rule.isForwardGroupTemplate)
      && databaseBool(rule.isEnabled)
      && String(rule.forwardType || "").trim().toLowerCase() === "gost"
    ))
    .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  if (rules.length === 0) return { processed: 0, changed: 0 };

  const activeRuleIds = rules.map((rule) => Number(rule.id || 0)).filter((id) => id > 0);
  const sharedPrimaryId = usesSharedTunnelPrimaryListener(tunnel) ? activeRuleIds[0] || 0 : 0;
  const reservedPorts: number[] = [];
  const heldReservations: HostPortReservation[] = [];
  const callerReservations = Array.isArray(options.reservations)
    ? options.reservations
    : [];
  // Keep ports acquired by the enclosing tunnel update visible to the
  // allocator even though they are not persisted until the transaction is
  // committed.  This prevents a secondary rule from selecting a newly
  // allocated listener/extra endpoint.
  for (const reservation of callerReservations) {
    if (Number(reservation?.hostId) !== hostId) continue;
    const port = Number(reservation?.port || 0);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !reservedPorts.includes(port)) {
      reservedPorts.push(port);
    }
  }
  let changed = 0;
  const db = await getDb();
  if (!db) return { processed: 0, changed: 0 };

  try {
    for (const rule of rules) {
      const ruleId = Number(rule.id || 0);
      if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
      const isSharedPrimary = sharedPrimaryId > 0 && ruleId === sharedPrimaryId;
      const previousPort = Number(rule.tunnelExitPort || 0);
      const preferredPort = isSharedPrimary ? listenPort : previousPort;
      if (isSharedPrimary && preferredPort <= 0) {
        throw new Error("隧道缺少有效的出口监听端口");
      }

      // A tunnel update may already hold the listener reservation. Reusing it
      // for the shared primary avoids a false "port busy" result and keeps the
      // reservation alive until the enclosing transaction has written every
      // related row.  Only the exact listener port is reusable; extra/hop
      // reservations must remain conflicts for rule-level allocations.
      const callerListenerReservation = isSharedPrimary
        ? callerReservations.find((reservation) => (
          Number(reservation?.hostId) === hostId
          && Number(reservation?.port) === preferredPort
        ))
        : undefined;
      let reservation: HostPortReservation | null = callerListenerReservation || null;
      if (!reservation) {
        reservation = await reserveTunnelExitPort({
          hostId,
          preferredStart: host.portRangeStart,
          preferredEnd: host.portRangeEnd,
          currentPort: preferredPort,
          reservedPorts,
          excludeRuleIds: activeRuleIds,
          // Only the shared primary may share the tunnel listener. The exact
          // resource descriptor prevents an extra/hop listener in the same
          // tunnel from being mistaken for the primary socket.
          ...(isSharedPrimary
            ? {
              sameTunnelResource: {
                tunnelId,
                port: preferredPort,
                kind: "primary" as const,
                resourceId: tunnelId,
              },
              allowSameTunnelListener: true,
            }
            : {}),
          excludeTunnelId: tunnelId,
          protocol: "both",
        });
      }
      if (!reservation) {
        throw new Error(`出口 Agent ${host.name || hostId} 已无可用隧道端口`);
      }
      if (!callerListenerReservation) heldReservations.push(reservation);
      const nextPort = Number(reservation.port);
      if (!reservedPorts.includes(nextPort)) reservedPorts.push(nextPort);

      // For shared primary runtimes the tunnel listener is authoritative. Never accept
      // a fallback allocation here: that would make the rule point at a port
      // where the tunnel runtime is not listening.
      if (isSharedPrimary && nextPort !== preferredPort) {
        throw new Error(`隧道监听端口 ${preferredPort} 无法复用`);
      }
      if (nextPort === previousPort) continue;
      await db.update(forwardRules).set({
        tunnelExitPort: nextPort,
        isRunning: false,
        updatedAt: nowDate(),
      } as any).where(eq(forwardRules.id, ruleId));
      changed += 1;
    }
    return { processed: rules.length, changed };
  } finally {
    releaseHostPortReservations(heldReservations);
  }
}

export async function isTunnelListenPortUsed(exitHostId: number, listenPort: number, excludeTunnelId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: tunnels.id }).from(tunnels).where(and(
    eq(tunnels.exitHostId, exitHostId),
    sql`(${tunnels.listenPort} = ${listenPort} OR ${tunnels.mimicPort} = ${listenPort})`,
  ));
  const extraRows = await db.select({ tunnelId: tunnelExitNodes.tunnelId }).from(tunnelExitNodes).where(and(
    eq(tunnelExitNodes.hostId, exitHostId),
    sql`(${tunnelExitNodes.listenPort} = ${listenPort} OR ${tunnelExitNodes.mimicPort} = ${listenPort})`,
  ));
  const hopRows = await db.select({ tunnelId: tunnelHops.tunnelId }).from(tunnelHops).where(and(
    eq(tunnelHops.hostId, exitHostId),
    sql`(${tunnelHops.listenPort} = ${listenPort} OR ${tunnelHops.mimicPort} = ${listenPort})`,
  ));
  return rows.some((row: any) => row.id !== excludeTunnelId)
    || extraRows.some((row: any) => row.tunnelId !== excludeTunnelId)
    || hopRows.some((row: any) => row.tunnelId !== excludeTunnelId);
}

const mimicPortAllocationLocks = new Map<number, Promise<{
  tunnel: any;
  hops: any[];
  exitNodes: any[];
  changed: boolean;
}>>();

async function allocateTunnelMimicPort(
  hostId: number,
  reservedPorts: number[],
  options: { listenPort?: number; tunnelId?: number } = {},
) {
  const host = await getHostById(hostId) as any;
  if (!host) return null;
  const listenPort = Number(options.listenPort || 0);
  const tunnelId = Number(options.tunnelId || 0);
  return reserveAvailableHostPort({
    hostId,
    protocol: "both",
    findPort: (processReservedPorts) => findAvailableTunnelExitPort(
      hostId,
      // The host policy (including any explicit allowlist entries) is the
      // source of truth for mimic UDP ports.  Passing the host range back as
      // a second intersecting policy can accidentally discard allowlist
      // ports, so leave the optional preferred range unset here.
      undefined,
      undefined,
      [...reservedPorts, ...processReservedPorts, ...(listenPort > 0 ? [listenPort] : [])],
    ),
    isUsed: async (port) => (
      port === listenPort
      || await isPortUsedOnHost(hostId, port, undefined, "both", tunnelId > 0 ? tunnelId : undefined)
    ),
  });
}

export async function ensureForwardXMimicPorts(tunnelInput: any, hopsInput: any[] = [], exitNodesInput: any[] = []) {
  const tunnelId = Number(tunnelInput?.id || 0);
  if (tunnelId <= 0) {
    return { tunnel: tunnelInput, hops: hopsInput, exitNodes: exitNodesInput, changed: false };
  }
  const existing = mimicPortAllocationLocks.get(tunnelId);
  if (existing) return existing;
  const work = (async () => {
    const db = await getDb();
    if (!db) return { tunnel: tunnelInput, hops: hopsInput, exitNodes: exitNodesInput, changed: false };
    const tunnel = { ...tunnelInput };
    const hops = hopsInput.map((hop) => ({ ...hop }));
    const exitNodes = exitNodesInput.map((node) => ({ ...node }));
    const reservedByHost = new Map<number, number[]>();
    const usedByHost = new Map<number, Set<number>>();
    const heldReservations: HostPortReservation[] = [];
    let changed = false;
    const reserve = (hostId: number, ...ports: unknown[]) => {
      const current = reservedByHost.get(hostId) || [];
      for (const value of ports) {
        const port = Number(value || 0);
        if (port > 0 && !current.includes(port)) current.push(port);
      }
      reservedByHost.set(hostId, current);
      return current;
    };
    // Reserve every listener up front.  A mimic port must never shadow a
    // listener belonging to another row in this tunnel, even when that row
    // appears later in the input array.
    const reserveListeners = (items: any[], fallbackHostId?: number) => {
      for (const item of items) {
        const hostId = Number(item?.hostId || fallbackHostId || 0);
        const listenPort = Number(item?.listenPort || 0);
        if (hostId > 0 && listenPort > 0) reserve(hostId, listenPort);
      }
    };
    reserveListeners(hops);
    reserveListeners(exitNodes);
    // The tunnel row mirrors the final hop's listener. Include it as well for
    // malformed/partially migrated rows where the hop list is missing its
    // final entry.
    reserveListeners([{ hostId: tunnel.exitHostId, listenPort: tunnel.listenPort }]);

    // Read persisted usage once per host.  ensureForwardXMimicPorts runs on
    // heartbeat reconciliation; issuing the full multi-table occupancy query
    // for every already-valid mimic port would otherwise add substantial
    // SQLite/event-loop overhead on installations with many tunnels.
    const usedPortsForHost = async (hostId: number) => {
      const cached = usedByHost.get(hostId);
      if (cached) return cached;
      const used = await getUsedPortsOnHost(hostId, undefined, "both", tunnelId);
      usedByHost.set(hostId, used);
      return used;
    };

    const ensurePort = async (hostId: number, listenPort: number, currentPort: unknown) => {
      const current = Number(currentPort || 0);
      const reserved = reserve(hostId, listenPort);
      const alreadyReserved = reserved.includes(current);
      const host = await getHostById(hostId) as any;
      const hostPolicy = portPolicyFrom(host);
      const usedPorts = await usedPortsForHost(hostId);
      // Existing values are preferences, not an exemption from the current
      // NAT policy or occupancy checks.  This repairs stale values after a
      // host range/allowlist change and prevents two tunnel rows from sharing
      // one mimic socket.
      if (current > 0
        && current !== listenPort
        && !alreadyReserved
        && isPortAllowedByPolicy(current, hostPolicy)
        && !usedPorts.has(current)) {
        // Keep the preserved value in the same in-process reservation table
        // used by newly allocated ports.  Without this, two concurrent
        // heartbeat reconciliations could both observe the same valid legacy
        // value and subsequently allocate another row on top of it.
        const preservedReservation = await reserveSpecificHostPort({
          hostId,
          port: current,
          protocol: "both",
          // `usedPorts` is a snapshot taken once for this tunnel/host.  It
          // includes all persisted occupants outside this tunnel; the local
          // reservation prevents races inside this panel process while the
          // reconciliation transaction is being written.
          isUsed: async (port) => usedPorts.has(port),
        });
        if (preservedReservation) {
          heldReservations.push(preservedReservation);
          reserved.push(current);
          return current;
        }
        // A concurrent allocator won the reservation after the snapshot;
        // fall through to choose a different port.
      }
      const reservation = await allocateTunnelMimicPort(hostId, reserved, { listenPort, tunnelId });
      if (!reservation) return 0;
      heldReservations.push(reservation);
      reserve(hostId, reservation.port);
      usedPorts.add(reservation.port);
      return reservation.port;
    };

    try {
    if (hops.length >= 2) {
      for (let index = 1; index < hops.length; index++) {
        const hop = hops[index];
        const hostId = Number(hop.hostId || 0);
        const listenPort = Number(hop.listenPort || 0);
        if (hostId <= 0 || listenPort <= 0) continue;
        // The primary exit port is stored on the tunnel. Prefer it for the
        // final multi-hop node so an administrator-specified port is retained.
        const requestedPort = index === hops.length - 1 && Number(tunnel.mimicPort || 0) > 0
          ? Number(tunnel.mimicPort)
          : hop.mimicPort;
        const mimicPort = await ensurePort(hostId, listenPort, requestedPort);
        if (mimicPort <= 0) throw new Error(`主机 ${hostId} 已无可用的 mimic UDP 线路端口`);
        if (Number(hop.mimicPort || 0) !== mimicPort) {
          await db.update(tunnelHops).set({ mimicPort } as any).where(eq(tunnelHops.id, Number(hop.id)));
          hop.mimicPort = mimicPort;
          changed = true;
        }
        if (index === hops.length - 1 && Number(tunnel.mimicPort || 0) !== mimicPort) {
          await db.update(tunnels).set({ mimicPort, updatedAt: nowDate() } as any).where(eq(tunnels.id, tunnelId));
          tunnel.mimicPort = mimicPort;
          changed = true;
        }
      }
    } else {
      const hostId = Number(tunnel.exitHostId || 0);
      const listenPort = Number(tunnel.listenPort || 0);
      if (hostId > 0 && listenPort > 0) {
        const mimicPort = await ensurePort(hostId, listenPort, tunnel.mimicPort);
        if (mimicPort <= 0) throw new Error(`出口 Agent ${hostId} 已无可用的 mimic UDP 线路端口`);
        if (Number(tunnel.mimicPort || 0) !== mimicPort) {
          await db.update(tunnels).set({ mimicPort, updatedAt: nowDate() } as any).where(eq(tunnels.id, tunnelId));
          tunnel.mimicPort = mimicPort;
          changed = true;
        }
      }
    }

    for (const node of exitNodes) {
      if (!databaseBool(node?.isEnabled, true)) continue;
      const hostId = Number(node.hostId || 0);
      const listenPort = Number(node.listenPort || 0);
      if (hostId <= 0 || listenPort <= 0) continue;
      const mimicPort = await ensurePort(hostId, listenPort, node.mimicPort);
      if (mimicPort <= 0) throw new Error(`负载出口 Agent ${hostId} 已无可用的 mimic UDP 线路端口`);
      if (Number(node.mimicPort || 0) !== mimicPort) {
        await db.update(tunnelExitNodes).set({ mimicPort, updatedAt: nowDate() } as any).where(eq(tunnelExitNodes.id, Number(node.id)));
        node.mimicPort = mimicPort;
        changed = true;
      }
    }
    return { tunnel, hops, exitNodes, changed };
    } finally {
      releaseHostPortReservations(heldReservations);
    }
  })();
  mimicPortAllocationLocks.set(tunnelId, work);
  try {
    return await work;
  } finally {
    if (mimicPortAllocationLocks.get(tunnelId) === work) mimicPortAllocationLocks.delete(tunnelId);
  }
}

export async function updateTunnelRunningStatus(id: number, isRunning: boolean) {
  const db = await getDb();
  if (!db) return;
  await db.update(tunnels).set({ isRunning, updatedAt: nowDate() }).where(eq(tunnels.id, id));
}

export async function updateTunnelTestResult(id: number, data: {
  status: string;
  latencyMs?: number | null;
  message?: string | null;
}) {
  const db = await getDb();
  if (!db) return;
  const updates: any = {
    lastTestStatus: data.status,
    lastTestMessage: data.message ?? null,
    lastTestAt: nowDate(),
    updatedAt: nowDate(),
  };
  if (data.status !== "pending" && data.status !== "running") {
    updates.lastLatencyMs = data.latencyMs ?? null;
  }
  await db.update(tunnels).set(updates).where(eq(tunnels.id, id));
}

function protocolConflictCondition(_protocol: unknown) {
  // Agent runtime state and cleanup are keyed by listen port. Treat a port as
  // one rule identity even when the operating system could bind TCP and UDP
  // separately, otherwise the two rules overwrite each other's local state.
  return null;
}

export async function getUsedPortsOnHost(
  hostId: number,
  excludeRuleId?: number | number[],
  protocol?: unknown,
  excludeTunnelId?: number,
  excludeRuleExitPorts = true,
): Promise<Set<number>> {
  const db = await getDb();
  if (!db) return new Set();
  const excludedIds = Array.from(new Set(
    (Array.isArray(excludeRuleId) ? excludeRuleId : [excludeRuleId])
      .map((id) => Number(id || 0))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  const excludedTunnelId = Number(excludeTunnelId || 0);
  const excludeRulesSql = excludedIds.length > 0
    ? sql`${forwardRules.id} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`
    : undefined;
  const excludeMappingsSql = excludedIds.length > 0
    ? sql`${forwardRuleTunnelExits.ruleId} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`
    : undefined;
  const protocolCond = protocolConflictCondition(protocol);

  const usedRuleConds: any[] = [
    eq(forwardRules.hostId, hostId),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRulesSql) usedRuleConds.push(excludeRulesSql);
  if (protocolCond) usedRuleConds.push(protocolCond);

  const usedPrimaryExitConds: any[] = [
    eq(tunnels.exitHostId, hostId),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRuleExitPorts && excludeRulesSql) usedPrimaryExitConds.push(excludeRulesSql);
  if (protocolCond) usedPrimaryExitConds.push(protocolCond);

  const usedExitConds: any[] = [eq(forwardRuleTunnelExits.exitHostId, hostId)];
  if (excludeRuleExitPorts && excludeMappingsSql) usedExitConds.push(excludeMappingsSql);
  if (protocolCond) usedExitConds.push(protocolCond);

  const [
    usedRules,
    usedPrimaryExits,
    usedMappedExits,
    usedTunnels,
    usedExtraTunnelNodes,
    usedHops,
  ] = await Promise.all([
    db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(...usedRuleConds)),
    db.select({ port: forwardRules.tunnelExitPort })
      .from(forwardRules)
      .innerJoin(tunnels, eq(forwardRules.tunnelId, tunnels.id))
      .where(and(...usedPrimaryExitConds)),
    db.select({ port: forwardRuleTunnelExits.tunnelExitPort })
      .from(forwardRuleTunnelExits)
      .innerJoin(forwardRules, eq(forwardRuleTunnelExits.ruleId, forwardRules.id))
      .where(and(...usedExitConds)),
    db.select({ id: tunnels.id, listenPort: tunnels.listenPort, mimicPort: tunnels.mimicPort })
      .from(tunnels)
      .where(eq(tunnels.exitHostId, hostId)),
    db.select({ tunnelId: tunnelExitNodes.tunnelId, listenPort: tunnelExitNodes.listenPort, mimicPort: tunnelExitNodes.mimicPort })
      .from(tunnelExitNodes)
      .where(eq(tunnelExitNodes.hostId, hostId)),
    db.select({ tunnelId: tunnelHops.tunnelId, listenPort: tunnelHops.listenPort, mimicPort: tunnelHops.mimicPort })
      .from(tunnelHops)
      .where(eq(tunnelHops.hostId, hostId)),
  ]);

  const used = new Set<number>();
  const addPort = (value: unknown) => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) used.add(port);
  };
  usedRules.forEach((row: any) => addPort(row.port));
  usedPrimaryExits.forEach((row: any) => addPort(row.port));
  usedMappedExits.forEach((row: any) => addPort(row.port));
  usedTunnels.forEach((row: any) => {
    if (Number(row.id) === excludedTunnelId) return;
    addPort(row.listenPort);
    addPort(row.mimicPort);
  });
  usedExtraTunnelNodes.forEach((row: any) => {
    if (Number(row.tunnelId) === excludedTunnelId) return;
    addPort(row.listenPort);
    addPort(row.mimicPort);
  });
  usedHops.forEach((row: any) => {
    if (Number(row.tunnelId) === excludedTunnelId) return;
    addPort(row.listenPort);
    addPort(row.mimicPort);
  });
  return used;
}

/** 检查某主机上的某端口是否已被占用 */
export async function isPortUsedOnHost(
  hostId: number,
  sourcePort: number,
  excludeRuleId?: number | number[],
  protocol?: unknown,
  excludeTunnelId?: number,
  excludeRuleExitPorts = true,
  allowTunnelListener?: TunnelListenerExemptionInput,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const excludedIds = Array.from(new Set(
    (Array.isArray(excludeRuleId) ? excludeRuleId : [excludeRuleId])
      .map((id) => Number(id || 0))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  const excludedTunnelId = Number(excludeTunnelId || 0);
  const listenerExemptions = allowTunnelListener === undefined
    ? undefined
    : normalizeTunnelListenerExemptions(allowTunnelListener);
  const conds: any[] = [
    eq(forwardRules.hostId, hostId),
    eq(forwardRules.sourcePort, sourcePort),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  const protocolCond = protocolConflictCondition(protocol);
  if (protocolCond) conds.push(protocolCond);
  if (excludedIds.length > 0) {
    conds.push(sql`${forwardRules.id} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  const r = await db.select({ count: sqlCountAll() }).from(forwardRules).where(and(...conds));
  if ((Number(r[0]?.count) || 0) > 0) return true;
  const primaryExitConds: any[] = [
    eq(tunnels.exitHostId, hostId),
    eq(forwardRules.tunnelExitPort, sourcePort),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRuleExitPorts && excludedIds.length > 0) {
    primaryExitConds.push(sql`${forwardRules.id} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (protocolCond) primaryExitConds.push(protocolCond);
  const primaryExitRows = await db.select({ count: sqlCountAll() })
    .from(forwardRules)
    .innerJoin(tunnels, eq(forwardRules.tunnelId, tunnels.id))
    .where(and(...primaryExitConds));
  if ((Number(primaryExitRows[0]?.count) || 0) > 0) return true;
  const exitConds: any[] = [
    eq(forwardRuleTunnelExits.exitHostId, hostId),
    eq(forwardRuleTunnelExits.tunnelExitPort, sourcePort),
  ];
  if (excludeRuleExitPorts && excludedIds.length > 0) {
    exitConds.push(sql`${forwardRuleTunnelExits.ruleId} NOT IN (${sql.join(excludedIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (protocolCond) exitConds.push(protocolCond);
  const exitRows = await db.select({ count: sqlCountAll() })
    .from(forwardRuleTunnelExits)
    .innerJoin(forwardRules, eq(forwardRuleTunnelExits.ruleId, forwardRules.id))
    .where(and(...exitConds));
  if ((Number(exitRows[0]?.count) || 0) > 0) return true;
  const tunnelRows = await db.select({ id: tunnels.id, listenPort: tunnels.listenPort, mimicPort: tunnels.mimicPort }).from(tunnels).where(and(
    eq(tunnels.exitHostId, hostId),
    sql`(${tunnels.listenPort} = ${sourcePort} OR ${tunnels.mimicPort} = ${sourcePort})`,
  ));
  if (tunnelRows.some((row: any) => {
    const sameTunnel = excludedTunnelId > 0 && Number(row.id) === excludedTunnelId;
    const sameListener = listenerExemptions?.some((exemption) => (
      exemption.kind === "primary"
      && Number(row.id) === Number(exemption.tunnelId)
      && (!exemption.resourceId || Number(row.id) === Number(exemption.resourceId))
      && Number(row.listenPort) === Number(exemption.port)
      && Number(row.listenPort) === Number(sourcePort)
    ));
    if (listenerExemptions !== undefined) return !sameListener;
    // Without a precise exemption, preserve the legacy excludeTunnelId
    // behaviour used by mimic reconciliation (all rows in the current tunnel
    // are self-owned). Callers reserving a listener should pass an exemption
    // so that extra/hop rows are not accidentally ignored.
    return !sameTunnel;
  })) return true;
  const extraRows = await db.select({ id: tunnelExitNodes.id, tunnelId: tunnelExitNodes.tunnelId, listenPort: tunnelExitNodes.listenPort, mimicPort: tunnelExitNodes.mimicPort }).from(tunnelExitNodes).where(and(
    eq(tunnelExitNodes.hostId, hostId),
    sql`(${tunnelExitNodes.listenPort} = ${sourcePort} OR ${tunnelExitNodes.mimicPort} = ${sourcePort})`,
  ));
  if (extraRows.some((row: any) => {
    const sameTunnel = excludedTunnelId > 0 && Number(row.tunnelId) === excludedTunnelId;
    const sameListener = listenerExemptions?.some((exemption) => (
      exemption.kind === "extra"
      && Number(row.tunnelId) === Number(exemption.tunnelId)
      && (!exemption.resourceId || Number(row.id) === Number(exemption.resourceId))
      && Number(row.listenPort) === Number(exemption.port)
      && Number(row.listenPort) === Number(sourcePort)
    ));
    if (listenerExemptions !== undefined) return !sameListener;
    return !sameTunnel;
  })) return true;
  const hopRows = await db.select({ id: tunnelHops.id, tunnelId: tunnelHops.tunnelId, listenPort: tunnelHops.listenPort, mimicPort: tunnelHops.mimicPort }).from(tunnelHops).where(and(
    eq(tunnelHops.hostId, hostId),
    sql`(${tunnelHops.listenPort} = ${sourcePort} OR ${tunnelHops.mimicPort} = ${sourcePort})`,
  ));
  return hopRows.some((row: any) => {
    const sameTunnel = excludedTunnelId > 0 && Number(row.tunnelId) === excludedTunnelId;
    const sameListener = listenerExemptions?.some((exemption) => (
      exemption.kind === "hop"
      && Number(row.tunnelId) === Number(exemption.tunnelId)
      && (!exemption.resourceId || Number(row.id) === Number(exemption.resourceId))
      && Number(row.listenPort) === Number(exemption.port)
      && Number(row.listenPort) === Number(sourcePort)
    ));
    if (listenerExemptions !== undefined) return !sameListener;
    return !sameTunnel;
  });
}

/** 在主机端口区间内找一个未被占用的随机端口 */
export async function findAvailablePort(
  hostId: number,
  rangeStart?: number | null,
  rangeEnd?: number | null,
  protocol?: unknown,
  reservedPorts: number[] = [],
  excludeRuleIds: number | number[] = [],
  allowedRanges: Array<{ start: number; end: number }> = [],
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const host = await getHostById(hostId) as any;
  const subscriptionPolicy = allowedRanges.length > 0
    ? portPolicyFrom({ portRanges: allowedRanges })
    : null;
  // Preserve host allowlist ports when the explicit range is simply the
  // host's own configured range; a narrower tunnel range remains restrictive.
  let policy = combineHostPortPolicyWithRange(host, rangeStart, rangeEnd);
  if (subscriptionPolicy) {
    policy = combinePortPolicies(policy, subscriptionPolicy);
  }
  const usedPorts = await getUsedPortsOnHost(hostId, excludeRuleIds, protocol, undefined, false);
  for (const reservedPort of reservedPorts) {
    const port = Number(reservedPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) usedPorts.add(port);
  }
  return pickAvailablePort(policy, usedPorts, { start: 10000, end: 65535 });
}

// ==================== Tunnel Hops (Multi-hop) ====================

export async function getTunnelHops(tunnelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tunnelHops).where(eq(tunnelHops.tunnelId, tunnelId)).orderBy(asc(tunnelHops.seq));
}

export async function getTunnelHopsByTunnelIds(tunnelIds: number[]) {
  const ids = Array.from(new Set(tunnelIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select().from(tunnelHops).where(inArray(tunnelHops.tunnelId, ids)).orderBy(asc(tunnelHops.tunnelId), asc(tunnelHops.seq));
}

export async function getTunnelExitNodes(tunnelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, tunnelId)).orderBy(asc(tunnelExitNodes.seq));
}

export async function getTunnelExitNodesByTunnelIds(tunnelIds: number[]) {
  const ids = Array.from(new Set(tunnelIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select().from(tunnelExitNodes).where(sql`${tunnelExitNodes.tunnelId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).orderBy(asc(tunnelExitNodes.tunnelId), asc(tunnelExitNodes.seq));
}

export async function replaceTunnelExitNodes(tunnelId: number, nodes: Array<Omit<InsertTunnelExitNode, "id" | "tunnelId" | "createdAt" | "updatedAt">>) {
  return withDatabaseTransaction(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, tunnelId));
  for (const node of nodes) {
    await db.insert(tunnelExitNodes).values({
      tunnelId,
      seq: Number(node.seq),
      hostId: Number(node.hostId),
      listenPort: Number(node.listenPort),
      mimicPort: Number((node as any).mimicPort || 0),
      connectHost: node.connectHost ?? null,
      isEnabled: databaseBool(node.isEnabled, true),
    } as any);
  }
  });
}

export async function syncTunnelExitGroupEndpoints(
  tunnelInput: any,
  members: ExitGroupTunnelMember[],
  strategyInput: unknown,
) {
  const tunnelId = Number(tunnelInput?.id || 0);
  if (tunnelId <= 0) return { tunnel: tunnelInput, changed: false, previousHostIds: [], nextHostIds: [] };
  return withKeyedTaskLock(`tunnel:${tunnelId}`, async () => {
    const currentTunnel = await getTunnelById(tunnelId) as any;
    if (!currentTunnel) return { tunnel: tunnelInput, changed: false, previousHostIds: [], nextHostIds: [] };

    const [existingNodes, existingHops] = await Promise.all([
      getTunnelExitNodes(tunnelId),
      getTunnelHops(tunnelId),
    ]);
    const database = await getDb();
    if (!database) return { tunnel: currentTunnel, changed: false, previousHostIds: [], nextHostIds: [] };
    const mappedRules = String(currentTunnel.mode || "").toLowerCase() === "forwardx"
      ? []
      : await database.select().from(forwardRules).where(and(
        eq(forwardRules.tunnelId, tunnelId),
        eq(forwardRules.pendingDelete, false),
      ));
    const existingRuleExitMappings = await getForwardRuleTunnelExitsByRuleIds(
      (mappedRules as any[]).map((rule) => Number(rule.id || 0)),
    );
    const ruleExitPortsByHostId = new Map<number, Map<number, number>>();
    for (const rule of mappedRules as any[]) {
      const portsByHostId = new Map<number, number>();
      const primaryPort = Number(rule.tunnelExitPort || 0);
      if (Number(currentTunnel.exitHostId || 0) > 0 && primaryPort > 0) {
        portsByHostId.set(Number(currentTunnel.exitHostId), primaryPort);
      }
      ruleExitPortsByHostId.set(Number(rule.id), portsByHostId);
    }
    for (const mapping of existingRuleExitMappings as any[]) {
      const ruleId = Number(mapping.ruleId || 0);
      const hostId = Number(mapping.exitHostId || 0);
      const port = Number(mapping.tunnelExitPort || 0);
      if (ruleId <= 0 || hostId <= 0 || port <= 0) continue;
      const portsByHostId = ruleExitPortsByHostId.get(ruleId) || new Map<number, number>();
      if (!portsByHostId.has(hostId)) portsByHostId.set(hostId, port);
      ruleExitPortsByHostId.set(ruleId, portsByHostId);
    }
    const existingEndpoints = [
      {
        hostId: Number(currentTunnel.exitHostId || 0),
        listenPort: Number(currentTunnel.listenPort || 0),
        mimicPort: Number(currentTunnel.mimicPort || 0),
        connectHost: String(currentTunnel.connectHost || "").trim() || null,
      },
      ...(existingNodes as any[]),
    ];
    const planned = planExitGroupTunnelEndpoints(members, existingEndpoints);
    if (planned.length === 0) throw new Error("Enabled exit group must contain at least one enabled host");

    const heldReservations: HostPortReservation[] = [];
    // The Agent's lowest-id active GOST rule owns the shared tunnel listener.
    // Do not exclude every rule in the tunnel here: secondary GOST rules use
    // independent exit ports, and hiding them could cause a collision.
    const activeManagedRuleIds = (mappedRules as any[])
      .filter((rule) => (
        rule
        && !databaseBool(rule.pendingDelete)
        && !databaseBool(rule.isForwardGroupTemplate)
        && databaseBool(rule.isEnabled)
        && String(rule.forwardType || "").trim().toLowerCase() === "gost"
      ))
      .map((rule) => Number(rule.id || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((left, right) => left - right);
    const primaryManagedRuleId = usesSharedTunnelPrimaryListener(currentTunnel)
      ? (activeManagedRuleIds[0] || 0)
      : 0;
    const listenerSharingRuleIds = primaryManagedRuleId > 0 ? [primaryManagedRuleId] : [];
    try {
      for (let endpointIndex = 0; endpointIndex < planned.length; endpointIndex += 1) {
        const endpoint = planned[endpointIndex];
        const host = await getHostById(endpoint.hostId) as any;
        if (!host) throw new Error(`Exit Agent ${endpoint.hostId} does not exist`);
        const existingExtraNode = (existingNodes as any[]).find(
          (node) => Number(node?.hostId || 0) === Number(endpoint.hostId),
        );
        const existingEndpointPort = Number(endpoint.listenPort || 0);
        // The primary endpoint belongs to the tunnel row.  Extra endpoints
        // are separate tunnel_exit_nodes rows and may preserve only their own
        // exact row while it is being replaced.  Never let an extra/hop row
        // be hidden merely because it shares this tunnel id.
        const currentPrimaryHostId = Number(currentTunnel.exitHostId || 0);
        const sameTunnelResource = endpointIndex === 0
          ? (existingExtraNode && Number(existingExtraNode.id || 0) > 0 && existingEndpointPort > 0
            // An extra endpoint can be promoted to primary. It is about to be
            // removed/replaced, so its exact row may transfer the listener.
            ? {
              tunnelId: tunnelId,
              port: existingEndpointPort,
              kind: "extra" as const,
              resourceId: Number(existingExtraNode.id),
            }
            : (existingEndpointPort > 0
              ? { tunnelId: tunnelId, port: existingEndpointPort, kind: "primary" as const, resourceId: tunnelId }
              : undefined))
          : (endpoint.hostId === currentPrimaryHostId && existingEndpointPort > 0
            // Conversely, when the old primary is demoted to an extra
            // endpoint, its listener can transfer to the new extra row.
            ? { tunnelId: tunnelId, port: existingEndpointPort, kind: "primary" as const, resourceId: tunnelId }
            : (existingExtraNode && Number(existingExtraNode.id || 0) > 0 && existingEndpointPort > 0
              ? {
                tunnelId: tunnelId,
                port: existingEndpointPort,
                kind: "extra" as const,
                resourceId: Number(existingExtraNode.id),
              }
              : undefined));
        // Existing endpoint listeners are preferences, not an exemption from
        // the current Agent NAT policy.  Revalidate them on every group sync
        // so a host range change repairs stale high ports automatically.
        const reservation = await reserveTunnelExitPort({
          hostId: endpoint.hostId,
          preferredStart: host.portRangeStart,
          preferredEnd: host.portRangeEnd,
          currentPort: endpoint.listenPort,
          excludeRuleIds: listenerSharingRuleIds,
          allowSameTunnelListener: endpointIndex === 0,
          sameTunnelResource,
          excludeTunnelId: tunnelId,
          protocol: "both",
        });
        if (!reservation) throw new Error(`Exit Agent ${host.name || endpoint.hostId} has no available tunnel port`);
        heldReservations.push(reservation);
        endpoint.listenPort = reservation.port;
      }

      const primary = planned[0];
      const nextNodes = planned.slice(1).map((endpoint, index) => ({
        seq: index + 1,
        hostId: endpoint.hostId,
        listenPort: endpoint.listenPort,
        mimicPort: endpoint.mimicPort,
        connectHost: endpoint.connectHost,
        isEnabled: true,
      }));
      const strategy = normalizeExitGroupStrategy(strategyInput);
      const primaryHost = await getHostById(primary.hostId) as any;
      const privateAddress = String(primaryHost?.tunnelEntryIp || "").trim();
      const networkType = primary.connectHost && privateAddress && primary.connectHost === privateAddress ? "private" : "public";
      const previousHostIds = existingEndpoints
        .map((endpoint) => Number(endpoint.hostId || 0))
        .filter((hostId) => hostId > 0);
      const nextHostIds = planned.map((endpoint) => endpoint.hostId);
      const previousSignature = JSON.stringify(existingEndpoints.map((endpoint) => ({
        hostId: Number(endpoint.hostId || 0),
        listenPort: Number(endpoint.listenPort || 0),
        mimicPort: Number(endpoint.mimicPort || 0),
        connectHost: String(endpoint.connectHost || "").trim() || null,
      })));
      const nextSignature = JSON.stringify(planned);
      const endpointsChanged = previousSignature !== nextSignature;
      // Database adapters may return boolean columns as strings (notably
      // SQLite/JSON-backed legacy rows).  `!!"0"` is true, so normalize the
      // persisted value before deciding whether the runtime state changed.
      const loadBalanceChanged = databaseBool(currentTunnel.loadBalanceEnabled) !== (nextNodes.length > 0);
      const changed = endpointsChanged
        || String(currentTunnel.loadBalanceStrategy || "") !== strategy
        || loadBalanceChanged;

      await updateTunnel(tunnelId, {
        exitHostId: primary.hostId,
        listenPort: primary.listenPort,
        mimicPort: primary.mimicPort,
        connectHost: primary.connectHost,
        networkType,
        loadBalanceEnabled: nextNodes.length > 0,
        loadBalanceStrategy: strategy,
        ...(changed ? { isRunning: false } : {}),
      } as any);

      if (endpointsChanged && (existingHops as any[]).length >= 2) {
        const nextHops = (existingHops as any[]).map((hop) => ({
          hostId: Number(hop.hostId),
          listenPort: Number(hop.listenPort),
          mimicPort: Number(hop.mimicPort || 0),
          connectHost: String(hop.connectHost || "").trim() || null,
        }));
        nextHops[nextHops.length - 1] = {
          hostId: primary.hostId,
          listenPort: primary.listenPort,
          mimicPort: primary.mimicPort,
          connectHost: primary.connectHost,
        };
        await createTunnelHops(tunnelId, nextHops);
      }

      if (endpointsChanged) await replaceTunnelExitNodes(tunnelId, nextNodes);
      let refreshedTunnel = { ...currentTunnel,
        exitHostId: primary.hostId,
        listenPort: primary.listenPort,
        mimicPort: primary.mimicPort,
        connectHost: primary.connectHost,
        networkType,
        loadBalanceEnabled: nextNodes.length > 0,
        loadBalanceStrategy: strategy,
        ...(changed ? { isRunning: false } : {}),
      };
      if (String(refreshedTunnel.mode || "").toLowerCase() === "forwardx"
        && (databaseBool(refreshedTunnel.udpOverTcp) || String(refreshedTunnel.forwardxVersion || "").toLowerCase() === "v2")) {
        const refreshedHops = await getTunnelHops(tunnelId);
        const refreshedNodes = await getTunnelExitNodes(tunnelId);
        const ensured = await ensureForwardXMimicPorts(refreshedTunnel, refreshedHops, refreshedNodes);
        refreshedTunnel = ensured.tunnel;
      }
      if (endpointsChanged && mappedRules.length > 0) {
        // Endpoint reservations protect allocation while the tunnel and its
        // exit-node rows are being written.  Release them before allocating
        // rule-level exit ports: rules in this tunnel are allowed to reuse
        // the endpoint listener (especially the primary nginx/GOST rule),
        // and keeping the reservation would make reserveTunnelExitPort see
        // its own listener as an external conflict and move the rule to a
        // different port.  The persisted tunnel rows now provide the normal
        // conflict check for concurrent callers.
        releaseHostPortReservations(heldReservations);
        heldReservations.length = 0;
        await mapWithConcurrency(mappedRules as any[], 8, async (rule) => {
          const ruleId = Number(rule.id || 0);
          const preferredPorts = ruleExitPortsByHostId.get(ruleId) || new Map<number, number>();
          // The primary managed rule shares the tunnel listener. When an exit
          // group changes its primary host, prefer the newly planned listener
          // instead of allocating a second arbitrary port.
          const sharedPrimaryPort = primaryManagedRuleId === ruleId ? Number(primary.listenPort || 0) : 0;
          let primaryRulePort = sharedPrimaryPort || Number(preferredPorts.get(primary.hostId) || 0);
          let primaryReservation: HostPortReservation | null = null;
          try {
            primaryReservation = await reserveTunnelExitPort({
              hostId: primary.hostId,
              preferredStart: primaryHost?.portRangeStart,
              preferredEnd: primaryHost?.portRangeEnd,
              currentPort: primaryRulePort,
              excludeRuleIds: [ruleId],
              allowSameTunnelListener: primaryManagedRuleId === ruleId,
              excludeTunnelId: tunnelId,
            });
            if (!primaryReservation) throw new Error(`Exit Agent ${primaryHost?.name || primary.hostId} has no available rule port`);
            primaryRulePort = primaryReservation.port;
            preferredPorts.set(primary.hostId, primaryRulePort);
            await database.update(forwardRules).set({
              tunnelExitPort: primaryRulePort,
              isRunning: false,
              updatedAt: nowDate(),
            } as any).where(eq(forwardRules.id, ruleId));
            await reconcileForwardRuleTunnelExits(
              { ...rule, tunnelExitPort: primaryRulePort, isRunning: false },
              refreshedTunnel,
              preferredPorts,
            );
          } finally {
            primaryReservation?.release();
          }
        });
      } else if (endpointsChanged || loadBalanceChanged) {
        await reconcileTunnelRuleExitMappings(tunnelId);
      }
      return { tunnel: refreshedTunnel, changed, previousHostIds, nextHostIds };
    } finally {
      releaseHostPortReservations(heldReservations);
    }
  });
}

export async function clearTunnelExitNodes(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, tunnelId));
}

export async function getTunnelExitEndpoints(tunnel: any) {
  const primary = {
    seq: 0,
    exitNodeId: 0,
    hostId: Number(tunnel?.exitHostId || 0),
    listenPort: Number(tunnel?.listenPort || 0),
    mimicPort: Number(tunnel?.mimicPort || 0),
    connectHost: String(tunnel?.connectHost || "").trim() || null,
    primary: true,
    isEnabled: true,
  };
  const extras = await getTunnelExitNodes(Number(tunnel?.id || 0));
  return [
    primary,
    ...extras.map((node: any) => ({
      seq: Number(node.seq),
      exitNodeId: Number(node.id),
      hostId: Number(node.hostId),
      listenPort: Number(node.listenPort),
      mimicPort: Number(node.mimicPort || 0),
      connectHost: String(node.connectHost || "").trim() || null,
      primary: false,
      isEnabled: databaseBool(node.isEnabled, true),
    })),
  ].filter((endpoint) => endpoint.hostId > 0 && endpoint.listenPort > 0 && endpoint.isEnabled);
}

export async function getForwardRuleTunnelExits(ruleId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, ruleId)).orderBy(asc(forwardRuleTunnelExits.exitSeq));
}

export async function getForwardRuleTunnelExitsByRuleIds(ruleIds: number[]) {
  const ids = Array.from(new Set(ruleIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  const db = await getDb();
  if (!db || ids.length === 0) return [];
  return db.select().from(forwardRuleTunnelExits).where(sql`${forwardRuleTunnelExits.ruleId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).orderBy(asc(forwardRuleTunnelExits.ruleId), asc(forwardRuleTunnelExits.exitSeq));
}

export async function clearForwardRuleTunnelExits(ruleId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, ruleId));
}

export async function clearForwardRuleTunnelExitsByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.tunnelId, tunnelId));
}

export async function replaceForwardRuleTunnelExits(ruleId: number, rows: Array<Omit<InsertForwardRuleTunnelExit, "id" | "ruleId" | "createdAt" | "updatedAt">>) {
  const db = await getDb();
  if (!db) return;
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, ruleId));
  for (const row of rows) {
    await upsertForwardRuleTunnelExit({
      ruleId,
      tunnelId: Number(row.tunnelId),
      exitNodeId: Number(row.exitNodeId),
      exitSeq: Number(row.exitSeq),
      exitHostId: Number(row.exitHostId),
      tunnelExitPort: Number(row.tunnelExitPort),
    });
  }
}

async function upsertForwardRuleTunnelExit(row: Omit<InsertForwardRuleTunnelExit, "id" | "createdAt" | "updatedAt">) {
  const now = Math.floor(Date.now() / 1000);
  const values = [
    Number(row.ruleId),
    Number(row.tunnelId),
    Number(row.exitNodeId),
    Number(row.exitSeq),
    Number(row.exitHostId),
    Number(row.tunnelExitPort),
    now,
    now,
  ];
  const q = quoteIdentifier;
  const table = q("forward_rule_tunnel_exits");
  const columns = [q("ruleId"), q("tunnelId"), q("exitNodeId"), q("exitSeq"), q("exitHostId"), q("tunnelExitPort"), q("createdAt"), q("updatedAt")].join(", ");
  if (getDatabaseKind() === "sqlite") {
    await executeRaw(
      `INSERT INTO ${table} (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(${q("ruleId")}, ${q("exitNodeId")}) DO UPDATE SET
         ${q("tunnelId")} = excluded.${q("tunnelId")},
         ${q("exitSeq")} = excluded.${q("exitSeq")},
         ${q("exitHostId")} = excluded.${q("exitHostId")},
         ${q("tunnelExitPort")} = excluded.${q("tunnelExitPort")},
         ${q("updatedAt")} = excluded.${q("updatedAt")}`,
      values,
    );
    return;
  }
  if (getDatabaseKind() === "postgresql") {
    await executeRaw(
      `INSERT INTO ${table} (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (${q("ruleId")}, ${q("exitNodeId")}) DO UPDATE SET
         ${q("tunnelId")} = excluded.${q("tunnelId")},
         ${q("exitSeq")} = excluded.${q("exitSeq")},
         ${q("exitHostId")} = excluded.${q("exitHostId")},
         ${q("tunnelExitPort")} = excluded.${q("tunnelExitPort")},
         ${q("updatedAt")} = excluded.${q("updatedAt")}`,
      values,
    );
    return;
  }
  await executeRaw(
    `INSERT INTO ${table} (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       ${q("tunnelId")} = VALUES(${q("tunnelId")}),
       ${q("exitSeq")} = VALUES(${q("exitSeq")}),
       ${q("exitHostId")} = VALUES(${q("exitHostId")}),
       ${q("tunnelExitPort")} = VALUES(${q("tunnelExitPort")}),
       ${q("updatedAt")} = VALUES(${q("updatedAt")})`,
    values,
  );
}

export async function reconcileForwardRuleTunnelExits(
  rule: any,
  tunnel: any,
  preferredPortsByHostId: ReadonlyMap<number, number> = new Map(),
) {
  const ruleId = Number(rule?.id || 0);
  const tunnelId = Number(tunnel?.id || rule?.tunnelId || 0);
  if (!ruleId || !tunnelId) return [];
  return withKeyedTaskLock(`rule-tunnel-exits:${ruleId}`, async () => {
  /*
   * The lowest-id active GOST rule is the primary route for every managed
   * GOST/Nginx tunnel (the same convention used by the Agent), so its
   * bookkeeping port must always follow the tunnel endpoint's listenPort.
   * Reconcile it here as well as secondary mappings so every call site shares
   * the same invariant.
   *
   * Values read from SQLite/MySQL are not guaranteed to have the same boolean
   * representation. Do not use a double-negation for active-rule selection:
   * strings such as "0" are truthy in JavaScript and would steal the primary
   * slot from a disabled rule.
   */
  if (usesSharedTunnelPrimaryListener(tunnel)) {
    const tunnelRules = await getForwardRulesByTunnel(tunnelId);
    const candidates = (tunnelRules as any[])
      .filter((candidate) => (
        candidate
        && !databaseBool(candidate.pendingDelete)
        && !databaseBool(candidate.isForwardGroupTemplate)
        && databaseBool(candidate.isEnabled)
        && String(candidate.forwardType || "").trim().toLowerCase() === "gost"
      ));
    // Include a freshly-created rule if a replica/read pool has not exposed
    // it yet, as long as its supplied runtime fields identify an active GOST.
    if (!candidates.some((candidate) => Number(candidate.id) === ruleId)
      && !databaseBool(rule?.pendingDelete)
      && !databaseBool(rule?.isForwardGroupTemplate)
      && databaseBool(rule?.isEnabled, true)
      && String(rule?.forwardType || "gost").trim().toLowerCase() === "gost") {
      candidates.push(rule);
    }
    const primaryRule = candidates
      .filter((candidate) => Number(candidate?.id || 0) > 0)
      .sort((left, right) => Number(left.id) - Number(right.id))[0];
    if (primaryRule && Number(primaryRule.id) === ruleId) {
      const endpointListenPort = Number((tunnel as any)?.listenPort || 0);
      if (endpointListenPort > 0 && Number(rule?.tunnelExitPort || 0) !== endpointListenPort) {
        const db = await getDb();
        if (db) {
          await db.update(forwardRules).set({
            tunnelExitPort: endpointListenPort,
            // Force the normal runtime refresh after repairing stale data.
            isRunning: false,
            updatedAt: nowDate(),
          } as any).where(eq(forwardRules.id, ruleId));
        }
        // Callers consume this object later in the same heartbeat.
        rule.tunnelExitPort = endpointListenPort;
        rule.isRunning = false;
      }
    }
  }
  if (String((tunnel as any)?.mode || "").toLowerCase() === "forwardx") {
    await clearForwardRuleTunnelExits(ruleId);
    return [];
  }
  const endpoints = (await getTunnelExitEndpoints(tunnel)).filter((endpoint) => !endpoint.primary);
  if (!databaseBool((tunnel as any).loadBalanceEnabled) || endpoints.length === 0) {
    await clearForwardRuleTunnelExits(ruleId);
    return [];
  }
  const existing = await getForwardRuleTunnelExits(ruleId);
  const existingByNodeId = new Map<number, any>();
  const existingByHostId = new Map<number, any>();
  const existingBySeq = new Map<number, any>();
  // Port numbers only conflict on the same Agent. Keeping one global list
  // would incorrectly make e.g. port 22600 on exit A block port 22600 on
  // independent exit B, and can report "no available port" when each host
  // has a single identical NAT slot.
  const reservedPortsByHostId = new Map<number, number[]>();
  const reservedPortsForHost = (hostId: number) => {
    const id = Number(hostId || 0);
    const ports = reservedPortsByHostId.get(id) || [];
    reservedPortsByHostId.set(id, ports);
    return ports;
  };
  const heldReservations: HostPortReservation[] = [];
  for (const row of existing as any[]) {
    existingByNodeId.set(Number(row.exitNodeId), row);
    existingByHostId.set(Number(row.exitHostId), row);
    existingBySeq.set(Number(row.exitSeq), row);
  }
  const nextRows: Array<Omit<InsertForwardRuleTunnelExit, "id" | "ruleId" | "createdAt" | "updatedAt">> = [];
  try {
  for (const endpoint of endpoints) {
    const nodeMatch = existingByNodeId.get(Number(endpoint.exitNodeId));
    const hostMatch = existingByHostId.get(Number(endpoint.hostId));
    const sequenceMatch = existingBySeq.get(Number(endpoint.seq));
    const existingRow = nodeMatch
      || hostMatch
      || (Number(sequenceMatch?.exitHostId) === Number(endpoint.hostId) ? sequenceMatch : undefined);
    const exitHost = await getHostById(Number(endpoint.hostId)) as any;
    const tunnelExitPortReservation = await reserveTunnelExitPort({
      hostId: Number(endpoint.hostId),
      preferredStart: exitHost?.portRangeStart,
      preferredEnd: exitHost?.portRangeEnd,
      currentPort: Number(existingRow?.tunnelExitPort || preferredPortsByHostId.get(Number(endpoint.hostId)) || 0),
      reservedPorts: reservedPortsForHost(Number(endpoint.hostId)),
      excludeRuleIds: [ruleId],
      excludeTunnelId: tunnelId,
    });
    if (!tunnelExitPortReservation) throw new Error("出口 Agent 已无可用隧道端口");
    heldReservations.push(tunnelExitPortReservation);
    const tunnelExitPort = tunnelExitPortReservation.port;
    const hostReservedPorts = reservedPortsForHost(Number(endpoint.hostId));
    if (!hostReservedPorts.includes(tunnelExitPort)) hostReservedPorts.push(tunnelExitPort);
    nextRows.push({
      tunnelId,
      exitNodeId: Number(endpoint.exitNodeId),
      exitSeq: Number(endpoint.seq),
      exitHostId: Number(endpoint.hostId),
      tunnelExitPort,
    } as any);
  }
  await replaceForwardRuleTunnelExits(ruleId, nextRows);
  return nextRows;
  } finally {
    releaseHostPortReservations(heldReservations);
  }
  });
}

export async function reconcileTunnelRuleExitMappings(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  const tunnel = await getTunnelById(tunnelId);
  if (!tunnel) return;
  const rules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.tunnelId, tunnelId),
    eq(forwardRules.pendingDelete, false),
  ));
  await mapWithConcurrency(rules as any[], 12, (rule) => reconcileForwardRuleTunnelExits(rule, tunnel));
}

export async function createTunnelHops(tunnelId: number, hops: { hostId: number; listenPort: number; mimicPort?: number; connectHost?: string | null }[]) {
  return withDatabaseTransaction(async () => {
  const db = await getDb();
  if (!db || hops.length === 0) return;
  // Delete existing hops first
  await db.delete(tunnelHops).where(eq(tunnelHops.tunnelId, tunnelId));
  // Insert new hops
  for (let i = 0; i < hops.length; i++) {
    await db.insert(tunnelHops).values({
      tunnelId,
      seq: i,
      hostId: hops[i].hostId,
      listenPort: hops[i].listenPort,
      mimicPort: Number(hops[i].mimicPort || 0),
      connectHost: hops[i].connectHost ?? null,
    });
  }
  });
}

export async function deleteTunnelHops(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(tunnelHops).where(eq(tunnelHops.tunnelId, tunnelId));
}

export async function getTunnelsByHopHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ tunnelId: tunnelHops.tunnelId }).from(tunnelHops).where(eq(tunnelHops.hostId, hostId));
  const ids = Array.from(new Set(rows.map((r: any) => r.tunnelId)));
  if (ids.length === 0) return [];
  return db.select().from(tunnels).where(sql`${tunnels.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
}


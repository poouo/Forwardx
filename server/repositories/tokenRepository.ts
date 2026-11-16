import { asc, desc, eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import { agentTokens, hosts, users, InsertAgentToken } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw, rawAffectedRows, withDatabaseTransaction } from "../dbRuntime";
import { inList, quoteIdentifier } from "../dbCompat";
import { HOST_ONLINE_TTL_MS } from "../hostHeartbeatPolicy";

// ==================== Agent Token Queries ====================

export const AGENT_AUTH_TOKEN_CACHE_TTL_MS = 60_000;
type AgentAuthHostIdentity = { id: number; name: string; agentInstallationId: string };
type AgentAuthTokenSnapshot = {
  tokens: string[];
  tokenSet: Set<string>;
  hostIdentityByToken: Map<string, AgentAuthHostIdentity>;
};

let agentAuthTokenCache: (AgentAuthTokenSnapshot & { expiresAt: number; loadedAt: number }) | null = null;
let agentAuthTokenLoad: Promise<AgentAuthTokenSnapshot> | null = null;
let agentAuthTokenGeneration = 0;

function isFreshHeartbeat(lastHeartbeat: unknown) {
  if (!lastHeartbeat) return false;
  const time = new Date(lastHeartbeat as any).getTime();
  return Number.isFinite(time) && Date.now() - time <= HOST_ONLINE_TTL_MS;
}

function withComputedOnline<T extends { isOnline?: boolean; lastHeartbeat?: unknown }>(host: T): T {
  return { ...host, isOnline: !!host.isOnline && isFreshHeartbeat(host.lastHeartbeat) };
}

export async function createAgentToken(data: InsertAgentToken) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = await insertAndGetId("agent_tokens", data as any);
  invalidateAgentAuthTokenCandidates();
  return id;
}

export async function getAgentTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(agentTokens).where(eq(agentTokens.token, token)).limit(1);
  return r[0];
}

export function invalidateAgentAuthTokenCandidates() {
  agentAuthTokenGeneration += 1;
  agentAuthTokenCache = null;
  agentAuthTokenLoad = null;
}

async function loadAgentAuthTokenCandidates() {
  const db = await getDb();
  if (!db) return { tokens: [], tokenSet: new Set<string>(), hostIdentityByToken: new Map<string, AgentAuthHostIdentity>() };
  // Ordinary accounts could formerly mint tokens. Reject those historical
  // credentials as well as new requests, without deleting incident evidence.
  const trustedIssuer = and(eq(users.role, "admin"), eq(users.accountEnabled, true));
  const tokenRows = await db.select({ token: agentTokens.token }).from(agentTokens)
    .innerJoin(users, eq(agentTokens.userId, users.id)).where(trustedIssuer);
  const hostRows = await db.select({ id: hosts.id, name: hosts.name, token: hosts.agentToken, agentInstallationId: hosts.agentInstallationId }).from(hosts)
    .innerJoin(users, eq(hosts.userId, users.id)).where(trustedIssuer);
  const tokens = Array.from(new Set([
    ...tokenRows.map((row: any) => row.token),
    ...hostRows.map((row: any) => row.token),
  ].map((token) => String(token || "").trim()).filter(Boolean)));
  const hostIdentityByToken = new Map<string, AgentAuthHostIdentity>();
  for (const row of hostRows as any[]) {
    const token = String(row?.token || "").trim();
    const id = Number(row?.id || 0);
    if (!token || !Number.isInteger(id) || id <= 0) continue;
    hostIdentityByToken.set(token, { id, name: String(row?.name || ""), agentInstallationId: String(row?.agentInstallationId || "") });
  }
  return { tokens, tokenSet: new Set(tokens), hostIdentityByToken };
}

async function getAgentAuthTokenSnapshot(options: { force?: boolean } = {}) {
  const now = Date.now();
  // Invalid proofs must not force two full credential queries per request.
  // Real local changes explicitly invalidate the snapshot and bypass this floor.
  if (agentAuthTokenCache && agentAuthTokenCache.expiresAt > now && (!options.force || now - agentAuthTokenCache.loadedAt < 1000)) {
    return agentAuthTokenCache;
  }
  if (agentAuthTokenLoad) return agentAuthTokenLoad;
  const loadGeneration = agentAuthTokenGeneration;
  const load = loadAgentAuthTokenCandidates().then((snapshot) => {
    if (loadGeneration === agentAuthTokenGeneration) {
      agentAuthTokenCache = { loadedAt: Date.now(), expiresAt: Date.now() + AGENT_AUTH_TOKEN_CACHE_TTL_MS, ...snapshot };
    }
    return snapshot;
  });
  agentAuthTokenLoad = load;
  try {
    return await load;
  } finally {
    if (agentAuthTokenLoad === load) agentAuthTokenLoad = null;
  }
}

export async function getAgentAuthTokenCandidates(options: { force?: boolean } = {}) {
  return (await getAgentAuthTokenSnapshot(options)).tokens;
}

export async function isKnownAgentAuthToken(token: string, options: { force?: boolean } = {}) {
  return (await getAgentAuthTokenSnapshot(options)).tokenSet.has(token);
}

export async function getAgentAuthHostIdentity(tokenValue: unknown, options: { force?: boolean; installationId?: string } = {}) {
  const token = String(tokenValue || "").trim();
  if (!token) return undefined;
  if (options.installationId) {
    const db = await getDb();
    if (!db) return undefined;
    const row = await db.select({ id: hosts.id, name: hosts.name, agentInstallationId: hosts.agentInstallationId })
      .from(hosts)
      .where(and(eq(hosts.agentToken, token), eq(hosts.agentInstallationId, options.installationId)))
      .orderBy(desc(hosts.id))
      .limit(1);
    let host = row[0];
    // Ordinary single-host tokens retain the legacy stale-installation
    // fencing path: resolve the active host so the middleware can return the
    // superseded response. Batch tokens must stay exact to their installation.
    if (!host) {
      const tokenRow = await db.select({ registrationMode: agentTokens.registrationMode })
        .from(agentTokens).where(eq(agentTokens.token, token)).limit(1);
      if (tokenRow[0]?.registrationMode !== "batch") {
        const fallback = await db.select({ id: hosts.id, name: hosts.name, agentInstallationId: hosts.agentInstallationId })
          .from(hosts).where(eq(hosts.agentToken, token)).orderBy(desc(hosts.id)).limit(1);
        host = fallback[0];
      }
    }
    return host?.id ? { id: Number(host.id), name: String(host.name || ""), agentInstallationId: String(host.agentInstallationId || "") } : undefined;
  }
  return (await getAgentAuthTokenSnapshot(options)).hostIdentityByToken.get(token);
}

export async function getAgentTokenById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(agentTokens).where(eq(agentTokens.id, id)).limit(1);
  return r[0];
}

export async function getAgentTokens(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const query = db
    .select({
      token: agentTokens,
      host: {
        id: hosts.id,
        name: hosts.name,
        ip: hosts.ip,
        ipv4: hosts.ipv4,
        ipv6: hosts.ipv6,
        entryIp: hosts.entryIp,
        isOnline: hosts.isOnline,
        lastHeartbeat: hosts.lastHeartbeat,
      },
    })
    .from(agentTokens)
    .leftJoin(hosts, eq(agentTokens.hostId, hosts.id));
  const rows = userId
    ? await query.where(eq(agentTokens.userId, userId)).orderBy(asc(agentTokens.sortOrder), desc(agentTokens.createdAt), desc(agentTokens.id))
    : await query.orderBy(asc(agentTokens.sortOrder), desc(agentTokens.createdAt), desc(agentTokens.id));
  // The left join above preserves the existing response shape. Batch tokens
  // need all hosts, which are loaded with one raw query below because hosts are
  // associated by token value rather than a foreign key.
  const batchHostsByToken = new Map<string, any[]>();
  const tokenValues = rows.map((row: any) => String(row.token.token || "").trim()).filter(Boolean);
  if (tokenValues.length) {
    const placeholders = tokenValues.map(() => "?").join(",");
    const q = quoteIdentifier;
    const allHosts = await queryRaw<any>(
      `SELECT ${q("id")}, ${q("name")}, ${q("ip")}, ${q("ipv4")}, ${q("ipv6")}, ${q("entryIp")}, ${q("isOnline")}, ${q("lastHeartbeat")}, ${q("agentToken")} FROM ${q("hosts")} WHERE ${q("agentToken")} IN (${placeholders}) ORDER BY ${q("id")} ASC`,
      tokenValues,
    );
    for (const host of allHosts) {
      const key = String(host.agentToken || "");
      const list = batchHostsByToken.get(key) || [];
      list.push(withComputedOnline(host));
      batchHostsByToken.set(key, list);
    }
  }
  return rows.map((row: any) => {
    const tokenValue = String(row.token.token || "");
    const hostsForToken = batchHostsByToken.get(tokenValue) || (row.host?.id ? [withComputedOnline(row.host)] : []);
    return {
      ...row.token,
      host: hostsForToken[0] || null,
      hosts: hostsForToken,
    };
  });
}

export async function reorderAgentTokens(ids: number[], userId?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const orderedIds = Array.from(ids || [])
    .map((id) => Math.floor(Number(id)))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) throw new Error("排序数据无效");
  const q = quoteIdentifier;
  const list = inList(orderedIds);
  const params: any[] = [...list.params];
  let userWhere = "";
  if (userId) {
    userWhere = ` AND ${q("userId")} = ?`;
    params.push(userId);
  }
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")} FROM ${q("agent_tokens")} WHERE ${q("id")} IN ${list.sql}${userWhere}`,
    params,
  );
  if (rows.length !== orderedIds.length) throw new Error("排序中包含无权操作或不存在的 Token");
  for (const [index, id] of orderedIds.entries()) {
    await executeRaw(`UPDATE ${q("agent_tokens")} SET ${q("sortOrder")} = ? WHERE ${q("id")} = ?`, [index, id]);
  }
}

export async function markAgentTokenUsed(token: string, hostId: number) {
  const db = await getDb();
  if (!db) return;
  const row = await getAgentTokenByToken(token);
  const keepFirstHost = row?.registrationMode === "batch" && row.hostId;
  await db.update(agentTokens).set({ isUsed: true, ...(keepFirstHost ? {} : { hostId }) }).where(eq(agentTokens.token, token));
}

export async function claimBatchAgentRegistration(token: string, now = Math.floor(Date.now() / 1000)) {
  const tokenRow = await getAgentTokenByToken(token);
  if (!tokenRow || tokenRow.registrationMode !== "batch") return false;
  if (tokenRow.registrationExpiresAt) {
    const expiresAt = tokenRow.registrationExpiresAt instanceof Date
      ? Math.floor(tokenRow.registrationExpiresAt.getTime() / 1000)
      : Number(tokenRow.registrationExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return false;
  }
  const limit = Math.max(0, Number(tokenRow.maxRegistrations) || 0);
  return withDatabaseTransaction(async () => {
    const q = quoteIdentifier;
    const whereLimit = limit > 0 ? ` AND ${q("usedRegistrations")} < ?` : "";
    const result = await executeRaw(
      `UPDATE ${q("agent_tokens")} SET ${q("usedRegistrations")} = ${q("usedRegistrations")} + 1, ${q("isUsed")} = ? WHERE ${q("token")} = ? AND ${q("registrationMode")} = ? AND (${q("registrationExpiresAt")} IS NULL OR ${q("registrationExpiresAt")} > ?)${whereLimit}`,
      [true, token, "batch", now, ...(limit > 0 ? [limit] : [])],
    );
    return rawAffectedRows(result) > 0;
  });
}

export async function updateAgentTokenDescription(id: number, description: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(agentTokens).set({ description }).where(eq(agentTokens.id, id));
}

export async function updateBatchAgentToken(
  id: number,
  data: { description: string | null; maxRegistrations: number; registrationExpiresAt: Date | null },
) {
  const db = await getDb();
  if (!db) return;
  await db.update(agentTokens).set(data).where(and(eq(agentTokens.id, id), eq(agentTokens.registrationMode, "batch")));
}

export async function detachHostFromAgentToken(token: string, hostId: number) {
  const db = await getDb();
  if (!db) return;
  const host = await db.select({ id: hosts.id }).from(hosts)
    .where(and(eq(hosts.id, hostId), eq(hosts.agentToken, token))).limit(1);
  if (!host.length) return;
  await db.update(hosts).set({ agentToken: null, isOnline: false, updatedAt: nowDate() })
    .where(and(eq(hosts.id, hostId), eq(hosts.agentToken, token)));
  await executeRaw(
    `UPDATE ${quoteIdentifier("agent_tokens")} SET ${quoteIdentifier("usedRegistrations")} = CASE WHEN ${quoteIdentifier("usedRegistrations")} > 0 THEN ${quoteIdentifier("usedRegistrations")} - 1 ELSE 0 END WHERE ${quoteIdentifier("token")} = ? AND ${quoteIdentifier("registrationMode")} = ?`,
    [token, "batch"],
  );
  invalidateAgentAuthTokenCandidates();
}

export async function deleteAgentToken(id: number) {
  const db = await getDb();
  if (!db) return;
  const token = await getAgentTokenById(id);
  if (token?.token) {
    await db.update(hosts).set({
      agentToken: null,
      isOnline: false,
      updatedAt: nowDate(),
    }).where(eq(hosts.agentToken, token.token));
  }
  await db.delete(agentTokens).where(eq(agentTokens.id, id));
  invalidateAgentAuthTokenCandidates();
}


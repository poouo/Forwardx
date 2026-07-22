import { asc, desc, eq } from "drizzle-orm";
import { agentTokens, hosts, InsertAgentToken } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { inList, quoteIdentifier } from "../dbCompat";

// ==================== Agent Token Queries ====================

const HOST_ONLINE_TTL_MS = 150 * 1000;
const AGENT_AUTH_TOKEN_CACHE_TTL_MS = 5_000;
let agentAuthTokenCache: { expiresAt: number; tokens: string[] } | null = null;
let agentAuthTokenLoad: Promise<string[]> | null = null;

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
  agentAuthTokenCache = null;
}

async function loadAgentAuthTokenCandidates() {
  const db = await getDb();
  if (!db) return [];
  const tokenRows = await db.select({ token: agentTokens.token }).from(agentTokens);
  const hostRows = await db.select({ token: hosts.agentToken }).from(hosts);
  return Array.from(new Set([
    ...tokenRows.map((row: any) => row.token),
    ...hostRows.map((row: any) => row.token),
  ].map((token) => String(token || "").trim()).filter(Boolean)));
}

export async function getAgentAuthTokenCandidates(options: { force?: boolean } = {}) {
  const now = Date.now();
  if (!options.force && agentAuthTokenCache && agentAuthTokenCache.expiresAt > now) {
    return agentAuthTokenCache.tokens;
  }
  if (agentAuthTokenLoad) return agentAuthTokenLoad;
  const load = loadAgentAuthTokenCandidates().then((tokens) => {
    agentAuthTokenCache = { expiresAt: Date.now() + AGENT_AUTH_TOKEN_CACHE_TTL_MS, tokens };
    return tokens;
  });
  agentAuthTokenLoad = load;
  try {
    return await load;
  } finally {
    if (agentAuthTokenLoad === load) agentAuthTokenLoad = null;
  }
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
  return rows.map((row: any) => ({
    ...row.token,
    host: row.host?.id ? withComputedOnline(row.host) : null,
  }));
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
  await db.update(agentTokens).set({ isUsed: true, hostId }).where(eq(agentTokens.token, token));
}

export async function updateAgentTokenDescription(id: number, description: string | null) {
  const db = await getDb();
  if (!db) return;
  await db.update(agentTokens).set({ description }).where(eq(agentTokens.id, id));
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


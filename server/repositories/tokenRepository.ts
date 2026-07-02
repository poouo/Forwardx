import { desc, eq } from "drizzle-orm";
import { agentTokens, hosts, InsertAgentToken } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";

// ==================== Agent Token Queries ====================

const HOST_ONLINE_TTL_MS = 150 * 1000;

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
  return insertAndGetId("agent_tokens", data as any);
}

export async function getAgentTokenByToken(token: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(agentTokens).where(eq(agentTokens.token, token)).limit(1);
  return r[0];
}

export async function getAgentAuthTokenCandidates() {
  const db = await getDb();
  if (!db) return [];
  const tokenRows = await db.select({ token: agentTokens.token }).from(agentTokens);
  const hostRows = await db.select({ token: hosts.agentToken }).from(hosts);
  return Array.from(new Set([
    ...tokenRows.map((row: any) => row.token),
    ...hostRows.map((row: any) => row.token),
  ].map((token) => String(token || "").trim()).filter(Boolean)));
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
    ? await query.where(eq(agentTokens.userId, userId)).orderBy(desc(agentTokens.createdAt))
    : await query.orderBy(desc(agentTokens.createdAt));
  return rows.map((row: any) => ({
    ...row.token,
    host: row.host?.id ? withComputedOnline(row.host) : null,
  }));
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
}


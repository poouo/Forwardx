import crypto from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { tunnels, InsertTunnel, forwardRules, userTunnelPermissions, tunnelHops, InsertTunnelHop } from "../../drizzle/schema";
import { executeRaw, quoteDbIdentifier, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { combinePortPolicies, pickAvailablePort, portPolicyFrom } from "../portPolicy";
import { getHostById } from "./hostRepository";

// ==================== Tunnel Queries ====================

export async function getTunnels(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  if (userId) return db.select().from(tunnels).where(eq(tunnels.userId, userId)).orderBy(desc(tunnels.createdAt));
  return db.select().from(tunnels).orderBy(desc(tunnels.createdAt));
}

export async function getTunnelsByHost(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const direct = await db.select({ id: tunnels.id }).from(tunnels).where(
    sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`
  );
  const hopRows = await db.select({ tunnelId: tunnelHops.tunnelId }).from(tunnelHops).where(eq(tunnelHops.hostId, hostId));
  const ids = Array.from(new Set([
    ...direct.map((row: any) => Number(row.id)),
    ...hopRows.map((row: any) => Number(row.tunnelId)),
  ].filter((id) => Number.isFinite(id) && id > 0)));
  if (ids.length === 0) return [];
  return db.select().from(tunnels).where(sql`${tunnels.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`).orderBy(desc(tunnels.createdAt));
}

export async function getTunnelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(tunnels).where(eq(tunnels.id, id)).limit(1);
  return r[0];
}

export async function createTunnel(data: InsertTunnel) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return insertAndGetId("tunnels", data as any);
}

export async function updateTunnel(id: number, data: Partial<InsertTunnel>) {
  const db = await getDb();
  if (!db) return;
  await db.update(tunnels).set({ ...data, updatedAt: nowDate() }).where(eq(tunnels.id, id));
}

export async function deleteTunnel(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ tunnelId: null, isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.tunnelId, id));
  await db.delete(userTunnelPermissions).where(eq(userTunnelPermissions.tunnelId, id));
  await db.delete(tunnels).where(eq(tunnels.id, id));
}

export async function resetForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({ isRunning: false, updatedAt: nowDate() }).where(eq(forwardRules.tunnelId, tunnelId));
}

export async function resetAgentRuntimeStateForHost(hostId: number) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return;
  const db = await getDb();
  if (!db) return;
  const now = Math.floor(Date.now() / 1000);

  await executeRaw(
    `UPDATE ${quoteDbIdentifier("tunnels")}
     SET ${quoteDbIdentifier("isRunning")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("isRunning")} = ?
       AND (
         ${quoteDbIdentifier("entryHostId")} = ?
         OR ${quoteDbIdentifier("exitHostId")} = ?
         OR ${quoteDbIdentifier("id")} IN (
           SELECT ${quoteDbIdentifier("tunnelId")}
           FROM ${quoteDbIdentifier("tunnel_hops")}
           WHERE ${quoteDbIdentifier("hostId")} = ?
         )
       )`,
    [false, now, true, id, id, id],
  );

  await executeRaw(
    `UPDATE ${quoteDbIdentifier("forward_rules")}
     SET ${quoteDbIdentifier("isRunning")} = ?, ${quoteDbIdentifier("updatedAt")} = ?
     WHERE ${quoteDbIdentifier("isRunning")} = ?
       AND (
         ${quoteDbIdentifier("hostId")} = ?
         OR ${quoteDbIdentifier("tunnelId")} IN (
           SELECT ${quoteDbIdentifier("id")}
           FROM ${quoteDbIdentifier("tunnels")}
            WHERE ${quoteDbIdentifier("entryHostId")} = ?
              OR ${quoteDbIdentifier("exitHostId")} = ?
              OR ${quoteDbIdentifier("id")} IN (
                SELECT ${quoteDbIdentifier("tunnelId")}
                FROM ${quoteDbIdentifier("tunnel_hops")}
                WHERE ${quoteDbIdentifier("hostId")} = ?
              )
          )
        )`,
    [false, now, true, id, id, id, id],
  );
}

export async function disableForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled: false,
    disabledByTunnel: true,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.tunnelId, tunnelId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
}

export async function restoreForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled: true,
    disabledByTunnel: false,
    isRunning: false,
    updatedAt: nowDate(),
  }).where(and(
    eq(forwardRules.tunnelId, tunnelId),
    eq(forwardRules.disabledByTunnel, true),
    eq(forwardRules.pendingDelete, false),
  ));
}

export async function findAvailableTunnelExitPort(
  exitHostId: number,
  preferredStart?: number | null,
  preferredEnd?: number | null,
): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const host = await getHostById(exitHostId) as any;
  const policy = portPolicyFrom({
    portRangeStart: preferredStart ?? host?.portRangeStart,
    portRangeEnd: preferredEnd ?? host?.portRangeEnd,
    portAllowlist: host?.portAllowlist,
  });
  const usedRulePorts = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(
    eq(forwardRules.hostId, exitHostId),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const usedTunnelPorts = await db.select({ port: tunnels.listenPort }).from(tunnels).where(eq(tunnels.exitHostId, exitHostId));
  const usedExitPorts = await db.select({ port: forwardRules.tunnelExitPort }).from(forwardRules).where(and(
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const used = new Set<number>();
  usedRulePorts.forEach((r: any) => used.add(Number(r.port)));
  usedTunnelPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExitPorts.forEach((r: any) => {
    if (r.port != null) used.add(Number(r.port));
  });
  return pickAvailablePort(policy, used, { start: 20000, end: 65535 });
}

export async function isTunnelListenPortUsed(exitHostId: number, listenPort: number, excludeTunnelId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: tunnels.id }).from(tunnels).where(and(eq(tunnels.exitHostId, exitHostId), eq(tunnels.listenPort, listenPort)));
  return rows.some((row) => row.id !== excludeTunnelId);
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
  await db.update(tunnels).set({
    lastTestStatus: data.status,
    lastLatencyMs: data.latencyMs ?? null,
    lastTestMessage: data.message ?? null,
    lastTestAt: nowDate(),
    updatedAt: nowDate(),
  }).where(eq(tunnels.id, id));
}

/** 检查某主机上的某端口是否已被占用 */
export async function isPortUsedOnHost(hostId: number, sourcePort: number, excludeRuleId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const conds: any[] = [
    eq(forwardRules.hostId, hostId),
    eq(forwardRules.sourcePort, sourcePort),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ];
  if (excludeRuleId) conds.push(sql`${forwardRules.id} != ${excludeRuleId}`);
  const r = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(and(...conds));
  return (Number(r[0]?.count) || 0) > 0;
}

/** 在主机端口区间内找一个未被占用的随机端口 */
export async function findAvailablePort(hostId: number, rangeStart?: number | null, rangeEnd?: number | null): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const host = await getHostById(hostId) as any;
  const hostPolicy = portPolicyFrom(host);
  const explicitPolicy = rangeStart != null && rangeEnd != null
    ? portPolicyFrom({ portRangeStart: rangeStart, portRangeEnd: rangeEnd })
    : null;
  const policy = explicitPolicy ? combinePortPolicies(hostPolicy, explicitPolicy) : hostPolicy;
  // 获取该主机已占用的端口
  const usedRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(
    eq(forwardRules.hostId, hostId),
    eq(forwardRules.isForwardGroupTemplate, false),
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const usedPorts = new Set<number>(usedRows.map((r: any) => Number(r.port)).filter((port: number) => Number.isInteger(port)));
  return pickAvailablePort(policy, usedPorts, { start: 10000, end: 65535 });
}

// ==================== Tunnel Hops (Multi-hop) ====================

export async function getTunnelHops(tunnelId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tunnelHops).where(eq(tunnelHops.tunnelId, tunnelId)).orderBy(asc(tunnelHops.seq));
}

export async function createTunnelHops(tunnelId: number, hops: { hostId: number; listenPort: number; connectHost?: string | null }[]) {
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
      connectHost: hops[i].connectHost ?? null,
    });
  }
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


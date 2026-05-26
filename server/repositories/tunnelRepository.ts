import crypto from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { tunnels, InsertTunnel, forwardRules, userTunnelPermissions } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";

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
  return db.select().from(tunnels).where(
    sql`${tunnels.entryHostId} = ${hostId} OR ${tunnels.exitHostId} = ${hostId}`
  ).orderBy(desc(tunnels.createdAt));
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

export async function disableForwardRulesByTunnel(tunnelId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardRules).set({
    isEnabled: false,
    disabledByTunnel: true,
    isRunning: false,
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
  const start = preferredStart ?? 20000;
  const end = preferredEnd ?? 65535;
  if (start > end) return null;
  const usedRulePorts = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(eq(forwardRules.hostId, exitHostId));
  const usedTunnelPorts = await db.select({ port: tunnels.listenPort }).from(tunnels).where(eq(tunnels.exitHostId, exitHostId));
  const usedExitPorts = await db.select({ port: forwardRules.tunnelExitPort }).from(forwardRules);
  const used = new Set<number>();
  usedRulePorts.forEach((r) => used.add(Number(r.port)));
  usedTunnelPorts.forEach((r) => used.add(Number(r.port)));
  usedExitPorts.forEach((r) => {
    if (r.port != null) used.add(Number(r.port));
  });
  const highStart = Math.max(start, end - 9999);
  const collectAvailable = (from: number, to: number) => {
    const ports: number[] = [];
    for (let port = from; port <= to; port++) {
      if (!used.has(port)) ports.push(port);
    }
    return ports;
  };
  let available = collectAvailable(highStart, end);
  if (available.length === 0 && highStart > start) {
    available = collectAvailable(start, highStart - 1);
  }
  if (available.length === 0) return null;
  const preferred = available.length > 1 ? available.filter((port) => port !== 65535) : available;
  return preferred[crypto.randomInt(0, preferred.length)];
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
  ];
  if (excludeRuleId) conds.push(sql`${forwardRules.id} != ${excludeRuleId}`);
  const r = await db.select({ count: sql<number>`COUNT(*)` }).from(forwardRules).where(and(...conds));
  return (Number(r[0]?.count) || 0) > 0;
}

/** 在主机端口区间内找一个未被占用的随机端口 */
export async function findAvailablePort(hostId: number, rangeStart?: number | null, rangeEnd?: number | null): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const start = rangeStart ?? 10000;
  const end = rangeEnd ?? 65535;
  // 获取该主机已占用的端口
  const usedRows = await db.select({ port: forwardRules.sourcePort }).from(forwardRules).where(and(
    eq(forwardRules.hostId, hostId),
    eq(forwardRules.isForwardGroupTemplate, false),
  ));
  const usedPorts = new Set(usedRows.map(r => r.port));
  // 闅忔満灏濊瘯
  const range = end - start + 1;
  if (range <= 0) return null;
  // 如果区间不大，直接遍历找空闲
  if (range <= 10000) {
    const available: number[] = [];
    for (let p = start; p <= end; p++) {
      if (!usedPorts.has(p)) available.push(p);
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }
  // 区间较大时随机尝试
  for (let i = 0; i < 100; i++) {
    const p = start + Math.floor(Math.random() * range);
    if (!usedPorts.has(p)) return p;
  }
  return null;
}


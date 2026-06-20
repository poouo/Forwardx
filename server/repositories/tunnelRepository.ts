import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  tunnels,
  InsertTunnel,
  forwardRules,
  userTunnelPermissions,
  tunnelHops,
  tunnelExitNodes,
  InsertTunnelExitNode,
  forwardRuleTunnelExits,
  InsertForwardRuleTunnelExit,
} from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { boolValue, quoteIdentifier, sqlCountAll } from "../dbCompat";
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
  const extraExitRows = await db.select({ tunnelId: tunnelExitNodes.tunnelId }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, hostId));
  const ids = Array.from(new Set([
    ...direct.map((row: any) => Number(row.id)),
    ...hopRows.map((row: any) => Number(row.tunnelId)),
    ...extraExitRows.map((row: any) => Number(row.tunnelId)),
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
  await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.tunnelId, id));
  await db.delete(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, id));
  await db.delete(tunnelHops).where(eq(tunnelHops.tunnelId, id));
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
        )`,
    [boolValue(false), now, boolValue(true), id, id, id, id],
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
           )
         )`,
    [boolValue(false), now, boolValue(true), id, id, id, id, id],
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
  const usedExtraTunnelPorts = await db.select({ port: tunnelExitNodes.listenPort }).from(tunnelExitNodes).where(eq(tunnelExitNodes.hostId, exitHostId));
  const usedExitPorts = await db.select({ port: forwardRules.tunnelExitPort }).from(forwardRules).where(and(
    eq(forwardRules.isEnabled, true),
    eq(forwardRules.pendingDelete, false),
  ));
  const usedMappedExitPorts = await db.select({ port: forwardRuleTunnelExits.tunnelExitPort }).from(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.exitHostId, exitHostId));
  const used = new Set<number>();
  usedRulePorts.forEach((r: any) => used.add(Number(r.port)));
  usedTunnelPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExtraTunnelPorts.forEach((r: any) => used.add(Number(r.port)));
  usedExitPorts.forEach((r: any) => {
    if (r.port != null) used.add(Number(r.port));
  });
  usedMappedExitPorts.forEach((r: any) => {
    if (r.port != null) used.add(Number(r.port));
  });
  return pickAvailablePort(policy, used, { start: 20000, end: 65535 });
}

export async function isTunnelListenPortUsed(exitHostId: number, listenPort: number, excludeTunnelId?: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select({ id: tunnels.id }).from(tunnels).where(and(eq(tunnels.exitHostId, exitHostId), eq(tunnels.listenPort, listenPort)));
  const extraRows = await db.select({ tunnelId: tunnelExitNodes.tunnelId }).from(tunnelExitNodes).where(and(eq(tunnelExitNodes.hostId, exitHostId), eq(tunnelExitNodes.listenPort, listenPort)));
  return rows.some((row: any) => row.id !== excludeTunnelId)
    || extraRows.some((row: any) => row.tunnelId !== excludeTunnelId);
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
  const r = await db.select({ count: sqlCountAll() }).from(forwardRules).where(and(...conds));
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
  const db = await getDb();
  if (!db) return;
  await db.delete(tunnelExitNodes).where(eq(tunnelExitNodes.tunnelId, tunnelId));
  for (const node of nodes) {
    await db.insert(tunnelExitNodes).values({
      tunnelId,
      seq: Number(node.seq),
      hostId: Number(node.hostId),
      listenPort: Number(node.listenPort),
      connectHost: node.connectHost ?? null,
      isEnabled: node.isEnabled !== false,
    } as any);
  }
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
      connectHost: String(node.connectHost || "").trim() || null,
      primary: false,
      isEnabled: node.isEnabled !== false,
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
    await db.insert(forwardRuleTunnelExits).values({
      ruleId,
      tunnelId: Number(row.tunnelId),
      exitNodeId: Number(row.exitNodeId),
      exitSeq: Number(row.exitSeq),
      exitHostId: Number(row.exitHostId),
      tunnelExitPort: Number(row.tunnelExitPort),
    } as any);
  }
}

export async function reconcileForwardRuleTunnelExits(rule: any, tunnel: any) {
  const ruleId = Number(rule?.id || 0);
  const tunnelId = Number(tunnel?.id || rule?.tunnelId || 0);
  if (!ruleId || !tunnelId) return [];
  if (String((tunnel as any)?.mode || "").toLowerCase() === "forwardx") {
    await clearForwardRuleTunnelExits(ruleId);
    return [];
  }
  const endpoints = (await getTunnelExitEndpoints(tunnel)).filter((endpoint) => !endpoint.primary);
  if (!(tunnel as any).loadBalanceEnabled || endpoints.length === 0) {
    await clearForwardRuleTunnelExits(ruleId);
    return [];
  }
  const existing = await getForwardRuleTunnelExits(ruleId);
  const existingByNodeId = new Map<number, any>();
  const existingBySeq = new Map<number, any>();
  for (const row of existing as any[]) {
    existingByNodeId.set(Number(row.exitNodeId), row);
    existingBySeq.set(Number(row.exitSeq), row);
  }
  const nextRows: Array<Omit<InsertForwardRuleTunnelExit, "id" | "ruleId" | "createdAt" | "updatedAt">> = [];
  for (const endpoint of endpoints) {
    const existingRow = existingByNodeId.get(Number(endpoint.exitNodeId)) || existingBySeq.get(Number(endpoint.seq));
    let tunnelExitPort = Number(existingRow?.tunnelExitPort || 0);
    if (!tunnelExitPort) {
      const exitHost = await getHostById(Number(endpoint.hostId));
      tunnelExitPort = await findAvailableTunnelExitPort(Number(endpoint.hostId), (exitHost as any)?.portRangeStart, (exitHost as any)?.portRangeEnd) ?? 0;
      if (!tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
    }
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
  for (const rule of rules as any[]) {
    await reconcileForwardRuleTunnelExits(rule, tunnel);
  }
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


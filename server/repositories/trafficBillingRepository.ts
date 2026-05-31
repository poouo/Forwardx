import { and, desc, eq, sql } from "drizzle-orm";
import {
  balanceTransactions,
  forwardRules,
  hosts,
  trafficBillingConfigs,
  trafficBillingRecords,
  trafficBillingUsage,
  tunnels,
  userTrafficBillingPermissions,
  users,
  type InsertTrafficBillingConfig,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { getSetting } from "./settingsRepository";
import { getUserById } from "./userRepository";

const GB_BYTES = 1024 ** 3;

export type TrafficBillingResourceType = "host" | "tunnel";

function normalizeMultiplier(value: number) {
  return Math.max(1, Math.min(3000, Math.round(Number(value) || 100)));
}

function normalizePrice(value: number) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export async function isTrafficBillingEnabled() {
  return (await getSetting("trafficBillingEnabled")) === "true";
}

export async function listTrafficBillingConfigs() {
  const db = await getDb();
  if (!db) return [];
  const configs = await db.select().from(trafficBillingConfigs).orderBy(desc(trafficBillingConfigs.updatedAt));
  const [hostRows, tunnelRows] = await Promise.all([
    db.select({ id: hosts.id, name: hosts.name }).from(hosts),
    db.select({ id: tunnels.id, name: tunnels.name }).from(tunnels),
  ]);
  const hostNames = new Map(hostRows.map((host: any) => [Number(host.id), host.name]));
  const tunnelNames = new Map(tunnelRows.map((tunnel: any) => [Number(tunnel.id), tunnel.name]));
  return configs.map((config: any) => ({
    ...config,
    resourceName: config.resourceType === "host"
      ? hostNames.get(Number(config.resourceId)) || `主机 #${config.resourceId}`
      : tunnelNames.get(Number(config.resourceId)) || `隧道 #${config.resourceId}`,
  }));
}

export async function getUserTrafficBillingPermissions(userId: number) {
  const db = await getDb();
  if (!db) return { hostIds: [], tunnelIds: [] };
  const rows = await db.select().from(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  return {
    hostIds: rows.filter((row: any) => row.resourceType === "host").map((row: any) => Number(row.resourceId)),
    tunnelIds: rows.filter((row: any) => row.resourceType === "tunnel").map((row: any) => Number(row.resourceId)),
  };
}

export async function getUserUsableTrafficBillingResourceIds(userId: number) {
  if (!(await isTrafficBillingEnabled())) return { hostIds: [], tunnelIds: [] };
  const db = await getDb();
  if (!db) return { hostIds: [], tunnelIds: [] };
  const permittedRows = await db
    .select({
      resourceType: userTrafficBillingPermissions.resourceType,
      resourceId: userTrafficBillingPermissions.resourceId,
    })
    .from(userTrafficBillingPermissions)
    .innerJoin(trafficBillingConfigs, and(
      eq(trafficBillingConfigs.resourceType, userTrafficBillingPermissions.resourceType),
      eq(trafficBillingConfigs.resourceId, userTrafficBillingPermissions.resourceId),
      eq(trafficBillingConfigs.enabled, true),
      eq(trafficBillingConfigs.requiresPermission, true),
    ))
    .where(eq(userTrafficBillingPermissions.userId, userId));
  const publicRows = await db
    .select({
      resourceType: trafficBillingConfigs.resourceType,
      resourceId: trafficBillingConfigs.resourceId,
    })
    .from(trafficBillingConfigs)
    .where(and(
      eq(trafficBillingConfigs.enabled, true),
      eq(trafficBillingConfigs.requiresPermission, false),
    ));
  const rows = [...permittedRows, ...publicRows];
  return {
    hostIds: Array.from(new Set(rows.filter((row: any) => row.resourceType === "host").map((row: any) => Number(row.resourceId)))),
    tunnelIds: Array.from(new Set(rows.filter((row: any) => row.resourceType === "tunnel").map((row: any) => Number(row.resourceId)))),
  };
}

export async function setUserTrafficBillingPermissions(userId: number, hostIds: number[], tunnelIds: number[]) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  const rows = [
    ...Array.from(new Set(hostIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "host", resourceId })),
    ...Array.from(new Set(tunnelIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "tunnel", resourceId })),
  ];
  if (rows.length > 0) await db.insert(userTrafficBillingPermissions).values(rows as any);
}

export async function checkUserTrafficBillingPermission(userId: number, resourceType: TrafficBillingResourceType, resourceId: number) {
  const db = await getDb();
  if (!db) return false;
  const configRows = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, resourceType),
    eq(trafficBillingConfigs.resourceId, resourceId),
    eq(trafficBillingConfigs.enabled, true),
  )).limit(1);
  const config = configRows[0] as any;
  if (!config) return false;
  if (!config.requiresPermission) return true;
  const rows = await db.select().from(userTrafficBillingPermissions).where(and(
    eq(userTrafficBillingPermissions.userId, userId),
    eq(userTrafficBillingPermissions.resourceType, resourceType),
    eq(userTrafficBillingPermissions.resourceId, resourceId),
  )).limit(1);
  return rows.length > 0;
}

export async function upsertTrafficBillingConfig(data: InsertTrafficBillingConfig) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const resourceType = String((data as any).resourceType || "") as TrafficBillingResourceType;
  const resourceId = Number((data as any).resourceId || 0);
  const id = Number((data as any).id || 0);
  if (resourceType !== "host" && resourceType !== "tunnel") throw new Error("资源类型无效");
  if (resourceId <= 0) throw new Error("资源无效");
  const payload = {
    resourceType,
    resourceId,
    enabled: !!(data as any).enabled,
    requiresPermission: !!(data as any).requiresPermission,
    pricePerGbCents: normalizePrice(Number((data as any).pricePerGbCents || 0)),
    multiplier: normalizeMultiplier(Number((data as any).multiplier || 100)),
    updatedAt: nowDate(),
  };
  if (id > 0) {
    const byId = await db.select().from(trafficBillingConfigs).where(eq(trafficBillingConfigs.id, id)).limit(1);
    if (!byId[0]) throw new Error("计费配置不存在");
    await db.update(trafficBillingConfigs).set(payload as any).where(eq(trafficBillingConfigs.id, id));
    return { ...byId[0], ...payload };
  }
  const existing = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, resourceType),
    eq(trafficBillingConfigs.resourceId, resourceId),
  )).limit(1);
  if (existing[0]) {
    await db.update(trafficBillingConfigs).set(payload as any).where(eq(trafficBillingConfigs.id, existing[0].id));
    return { ...existing[0], ...payload };
  }
  const createdId = await insertAndGetId("traffic_billing_configs", { ...payload, createdAt: nowDate() });
  return { id: createdId, ...payload };
}

export async function deleteTrafficBillingConfig(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(trafficBillingConfigs).where(eq(trafficBillingConfigs.id, id));
}

export async function findTrafficBillingConfig(resourceType: TrafficBillingResourceType, resourceId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(trafficBillingConfigs).where(and(
    eq(trafficBillingConfigs.resourceType, resourceType),
    eq(trafficBillingConfigs.resourceId, resourceId),
    eq(trafficBillingConfigs.enabled, true),
  )).limit(1);
  return rows[0];
}

export async function billTrafficUsage(input: {
  userId: number;
  ruleId: number;
  bytes: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
}) {
  if (input.bytes <= 0) return null;
  if (!(await isTrafficBillingEnabled())) return null;
  const config = await findTrafficBillingConfig(input.resourceType, input.resourceId);
  if (!config || Number(config.pricePerGbCents || 0) <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  const usageRows = await db.select().from(trafficBillingUsage).where(and(
    eq(trafficBillingUsage.userId, input.userId),
    eq(trafficBillingUsage.resourceType, input.resourceType),
    eq(trafficBillingUsage.resourceId, input.resourceId),
  )).limit(1);
  const usage = usageRows[0] as any;
  const previousBytes = Number(usage?.totalBytes || 0);
  const totalBytes = previousBytes + input.bytes;
  const previousBilledGb = Number(usage?.billedGb || 0);
  const totalBilledGb = Math.max(1, Math.ceil(totalBytes / GB_BYTES));
  const newlyBilledGb = Math.max(0, totalBilledGb - previousBilledGb);
  if (usage) {
    await db.update(trafficBillingUsage).set({
      totalBytes,
      billedGb: Math.max(previousBilledGb, totalBilledGb),
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingUsage.id, usage.id));
  } else {
    await db.insert(trafficBillingUsage).values({
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes,
      billedGb: totalBilledGb,
      updatedAt: nowDate(),
    } as any);
  }
  if (newlyBilledGb <= 0) return null;
  const multiplier = normalizeMultiplier(Number(config.multiplier || 100));
  const amountCents = Math.max(1, Math.ceil(newlyBilledGb * Number(config.pricePerGbCents || 0) * multiplier / 100));
  const user = await getUserById(input.userId);
  if (!user) return null;
  const balanceAfterCents = Number((user as any).balanceCents || 0) - amountCents;
  await db.update(users).set({ balanceCents: balanceAfterCents, updatedAt: nowDate() } as any).where(eq(users.id, input.userId));
  await db.insert(balanceTransactions).values({
    userId: input.userId,
    type: "traffic_billing",
    amountCents: -amountCents,
    balanceAfterCents,
    description: `流量计费：${input.resourceType === "host" ? "主机" : "隧道"} #${input.resourceId} 新增 ${newlyBilledGb}GB x ${(multiplier / 100).toFixed(2)}`,
    createdAt: nowDate(),
  } as any);
  await db.insert(trafficBillingRecords).values({
    userId: input.userId,
    ruleId: input.ruleId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    bytes: input.bytes,
    billedGb: newlyBilledGb,
    pricePerGbCents: Number(config.pricePerGbCents || 0),
    multiplier,
    amountCents,
    balanceAfterCents,
    createdAt: nowDate(),
  } as any);
  return { amountCents, billedGb: newlyBilledGb, balanceAfterCents };
}

export async function listTrafficBillingRecords(options?: { userId?: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.min(500, Number(options?.limit || 100)));
  const base = db
    .select({
      id: trafficBillingRecords.id,
      userId: trafficBillingRecords.userId,
      username: users.username,
      name: users.name,
      ruleId: trafficBillingRecords.ruleId,
      ruleName: forwardRules.name,
      resourceType: trafficBillingRecords.resourceType,
      resourceId: trafficBillingRecords.resourceId,
      bytes: trafficBillingRecords.bytes,
      billedGb: trafficBillingRecords.billedGb,
      pricePerGbCents: trafficBillingRecords.pricePerGbCents,
      multiplier: trafficBillingRecords.multiplier,
      amountCents: trafficBillingRecords.amountCents,
      balanceAfterCents: trafficBillingRecords.balanceAfterCents,
      createdAt: trafficBillingRecords.createdAt,
    })
    .from(trafficBillingRecords)
    .leftJoin(users, eq(trafficBillingRecords.userId, users.id))
    .leftJoin(forwardRules, eq(trafficBillingRecords.ruleId, forwardRules.id));
  if (options?.userId) {
    return base.where(eq(trafficBillingRecords.userId, options.userId)).orderBy(desc(trafficBillingRecords.createdAt)).limit(limit);
  }
  return base.orderBy(desc(trafficBillingRecords.createdAt)).limit(limit);
}

export async function getTrafficBillingSummary(userId?: number) {
  const db = await getDb();
  if (!db) return { enabled: await isTrafficBillingEnabled(), totalAmountCents: 0, totalBilledGb: 0, totalBytes: 0, records: [] };
  const records = await listTrafficBillingRecords({ userId, limit: 20 });
  const totalsQuery = db
    .select({
      totalAmountCents: sql<number>`COALESCE(SUM(${trafficBillingRecords.amountCents}), 0)`,
      totalBilledGb: sql<number>`COALESCE(SUM(${trafficBillingRecords.billedGb}), 0)`,
    })
    .from(trafficBillingRecords);
  const usageQuery = db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficBillingUsage.totalBytes}), 0)`,
    })
    .from(trafficBillingUsage);
  const [rows, usageRows] = await Promise.all([
    userId ? totalsQuery.where(eq(trafficBillingRecords.userId, userId)) : totalsQuery,
    userId ? usageQuery.where(eq(trafficBillingUsage.userId, userId)) : usageQuery,
  ]);
  return {
    enabled: await isTrafficBillingEnabled(),
    totalAmountCents: Number(rows[0]?.totalAmountCents || 0),
    totalBilledGb: Number(rows[0]?.totalBilledGb || 0),
    totalBytes: Number(usageRows[0]?.totalBytes || 0),
    records,
  };
}

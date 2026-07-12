import { and, desc, eq, sql } from "drizzle-orm";
import {
  balanceTransactions,
  forwardGroups,
  forwardRules,
  hosts,
  trafficBillingConfigs,
  trafficBillingRecords,
  trafficBillingRuleUsage,
  trafficBillingUsage,
  trafficStats,
  tunnels,
  userTrafficBillingPermissions,
  users,
  type InsertTrafficBillingConfig,
} from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { getSetting, setSetting } from "./settingsRepository";
import { getUserById } from "./userRepository";
import { formatTrafficMultiplier, normalizeTrafficMultiplier } from "../../shared/trafficMultiplier";

const GB_BYTES = 1024 ** 3;
const MILLI_CENTS_PER_CENT = 1000;
const BILLING_DENOMINATOR = 100n * BigInt(MILLI_CENTS_PER_CENT);
const TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER = "traffic-billing-rule-usage-v1";

export type TrafficBillingResourceType = "host" | "tunnel" | "forward_group";

function normalizeMultiplier(value: number) {
  return normalizeTrafficMultiplier(value);
}

function normalizePrice(value: number) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizePriceMilliCents(value: number) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function configPriceMilliCents(config: any) {
  const milliCents = normalizePriceMilliCents(Number(config?.pricePerGbMilliCents || 0));
  if (milliCents > 0) return milliCents;
  return normalizePrice(Number(config?.pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT;
}

function billedFullGb(totalBytes: number) {
  return Math.max(0, Math.floor(Math.max(0, Number(totalBytes) || 0) / GB_BYTES));
}

function effectiveAmountCentsForGb(gb: number, pricePerGbMilliCents: number, multiplier: number) {
  const numerator = BigInt(Math.max(0, Math.floor(gb)))
    * BigInt(normalizePriceMilliCents(pricePerGbMilliCents))
    * BigInt(normalizeMultiplier(multiplier));
  return Number(numerator / BILLING_DENOMINATOR);
}

function effectiveAmountCentsForBytes(bytes: number, pricePerGbMilliCents: number, multiplier: number) {
  const normalizedBytes = Math.max(0, Math.floor(Number(bytes) || 0));
  const numerator = BigInt(normalizedBytes)
    * BigInt(normalizePriceMilliCents(pricePerGbMilliCents))
    * BigInt(normalizeMultiplier(multiplier));
  return Number(numerator / (BigInt(GB_BYTES) * BILLING_DENOMINATOR));
}

function isTrafficBillingResourceType(value: unknown): value is TrafficBillingResourceType {
  return value === "host" || value === "tunnel" || value === "forward_group";
}

function forwardGroupBillingKind(group: any) {
  const mode = String(group?.groupMode || "failover");
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  if (group?.groupType === "tunnel") return "隧道转发组";
  return "转发组";
}

function trafficBillingResourceLabel(resourceType: TrafficBillingResourceType) {
  if (resourceType === "host") return "历史主机";
  if (resourceType === "tunnel") return "隧道转发";
  return "转发资源";
}

async function getBillingResourceMultiplier(resourceType: TrafficBillingResourceType, resourceId: number, fallback = 100) {
  const db = await getDb();
  if (!db) return normalizeMultiplier(fallback);
  if (resourceType === "tunnel") {
    const rows = await db.select({ trafficMultiplier: tunnels.trafficMultiplier }).from(tunnels).where(eq(tunnels.id, resourceId)).limit(1);
    return normalizeMultiplier(Number((rows[0] as any)?.trafficMultiplier || fallback));
  }
  if (resourceType === "forward_group") {
    const rows = await db.select({ trafficMultiplier: forwardGroups.trafficMultiplier }).from(forwardGroups).where(eq(forwardGroups.id, resourceId)).limit(1);
    return normalizeMultiplier(Number((rows[0] as any)?.trafficMultiplier || fallback));
  }
  return normalizeMultiplier(fallback);
}

async function assertBillingResourceExists(resourceType: TrafficBillingResourceType, resourceId: number) {
  const db = await getDb();
  if (!db) return;
  if (resourceType === "host") {
    const rows = await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, resourceId)).limit(1);
    if (!rows[0]) throw new Error("主机资源不存在");
    return;
  }
  if (resourceType === "tunnel") {
    const rows = await db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.id, resourceId)).limit(1);
    if (!rows[0]) throw new Error("隧道资源不存在");
    return;
  }
  const rows = await db.select({ id: forwardGroups.id }).from(forwardGroups).where(eq(forwardGroups.id, resourceId)).limit(1);
  if (!rows[0]) throw new Error("转发资源不存在");
}

export function trafficBillingResourceCandidatesForRule(rule: any) {
  const candidates: Array<{ resourceType: TrafficBillingResourceType; resourceId: number }> = [];
  const forwardGroupId = Number(rule?.forwardGroupId || 0);
  const tunnelId = Number(rule?.tunnelId || 0);
  const hostId = Number(rule?.hostId || 0);
  if (forwardGroupId > 0) candidates.push({ resourceType: "forward_group", resourceId: forwardGroupId });
  if (tunnelId > 0) candidates.push({ resourceType: "tunnel", resourceId: tunnelId });
  if (hostId > 0) candidates.push({ resourceType: "host", resourceId: hostId });
  return candidates;
}

export async function findTrafficBillingResourceForRule(rule: any) {
  for (const candidate of trafficBillingResourceCandidatesForRule(rule)) {
    const config = await findTrafficBillingConfig(candidate.resourceType, candidate.resourceId);
    if (config) return { ...candidate, config };
  }
  return null;
}

async function getHistoricalRuleTrafficBytes(ruleId: number) {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficStats.bytesIn} + ${trafficStats.bytesOut}), 0)`,
    })
    .from(trafficStats)
    .where(eq(trafficStats.ruleId, ruleId));
  return Number(rows[0]?.totalBytes || 0);
}

export async function backfillTrafficBillingRuleUsageFromStats() {
  if (await getSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER)) return { skipped: true, inserted: 0 };
  const db = await getDb();
  if (!db) return { skipped: true, inserted: 0 };

  const usageRows = await db.select().from(trafficBillingUsage);
  let inserted = 0;
  for (const usage of usageRows as any[]) {
    const userId = Number(usage?.userId || 0);
    const resourceType = String(usage?.resourceType || "") as TrafficBillingResourceType;
    const resourceId = Number(usage?.resourceId || 0);
    if (userId <= 0 || resourceId <= 0 || !isTrafficBillingResourceType(resourceType)) continue;

    const existingRows = await db
      .select({ ruleId: trafficBillingRuleUsage.ruleId })
      .from(trafficBillingRuleUsage)
      .where(and(
        eq(trafficBillingRuleUsage.resourceType, resourceType),
        eq(trafficBillingRuleUsage.resourceId, resourceId),
      ));
    const existingRuleIds = new Set((existingRows as any[]).map((row) => Number(row.ruleId || 0)));
    const ruleConditions: any[] = [eq(forwardRules.userId, userId)];
    if (resourceType === "host") {
      ruleConditions.push(eq(forwardRules.hostId, resourceId));
      ruleConditions.push(sql`(${forwardRules.tunnelId} IS NULL OR ${forwardRules.tunnelId} = 0)`);
    } else if (resourceType === "tunnel") {
      ruleConditions.push(eq(forwardRules.tunnelId, resourceId));
    } else {
      ruleConditions.push(eq(forwardRules.forwardGroupId, resourceId));
    }
    const ruleRows = await db
      .select({ id: forwardRules.id })
      .from(forwardRules)
      .where(and(...ruleConditions));

    for (const rule of ruleRows as any[]) {
      const ruleId = Number(rule?.id || 0);
      if (ruleId <= 0 || existingRuleIds.has(ruleId)) continue;
      const totalBytes = Math.max(0, await getHistoricalRuleTrafficBytes(ruleId));
      if (totalBytes <= 0) continue;
      await db.insert(trafficBillingRuleUsage).values({
        userId,
        ruleId,
        resourceType,
        resourceId,
        totalBytes,
        billedGb: Math.ceil(totalBytes / GB_BYTES),
        pendingMilliCents: 0,
        settled: false,
        updatedAt: nowDate(),
      } as any);
      existingRuleIds.add(ruleId);
      inserted += 1;
    }
  }
  await setSetting(TRAFFIC_BILLING_RULE_USAGE_BACKFILL_MARKER, String(Math.floor(Date.now() / 1000)));
  return { skipped: false, inserted };
}
export async function isTrafficBillingEnabled() {
  return (await getSetting("trafficBillingEnabled")) === "true";
}

export async function listTrafficBillingConfigs() {
  const db = await getDb();
  if (!db) return [];
  const configs = await db.select().from(trafficBillingConfigs).orderBy(desc(trafficBillingConfigs.updatedAt));
  const [hostRows, tunnelRows, forwardGroupRows] = await Promise.all([
    db.select({ id: hosts.id, name: hosts.name }).from(hosts),
    db.select({ id: tunnels.id, name: tunnels.name, trafficMultiplier: tunnels.trafficMultiplier, mode: tunnels.mode }).from(tunnels),
    db.select({
      id: forwardGroups.id,
      name: forwardGroups.name,
      groupType: forwardGroups.groupType,
      groupMode: forwardGroups.groupMode,
      trafficMultiplier: forwardGroups.trafficMultiplier,
    }).from(forwardGroups),
  ]);
  const hostNames = new Map(hostRows.map((host: any) => [Number(host.id), host.name]));
  const tunnelById = new Map<number, any>(tunnelRows.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const forwardGroupById = new Map<number, any>(forwardGroupRows.map((group: any) => [Number(group.id), group]));
  return configs.map((config: any) => ({
    ...config,
    pricePerGbMilliCents: configPriceMilliCents(config),
    ...(() => {
      const resourceId = Number(config.resourceId);
      if (config.resourceType === "host") {
        return {
          resourceName: hostNames.get(resourceId) || `主机 #${config.resourceId}`,
          resourceKind: "历史主机",
          resourceMissing: !hostNames.has(resourceId),
          configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplierText: formatTrafficMultiplier(config.multiplier),
        };
      }
      if (config.resourceType === "forward_group") {
        const group = forwardGroupById.get(resourceId);
        const multiplier = normalizeMultiplier(Number(group?.trafficMultiplier || config.multiplier || 100));
        return {
          resourceName: group?.name || `转发资源 #${config.resourceId}`,
          resourceKind: group ? forwardGroupBillingKind(group) : "转发资源",
          resourceMissing: !group,
          configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
          multiplier,
          multiplierText: formatTrafficMultiplier(multiplier),
        };
      }
      const tunnel = tunnelById.get(resourceId);
      const multiplier = normalizeMultiplier(Number(tunnel?.trafficMultiplier || config.multiplier || 100));
      return {
        resourceName: tunnel?.name || `隧道 #${config.resourceId}`,
        resourceKind: "隧道转发",
        resourceMissing: !tunnel,
        configuredMultiplier: normalizeMultiplier(Number(config.multiplier || 100)),
        multiplier,
        multiplierText: formatTrafficMultiplier(multiplier),
      };
    })(),
  }));
}

export async function getUserTrafficBillingPermissions(userId: number) {
  const db = await getDb();
  if (!db) return { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
  const rows = await db.select().from(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  return {
    hostIds: rows.filter((row: any) => row.resourceType === "host").map((row: any) => Number(row.resourceId)),
    tunnelIds: rows.filter((row: any) => row.resourceType === "tunnel").map((row: any) => Number(row.resourceId)),
    forwardGroupIds: rows.filter((row: any) => row.resourceType === "forward_group").map((row: any) => Number(row.resourceId)),
  };
}

export async function getUserUsableTrafficBillingResourceIds(userId: number) {
  if (!(await isTrafficBillingEnabled())) return { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
  const db = await getDb();
  if (!db) return { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
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
    forwardGroupIds: Array.from(new Set(rows.filter((row: any) => row.resourceType === "forward_group").map((row: any) => Number(row.resourceId)))),
  };
}

export async function setUserTrafficBillingPermissions(userId: number, hostIds: number[], tunnelIds: number[], forwardGroupIds: number[] = []) {
  const db = await getDb();
  if (!db) return;
  await db.delete(userTrafficBillingPermissions).where(eq(userTrafficBillingPermissions.userId, userId));
  const rows = [
    ...Array.from(new Set(hostIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "host", resourceId })),
    ...Array.from(new Set(tunnelIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "tunnel", resourceId })),
    ...Array.from(new Set(forwardGroupIds.map(Number).filter((id) => id > 0))).map((resourceId) => ({ userId, resourceType: "forward_group", resourceId })),
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
  if (!isTrafficBillingResourceType(resourceType)) throw new Error("资源类型无效");
  if (resourceId <= 0) throw new Error("资源无效");
  await assertBillingResourceExists(resourceType, resourceId);
  const existingById = id > 0
    ? (await db.select().from(trafficBillingConfigs).where(eq(trafficBillingConfigs.id, id)).limit(1))[0]
    : null;
  const pricePerGbMilliCents = normalizePriceMilliCents(
    Number((data as any).pricePerGbMilliCents || 0) || normalizePrice(Number((data as any).pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT,
  );
  const multiplier = await getBillingResourceMultiplier(
    resourceType,
    resourceId,
    Number((data as any).multiplier || (existingById as any)?.multiplier || 100),
  );
  const payload = {
    resourceType,
    resourceId,
    enabled: !!(data as any).enabled,
    requiresPermission: !!(data as any).requiresPermission,
    description: String((data as any).description || "").trim() || null,
    pricePerGbCents: Math.floor(pricePerGbMilliCents / MILLI_CENTS_PER_CENT),
    pricePerGbMilliCents,
    multiplier,
    updatedAt: nowDate(),
  };
  if (id > 0) {
    if (!existingById) throw new Error("计费配置不存在");
    await db.update(trafficBillingConfigs).set(payload as any).where(eq(trafficBillingConfigs.id, id));
    return { ...existingById, ...payload };
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

async function insertTrafficBillingCharge(input: {
  userId: number;
  ruleId: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
  bytes: number;
  billedGb: number;
  amountCents: number;
  pricePerGbMilliCents: number;
  multiplier: number;
  description: string;
}) {
  const amountCents = Math.max(0, Math.floor(Number(input.amountCents) || 0));
  if (amountCents <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  const user = await getUserById(input.userId);
  if (!user) return null;
  const balanceAfterCents = Number((user as any).balanceCents || 0) - amountCents;
  await db.update(users).set({ balanceCents: balanceAfterCents, updatedAt: nowDate() } as any).where(eq(users.id, input.userId));
  await db.insert(balanceTransactions).values({
    userId: input.userId,
    type: "traffic_billing",
    amountCents: -amountCents,
    balanceAfterCents,
    description: input.description,
    createdAt: nowDate(),
  } as any);
  await db.insert(trafficBillingRecords).values({
    userId: input.userId,
    ruleId: input.ruleId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    bytes: Math.max(0, Math.floor(Number(input.bytes) || 0)),
    billedGb: Math.max(0, Math.floor(Number(input.billedGb) || 0)),
    pricePerGbCents: Math.floor(input.pricePerGbMilliCents / MILLI_CENTS_PER_CENT),
    pricePerGbMilliCents: input.pricePerGbMilliCents,
    multiplier: input.multiplier,
    amountCents,
    balanceAfterCents,
    createdAt: nowDate(),
  } as any);
  return { amountCents, billedGb: input.billedGb, balanceAfterCents };
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
  const pricePerGbMilliCents = configPriceMilliCents(config);
  if (!config || pricePerGbMilliCents <= 0) return null;
  const db = await getDb();
  if (!db) return null;
  const [usageRows, ruleUsageRows] = await Promise.all([
    db.select().from(trafficBillingUsage).where(and(
      eq(trafficBillingUsage.userId, input.userId),
      eq(trafficBillingUsage.resourceType, input.resourceType),
      eq(trafficBillingUsage.resourceId, input.resourceId),
    )).limit(1),
    db.select().from(trafficBillingRuleUsage).where(and(
      eq(trafficBillingRuleUsage.ruleId, input.ruleId),
      eq(trafficBillingRuleUsage.resourceType, input.resourceType),
      eq(trafficBillingRuleUsage.resourceId, input.resourceId),
    )).limit(1),
  ]);
  const usage = usageRows[0] as any;
  const previousBytes = Number(usage?.totalBytes || 0);
  const totalBytes = previousBytes + input.bytes;
  const previousBilledGb = Number(usage?.billedGb || 0);
  const multiplier = await getBillingResourceMultiplier(input.resourceType, input.resourceId, Number(config.multiplier || 100));
  const ruleUsage = ruleUsageRows[0] as any;
  const hasAnyRuleUsage = ruleUsage
    ? true
    : (await db.select({ id: trafficBillingRuleUsage.id }).from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId)).limit(1)).length > 0;
  const historicalRuleBytes = ruleUsage || hasAnyRuleUsage || !usage
    ? 0
    : Math.max(0, (await getHistoricalRuleTrafficBytes(input.ruleId)) - input.bytes);
  const previousRuleBytes = Number(ruleUsage?.totalBytes || historicalRuleBytes);
  const previousRuleBilledGb = Number(ruleUsage?.billedGb || (historicalRuleBytes > 0 ? Math.ceil(historicalRuleBytes / GB_BYTES) : 0));
  const nextRuleBytes = previousRuleBytes + input.bytes;
  const nextRuleBilledGb = billedFullGb(nextRuleBytes);
  const newlyBilledGb = Math.max(0, nextRuleBilledGb - previousRuleBilledGb);
  const storedRuleBilledGb = Math.max(previousRuleBilledGb, nextRuleBilledGb);
  if (usage) {
    await db.update(trafficBillingUsage).set({
      totalBytes,
      billedGb: previousBilledGb + newlyBilledGb,
      pendingMilliCents: 0,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingUsage.id, usage.id));
  } else {
    await db.insert(trafficBillingUsage).values({
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes,
      billedGb: newlyBilledGb,
      pendingMilliCents: 0,
      updatedAt: nowDate(),
    } as any);
  }
  if (ruleUsage) {
    await db.update(trafficBillingRuleUsage).set({
      userId: input.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes: nextRuleBytes,
      billedGb: storedRuleBilledGb,
      pendingMilliCents: 0,
      settled: false,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingRuleUsage.id, ruleUsage.id));
  } else {
    await db.insert(trafficBillingRuleUsage).values({
      userId: input.userId,
      ruleId: input.ruleId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      totalBytes: nextRuleBytes,
      billedGb: storedRuleBilledGb,
      pendingMilliCents: 0,
      settled: false,
      updatedAt: nowDate(),
    } as any);
  }
  if (newlyBilledGb <= 0) return null;
  const amountCents = effectiveAmountCentsForGb(newlyBilledGb, pricePerGbMilliCents, multiplier);
  return insertTrafficBillingCharge({
    userId: input.userId,
    ruleId: input.ruleId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    bytes: input.bytes,
    billedGb: newlyBilledGb,
    pricePerGbMilliCents,
    multiplier,
    amountCents,
    description: `流量计费：${trafficBillingResourceLabel(input.resourceType)} #${input.resourceId} 新增 ${newlyBilledGb}GB x ${(multiplier / 100).toFixed(2)}`,
  });
}

export async function settleTrafficBillingRuleOnDelete(input: {
  userId: number;
  ruleId: number;
  resourceType: TrafficBillingResourceType;
  resourceId: number;
}) {
  if (!(await isTrafficBillingEnabled())) return null;
  const db = await getDb();
  if (!db) return null;
  let rows = await db.select().from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId));
  if (rows.length === 0) {
    const usageRows = await db.select({ id: trafficBillingUsage.id }).from(trafficBillingUsage).where(and(
      eq(trafficBillingUsage.userId, input.userId),
      eq(trafficBillingUsage.resourceType, input.resourceType),
      eq(trafficBillingUsage.resourceId, input.resourceId),
    )).limit(1);
    const historicalRuleBytes = usageRows.length > 0 ? await getHistoricalRuleTrafficBytes(input.ruleId) : 0;
    if (historicalRuleBytes > 0) {
      await db.insert(trafficBillingRuleUsage).values({
        userId: input.userId,
        ruleId: input.ruleId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        totalBytes: historicalRuleBytes,
        billedGb: Math.ceil(historicalRuleBytes / GB_BYTES),
        pendingMilliCents: 0,
        settled: false,
        updatedAt: nowDate(),
      } as any);
      rows = await db.select().from(trafficBillingRuleUsage).where(eq(trafficBillingRuleUsage.ruleId, input.ruleId));
    }
  }
  let totalAmountCents = 0;
  let balanceAfterCents: number | null = null;
  for (const usage of rows as any[]) {
    if (!usage || usage.settled) continue;
    const resourceType = String(usage.resourceType || input.resourceType) as TrafficBillingResourceType;
    const resourceId = Number(usage.resourceId || input.resourceId);
    const config = isTrafficBillingResourceType(resourceType)
      ? await findTrafficBillingConfig(resourceType, resourceId)
      : null;
    const pricePerGbMilliCents = configPriceMilliCents(config);
    const totalBytes = Math.max(0, Number(usage.totalBytes || 0));
    const billedBytes = Math.max(0, Number(usage.billedGb || 0)) * GB_BYTES;
    const remainingBytes = Math.max(0, totalBytes - billedBytes);
    const multiplier = await getBillingResourceMultiplier(resourceType, resourceId, Number(config?.multiplier || 100));
    const amountCents = config && pricePerGbMilliCents > 0
      ? effectiveAmountCentsForBytes(remainingBytes, pricePerGbMilliCents, multiplier)
      : 0;
    await db.update(trafficBillingRuleUsage).set({
      pendingMilliCents: 0,
      settled: true,
      updatedAt: nowDate(),
    } as any).where(eq(trafficBillingRuleUsage.id, usage.id));
    if (remainingBytes <= 0 || amountCents <= 0) continue;
    const charged = await insertTrafficBillingCharge({
      userId: input.userId,
      ruleId: input.ruleId,
      resourceType,
      resourceId,
      bytes: remainingBytes,
      billedGb: 0,
      pricePerGbMilliCents,
      multiplier,
      amountCents,
      description: `流量计费：${trafficBillingResourceLabel(resourceType)} #${resourceId} 删除规则结算 ${remainingBytes} bytes x ${(multiplier / 100).toFixed(2)}`,
    });
    if (charged) {
      totalAmountCents += charged.amountCents;
      balanceAfterCents = charged.balanceAfterCents;
    }
  }
  if (totalAmountCents <= 0 || balanceAfterCents === null) return null;
  return { amountCents: totalAmountCents, billedGb: 0, balanceAfterCents };
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
      pricePerGbMilliCents: trafficBillingRecords.pricePerGbMilliCents,
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
    })
    .from(trafficBillingRecords);
  const usageQuery = db
    .select({
      totalBytes: sql<number>`COALESCE(SUM(${trafficBillingUsage.totalBytes}), 0)`,
      totalBilledGb: sql<number>`COALESCE(SUM(${trafficBillingUsage.billedGb}), 0)`,
    })
    .from(trafficBillingUsage);
  const [rows, usageRows] = await Promise.all([
    userId ? totalsQuery.where(eq(trafficBillingRecords.userId, userId)) : totalsQuery,
    userId ? usageQuery.where(eq(trafficBillingUsage.userId, userId)) : usageQuery,
  ]);
  return {
    enabled: await isTrafficBillingEnabled(),
    totalAmountCents: Number(rows[0]?.totalAmountCents || 0),
    totalBilledGb: Number(usageRows[0]?.totalBilledGb || 0),
    totalBytes: Number(usageRows[0]?.totalBytes || 0),
    records,
  };
}

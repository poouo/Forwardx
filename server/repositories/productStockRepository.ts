import { boolLiteral } from "../dbCompat";
import { executeRaw, getDatabaseKind, isDatabaseTransactionActive, queryRaw, quoteDbIdentifier as q, rawAffectedRows } from "../dbRuntime";
import { getSetting } from "./settingsRepository";

/** Must be in the same transaction as the order/subscription being created. */
export async function reservePlanStock(planId: number) {
  if (!isDatabaseTransactionActive()) throw new Error("Stock reservation requires a transaction");
  const result = await executeRaw(`UPDATE ${q("subscription_plans")}
    SET ${q("stockUsed")} = ${q("stockUsed")} + 1
    WHERE ${q("id")} = ? AND ${q("isActive")} = ${boolLiteral(true)}
      AND (${q("stockLimit")} = 0 OR ${q("stockUsed")} < ${q("stockLimit")})`, [planId]);
  if (rawAffectedRows(result) !== 1) throw new Error("套餐库存不足或已售罄");
}

export async function releasePlanStock(planId: number) {
  if (!isDatabaseTransactionActive()) throw new Error("Stock release requires a transaction");
  await executeRaw(`UPDATE ${q("subscription_plans")} SET ${q("stockUsed")} = ${q("stockUsed")} - 1
    WHERE ${q("id")} = ? AND ${q("stockUsed")} > 0`, [planId]);
}

const rootCondition = (alias: string) => `COALESCE(${alias}.${q("forwardGroupRuleId")}, 0) = 0
  AND COALESCE(${alias}.${q("forwardGroupMemberId")}, 0) = 0
  AND COALESCE(${alias}.${q("pendingDelete")}, ${boolLiteral(false)}) = ${boolLiteral(false)}`;

// Same group > tunnel > host precedence as the traffic billing resolver.
const selectedConfig = (r: string, lock = false) => `(SELECT c.${q("id")} FROM ${q("traffic_billing_configs")} c
  WHERE c.${q("enabled")} = ${boolLiteral(true)} AND (
    (c.${q("resourceType")} = 'forward_group' AND c.${q("resourceId")} = ${r}.${q("forwardGroupId")}) OR
    (c.${q("resourceType")} = 'tunnel' AND c.${q("resourceId")} = ${r}.${q("tunnelId")}) OR
    (c.${q("resourceType")} = 'host' AND c.${q("resourceId")} = ${r}.${q("hostId")}))
  ORDER BY CASE c.${q("resourceType")} WHEN 'forward_group' THEN 0 WHEN 'tunnel' THEN 1 ELSE 2 END LIMIT 1${lock && getDatabaseKind() === "mysql" ? " FOR UPDATE" : ""})`;

export async function getTrafficStockUsage() {
  const rows = await queryRaw<{ configId: number; used: number }>(`SELECT x.${q("configId")}, COUNT(DISTINCT x.${q("userId")}) AS ${q("used")}
    FROM (SELECT ${selectedConfig("r")} AS ${q("configId")}, r.${q("userId")} FROM ${q("forward_rules")} r WHERE ${rootCondition("r")}) x
    WHERE x.${q("configId")} IS NOT NULL GROUP BY x.${q("configId")}`);
  return new Map(rows.map((row) => [Number(row.configId), Number(row.used)]));
}

export async function getTrafficRuleUsageForUser(userId: number) {
  const rows = await queryRaw<{ configId: number; used: number }>(`SELECT x.${q("configId")}, COUNT(*) AS ${q("used")}
    FROM (SELECT ${selectedConfig("r")} AS ${q("configId")} FROM ${q("forward_rules")} r
      WHERE r.${q("userId")} = ? AND ${rootCondition("r")}) x
    WHERE x.${q("configId")} IS NOT NULL GROUP BY x.${q("configId")}`, [userId]);
  return new Map(rows.map(row => [Number(row.configId), Number(row.used)]));
}

function isRoot(rule: any) {
  return rule && !rule.forwardGroupRuleId && !rule.forwardGroupMemberId && !rule.pendingDelete;
}

async function matchingConfig(rule: any, lock: boolean) {
  const suffix = lock && getDatabaseKind() !== "sqlite" ? " FOR UPDATE" : "";
  const rows = await queryRaw<{ id: number; resourceType: string; resourceId: number; stockLimit: number; maxRulesPerUser: number }>(`SELECT ${q("id")}, ${q("resourceType")}, ${q("resourceId")}, ${q("stockLimit")}, ${q("maxRulesPerUser")}
    FROM ${q("traffic_billing_configs")} WHERE ${q("enabled")} = ${boolLiteral(true)} AND (
      (${q("resourceType")} = 'forward_group' AND ${q("resourceId")} = ?) OR
      (${q("resourceType")} = 'tunnel' AND ${q("resourceId")} = ?) OR
      (${q("resourceType")} = 'host' AND ${q("resourceId")} = ?))
    ORDER BY CASE ${q("resourceType")} WHEN 'forward_group' THEN 0 WHEN 'tunnel' THEN 1 ELSE 2 END LIMIT 1${suffix}`,
  [Number(rule.forwardGroupId || 0), Number(rule.tunnelId || 0), Number(rule.hostId || 0)]);
  return rows[0];
}

/** Lock the product before counting and inserting/moving a logical rule.
 * Locking reads are intentional: MySQL REPEATABLE READ snapshots may predate
 * the preceding buyer's commit even after acquiring the product row lock. */
export async function assertRuleStock(next: any, previous?: any) {
  if (!isRoot(next)) return;
  if (!isDatabaseTransactionActive()) throw new Error("Rule stock check requires a transaction");
  if ((await getSetting("trafficBillingEnabled")) !== "true") return;
  if (getDatabaseKind() !== "sqlite") {
    // Lock source and destination products in one deterministic order before
    // any rule row. This avoids the common create-vs-edit/swap lock inversion.
    const candidates = [next, previous].filter(isRoot);
    const condition = `(${q("resourceType")} = 'forward_group' AND ${q("resourceId")} = ?) OR (${q("resourceType")} = 'tunnel' AND ${q("resourceId")} = ?) OR (${q("resourceType")} = 'host' AND ${q("resourceId")} = ?)`;
    await queryRaw(`SELECT ${q("id")} FROM ${q("traffic_billing_configs")} WHERE ${candidates.map(() => `(${condition})`).join(" OR ")} ORDER BY ${q("id")} FOR UPDATE`,
      candidates.flatMap(rule => [Number(rule.forwardGroupId || 0), Number(rule.tunnelId || 0), Number(rule.hostId || 0)]));
  }
  const config = await matchingConfig(next, true);
  if (!config || (Number(config.stockLimit) === 0 && Number(config.maxRulesPerUser) === 0)) return;
  if (isRoot(previous) && Number(previous.userId) === Number(next.userId) && (await matchingConfig(previous, true))?.id === config.id) return;
  const suffix = getDatabaseKind() === "sqlite" ? "" : " FOR UPDATE";
  const resourceColumn = config.resourceType === "forward_group" ? "forwardGroupId" : config.resourceType === "tunnel" ? "tunnelId" : "hostId";
  const onlyOwn = Number(config.stockLimit) === 0;
  const occupied = await queryRaw<{ id: number; userId: number }>(`SELECT r.${q("id")}, r.${q("userId")} FROM ${q("forward_rules")} r
    WHERE r.${q(resourceColumn)} = ? AND ${rootCondition("r")} AND ${selectedConfig("r", true)} = ? AND r.${q("id")} <> ?
      ${onlyOwn ? `AND r.${q("userId")} = ?` : ""}${suffix}`, [config.resourceId, config.id, Number(previous?.id || 0), ...(onlyOwn ? [Number(next.userId)] : [])]);
  const ownCount = occupied.filter(rule => Number(rule.userId) === Number(next.userId)).length;
  if (Number(config.maxRulesPerUser) > 0 && ownCount >= Number(config.maxRulesPerUser)) throw new Error("已达到该计费资源的单用户规则上限");
  const users = new Set(occupied.map(rule => Number(rule.userId)));
  // One user reserves one unit, even if they create multiple logical rules.
  if (ownCount === 0 && Number(config.stockLimit) > 0 && users.size >= Number(config.stockLimit)) throw new Error("该计费资源库存不足或已售罄");
}

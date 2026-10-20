import { boolLiteral, quoteIdentifier as q } from "../dbCompat";

/** Index-driven owner closure, including managed children owned by a template.
 * Never starts by scanning all traffic and applying COALESCE(userId) afterwards.
 * Parent ownership is authoritative only for a matching, real group template.
 */
export function trafficOwnerRuleIdsSql(userId: number) {
  return {
    sql: `SELECT own.${q("id")} FROM ${q("forward_rules")} own
      LEFT JOIN ${q("forward_rules")} owner_parent
        ON owner_parent.${q("id")} = own.${q("forwardGroupRuleId")}
       AND owner_parent.${q("forwardGroupId")} = own.${q("forwardGroupId")}
       AND owner_parent.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}
      WHERE own.${q("userId")} = ?
        AND (owner_parent.${q("id")} IS NULL OR owner_parent.${q("userId")} = ?)
      UNION
      SELECT child.${q("id")} FROM ${q("forward_rules")} owner_root
      INNER JOIN ${q("forward_rules")} child
        ON child.${q("forwardGroupRuleId")} = owner_root.${q("id")}
       AND child.${q("forwardGroupId")} = owner_root.${q("forwardGroupId")}
      WHERE owner_root.${q("userId")} = ?
        AND child.${q("forwardGroupRuleId")} IS NOT NULL
        AND owner_root.${q("isForwardGroupTemplate")} = ${boolLiteral(true)}`,
    params: [userId, userId, userId],
  };
}

/** Stored owner is used only for orphan history, not to override a live rule's
 * current owner. UNION branches can seek ruleId / userId indexes independently.
 */
export function scopedTrafficSource(table: string, alias: string, userId?: number, storedOwner = false) {
  if (!userId) return { sql: `${q(table)} ${alias}`, params: [] as number[] };
  const owned = trafficOwnerRuleIdsSql(userId);
  return {
    sql: `(SELECT scoped.* FROM ${q(table)} scoped
       WHERE scoped.${q("ruleId")} IN (${owned.sql})
       ${storedOwner ? `UNION ALL SELECT historical.* FROM ${q(table)} historical
        WHERE historical.${q("userId")} = ? AND NOT EXISTS (
          SELECT 1 FROM ${q("forward_rules")} current_rule WHERE current_rule.${q("id")} = historical.${q("ruleId")}
        )` : ""}) ${alias}`,
    params: [...owned.params, ...(storedOwner ? [userId] : [])],
  };
}

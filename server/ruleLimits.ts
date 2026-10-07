import { and, eq, inArray, isNotNull, isNull, or, gt } from "drizzle-orm";
import { forwardRules } from "../drizzle/schema";
import * as db from "./db";
import { ruleLimitReason, isAdminManagedRule } from "../shared/ruleLimits";
import { pushAgentRefresh } from "./agentEvents";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { executeRaw, withDatabaseTransaction } from "./dbRuntime";
import { quoteIdentifier as q } from "./dbCompat";

const rootId = (rule: any) => Number(rule.forwardGroupRuleId || rule.id);

export async function getRuleLimitPolicies(ids?: number[]): Promise<any[]> {
  const connection = await db.getDb();
  if (!connection || (ids && ids.length === 0)) return [];
  return connection.select().from(forwardRules).where(and(
    eq(forwardRules.pendingDelete, false), or(isNull(forwardRules.forwardGroupRuleId), eq(forwardRules.forwardGroupRuleId, 0)),
    ids ? inArray(forwardRules.id, [...new Set(ids)]) : or(
      gt(forwardRules.trafficLimit, 0), isNotNull(forwardRules.expiresAt), isNotNull(forwardRules.ruleLimitReason),
    ),
  ));
}

async function reasonsForPolicies(policies: any[]) {
  const quotaIds = policies.filter(rule => isAdminManagedRule(rule) && rule.quotaUsedIn == null).map(rule => Number(rule.id));
  const totals = new Map<number, { bytesIn: number; bytesOut: number }>();
  if (quotaIds.length) {
    // Bounded cumulative counters, normalized to logical rules: only the entry
    // of a chain counts, and generated group members roll up to their template.
    for (const row of await db.getTrafficCounterSummaryByRule({ ruleIds: quotaIds, includeLatency: false })) {
      const value = totals.get(row.ruleId) || { bytesIn: 0, bytesOut: 0 };
      value.bytesIn += Number(row.bytesIn) || 0;
      value.bytesOut += Number(row.bytesOut) || 0;
      totals.set(row.ruleId, value);
    }
    const connection = await db.getDb();
    if (connection) for (const id of quotaIds) {
      const total = totals.get(id) || { bytesIn: 0, bytesOut: 0 };
      // A concurrent report may already have initialized/incremented the row.
      // Never replace an established logical-rule counter with a snapshot.
      await connection.update(forwardRules).set({ quotaUsedIn: total.bytesIn, quotaUsedOut: total.bytesOut })
        .where(and(eq(forwardRules.id, id), isNull(forwardRules.quotaUsedIn)));
    }
    for (const policy of await getRuleLimitPolicies(quotaIds)) {
      totals.set(Number(policy.id), { bytesIn: Number(policy.quotaUsedIn) || 0, bytesOut: Number(policy.quotaUsedOut) || 0 });
    }
  }
  return new Map(policies.map(rule => [Number(rule.id), ruleLimitReason(rule, totals.get(Number(rule.id)) || {
    bytesIn: Number(rule.quotaUsedIn) || 0, bytesOut: Number(rule.quotaUsedOut) || 0,
  })]));
}

/** Called inside the existing deduplicated, per-user accounting transaction. */
export async function recordRuleQuotaTraffic(items: db.TrafficStatBatchItem[], contexts: Map<number, any>) {
  const deltas = new Map<number, { bytesIn: number; bytesOut: number }>();
  for (const item of items) {
    const rule = contexts.get(Number(item.stat.ruleId))?.rule;
    if (!rule) continue;
    if (!Number(rule.forwardGroupRuleId) && !isAdminManagedRule(rule) && rule.quotaUsedIn == null) continue;
    const id = rootId(rule);
    const delta = deltas.get(id) || { bytesIn: 0, bytesOut: 0 };
    delta.bytesIn += Math.max(0, Number(item.stat.bytesIn) || 0);
    delta.bytesOut += Math.max(0, Number(item.stat.bytesOut) || 0);
    deltas.set(id, delta);
  }
  if (!deltas.size) return;
  const policies = (await getRuleLimitPolicies([...deltas.keys()]))
    .filter(rule => isAdminManagedRule(rule) || rule.quotaUsedIn != null);
  const missingIds = policies.filter(rule => rule.quotaUsedIn == null).map(rule => Number(rule.id));
  const totals = new Map<number, { bytesIn: number; bytesOut: number }>();
  if (missingIds.length) for (const row of await db.getTrafficCounterSummaryByRule({ ruleIds: missingIds, includeLatency: false })) {
    const total = totals.get(row.ruleId) || { bytesIn: 0, bytesOut: 0 };
    total.bytesIn += Number(row.bytesIn) || 0; total.bytesOut += Number(row.bytesOut) || 0;
    totals.set(row.ruleId, total);
  }
  for (const policy of policies) {
    const id = Number(policy.id); const delta = deltas.get(id)!;
    const total = totals.get(id) || delta;
    // Stats already include this report. On first initialization, subtract its
    // delta from the baseline; COALESCE still handles a concurrent initializer.
    await executeRaw(`UPDATE ${q("forward_rules")} SET
      ${q("quotaUsedIn")} = COALESCE(${q("quotaUsedIn")}, ?) + ?,
      ${q("quotaUsedOut")} = COALESCE(${q("quotaUsedOut")}, ?) + ? WHERE ${q("id")} = ?`,
    [Math.max(0, total.bytesIn - delta.bytesIn), delta.bytesIn, Math.max(0, total.bytesOut - delta.bytesOut), delta.bytesOut, id]);
  }
}

export async function resetRuleQuotaCounters(ids: number[]) {
  const connection = await db.getDb();
  if (!connection || !ids.length) return;
  await connection.update(forwardRules).set({ quotaUsedIn: 0, quotaUsedOut: 0 }).where(and(
    inArray(forwardRules.id, ids), or(isNotNull(forwardRules.quotaUsedIn), gt(forwardRules.trafficLimit, 0)),
  ));
}

export async function applyRuleLimitsForRuntime<T extends Record<string, any>>(rules: T[]): Promise<T[]> {
  if (!rules.length) return rules;
  const parentIds = [...new Set(rules.filter(rule => Number(rule.forwardGroupRuleId) > 0).map(rootId))];
  const policies = [...rules.filter(rule => !Number(rule.forwardGroupRuleId)), ...await getRuleLimitPolicies(parentIds)];
  const byId = new Map<number, any>(policies.map(rule => [Number(rule.id), rule]));
  const reasons = await reasonsForPolicies(policies);
  return rules.map(rule => {
    const policy = byId.get(rootId(rule));
    if (!policy) return rule;
    const reason = reasons.get(Number(policy.id));
    // Leave ordinary, available root rules untouched, including their object
    // identity: callers use that identity to avoid needless runtime rebuilding.
    if (!reason && !Number(rule.forwardGroupRuleId) && !rule.ruleLimitReason) return rule;
    return { ...rule, rateLimitMbps: policy.rateLimitMbps, expiresAt: policy.expiresAt,
      trafficLimit: policy.trafficLimit, trafficMode: policy.trafficMode, ruleLimitReason: reason,
      ...(reason ? { isEnabled: false, resourceAccessDenied: true } : {}) };
  });
}

export async function refreshRuleLimitAgents(policy: any) {
  const rows = [policy, ...await db.getForwardGroupChildRulesForTemplate(Number(policy.id))];
  const hosts = new Set<number>(rows.map(rule => Number(rule.hostId)).filter(id => id > 0));
  for (const tunnelId of new Set(rows.map(rule => Number(rule.tunnelId)).filter(id => id > 0))) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    hosts.add(Number(tunnel.entryHostId)); hosts.add(Number(tunnel.exitHostId));
    for (const hop of await db.getTunnelHops(tunnelId)) hosts.add(Number(hop.hostId));
    for (const exit of await db.getTunnelExitNodes(tunnelId)) hosts.add(Number(exit.hostId));
    for (const groupId of [tunnel.entryGroupId, tunnel.exitGroupId].filter(Boolean)) {
      const group = await db.getForwardGroupById(Number(groupId));
      for (const member of group?.members || []) if (member.hostId) hosts.add(Number(member.hostId));
    }
  }
  // Do not clear tunnel readiness here; the normal reconciler applies the
  // changed rule without forcing unrelated tunnel endpoints to re-apply.
  for (const id of hosts) if (id > 0) pushAgentRefresh(id, "rule-limits-changed", { urgent: true });
}

export async function reconcileRuleLimits(ids?: number[], forceRefresh = false) {
  if (ids?.length === 0) return false;
  return withKeyedTaskLock("rule-limits-reconcile", async () => {
    const candidates = await getRuleLimitPolicies(ids);
    if (!forceRefresh && !candidates.some(rule => Number(rule.trafficLimit) > 0 || rule.expiresAt || rule.ruleLimitReason)) return false;
    // Keep first-time baseline initialization consistent with traffic reports.
    // Do not perform network/runtime notifications while holding a DB transaction.
    const changedPolicies = await withDatabaseTransaction(async () => {
      const policies = await getRuleLimitPolicies(ids);
      const reasons = await reasonsForPolicies(policies);
      const connection = await db.getDb();
      const refresh: any[] = [];
      const transitions: Array<{ id: number; reason: string | null }> = [];
      if (!connection) return { policies, refresh, transitions };
      for (const policy of policies) {
        const reason = reasons.get(Number(policy.id)) || null;
        const changed = (policy.ruleLimitReason || null) !== reason;
        if (changed) {
          await connection.update(forwardRules).set({ ruleLimitReason: reason }).where(eq(forwardRules.id, policy.id));
          transitions.push({ id: Number(policy.id), reason });
        }
        if (changed || forceRefresh) refresh.push(policy);
      }
      return { policies, refresh, transitions };
    });
    for (const transition of changedPolicies.transitions) console.info(`[RuleLimits] rule=${transition.id} state=${transition.reason || "available"}`);
    for (const policy of changedPolicies.refresh) await refreshRuleLimitAgents(policy);
    return changedPolicies.policies.some(policy => Number(policy.trafficLimit) > 0);
  });
}

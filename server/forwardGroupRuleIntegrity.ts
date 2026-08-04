import { eq } from "drizzle-orm";
import { forwardRules, forwardRuleTunnelExits, tunnels } from "../drizzle/schema";
import { boolValue, quoteIdentifier } from "./dbCompat";
import {
  executeRaw,
  getDb,
  nowDate,
  queryRaw,
  rawAffectedRows,
  withDatabaseTransaction,
} from "./dbRuntime";
import { recordConfigAuditEvent } from "./configAudit";
import { trafficBillingUserLockKey, withKeyedTaskLock } from "./keyedTaskLock";
import {
  getForwardRuleById,
  markOrphanedForwardGroupTemplatesPendingDelete,
} from "./repositories/forwardRuleRepository";
import {
  findTrafficBillingResourceForRule,
  settleTrafficBillingRuleOnDelete,
  trafficBillingResourceCandidatesForRule,
} from "./repositories/trafficBillingRepository";
import { setUserForwardAccess } from "./repositories/userRepository";

const REPAIR_BATCH_SIZE = 200;

type ManagedChildIntegrityRow = {
  ruleId: unknown;
  hostId: unknown;
  userId: unknown;
  tunnelId: unknown;
  groupId: unknown;
  parentRuleId: unknown;
  memberId: unknown;
  pendingDelete: unknown;
  isTemplate: unknown;
  groupExists: unknown;
  parentExists: unknown;
  parentGroupId: unknown;
  parentIsTemplate: unknown;
  parentPendingDelete: unknown;
  memberExists: unknown;
  memberGroupId: unknown;
};

type LegacyMemberRuleRow = {
  memberId: unknown;
  memberGroupId: unknown;
  memberHostId: unknown;
  memberType: unknown;
  memberTunnelId: unknown;
  ruleId: unknown;
  groupExists: unknown;
  groupName: unknown;
  groupUserId: unknown;
  groupForwardType: unknown;
  groupProtocol: unknown;
  groupSourcePort: unknown;
  groupTargetIp: unknown;
  groupTargetPort: unknown;
  tunnelExists: unknown;
  tunnelEntryHostId: unknown;
  ruleExists: unknown;
  ruleHostId: unknown;
  ruleName: unknown;
  ruleUserId: unknown;
  ruleForwardType: unknown;
  ruleProtocol: unknown;
  ruleGostMode: unknown;
  ruleTunnelId: unknown;
  ruleSourcePort: unknown;
  ruleTargetIp: unknown;
  ruleTargetPort: unknown;
  rulePendingDelete: unknown;
  ruleIsTemplate: unknown;
  ruleGroupId: unknown;
  ruleParentId: unknown;
  ruleMemberId: unknown;
};

export type ForwardGroupRuleIntegrityRepair = {
  orphanRules: number;
  legacyRules: number;
  legacyPointers: number;
  orphanTemplates: number;
};

function positiveId(value: unknown) {
  const id = Math.floor(Number(value || 0));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function databaseBoolean(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function isActiveManagedChild(row: ManagedChildIntegrityRow | undefined): row is ManagedChildIntegrityRow {
  return !!row
    && !databaseBoolean(row.pendingDelete)
    && !databaseBoolean(row.isTemplate)
    && (row.parentRuleId !== null && row.parentRuleId !== undefined
      || row.memberId !== null && row.memberId !== undefined);
}

function isValidManagedChild(row: ManagedChildIntegrityRow | undefined) {
  if (!isActiveManagedChild(row)) return false;
  const groupId = positiveId(row.groupId);
  const parentRuleId = positiveId(row.parentRuleId);
  const memberId = positiveId(row.memberId);
  return groupId > 0
    && positiveId(row.groupExists) === groupId
    && parentRuleId > 0
    && positiveId(row.parentExists) === parentRuleId
    && databaseBoolean(row.parentIsTemplate)
    && !databaseBoolean(row.parentPendingDelete)
    && positiveId(row.parentGroupId) === groupId
    && memberId > 0
    && positiveId(row.memberExists) === memberId
    && positiveId(row.memberGroupId) === groupId;
}

function normalizedText(value: unknown) {
  return String(value ?? "").trim();
}

function isDefiniteLegacyManagedRule(row: LegacyMemberRuleRow | undefined) {
  if (!row) return false;
  const groupId = positiveId(row.memberGroupId);
  const ruleId = positiveId(row.ruleId);
  if (
    groupId <= 0
    || positiveId(row.groupExists) !== groupId
    || ruleId <= 0
    || positiveId(row.ruleExists) !== ruleId
    || databaseBoolean(row.rulePendingDelete)
    || databaseBoolean(row.ruleIsTemplate)
    || positiveId(row.ruleGroupId) > 0
    || positiveId(row.ruleParentId) > 0
    || positiveId(row.ruleMemberId) > 0
    || positiveId(row.groupUserId) !== positiveId(row.ruleUserId)
    || normalizedText(row.ruleName) !== `[组] ${normalizedText(row.groupName)}`
    || normalizedText(row.ruleProtocol).toLowerCase() !== normalizedText(row.groupProtocol).toLowerCase()
    || Number(row.ruleSourcePort) !== Number(row.groupSourcePort)
    || normalizedText(row.ruleTargetIp) !== normalizedText(row.groupTargetIp)
    || Number(row.ruleTargetPort) !== Number(row.groupTargetPort)
    || normalizedText(row.ruleGostMode).toLowerCase() !== "direct"
  ) return false;

  const memberType = normalizedText(row.memberType).toLowerCase();
  if (memberType === "host") {
    return positiveId(row.memberHostId) > 0
      && positiveId(row.ruleHostId) === positiveId(row.memberHostId)
      && positiveId(row.ruleTunnelId) === 0
      && normalizedText(row.ruleForwardType).toLowerCase() === normalizedText(row.groupForwardType).toLowerCase();
  }
  if (memberType === "tunnel") {
    const tunnelId = positiveId(row.memberTunnelId);
    return tunnelId > 0
      && positiveId(row.tunnelExists) === tunnelId
      && positiveId(row.ruleTunnelId) === tunnelId
      && positiveId(row.ruleHostId) === positiveId(row.tunnelEntryHostId)
      && normalizedText(row.ruleForwardType).toLowerCase() === "gost";
  }
  return false;
}

async function withForwardGroupLocks<T>(groupIds: unknown[], work: () => Promise<T>): Promise<T> {
  const ids = Array.from(new Set(groupIds.map(positiveId).filter((id) => id > 0))).sort((a, b) => a - b);
  const run = (index: number): Promise<T> => index >= ids.length
    ? work()
    : withKeyedTaskLock(`forward-group-sync:${ids[index]}`, () => run(index + 1));
  return run(0);
}

async function managedChildIntegrity(ruleId: number) {
  const q = quoteIdentifier;
  const rows = await queryRaw<ManagedChildIntegrityRow>(
    `SELECT
        r.${q("id")} AS ${q("ruleId")},
        r.${q("hostId")} AS ${q("hostId")},
        r.${q("userId")} AS ${q("userId")},
        r.${q("tunnelId")} AS ${q("tunnelId")},
        r.${q("forwardGroupId")} AS ${q("groupId")},
        r.${q("forwardGroupRuleId")} AS ${q("parentRuleId")},
        r.${q("forwardGroupMemberId")} AS ${q("memberId")},
        r.${q("pendingDelete")} AS ${q("pendingDelete")},
        r.${q("isForwardGroupTemplate")} AS ${q("isTemplate")},
        g.${q("id")} AS ${q("groupExists")},
        p.${q("id")} AS ${q("parentExists")},
        p.${q("forwardGroupId")} AS ${q("parentGroupId")},
        p.${q("isForwardGroupTemplate")} AS ${q("parentIsTemplate")},
        p.${q("pendingDelete")} AS ${q("parentPendingDelete")},
        m.${q("id")} AS ${q("memberExists")},
        m.${q("groupId")} AS ${q("memberGroupId")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = r.${q("forwardGroupId")}
       LEFT JOIN ${q("forward_rules")} p ON p.${q("id")} = r.${q("forwardGroupRuleId")}
       LEFT JOIN ${q("forward_group_members")} m ON m.${q("id")} = r.${q("forwardGroupMemberId")}
      WHERE r.${q("id")} = ?
      LIMIT 1`,
    [ruleId],
  );
  return rows[0];
}

async function refreshRetiredRuleEndpoints(rule: any, reason: string) {
  const { pushAgentRefresh } = await import("./agentEvents");
  const hostId = positiveId(rule?.hostId);
  if (hostId > 0) pushAgentRefresh(hostId, reason, { urgent: true });
  const tunnelId = positiveId(rule?.tunnelId);
  if (tunnelId <= 0) return;
  const db = await getDb();
  if (!db) return;
  const tunnelRows = await db
    .select({ entryHostId: tunnels.entryHostId, exitHostId: tunnels.exitHostId })
    .from(tunnels)
    .where(eq(tunnels.id, tunnelId))
    .limit(1);
  const tunnel = tunnelRows[0];
  for (const endpointHostId of new Set([positiveId(tunnel?.entryHostId), positiveId(tunnel?.exitHostId)])) {
    if (endpointHostId > 0) pushAgentRefresh(endpointHostId, `${reason}-tunnel`, { urgent: true });
  }
}

async function refreshUserRuleEndpoints(userId: number, reason: string) {
  const db = await getDb();
  if (!db || userId <= 0) return;
  const { pushAgentRefresh } = await import("./agentEvents");
  const rules = await db
    .select({ hostId: forwardRules.hostId, tunnelId: forwardRules.tunnelId })
    .from(forwardRules)
    .where(eq(forwardRules.userId, userId));
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules) {
    const hostId = positiveId(rule.hostId);
    const tunnelId = positiveId(rule.tunnelId);
    if (hostId > 0) hostIds.add(hostId);
    if (tunnelId > 0) tunnelIds.add(tunnelId);
  }
  for (const hostId of hostIds) pushAgentRefresh(hostId, reason, { urgent: true });
  for (const tunnelId of tunnelIds) {
    const tunnelRows = await db
      .select({ entryHostId: tunnels.entryHostId, exitHostId: tunnels.exitHostId })
      .from(tunnels)
      .where(eq(tunnels.id, tunnelId))
      .limit(1);
    const tunnel = tunnelRows[0];
    for (const endpointHostId of new Set([positiveId(tunnel?.entryHostId), positiveId(tunnel?.exitHostId)])) {
      if (endpointHostId > 0) pushAgentRefresh(endpointHostId, `${reason}-tunnel`, { urgent: true });
    }
  }
}

async function retireRuleIf(
  ruleId: number,
  stillManagedAndInvalid: () => Promise<boolean>,
  source: string,
) {
  return withKeyedTaskLock(`rule:${ruleId}`, async () => {
    const preview = await getForwardRuleById(ruleId);
    if (!preview || databaseBoolean((preview as any).pendingDelete) || !(await stillManagedAndInvalid())) return false;

    let before: any = null;
    let billed: any = null;
    let claimed = false;
    await withKeyedTaskLock(trafficBillingUserLockKey((preview as any).userId), async () => {
      await withDatabaseTransaction(async () => {
        const current = await getForwardRuleById(ruleId);
        if (!current || databaseBoolean((current as any).pendingDelete) || !(await stillManagedAndInvalid())) return;
        before = current;
        const billingResource = await findTrafficBillingResourceForRule(current);
        const resource = billingResource || trafficBillingResourceCandidatesForRule(current)[0] || null;
        billed = resource
          ? await settleTrafficBillingRuleOnDelete({
            userId: positiveId((current as any).userId),
            ruleId,
            resourceType: resource.resourceType,
            resourceId: positiveId(resource.resourceId),
          })
          : null;

        const q = quoteIdentifier;
        const result = await executeRaw(
          `UPDATE ${q("forward_rules")}
              SET ${q("isEnabled")} = ?,
                  ${q("isRunning")} = ?,
                  ${q("pendingDelete")} = ?,
                  ${q("updatedAt")} = ?
            WHERE ${q("id")} = ?
              AND ${q("pendingDelete")} = ?
              AND ${q("updatedAt")} = ?`,
          [
            boolValue(false),
            boolValue(true),
            boolValue(true),
            nowDate(),
            ruleId,
            boolValue(false),
            (current as any).updatedAt,
          ],
        );
        if (rawAffectedRows(result) <= 0) return;
        const db = await getDb();
        if (!db) return;
        await db.delete(forwardRuleTunnelExits).where(eq(forwardRuleTunnelExits.ruleId, ruleId));
        claimed = true;
      });
    });

    if (!claimed || !before) return false;
    await recordConfigAuditEvent({
      resourceType: "forward_rule",
      resourceId: ruleId,
      hostId: positiveId(before.hostId) || null,
      action: "delete",
      before,
      source,
    });
    if (billed && Number(billed.balanceAfterCents) < 0) {
      const userId = positiveId(before.userId);
      await setUserForwardAccess(userId, false, "traffic_billing_balance");
      await refreshUserRuleEndpoints(userId, `${source}-balance-negative`);
    }
    await refreshRetiredRuleEndpoints(before, source);
    return true;
  });
}

async function managedChildCandidates(afterId: number, hostId?: number) {
  const q = quoteIdentifier;
  const scopedHostId = positiveId(hostId);
  const hostSql = scopedHostId > 0
    ? ` AND (r.${q("hostId")} = ? OR p.${q("hostId")} = ?)`
    : "";
  return queryRaw<ManagedChildIntegrityRow>(
    `SELECT
        r.${q("id")} AS ${q("ruleId")},
        r.${q("hostId")} AS ${q("hostId")},
        r.${q("forwardGroupId")} AS ${q("groupId")},
        r.${q("forwardGroupRuleId")} AS ${q("parentRuleId")},
        r.${q("forwardGroupMemberId")} AS ${q("memberId")},
        p.${q("forwardGroupId")} AS ${q("parentGroupId")}
       FROM ${q("forward_rules")} r
       LEFT JOIN ${q("forward_rules")} p ON p.${q("id")} = r.${q("forwardGroupRuleId")}
      WHERE r.${q("id")} > ?
        AND r.${q("pendingDelete")} = ?
        AND r.${q("isForwardGroupTemplate")} = ?
        AND (r.${q("forwardGroupRuleId")} IS NOT NULL OR r.${q("forwardGroupMemberId")} IS NOT NULL)
        ${hostSql}
      ORDER BY r.${q("id")} ASC
      LIMIT ${REPAIR_BATCH_SIZE}`,
    [afterId, boolValue(false), boolValue(false), ...(scopedHostId > 0 ? [scopedHostId, scopedHostId] : [])],
  );
}

async function repairOrphanManagedChildren(hostId?: number) {
  let repaired = 0;
  let afterId = 0;
  while (true) {
    const rows = await managedChildCandidates(afterId, hostId);
    if (rows.length === 0) break;
    for (const row of rows) {
      const ruleId = positiveId(row.ruleId);
      afterId = Math.max(afterId, ruleId);
      if (ruleId <= 0) continue;
      const groupIds = [row.groupId, row.parentGroupId];
      const retired = await withForwardGroupLocks(groupIds, () => retireRuleIf(
        ruleId,
        async () => {
          const current = await managedChildIntegrity(ruleId);
          return isActiveManagedChild(current) && !isValidManagedChild(current);
        },
        "forward-group-integrity-repair",
      ));
      if (retired) repaired += 1;
    }
    if (rows.length < REPAIR_BATCH_SIZE) break;
  }
  return repaired;
}

async function legacyMemberRuleCandidates(afterId: number, hostId?: number) {
  const q = quoteIdentifier;
  const scopedHostId = positiveId(hostId);
  const hostSql = scopedHostId > 0
    ? ` AND (m.${q("hostId")} = ? OR r.${q("hostId")} = ?)`
    : "";
  const params = [afterId, ...(scopedHostId > 0 ? [scopedHostId, scopedHostId] : [])];
  const probe = await queryRaw<{ memberId: unknown }>(
    `SELECT m.${q("id")} AS ${q("memberId")}
       FROM ${q("forward_group_members")} m
       LEFT JOIN ${q("forward_rules")} r ON r.${q("id")} = m.${q("ruleId")}
      WHERE m.${q("id")} > ?
        AND m.${q("ruleId")} IS NOT NULL
        ${hostSql}
      ORDER BY m.${q("id")} ASC
      LIMIT 1`,
    params,
  );
  if (probe.length === 0) return [];
  return queryRaw<LegacyMemberRuleRow>(
    `SELECT
        m.${q("id")} AS ${q("memberId")},
        m.${q("groupId")} AS ${q("memberGroupId")},
        m.${q("hostId")} AS ${q("memberHostId")},
        m.${q("memberType")} AS ${q("memberType")},
        m.${q("tunnelId")} AS ${q("memberTunnelId")},
        m.${q("ruleId")} AS ${q("ruleId")},
        g.${q("id")} AS ${q("groupExists")},
        g.${q("name")} AS ${q("groupName")},
        g.${q("userId")} AS ${q("groupUserId")},
        g.${q("forwardType")} AS ${q("groupForwardType")},
        g.${q("protocol")} AS ${q("groupProtocol")},
        g.${q("sourcePort")} AS ${q("groupSourcePort")},
        g.${q("targetIp")} AS ${q("groupTargetIp")},
        g.${q("targetPort")} AS ${q("groupTargetPort")},
        t.${q("id")} AS ${q("tunnelExists")},
        t.${q("entryHostId")} AS ${q("tunnelEntryHostId")},
        r.${q("id")} AS ${q("ruleExists")},
        r.${q("hostId")} AS ${q("ruleHostId")},
        r.${q("name")} AS ${q("ruleName")},
        r.${q("userId")} AS ${q("ruleUserId")},
        r.${q("forwardType")} AS ${q("ruleForwardType")},
        r.${q("protocol")} AS ${q("ruleProtocol")},
        r.${q("gostMode")} AS ${q("ruleGostMode")},
        r.${q("tunnelId")} AS ${q("ruleTunnelId")},
        r.${q("sourcePort")} AS ${q("ruleSourcePort")},
        r.${q("targetIp")} AS ${q("ruleTargetIp")},
        r.${q("targetPort")} AS ${q("ruleTargetPort")},
        r.${q("pendingDelete")} AS ${q("rulePendingDelete")},
        r.${q("isForwardGroupTemplate")} AS ${q("ruleIsTemplate")},
        r.${q("forwardGroupId")} AS ${q("ruleGroupId")},
        r.${q("forwardGroupRuleId")} AS ${q("ruleParentId")},
        r.${q("forwardGroupMemberId")} AS ${q("ruleMemberId")}
       FROM ${q("forward_group_members")} m
       LEFT JOIN ${q("forward_groups")} g ON g.${q("id")} = m.${q("groupId")}
       LEFT JOIN ${q("tunnels")} t ON t.${q("id")} = m.${q("tunnelId")}
       LEFT JOIN ${q("forward_rules")} r ON r.${q("id")} = m.${q("ruleId")}
      WHERE m.${q("id")} > ?
        AND m.${q("ruleId")} IS NOT NULL
        ${hostSql}
      ORDER BY m.${q("id")} ASC
      LIMIT ${REPAIR_BATCH_SIZE}`,
    params,
  );
}

async function legacyMemberRuleIntegrity(memberId: number, ruleId: number) {
  const rows = await legacyMemberRuleCandidates(Math.max(0, memberId - 1));
  return rows.find((row) => positiveId(row.memberId) === memberId && Number(row.ruleId) === ruleId);
}

async function clearLegacyMemberRulePointer(memberId: number, ruleId: number) {
  const q = quoteIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("forward_group_members")}
        SET ${q("ruleId")} = NULL, ${q("updatedAt")} = ?
      WHERE ${q("id")} = ? AND ${q("ruleId")} = ?`,
    [nowDate(), memberId, ruleId],
  );
  return rawAffectedRows(result) > 0;
}

async function repairLegacyMemberRuleReferences(hostId?: number) {
  let rules = 0;
  let pointers = 0;
  let afterId = 0;
  while (true) {
    const rows = await legacyMemberRuleCandidates(afterId, hostId);
    if (rows.length === 0) break;
    for (const row of rows) {
      const memberId = positiveId(row.memberId);
      const storedRuleId = Math.trunc(Number(row.ruleId));
      const ruleId = positiveId(storedRuleId);
      afterId = Math.max(afterId, memberId);
      if (memberId <= 0 || !Number.isFinite(storedRuleId)) continue;
      const current = ruleId > 0 ? await legacyMemberRuleIntegrity(memberId, storedRuleId) : undefined;
      if (ruleId > 0 && isDefiniteLegacyManagedRule(current)) {
        const retired = await retireRuleIf(
          ruleId,
          async () => isDefiniteLegacyManagedRule(await legacyMemberRuleIntegrity(memberId, storedRuleId)),
          "legacy-forward-group-member-repair",
        );
        if (retired) rules += 1;
      }
      if (await clearLegacyMemberRulePointer(memberId, storedRuleId)) pointers += 1;
    }
    if (rows.length < REPAIR_BATCH_SIZE) break;
  }
  return { rules, pointers };
}

/**
 * Repairs only relationships that cannot be produced by the current forward-group model.
 * Rules remain pending until their Agent confirms that the listener has stopped.
 */
export async function repairForwardGroupRuleIntegrity(hostId?: number): Promise<ForwardGroupRuleIntegrityRepair> {
  const orphanRules = await repairOrphanManagedChildren(hostId);
  const legacy = await repairLegacyMemberRuleReferences(hostId);
  const orphanTemplates = await markOrphanedForwardGroupTemplatesPendingDelete(positiveId(hostId) || undefined);
  return {
    orphanRules,
    legacyRules: legacy.rules,
    legacyPointers: legacy.pointers,
    orphanTemplates,
  };
}

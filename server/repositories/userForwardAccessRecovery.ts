import { and, eq, inArray } from "drizzle-orm";
import { forwardGroupMembers, forwardGroups, forwardRules } from "../../drizzle/schema";
import { pushAgentRefresh } from "../agentEvents";
import { afterDatabaseCommit, getDb, nowDate } from "../dbRuntime";
import { keyedTaskDepth, trafficBillingUserLockKey, withKeyedTaskLock } from "../keyedTaskLock";
import { getForwardRulesForUserSync } from "./forwardRuleRepository";
import { runForwardGroupFailover, syncForwardGroupRules } from "./forwardGroupRepository";
import { getTunnelById, getTunnelExitNodes, getTunnelHops, updateTunnel } from "./tunnelRepository";
import { getUserById, type ForwardAccessPauseReason } from "./userRepository";

type RuntimeGroupState = {
  isEnabled: boolean;
  groupMode: string;
  entryGroupId: number | null;
};

export type UserForwardRuleRecoveryResult = {
  clearedRuleIds: number[];
  enabledRuleIds: number[];
  refreshedHostIds: number[];
};

const queuedRecoveryUsers = new Set<number>();

function enabled(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function normalizedPauseReason(value: unknown): ForwardAccessPauseReason | null {
  const reason = String(value || "").trim();
  return reason ? reason as ForwardAccessPauseReason : null;
}

function userAllowsRuleRecovery(user: any) {
  return !!user
    && enabled(user.accountEnabled)
    && enabled(user.canAddRules)
    && !normalizedPauseReason(user.forwardAccessPauseReason);
}

async function runtimeGroupState(groupId: number, cache: Map<number, RuntimeGroupState | null>) {
  if (cache.has(groupId)) return cache.get(groupId) ?? null;
  const db = await getDb();
  if (!db || groupId <= 0) return null;
  const row = (await db.select({
    isEnabled: forwardGroups.isEnabled,
    groupMode: forwardGroups.groupMode,
    entryGroupId: forwardGroups.entryGroupId,
  }).from(forwardGroups).where(eq(forwardGroups.id, groupId)).limit(1))[0] as any;
  const state = row ? {
    isEnabled: enabled(row.isEnabled),
    groupMode: String(row.groupMode || "").toLowerCase(),
    entryGroupId: Number(row.entryGroupId || 0) || null,
  } : null;
  cache.set(groupId, state);
  return state;
}

async function groupAllowsRuntime(
  groupId: number,
  cache: Map<number, RuntimeGroupState | null>,
  expectedMode?: "entry" | "exit",
) {
  const group = await runtimeGroupState(groupId, cache);
  if (!group?.isEnabled || (expectedMode && group.groupMode !== expectedMode)) return false;
  if (group.groupMode !== "chain" || !group.entryGroupId) return true;
  return groupAllowsRuntime(group.entryGroupId, cache, "entry");
}

async function addEndpointGroupHostIds(
  groupId: number,
  expectedMode: "entry" | "exit",
  groupCache: Map<number, RuntimeGroupState | null>,
  hostIds: Set<number>,
) {
  const group = await runtimeGroupState(groupId, groupCache);
  if (!group?.isEnabled || group.groupMode !== expectedMode) return;
  const db = await getDb();
  if (!db) return;
  const members = await db.select({ hostId: forwardGroupMembers.hostId })
    .from(forwardGroupMembers)
    .where(and(
      eq(forwardGroupMembers.groupId, groupId),
      eq(forwardGroupMembers.memberType, "host"),
      eq(forwardGroupMembers.isEnabled, true),
    ));
  for (const member of members as any[]) {
    const hostId = Number(member.hostId || 0);
    if (hostId > 0) hostIds.add(hostId);
  }
}

async function ruleRuntimeControlState(rule: any, groupCache: Map<number, RuntimeGroupState | null>) {
  let blockedByGroup = enabled(rule.disabledByGroup);
  let blockedByTunnel = enabled(rule.disabledByTunnel);
  const groupId = Number(rule.forwardGroupId || 0);
  if (groupId > 0 && !(await groupAllowsRuntime(groupId, groupCache))) blockedByGroup = true;

  const tunnelId = Number(rule.tunnelId || 0);
  if (tunnelId > 0) {
    const tunnel = await getTunnelById(tunnelId) as any;
    if (!tunnel || !enabled(tunnel.isEnabled) || enabled(tunnel.disabledByGroup)) {
      blockedByTunnel = true;
    } else {
      const entryGroupId = Number(tunnel.entryGroupId || 0);
      const exitGroupId = Number(tunnel.exitGroupId || 0);
      if (entryGroupId > 0 && !(await groupAllowsRuntime(entryGroupId, groupCache, "entry"))) blockedByTunnel = true;
      if (exitGroupId > 0 && !(await groupAllowsRuntime(exitGroupId, groupCache, "exit"))) blockedByTunnel = true;
    }
  }
  return {
    blockedByGroup,
    blockedByTunnel,
    canEnable: !blockedByGroup && !blockedByTunnel && !String(rule.protocolBlockReason || "").trim(),
  };
}

export async function getUserForwardRuleIdsDisabledByAccess(userId: number) {
  const db = await getDb();
  if (!db || userId <= 0) return [];
  const rows = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.disabledByUser, true),
    eq(forwardRules.pendingDelete, false),
  ));
  return rows.map((row: any) => Number(row.id || 0)).filter((id: number) => id > 0);
}

export async function hasUserForwardRulesDisabledByAccess(userId: number) {
  return (await getUserForwardRuleIdsDisabledByAccess(userId)).length > 0;
}

/** Restore only rules that were running when account eligibility paused them. */
export async function restoreUserForwardRulesAfterAccessRecovery(userId: number): Promise<UserForwardRuleRecoveryResult> {
  const empty = { clearedRuleIds: [], enabledRuleIds: [], refreshedHostIds: [] };
  const db = await getDb();
  if (!db || userId <= 0) return empty;

  const user = await getUserById(userId) as any;
  if (!userAllowsRuleRecovery(user)) return empty;

  const pausedRules = await db.select().from(forwardRules).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.disabledByUser, true),
    eq(forwardRules.pendingDelete, false),
  )) as any[];
  if (pausedRules.length === 0) return empty;

  const clearedRuleIds = pausedRules.map((rule) => Number(rule.id)).filter((id) => id > 0);
  const now = nowDate();
  await db.update(forwardRules).set({
    disabledByUser: false,
    isRunning: false,
    updatedAt: now,
  } as any).where(and(
    eq(forwardRules.userId, userId),
    eq(forwardRules.disabledByUser, true),
    eq(forwardRules.pendingDelete, false),
  ));

  const groupCache = new Map<number, RuntimeGroupState | null>();
  const enabledRuleIds: number[] = [];
  const affectedGroupIds = new Set<number>();
  for (const rule of pausedRules) {
    const groupId = Number(rule.forwardGroupId || 0);
    if (groupId > 0) affectedGroupIds.add(groupId);
    const control = await ruleRuntimeControlState(rule, groupCache);
    if (control.blockedByGroup || control.blockedByTunnel) {
      await db.update(forwardRules).set({
        isEnabled: false,
        isRunning: false,
        disabledByGroup: control.blockedByGroup,
        disabledByTunnel: control.blockedByTunnel,
        updatedAt: nowDate(),
      } as any).where(eq(forwardRules.id, Number(rule.id)));
    }
    // Managed children derive their state from the visible template during the
    // group sync below; enabling them directly can bypass a disabled member.
    if (Number(rule.forwardGroupRuleId || 0) > 0) continue;
    if (!control.canEnable) continue;
    await db.update(forwardRules).set({
      isEnabled: true,
      isRunning: false,
      updatedAt: nowDate(),
    } as any).where(and(
      eq(forwardRules.id, Number(rule.id)),
      eq(forwardRules.pendingDelete, false),
      eq(forwardRules.disabledByUser, false),
    ));
    enabledRuleIds.push(Number(rule.id));
  }

  // If access was paused again while this recovery pass was preparing rules,
  // restore the blocker before any Agent is notified.
  if (!userAllowsRuleRecovery(await getUserById(userId))) {
    await db.update(forwardRules).set({
      isEnabled: false,
      isRunning: false,
      disabledByUser: true,
      updatedAt: nowDate(),
    } as any).where(inArray(forwardRules.id, clearedRuleIds));
    return empty;
  }

  for (const groupId of affectedGroupIds) {
    try {
      await syncForwardGroupRules(groupId);
      await runForwardGroupFailover(groupId);
    } catch (error) {
      console.warn(`[ForwardAccess] group restore sync failed user=${userId} group=${groupId}:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (!userAllowsRuleRecovery(await getUserById(userId))) {
    await db.update(forwardRules).set({
      isEnabled: false,
      isRunning: false,
      disabledByUser: true,
      updatedAt: nowDate(),
    } as any).where(inArray(forwardRules.id, clearedRuleIds));
    return empty;
  }

  const affectedRuleIds = new Set(clearedRuleIds);
  const runtimeRules = (await getForwardRulesForUserSync(userId) as any[]).filter((rule) => (
    enabled(rule.isEnabled)
    && (affectedRuleIds.has(Number(rule.id)) || affectedGroupIds.has(Number(rule.forwardGroupId || 0)))
  ));
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of runtimeRules) {
    const hostId = Number(rule.hostId || 0);
    const tunnelId = Number(rule.tunnelId || 0);
    if (hostId > 0) hostIds.add(hostId);
    if (tunnelId > 0) tunnelIds.add(tunnelId);
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await getTunnelById(tunnelId) as any;
    if (!tunnel) continue;
    await updateTunnel(tunnelId, { isRunning: false } as any);
    for (const hostId of [Number(tunnel.entryHostId), Number(tunnel.exitHostId)]) {
      if (hostId > 0) hostIds.add(hostId);
    }
    for (const hop of await getTunnelHops(tunnelId) as any[]) {
      const hostId = Number(hop.hostId || 0);
      if (hostId > 0) hostIds.add(hostId);
    }
    for (const exit of await getTunnelExitNodes(tunnelId) as any[]) {
      const hostId = Number(exit.hostId || 0);
      if (hostId > 0) hostIds.add(hostId);
    }
    await addEndpointGroupHostIds(Number(tunnel.entryGroupId || 0), "entry", groupCache, hostIds);
    await addEndpointGroupHostIds(Number(tunnel.exitGroupId || 0), "exit", groupCache, hostIds);
  }
  for (const hostId of hostIds) {
    pushAgentRefresh(hostId, "user-forward-access-restored", { urgent: true });
  }
  return {
    clearedRuleIds,
    enabledRuleIds,
    refreshedHostIds: Array.from(hostIds),
  };
}

export async function scheduleUserForwardRulesAfterAccessRecovery(
  userId: number,
): Promise<UserForwardRuleRecoveryResult | null> {
  let result: UserForwardRuleRecoveryResult | null = null;
  const run = async () => {
    try {
      return await restoreUserForwardRulesAfterAccessRecovery(userId);
    } catch (error) {
      // Access/payment state may already be committed. Keep that operation
      // successful and let a later recovery pass retry rule sync.
      console.warn(`[ForwardAccess] rule restore failed user=${userId}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  await afterDatabaseCommit(async () => {
    const lockKey = trafficBillingUserLockKey(userId);
    if (keyedTaskDepth(lockKey) === 0) {
      result = await run();
      return;
    }
    if (queuedRecoveryUsers.has(userId)) return;
    queuedRecoveryUsers.add(userId);
    // Queue behind the active billing operation without polling. The callback
    // must not await this task because the current keyed task cannot release
    // until its transaction's after-commit callbacks have returned.
    void withKeyedTaskLock(lockKey, run)
      .finally(() => queuedRecoveryUsers.delete(userId));
  });
  return result as UserForwardRuleRecoveryResult | null;
}

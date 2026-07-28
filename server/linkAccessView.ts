import { eq, inArray } from "drizzle-orm";
import {
  forwardGroups,
  forwardGroupMembers,
  hosts,
  tunnelExitNodes,
  tunnelHops,
  tunnels,
  users,
  userForwardGroupPermissions,
  userHostPermissions,
  userTunnelPermissions,
} from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { createQueryCache } from "./queryCache";
import { getActiveUserSubscriptions } from "./repositories/billingRepository";
import {
  getTrafficBillingAccessSnapshot,
} from "./repositories/trafficBillingRepository";

export type LinkAccessScope = {
  hostIds: Set<number>;
  tunnelIds: Set<number>;
  groupIds: Set<number>;
  /** Resources that may be selected as the root resource of a rule. */
  useHostIds?: Set<number>;
  useTunnelIds?: Set<number>;
  useGroupIds?: Set<number>;
  /** Resources exposed only while rendering an explicitly authorized group. */
  groupHostIds?: Map<number, Set<number>>;
  groupTunnelIds?: Map<number, Set<number>>;
};

type LinkAccessClosureInput = {
  hostIds?: Iterable<unknown>;
  tunnelIds?: Iterable<unknown>;
  groupIds?: Iterable<unknown>;
  groups?: Iterable<any>;
  members?: Iterable<any>;
  tunnels?: Iterable<any>;
  tunnelHops?: Iterable<any>;
  tunnelExitNodes?: Iterable<any>;
};

const linkAccessQueryCache = createQueryCache(500);
let lastLinkAccessWarningAt = 0;

function warnLinkAccessLookupFailure(error: unknown) {
  const now = Date.now();
  if (now - lastLinkAccessWarningAt < 60_000) return;
  lastLinkAccessWarningAt = now;
  console.warn("[LinkAccess] optional access lookup failed; direct user-owned resources remain available:", error instanceof Error ? error.message : String(error));
}

function positiveId(value: unknown) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function dbBool(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || value === "1" || String(value).trim().toLowerCase() === "true";
}

/**
 * Expand resource ACLs to the topology needed to render and use shared links.
 * A forward group is a complete resource: its enabled members (and a chain's
 * entry group) must be visible even when the user was not separately granted
 * each underlying host or tunnel. The expanded member IDs stay in a
 * group-specific scope so granting a group does not grant standalone access
 * to every host or tunnel referenced by that group.
 */
export function expandLinkAccessScope(input: LinkAccessClosureInput): LinkAccessScope {
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  const groupIds = new Set<number>();
  const groupHostIds = new Map<number, Set<number>>();
  const groupTunnelIds = new Map<number, Set<number>>();
  for (const value of input.hostIds || []) {
    const id = positiveId(value);
    if (id > 0) hostIds.add(id);
  }
  for (const value of input.tunnelIds || []) {
    const id = positiveId(value);
    if (id > 0) tunnelIds.add(id);
  }
  const directTunnelIds = new Set(tunnelIds);
  for (const value of input.groupIds || []) {
    const id = positiveId(value);
    if (id > 0) groupIds.add(id);
  }
  const useHostIds = new Set(hostIds);
  const useTunnelIds = new Set(tunnelIds);
  const useGroupIds = new Set(groupIds);

  const groupsById = new Map<number, any>();
  for (const group of input.groups || []) {
    const id = positiveId(group?.id);
    if (id > 0) groupsById.set(id, group);
  }
  const membersByGroupId = new Map<number, any[]>();
  for (const member of input.members || []) {
    const groupId = positiveId(member?.groupId);
    if (groupId <= 0) continue;
    const members = membersByGroupId.get(groupId) || [];
    members.push(member);
    membersByGroupId.set(groupId, members);
  }
  const tunnelsById = new Map<number, any>();
  for (const tunnel of input.tunnels || []) {
    const id = positiveId(tunnel?.id);
    if (id > 0) tunnelsById.set(id, tunnel);
  }
  const tunnelHostIdsByTunnel = new Map<number, Set<number>>();
  const addTunnelHost = (tunnelId: unknown, hostId: unknown) => {
    const tunnel = positiveId(tunnelId);
    const host = positiveId(hostId);
    if (tunnel <= 0 || host <= 0) return;
    const ids = tunnelHostIdsByTunnel.get(tunnel) || new Set<number>();
    ids.add(host);
    tunnelHostIdsByTunnel.set(tunnel, ids);
  };
  for (const tunnel of tunnelsById.values()) {
    addTunnelHost(tunnel.id, tunnel.entryHostId);
    addTunnelHost(tunnel.id, tunnel.exitHostId);
  }
  for (const hop of input.tunnelHops || []) addTunnelHost(hop?.tunnelId, hop?.hostId);
  for (const exit of input.tunnelExitNodes || []) {
    if (exit?.isEnabled !== undefined && !dbBool(exit.isEnabled, true)) continue;
    addTunnelHost(exit?.tunnelId, exit?.hostId);
  }

  const pendingGroups = Array.from(groupIds);
  const pendingTunnels = Array.from(tunnelIds);
  const visitedGroups = new Set<number>();
  const visitedTunnels = new Set<number>();
  let groupIndex = 0;
  let tunnelIndex = 0;
  // Resolve the topology as a fixed point. Group chains can point at other
  // groups, while a tunnel can point back to entry/exit groups.
  while (groupIndex < pendingGroups.length || tunnelIndex < pendingTunnels.length) {
    while (groupIndex < pendingGroups.length) {
      const groupId = positiveId(pendingGroups[groupIndex]);
      groupIndex += 1;
      if (groupId <= 0 || visitedGroups.has(groupId)) continue;
      visitedGroups.add(groupId);
      const groupHostScope = groupHostIds.get(groupId) || new Set<number>();
      const groupTunnelScope = groupTunnelIds.get(groupId) || new Set<number>();
      groupHostIds.set(groupId, groupHostScope);
      groupTunnelIds.set(groupId, groupTunnelScope);
      const group = groupsById.get(groupId);
      const entryGroupId = positiveId(group?.entryGroupId);
      if (entryGroupId > 0 && !groupIds.has(entryGroupId)) {
        groupIds.add(entryGroupId);
        pendingGroups.push(entryGroupId);
      }
      for (const member of membersByGroupId.get(groupId) || []) {
        if (member?.isEnabled !== undefined && !dbBool(member.isEnabled, true)) continue;
        if (member?.memberType === "tunnel") {
          const tunnelId = positiveId(member?.tunnelId);
          if (tunnelId <= 0 || !tunnelsById.has(tunnelId)) continue;
          groupTunnelScope.add(tunnelId);
          if (!visitedTunnels.has(tunnelId)) pendingTunnels.push(tunnelId);
          for (const hostId of tunnelHostIdsByTunnel.get(tunnelId) || []) groupHostScope.add(hostId);
        } else {
          const hostId = positiveId(member?.hostId);
          if (hostId > 0) groupHostScope.add(hostId);
        }
      }
    }
    while (tunnelIndex < pendingTunnels.length) {
      const tunnelId = positiveId(pendingTunnels[tunnelIndex]);
      tunnelIndex += 1;
      if (tunnelId <= 0 || visitedTunnels.has(tunnelId)) continue;
      visitedTunnels.add(tunnelId);
      if (directTunnelIds.has(tunnelId)) {
        for (const hostId of tunnelHostIdsByTunnel.get(tunnelId) || []) hostIds.add(hostId);
      }
      const tunnel = tunnelsById.get(tunnelId);
      for (const relatedGroupId of [tunnel?.entryGroupId, tunnel?.exitGroupId]) {
        const groupId = positiveId(relatedGroupId);
        if (groupId <= 0 || groupIds.has(groupId)) continue;
        groupIds.add(groupId);
        pendingGroups.push(groupId);
      }
    }
  }
  return {
    hostIds,
    tunnelIds,
    groupIds,
    useHostIds,
    useTunnelIds,
    useGroupIds,
    groupHostIds,
    groupTunnelIds,
  };
}

async function loadLinkAccessScope(userId: number): Promise<LinkAccessScope> {
  const db = await getDb();
  if (!db) return { hostIds: new Set(), tunnelIds: new Set(), groupIds: new Set(), groupHostIds: new Map(), groupTunnelIds: new Map() };
  const safe = <T>(task: Promise<T>, fallback: T) => task.catch((error) => {
    warnLinkAccessLookupFailure(error);
    return fallback;
  });
  const tracked = async <T>(task: Promise<T>, fallback: T) => {
    try {
      return { ok: true as const, value: await task };
    } catch (error) {
      warnLinkAccessLookupFailure(error);
      return { ok: false as const, value: fallback };
    }
  };
  const [ownedHosts, ownedTunnels, ownedForwardGroups, hostPermissions, tunnelPermissions, groupPermissions, subscriptions, billingSnapshot, topologyGroupsResult, topologyMembersResult, topologyTunnels, topologyHops, topologyExits] = await Promise.all([
    safe(db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, userId)), []),
    safe(db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.userId, userId)), []),
    safe(db.select({ id: forwardGroups.id }).from(forwardGroups).where(eq(forwardGroups.userId, userId)), []),
    safe(db.select({ id: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId)), []),
    safe(db.select({ id: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId)), []),
    safe(db.select({ id: userForwardGroupPermissions.forwardGroupId }).from(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.userId, userId)), []),
    safe(getActiveUserSubscriptions(userId), []),
    getTrafficBillingAccessSnapshot(userId),
    tracked(db.select({ id: forwardGroups.id, entryGroupId: forwardGroups.entryGroupId }).from(forwardGroups), []),
    tracked(db.select({ groupId: forwardGroupMembers.groupId, memberType: forwardGroupMembers.memberType, hostId: forwardGroupMembers.hostId, tunnelId: forwardGroupMembers.tunnelId, isEnabled: forwardGroupMembers.isEnabled }).from(forwardGroupMembers), []),
    safe(db.select({ id: tunnels.id, entryHostId: tunnels.entryHostId, exitHostId: tunnels.exitHostId, entryGroupId: tunnels.entryGroupId, exitGroupId: tunnels.exitGroupId }).from(tunnels), []),
    safe(db.select({ tunnelId: tunnelHops.tunnelId, hostId: tunnelHops.hostId }).from(tunnelHops), []),
    safe(db.select({ tunnelId: tunnelExitNodes.tunnelId, hostId: tunnelExitNodes.hostId, isEnabled: tunnelExitNodes.isEnabled }).from(tunnelExitNodes), []),
  ]);
  const subscriptionHostIds = (subscriptions as any[]).flatMap((subscription) => subscription.hostIds || []).map(Number);
  const subscriptionTunnelIds = (subscriptions as any[]).flatMap((subscription) => subscription.tunnelIds || []).map(Number);
  const subscriptionGroupIds = (subscriptions as any[]).flatMap((subscription) => subscription.forwardGroupIds || []).map(Number);
  const billingResourceIds = billingSnapshot.usableResourceIds;
  const topologyGroups = topologyGroupsResult.value;
  const topologyMembers = topologyMembersResult.value;
  const scope = expandLinkAccessScope({
    hostIds: [
      ...(ownedHosts as any[]).map((host) => host.id),
      ...hostPermissions.map((row: any) => row.id),
      ...subscriptionHostIds,
      ...billingResourceIds.hostIds,
    ],
    tunnelIds: [
      ...(ownedTunnels as any[]).map((tunnel) => tunnel.id),
      ...tunnelPermissions.map((row: any) => row.id),
      ...subscriptionTunnelIds,
      ...billingResourceIds.tunnelIds,
    ],
    groupIds: [
      ...(ownedForwardGroups as any[]).map((group) => group.id),
      ...groupPermissions.map((row: any) => row.id),
      ...subscriptionGroupIds,
      ...billingResourceIds.forwardGroupIds,
    ],
    groups: topologyGroups as any[],
    members: topologyMembers as any[],
    tunnels: topologyTunnels as any[],
    tunnelHops: topologyHops as any[],
    tunnelExitNodes: topologyExits as any[],
  });
  const usableBillingIds = {
    host: new Set(billingResourceIds.hostIds.map(Number)),
    tunnel: new Set(billingResourceIds.tunnelIds.map(Number)),
    forward_group: new Set(billingResourceIds.forwardGroupIds.map(Number)),
  };
  const activeBillingIds = {
    host: new Set(billingSnapshot.activeResourceIds.hostIds.map(Number)),
    tunnel: new Set(billingSnapshot.activeResourceIds.tunnelIds.map(Number)),
    forward_group: new Set(billingSnapshot.activeResourceIds.forwardGroupIds.map(Number)),
  };
  const useIdsByType = {
    host: scope.useHostIds || scope.hostIds,
    tunnel: scope.useTunnelIds || scope.tunnelIds,
    forward_group: scope.useGroupIds || scope.groupIds,
  };
  if (billingSnapshot.status === "failed") {
    for (const useIds of Object.values(useIdsByType)) useIds.clear();
  } else if (billingSnapshot.enabled) {
    for (const resourceType of Object.keys(activeBillingIds) as Array<keyof typeof activeBillingIds>) {
      for (const value of activeBillingIds[resourceType]) {
        const resourceId = positiveId(value);
        if (resourceId <= 0) continue;
        if (usableBillingIds[resourceType].has(resourceId)) useIdsByType[resourceType].add(resourceId);
        else useIdsByType[resourceType].delete(resourceId);
      }
    }
    if (!topologyGroupsResult.ok || !topologyMembersResult.ok) {
      useIdsByType.forward_group.clear();
      return scope;
    }
    const groupsById = new Map((topologyGroups as any[]).map((group) => [positiveId(group?.id), group]));
    const membersByGroupId = new Map<number, any[]>();
    for (const member of topologyMembers as any[]) {
      if (!dbBool(member?.isEnabled, true)) continue;
      const groupId = positiveId(member?.groupId);
      if (!groupId) continue;
      const rows = membersByGroupId.get(groupId) || [];
      rows.push(member);
      membersByGroupId.set(groupId, rows);
    }
    const groupHasDeniedBillingMember = (rootGroupId: number) => {
      const pending = [rootGroupId];
      const visited = new Set<number>();
      while (pending.length > 0) {
        const groupId = positiveId(pending.shift());
        if (!groupId || visited.has(groupId)) continue;
        visited.add(groupId);
        const entryGroupId = positiveId(groupsById.get(groupId)?.entryGroupId);
        if (entryGroupId) pending.push(entryGroupId);
        for (const member of membersByGroupId.get(groupId) || []) {
          const hostId = member?.memberType === "host" ? positiveId(member?.hostId) : 0;
          if (hostId && activeBillingIds.host.has(hostId) && !usableBillingIds.host.has(hostId)) return true;
          const tunnelId = member?.memberType === "tunnel" ? positiveId(member?.tunnelId) : 0;
          if (tunnelId && activeBillingIds.tunnel.has(tunnelId) && !usableBillingIds.tunnel.has(tunnelId)) return true;
        }
      }
      return false;
    };
    for (const groupId of Array.from(useIdsByType.forward_group)) {
      if (groupHasDeniedBillingMember(groupId)) useIdsByType.forward_group.delete(groupId);
    }
  }
  return scope;
}

export function getLinkAccessScope(user: { id: number; role: string }): Promise<LinkAccessScope | null> {
  if (user.role === "admin") return Promise.resolve(null);
  return linkAccessQueryCache.get(
    `user:${Number(user.id)}`,
    { ttlMs: 1_000, staleMs: 0 },
    () => loadLinkAccessScope(Number(user.id)),
  );
}

export function clearLinkAccessScopeCache() {
  linkAccessQueryCache.clear();
}

export function canUseForwardRuleResource(rule: any, scope: LinkAccessScope | null) {
  if (!scope) return true;
  const groupId = positiveId(rule?.forwardGroupId);
  if (groupId > 0) return (scope.useGroupIds || scope.groupIds).has(groupId);
  const tunnelId = positiveId(rule?.tunnelId);
  if (tunnelId > 0) return (scope.useTunnelIds || scope.tunnelIds).has(tunnelId);
  const hostId = positiveId(rule?.hostId);
  return hostId > 0 && (scope.useHostIds || scope.hostIds).has(hostId);
}

/**
 * Runtime rows keep their persisted enabled flag, but an Agent must treat a
 * rule whose root resource is no longer authorized as disabled. Returning
 * cloned denied rows lets the normal removal path clean up an existing
 * listener without hiding or mutating the user's saved rule.
 */
export async function gateForwardRulesForRuntime<T extends Record<string, any>>(rules: T[]): Promise<T[]> {
  const userIds = Array.from(new Set(rules
    .map((rule) => positiveId(rule?.userId))
    .filter((id) => id > 0)));
  if (userIds.length === 0) return rules;

  const db = await getDb();
  if (!db) {
    return rules.map((rule) => ({ ...rule, isEnabled: false, resourceAccessDenied: true }));
  }
  const userRows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, userIds));
  const roleByUserId = new Map((userRows as any[])
    .map((user) => [positiveId(user?.id), String(user?.role || "user")] as const));
  const scopeEntries = await Promise.all(userIds.map(async (userId) => {
    const role = roleByUserId.get(userId);
    if (!role) return [userId, undefined] as const;
    return [userId, await getLinkAccessScope({ id: userId, role })] as const;
  }));
  const scopeByUserId = new Map(scopeEntries);

  return rules.map((rule) => {
    const userId = positiveId(rule?.userId);
    const scope = scopeByUserId.get(userId);
    const allowed = scope !== undefined && canUseForwardRuleResource(rule, scope);
    if (allowed) return rule;
    return { ...rule, isEnabled: false, resourceAccessDenied: true };
  });
}

function allowedHost(scope: LinkAccessScope, hostId: unknown) {
  const id = Number(hostId || 0);
  return id > 0 && scope.hostIds.has(id);
}

export function filterTunnelFieldsForUser(tunnel: any, scope: LinkAccessScope) {
  const {
    certPem,
    certKeyPem,
    secret,
    entryGroup,
    exitGroup,
    // Probe diagnostics can contain route labels, hostnames, addresses, and ports.
    // They must not cross the shared-tunnel ACL boundary.
    lastTestMessage,
    latestLatencySeries,
    ...rest
  } = tunnel || {};
  const rawHopIds = Array.isArray(rest.hopHostIds) ? rest.hopHostIds : [];
  const rawHopConnectHosts = Array.isArray(rest.hopConnectHosts) ? rest.hopConnectHosts : [];
  const visibleHopIndexes = rawHopIds
    .map((hostId: unknown, index: number) => allowedHost(scope, hostId) ? index : -1)
    .filter((index: number) => index >= 0);
  const visibleExits = (Array.isArray(rest.loadBalanceExits) ? rest.loadBalanceExits : [])
    .filter((exit: any) => allowedHost(scope, exit?.hostId));
  const entryHostVisible = allowedHost(scope, rest.entryHostId);
  const exitHostVisible = allowedHost(scope, rest.exitHostId);
  return {
    ...rest,
    entryHostId: entryHostVisible ? rest.entryHostId : null,
    exitHostId: exitHostVisible ? rest.exitHostId : null,
    entryGroupId: scope.groupIds.has(Number(rest.entryGroupId || 0)) ? rest.entryGroupId : null,
    exitGroupId: scope.groupIds.has(Number(rest.exitGroupId || 0)) ? rest.exitGroupId : null,
    connectHost: exitHostVisible ? rest.connectHost ?? null : null,
    entryHost: entryHostVisible ? rest.entryHost ?? null : null,
    exitHost: exitHostVisible ? rest.exitHost ?? null : null,
    hopHostIds: visibleHopIndexes.map((index: number) => Number(rawHopIds[index])),
    hopConnectHosts: visibleHopIndexes.map((index: number) => rawHopConnectHosts[index] ?? null),
    hopHosts: (Array.isArray(rest.hopHosts) ? rest.hopHosts : [])
      .filter((host: any) => allowedHost(scope, host?.id)),
    loadBalanceExits: visibleExits.map((exit: any) => ({
      ...exit,
      host: allowedHost(scope, exit?.hostId) ? exit?.host ?? null : null,
    })),
  };
}

export function visibleForwardGroupMemberIds(group: any, scope: LinkAccessScope | null) {
  const members = Array.isArray(group?.members) ? group.members : [];
  if (!scope) return members.map((member: any) => Number(member.id));
  const groupId = positiveId(group?.id);
  const groupHostIds = scope.groupHostIds?.get(groupId);
  const groupTunnelIds = scope.groupTunnelIds?.get(groupId);
  if (groupHostIds || groupTunnelIds) {
    return members
      .filter((member: any) => member?.memberType === "tunnel"
        ? !!groupTunnelIds?.has(Number(member.tunnelId || 0))
        : !!groupHostIds?.has(Number(member.hostId || 0)))
      .map((member: any) => Number(member.id));
  }
  return members
    .filter((member: any) => member?.memberType === "tunnel"
      ? scope.tunnelIds.has(Number(member.tunnelId || 0))
      : scope.hostIds.has(Number(member.hostId || 0)))
    .map((member: any) => Number(member.id));
}

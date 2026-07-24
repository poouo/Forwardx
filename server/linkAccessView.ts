import { eq } from "drizzle-orm";
import {
  forwardGroups,
  hosts,
  tunnels,
  userForwardGroupPermissions,
  userHostPermissions,
  userTunnelPermissions,
} from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { createQueryCache } from "./queryCache";
import { getActiveUserSubscriptions } from "./repositories/billingRepository";
import { getUserUsableTrafficBillingResourceIds } from "./repositories/trafficBillingRepository";

export type LinkAccessScope = {
  hostIds: Set<number>;
  tunnelIds: Set<number>;
  groupIds: Set<number>;
};

const linkAccessQueryCache = createQueryCache(500);
let lastLinkAccessWarningAt = 0;

function warnLinkAccessLookupFailure(error: unknown) {
  const now = Date.now();
  if (now - lastLinkAccessWarningAt < 60_000) return;
  lastLinkAccessWarningAt = now;
  console.warn("[LinkAccess] optional access lookup failed; direct user-owned resources remain available:", error instanceof Error ? error.message : String(error));
}

async function loadLinkAccessScope(userId: number): Promise<LinkAccessScope> {
  const db = await getDb();
  if (!db) return { hostIds: new Set(), tunnelIds: new Set(), groupIds: new Set() };
  const safe = <T>(task: Promise<T>, fallback: T) => task.catch((error) => {
    warnLinkAccessLookupFailure(error);
    return fallback;
  });
  const [ownedHosts, ownedTunnels, ownedForwardGroups, hostPermissions, tunnelPermissions, groupPermissions, subscriptions, billingResourceIds] = await Promise.all([
    safe(db.select({ id: hosts.id }).from(hosts).where(eq(hosts.userId, userId)), []),
    safe(db.select({ id: tunnels.id }).from(tunnels).where(eq(tunnels.userId, userId)), []),
    safe(db.select({ id: forwardGroups.id }).from(forwardGroups).where(eq(forwardGroups.userId, userId)), []),
    safe(db.select({ id: userHostPermissions.hostId }).from(userHostPermissions).where(eq(userHostPermissions.userId, userId)), []),
    safe(db.select({ id: userTunnelPermissions.tunnelId }).from(userTunnelPermissions).where(eq(userTunnelPermissions.userId, userId)), []),
    safe(db.select({ id: userForwardGroupPermissions.forwardGroupId }).from(userForwardGroupPermissions).where(eq(userForwardGroupPermissions.userId, userId)), []),
    safe(getActiveUserSubscriptions(userId), []),
    safe(getUserUsableTrafficBillingResourceIds(userId), { hostIds: [], tunnelIds: [], forwardGroupIds: [] }),
  ]);
  const subscriptionHostIds = (subscriptions as any[]).flatMap((subscription) => subscription.hostIds || []).map(Number);
  const subscriptionTunnelIds = (subscriptions as any[]).flatMap((subscription) => subscription.tunnelIds || []).map(Number);
  const subscriptionGroupIds = (subscriptions as any[]).flatMap((subscription) => subscription.forwardGroupIds || []).map(Number);
  return {
    hostIds: new Set([
      ...(ownedHosts as any[]).map((host) => Number(host.id)),
      ...hostPermissions.map((row: any) => Number(row.id)),
      ...subscriptionHostIds,
      ...billingResourceIds.hostIds.map(Number),
    ]),
    tunnelIds: new Set([
      ...(ownedTunnels as any[]).map((tunnel) => Number(tunnel.id)),
      ...tunnelPermissions.map((row: any) => Number(row.id)),
      ...subscriptionTunnelIds,
      ...billingResourceIds.tunnelIds.map(Number),
    ]),
    groupIds: new Set([
      ...(ownedForwardGroups as any[]).map((group) => Number(group.id)),
      ...groupPermissions.map((row: any) => Number(row.id)),
      ...subscriptionGroupIds,
      ...billingResourceIds.forwardGroupIds.map(Number),
    ]),
  };
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
  return members
    .filter((member: any) => member?.memberType === "tunnel"
      ? scope.tunnelIds.has(Number(member.tunnelId || 0))
      : scope.hostIds.has(Number(member.hostId || 0)))
    .map((member: any) => Number(member.id));
}

import { HOST_ONLINE_TTL_MS } from "./hostHeartbeatPolicy";

const authenticatedAgentSeenAt = new Map<number, number>();
type AuthenticatedAgentActivityListener = (hostId: number, seenAt: number) => void;
const authenticatedAgentActivityListeners = new Set<AuthenticatedAgentActivityListener>();

export function recordAuthenticatedAgentActivity(hostIdValue: unknown, seenAt = Date.now()) {
  const hostId = Number(hostIdValue);
  if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isFinite(seenAt)) return;
  const acceptedAt = Math.max(authenticatedAgentSeenAt.get(hostId) || 0, seenAt);
  authenticatedAgentSeenAt.set(hostId, acceptedAt);
  for (const listener of authenticatedAgentActivityListeners) {
    try {
      listener(hostId, acceptedAt);
    } catch {
      // Authentication must not depend on a liveness observer succeeding.
    }
  }
}

export function getLastAuthenticatedAgentActivity(hostIdValue: unknown) {
  const hostId = Number(hostIdValue);
  if (!Number.isInteger(hostId) || hostId <= 0) return null;
  return authenticatedAgentSeenAt.get(hostId) ?? null;
}

export function subscribeAuthenticatedAgentActivity(listener: AuthenticatedAgentActivityListener) {
  authenticatedAgentActivityListeners.add(listener);
  return () => { authenticatedAgentActivityListeners.delete(listener); };
}

export function hasRecentAuthenticatedAgentActivity(
  hostIdValue: unknown,
  now = Date.now(),
  ttlMs = HOST_ONLINE_TTL_MS,
) {
  const hostId = Number(hostIdValue);
  const seenAt = authenticatedAgentSeenAt.get(hostId);
  if (seenAt === undefined) return false;
  if (now - seenAt <= ttlMs) return true;
  authenticatedAgentSeenAt.delete(hostId);
  return false;
}

export function partitionHostsByRecentAgentActivity<T extends { id?: unknown }>(
  hosts: T[],
  now = Date.now(),
  ttlMs = HOST_ONLINE_TTL_MS,
) {
  const active: T[] = [];
  const stale: T[] = [];
  for (const host of hosts) {
    if (hasRecentAuthenticatedAgentActivity(host?.id, now, ttlMs)) active.push(host);
    else stale.push(host);
  }
  return { active, stale };
}

export function clearAuthenticatedAgentActivity(hostIdValue?: unknown) {
  if (hostIdValue === undefined) {
    authenticatedAgentSeenAt.clear();
    return;
  }
  authenticatedAgentSeenAt.delete(Number(hostIdValue));
}

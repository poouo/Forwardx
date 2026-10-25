import type { HostConnectionStats, HostSocketCount } from "../shared/hostConnections";
import { setBoundedMapValue } from "./boundedCache";

const TTL_MS = 15 * 60_000;
const snapshots = new Map<number, { stats: HostConnectionStats; receivedAt: number }>();
let lastPrunedAt = 0;
const reasons = new Set(["unsupported-platform", "permission-denied", "summary-missing", "summary-unreadable", "summary-invalid", "ipv6-summary-missing"]);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function normalizeSocketCount(value: unknown, tcp: boolean): HostSocketCount | null {
  if (!isObject(value) || typeof value.ipv6Included !== "boolean") return null;
  if (value.status === "unavailable") {
    if (typeof value.reason !== "string" || !reasons.has(value.reason)) return null;
    return { status: "unavailable", ipv6Included: false, reason: value.reason as HostSocketCount["reason"] };
  }
  if (value.status !== "ok" || !isCount(value.total) || !isCount(value.inUse)) return null;
  if (tcp ? !isCount(value.timeWait) || value.inUse + value.timeWait !== value.total : value.inUse !== value.total) return null;
  return { status: "ok", total: value.total, inUse: value.inUse, ...(tcp ? { timeWait: value.timeWait as number } : {}), ipv6Included: value.ipv6Included };
}

/** Backend-only latest snapshot: no historical DB writes or UI changes. */
export function recordAgentConnectionStats(hostId: number, value: unknown, now = Date.now()): boolean {
  if (!Number.isSafeInteger(hostId) || hostId <= 0 || !isObject(value) || value.version !== 1 || value.scope !== "network-namespace" || value.source !== "proc-sockstat") return false;
  if (!isCount(value.sampledAt) || value.sampledAt * 1000 > now + 30_000 || value.sampledAt * 1000 < now - TTL_MS) return false;
  const tcp = normalizeSocketCount(value.tcp, true);
  const udp = normalizeSocketCount(value.udp, false);
  if (!tcp || !udp) return false;
  if (now - lastPrunedAt >= 60_000) {
    for (const [id, snapshot] of snapshots) if (snapshot.receivedAt + TTL_MS <= now) snapshots.delete(id);
    lastPrunedAt = now;
  }
  const previous = snapshots.get(hostId);
  if (previous && previous.stats.sampledAt > value.sampledAt) return false;
  setBoundedMapValue(snapshots, hostId, { stats: { version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: value.sampledAt, tcp, udp }, receivedAt: now }, 5000);
  return true;
}

export function getAgentConnectionStats(hostId: number, now = Date.now()) {
  const snapshot = snapshots.get(hostId);
  if (!snapshot) return null;
  if (snapshot.receivedAt + TTL_MS <= now || snapshot.stats.sampledAt * 1000 + TTL_MS <= now) {
    snapshots.delete(hostId);
    return null;
  }
  return structuredClone(snapshot);
}

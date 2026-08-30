import { normalizeExitGroupStrategy } from "@shared/exitStrategy";

export type ExitGroupTunnelMember = {
  hostId?: number | null;
  connectHost?: string | null;
  priority?: number | null;
  isEnabled?: boolean | number | null;
};

export type TunnelExitEndpointSnapshot = {
  hostId?: number | null;
  listenPort?: number | null;
  mimicPort?: number | null;
  connectHost?: string | null;
};

export type PlannedTunnelExitEndpoint = {
  hostId: number;
  listenPort: number;
  mimicPort: number;
  connectHost: string | null;
};

function memberEnabled(value: ExitGroupTunnelMember["isEnabled"]) {
  return value !== false && value !== 0;
}

export function planExitGroupTunnelEndpoints(
  members: ExitGroupTunnelMember[],
  existingEndpoints: TunnelExitEndpointSnapshot[],
): PlannedTunnelExitEndpoint[] {
  const existingByHostId = new Map<number, TunnelExitEndpointSnapshot>();
  for (const endpoint of existingEndpoints) {
    const hostId = Number(endpoint?.hostId || 0);
    if (hostId > 0 && !existingByHostId.has(hostId)) existingByHostId.set(hostId, endpoint);
  }

  const seen = new Set<number>();
  return [...members]
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0))
    .filter((member) => memberEnabled(member.isEnabled))
    .map((member) => ({ ...member, hostId: Number(member.hostId || 0) }))
    .filter((member) => {
      if (member.hostId <= 0 || seen.has(member.hostId)) return false;
      seen.add(member.hostId);
      return true;
    })
    .map((member) => {
      const existing = existingByHostId.get(member.hostId);
      return {
        hostId: member.hostId,
        listenPort: Number(existing?.listenPort || 0),
        mimicPort: Number(existing?.mimicPort || 0),
        connectHost: String(member.connectHost || "").trim() || null,
      };
    });
}

export function forwardXExitStrategy(value: unknown) {
  const strategy = normalizeExitGroupStrategy(value);
  return strategy === "none" ? "round_robin" : strategy;
}

/**
 * A failed multi-exit dial must not wait on the runtime's longer default
 * timeout before the handler retries another exit. Relay failover uses the
 * same fast path even when it has no exit group.
 */
export function shouldUseFastTunnelFailover(exitCandidateCount: number, relayFailover = false) {
  return relayFailover || Number(exitCandidateCount) > 1;
}

export function gostExitSelector(value: unknown) {
  const strategy = normalizeExitGroupStrategy(value);
  return {
    strategy: strategy === "fallback" ? "fifo" : strategy === "random" ? "random" : strategy === "ip_hash" ? "hash" : "round",
    maxFails: 1,
    failTimeout: strategy === "fallback" ? "5s" : "15s",
  };
}

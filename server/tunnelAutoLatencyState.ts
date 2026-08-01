export type TunnelAutoHopDetail = {
  hopIndex: number;
  hopCount: number;
  fromHostId: number | null;
  toHostId: number | null;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

type AutoHopResult = TunnelAutoHopDetail & {
  generation: string;
};

const byTunnel = new Map<string, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 6 * 60 * 1000;

function tunnelPathStateKey(tunnelId: number, pathKey?: string | null) {
  return `${tunnelId}:${String(pathKey || "default").trim().toLowerCase() || "default"}`;
}

export function clearTunnelAutoHopLatencyState(tunnelId: number) {
  const prefix = `${Number(tunnelId)}:`;
  if (!Number.isInteger(Number(tunnelId)) || Number(tunnelId) <= 0) return;
  for (const key of byTunnel.keys()) {
    if (key.startsWith(prefix)) byTunnel.delete(key);
  }
}

function cleanupTunnelHopResults(stateKey: string, hopCount: number, generation: string, now: number) {
  const hops = byTunnel.get(stateKey);
  if (!hops) return;
  for (const [idx, result] of hops.entries()) {
    if (idx >= hopCount || result.hopCount !== hopCount || result.generation !== generation || now - result.recordedAt > AUTO_HOP_TTL_MS) {
      hops.delete(idx);
    }
  }
  if (hops.size === 0) byTunnel.delete(stateKey);
}

function aggregateTunnelHopResults(stateKey: string, hopCount: number, generation: string, now: number, allowEarlyFailure = false) {
  cleanupTunnelHopResults(stateKey, hopCount, generation, now);
  const hops = byTunnel.get(stateKey);
  if (!hops) return null;

  if (allowEarlyFailure && Array.from(hops.values()).some((result) => (
    result.generation === generation
    && now - result.recordedAt <= AUTO_HOP_TTL_MS
    && (result.isTimeout || !result.latencyMs || result.latencyMs <= 0)
  ))) {
    return { success: false, latencyMs: null };
  }

  const results: AutoHopResult[] = [];
  for (let i = 0; i < hopCount; i++) {
    const result = hops.get(i);
    if (!result || result.hopCount !== hopCount || result.generation !== generation || now - result.recordedAt > AUTO_HOP_TTL_MS) return null;
    results.push(result);
  }

  if (results.some((result) => result.isTimeout || !result.latencyMs || result.latencyMs <= 0)) {
    return { success: false, latencyMs: null };
  }
  return {
    success: true,
    latencyMs: results.reduce((sum, result) => sum + Number(result.latencyMs || 0), 0),
  };
}

export function recordTunnelAutoHopLatency(input: {
  tunnelId: number;
  hopIndex: number;
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
  generation?: string | null;
  pathKey?: string | null;
  allowEarlyFailure?: boolean;
  fromHostId?: number | null;
  toHostId?: number | null;
}): null | {
  success: boolean;
  latencyMs: number | null;
} {
  const tunnelId = Number(input.tunnelId);
  const hopIndex = Number(input.hopIndex);
  const hopCount = Number(input.hopCount);
  if (!Number.isFinite(tunnelId) || tunnelId <= 0) return null;
  if (!Number.isFinite(hopIndex) || hopIndex < 0) return null;
  if (!Number.isFinite(hopCount) || hopCount <= 0 || hopIndex >= hopCount) return null;
  const generation = String(input.generation || `legacy:${hopCount}`).slice(0, 1024);
  const stateKey = tunnelPathStateKey(tunnelId, input.pathKey);

  const now = Date.now();
  let hops = byTunnel.get(stateKey);
  if (!hops) {
    hops = new Map<number, AutoHopResult>();
    byTunnel.set(stateKey, hops);
  }
  for (const [idx, result] of hops.entries()) {
    if (result.hopCount !== hopCount || result.generation !== generation || now - result.recordedAt > AUTO_HOP_TTL_MS) {
      hops.delete(idx);
    }
  }
  hops.set(hopIndex, {
    hopIndex,
    hopCount,
    generation,
    fromHostId: Number.isInteger(Number(input.fromHostId)) && Number(input.fromHostId) > 0 ? Number(input.fromHostId) : null,
    toHostId: Number.isInteger(Number(input.toHostId)) && Number(input.toHostId) > 0 ? Number(input.toHostId) : null,
    latencyMs: input.latencyMs,
    isTimeout: !!input.isTimeout,
    recordedAt: now,
  });
  return aggregateTunnelHopResults(stateKey, hopCount, generation, now, !!input.allowEarlyFailure);
}

export function getTunnelAutoHopAggregate(
  tunnelId: number,
  hopCount: number,
  generation?: string,
  pathKey?: string | null,
  allowEarlyFailure = false,
) {
  const id = Number(tunnelId);
  const count = Number(hopCount);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(count) || count <= 0) return null;
  const stateKey = tunnelPathStateKey(id, pathKey);
  const hops = byTunnel.get(stateKey);
  const activeGeneration = String(generation || hops?.get(0)?.generation || `legacy:${count}`);
  return aggregateTunnelHopResults(stateKey, count, activeGeneration, Date.now(), allowEarlyFailure);
}

/** Returns the complete, fresh per-hop sample used to form an automatic aggregate. */
export function getTunnelAutoHopDetails(input: {
  tunnelId: number;
  hopCount: number;
  generation?: string | null;
  pathKey?: string | null;
  referenceAt?: number | Date | null;
  maxAgeMs?: number;
}) {
  const tunnelId = Number(input.tunnelId);
  const hopCount = Number(input.hopCount);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isInteger(hopCount) || hopCount <= 0) return null;
  const stateKey = tunnelPathStateKey(tunnelId, input.pathKey);
  const hops = byTunnel.get(stateKey);
  if (!hops) return null;
  const generation = String(input.generation || hops.get(0)?.generation || `legacy:${hopCount}`).slice(0, 1024);
  const now = Date.now();
  cleanupTunnelHopResults(stateKey, hopCount, generation, now);
  const refreshed = byTunnel.get(stateKey);
  if (!refreshed) return null;
  const referenceAt = input.referenceAt instanceof Date
    ? input.referenceAt.getTime()
    : Number(input.referenceAt || 0);
  const maxAgeMs = Math.max(1_000, Number(input.maxAgeMs || AUTO_HOP_TTL_MS));
  const details: TunnelAutoHopDetail[] = [];
  for (let hopIndex = 0; hopIndex < hopCount; hopIndex += 1) {
    const result = refreshed.get(hopIndex);
    if (!result || result.hopCount !== hopCount || result.generation !== generation) return null;
    if (now - result.recordedAt > maxAgeMs) return null;
    if (referenceAt > 0 && Math.abs(result.recordedAt - referenceAt) > 30_000) return null;
    details.push({
      hopIndex: result.hopIndex,
      hopCount: result.hopCount,
      fromHostId: result.fromHostId,
      toHostId: result.toHostId,
      latencyMs: result.latencyMs,
      isTimeout: result.isTimeout,
      recordedAt: result.recordedAt,
    });
  }
  return details;
}

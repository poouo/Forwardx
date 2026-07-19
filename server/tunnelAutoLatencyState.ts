type AutoHopResult = {
  hopCount: number;
  generation: string;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

const byTunnel = new Map<string, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 5 * 60 * 1000;

function tunnelPathStateKey(tunnelId: number, pathKey?: string | null) {
  return `${tunnelId}:${String(pathKey || "default").trim().toLowerCase() || "default"}`;
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
    hopCount,
    generation,
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

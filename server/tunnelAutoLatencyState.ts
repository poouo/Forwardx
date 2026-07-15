type AutoHopResult = {
  hopCount: number;
  generation: string;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

const byTunnel = new Map<number, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 5 * 60 * 1000;

function cleanupTunnelHopResults(tunnelId: number, hopCount: number, generation: string, now: number) {
  const hops = byTunnel.get(tunnelId);
  if (!hops) return;
  for (const [idx, result] of hops.entries()) {
    if (idx >= hopCount || result.hopCount !== hopCount || result.generation !== generation || now - result.recordedAt > AUTO_HOP_TTL_MS) {
      hops.delete(idx);
    }
  }
  if (hops.size === 0) byTunnel.delete(tunnelId);
}

function aggregateTunnelHopResults(tunnelId: number, hopCount: number, generation: string, now: number) {
  cleanupTunnelHopResults(tunnelId, hopCount, generation, now);
  const hops = byTunnel.get(tunnelId);
  if (!hops) return null;

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

  const now = Date.now();
  let hops = byTunnel.get(tunnelId);
  if (!hops) {
    hops = new Map<number, AutoHopResult>();
    byTunnel.set(tunnelId, hops);
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
  return aggregateTunnelHopResults(tunnelId, hopCount, generation, now);
}

export function getTunnelAutoHopAggregate(tunnelId: number, hopCount: number, generation?: string) {
  const id = Number(tunnelId);
  const count = Number(hopCount);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(count) || count <= 0) return null;
  const hops = byTunnel.get(id);
  const activeGeneration = String(generation || hops?.get(0)?.generation || `legacy:${count}`);
  return aggregateTunnelHopResults(id, count, activeGeneration, Date.now());
}

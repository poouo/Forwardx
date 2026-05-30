type AutoHopResult = {
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

const byTunnel = new Map<number, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 2 * 60 * 1000;

export function recordTunnelAutoHopLatency(input: {
  tunnelId: number;
  hopIndex: number;
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
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

  const now = Date.now();
  let hops = byTunnel.get(tunnelId);
  if (!hops) {
    hops = new Map<number, AutoHopResult>();
    byTunnel.set(tunnelId, hops);
  }
  for (const [idx, result] of hops.entries()) {
    if (result.hopCount !== hopCount || now - result.recordedAt > AUTO_HOP_TTL_MS) {
      hops.delete(idx);
    }
  }
  hops.set(hopIndex, {
    hopCount,
    latencyMs: input.latencyMs,
    isTimeout: !!input.isTimeout,
    recordedAt: now,
  });
  if (hops.size < hopCount) return null;

  const results: AutoHopResult[] = [];
  for (let i = 0; i < hopCount; i++) {
    const result = hops.get(i);
    if (!result || result.hopCount !== hopCount || now - result.recordedAt > AUTO_HOP_TTL_MS) return null;
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

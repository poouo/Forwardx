type AutoHopResult = {
  hopCount: number;
  generation: string;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

const byGroup = new Map<number, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 2 * 60 * 1000;

export function recordForwardGroupAutoHopLatency(input: {
  groupId: number;
  hopIndex: number;
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
  generation?: string | null;
}): null | {
  success: boolean;
  latencyMs: number | null;
} {
  const groupId = Number(input.groupId);
  const hopIndex = Number(input.hopIndex);
  const hopCount = Number(input.hopCount);
  if (!Number.isFinite(groupId) || groupId <= 0) return null;
  if (!Number.isFinite(hopIndex) || hopIndex < 0) return null;
  if (!Number.isFinite(hopCount) || hopCount <= 0 || hopIndex >= hopCount) return null;
  const generation = String(input.generation || `legacy:${hopCount}`).slice(0, 1024);

  const now = Date.now();
  let hops = byGroup.get(groupId);
  if (!hops) {
    hops = new Map<number, AutoHopResult>();
    byGroup.set(groupId, hops);
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
  if (hops.size < hopCount) return null;

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

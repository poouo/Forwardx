type AutoHopResult = {
  hopCount: number;
  generation: string;
  latencyMs: number | null;
  isTimeout: boolean;
  probeCount: number;
  probeSuccesses: number;
  recordedAt: number;
};

const byGroup = new Map<number, Map<number, AutoHopResult>>();

const AUTO_HOP_TTL_MS = 6 * 60 * 1000;

export function recordForwardGroupAutoHopLatency(input: {
  groupId: number;
  hopIndex: number;
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
  probeCount?: number | null;
  probeSuccesses?: number | null;
  generation?: string | null;
}): null | {
  success: boolean;
  latencyMs: number | null;
  probeCount?: number;
  probeSuccesses?: number;
} {
  const groupId = Number(input.groupId);
  const hopIndex = Number(input.hopIndex);
  const hopCount = Number(input.hopCount);
  if (!Number.isFinite(groupId) || groupId <= 0) return null;
  if (!Number.isFinite(hopIndex) || hopIndex < 0) return null;
  if (!Number.isFinite(hopCount) || hopCount <= 0 || hopIndex >= hopCount) return null;
  const generation = String(input.generation || `legacy:${hopCount}`).slice(0, 1024);

  const rawCount = Number(input.probeCount);
  const sampleProbeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
  const rawSuccesses = Number(input.probeSuccesses);
  let sampleProbeSuccesses = Number.isInteger(rawSuccesses)
    ? Math.max(0, Math.min(sampleProbeCount, rawSuccesses))
    : (input.isTimeout ? 0 : sampleProbeCount);
  // Rows from older Agents did not carry counters. A successful boolean
  // therefore represents one successful probe, while an explicit partial
  // result keeps its zero/non-zero packet count intact.
  if (!input.isTimeout && sampleProbeSuccesses === 0 && input.probeSuccesses === undefined) sampleProbeSuccesses = sampleProbeCount;

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
    probeCount: sampleProbeCount,
    probeSuccesses: sampleProbeSuccesses,
    recordedAt: now,
  });
  if (hops.size < hopCount) return null;

  const results: AutoHopResult[] = [];
  for (let i = 0; i < hopCount; i++) {
    const result = hops.get(i);
    if (!result || result.hopCount !== hopCount || result.generation !== generation || now - result.recordedAt > AUTO_HOP_TTL_MS) return null;
    results.push(result);
  }

  const probeCount = Math.max(...results.map((result) => result.probeCount || 1), 1);
  // Every hop must succeed for the same packet to complete the path. Using
  // the minimum success ratio is conservative and preserves partial loss
  // without claiming more successful packets than any individual hop.
  const probeSuccesses = Math.max(0, Math.min(
    probeCount,
    Math.floor(Math.min(...results.map((result) => {
      const count = Math.max(1, result.probeCount || 1);
      const successes = Math.max(0, Math.min(count, result.probeSuccesses || 0));
      return successes / count;
    })) * probeCount),
  ));
  // A path remains reachable when each hop has at least one successful
  // packet. `isTimeout` is a legacy binary field and may be true on a
  // partially-lost sample; the packet counters are authoritative here.
  const successful = probeSuccesses > 0 && results.every((result) => (
    result.probeSuccesses > 0 && Number(result.latencyMs || 0) > 0
  ));
  const aggregate = {
    success: successful,
    latencyMs: successful ? results.reduce((sum, result) => sum + Number(result.latencyMs || 0), 0) : null,
  } as { success: boolean; latencyMs: number | null; probeCount?: number; probeSuccesses?: number };
  if (probeCount !== 1 || probeSuccesses !== (successful ? 1 : 0)) {
    aggregate.probeCount = probeCount;
    aggregate.probeSuccesses = probeSuccesses;
  }
  return aggregate;
}

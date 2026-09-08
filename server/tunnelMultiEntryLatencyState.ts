export type TunnelEntryLatencyDetail = {
  hostId: number;
  label: string;
  latencyMs: number | null;
  isTimeout: boolean;
  probeCount?: number;
  probeSuccesses?: number;
};

export type TunnelMultiEntryHopDetail = {
  hopIndex: number;
  hopCount: number;
  fromHostId: number | null;
  toHostId: number | null;
  latencyMs: number | null;
  isTimeout: boolean;
  probeCount?: number;
  probeSuccesses?: number;
  recordedAt: number;
};

type ProbeResult = {
  latencyMs: number | null;
  isTimeout: boolean;
  label: string;
  fromHostId: number;
  toHostId: number | null;
  hopIndex: number;
  probeCount: number;
  probeSuccesses: number;
  recordedAt: number;
};

type MultiEntryPathState = {
  generation: string;
  hopCount: number;
  expectedEntryHostIds: number[];
  entryHops: Map<number, ProbeResult>;
  sharedHops: Map<number, ProbeResult>;
  updatedAt: number;
};

export type TunnelMultiEntryLatencyAggregate = {
  success: boolean;
  partial: boolean;
  latencyMs: number | null;
  details: TunnelEntryLatencyDetail[];
  probeCount?: number;
  probeSuccesses?: number;
};

const states = new Map<string, MultiEntryPathState>();
const MULTI_ENTRY_PROBE_TTL_MS = 6 * 60 * 1000;

function normalizeHostIds(values: number[]) {
  return Array.from(new Set((values || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right);
}

function pathStateKey(tunnelId: number, pathKey?: string | null) {
  const path = String(pathKey || "default").trim().toLowerCase() || "default";
  return `${tunnelId}:${path}`;
}

export function clearTunnelMultiEntryLatencyState(tunnelId: number) {
  const prefix = `${Number(tunnelId)}:`;
  if (!Number.isInteger(Number(tunnelId)) || Number(tunnelId) <= 0) return;
  for (const key of states.keys()) {
    if (key.startsWith(prefix)) states.delete(key);
  }
}

function expectedSignature(hostIds: number[]) {
  return hostIds.join(",");
}

function cleanExpiredResults(state: MultiEntryPathState, now: number) {
  for (const [hostId, result] of state.entryHops.entries()) {
    if (now - result.recordedAt > MULTI_ENTRY_PROBE_TTL_MS) state.entryHops.delete(hostId);
  }
  for (const [hopIndex, result] of state.sharedHops.entries()) {
    if (now - result.recordedAt > MULTI_ENTRY_PROBE_TTL_MS) state.sharedHops.delete(hopIndex);
  }
}

function cleanExpiredStates(now: number) {
  for (const [key, state] of states.entries()) {
    if (now - state.updatedAt > MULTI_ENTRY_PROBE_TTL_MS) states.delete(key);
  }
}

function resultSucceeded(result: ProbeResult | undefined) {
  return !!result && result.probeSuccesses > 0 && Number(result.latencyMs || 0) > 0;
}

function normalizeProbeCounts(input: {
  probeCount?: number | null;
  probeSuccesses?: number | null;
  isTimeout?: boolean;
}) {
  const rawCount = Number(input.probeCount);
  const probeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
  const rawSuccesses = Number(input.probeSuccesses);
  const hasSuccesses = input.probeSuccesses !== undefined && input.probeSuccesses !== null
    && Number.isInteger(rawSuccesses);
  let probeSuccesses = hasSuccesses ? rawSuccesses : (input.isTimeout ? 0 : probeCount);
  probeSuccesses = Math.max(0, Math.min(probeCount, probeSuccesses));
  return { probeCount, probeSuccesses };
}

function combineProbeCounts(results: ProbeResult[]) {
  if (results.length === 0) return { probeCount: 1, probeSuccesses: 0 };
  const probeCount = Math.max(...results.map((result) => Math.max(1, result.probeCount || 1)), 1);
  const ratio = Math.min(...results.map((result) => {
    const count = Math.max(1, result.probeCount || 1);
    return Math.max(0, Math.min(count, result.probeSuccesses || 0)) / count;
  }));
  return {
    probeCount,
    probeSuccesses: Math.max(0, Math.min(probeCount, Math.floor(ratio * probeCount + 1e-9))),
  };
}

/**
 * Pick a representative counter set for an alternative-path aggregate.
 *
 * Entries in a multi-entry tunnel are failover/parallel alternatives rather
 * than packets that all traverse the same path.  Counting every entry in the
 * denominator would therefore report a loss whenever an unused entry is down.
 * Prefer the successful entry with the best observed success ratio; when no
 * entry succeeded, retain a conservative failure count from all available
 * samples so a repeated (for example 0/3) probe is not collapsed to 1/0.
 */
function representativeProbeCounts(
  details: Array<{ probeCount?: number; probeSuccesses?: number; isTimeout: boolean }>,
  fallback: ProbeResult[] = [],
) {
  const candidates = details
    .map((detail) => {
      const count = Number.isInteger(Number(detail.probeCount)) && Number(detail.probeCount) >= 1
        ? Math.min(1024, Number(detail.probeCount))
        : 1;
      const successes = Number.isInteger(Number(detail.probeSuccesses))
        ? Math.max(0, Math.min(count, Number(detail.probeSuccesses)))
        : (detail.isTimeout ? 0 : count);
      return { probeCount: count, probeSuccesses: successes };
    });
  const successful = candidates
    .filter((candidate) => candidate.probeSuccesses > 0)
    .sort((left, right) => (
      right.probeSuccesses / right.probeCount - left.probeSuccesses / left.probeCount
    ));
  if (successful.length > 0) return successful[0];
  return combineProbeCounts(fallback);
}

function maybeAttachCounts<T extends { isTimeout: boolean }>(detail: T, counts: { probeCount: number; probeSuccesses: number }) {
  if (counts.probeCount === 1 && counts.probeSuccesses === (detail.isTimeout ? 0 : 1)) return detail;
  return { ...detail, ...counts };
}

function aggregateMultiEntryState(state: MultiEntryPathState, now: number): TunnelMultiEntryLatencyAggregate | null {
  cleanExpiredResults(state, now);
  const sharedResults: ProbeResult[] = [];
  for (let index = 1; index < state.hopCount; index += 1) {
    const shared = state.sharedHops.get(index);
    if (!shared) return null;
    sharedResults.push(shared);
  }
  const sharedFailed = sharedResults.some((shared) => !resultSucceeded(shared));
  const sharedLatency = sharedResults.reduce((sum, shared) => sum + Number(shared.latencyMs || 0), 0);
  const sharedCounts = combineProbeCounts(sharedResults);
  const details: TunnelEntryLatencyDetail[] = state.expectedEntryHostIds.flatMap((hostId) => {
    const entry = state.entryHops.get(hostId);
    if (!entry && !sharedFailed) return [];
    const success = !sharedFailed && resultSucceeded(entry);
    const entryCounts = entry ? combineProbeCounts([entry, ...sharedResults]) : { probeCount: sharedCounts.probeCount, probeSuccesses: 0 };
    return [maybeAttachCounts({
      hostId,
      label: entry?.label || `入口 ${hostId}`,
      latencyMs: success ? Number(entry?.latencyMs || 0) + sharedLatency : null,
      isTimeout: !success,
    }, entryCounts)];
  });
  const successful = details.filter((detail) => !detail.isTimeout && Number(detail.latencyMs || 0) > 0);
  if (successful.length > 0) {
    const representative = representativeProbeCounts(successful);
    return {
      success: true,
      partial: successful.length < state.expectedEntryHostIds.length,
      latencyMs: Math.max(...successful.map((detail) => Number(detail.latencyMs))),
      details,
      ...(representative.probeCount !== 1 || representative.probeSuccesses !== 1 ? representative : {}),
    };
  }
  if (sharedFailed || details.length === state.expectedEntryHostIds.length) {
    const availableResults = [
      ...state.entryHops.values(),
      ...sharedResults,
    ];
    const failureCounts = representativeProbeCounts([], availableResults);
    return {
      success: false,
      partial: false,
      latencyMs: null,
      details,
      ...(failureCounts.probeCount !== 1 || failureCounts.probeSuccesses !== 0 ? failureCounts : {}),
    };
  }
  return null;
}

export function recordTunnelMultiEntryLatency(input: {
  tunnelId: number;
  sourceHostId: number;
  sourceLabel?: string | null;
  expectedEntryHostIds: number[];
  hopIndex: number;
  hopCount: number;
  latencyMs: number | null;
  isTimeout: boolean;
  generation?: string | null;
  pathKey?: string | null;
  toHostId?: number | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
}): TunnelMultiEntryLatencyAggregate | null {
  const tunnelId = Number(input.tunnelId);
  const sourceHostId = Number(input.sourceHostId);
  const hopIndex = Number(input.hopIndex);
  const hopCount = Number(input.hopCount);
  const expectedEntryHostIds = normalizeHostIds(input.expectedEntryHostIds);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) return null;
  if (!Number.isInteger(sourceHostId) || sourceHostId <= 0) return null;
  if (!Number.isInteger(hopIndex) || hopIndex < 0) return null;
  if (!Number.isInteger(hopCount) || hopCount <= 0 || hopIndex >= hopCount) return null;
  if (expectedEntryHostIds.length < 2) return null;
  if (hopIndex === 0 && !expectedEntryHostIds.includes(sourceHostId)) return null;

  const generation = String(input.generation || `legacy:${hopCount}`).slice(0, 1024);
  const key = pathStateKey(tunnelId, input.pathKey);
  const now = Date.now();
  cleanExpiredStates(now);
  let state = states.get(key);
  if (
    !state
    || state.generation !== generation
    || state.hopCount !== hopCount
    || expectedSignature(state.expectedEntryHostIds) !== expectedSignature(expectedEntryHostIds)
  ) {
    state = {
      generation,
      hopCount,
      expectedEntryHostIds,
      entryHops: new Map(),
      sharedHops: new Map(),
      updatedAt: now,
    };
    states.set(key, state);
  }
  cleanExpiredResults(state, now);
  const result: ProbeResult = {
    latencyMs: typeof input.latencyMs === "number" && input.latencyMs > 0 ? input.latencyMs : null,
    isTimeout: !!input.isTimeout || !(typeof input.latencyMs === "number" && input.latencyMs > 0),
    label: String(input.sourceLabel || "").trim().slice(0, 96),
    fromHostId: sourceHostId,
    toHostId: Number.isInteger(Number(input.toHostId)) && Number(input.toHostId) > 0 ? Number(input.toHostId) : null,
    hopIndex,
    ...normalizeProbeCounts(input),
    recordedAt: now,
  };
  if (hopIndex === 0) state.entryHops.set(sourceHostId, result);
  else state.sharedHops.set(hopIndex, result);
  state.updatedAt = now;

  return aggregateMultiEntryState(state, now);
}

export function getTunnelMultiEntryLatency(input: {
  tunnelId: number;
  expectedEntryHostIds: number[];
  hopCount: number;
  generation?: string | null;
  pathKey?: string | null;
}): TunnelMultiEntryLatencyAggregate | null {
  const tunnelId = Number(input.tunnelId);
  const hopCount = Number(input.hopCount);
  const expectedEntryHostIds = normalizeHostIds(input.expectedEntryHostIds);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isInteger(hopCount) || hopCount <= 0) return null;
  if (expectedEntryHostIds.length < 2) return null;
  const state = states.get(pathStateKey(tunnelId, input.pathKey));
  if (!state) return null;
  const generation = String(input.generation || `legacy:${hopCount}`).slice(0, 1024);
  if (
    state.generation !== generation
    || state.hopCount !== hopCount
    || expectedSignature(state.expectedEntryHostIds) !== expectedSignature(expectedEntryHostIds)
  ) return null;
  const now = Date.now();
  if (now - state.updatedAt > MULTI_ENTRY_PROBE_TTL_MS) {
    states.delete(pathStateKey(tunnelId, input.pathKey));
    return null;
  }
  return aggregateMultiEntryState(state, now);
}

/** Returns only the fresh entry and shared-hop samples actually reported by Agents. */
export function getTunnelMultiEntryHopDetails(input: {
  tunnelId: number;
  expectedEntryHostIds: number[];
  hopCount: number;
  generation?: string | null;
  pathKey?: string | null;
  referenceAt?: number | Date | null;
  maxAgeMs?: number;
}) {
  const tunnelId = Number(input.tunnelId);
  const hopCount = Number(input.hopCount);
  const expectedEntryHostIds = normalizeHostIds(input.expectedEntryHostIds);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isInteger(hopCount) || hopCount <= 0 || expectedEntryHostIds.length < 2) return null;
  const key = pathStateKey(tunnelId, input.pathKey);
  const now = Date.now();
  cleanExpiredStates(now);
  const state = states.get(key);
  if (!state) return null;
  const generation = String(input.generation || state.generation).slice(0, 1024);
  if (
    state.generation !== generation
    || state.hopCount !== hopCount
    || expectedSignature(state.expectedEntryHostIds) !== expectedSignature(expectedEntryHostIds)
  ) return null;
  cleanExpiredResults(state, now);
  const referenceAt = input.referenceAt instanceof Date
    ? input.referenceAt.getTime()
    : Number(input.referenceAt || 0);
  const maxAgeMs = Math.max(1_000, Number(input.maxAgeMs || MULTI_ENTRY_PROBE_TTL_MS));
  const isFresh = (recordedAt: number) => (
    now - recordedAt <= maxAgeMs
    && (referenceAt <= 0 || Math.abs(recordedAt - referenceAt) <= 30_000)
  );
  const sharedFirstSource = state.sharedHops.get(1)?.fromHostId || null;
  const details: TunnelMultiEntryHopDetail[] = [];
  for (const hostId of expectedEntryHostIds) {
    const entry = state.entryHops.get(hostId);
    if (!entry) continue;
    if (!isFresh(entry.recordedAt)) return null;
    const detail: TunnelMultiEntryHopDetail = {
      hopIndex: 0,
      hopCount,
      fromHostId: hostId,
      toHostId: entry.toHostId || sharedFirstSource,
      latencyMs: entry.latencyMs,
      isTimeout: entry.isTimeout,
      recordedAt: entry.recordedAt,
    };
    if (entry.probeCount !== 1 || entry.probeSuccesses !== (entry.isTimeout ? 0 : 1)) {
      detail.probeCount = entry.probeCount;
      detail.probeSuccesses = entry.probeSuccesses;
    }
    details.push(detail);
  }
  for (let hopIndex = 1; hopIndex < hopCount; hopIndex += 1) {
    const shared = state.sharedHops.get(hopIndex);
    if (!shared) continue;
    if (!isFresh(shared.recordedAt)) return null;
    const detail: TunnelMultiEntryHopDetail = {
      hopIndex,
      hopCount,
      fromHostId: shared.fromHostId || null,
      toHostId: shared.toHostId || null,
      latencyMs: shared.latencyMs,
      isTimeout: shared.isTimeout,
      recordedAt: shared.recordedAt,
    };
    if (shared.probeCount !== 1 || shared.probeSuccesses !== (shared.isTimeout ? 0 : 1)) {
      detail.probeCount = shared.probeCount;
      detail.probeSuccesses = shared.probeSuccesses;
    }
    details.push(detail);
  }
  return details.length > 0 ? details : null;
}

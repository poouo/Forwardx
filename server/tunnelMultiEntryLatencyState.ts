export type TunnelEntryLatencyDetail = {
  hostId: number;
  label: string;
  latencyMs: number | null;
  isTimeout: boolean;
};

export type TunnelMultiEntryHopDetail = {
  hopIndex: number;
  hopCount: number;
  fromHostId: number | null;
  toHostId: number | null;
  latencyMs: number | null;
  isTimeout: boolean;
  recordedAt: number;
};

type ProbeResult = {
  latencyMs: number | null;
  isTimeout: boolean;
  label: string;
  fromHostId: number;
  toHostId: number | null;
  hopIndex: number;
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
  return !!result && !result.isTimeout && Number(result.latencyMs || 0) > 0;
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
  const details = state.expectedEntryHostIds.flatMap((hostId) => {
    const entry = state.entryHops.get(hostId);
    if (!entry && !sharedFailed) return [];
    const success = !sharedFailed && resultSucceeded(entry);
    return [{
      hostId,
      label: entry?.label || `入口 ${hostId}`,
      latencyMs: success ? Number(entry?.latencyMs || 0) + sharedLatency : null,
      isTimeout: !success,
    }];
  });
  const successful = details.filter((detail) => !detail.isTimeout && Number(detail.latencyMs || 0) > 0);
  if (successful.length > 0) {
    return {
      success: true,
      partial: successful.length < state.expectedEntryHostIds.length,
      latencyMs: Math.max(...successful.map((detail) => Number(detail.latencyMs))),
      details,
    };
  }
  if (sharedFailed || details.length === state.expectedEntryHostIds.length) {
    return {
      success: false,
      partial: false,
      latencyMs: null,
      details,
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
    details.push({
      hopIndex: 0,
      hopCount,
      fromHostId: hostId,
      toHostId: entry.toHostId || sharedFirstSource,
      latencyMs: entry.latencyMs,
      isTimeout: entry.isTimeout,
      recordedAt: entry.recordedAt,
    });
  }
  for (let hopIndex = 1; hopIndex < hopCount; hopIndex += 1) {
    const shared = state.sharedHops.get(hopIndex);
    if (!shared) continue;
    if (!isFresh(shared.recordedAt)) return null;
    details.push({
      hopIndex,
      hopCount,
      fromHostId: shared.fromHostId || null,
      toHostId: shared.toHostId || null,
      latencyMs: shared.latencyMs,
      isTimeout: shared.isTimeout,
      recordedAt: shared.recordedAt,
    });
  }
  return details.length > 0 ? details : null;
}

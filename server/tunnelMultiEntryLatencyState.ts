export type TunnelEntryLatencyDetail = {
  hostId: number;
  label: string;
  latencyMs: number | null;
  isTimeout: boolean;
};

type ProbeResult = {
  latencyMs: number | null;
  isTimeout: boolean;
  label: string;
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
const MULTI_ENTRY_PROBE_TTL_MS = 5 * 60 * 1000;

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

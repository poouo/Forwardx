import {
  LINK_PROBE_FRESH_MS,
  LINK_PROBE_MAX_FUTURE_SKEW_MS,
} from "@shared/linkProbePolicy";

export type RuleProbeSummary = {
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | number | null;
};

type InvalidationBoundary = {
  invalidatedAt: number;
  previousProbeAt: number;
};

const probesByUser = new Map<string, Map<number, RuleProbeSummary>>();
const invalidationsByUser = new Map<string, Map<number, InvalidationBoundary>>();

function userCacheKey(userId: unknown) {
  if (userId === null || userId === undefined) return null;
  const key = String(userId).trim();
  return key ? key : null;
}

function validRuleId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 0 && numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function probeTimestamp(probe: RuleProbeSummary | null | undefined) {
  return timestampMillis(probe?.latestLatencyAt);
}

function isValidProbe(probe: RuleProbeSummary | null | undefined) {
  if (!probe || probeTimestamp(probe) <= 0) return false;
  if (probe.latestLatencyIsTimeout === true) return true;
  const latency = Number(probe.latestLatencyMs);
  return probe.latestLatencyMs !== null
    && probe.latestLatencyMs !== undefined
    && Number.isFinite(latency)
    && latency >= 0;
}

function isFreshProbe(probe: RuleProbeSummary, now: number) {
  const recordedAt = probeTimestamp(probe);
  return recordedAt > 0
    && recordedAt <= now + LINK_PROBE_MAX_FUTURE_SKEW_MS
    && now - recordedAt <= LINK_PROBE_FRESH_MS;
}

function isAfterInvalidation(
  boundary: InvalidationBoundary | undefined,
  probe: RuleProbeSummary | null | undefined,
) {
  if (!isValidProbe(probe)) return false;
  if (!boundary) return true;
  const recordedAt = probeTimestamp(probe);
  if (boundary.previousProbeAt > 0) return recordedAt > boundary.previousProbeAt;
  return recordedAt >= boundary.invalidatedAt;
}

export function updateRuleProbeCache(
  userId: unknown,
  probes: ReadonlyMap<number, RuleProbeSummary>,
) {
  const userKey = userCacheKey(userId);
  if (!userKey) return;
  let cache = probesByUser.get(userKey);
  const invalidations = invalidationsByUser.get(userKey);

  for (const [rawRuleId, probe] of probes) {
    const ruleId = validRuleId(rawRuleId);
    if (!ruleId || !isAfterInvalidation(invalidations?.get(ruleId), probe)) continue;
    if (!cache) {
      cache = new Map<number, RuleProbeSummary>();
      probesByUser.set(userKey, cache);
    }
    const cached = cache.get(ruleId);
    if (!cached || probeTimestamp(probe) >= probeTimestamp(cached)) {
      cache.set(ruleId, probe);
    }
  }
}

export function clearRuleProbeCache(userId: unknown, ruleIds: Iterable<number>) {
  const userKey = userCacheKey(userId);
  if (!userKey) return;
  const cache = probesByUser.get(userKey);
  let invalidations = invalidationsByUser.get(userKey);
  const invalidatedAt = Math.floor(Date.now() / 1000) * 1000;

  for (const rawRuleId of ruleIds) {
    const ruleId = validRuleId(rawRuleId);
    if (!ruleId) continue;
    const previousProbeAt = probeTimestamp(cache?.get(ruleId));
    cache?.delete(ruleId);
    if (!invalidations) {
      invalidations = new Map<number, InvalidationBoundary>();
      invalidationsByUser.set(userKey, invalidations);
    }
    invalidations.set(ruleId, { invalidatedAt, previousProbeAt });
  }

  if (cache?.size === 0) probesByUser.delete(userKey);
}

export function hasRuleProbeAfterInvalidation(
  userId: unknown,
  ruleId: number,
  probe: RuleProbeSummary | null | undefined,
) {
  const userKey = userCacheKey(userId);
  const normalizedRuleId = validRuleId(ruleId);
  if (!userKey || !normalizedRuleId) return false;
  const invalidations = invalidationsByUser.get(userKey);
  const boundary = invalidations?.get(normalizedRuleId);
  if (!isAfterInvalidation(boundary, probe)) return false;
  if (boundary) {
    invalidations?.delete(normalizedRuleId);
    if (invalidations?.size === 0) invalidationsByUser.delete(userKey);
  }
  return true;
}

export function buildStableRuleProbeMap(
  userId: unknown,
  ruleIds: Iterable<number>,
  currentProbes: ReadonlyMap<number, RuleProbeSummary>,
  now = Date.now(),
  invalidatedRuleIds: ReadonlySet<number> = new Set<number>(),
) {
  const userKey = userCacheKey(userId);
  const cache = userKey ? probesByUser.get(userKey) : undefined;
  const stable = new Map<number, RuleProbeSummary>();

  for (const rawRuleId of ruleIds) {
    const ruleId = validRuleId(rawRuleId);
    if (!ruleId || invalidatedRuleIds.has(ruleId)) continue;
    const current = currentProbes.get(ruleId);
    const cached = cache?.get(ruleId);
    if (isValidProbe(current) && (!cached || probeTimestamp(current) >= probeTimestamp(cached))) {
      stable.set(ruleId, current!);
      continue;
    }
    if (cached && isFreshProbe(cached, now)) {
      stable.set(ruleId, cached);
      continue;
    }
    if (isValidProbe(current)) stable.set(ruleId, current!);
  }

  return stable;
}

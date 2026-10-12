/** Raw, reported latency samples stay in the panel's configured database. */
export const LATENCY_HISTORY_DAYS = 30;
export const LATENCY_HISTORY_HOURS = LATENCY_HISTORY_DAYS * 24;

/** Bound chart responses, not stored samples. Align buckets to whole minutes. */
export function latencyChartBucketSeconds(hours: number, maxPoints = 1440) {
  return Math.max(60, Math.ceil(hours * 3600 / Math.max(1, maxPoints - 1) / 60) * 60);
}

export function latencyHistoryCacheOptions(hours: number) {
  return { ttlMs: hours > 24 ? 60_000 : 5_000, staleMs: 0 };
}

/** Live rates are interval averages in bytes/second, never cumulative usage. */
export const HOST_NETWORK_SAMPLE_MAX_AGE_MS = 90_000;

type NetworkMetric = {
  recordedAt?: unknown;
  uptime?: unknown;
  networkIn?: unknown;
  networkOut?: unknown;
  networkSpeedIn?: unknown;
  networkSpeedOut?: unknown;
  networkSampleAgeMs?: unknown;
  networkSampleReceivedAt?: unknown;
};

function nonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestamp(value: unknown) {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}

/** Stamp once when a response arrives, not during rendering. Persisting this
 * stamp with cached metrics also prevents cached rates from looking new. */
export function stampHostNetworkMetrics<T extends NetworkMetric>(metrics: T[], receivedAt: number): T[] {
  return metrics.map((metric) => nonNegative(metric.networkSampleAgeMs) === null
    ? metric
    : { ...metric, networkSampleReceivedAt: receivedAt });
}

export function hostNetworkSampleAgeMs(metric: NetworkMetric, now = Date.now()): number | null {
  const at = timestamp(metric.recordedAt);
  return at === null ? null : Math.max(0, now - at);
}

export function hostNetworkSpeed(
  latest: NetworkMetric | null | undefined,
  previous?: NetworkMetric | null,
  options: { now?: number; isOnline?: boolean } = {},
): { in: number | null; out: number | null } {
  const unknown = { in: null, out: null };
  if (!latest || options.isOnline === false) return unknown;
  const now = options.now ?? Date.now();
  const latestAt = timestamp(latest.recordedAt);
  const receivedAt = timestamp(latest.networkSampleReceivedAt);
  const sampleAge = nonNegative(latest.networkSampleAgeMs);
  // Server and browser clocks need not agree. Use server-calculated age plus
  // time since receipt where available; old responses still use the legacy path.
  const hasReceipt = receivedAt !== null && sampleAge !== null;
  const age = hasReceipt ? sampleAge + Math.max(0, now - receivedAt) : latestAt === null ? Infinity : now - latestAt;
  if (latestAt === null || age > HOST_NETWORK_SAMPLE_MAX_AGE_MS
    || (hasReceipt ? receivedAt - now : latestAt - now) > 5_000) return unknown;
  // Explicit null is authoritative: never recalculate a rejected server sample.
  if (Object.hasOwn(latest, "networkSpeedIn") || Object.hasOwn(latest, "networkSpeedOut")) {
    return { in: nonNegative(latest.networkSpeedIn), out: nonNegative(latest.networkSpeedOut) };
  }
  if (!previous) return unknown;
  const previousAt = timestamp(previous.recordedAt);
  if (previousAt === null || latestAt <= previousAt || latestAt - previousAt > HOST_NETWORK_SAMPLE_MAX_AGE_MS) return unknown;
  let seconds = (latestAt - previousAt) / 1000;
  const latestUptime = nonNegative(latest.uptime), previousUptime = nonNegative(previous.uptime);
  if (latestUptime !== null && previousUptime !== null) {
    // Agent uptime follows collection time, not variable panel/network delays.
    // A reboot or two samples in the same uptime second cannot yield a rate.
    seconds = latestUptime - previousUptime;
    if (seconds <= 0 || seconds * 1000 > HOST_NETWORK_SAMPLE_MAX_AGE_MS) return unknown;
  }
  const rate = (current: unknown, prior: unknown) => {
    const a = nonNegative(current), b = nonNegative(prior);
    return a === null || b === null || a < b ? null : (a - b) / seconds;
  };
  return { in: rate(latest.networkIn, previous.networkIn), out: rate(latest.networkOut, previous.networkOut) };
}

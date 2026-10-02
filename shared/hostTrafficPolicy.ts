export type HostTrafficPolicy = {
  trafficLimit?: unknown;
  trafficMeasureMode?: unknown;
  trafficFailoverEnabled?: unknown;
  trafficFailoverThresholdPercent?: unknown;
  trafficFailoverExcluded?: unknown;
};

export function hostPolicyBool(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function hostTrafficUsageBytes(traffic: { bytesIn?: unknown; bytesOut?: unknown }, mode: unknown) {
  const bytesIn = Math.max(0, Number(traffic.bytesIn) || 0);
  const bytesOut = Math.max(0, Number(traffic.bytesOut) || 0);
  return mode === "outbound" ? bytesOut : mode === "max" ? Math.max(bytesIn, bytesOut) : bytesIn + bytesOut;
}

export function normalizeHostTrafficFailoverPercent(value: unknown) {
  const percent = Number(value ?? 100);
  return Number.isFinite(percent) ? Math.min(100, Math.max(1, Math.floor(percent))) : 100;
}

export function shouldExcludeHostForTraffic(host: HostTrafficPolicy, traffic: { bytesIn?: unknown; bytesOut?: unknown }) {
  const limit = Number(host.trafficLimit) || 0;
  return hostPolicyBool(host.trafficFailoverEnabled) && limit > 0
    && hostTrafficUsageBytes(traffic, host.trafficMeasureMode) >= limit * normalizeHostTrafficFailoverPercent(host.trafficFailoverThresholdPercent) / 100;
}

// The switch and limit remain authoritative, including during configuration
// changes before the persisted derived state has been recomputed.
export function hostTrafficExcluded(host: HostTrafficPolicy | null | undefined) {
  return !!host && hostPolicyBool(host.trafficFailoverEnabled) && Number(host.trafficLimit) > 0
    && hostPolicyBool(host.trafficFailoverExcluded);
}

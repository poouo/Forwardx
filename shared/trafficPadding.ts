/**
 * Optional cover-traffic settings for ForwardX V1.
 *
 * These values are deliberately separate from trafficMultiplier (which is a
 * billing setting).  A disabled configuration is represented by zero values
 * so older agents and runtimes retain exactly their normal forwarding path.
 */
export const TRAFFIC_PADDING_RATIO_MIN = 1;
export const TRAFFIC_PADDING_RATIO_MAX = 50;
export const TRAFFIC_PADDING_MAX_MBPS_MAX = 1_000;

export type TrafficPaddingFields = {
  trafficPaddingEnabled: boolean;
  trafficPaddingRatio: number;
  trafficPaddingMaxMbps: number;
};

export type TrafficPaddingRuntime = {
  mode?: unknown;
  forwardxVersion?: unknown;
};

export function trafficPaddingRuntimeSupported(runtime: TrafficPaddingRuntime = {}) {
  return String(runtime.mode || "").trim().toLowerCase() === "forwardx"
    && String(runtime.forwardxVersion || "v1").trim().toLowerCase() === "v1";
}
function asFiniteInt(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

/**
 * Normalize persisted/API values.  Unsupported runtimes and disabled values
 * always collapse to the all-zero representation.
 */
export function normalizeTrafficPadding(
  value: Partial<TrafficPaddingFields> | null | undefined,
  runtime: TrafficPaddingRuntime = {},
): TrafficPaddingFields {
  const enabled = value?.trafficPaddingEnabled === true;
  if (!enabled || !trafficPaddingRuntimeSupported(runtime)) {
    return { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 };
  }
  const ratio = Math.min(
    TRAFFIC_PADDING_RATIO_MAX,
    Math.max(TRAFFIC_PADDING_RATIO_MIN, asFiniteInt(value?.trafficPaddingRatio)),
  );
  const maxMbps = Math.min(
    TRAFFIC_PADDING_MAX_MBPS_MAX,
    Math.max(0, asFiniteInt(value?.trafficPaddingMaxMbps)),
  );
  return { trafficPaddingEnabled: true, trafficPaddingRatio: ratio, trafficPaddingMaxMbps: maxMbps };
}

export function trafficPaddingInputIsValid(value: Partial<TrafficPaddingFields> | null | undefined) {
  if (value?.trafficPaddingEnabled !== true) return true;
  const ratio = Number(value?.trafficPaddingRatio);
  const maxMbps = Number(value?.trafficPaddingMaxMbps);
  return Number.isInteger(ratio)
    && ratio >= TRAFFIC_PADDING_RATIO_MIN
    && ratio <= TRAFFIC_PADDING_RATIO_MAX
    && Number.isInteger(maxMbps)
    && maxMbps >= 0
    && maxMbps <= TRAFFIC_PADDING_MAX_MBPS_MAX;
}

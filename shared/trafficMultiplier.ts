export const TRAFFIC_MULTIPLIER_SCALE = 100;
export const TRAFFIC_MULTIPLIER_DEFAULT = 100;
export const TRAFFIC_MULTIPLIER_MIN = 1;
export const TRAFFIC_MULTIPLIER_MAX = 5000;

export function normalizeTrafficMultiplier(value: unknown, fallback = TRAFFIC_MULTIPLIER_DEFAULT) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return normalizeTrafficMultiplier(fallback, TRAFFIC_MULTIPLIER_DEFAULT);
  return Math.min(TRAFFIC_MULTIPLIER_MAX, Math.max(TRAFFIC_MULTIPLIER_MIN, n));
}

export function trafficMultiplierFromInput(value: unknown) {
  return normalizeTrafficMultiplier(Math.round(Number(value) * TRAFFIC_MULTIPLIER_SCALE));
}

export function trafficMultiplierToInputValue(value: unknown) {
  return normalizeTrafficMultiplier(value) / TRAFFIC_MULTIPLIER_SCALE;
}

export function formatTrafficMultiplier(value: unknown) {
  const multiplier = trafficMultiplierToInputValue(value);
  const text = multiplier.toFixed(2).replace(/\.?0+$/, "");
  return `${text}x`;
}

export function applyTrafficMultiplier(bytes: number, multiplier: unknown) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  return Math.round((safeBytes * normalizeTrafficMultiplier(multiplier)) / TRAFFIC_MULTIPLIER_SCALE);
}

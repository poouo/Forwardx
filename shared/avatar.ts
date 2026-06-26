export const AVATAR_MAX_BYTES = 50 * 1024;
export const AVATAR_MAX_DATA_URL_LENGTH = 90 * 1024;
export const BRAND_LOGO_MAX_BYTES = 100 * 1024;
export const BRAND_LOGO_MAX_DATA_URL_LENGTH = 150 * 1024;
export const MULTIAVATAR_PREFIX = "multiavatar:";
export const LEGACY_AVATAR_PRESET_PREFIX = "preset:";
export const AVATAR_DAILY_CHANGE_LIMIT = 3;
export const AVATAR_RANDOM_WINDOW_MS = 60 * 1000;
export const AVATAR_RANDOM_WINDOW_LIMIT = 10;

const MULTIAVATAR_RE = /^multiavatar:[a-z0-9_-]{1,80}$/i;
const LEGACY_PRESET_RE = /^preset:[a-z0-9_-]{1,80}$/i;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

function normalizeSeed(seed: string) {
  return String(seed || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function multiavatarValue(seed: string) {
  return `${MULTIAVATAR_PREFIX}${normalizeSeed(seed) || "forwardx"}`;
}

function randomSeed(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function randomMultiavatarValue(seed: string = randomSeed()) {
  return multiavatarValue(seed);
}

export function isMultiavatarValue(value?: string | null) {
  return MULTIAVATAR_RE.test(String(value || ""));
}

export function isLegacyAvatarPreset(value?: string | null) {
  return LEGACY_PRESET_RE.test(String(value || ""));
}

export function migrateLegacyAvatarValue(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (isMultiavatarValue(text)) return text;
  if (isLegacyAvatarPreset(text)) return multiavatarValue(text.slice(LEGACY_AVATAR_PRESET_PREFIX.length));
  return multiavatarValue(String(fallback || "forwardx"));
}

export function multiavatarSeedFromValue(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (isMultiavatarValue(text)) return text.slice(MULTIAVATAR_PREFIX.length);
  if (isLegacyAvatarPreset(text)) return text.slice(LEGACY_AVATAR_PRESET_PREFIX.length);
  return normalizeSeed(String(fallback || "forwardx"));
}

export function getAvatarDataUrlByteLength(value: string) {
  const text = String(value || "");
  const marker = ";base64,";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return new TextEncoder().encode(text).length;
  const base64 = text.slice(markerIndex + marker.length).replace(/\s/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function isValidAvatarValue(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (isMultiavatarValue(text)) return true;
  if (text.length > AVATAR_MAX_DATA_URL_LENGTH) return false;
  if (!IMAGE_DATA_URL_RE.test(text)) return false;
  return getAvatarDataUrlByteLength(text) <= AVATAR_MAX_BYTES;
}

export function normalizeAvatarValue(value?: string | null) {
  const text = String(value || "").trim();
  return isValidAvatarValue(text) ? text : null;
}

export function isValidBrandLogoValue(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (text.length > BRAND_LOGO_MAX_DATA_URL_LENGTH) return false;
  if (!IMAGE_DATA_URL_RE.test(text)) return false;
  return getAvatarDataUrlByteLength(text) <= BRAND_LOGO_MAX_BYTES;
}

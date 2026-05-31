export const AVATAR_MAX_BYTES = 50 * 1024;
export const AVATAR_MAX_DATA_URL_LENGTH = 90 * 1024;
export const AVATAR_PRESET_PREFIX = "preset:";
export const AVATAR_DAILY_CHANGE_LIMIT = 3;

export const DEFAULT_AVATAR_SEEDS = [
  "nova",
  "orbit",
  "ember",
  "pixel",
  "mint",
  "coral",
  "sunrise",
  "aurora",
  "cobalt",
  "meadow",
  "plum",
  "lagoon",
];

const PRESET_RE = /^preset:[a-z0-9_-]{1,48}$/i;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

export function avatarPreset(seed: string) {
  const normalized = String(seed || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${AVATAR_PRESET_PREFIX}${normalized || "nova"}`;
}

export function randomAvatarPreset() {
  const seed = DEFAULT_AVATAR_SEEDS[Math.floor(Math.random() * DEFAULT_AVATAR_SEEDS.length)] || "nova";
  return avatarPreset(`${seed}-${Math.random().toString(36).slice(2, 8)}`);
}

export function isAvatarPreset(value?: string | null) {
  return PRESET_RE.test(String(value || ""));
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
  if (isAvatarPreset(text)) return true;
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
  if (text.length > AVATAR_MAX_DATA_URL_LENGTH) return false;
  if (!IMAGE_DATA_URL_RE.test(text)) return false;
  return getAvatarDataUrlByteLength(text) <= AVATAR_MAX_BYTES;
}

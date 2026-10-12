export const AVATAR_MAX_BYTES = 50 * 1024;
export const AVATAR_MAX_DATA_URL_LENGTH = 90 * 1024;
export const BRAND_LOGO_MAX_BYTES = 100 * 1024;
export const BRAND_LOGO_MAX_DATA_URL_LENGTH = 150 * 1024;
export const AVATAAARS_PREFIX = "avataaars:";
export const MULTIAVATAR_PREFIX = "multiavatar:";
export const LEGACY_AVATAR_PRESET_PREFIX = "preset:";
export const AVATAR_DAILY_CHANGE_LIMIT = 3;
export const AVATAR_RANDOM_WINDOW_MS = 60 * 1000;
export const AVATAR_RANDOM_WINDOW_LIMIT = 10;

export const BUILTIN_AVATAR_PREFIX = "builtin:";
export const BUILTIN_AVATARS = [
  { id: "ink-mountains", name: "水墨青山", nameEn: "Ink Mountains" },
  { id: "jiangnan-bridge", name: "烟雨江南", nameEn: "Jiangnan Bridge" },
  { id: "hanfu-woman", name: "青衣花影", nameEn: "Jade Blossom" },
  { id: "hanfu-man", name: "竹影公子", nameEn: "Bamboo Scholar" },
  { id: "crane-moon", name: "月下仙鹤", nameEn: "Moonlit Crane" },
  { id: "koi", name: "锦鲤游春", nameEn: "Spring Koi" },
  { id: "panda", name: "竹林熊猫", nameEn: "Bamboo Panda" },
  { id: "moon-rabbit", name: "桂月玉兔", nameEn: "Moon Rabbit" },
  { id: "celadon-tea", name: "青瓷茶韵", nameEn: "Celadon Tea" },
  { id: "dunhuang-lotus", name: "敦煌飞花", nameEn: "Dunhuang Lotus" },
  { id: "snow-plum", name: "踏雪寻梅", nameEn: "Snowy Plum" },
  { id: "pink-lotus", name: "荷风清韵", nameEn: "Pink Lotus" },
  { id: "ginger-cat", name: "花间橘猫", nameEn: "Garden Cat" },
  { id: "blue-dragon", name: "祥云青龙", nameEn: "Cloud Dragon" },
  { id: "starry-peaks", name: "雪山星河", nameEn: "Starry Peaks" },
  { id: "ginkgo-temple", name: "银杏古寺", nameEn: "Ginkgo Temple" },
  { id: "paper-swallow", name: "剪纸春燕", nameEn: "Paper Swallow" },
  { id: "porcelain-lotus", name: "青花莲韵", nameEn: "Porcelain Lotus" },
  { id: "neon-pavilion", name: "霓虹楼阁", nameEn: "Neon Pavilion" },
  { id: "cloud-sunrise", name: "云海朝阳", nameEn: "Cloud Sunrise" },
] as const;

export type BuiltinAvatarId = typeof BUILTIN_AVATARS[number]["id"];

export function builtinAvatarValue(id: BuiltinAvatarId) {
  return `${BUILTIN_AVATAR_PREFIX}${id}`;
}

export function isBuiltinAvatarValue(value?: string | null) {
  return BUILTIN_AVATARS.some((avatar) => builtinAvatarValue(avatar.id) === value);
}

// Map old generated avatars deterministically without rewriting user records.
export function builtinAvatarForSeed(seed: string | number) {
  let hash = 2166136261;
  for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return builtinAvatarValue(BUILTIN_AVATARS[(hash >>> 0) % BUILTIN_AVATARS.length].id);
}

export function randomBuiltinAvatarValue(exclude?: string | null) {
  const choices = BUILTIN_AVATARS.filter((avatar) => builtinAvatarValue(avatar.id) !== exclude);
  return builtinAvatarValue(choices[Math.floor(Math.random() * choices.length)].id);
}

export function builtinAvatarPath(value?: string | null, fallback?: string | number | null) {
  const normalized = isBuiltinAvatarValue(value) ? String(value) : builtinAvatarForSeed(avatarSeedFromValue(value, fallback));
  return `/avatars/${normalized.slice(BUILTIN_AVATAR_PREFIX.length)}.webp`;
}

const AVATAAARS_RE = /^avataaars:[a-z0-9_-]{1,80}$/i;
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

export function isAvataaarsValue(value?: string | null) {
  return AVATAAARS_RE.test(String(value || ""));
}

export function isMultiavatarValue(value?: string | null) {
  return MULTIAVATAR_RE.test(String(value || ""));
}

export function isLegacyAvatarPreset(value?: string | null) {
  return LEGACY_PRESET_RE.test(String(value || ""));
}

export function migrateLegacyAvatarValue(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (isBuiltinAvatarValue(text) || (IMAGE_DATA_URL_RE.test(text) && isValidAvatarValue(text))) return text;
  return builtinAvatarForSeed(avatarSeedFromValue(text, fallback));
}

export function avatarSeedFromValue(value?: string | null, fallback?: string | number | null) {
  const text = String(value || "").trim();
  if (isAvataaarsValue(text)) return text.slice(AVATAAARS_PREFIX.length);
  if (isMultiavatarValue(text)) return text.slice(MULTIAVATAR_PREFIX.length);
  if (isLegacyAvatarPreset(text)) return text.slice(LEGACY_AVATAR_PRESET_PREFIX.length);
  return normalizeSeed(String(fallback || "forwardx"));
}

export const multiavatarSeedFromValue = avatarSeedFromValue;

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
  if (isBuiltinAvatarValue(text)) return true;
  if (isAvataaarsValue(text)) return true;
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

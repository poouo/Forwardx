export const BUILTIN_WALLPAPERS = [
  { id: "anime-1", name: "插画 1", url: "/wallpapers/anime-1.jpg" },
  { id: "anime-2", name: "二次元 2", url: "/wallpapers/anime-2.jpg" },
  { id: "anime-3", name: "二次元 3", url: "/wallpapers/anime-3.jpg" },
  { id: "anime-4", name: "二次元 4", url: "/wallpapers/anime-4.jpg" },
  { id: "illustration-1", name: "二次元 1", url: "/wallpapers/illustration-1.jpg" },
] as const;

export type BuiltinWallpaperId = typeof BUILTIN_WALLPAPERS[number]["id"];

export type PersonalizationBackgroundSource = "none" | "builtin" | "upload" | "url";
export type PersonalizationBackgroundUrlType = "image" | "video";

export type PersonalizationBackgroundImage = {
  id: string;
  name: string;
  dataUrl: string;
  size?: number;
  createdAt?: number;
};

export type PersonalizationBackgroundConfig = {
  source: PersonalizationBackgroundSource;
  opacity: number;
  blur: number;
  selectedId: string | null;
  url: string;
  urlType: PersonalizationBackgroundUrlType;
  images: PersonalizationBackgroundImage[];
};

export const DEFAULT_PERSONALIZATION_BACKGROUND: PersonalizationBackgroundConfig = {
  source: "none",
  opacity: 0.22,
  blur: 0,
  selectedId: null,
  url: "",
  urlType: "image",
  images: [],
};

export function isBuiltinWallpaperId(value: unknown): value is BuiltinWallpaperId {
  return BUILTIN_WALLPAPERS.some((item) => item.id === value);
}

export function builtinWallpaperById(value: unknown) {
  return BUILTIN_WALLPAPERS.find((item) => item.id === value) || null;
}

export function clampBackgroundOpacity(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.opacity;
  return Math.min(0.85, Math.max(0, num));
}

export function clampBackgroundBlur(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.blur;
  return Math.min(32, Math.max(0, num));
}

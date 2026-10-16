export const BUILTIN_WALLPAPERS = [
  { id: "anime-1", name: "插画 1", url: "/wallpapers/anime-1.jpg" },
  { id: "anime-2", name: "二次元 2", url: "/wallpapers/anime-2.jpg" },
  { id: "anime-3", name: "二次元 3", url: "/wallpapers/anime-3.jpg" },
  { id: "anime-4", name: "二次元 4", url: "/wallpapers/anime-4.jpg" },
  { id: "illustration-1", name: "二次元 1", url: "/wallpapers/illustration-1.jpg" },
] as const;

export type BuiltinWallpaperId = typeof BUILTIN_WALLPAPERS[number]["id"];

export const PERSONALIZATION_THEME_PRESETS = [
  {
    id: "ink",
    name: "墨色",
    description: "克制深墨主色，适合当前胶囊式界面。",
    swatches: ["#0e1116", "#e8ecef", "#5d666f"],
    light: {
      primary: "oklch(0.20 0.015 260)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.42 0.02 260)",
      accent: "oklch(0.93 0.01 260)",
      accentForeground: "oklch(0.18 0.015 260)",
      sidebarAccent: "oklch(0.93 0.01 260)",
      sidebarAccentForeground: "oklch(0.18 0.015 260)",
      sidebarPrimary: "oklch(0.20 0.015 260)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.42 0.02 260)",
      glow: "rgb(24 28 36 / 14%)",
      chart1: "oklch(0.56 0.12 170)",
      chart2: "oklch(0.62 0.16 150)",
      chart3: "oklch(0.58 0.08 260)",
      chart4: "oklch(0.68 0.14 80)",
    },
    dark: {
      primary: "oklch(0.93 0.005 260)",
      primaryForeground: "oklch(0.14 0.01 260)",
      ring: "oklch(0.74 0.02 260)",
      accent: "oklch(0.24 0.015 260)",
      accentForeground: "oklch(0.94 0.005 260)",
      sidebarAccent: "oklch(0.24 0.015 260)",
      sidebarAccentForeground: "oklch(0.94 0.005 260)",
      sidebarPrimary: "oklch(0.93 0.005 260)",
      sidebarPrimaryForeground: "oklch(0.14 0.01 260)",
      sidebarRing: "oklch(0.74 0.02 260)",
      glow: "rgb(255 255 255 / 10%)",
      chart1: "oklch(0.72 0.14 165)",
      chart2: "oklch(0.75 0.18 150)",
      chart3: "oklch(0.70 0.08 260)",
      chart4: "oklch(0.78 0.14 80)",
    },
  },
  {
    id: "teal",
    name: "松石",
    description: "清爽青绿色，和浅色玻璃背景更协调。",
    swatches: ["#0f766e", "#99f6e4", "#134e4a"],
    light: {
      primary: "oklch(0.50 0.14 180)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.12 180)",
      accent: "oklch(0.93 0.04 180)",
      accentForeground: "oklch(0.28 0.12 180)",
      sidebarAccent: "oklch(0.93 0.04 180)",
      sidebarAccentForeground: "oklch(0.28 0.12 180)",
      sidebarPrimary: "oklch(0.50 0.14 180)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.12 180)",
      glow: "rgb(15 118 110 / 25%)",
      chart1: "oklch(0.58 0.13 178)",
      chart2: "oklch(0.64 0.14 165)",
      chart3: "oklch(0.58 0.10 205)",
      chart4: "oklch(0.70 0.13 95)",
    },
    dark: {
      primary: "oklch(0.74 0.14 180)",
      primaryForeground: "oklch(0.12 0.03 185)",
      ring: "oklch(0.74 0.11 180)",
      accent: "oklch(0.24 0.05 180)",
      accentForeground: "oklch(0.88 0.11 180)",
      sidebarAccent: "oklch(0.24 0.05 180)",
      sidebarAccentForeground: "oklch(0.88 0.11 180)",
      sidebarPrimary: "oklch(0.74 0.14 180)",
      sidebarPrimaryForeground: "oklch(0.12 0.03 185)",
      sidebarRing: "oklch(0.74 0.11 180)",
      glow: "rgb(45 212 191 / 25%)",
      chart1: "oklch(0.72 0.14 180)",
      chart2: "oklch(0.76 0.14 165)",
      chart3: "oklch(0.72 0.10 205)",
      chart4: "oklch(0.80 0.13 95)",
    },
  },
  {
    id: "forest",
    name: "森绿",
    description: "偏稳重的绿色，适合运维和资源管理场景。",
    swatches: ["#166534", "#86efac", "#14532d"],
    light: {
      primary: "oklch(0.46 0.14 145)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.54 0.12 145)",
      accent: "oklch(0.93 0.04 145)",
      accentForeground: "oklch(0.26 0.12 145)",
      sidebarAccent: "oklch(0.93 0.04 145)",
      sidebarAccentForeground: "oklch(0.26 0.12 145)",
      sidebarPrimary: "oklch(0.46 0.14 145)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.54 0.12 145)",
      glow: "rgb(22 101 52 / 25%)",
      chart1: "oklch(0.56 0.13 145)",
      chart2: "oklch(0.60 0.15 135)",
      chart3: "oklch(0.50 0.10 170)",
      chart4: "oklch(0.70 0.13 95)",
    },
    dark: {
      primary: "oklch(0.74 0.15 145)",
      primaryForeground: "oklch(0.12 0.03 150)",
      ring: "oklch(0.74 0.11 145)",
      accent: "oklch(0.24 0.05 145)",
      accentForeground: "oklch(0.88 0.11 145)",
      sidebarAccent: "oklch(0.24 0.05 145)",
      sidebarAccentForeground: "oklch(0.88 0.11 145)",
      sidebarPrimary: "oklch(0.74 0.15 145)",
      sidebarPrimaryForeground: "oklch(0.12 0.03 150)",
      sidebarRing: "oklch(0.74 0.11 145)",
      glow: "rgb(74 222 128 / 25%)",
      chart1: "oklch(0.72 0.14 145)",
      chart2: "oklch(0.76 0.15 135)",
      chart3: "oklch(0.70 0.10 170)",
      chart4: "oklch(0.80 0.13 95)",
    },
  },
  {
    id: "wisteria",
    name: "紫藤",
    description: "低饱和紫色，保留一点个性但不刺眼。",
    swatches: ["#6d28d9", "#ddd6fe", "#312e81"],
    light: {
      primary: "oklch(0.48 0.16 295)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.58 0.12 295)",
      accent: "oklch(0.94 0.04 295)",
      accentForeground: "oklch(0.32 0.14 295)",
      sidebarAccent: "oklch(0.94 0.04 295)",
      sidebarAccentForeground: "oklch(0.32 0.14 295)",
      sidebarPrimary: "oklch(0.48 0.16 295)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.58 0.12 295)",
      glow: "rgb(124 58 237 / 25%)",
      chart1: "oklch(0.56 0.13 300)",
      chart2: "oklch(0.62 0.11 330)",
      chart3: "oklch(0.58 0.12 270)",
      chart4: "oklch(0.70 0.12 25)",
    },
    dark: {
      primary: "oklch(0.76 0.15 295)",
      primaryForeground: "oklch(0.14 0.03 295)",
      ring: "oklch(0.76 0.11 295)",
      accent: "oklch(0.24 0.06 295)",
      accentForeground: "oklch(0.89 0.11 295)",
      sidebarAccent: "oklch(0.24 0.06 295)",
      sidebarAccentForeground: "oklch(0.89 0.11 295)",
      sidebarPrimary: "oklch(0.76 0.15 295)",
      sidebarPrimaryForeground: "oklch(0.14 0.03 295)",
      sidebarRing: "oklch(0.76 0.11 295)",
      glow: "rgb(192 132 252 / 25%)",
      chart1: "oklch(0.74 0.13 300)",
      chart2: "oklch(0.78 0.11 330)",
      chart3: "oklch(0.74 0.12 270)",
      chart4: "oklch(0.80 0.12 25)",
    },
  },
  {
    id: "ember",
    name: "暖阳",
    description: "温暖琥珀色，适合偏活泼的面板风格。",
    swatches: ["#92400e", "#fcd34d", "#451a03"],
    light: {
      primary: "oklch(0.52 0.16 65)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.62 0.12 65)",
      accent: "oklch(0.94 0.04 65)",
      accentForeground: "oklch(0.34 0.13 65)",
      sidebarAccent: "oklch(0.94 0.04 65)",
      sidebarAccentForeground: "oklch(0.34 0.13 65)",
      sidebarPrimary: "oklch(0.52 0.16 65)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.62 0.12 65)",
      glow: "rgb(217 119 6 / 25%)",
      chart1: "oklch(0.62 0.14 75)",
      chart2: "oklch(0.66 0.13 45)",
      chart3: "oklch(0.58 0.11 85)",
      chart4: "oklch(0.70 0.14 30)",
    },
    dark: {
      primary: "oklch(0.78 0.15 65)",
      primaryForeground: "oklch(0.16 0.04 65)",
      ring: "oklch(0.78 0.11 65)",
      accent: "oklch(0.25 0.05 65)",
      accentForeground: "oklch(0.90 0.11 65)",
      sidebarAccent: "oklch(0.25 0.05 65)",
      sidebarAccentForeground: "oklch(0.90 0.11 65)",
      sidebarPrimary: "oklch(0.78 0.15 65)",
      sidebarPrimaryForeground: "oklch(0.16 0.04 65)",
      sidebarRing: "oklch(0.78 0.11 65)",
      glow: "rgb(251 191 36 / 25%)",
      chart1: "oklch(0.78 0.14 75)",
      chart2: "oklch(0.80 0.13 45)",
      chart3: "oklch(0.76 0.11 85)",
      chart4: "oklch(0.82 0.14 30)",
    },
  },
  {
    id: "sakura",
    name: "樱粉",
    description: "偏少女感的泡泡糖粉，适合柔和甜一点的面板风格。",
    swatches: ["#ff4fa3", "#ffd6ea", "#c4b5fd"],
    light: {
      primary: "oklch(0.58 0.20 350)",
      primaryForeground: "oklch(0.98 0 0)",
      ring: "oklch(0.70 0.14 350)",
      accent: "oklch(0.95 0.04 350)",
      accentForeground: "oklch(0.38 0.16 350)",
      sidebarAccent: "oklch(0.95 0.04 350)",
      sidebarAccentForeground: "oklch(0.38 0.16 350)",
      sidebarPrimary: "oklch(0.58 0.20 350)",
      sidebarPrimaryForeground: "oklch(0.98 0 0)",
      sidebarRing: "oklch(0.70 0.14 350)",
      glow: "rgb(236 72 153 / 25%)",
      chart1: "oklch(0.74 0.16 350)",
      chart2: "oklch(0.86 0.08 15)",
      chart3: "oklch(0.80 0.12 325)",
      chart4: "oklch(0.82 0.10 285)",
    },
    dark: {
      primary: "oklch(0.82 0.16 350)",
      primaryForeground: "oklch(0.16 0.04 350)",
      ring: "oklch(0.82 0.12 350)",
      accent: "oklch(0.25 0.06 350)",
      accentForeground: "oklch(0.92 0.11 350)",
      sidebarAccent: "oklch(0.25 0.06 350)",
      sidebarAccentForeground: "oklch(0.92 0.11 350)",
      sidebarPrimary: "oklch(0.82 0.16 350)",
      sidebarPrimaryForeground: "oklch(0.16 0.04 350)",
      sidebarRing: "oklch(0.82 0.12 350)",
      glow: "rgb(244 114 182 / 25%)",
      chart1: "oklch(0.86 0.14 350)",
      chart2: "oklch(0.90 0.08 15)",
      chart3: "oklch(0.88 0.11 325)",
      chart4: "oklch(0.86 0.10 285)",
    },
  },
] as const;

export type PersonalizationThemePresetId = typeof PERSONALIZATION_THEME_PRESETS[number]["id"];

export function normalizePersonalizationThemePresetId(value: unknown): PersonalizationThemePresetId {
  const text = String(value || "").trim();
  return PERSONALIZATION_THEME_PRESETS.some((preset) => preset.id === text)
    ? text as PersonalizationThemePresetId
    : "ink";
}

export function getPersonalizationThemePreset(value: unknown) {
  const id = normalizePersonalizationThemePresetId(value);
  return PERSONALIZATION_THEME_PRESETS.find((preset) => preset.id === id) || PERSONALIZATION_THEME_PRESETS[0];
}

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
  return Math.min(1, Math.max(0, num));
}

export function clampBackgroundBlur(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_PERSONALIZATION_BACKGROUND.blur;
  return Math.min(32, Math.max(0, num));
}

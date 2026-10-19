import { PERSONALIZATION_THEME_PRESETS, normalizePersonalizationThemePresetId } from "./personalization";

export const DEFAULT_APP_ICON = "ink-light";
export const APP_ICON_VARIANTS = PERSONALIZATION_THEME_PRESETS.flatMap(preset =>
  (["light", "dark"] as const).map(appearance => ({
    key: `${preset.id}-${appearance}`,
    theme: preset.id,
    appearance,
    primary: preset[appearance].primary,
    name: `AppIcon${pascalCase(preset.id)}${pascalCase(appearance)}`,
    launcher: `Launcher${pascalCase(preset.id)}${pascalCase(appearance)}`,
  })),
);

function pascalCase(value: string) {
  return value.replace(/(^|-)([a-z])/g, (_, _separator, letter: string) => letter.toUpperCase());
}

export function appIconKey(theme: unknown, dark: boolean) {
  return `${normalizePersonalizationThemePresetId(theme)}-${dark ? "dark" : "light"}`;
}

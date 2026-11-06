import { TRPCError } from "@trpc/server";
import { BUILTIN_THEMES, THEME_LIMITS, type ThemeDefinition, type ThemeSummary } from "../../shared/themes";
import { normalizePersonalizationThemePresetId } from "../../shared/personalization";
import { getSetting, getSettings, setSettings } from "./settingsRepository";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { parseThemePackage } from "../themePackage";

const REGISTRY = "personalizationThemePackages";
const ACTIVE = "personalizationActiveTheme";
export const THEME_SETTINGS_LOCK = "system-settings:themes";

function readRegistry(raw: string | null): ThemeDefinition[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("主题存储数据无效");
  return value as ThemeDefinition[];
}

function summary(theme: ThemeDefinition): ThemeSummary {
  const { id, name, version, base, description, author } = theme.manifest;
  return { id, name, version, base, description: description || "", author: author || "", builtin: false, revision: theme.revision };
}

/** Small descriptor only: publicInfo must never include the installed archive registry. */
export function activeThemeSummary(settings: Record<string, string | null>): ThemeSummary {
  try {
    const value = JSON.parse(settings[ACTIVE] || "null") as ThemeSummary | null;
    if (value && !value.builtin && /^[a-z][a-z0-9-]{2,63}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.revision)) return value;
  } catch { /* Invalid/legacy descriptors fall back to the existing palette. */ }
  return BUILTIN_THEMES.find(theme => theme.id === normalizePersonalizationThemePresetId(settings.personalizationTheme))!;
}

export async function listThemes() {
  const settings = await getSettings([REGISTRY, ACTIVE, "personalizationTheme"]);
  return { active: activeThemeSummary(settings), themes: [...BUILTIN_THEMES, ...readRegistry(settings[REGISTRY]).map(summary)] };
}

export async function themeDefinition(id: string) {
  const theme = readRegistry(await getSetting(REGISTRY)).find(item => item.manifest.id === id);
  if (!theme) throw new TRPCError({ code: "NOT_FOUND", message: "主题不存在" });
  return theme;
}

export async function installTheme(archive: Buffer, replace: boolean) {
  let parsed: ThemeDefinition;
  try { parsed = await parseThemePackage(archive); }
  catch (cause) { throw new TRPCError({ code: "BAD_REQUEST", message: cause instanceof Error ? cause.message : "主题压缩包无效", cause }); }
  return withKeyedTaskLock(THEME_SETTINGS_LOCK, async () => {
    const settings = await getSettings([REGISTRY, ACTIVE, "personalizationTheme"]);
    const themes = readRegistry(settings[REGISTRY]);
    const index = themes.findIndex(item => item.manifest.id === parsed.manifest.id);
    if (index >= 0 && !replace) throw new TRPCError({ code: "CONFLICT", message: "相同 ID 的主题已安装，请勾选替换后重新上传" });
    // Installing/replacing never changes the visible theme without an explicit activate.
    if (index >= 0 && activeThemeSummary(settings).id === parsed.manifest.id) {
      throw new TRPCError({ code: "CONFLICT", message: "请先切换到其他主题，再替换当前主题" });
    }
    if (index >= 0) themes[index] = parsed;
    else {
      if (themes.length >= THEME_LIMITS.installed) throw new TRPCError({ code: "BAD_REQUEST", message: "最多安装 12 个自定义主题" });
      themes.push(parsed);
    }
    const encoded = JSON.stringify(themes);
    if (Buffer.byteLength(encoded) > THEME_LIMITS.registryBytes) throw new TRPCError({ code: "BAD_REQUEST", message: "主题总存储超过 16MB，请删除部分主题" });
    await setSettings({ [REGISTRY]: encoded });
    return summary(parsed);
  });
}

export async function activateTheme(id: string) {
  return withKeyedTaskLock(THEME_SETTINGS_LOCK, async () => {
    const builtin = BUILTIN_THEMES.find(theme => theme.id === id);
    const selected = builtin || summary(await themeDefinition(id));
    await setSettings({ personalizationTheme: selected.base, [ACTIVE]: selected.builtin ? null : JSON.stringify(selected) });
    return selected;
  });
}

export async function removeTheme(id: string) {
  return withKeyedTaskLock(THEME_SETTINGS_LOCK, async () => {
    if (BUILTIN_THEMES.some(theme => theme.id === id)) throw new TRPCError({ code: "BAD_REQUEST", message: "内置主题不能删除" });
    const settings = await getSettings([REGISTRY, ACTIVE, "personalizationTheme"]);
    if (activeThemeSummary(settings).id === id) throw new TRPCError({ code: "CONFLICT", message: "请先切换到其他主题，再删除当前主题" });
    const themes = readRegistry(settings[REGISTRY]);
    if (!themes.some(theme => theme.manifest.id === id)) throw new TRPCError({ code: "NOT_FOUND", message: "主题不存在" });
    await setSettings({ [REGISTRY]: JSON.stringify(themes.filter(theme => theme.manifest.id !== id)) });
    return { success: true };
  });
}

export async function publicThemeStyles(id: string, revision: string) {
  const active = activeThemeSummary(await getSettings([ACTIVE, "personalizationTheme"]));
  if (active.builtin || active.id !== id || active.revision !== revision) throw new TRPCError({ code: "NOT_FOUND", message: "主题已切换，请刷新页面" });
  const theme = await themeDefinition(id);
  if (theme.revision !== revision) throw new TRPCError({ code: "NOT_FOUND", message: "主题版本已变更" });
  return theme;
}

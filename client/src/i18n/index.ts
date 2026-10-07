import english from "./en.json";
import { interpolate, LANGUAGE_STORAGE_KEY, parseLanguagePreference, resolveLanguage, type Language, type LanguagePreference } from "./language";

export { LANGUAGE_STORAGE_KEY, type Language, type LanguagePreference } from "./language";

function readPreference(): LanguagePreference {
  try { return parseLanguagePreference(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)); }
  catch { return "auto"; }
}
function getBrowserLanguages(): readonly string[] {
  return typeof window === "undefined" || typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
}

let preference = readPreference();
let language: Language = resolveLanguage(preference, getBrowserLanguages());
let initializationVersion = 0;

export function getLanguage() { return language; }
export function getLanguagePreference() { return preference; }
export function getFormatLocale() { return language === "en" ? "en-US" : "zh-CN"; }

export function t(source: string, values?: readonly unknown[]): string {
  const translated = language === "en" && Object.hasOwn(english, source)
    ? (english as Record<string, string>)[source]
    : source;
  return interpolate(translated, values);
}

export function setLanguagePreference(next: LanguagePreference): boolean {
  try {
    if (next === "auto") globalThis.localStorage?.removeItem(LANGUAGE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next);
    // If persistence is blocked, preserve the choice for this tab across reload.
    globalThis.sessionStorage?.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    try { globalThis.sessionStorage?.setItem(LANGUAGE_STORAGE_KEY, next); }
    catch { return false; }
  }
  preference = next;
  return true;
}

export async function initializeLanguage(panelBase = "") {
  const version = ++initializationVersion;
  try {
    const temporary = globalThis.sessionStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (temporary) preference = parseLanguagePreference(temporary);
  } catch { /* storage may be disabled */ }
  let country: string | undefined;
  let setupLanguage: Language | undefined;
  if (preference === "auto") {
    try {
      const response = await fetch(`${panelBase}/api/locale`, { signal: AbortSignal.timeout(1500), credentials: "omit" });
      if (response.ok) {
        const hint = await response.json();
        if (typeof hint.country === "string") country = hint.country;
        if (hint.setupLanguage === "zh-CN" || hint.setupLanguage === "en") setupLanguage = hint.setupLanguage;
      }
    } catch { /* locale detection must not make the panel unavailable */ }
  }
  if (version !== initializationVersion) return;
  language = preference === "auto" && setupLanguage ? setupLanguage : resolveLanguage(preference, getBrowserLanguages(), country);
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

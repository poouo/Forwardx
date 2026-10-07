export type Language = "zh-CN" | "en";
export type LanguagePreference = Language | "auto";
export const LANGUAGE_STORAGE_KEY = "forwardx.language";

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh-CN" ? value : "auto";
}

export function browserLanguage(languages: readonly string[]): Language | null {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return null;
}

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[], country?: string | null): Language {
  if (preference !== "auto") return preference;
  const browser = browserLanguage(languages);
  if (browser) return browser;
  if (country && /^[A-Z]{2}$/.test(country)) {
    return ["CN", "TW", "HK", "MO"].includes(country) ? "zh-CN" : "en";
  }
  // Keep the existing language when no reliable language/country hint exists.
  return "zh-CN";
}

export function interpolate(text: string, values: readonly unknown[] = []): string {
  // One pass: placeholder-like text in a username/hostname is never re-expanded.
  return text.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < values.length ? String(values[Number(index)] ?? "") : placeholder);
}

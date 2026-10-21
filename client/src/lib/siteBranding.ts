import { mobileAuth } from "./mobileAuth";
import { isValidBrandLogoValue } from "@shared/avatar";

const PREFIX = "forwardx.branding.v1:";
const MAX_BYTES = 200_000;
export type SiteBranding = { siteTitle: string; siteLogoDataUrl: string };
export const defaultSiteBranding: SiteBranding = { siteTitle: "ForwardX", siteLogoDataUrl: "" };

export function siteBrandingScope() {
  try {
    return (mobileAuth.isNative ? mobileAuth.getPanelUrl() : window.location.origin).replace(/\/+$/, "");
  } catch { return ""; }
}

export function normalizeSiteBranding(input: { siteTitle?: unknown; siteLogoDataUrl?: unknown }): SiteBranding {
  const logo = typeof input.siteLogoDataUrl === "string" ? input.siteLogoDataUrl.trim() : "";
  return {
    siteTitle: typeof input.siteTitle === "string" ? input.siteTitle.trim().slice(0, 160) || "ForwardX" : "ForwardX",
    siteLogoDataUrl: isValidBrandLogoValue(logo) ? logo : "",
  };
}

/** Public display fields only. This cache must never become an auth or permission snapshot. */
export function readSiteBranding(scope = siteBrandingScope(), allowLegacy = !mobileAuth.isNative): SiteBranding {
  if (!scope) return defaultSiteBranding;
  try {
    const raw = window.localStorage.getItem(PREFIX + scope);
    if (raw && raw.length <= MAX_BYTES) {
      const value = JSON.parse(raw);
      if (value?.version === 1 && value.scope === scope) return normalizeSiteBranding(value);
    }
    // Existing browser installations already have these public fields. Native
    // apps must not inherit unscoped branding from another configured panel.
    if (allowLegacy) return normalizeSiteBranding({
      siteTitle: window.localStorage.getItem("forwardx.siteTitle"),
      siteLogoDataUrl: window.localStorage.getItem("forwardx.siteLogoDataUrl"),
    });
  } catch { /* Storage denial or malformed values must not block startup. */ }
  return defaultSiteBranding;
}

export function saveSiteBranding(input: { siteTitle?: unknown; siteLogoDataUrl?: unknown }, scope = siteBrandingScope()) {
  const value = normalizeSiteBranding(input);
  if (scope) try {
    // Whitelist fields rather than persisting the publicInfo response wholesale.
    window.localStorage.setItem(PREFIX + scope, JSON.stringify({ version: 1, scope, ...value }));
  } catch { /* Best-effort presentation only. */ }
  return value;
}

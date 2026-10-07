import type { Express } from "express";
import { cachedAddressCountry } from "./hostGeo";
import { hasLocalSetupCompleteMarker } from "./setupState";

export function initialSetupLanguage(value: unknown, setupComplete: boolean): "zh-CN" | "en" | null {
  if (setupComplete) return null;
  return value === "zh-CN" || value === "en" ? value : null;
}

export function localeCountryHint(cachedCountry: string | null, proxyCountry: unknown, trustedProxy: boolean): string | null {
  const candidate = cachedCountry || (trustedProxy && typeof proxyCountry === "string" ? proxyCountry.trim().toUpperCase() : null);
  return candidate && /^[A-Z]{2}$/.test(candidate) && candidate !== "XX" ? candidate : null;
}

export function registerLocaleHintRoute(app: Express) {
  app.get("/api/locale", (req, res) => {
    const trust = req.app.get("trust proxy fn");
    const trusted = typeof trust === "function" && !!req.socket.remoteAddress && trust(req.socket.remoteAddress, 0);
    // A configured trusted country-aware proxy (e.g. Cloudflare) must overwrite
    // this header. It is only a UI hint, never an authentication decision.
    const country = localeCountryHint(cachedAddressCountry(req.ip || ""), req.headers["cf-ipcountry"], trusted);
    res.setHeader("Cache-Control", "private, no-store");
    // The local marker is available even before a database has been configured.
    // Installation language must not override normal browser detection after setup.
    const setupLanguage = initialSetupLanguage(process.env.FORWARDX_SETUP_LANGUAGE, hasLocalSetupCompleteMarker());
    res.json({ country, setupLanguage });
  });
}

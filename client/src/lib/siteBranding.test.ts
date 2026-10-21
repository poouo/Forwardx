import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteBranding, normalizeSiteBranding, readSiteBranding, saveSiteBranding, siteBrandingScope } from "./siteBranding";

function withStorage(run: (values: Map<string, string>, browser: any) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  const browser = {
    location: { origin: "https://panel.example" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  try { run(values, browser); }
  finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("branding persists only public display fields and separates panels", () => withStorage((values) => {
  const input = { siteTitle: " Custom Panel ", siteLogoDataUrl: "data:image/png;base64,dGVzdA==", role: "admin", token: "secret", userId: 9 };
  assert.equal(siteBrandingScope(), "https://panel.example");
  const saved = saveSiteBranding(input);
  assert.equal(saved.siteTitle, "Custom Panel");
  assert.deepEqual(readSiteBranding(), saved);
  assert.deepEqual(readSiteBranding("https://other.example", false), defaultSiteBranding);
  saveSiteBranding({ siteTitle: "Other Panel" }, "https://other.example");
  assert.equal(readSiteBranding().siteTitle, "Custom Panel");
  assert.equal(readSiteBranding("https://other.example", false).siteTitle, "Other Panel");
  const raw = values.get("forwardx.branding.v1:https://panel.example")!;
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["scope", "siteLogoDataUrl", "siteTitle", "version"]);
  assert.doesNotMatch(raw, /secret|admin|userId|token|role/);
}));

test("legacy public branding is reused in browsers but never across native panels", () => withStorage((values, browser) => {
  values.set("forwardx.siteTitle", "Existing Panel");
  assert.equal(readSiteBranding().siteTitle, "Existing Panel");
  browser.Capacitor = { isNativePlatform: () => true };
  values.set("forwardx.mobile.panelUrl", "https://native.example/");
  assert.equal(siteBrandingScope(), "https://native.example");
  assert.deepEqual(readSiteBranding(), defaultSiteBranding);
  saveSiteBranding({ siteTitle: "Native Panel" });
  assert.equal(readSiteBranding().siteTitle, "Native Panel");
  values.set("forwardx.mobile.panelUrl", "https://second.example");
  assert.deepEqual(readSiteBranding(), defaultSiteBranding);
}));

test("resetting public branding clears stale title and logo", () => withStorage(() => {
  saveSiteBranding({ siteTitle: "Custom Panel", siteLogoDataUrl: "data:image/png;base64,dGVzdA==" });
  saveSiteBranding({ siteTitle: "", siteLogoDataUrl: "" });
  assert.deepEqual(readSiteBranding(), defaultSiteBranding);
}));

test("malformed, oversized, mismatched or denied storage cannot block startup", () => withStorage((values, browser) => {
  const key = "forwardx.branding.v1:https://panel.example";
  for (const raw of ["{", "x".repeat(200_001), JSON.stringify({ version: 1, scope: "https://wrong.example", siteTitle: "Wrong Panel" }), "null"]) {
    values.set(key, raw);
    assert.deepEqual(readSiteBranding(), defaultSiteBranding);
  }
  Object.defineProperty(browser, "localStorage", { get() { throw new Error("Denied"); } });
  assert.deepEqual(readSiteBranding(), defaultSiteBranding);
  assert.equal(saveSiteBranding({ siteTitle: "Public Title" }).siteTitle, "Public Title");
}));

test("branding normalization rejects unsafe and oversized logo data", () => {
  for (const siteLogoDataUrl of ["javascript:alert(1)", "https://tracker.example/logo.png", "data:image/svg+xml;base64,dGVzdA==", "data:image/png;base64," + "A".repeat(160_000)]) {
    assert.equal(normalizeSiteBranding({ siteLogoDataUrl }).siteLogoDataUrl, "");
  }
  assert.deepEqual(normalizeSiteBranding({ siteTitle: 123, siteLogoDataUrl: false }), defaultSiteBranding);
  assert.equal(normalizeSiteBranding({ siteTitle: "x".repeat(500) }).siteTitle.length, 160);
});

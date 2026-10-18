import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PanelStartView from "./PanelStartView";
import AnimatedStatValue, { StatValuePersistenceContext } from "./AnimatedStatValue";
import { initializeLanguage, setLanguagePreference } from "@/i18n";

test("initial UI is usable and bilingual, without an overlay or private controls", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language); await initializeLanguage();
    const html = renderToStaticMarkup(<PanelStartView />);
    assert.match(html, /href="\/"/);
    assert.match(html, /href="\/login"/);
    assert.match(html, /<h1/);
    assert.doesNotMatch(html, /fixed|inset-0|animate-pulse|type="password"|\/settings|\/users/);
    if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
  }
});

test("dashboard presentation ignores legacy unscoped text caches", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => "OTHER-USER-DATA" } } });
  try {
    const html = renderToStaticMarkup(<StatValuePersistenceContext.Provider value={false}><AnimatedStatValue cacheKey="home.stats.totalRules" value={0} loading fallbackValue="—" /></StatValuePersistenceContext.Provider>);
    assert.doesNotMatch(html, /OTHER-USER-DATA/);
    assert.match(html, /—/);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});

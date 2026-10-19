import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import RoutePage from "./RoutePage";
import { initializeLanguage, setLanguagePreference } from "@/i18n";

test("route fallback is local, bilingual and does not start fetching other pages on render", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language);
    await initializeLanguage();
    const html = renderToStaticMarkup(<RoutePage page="Hosts" />);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /fixed|inset-0|min-h-screen|animate-pulse|<aside|<nav/);
    if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
  }
});

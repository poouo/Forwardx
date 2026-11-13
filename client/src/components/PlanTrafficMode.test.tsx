import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { PlanTrafficModeBadge, PlanTrafficModeField } from "./PlanTrafficMode";
import { StorePlanCard } from "../pages/Store";

test("plan traffic controls and badges use the project selector and support both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const both = renderToStaticMarkup(<PlanTrafficModeBadge />);
      const outbound = renderToStaticMarkup(<PlanTrafficModeBadge mode="outbound" />);
      const field = renderToStaticMarkup(<PlanTrafficModeField value="outbound" onChange={() => {}} />);
      assert.match(field, /role="combobox"/);
      assert.match(field, /for="plan-traffic-mode"/);
      assert.match(field, /pearl-select-trigger/);
      // Radix keeps a hidden native select for form/accessibility support.
      assert.doesNotMatch(field, /<select(?![^>]*aria-hidden="true")/);
      assert.match(outbound + field, language === "en" ? /One-way \(Outbound\)/ : /单向（仅出向）/);
      assert.match(both, language === "en" ? /Total \(both directions\)/ : /双向合计/);
      if (language === "en") assert.doesNotMatch(both + outbound + field, /\p{Script=Han}/u);
      const card = renderToStaticMarkup(<StorePlanCard plan={{ name: "Plan", description: "Custom description", trafficMode: "outbound" }} onBuy={() => {}} />);
      assert.match(card, /Custom description/);
      assert.match(card, language === "en" ? /One-way \(Outbound\)/ : /单向（仅出向）/);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("plan mode is saved, restored and displayed in the user's subscription", () => {
  const plans = readFileSync("client/src/pages/Plans.tsx", "utf8");
  assert.match(plans, /trafficMode: "both"/);
  assert.match(plans, /trafficMode: normalizePlanTrafficMode\(plan\.trafficMode\)/);
  assert.match(plans, /trafficMode: form\.trafficMode/);
  assert.match(plans, /<PlanTrafficModeField value=\{form.trafficMode\}/);
  assert.match(readFileSync("client/src/pages/Subscriptions.tsx", "utf8"), /<PlanTrafficModeBadge mode=\{sub\.trafficMode\}/);
});

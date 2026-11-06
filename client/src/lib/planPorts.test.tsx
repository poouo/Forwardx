import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { planPortCountText, subscriptionPortRangeText } from "./planDisplay";
import { StorePlanCard } from "../pages/Store";

test("zero ports display as unlimited, not a zero-sized or null-null range, in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const unlimited = language === "en" ? "Unlimited" : "不限";
      assert.equal(planPortCountText(0), unlimited);
      assert.equal(subscriptionPortRangeText({ portCount: 0, portRangeStart: null, portRangeEnd: null }), unlimited);
      assert.equal(subscriptionPortRangeText({ portCount: 0, portRangeStart: 10000, portRangeEnd: 10019 }), unlimited);
      assert.equal(subscriptionPortRangeText({ portCount: 20, portRangeStart: 10000, portRangeEnd: 10019 }), "10000-10019");
      assert.equal(subscriptionPortRangeText({}), "-");
      assert.match(planPortCountText(2048), /2048/);
      const card = renderToStaticMarkup(<StorePlanCard plan={{ name: "Unlimited", portCount: 0 }} onBuy={() => {}} />);
      assert.match(card, language === "en" ? /Unlimited ports/ : /端口不限/);
      assert.doesNotMatch(card, /null-null|连续端口 0 个|0 consecutive ports/);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("plan form accepts zero without clamping to one and removes the old 1024 cap", () => {
  const source = readFileSync("client/src/pages/Plans.tsx", "utf8");
  assert.match(source, /连续端口数（0 为不限）/);
  assert.match(source, /min=\{0\} max=\{65535\} value=\{form.portCount\}/);
  assert.match(source, /portCount: Math.max\(0, Math.floor\(Number\(form.portCount \|\| 0\)\)\)/);
  for (const file of ["Users", "Subscriptions", "Billing"]) {
    assert.match(readFileSync(`client/src/pages/${file}.tsx`, "utf8"), /subscriptionPortRangeText\(sub\)/);
  }
});

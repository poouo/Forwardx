import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeLanguage, getLanguagePreference, setLanguagePreference } from "@/i18n";
import { PlanPurchaseQuantity, planPurchaseQuote, discountQuoteKey } from "./PlanPurchaseQuantity";
import { PlanBillingCycleSelect } from "./PlanBillingCycleSelect";
import { planBillingCycles } from "@shared/planPurchase";

test("purchase period control shows total validity and accessible input in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<PlanPurchaseQuantity value="5" onChange={() => {}} durationDays={30} disabled={false} valid />);
      assert.match(html, language === "en" ? /Quantity/ : /购买数量/);
      assert.match(html, language === "en" ? /150 days total/ : /共 150 天/);
      assert.doesNotMatch(html, /每期|期数|>期<|[Pp]eriods?|流量及其他额度/);
      assert.match(html, /value="5"/);
      assert.match(html, /max="100"/);
      assert.match(html, /aria-invalid="false"/);
      assert.match(html, /for="plan-purchase-quantity"/);
      if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("invalid quantities have no quote and pending purchase controls are disabled", () => {
  const plan = { priceCents: 100, durationDays: 30, cyclePrices: JSON.stringify([{ durationDays: 90, kind: "fixed", priceCents: 250 }]) };
  assert.equal(planPurchaseQuote(plan, "5")?.priceCents, 500);
  assert.equal(planPurchaseQuote(plan, "2", 90)?.priceCents, 500);
  for (const quantity of ["", "0", "2.5", "101"]) assert.equal(planPurchaseQuote(plan, quantity), null);
  for (const durationDays of [0, 365]) assert.equal(planPurchaseQuote({ ...plan, durationDays }, "2"), null);
  assert.equal(planPurchaseQuote({ ...plan, cyclePrices: null }, "2"), null);
  const pending = renderToStaticMarkup(<PlanPurchaseQuantity value="2" onChange={() => {}} durationDays={30} disabled valid />);
  assert.equal((pending.match(/disabled=""/g) || []).length, 3);
});

test("selected billing cycle shows its discount and fixed-duration plans have no selector", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const cycles = planBillingCycles({ durationDays: 30, priceCents: 2000, cyclePrices: JSON.stringify([
      { durationDays: 365, kind: "percent", pricePercent: 90 },
      { durationDays: 730, kind: "percent", pricePercent: 100 },
    ]) });
    const discounted = renderToStaticMarkup(<PlanBillingCycleSelect options={cycles} value={365} onChange={() => {}} disabled={false} />);
    assert.match(discounted, /role="combobox"/);
    assert.match(discounted, /10% off/);
    assert.match(discounted, /<s[^>]*>[^<]*240\.00<\/s>/);
    assert.match(discounted, /216\.00/);
    assert.doesNotMatch(discounted, /\p{Script=Han}/u);
    const annual = renderToStaticMarkup(<PlanBillingCycleSelect options={[{ durationDays: 365, priceCents: 20000 }]} value={365} onChange={() => {}} disabled={false} />);
    assert.match(annual, /Annual/);
    assert.doesNotMatch(annual, /role="combobox"|% off/);
    const atFullPrice = renderToStaticMarkup(<PlanBillingCycleSelect options={cycles} value={730} onChange={() => {}} disabled={false} />);
    assert.doesNotMatch(atFullPrice, /% off|<s[ >]/);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("late discount previews are bound to the plan, total amount and discount code", () => {
  const key = discountQuoteKey(1, 500, "test");
  assert.equal(key, discountQuoteKey(1, 500, " TEST "));
  assert.notEqual(key, discountQuoteKey(1, 200, "test"));
  assert.notEqual(key, discountQuoteKey(2, 500, "test"));
  assert.notEqual(key, discountQuoteKey(1, 500, "other"));
});

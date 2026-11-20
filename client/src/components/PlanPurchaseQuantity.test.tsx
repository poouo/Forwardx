import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeLanguage, getLanguagePreference, setLanguagePreference } from "@/i18n";
import { PlanPurchaseQuantity, planPurchaseQuote, discountQuoteKey } from "./PlanPurchaseQuantity";

test("purchase period control shows total validity and accessible input in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<PlanPurchaseQuantity value="5" onChange={() => {}} durationDays={30} disabled={false} valid />);
      assert.match(html, /150/);
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

test("invalid periods have no quote; lifetime and pending purchase controls are disabled", () => {
  const plan = { priceCents: 100, durationDays: 30 };
  assert.equal(planPurchaseQuote(plan, "5")?.priceCents, 500);
  for (const quantity of ["", "0", "2.5", "101"]) assert.equal(planPurchaseQuote(plan, quantity), null);
  assert.equal(planPurchaseQuote({ ...plan, durationDays: 0 }, "2"), null);
  const permanent = renderToStaticMarkup(<PlanPurchaseQuantity value="1" onChange={() => {}} durationDays={0} disabled={false} valid />);
  assert.equal((permanent.match(/disabled=""/g) || []).length, 3);
  const pending = renderToStaticMarkup(<PlanPurchaseQuantity value="2" onChange={() => {}} durationDays={30} disabled valid />);
  assert.equal((pending.match(/disabled=""/g) || []).length, 3);
});

test("late discount previews are bound to the plan, total amount and discount code", () => {
  const key = discountQuoteKey(1, 500, "test");
  assert.equal(key, discountQuoteKey(1, 500, " TEST "));
  assert.notEqual(key, discountQuoteKey(1, 200, "test"));
  assert.notEqual(key, discountQuoteKey(2, 500, "test"));
  assert.notEqual(key, discountQuoteKey(1, 500, "other"));
});

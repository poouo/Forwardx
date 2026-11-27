import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeLanguage, getLanguagePreference, setLanguagePreference } from "@/i18n";
import { PlanPurchaseQuantity, planPurchaseQuote, discountQuoteKey } from "./PlanPurchaseQuantity";
import { PlanBillingCycleSelect } from "./PlanBillingCycleSelect";
import { PlanCheckoutBenefits } from "./PlanCheckoutBenefits";
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

test("checkout benefits follow the selected cycle and quantity without multiplying quotas", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const plan = {
      priceCents: 1000,
      durationDays: 30,
      cyclePrices: JSON.stringify([{ durationDays: 90, kind: "fixed", priceCents: 2400 }]),
      trafficLimit: 100 * 1024 ** 3,
      trafficMode: "both",
      portCount: 3,
      rateLimitMbps: 50,
      maxRules: 4,
      maxConnections: 20,
      maxIPs: 5,
      hostIds: [1],
    };
    const render = (quantity: string, cycle: number) =>
      renderToStaticMarkup(<PlanCheckoutBenefits plan={plan} durationDays={planPurchaseQuote(plan, quantity, cycle)?.durationDays} />);
    const monthly = render("1", 30);
    const twoQuarters = render("2", 90);
    assert.match(monthly, /30 days/);
    assert.doesNotMatch(monthly, /resets monthly/);
    assert.match(twoQuarters, /180 days/);
    assert.match(twoQuarters, /resets monthly/);
    for (const html of [monthly, twoQuarters]) {
      assert.match(html, /100 GB/);
      assert.match(html, /3 ports/);
      assert.match(html, /50 Mbps/);
    }
    assert.doesNotMatch(render("", 90), /180 days|resets monthly/);
    assert.match(renderToStaticMarkup(<PlanCheckoutBenefits plan={{ ...plan, trafficLimit: 0 }} durationDays={0} />), /Never Expires/);
    const custom = { ...plan, description: "**Custom plan description**" };
    const customMonthly = renderToStaticMarkup(<PlanCheckoutBenefits plan={custom} durationDays={30} />);
    const customQuarterly = renderToStaticMarkup(<PlanCheckoutBenefits plan={custom} durationDays={90} />);
    for (const html of [customMonthly, customQuarterly]) {
      assert.match(html, /<strong>Custom plan description<\/strong>/);
      assert.doesNotMatch(html, /Plan Benefits|100 GB|3 ports/);
    }
    assert.match(customMonthly, /30 days/);
    assert.match(customQuarterly, /90 days.*resets monthly/s);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
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

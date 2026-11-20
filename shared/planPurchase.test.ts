import assert from "node:assert/strict";
import test from "node:test";
import { planBillingCycles, planCyclePurchaseTotals, planPurchaseTotals } from "./planPurchase";

test("plan periods multiply price and validity, preserving a one-period default", () => {
  assert.deepEqual(planPurchaseTotals(1200, 30, 5), { quantity: 5, priceCents: 6000, durationDays: 150 });
  assert.deepEqual(planPurchaseTotals(1200, 30, 2), { quantity: 2, priceCents: 2400, durationDays: 60 });
  assert.deepEqual(planPurchaseTotals(1200, 30), { quantity: 1, priceCents: 1200, durationDays: 30 });
  assert.equal(planPurchaseTotals(0, 30, 100).priceCents, 0);
  assert.equal(planPurchaseTotals(1200, 0).durationDays, 0);
});

test("plan periods reject invalid quantities, duplicate lifetime purchases and unsafe totals", () => {
  for (const quantity of [0, -1, 1.5, 101, Infinity, NaN]) {
    assert.throws(() => planPurchaseTotals(100, 30, quantity), /购买期数/);
  }
  assert.throws(() => planPurchaseTotals(100, 0, 2), /永久套餐/);
  for (const [price, days] of [[-1, 30], [1.2, 30], [100, -1], [100, 30.5], [100_000_000, 30], [1, 100_000_000]]) {
    assert.throws(() => planPurchaseTotals(price, days, 2), /有效范围/);
  }
});

test("monthly cycle rules charge the configured percentage of the original price", () => {
  const plan = {
    priceCents: 2000, durationDays: 30, cyclePrices: JSON.stringify([
      { durationDays: 90, kind: "fixed", priceCents: 5500 },
      { durationDays: 180, kind: "percent", pricePercent: 1 },
      { durationDays: 365, kind: "percent", pricePercent: 90 },
      { durationDays: 730, kind: "percent", pricePercent: 100 },
    ]),
  };
  assert.deepEqual(planBillingCycles(plan), [
    { durationDays: 30, priceCents: 2000 },
    { durationDays: 90, priceCents: 5500 },
    { durationDays: 180, priceCents: 120, referencePriceCents: 12000, discountPercent: 99 },
    { durationDays: 365, priceCents: 21600, referencePriceCents: 24000, discountPercent: 10 },
    { durationDays: 730, priceCents: 48000 },
  ]);
  assert.deepEqual(planCyclePurchaseTotals(plan, 2, 90), { quantity: 2, priceCents: 11000, durationDays: 180 });
  assert.deepEqual(planCyclePurchaseTotals(plan, 2, 365), { quantity: 2, priceCents: 43200, durationDays: 730 });
  assert.equal(planCyclePurchaseTotals(plan, 1, 730).priceCents, 48000);
});

test("only monthly plans with an enabled longer cycle allow multiple units", () => {
  const monthly = { priceCents: 2000, durationDays: 30 };
  const rules = JSON.stringify([{ durationDays: 90, kind: "fixed", priceCents: 5500 }]);
  const yearly = { priceCents: 20000, durationDays: 365, cyclePrices: rules };
  const discountedMonthly = {
    ...monthly, cyclePrices: JSON.stringify([{ durationDays: 30, kind: "percent", pricePercent: 90 }]),
  };
  assert.equal(planCyclePurchaseTotals(monthly).durationDays, 30);
  assert.equal(planCyclePurchaseTotals(discountedMonthly).priceCents, 1800);
  assert.deepEqual(planCyclePurchaseTotals(yearly), { quantity: 1, priceCents: 20000, durationDays: 365 });
  for (const plan of [monthly, yearly, discountedMonthly, { ...monthly, cyclePrices: "invalid" }]) {
    assert.throws(() => planCyclePurchaseTotals(plan, 2), /每次只能购买一份/);
    assert.throws(() => planCyclePurchaseTotals(plan, 1, 90), /所选付款周期不可购买/);
  }
  assert.equal(planCyclePurchaseTotals({ ...monthly, cyclePrices: rules }, 2).durationDays, 60);
});

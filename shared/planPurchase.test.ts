import assert from "node:assert/strict";
import test from "node:test";
import { planPurchaseTotals } from "./planPurchase";

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

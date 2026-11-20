import assert from "node:assert/strict";
import test from "node:test";
import { getFormatLocale } from "@/i18n";
import { formatBytes, formatHostRenewalCost } from "./hostDisplay";

test("formatBytes clamps values at the largest supported unit", () => {
  assert.equal(formatBytes(1024 ** 5), "1 PB");
  assert.equal(formatBytes(1024 ** 6), "1024 PB");
});

test("formatBytes handles non-finite values", () => {
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("host renewal prices use short currency symbols and preserve a configured zero", () => {
  for (const currency of ["USD", "HKD", "CAD"] as const) {
    assert.equal(formatHostRenewalCost(1234, currency), "$12.34");
  }
  for (const [cents, currency] of [[550, "EUR"], [0, "JPY"]] as const) {
    assert.equal(formatHostRenewalCost(cents, currency),
      new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }).format(cents / 100));
  }
  assert.equal(formatHostRenewalCost(null, null), null);
  assert.equal(formatHostRenewalCost(1234, "invalid"), null);
});

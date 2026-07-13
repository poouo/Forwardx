import assert from "node:assert/strict";
import test from "node:test";
import {
  getManagePresetGroup,
  normalizeManagePresetCustomPatch,
  parseManagePresetSelection,
} from "./managePresets";

test("offers credit and deduction amount presets from the original instruction", () => {
  const credit = getManagePresetGroup({
    action: "balance_adjust",
    sourceText: "给用户充值余额",
    missingFields: ["amountYuan"],
  });
  const deduction = getManagePresetGroup({
    action: "balance_adjust",
    sourceText: "扣减用户余额",
    missingFields: ["amountYuan"],
  });

  assert.deepEqual(credit?.choices.map((item) => item.value), ["10", "50", "100", "500"]);
  assert.deepEqual(deduction?.choices.map((item) => item.value), ["-10", "-50", "-100", "-500"]);
});

test("guides multi-field code generation one field at a time", () => {
  const amount = getManagePresetGroup({
    action: "redeem_code_generate_balance",
    missingFields: ["amountYuan", "codeCount"],
  });
  const count = getManagePresetGroup({
    action: "redeem_code_generate_balance",
    missingFields: ["codeCount"],
  });
  const discount = getManagePresetGroup({
    action: "discount_code_generate_percent",
    missingFields: ["discountPercent", "codeCount"],
  });

  assert.equal(amount?.field, "amountYuan");
  assert.equal(count?.field, "codeCount");
  assert.equal(discount?.field, "discountPercent");
});

test("parses only bounded preset callback values", () => {
  assert.deepEqual(parseManagePresetSelection("amountYuan", "-50"), { amountYuan: -50 });
  assert.deepEqual(parseManagePresetSelection("duration", "3m"), { durationValue: 3, durationUnit: "month" });
  assert.deepEqual(parseManagePresetSelection("codeCount", "100"), { codeCount: 100 });
  assert.deepEqual(parseManagePresetSelection("discountPercent", "15"), { discountPercent: 15 });
  assert.equal(parseManagePresetSelection("codeCount", "501"), null);
  assert.equal(parseManagePresetSelection("duration", "one-month"), null);
  assert.equal(parseManagePresetSelection("unknown", "10"), null);
});

test("keeps the original credit or deduction direction for custom amounts", () => {
  assert.deepEqual(normalizeManagePresetCustomPatch({
    action: "balance_adjust",
    sourceText: "扣减这个用户的余额",
    missingFields: ["amountYuan"],
  }, { amountYuan: 30 }), { amountYuan: -30 });
  assert.deepEqual(normalizeManagePresetCustomPatch({
    action: "balance_adjust",
    sourceText: "给这个用户充值",
    missingFields: ["amountYuan"],
  }, { amountYuan: -30 }), { amountYuan: 30 });
});

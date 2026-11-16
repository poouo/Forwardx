import assert from "node:assert/strict";
import test from "node:test";
import { paymentStatusText } from "./paymentStatus";

test("payment status labels use localized Chinese source text", () => {
  assert.equal(paymentStatusText("completed"), "已完成");
  assert.equal(paymentStatusText("pending"), "待支付");
  assert.equal(paymentStatusText("cancelled"), "已取消");
});

test("unknown payment status remains visible for diagnostics", () => {
  assert.equal(paymentStatusText("provider_review"), "provider_review");
});

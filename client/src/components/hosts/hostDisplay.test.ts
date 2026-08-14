import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "./hostDisplay";

test("formatBytes clamps values at the largest supported unit", () => {
  assert.equal(formatBytes(1024 ** 5), "1 PB");
  assert.equal(formatBytes(1024 ** 6), "1024 PB");
});

test("formatBytes handles non-finite values", () => {
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

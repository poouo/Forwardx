import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./asyncPool";

test("runs independent work concurrently with a fixed upper bound", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(Array.from({ length: 40 }, (_, index) => index), 6, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 6);
  assert.deepEqual(results, Array.from({ length: 40 }, (_, index) => index * 2));
});

test("waits for active work to drain before rejecting", async () => {
  let active = 0;
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3], 3, async (value) => {
      active += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (value === 1) throw new Error("failed");
        return value;
      } finally {
        active -= 1;
      }
    }),
    /failed/,
  );
  assert.equal(active, 0);
});

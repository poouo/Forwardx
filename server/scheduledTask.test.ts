import assert from "node:assert/strict";
import test from "node:test";
import { createNonOverlappingScheduledTask } from "./scheduledTask";
import { SELF_TEST_SWEEP_INTERVAL_MS, SELF_TEST_TIMEOUT_SECONDS } from "./selfTestTiming";

test("manual self-tests settle within a short interactive deadline", () => {
  assert.equal(SELF_TEST_TIMEOUT_SECONDS, 8);
  assert.equal(SELF_TEST_SWEEP_INTERVAL_MS, 2_000);
});

test("scheduled tasks skip overlapping ticks and resume after completion", async () => {
  let runs = 0;
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const warnings: string[] = [];
  const run = createNonOverlappingScheduledTask("cleanup", async () => {
    runs += 1;
    if (runs === 1) await wait;
  }, {
    logger: { warn: (message) => warnings.push(String(message)), error: () => undefined },
    slowTaskMs: 0,
  });

  const first = run();
  await Promise.resolve();
  assert.equal(await run(), false);
  assert.equal(runs, 1);
  assert.match(warnings[0], /skipped overlapping/);
  release?.();
  assert.equal(await first, true);
  assert.equal(await run(), true);
  assert.equal(runs, 2);
});

test("scheduled tasks release their guard after errors", async () => {
  let runs = 0;
  const errors: string[] = [];
  const run = createNonOverlappingScheduledTask("failure", async () => {
    runs += 1;
    if (runs === 1) throw new Error("expected failure");
  }, {
    logger: { warn: () => undefined, error: (message) => errors.push(String(message)) },
    slowTaskMs: 0,
  });

  assert.equal(await run(), true);
  assert.equal(await run(), true);
  assert.equal(runs, 2);
  assert.match(errors[0], /expected failure/);
});

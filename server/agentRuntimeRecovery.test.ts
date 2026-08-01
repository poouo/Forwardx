import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntimeRecoveryCoordinator,
} from "./agentRuntimeRecovery";

test("coalesces same-host recovery and applies cooldown after success", async () => {
  let now = 1_000;
  const coordinator = new AgentRuntimeRecoveryCoordinator({ cooldownMs: 60_000, now: () => now });
  let calls = 0;
  let release: (() => void) | undefined;
  const firstTask = new Promise<void>((resolve) => { release = resolve; });

  const first = coordinator.run(7, { preserveReportedRuntime: false }, async () => {
    calls += 1;
    await firstTask;
  });
  const second = coordinator.run(7, { preserveReportedRuntime: false }, async () => {
    calls += 1;
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(calls, 1);
  assert.equal(await coordinator.run(7, { preserveReportedRuntime: false }, async () => { calls += 1; }), false);

  now += 60_001;
  assert.equal(await coordinator.run(7, { preserveReportedRuntime: false }, async () => { calls += 1; }), true);
  assert.equal(calls, 2);
});

test("does not commit cooldown when recovery fails", async () => {
  const coordinator = new AgentRuntimeRecoveryCoordinator({ cooldownMs: 60_000, now: () => 1_000 });
  let calls = 0;
  await assert.rejects(
    coordinator.run(8, { preserveReportedRuntime: false }, async () => {
      calls += 1;
      throw new Error("temporary reset failure");
    }),
    /temporary reset failure/,
  );

  assert.equal(await coordinator.run(8, { preserveReportedRuntime: false }, async () => { calls += 1; }), true);
  assert.equal(calls, 2);
});

test("a duplicate request can retry after an in-flight recovery fails", async () => {
  const coordinator = new AgentRuntimeRecoveryCoordinator({ cooldownMs: 60_000, now: () => 1_500 });
  let rejectFirst: ((error: Error) => void) | undefined;
  const firstTask = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  let calls = 0;

  const first = coordinator.run(8, { preserveReportedRuntime: false }, async () => {
    calls += 1;
    await firstTask;
  });
  const duplicate = coordinator.run(8, { preserveReportedRuntime: false }, async () => {
    calls += 1;
  });
  await Promise.resolve();
  rejectFirst?.(new Error("transient reset failure"));

  await assert.rejects(first, /transient reset failure/);
  assert.equal(await duplicate, true);
  assert.equal(calls, 2);
});

test("full recovery is not hidden by a recent light recovery", async () => {
  let now = 2_000;
  const coordinator = new AgentRuntimeRecoveryCoordinator({ cooldownMs: 60_000, now: () => now });
  const calls: string[] = [];

  assert.equal(await coordinator.run(9, { preserveReportedRuntime: true }, async () => { calls.push("light"); }), true);
  assert.equal(await coordinator.run(9, { preserveReportedRuntime: true }, async () => { calls.push("light-duplicate"); }), false);
  assert.equal(await coordinator.run(9, { preserveReportedRuntime: false }, async () => { calls.push("full"); }), true);
  assert.deepEqual(calls, ["light", "full"]);
  assert.equal(await coordinator.run(9, { preserveReportedRuntime: true }, async () => { calls.push("light-after-full"); }), false);

  now += 60_001;
  assert.equal(await coordinator.run(9, { preserveReportedRuntime: true }, async () => { calls.push("light-after-window"); }), true);
  assert.deepEqual(calls, ["light", "full", "light-after-window"]);
});

test("a stronger request waits for a light recovery and then runs", async () => {
  const coordinator = new AgentRuntimeRecoveryCoordinator({ cooldownMs: 60_000, now: () => 3_000 });
  let release: (() => void) | undefined;
  const lightTask = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];

  const light = coordinator.run(10, { preserveReportedRuntime: true }, async () => {
    calls.push("light");
    await lightTask;
  });
  const full = coordinator.run(10, { preserveReportedRuntime: false }, async () => {
    calls.push("full");
  });
  release?.();

  assert.equal(await light, true);
  assert.equal(await full, true);
  assert.deepEqual(calls, ["light", "full"]);
});

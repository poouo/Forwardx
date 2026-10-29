import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createNonOverlappingScheduledTask } from "./scheduledTask";
import {
  FORWARD_TUNNEL_LATENCY_WAIT_MS,
  SELF_TEST_SWEEP_ACTIVE_WINDOW_MS,
  SELF_TEST_SWEEP_INTERVAL_MS,
  SELF_TEST_TIMEOUT_SECONDS,
  SELF_TEST_MAX_LIFETIME_SECONDS,
  RUNTIME_SELF_TEST_TIMEOUT_SECONDS,
  SelfTestSweepActivity,
  selfTestTimeoutSeconds,
  startSelfTestSweepTimer,
} from "./selfTestTiming";

test("manual self-tests outlive the Agent runtime readiness budget", () => {
  assert.equal(SELF_TEST_TIMEOUT_SECONDS, 8);
  assert.equal(RUNTIME_SELF_TEST_TIMEOUT_SECONDS, 45);
  assert.equal(FORWARD_TUNNEL_LATENCY_WAIT_MS, 18_000);
  assert.ok(RUNTIME_SELF_TEST_TIMEOUT_SECONDS > 4 + 20);
  assert.ok(FORWARD_TUNNEL_LATENCY_WAIT_MS > 8_000);
  assert.ok(FORWARD_TUNNEL_LATENCY_WAIT_MS < RUNTIME_SELF_TEST_TIMEOUT_SECONDS * 1000);
  assert.ok(
    RUNTIME_SELF_TEST_TIMEOUT_SECONDS * 1000
      > (4 + 20) * 1000 + FORWARD_TUNNEL_LATENCY_WAIT_MS + SELF_TEST_SWEEP_INTERVAL_MS,
  );
  assert.equal(
    SELF_TEST_SWEEP_ACTIVE_WINDOW_MS,
    SELF_TEST_MAX_LIFETIME_SECONDS * 1000 + SELF_TEST_SWEEP_INTERVAL_MS * 2,
  );
  assert.ok(SELF_TEST_MAX_LIFETIME_SECONDS > RUNTIME_SELF_TEST_TIMEOUT_SECONDS);
  assert.equal(SELF_TEST_SWEEP_INTERVAL_MS, 2_000);
});

test("only runtime-dependent self-tests receive the extended timeout", () => {
  for (const kind of ["tunnel", "tunnel-hop", "forward-via-tunnel", "forward-via-tunnel-entry", "forward-chain"]) {
    assert.equal(selfTestTimeoutSeconds({ kind }), RUNTIME_SELF_TEST_TIMEOUT_SECONDS, kind);
  }
  assert.equal(
    selfTestTimeoutSeconds({ kind: "forward-chain", runtimeDependent: false }),
    SELF_TEST_TIMEOUT_SECONDS,
  );
  assert.equal(selfTestTimeoutSeconds({ kind: "direct" }), SELF_TEST_TIMEOUT_SECONDS);
  assert.equal(selfTestTimeoutSeconds(null), SELF_TEST_TIMEOUT_SECONDS);
});

test("self-test timeout sweeps stay idle until work is created or claimed", () => {
  let now = 10_000;
  const activity = new SelfTestSweepActivity(() => now, false);

  assert.equal(activity.shouldSweep(), false);
  activity.markActive();
  assert.equal(activity.shouldSweep(), true);

  now += SELF_TEST_SWEEP_ACTIVE_WINDOW_MS - 1;
  assert.equal(activity.shouldSweep(), true);
  now += 1;
  assert.equal(activity.shouldSweep(), false);
});

test("self-test timeout sweeps support an explicit restart recovery window", () => {
  let now = 20_000;
  const activity = new SelfTestSweepActivity(() => now, true);

  assert.equal(activity.shouldSweep(), true);
  now += SELF_TEST_SWEEP_ACTIVE_WINDOW_MS;
  assert.equal(activity.shouldSweep(), false);
});

test("self-test timeout sweep timers exist only during active windows", async () => {
  let now = 30_000;
  let nextTimerId = 0;
  const pendingTimers = new Map<number, {
    callback: () => void | Promise<void>;
    delayMs: number;
    unrefed: boolean;
  }>();
  const activity = new SelfTestSweepActivity(() => now, false);
  const timers = {
    setTimeout(callback: () => void | Promise<void>, delayMs: number) {
      const id = ++nextTimerId;
      const pending = { callback, delayMs, unrefed: false };
      pendingTimers.set(id, pending);
      return {
        id,
        unref: () => { pending.unrefed = true; },
      };
    },
    clearTimeout(handle: { id: number }) {
      pendingTimers.delete(handle.id);
    },
  };
  const takeTimer = () => {
    const next = pendingTimers.entries().next().value;
    assert.ok(next);
    const [id, timer] = next;
    pendingTimers.delete(id);
    return timer;
  };
  let sweeps = 0;
  const stop = startSelfTestSweepTimer(() => { sweeps += 1; }, {
    activity,
    timers,
  });

  assert.equal(pendingTimers.size, 0);
  activity.markActive();
  assert.equal(pendingTimers.size, 1);
  const first = takeTimer();
  assert.equal(first.delayMs, SELF_TEST_SWEEP_INTERVAL_MS);
  assert.equal(first.unrefed, true);
  now += SELF_TEST_SWEEP_INTERVAL_MS;
  await first.callback();
  assert.equal(sweeps, 1);
  assert.equal(pendingTimers.size, 1);

  now += SELF_TEST_SWEEP_ACTIVE_WINDOW_MS;
  await takeTimer().callback();
  assert.equal(sweeps, 1);
  assert.equal(pendingTimers.size, 0);

  activity.markActive();
  assert.equal(pendingTimers.size, 1);
  stop();
  assert.equal(pendingTimers.size, 0);
});

test("self-test sweeps retain scheduler context across request-triggered activation and reactivation", async () => {
  const context = new AsyncLocalStorage<string>();
  let now = 10_000;
  const activity = new SelfTestSweepActivity(() => now, false);
  const pending = new Map<object, () => void | Promise<void>>();
  const seen: Array<string | undefined> = [];
  const stop = context.run("scheduler", () => startSelfTestSweepTimer(() => { seen.push(context.getStore()); }, {
    activity,
    timers: {
      setTimeout(callback) { const handle = {}; pending.set(handle, callback); return handle; },
      clearTimeout(handle) { pending.delete(handle); },
    },
  }));
  const fire = async () => {
    const next = pending.entries().next().value; assert.ok(next);
    pending.delete(next[0]);
    // Even a callback invoked from another request must not borrow its scope.
    await context.run("unrelated-request", next[1]);
  };
  try {
    for (const request of ["tunnel-test-transaction", "rule-test-transaction"]) {
      context.run(request, () => activity.markActive());
      assert.equal(pending.size, 1);
      await fire();
      assert.equal(pending.size, 1);
      now += SELF_TEST_SWEEP_ACTIVE_WINDOW_MS;
      await fire();
      assert.equal(pending.size, 0);
    }
    assert.deepEqual(seen, ["scheduler", "scheduler"]);
  } finally { stop(); }
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

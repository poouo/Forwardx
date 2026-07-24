import assert from "node:assert/strict";
import test from "node:test";
import { HostDdnsRetryScheduler, HostDdnsUpdateCoordinator } from "./hostDdns";

test("deduplicates in-flight updates per host", () => {
  const updates = new HostDdnsUpdateCoordinator(() => 10_000);

  assert.equal(updates.tryStart(1), true);
  assert.equal(updates.tryStart(1), false);
  assert.equal(updates.canReconcile(1), false);
  assert.equal(updates.tryStart(2), true, "different hosts may update concurrently");

  assert.deepEqual(updates.finish(1), {
    rerunRequested: true,
    immediate: false,
  }, "an overlapping request must be coalesced into one rerun");
  assert.equal(updates.tryStart(1), true);
});

test("coalesced reruns wait for an existing failure backoff", () => {
  let now = 10_000;
  const updates = new HostDdnsUpdateCoordinator(() => now);

  assert.equal(updates.tryStart(1), true);
  assert.equal(updates.tryStart(1), false, "the later request is merged while the update is active");
  assert.equal(updates.recordFailure(1), 70_000);
  assert.deepEqual(updates.finish(1), {
    rerunRequested: true,
    immediate: false,
  }, "the merged request remains visible to the completion path");
  assert.equal(updates.canReconcile(1), false, "completion must not bypass the failure retry window");
  now = 70_000;
  assert.equal(updates.canReconcile(1), true);
});

test("defers reconcile after failure until the retry window expires", () => {
  let now = 10_000;
  const updates = new HostDdnsUpdateCoordinator(() => now);

  assert.equal(updates.recordFailure(1), 70_000);
  assert.equal(updates.canReconcile(1), false);
  now = 69_999;
  assert.equal(updates.canReconcile(1), false);
  now = 70_000;
  assert.equal(updates.canReconcile(1), true);
});

test("backs off repeated failures exponentially up to the maximum", () => {
  const updates = new HostDdnsUpdateCoordinator(() => 1_000);

  assert.equal(updates.recordFailure(1), 61_000);
  assert.equal(updates.recordFailure(1), 121_000);
  assert.equal(updates.recordFailure(1), 241_000);
  assert.equal(updates.recordFailure(1), 481_000);
  assert.equal(updates.recordFailure(1), 961_000);
  assert.equal(updates.recordFailure(1), 1_801_000);
  assert.equal(updates.recordFailure(1), 1_801_000);
});

test("success clears the retry window", () => {
  const updates = new HostDdnsUpdateCoordinator(() => 10_000);

  updates.recordFailure(1);
  assert.equal(updates.canReconcile(1), false);
  updates.recordSuccess(1);
  assert.equal(updates.canReconcile(1), true);
  assert.equal(updates.recordFailure(1), 70_000, "the next failure starts again at one minute");
});

test("explicit updates bypass retry backoff but still deduplicate in-flight work", () => {
  const updates = new HostDdnsUpdateCoordinator(() => 10_000);

  updates.recordFailure(1);
  assert.equal(updates.canReconcile(1), false);
  assert.equal(updates.tryStart(1), true, "address and configuration changes may retry immediately");
  assert.equal(updates.tryStart(1), false);
  updates.finish(1);
  assert.equal(updates.tryStart(1), true);
});

test("forced reruns clear backoff after an in-flight update finishes", () => {
  const updates = new HostDdnsUpdateCoordinator(() => 10_000);

  assert.equal(updates.tryStart(1), true);
  updates.recordFailure(1);
  assert.equal(updates.tryStart(1, { force: true }), false);
  assert.deepEqual(updates.finish(1), {
    rerunRequested: true,
    immediate: true,
  });
  assert.equal(updates.canReconcile(1), true);
});

test("DDNS retry timers deduplicate the same deadline and replace changed deadlines", async () => {
  const now = 10_000;
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const retried: number[] = [];
  const scheduler = new HostDdnsRetryScheduler(
    async (hostId) => { retried.push(hostId); },
    () => now,
    ((callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    ((timer: any) => { timer.cleared = true; }) as any,
  );

  scheduler.replace(7, 70_000);
  scheduler.replace(7, 70_000);
  assert.equal(timers.length, 1, "the same host and deadline must keep one timer");
  assert.equal(timers[0].delayMs, 60_025);

  scheduler.replace(7, 130_000);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(scheduler.retryAt(7), 130_000);

  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(retried, [7]);
  assert.equal(scheduler.retryAt(7), null);
});

test("DDNS retry timers can be cancelled when a host converges or is disabled", () => {
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  const scheduler = new HostDdnsRetryScheduler(
    () => {},
    () => 10_000,
    ((callback: () => void) => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    ((timer: any) => { timer.cleared = true; }) as any,
  );

  scheduler.replace(8, 70_000);
  scheduler.replace(8, null);
  assert.equal(timers[0].cleared, true);
  assert.equal(scheduler.retryAt(8), null);
});

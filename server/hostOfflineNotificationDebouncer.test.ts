import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_OFFLINE_NOTIFICATION_DEBOUNCE_MS,
  HostOfflineNotificationDebouncer,
} from "./hostOfflineNotificationDebouncer";

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unrefed: boolean;
  unref: () => void;
};

function fakeTimerHarness() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer: ((callback: () => void, delayMs: number) => {
      const timer: FakeTimer = {
        callback,
        delayMs,
        cleared: false,
        unrefed: false,
        unref() { timer.unrefed = true; },
      };
      timers.push(timer);
      return timer;
    }) as any,
    clearTimer: ((timer: FakeTimer) => { timer.cleared = true; }) as any,
  };
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("recovery cancels the pending 30 second offline notification", () => {
  const clock = fakeTimerHarness();
  const notifications: number[] = [];
  const debouncer = new HostOfflineNotificationDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(debouncer.schedule(7, () => true, () => { notifications.push(7); }), true);
  assert.equal(debouncer.hasPending(7), true);
  assert.equal(clock.timers[0].delayMs, HOST_OFFLINE_NOTIFICATION_DEBOUNCE_MS);
  assert.equal(clock.timers[0].unrefed, true);

  assert.equal(debouncer.cancel(7), true);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(debouncer.hasPending(7), false);
  clock.timers[0].callback();
  assert.deepEqual(notifications, []);
});

test("a sustained offline generation notifies only once", () => {
  const clock = fakeTimerHarness();
  const notifications: number[] = [];
  const debouncer = new HostOfflineNotificationDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  debouncer.schedule(8, () => true, () => { notifications.push(8); });
  clock.timers[0].callback();
  clock.timers[0].callback();

  assert.deepEqual(notifications, [8]);
  assert.equal(debouncer.hasPending(8), false);
});

test("a new generation replaces an older pending task", () => {
  const clock = fakeTimerHarness();
  const notifications: string[] = [];
  const debouncer = new HostOfflineNotificationDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  debouncer.schedule(9, () => true, () => { notifications.push("old"); });
  debouncer.schedule(9, () => true, () => { notifications.push("new"); });

  assert.equal(clock.timers[0].cleared, true);
  assert.equal(debouncer.hasPending(9), true);
  clock.timers[0].callback();
  clock.timers[1].callback();
  assert.deepEqual(notifications, ["new"]);
});

test("clear cancels every host's pending notification", () => {
  const clock = fakeTimerHarness();
  const notifications: number[] = [];
  const debouncer = new HostOfflineNotificationDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  debouncer.schedule(10, () => true, () => { notifications.push(10); });
  debouncer.schedule(11, () => true, () => { notifications.push(11); });
  debouncer.clear();

  assert.ok(clock.timers.every((timer) => timer.cleared));
  assert.equal(debouncer.hasPending(10), false);
  assert.equal(debouncer.hasPending(11), false);
  for (const timer of clock.timers) timer.callback();
  assert.deepEqual(notifications, []);
});

test("stale guards and notification failures are contained", async () => {
  const clock = fakeTimerHarness();
  const errors: Array<{ hostId: number; message: string }> = [];
  const debouncer = new HostOfflineNotificationDebouncer({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (error, hostId) => {
      errors.push({ hostId, message: error instanceof Error ? error.message : String(error) });
    },
  });

  debouncer.schedule(12, () => false, () => { throw new Error("must not run"); });
  clock.timers[0].callback();
  debouncer.schedule(13, () => { throw new Error("guard failed"); }, () => {});
  clock.timers[1].callback();
  debouncer.schedule(14, () => true, async () => { throw new Error("notify failed"); });
  clock.timers[2].callback();
  await nextTurn();

  assert.deepEqual(errors, [
    { hostId: 13, message: "guard failed" },
    { hostId: 14, message: "notify failed" },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ForwardGroupEvaluationBatchError,
  ForwardGroupEvaluationQueue,
  FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS,
  ForwardGroupHealthRecheckScheduler,
  ForwardGroupHostSilenceScheduler,
  forwardGroupChinaHealthStateAt,
  isActivityFreshAt,
  nextForwardGroupChinaHealthExpiryAt,
  nextForwardGroupHealthRecheckAt,
} from "./forwardGroupHealthRecheck";

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("failed forward group evaluation is requeued with events received in flight", async () => {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const batches: number[][] = [];
  let rejectFirst!: (error: Error) => void;
  const queue = new ForwardGroupEvaluationQueue(
    async (groupIds) => {
      batches.push(groupIds);
      if (batches.length === 1) {
        await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      }
    },
    {
      debounceMs: 250,
      retryBaseMs: 1_000,
      retryMaxMs: 30_000,
      setTimer: ((callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      }) as any,
      clearTimer: ((timer: any) => { timer.cleared = true; }) as any,
    },
  );

  queue.enqueue([1, 2]);
  assert.equal(timers[0].delayMs, 250);
  timers[0].callback();
  queue.enqueue([3, 2]);
  assert.deepEqual(batches, [[1, 2]]);

  rejectFirst(new Error("temporary database failure"));
  await nextTurn();
  assert.equal(timers.length, 4);
  assert.equal(timers[1].delayMs, 1_000);
  assert.equal(timers[2].delayMs, 1_000);
  assert.equal(timers[3].delayMs, 250);

  timers[3].callback();
  await nextTurn();
  assert.deepEqual([...batches[1]].sort((left, right) => left - right), [2, 3]);
  assert.equal(timers[2].cleared, true, "a newer successful event cancels the old retry for the same group");

  timers[1].callback();
  assert.equal(timers[4].delayMs, 0);
  timers[4].callback();
  await nextTurn();
  assert.deepEqual(batches[2], [1]);
});

test("forward group evaluation retry delay backs off to a fixed upper bound", async () => {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const queue = new ForwardGroupEvaluationQueue(
    async () => { throw new Error("still unavailable"); },
    {
      debounceMs: 250,
      retryBaseMs: 1_000,
      retryMaxMs: 2_500,
      setTimer: ((callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, unref() {} };
        timers.push(timer);
        return timer;
      }) as any,
    },
  );

  queue.enqueue([7]);
  timers[0].callback();
  await nextTurn();
  const retryDelays: number[] = [];
  let timerIndex = 1;
  for (let index = 0; index < 4; index += 1) {
    const retryTimer = timers[timerIndex++];
    retryDelays.push(retryTimer.delayMs);
    retryTimer.callback();
    const immediateTimer = timers[timerIndex++];
    assert.equal(immediateTimer.delayMs, 0);
    immediateTimer.callback();
    await nextTurn();
  }
  assert.deepEqual(retryDelays, [1_000, 2_000, 2_500, 2_500]);
  assert.equal(timers[timerIndex].delayMs, 2_500);
});

test("one failing forward group does not requeue successful groups or delay new events", async () => {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const batches: number[][] = [];
  const queue = new ForwardGroupEvaluationQueue(
    async (groupIds) => {
      batches.push(groupIds);
      if (groupIds.includes(1)) {
        throw new ForwardGroupEvaluationBatchError([{ groupId: 1, error: new Error("group 1 unavailable") }]);
      }
    },
    {
      debounceMs: 250,
      retryBaseMs: 1_000,
      retryMaxMs: 30_000,
      setTimer: ((callback: () => void, delayMs: number) => {
        const timer = { callback, delayMs, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      }) as any,
      clearTimer: ((timer: any) => { timer.cleared = true; }) as any,
    },
  );

  queue.enqueue([1, 2]);
  timers[0].callback();
  await nextTurn();
  assert.deepEqual(batches, [[1, 2]]);
  assert.equal(timers[1].delayMs, 1_000, "only the failed group waits for retry");

  queue.enqueue([3]);
  assert.equal(timers[2].delayMs, 250, "new work keeps the normal debounce while another group backs off");
  timers[2].callback();
  await nextTurn();
  assert.deepEqual(batches, [[1, 2], [3]]);
  assert.equal(timers[1].cleared, false);

  timers[1].callback();
  assert.equal(timers[3].delayMs, 0);
  timers[3].callback();
  await nextTurn();
  assert.deepEqual(batches, [[1, 2], [3], [1]]);
});

test("forward group timeout schedules one evaluation at the 60 second threshold", async () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  const dueAt = nextForwardGroupHealthRecheckAt({
    members: [{ healthy: false, failureSince: new Date(now), failedLongEnough: false }],
    failoverMs: 60_000,
    recoverMs: 120_000,
    now,
  });
  assert.equal(dueAt, now + 60_000);

  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const evaluated: number[] = [];
  const scheduler = new ForwardGroupHealthRecheckScheduler(
    async (groupId) => { evaluated.push(groupId); },
    () => now,
    ((callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    ((timer: any) => { timer.cleared = true; }) as any,
  );

  scheduler.replace(9, dueAt);
  scheduler.replace(9, dueAt);
  assert.equal(timers.length, 1, "the same threshold must be deduplicated");
  assert.equal(timers[0].delayMs, 60_025);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(evaluated, [9]);
  assert.equal(scheduler.dueAt(9), null);
});

test("forward group recovery replaces and can cancel a pending failure evaluation", () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const scheduler = new ForwardGroupHealthRecheckScheduler(
    () => {},
    () => now,
    ((callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    }) as any,
    ((timer: any) => { timer.cleared = true; }) as any,
  );

  scheduler.replace(10, now + 60_000);
  scheduler.replace(10, now + 120_000);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  assert.equal(scheduler.dueAt(10), now + 120_000);

  scheduler.replace(10, null);
  assert.equal(timers[1].cleared, true);
  assert.equal(scheduler.dueAt(10), null);
});

test("completed failure and recovery windows do not schedule another evaluation", () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  assert.equal(nextForwardGroupHealthRecheckAt({
    members: [
      { healthy: false, failureSince: now - 60_000, failedLongEnough: true },
      { healthy: true, healthySince: now - 120_000, recoveredLongEnough: true },
    ],
    failoverMs: 60_000,
    recoverMs: 120_000,
    now,
  }), null);
});

test("an elapsed health deadline with a stale false flag schedules an immediate recheck", () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  assert.equal(nextForwardGroupHealthRecheckAt({
    members: [{ healthy: false, failureSince: now - 61_000, failedLongEnough: false }],
    failoverMs: 60_000,
    recoverMs: 120_000,
    now,
  }), now);
  assert.equal(nextForwardGroupHealthRecheckAt({
    members: [{ healthy: true, healthySince: now - 121_000, recoveredLongEnough: false }],
    failoverMs: 60_000,
    recoverMs: 120_000,
    now,
  }), now);
});

test("activity windows expire exactly at their configured deadline", () => {
  const now = 1_000_000;
  assert.equal(isActivityFreshAt(now - 150_000, 150_000, now), false);
  assert.equal(isActivityFreshAt(now - 149_999, 150_000, now), true);
  assert.equal(isActivityFreshAt(now - 150_001, 150_000, now), false);
});

test("China health snapshots expire exactly after the jitter-safe report window", () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  const checkedAt = now - 30_000;
  const expiresAt = checkedAt + FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS;
  const member = { isEnabled: true, chinaHealthStatus: "healthy", chinaHealthCheckedAt: checkedAt };

  assert.equal(FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS, 8 * 60_000);
  assert.equal(forwardGroupChinaHealthStateAt(member, expiresAt - 1), "healthy");
  assert.equal(forwardGroupChinaHealthStateAt(member, expiresAt), "stale");
  assert.equal(forwardGroupChinaHealthStateAt({ chinaHealthStatus: "healthy" }, now), "stale");
  assert.equal(forwardGroupChinaHealthStateAt({ chinaHealthStatus: "unknown" }, now), "pending");
  assert.equal(nextForwardGroupChinaHealthExpiryAt({ enabled: true, members: [member], now }), expiresAt);
});

test("China health expiry scheduling ignores states that cannot transition from healthy", () => {
  const now = Date.parse("2026-07-24T10:00:00Z");
  const freshCheckedAt = now - 60_000;
  assert.equal(nextForwardGroupChinaHealthExpiryAt({
    enabled: true,
    members: [
      { isEnabled: false, chinaHealthStatus: "healthy", chinaHealthCheckedAt: now },
      { isEnabled: true, chinaHealthStatus: "unhealthy", chinaHealthCheckedAt: now },
      { isEnabled: true, chinaHealthStatus: "unknown", chinaHealthCheckedAt: null },
      { isEnabled: true, chinaHealthStatus: "healthy", chinaHealthCheckedAt: freshCheckedAt },
    ],
    now,
  }), freshCheckedAt + FORWARD_GROUP_CHINA_HEALTH_FRESHNESS_TTL_MS);
  assert.equal(nextForwardGroupChinaHealthExpiryAt({
    enabled: false,
    members: [{ isEnabled: true, chinaHealthStatus: "healthy", chinaHealthCheckedAt: now }],
    now,
  }), null);
});

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unrefed: boolean;
  unref: () => void;
};

function fakeTimerHarness(startedAt: number) {
  let current = startedAt;
  const timers: FakeTimer[] = [];
  return {
    timers,
    now: () => current,
    moveTo: (value: number) => { current = value; },
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

test("host activity deduplicates and resets one unrefed silence timer", async () => {
  const clock = fakeTimerHarness(1_000);
  const resolvedHosts: number[] = [];
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async (hostId) => {
      resolvedHosts.push(hostId);
      return [];
    },
    () => {},
    {
      silenceMs: 4_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  assert.equal(scheduler.observe(7, 1_000), true);
  assert.equal(scheduler.pendingAt(7), 5_000);
  assert.deepEqual(scheduler.pendingHostIds(), [7]);
  assert.equal(clock.timers[0].delayMs, 4_000);
  assert.equal(clock.timers[0].unrefed, true);

  scheduler.observe(7, 1_000);
  assert.equal(clock.timers.length, 1, "the same activity sample must not replace its timer");

  clock.moveTo(2_000);
  scheduler.observe(7, 2_000);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(clock.timers[1].delayMs, 4_000);
  assert.equal(scheduler.pendingAt(7), 6_000);

  clock.timers[0].callback();
  assert.deepEqual(resolvedHosts, [], "a replaced timer must not resolve stale host state");

  clock.moveTo(5_999);
  clock.timers[1].callback();
  assert.equal(clock.timers[2].delayMs, 1, "an early timer tick is rearmed for the remaining duration");
  clock.moveTo(6_000);
  clock.timers[2].callback();
  await nextTurn();
  assert.deepEqual(resolvedHosts, [7]);
  assert.equal(scheduler.pendingAt(7), null);
});

test("a silent host resolves once and triggers groups at their separate deadlines", async () => {
  const clock = fakeTimerHarness(1_000);
  let resolveCount = 0;
  const triggered: number[][] = [];
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async () => {
      resolveCount += 1;
      return [
        { groupId: 11, timeoutMs: 10_000 },
        { groupId: 12, timeoutMs: 20_000 },
        { groupId: 11, timeoutMs: 15_000 },
      ];
    },
    async (groupIds) => { triggered.push(groupIds); },
    {
      silenceMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  scheduler.observe(3, 1_000);
  clock.moveTo(2_000);
  clock.timers[0].callback();
  await nextTurn();
  assert.equal(resolveCount, 1);
  assert.equal(scheduler.dueAt(11), 12_000);
  assert.equal(scheduler.dueAt(12), 22_000);
  assert.deepEqual(scheduler.pendingGroupIds().sort((left, right) => left - right), [11, 12]);
  assert.equal(clock.timers[1].delayMs, 10_000);
  assert.equal(clock.timers[1].unrefed, true);

  clock.moveTo(12_000);
  clock.timers[1].callback();
  await nextTurn();
  assert.deepEqual(triggered, [[11]]);
  assert.equal(scheduler.dueAt(11), null);
  assert.equal(scheduler.dueAt(12), 22_000);
  assert.equal(clock.timers[2].delayMs, 10_000);

  clock.moveTo(22_000);
  clock.timers[2].callback();
  await nextTurn();
  assert.deepEqual(triggered, [[11], [12]]);
  assert.equal(resolveCount, 1, "continued silence must not repeat the host lookup");
  assert.deepEqual(scheduler.pendingGroupIds(), []);
});

test("new activity wins a race with an in-flight silence lookup", async () => {
  const clock = fakeTimerHarness(1_000);
  let resolveCount = 0;
  let finishFirst!: (value: Array<{ groupId: number; timeoutMs: number }>) => void;
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async () => {
      resolveCount += 1;
      if (resolveCount === 1) {
        return new Promise<Array<{ groupId: number; timeoutMs: number }>>((resolve) => {
          finishFirst = resolve;
        });
      }
      return [{ groupId: 21, timeoutMs: 500 }];
    },
    () => {},
    {
      silenceMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  scheduler.observe(5, 1_000);
  clock.moveTo(2_000);
  clock.timers[0].callback();
  assert.equal(resolveCount, 1);

  clock.moveTo(2_100);
  scheduler.observe(5, 2_100);
  assert.equal(scheduler.pendingAt(5), 3_100);
  finishFirst([{ groupId: 20, timeoutMs: 100 }]);
  await nextTurn();
  assert.equal(scheduler.dueAt(20), null, "the stale lookup must not install deadlines");

  clock.moveTo(3_100);
  clock.timers[1].callback();
  await nextTurn();
  assert.equal(resolveCount, 2);
  assert.equal(scheduler.dueAt(21), 3_600);
});

test("lookup and trigger failures retry without shifting the original group deadline", async () => {
  const clock = fakeTimerHarness(1_000);
  let resolveCount = 0;
  let triggerCount = 0;
  const errors: Array<{ phase: string; retryAt: number }> = [];
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async () => {
      resolveCount += 1;
      if (resolveCount === 1) throw new Error("database unavailable");
      return [{ groupId: 31, timeoutMs: 1_000 }];
    },
    async () => {
      triggerCount += 1;
      if (triggerCount === 1) throw new Error("queue unavailable");
    },
    {
      silenceMs: 1_000,
      retryMs: 500,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onError: (_error, context) => { errors.push({ phase: context.phase, retryAt: context.retryAt }); },
    },
  );

  scheduler.observe(8, 1_000, 2_000);
  clock.moveTo(2_000);
  clock.timers[0].callback();
  await nextTurn();
  assert.equal(scheduler.pendingAt(8), 2_500);
  assert.deepEqual(errors, [{ phase: "resolve", retryAt: 2_500 }]);

  clock.moveTo(2_500);
  clock.timers[1].callback();
  await nextTurn();
  assert.equal(scheduler.dueAt(31), 3_000, "a lookup retry must preserve the original silence cutoff");
  assert.equal(clock.timers[2].delayMs, 500);

  clock.moveTo(3_000);
  clock.timers[2].callback();
  await nextTurn();
  assert.equal(scheduler.dueAt(31), 3_500);
  assert.deepEqual(errors, [
    { phase: "resolve", retryAt: 2_500 },
    { phase: "trigger", retryAt: 3_500 },
  ]);

  clock.moveTo(3_500);
  clock.timers[3].callback();
  await nextTurn();
  assert.equal(triggerCount, 2);
  assert.equal(scheduler.dueAt(31), null);
  assert.ok(clock.timers.every((timer) => timer.unrefed), "every scheduler timer must be unrefed");
});

test("startup notBefore delays only the lookup and preserves the original liveness deadline", async () => {
  const clock = fakeTimerHarness(10_000);
  const triggered: number[][] = [];
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async () => [{ groupId: 35, timeoutMs: 9_000 }],
    async (groupIds) => { triggered.push(groupIds); },
    {
      silenceMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  scheduler.observe(9, 1_000, 15_000);
  assert.equal(scheduler.pendingAt(9), 15_000);
  assert.equal(clock.timers[0].delayMs, 5_000);

  clock.moveTo(15_000);
  clock.timers[0].callback();
  await nextTurn();

  assert.equal(scheduler.dueAt(35), 11_000);
  assert.equal(clock.timers[1].delayMs, 0);
  clock.timers[1].callback();
  await nextTurn();

  assert.equal(scheduler.dueAt(35), null);
  assert.deepEqual(triggered, [[35]], "an already-expired deadline must run immediately after startup grace");
});

test("new host activity cancels only that host's copy of a shared group deadline", async () => {
  const clock = fakeTimerHarness(1_000);
  const scheduler = new ForwardGroupHostSilenceScheduler(
    async (hostId) => [{ groupId: 41, timeoutMs: hostId === 1 ? 1_000 : 2_000 }],
    () => {},
    {
      silenceMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );

  scheduler.observe(1, 1_000);
  scheduler.observe(2, 1_000, 2_500);
  clock.moveTo(2_000);
  clock.timers[0].callback();
  await nextTurn();
  assert.equal(scheduler.dueAt(41), 3_000);

  clock.moveTo(2_500);
  clock.timers[1].callback();
  await nextTurn();
  assert.equal(scheduler.dueAt(41), 3_000);

  clock.moveTo(2_600);
  scheduler.observe(1, 2_600);
  assert.equal(scheduler.dueAt(41), 4_000, "the other silent host's original deadline must remain scheduled");
});

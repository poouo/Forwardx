import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FAST_LIVENESS_SILENCE_MS,
  AGENT_FAST_LIVENESS_STARTUP_GRACE_MS,
  AgentFastLivenessTracker,
  getPresenceCapableHostLivenessSnapshot,
  observePresenceCapableHostActivity,
  registerPresenceCapableHost,
  removePresenceCapableHost,
  supportsAgentFastLiveness,
  type AgentFastLivenessTransition,
} from "./agentFastLiveness";
import { clearAuthenticatedAgentActivity, recordAuthenticatedAgentActivity } from "./agentActivity";

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

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("fast liveness is limited to Agents that support lightweight presence", () => {
  assert.equal(supportsAgentFastLiveness("2.2.170"), false);
  assert.equal(supportsAgentFastLiveness("2.2.171"), true);
  assert.equal(supportsAgentFastLiveness("v2.3.272"), true);
  assert.equal(supportsAgentFastLiveness(null), false);
});

test("prime registers only eligible hosts behind one startup observation grace", () => {
  const clock = fakeTimerHarness(100_000);
  const transitions: AgentFastLivenessTransition[] = [];
  const tracker = new AgentFastLivenessTracker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.subscribe((event) => { transitions.push(event); });

  assert.equal(tracker.primeHosts([
    { id: 1, agentVersion: "2.2.170", lastHeartbeat: 99_000 },
    { id: 2, agentVersion: "2.2.171", isOnline: false, lastHeartbeat: 1_000 },
    { id: 3, agentVersion: "2.3.0", lastHeartbeat: new Date(99_000) },
  ]), 2);
  assert.deepEqual(tracker.registeredHostIds(), [2, 3]);
  assert.equal(clock.timers.length, 2);
  assert.ok(clock.timers.every((timer) => timer.delayMs === AGENT_FAST_LIVENESS_STARTUP_GRACE_MS));
  assert.ok(clock.timers.every((timer) => timer.unrefed));
  assert.equal(tracker.state(2)?.lastOfflineAt, 100_000, "persisted offline state invalidates pre-restart health samples");

  clock.moveTo(100_000 + AGENT_FAST_LIVENESS_STARTUP_GRACE_MS);
  clock.timers[0].callback();
  assert.equal(tracker.isConfirmedOffline(2), true, "state changes synchronously in the timer callback");
  assert.equal(transitions[0].kind, "confirmed-offline");
  assert.equal(transitions[0].isCurrent(), true);
});

test("authenticated activity resets the 25 second deadline and stale timers cannot win", () => {
  const clock = fakeTimerHarness(1_000);
  const transitions: AgentFastLivenessTransition[] = [];
  const tracker = new AgentFastLivenessTracker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.subscribe((event) => { transitions.push(event); });
  tracker.registerHost({ id: 7, agentVersion: "2.3.0" });

  assert.equal(clock.timers[0].delayMs, AGENT_FAST_LIVENESS_SILENCE_MS);
  const initialEpoch = tracker.state(7)?.transitionEpoch;
  clock.moveTo(6_000);
  assert.equal(tracker.observeActivity(7, 6_000), true);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(clock.timers[1].delayMs, AGENT_FAST_LIVENESS_SILENCE_MS);
  assert.equal(tracker.state(7)?.transitionEpoch, initialEpoch, "routine presence must not advance the transition epoch");

  clock.moveTo(26_000);
  clock.timers[0].callback();
  assert.equal(tracker.isConfirmedOffline(7), false);
  assert.deepEqual(transitions, []);

  clock.moveTo(31_000);
  clock.timers[1].callback();
  assert.equal(tracker.isConfirmedOffline(7), true);
  assert.equal(tracker.state(7)?.offlineAt, 31_000);
  assert.equal(tracker.state(7)?.lastOfflineAt, 31_000);
  assert.equal(transitions.length, 1);
});

test("an early timer tick rearms only the current generation", () => {
  const clock = fakeTimerHarness(5_000);
  const tracker = new AgentFastLivenessTracker({
    silenceMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.registerHost({ id: 8, agentVersion: "2.3.0" });

  clock.moveTo(5_900);
  clock.timers[0].callback();
  assert.equal(tracker.isConfirmedOffline(8), false);
  assert.equal(clock.timers[1].delayMs, 100);
  assert.equal(clock.timers[1].unrefed, true);

  clock.moveTo(6_000);
  clock.timers[1].callback();
  assert.equal(tracker.isConfirmedOffline(8), true);
});

test("new activity clears confirmed offline and invalidates async offline work", async () => {
  const clock = fakeTimerHarness(10_000);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let currentAfterAwait: boolean | null = null;
  const transitions: AgentFastLivenessTransition[] = [];
  const tracker = new AgentFastLivenessTracker({
    silenceMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.subscribe(async (event) => {
    transitions.push(event);
    if (event.kind !== "confirmed-offline") return;
    await waiting;
    currentAfterAwait = event.isCurrent();
  });
  tracker.registerHost({ id: 9, agentVersion: "2.3.0" });

  clock.moveTo(11_000);
  clock.timers[0].callback();
  const offlineEvent = transitions[0];
  assert.equal(tracker.isConfirmedOffline(9), true);
  assert.equal(offlineEvent.isCurrent(), true);

  clock.moveTo(11_100);
  tracker.observeActivity(9, 11_100);
  assert.equal(tracker.isConfirmedOffline(9), false);
  assert.equal(tracker.state(9)?.offlineAt, null);
  assert.equal(tracker.state(9)?.lastOfflineAt, 11_000);
  assert.equal(offlineEvent.isCurrent(), false);
  assert.equal(transitions[1].kind, "activity-restored");
  assert.equal(transitions[1].isCurrent(), true);

  release();
  await nextTurn();
  assert.equal(currentAfterAwait, false);
});

test("an older offline event stays stale across a later offline transition", () => {
  const clock = fakeTimerHarness(20_000);
  const offlineEvents: AgentFastLivenessTransition[] = [];
  const tracker = new AgentFastLivenessTracker({
    silenceMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.subscribeOffline((event) => { offlineEvents.push(event); });
  tracker.registerPresenceCapableHost(12, 20_000);

  clock.moveTo(21_000);
  clock.timers[0].callback();
  tracker.observeActivity(12, 21_000);
  clock.moveTo(22_000);
  clock.timers[1].callback();

  assert.equal(offlineEvents.length, 2);
  assert.equal(offlineEvents[0].isCurrent(), false);
  assert.equal(offlineEvents[1].isCurrent(), true);
  assert.notEqual(offlineEvents[0].transitionEpoch, offlineEvents[1].transitionEpoch);
});

test("removing or downgrading a host cancels its pending deadline", () => {
  const clock = fakeTimerHarness(1_000);
  const tracker = new AgentFastLivenessTracker({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  tracker.registerHost({ id: 10, agentVersion: "2.3.0" });
  assert.equal(tracker.registerHost({ id: 10, agentVersion: "2.2.170" }), false);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(tracker.hasHost(10), false);
  clock.moveTo(100_000);
  clock.timers[0].callback();
  assert.equal(tracker.isConfirmedOffline(10), false);
});

test("the shared tracker accepts explicit liveness activity but ignores unrelated authenticated reports", () => {
  const hostId = 987_654_321;
  const firstSeenAt = Date.now() - 2_000;
  const nextSeenAt = firstSeenAt + 1_000;
  removePresenceCapableHost(hostId);
  clearAuthenticatedAgentActivity(hostId);
  try {
    assert.equal(registerPresenceCapableHost(hostId, firstSeenAt), true);
    assert.equal(getPresenceCapableHostLivenessSnapshot(hostId)?.lastSeenAt, firstSeenAt);

    recordAuthenticatedAgentActivity(hostId, nextSeenAt);
    assert.equal(
      getPresenceCapableHostLivenessSnapshot(hostId)?.lastSeenAt,
      firstSeenAt,
      "a non-heartbeat Agent report must not conceal a failed presence loop",
    );
    observePresenceCapableHostActivity(hostId, nextSeenAt);
    assert.equal(getPresenceCapableHostLivenessSnapshot(hostId)?.lastSeenAt, nextSeenAt);
  } finally {
    removePresenceCapableHost(hostId);
    clearAuthenticatedAgentActivity(hostId);
  }
});

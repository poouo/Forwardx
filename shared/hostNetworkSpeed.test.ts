import assert from "node:assert/strict";
import test from "node:test";
import { hostNetworkSpeed, HOST_NETWORK_SAMPLE_MAX_AGE_MS, hostNetworkSampleAgeMs, stampHostNetworkMetrics } from "./hostNetworkSpeed";

const now = 1_800_000_000_000;
const previous = { recordedAt: now - 3000, uptime: 100, networkIn: 1000, networkOut: 2000 };
const latest = { recordedAt: now, uptime: 103, networkIn: 4000, networkOut: 8000 };
const unknown = { in: null, out: null };

test("network rates use Agent collection time despite panel receipt jitter", () => {
  assert.deepEqual(hostNetworkSpeed(latest, previous, { now }), { in: 1000, out: 2000 });
  assert.deepEqual(hostNetworkSpeed({ ...latest, recordedAt: now - 2000 }, previous, { now }), { in: 1000, out: 2000 });
  assert.deepEqual(hostNetworkSpeed({ ...latest, uptime: undefined }, previous, { now }), { in: 1000, out: 2000 });
  assert.deepEqual(hostNetworkSpeed({ ...latest, uptime: undefined, recordedAt: now - 1500 }, previous, { now }), { in: 2000, out: 4000 });
});

test("missing counters never become zero baselines or fake spikes", () => {
  for (const missing of [null, undefined, "", NaN, Infinity, -1]) {
    assert.deepEqual(hostNetworkSpeed(latest, { ...previous, networkIn: missing }, { now }), { in: null, out: 2000 });
    assert.deepEqual(hostNetworkSpeed({ ...latest, networkIn: missing }, previous, { now }), { in: null, out: 2000 });
  }
  assert.deepEqual(hostNetworkSpeed({ ...latest, networkIn: 0 }, { ...previous, networkIn: 0 }, { now }), { in: 0, out: 2000 });
});

test("reboots, counter resets and repeated/reversed timestamps do not yield valid speeds", () => {
  assert.deepEqual(hostNetworkSpeed({ ...latest, uptime: 1 }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, uptime: 100 }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, recordedAt: previous.recordedAt }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, recordedAt: previous.recordedAt - 1 }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, networkIn: 10 }, previous, { now }), { in: null, out: 2000 });
});

test("offline, stale, distant and future samples never present historical rates as live", () => {
  assert.deepEqual(hostNetworkSpeed(latest, previous, { now, isOnline: false }), unknown);
  assert.deepEqual(hostNetworkSpeed(latest, previous, { now: now + HOST_NETWORK_SAMPLE_MAX_AGE_MS + 1 }), unknown);
  assert.deepEqual(hostNetworkSpeed(latest, { ...previous, recordedAt: now - 300_000 }, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, recordedAt: now + 10_000 }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, recordedAt: null }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed(latest, null, { now }), unknown);
});

test("explicit rejected speeds stay unknown across cards and themes", () => {
  assert.deepEqual(hostNetworkSpeed({ ...latest, networkSpeedIn: null, networkSpeedOut: null }, previous, { now }), unknown);
  assert.deepEqual(hostNetworkSpeed({ ...latest, networkSpeedIn: 0, networkSpeedOut: 123 }, previous, { now }), { in: 0, out: 123 });
  assert.deepEqual(hostNetworkSpeed({ ...latest, networkSpeedIn: Infinity, networkSpeedOut: -1 }, previous, { now }), unknown);
});

test("fresh server rates survive browser clock skew in either direction", () => {
  const metric = { ...latest, networkSpeedIn: 1000, networkSpeedOut: 2000, networkSampleAgeMs: 2000 };
  for (const skew of [-3_600_000, 3_600_000]) {
    const receivedAt = now + skew;
    const [stamped] = stampHostNetworkMetrics([metric], receivedAt);
    assert.deepEqual(hostNetworkSpeed(stamped, undefined, { now: receivedAt + 1000 }), { in: 1000, out: 2000 });
    assert.deepEqual(hostNetworkSpeed(stamped, undefined, { now: receivedAt + HOST_NETWORK_SAMPLE_MAX_AGE_MS }), unknown);
    assert.deepEqual(hostNetworkSpeed(stamped, undefined, { now: receivedAt, isOnline: false }), unknown);
    assert.deepEqual(hostNetworkSpeed({ ...stamped, networkSpeedIn: null, networkSpeedOut: null }, previous, { now: receivedAt }), unknown);
  }
});

test("query and disk caches retain sample age instead of renewing old rates on mount", () => {
  const metric = { ...latest, networkSpeedIn: 0, networkSpeedOut: 0, networkSampleAgeMs: 20_000 };
  const [stamped] = stampHostNetworkMetrics([metric], now);
  const restored = JSON.parse(JSON.stringify(stamped));
  assert.deepEqual(hostNetworkSpeed(restored, undefined, { now: now + 70_001 }), unknown);
  const [remounted] = stampHostNetworkMetrics([metric], now);
  assert.deepEqual(hostNetworkSpeed(remounted, undefined, { now: now + 70_001 }), unknown);
  assert.deepEqual(hostNetworkSpeed(stamped, undefined, { now: now + 1000 }), { in: 0, out: 0 });
  assert.equal(hostNetworkSampleAgeMs(latest, now + 1000), 1000);
  assert.equal(hostNetworkSampleAgeMs({ recordedAt: "invalid" }, now), null);
  assert.deepEqual(stampHostNetworkMetrics([latest], now), [latest], "old panels without age metadata remain compatible");
});

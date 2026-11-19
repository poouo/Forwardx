import assert from "node:assert/strict";
import test from "node:test";
import { HostNetworkLive } from "./hostNetworkLive";
import { hostNetworkSpeed, stampHostNetworkMetrics } from "../shared/hostNetworkSpeed";

test("network presence stays live throughout a three-minute runtime reconciliation stall", () => {
  let now = Date.now();
  const live = new HostNetworkLive(() => now);
  const row = { hostId: 1, cpuUsage: 12, recordedAt: new Date(now - 180_000), networkSpeedIn: null, networkSpeedOut: null };
  for (let seconds = 0; seconds <= 180; seconds += 5) {
    live.record(1, { uptime: 100 + seconds, networkIn: seconds * 1000, networkOut: seconds * 2000 }, "boot");
    const merged = live.merge(row);
    assert.equal(merged.cpuUsage, 12, "partial network samples must not erase CPU/disk metrics");
    if (seconds > 0) {
      const [browser] = stampHostNetworkMetrics([{ ...merged, networkSampleAgeMs: 0 }], now - 3600_000);
      assert.deepEqual(hostNetworkSpeed(browser, undefined, { now: now - 3600_000 }), { in: 1000, out: 2000 });
    }
    now += 5000;
  }
});

test("duplicate/delayed samples do not erase a good baseline; reboot/reset and staleness stay unknown", () => {
  let now = Date.now();
  const live = new HostNetworkLive(() => now);
  const row = { hostId: 1, recordedAt: new Date(now - 1000) };
  live.record(1, { uptime: 100, networkIn: 1000, networkOut: 2000 }, "boot");
  now += 5000;
  live.record(1, { uptime: 105, networkIn: 6000, networkOut: 12000 }, "boot");
  live.record(1, { uptime: 105, networkIn: 6000, networkOut: 12000 }, "boot");
  assert.deepEqual(hostNetworkSpeed(live.merge(row), undefined, { now }), { in: 1000, out: 2000 });
  assert.equal(live.record(1, { uptime: 101, networkIn: 2000, networkOut: 4000 }, "boot"), false);
  now += 5000;
  live.record(1, { uptime: 1, networkIn: 0, networkOut: 0 }, "new-boot");
  assert.deepEqual(hostNetworkSpeed(live.merge(row), undefined, { now }), { in: null, out: null });
  now += 5000;
  live.record(1, { uptime: 6, networkIn: 0, networkOut: 0 }, "new-boot");
  assert.deepEqual(hostNetworkSpeed(live.merge(row), undefined, { now }), { in: 0, out: 0 });
  now += 90_001;
  assert.equal(live.snapshots(1), null);
  assert.deepEqual(hostNetworkSpeed(live.merge(row), undefined, { now }), { in: null, out: null });
  assert.equal(live.record(1, { uptime: 10, networkIn: null, networkOut: 0 }), false);
});

test("network cache is bounded and cannot replace a newer database sample", () => {
  let now = Date.now();
  const live = new HostNetworkLive(() => now, 2);
  for (const id of [1, 2, 3]) live.record(id, { uptime: 10, networkIn: 0, networkOut: 0 });
  assert.equal(live.snapshots(1), null);
  const row = { hostId: 3, recordedAt: new Date(now + 1000), networkSpeedIn: 20 };
  assert.equal(live.merge(row), row);
});

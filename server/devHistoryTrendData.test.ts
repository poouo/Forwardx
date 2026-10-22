import assert from "node:assert/strict";
import test from "node:test";
import { devAvailabilityPeriods, devProbeTrendSample, uncoveredPeriods } from "./devHistoryTrendData";

test("demo history includes noon outages, recovery, partial coverage and probe loss", () => {
  const rows = devAvailabilityPeriods(0, 86400, 3);
  assert.ok(rows.some(row => !row.online && row.startAt === 43200));
  assert.ok(rows.some(row => row.online && row.startAt > 43200));
  assert.ok(rows.reduce((sum, row) => sum + row.endAt - row.startAt, 0) < 86400);
  assert.equal(devProbeTrendSample(48, 1).isTimeout, true);
  assert.equal(devProbeTrendSample(33, 1).probeSuccesses, 97);
  assert.equal(devProbeTrendSample(60, 1).probeSuccesses, 100);
  assert.deepEqual(uncoveredPeriods(0, 100, [{ startAt: 10, endAt: 30 }, { startAt: 20, endAt: 40 }, { startAt: 80, endAt: 120 }]), [{ startAt: 0, endAt: 10 }, { startAt: 40, endAt: 80 }]);
  assert.deepEqual(uncoveredPeriods(0, 100, [{ startAt: 0, endAt: 100 }]), [], "reuse must not overwrite or duplicate existing data");
});

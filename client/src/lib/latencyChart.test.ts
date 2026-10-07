import assert from "node:assert/strict";
import test from "node:test";
import { getLatencyStabilityStats } from "./latencyChart";

test("latency stability stats count partial packet loss", () => {
  const stats = getLatencyStabilityStats([
    { latency: 24, isTimeout: false, probeCount: 5, probeSuccesses: 4 },
  ]);

  assert.equal(stats.total, 5);
  assert.equal(stats.timeout, 1);
  assert.equal(stats.valid, 4);
  assert.equal(stats.lossRate, 20);
  assert.equal(stats.avg, 24);
});

test("latency stability stats preserve legacy binary rows", () => {
  const stats = getLatencyStabilityStats([
    { latency: 12, isTimeout: false },
    { latency: 0, isTimeout: true },
  ]);

  assert.equal(stats.total, 2);
  assert.equal(stats.timeout, 1);
  assert.equal(stats.valid, 1);
  assert.equal(stats.lossRate, 50);
});

test("cumulative counters correct biased history without replaying cached failures", () => {
  const chart = [
    { latency: 8, probeCount: 3, probeSuccesses: 3 },
    ...Array.from({ length: 30 }, () => ({ latency: 8, probeCount: 3, probeSuccesses: 2 })),
    { latency: 8, probeCount: 3, probeSuccesses: 3 },
  ];
  assert.equal(getLatencyStabilityStats(chart).score, 10, "old biased samples reproduce the reported issue");
  const stats = getLatencyStabilityStats(chart, { total: 3000, successes: 2997, available: true, observedSince: null, latestAt: null });
  assert.equal(stats.total, 3000);
  assert.equal(stats.timeout, 3);
  assert.equal(stats.lossRate, 0.1);
  assert.equal(stats.avg, 8, "latency averages use latency sample weights, not lifetime counters");
  assert.equal(stats.maxLossRun, 0, "cached health samples are not a real run of failed probes");
  assert.ok(stats.score! >= 90);
});

test("old or unavailable telemetry preserves latency but does not invent an accurate loss rate", () => {
  const samples = [{ latency: 8, probeCount: 3, probeSuccesses: 2 }];
  for (const counters of [null, { total: 0, successes: 0, available: false, observedSince: null, latestAt: null }]) {
    const stats = getLatencyStabilityStats(samples, counters);
    assert.equal(stats.total, 0);
    assert.equal(stats.avg, 8);
    assert.equal(stats.score, null);
  }
});

test("real partial failures remain visible and all failed probes still receive a low score", () => {
  const actual = { total: 300, successes: 200, available: true, observedSince: null, latestAt: null };
  assert.equal(getLatencyStabilityStats([{ latency: 8 }], actual).score, 10);
  assert.equal(getLatencyStabilityStats([], { ...actual, successes: 0 }).score, 0);
  assert.equal(getLatencyStabilityStats([], actual).score, null, "missing latency is not total unreachability");
});

test("compacted multi-batch rows keep counts larger than a single wire batch", () => {
  const stats = getLatencyStabilityStats([{ latency: 8, probeCount: 1500, probeSuccesses: 1499 }]);
  assert.equal(stats.total, 1500);
  assert.equal(stats.timeout, 1);
});


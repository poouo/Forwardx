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


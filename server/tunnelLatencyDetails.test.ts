import assert from "node:assert/strict";
import test from "node:test";
import {
  selectTunnelLatencyDetailPathKey,
  structuredTunnelMessageMatchesLatency,
  tunnelLatencySampleIsAfterBaseline,
  tunnelDetailHostEdges,
  tunnelDetailsMatchTopology,
  tunnelLatencyProbeSourceHostIds,
} from "./tunnelLatencyDetails";

test("latest total latency selects the matching branch from the same sample batch", () => {
  const recordedAt = new Date("2026-07-31T10:00:00.000Z");
  assert.equal(selectTunnelLatencyDetailPathKey({
    seriesKey: "total",
    latencyMs: 48,
    isTimeout: false,
    recordedAt,
  }, [
    { seriesKey: "primary", latencyMs: 21, isTimeout: false, recordedAt },
    { seriesKey: "exit-2", latencyMs: 48, isTimeout: false, recordedAt },
    { seriesKey: "exit-3", latencyMs: 48, isTimeout: false, recordedAt: new Date(recordedAt.getTime() - 60_000) },
  ]), "exit-2");

  assert.equal(selectTunnelLatencyDetailPathKey({
    seriesKey: "total",
    latencyMs: null,
    isTimeout: true,
    recordedAt,
  }, [
    { seriesKey: "relay-2", latencyMs: null, isTimeout: true, recordedAt },
    { seriesKey: "relay-1", latencyMs: null, isTimeout: true, recordedAt },
  ]), "relay-1");
});

test("structured fallback must belong to the current latency sample", () => {
  const recordedAt = new Date("2026-07-31T10:00:00.000Z");
  assert.equal(structuredTunnelMessageMatchesLatency("2026-07-31T09:59:30.000Z", recordedAt), true);
  assert.equal(structuredTunnelMessageMatchesLatency("2026-07-31T09:59:29.999Z", recordedAt), false);
  assert.equal(structuredTunnelMessageMatchesLatency(undefined, recordedAt), false);
});

test("a timed-out refresh cannot reuse its baseline latency row", () => {
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 41 }, 41), false);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 42 }, 41), true);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 40 }, 41), false);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 42 }, 0), true);
  assert.equal(tunnelLatencySampleIsAfterBaseline(undefined, 41), false);
});

test("explicit detail host ids take precedence over stale labels", () => {
  assert.deepEqual(tunnelDetailHostEdges([{
    fromHostId: 10,
    toHostId: 20,
    hopLabel: "1/1 90->91",
    routeLabel: "old 90 -> 91",
  }]), [[10, 20]]);
});

test("relay failover validates complete candidate paths instead of a linear relay chain", () => {
  const tunnel = {
    id: 71,
    mode: "forwardx",
    relayMode: "failover",
    entryHostId: 10,
    exitHostId: 40,
  };
  const hops = [
    { hostId: 10 },
    { hostId: 20 },
    { hostId: 30 },
    { hostId: 40 },
  ];
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 11, toHostId: 30, hopLabel: "stale 10->20" },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), true);
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 10, toHostId: 20 },
      { fromHostId: 20, toHostId: 30 },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), false);
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 10, toHostId: 20 },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), false);
});

test("a forced tunnel refresh targets entries and relay sources but not exits", () => {
  const hops = [
    { hostId: 10 },
    { hostId: 20 },
    { hostId: 30 },
    { hostId: 40 },
  ];
  assert.deepEqual(tunnelLatencyProbeSourceHostIds([10, 11], hops), [10, 11, 20, 30]);
  assert.deepEqual(tunnelLatencyProbeSourceHostIds([10, 11], []), [10, 11]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { clearTunnelAutoHopLatencyState, getTunnelAutoHopDetails, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";

test("automatic tunnel probes retain fresh per-hop source and target details", () => {
  const base = {
    tunnelId: 94001,
    hopCount: 2,
    generation: "topology-v1",
  };
  recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 0,
    fromHostId: 10,
    toHostId: 20,
    latencyMs: 12,
    isTimeout: false,
  });
  recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 1,
    fromHostId: 20,
    toHostId: 30,
    latencyMs: 21,
    isTimeout: false,
  });

  const details = getTunnelAutoHopDetails(base);
  assert.ok(details);
  assert.deepEqual(details.map(({ recordedAt: _recordedAt, ...detail }) => detail), [
    { hopIndex: 0, hopCount: 2, fromHostId: 10, toHostId: 20, latencyMs: 12, isTimeout: false },
    { hopIndex: 1, hopCount: 2, fromHostId: 20, toHostId: 30, latencyMs: 21, isTimeout: false },
  ]);
  assert.ok(details.every((detail) => detail.recordedAt > 0));
});

test("automatic tunnel hop aggregation preserves partial packet loss", () => {
  const base = { tunnelId: 94010, hopCount: 2, generation: "partial-loss" };
  assert.equal(recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 0,
    latencyMs: 12,
    isTimeout: false,
    probeCount: 3,
    probeSuccesses: 2,
  }), null);
  assert.deepEqual(recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 1,
    latencyMs: 18,
    isTimeout: false,
    probeCount: 3,
    probeSuccesses: 3,
  }), {
    success: true,
    latencyMs: 30,
    probeCount: 3,
    probeSuccesses: 2,
  });
  const details = getTunnelAutoHopDetails(base);
  assert.ok(details);
  assert.equal(details[0].probeCount, 3);
  assert.equal(details[0].probeSuccesses, 2);
});

test("automatic tunnel all-packet loss is not rewritten as a binary success", () => {
  const base = { tunnelId: 94011, hopCount: 2, generation: "full-loss", pathKey: "relay-1", allowEarlyFailure: true };
  const aggregate = recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 0,
    latencyMs: null,
    isTimeout: true,
    probeCount: 3,
    probeSuccesses: 0,
  });
  assert.deepEqual(aggregate, {
    success: false,
    latencyMs: null,
    probeCount: 3,
    probeSuccesses: 0,
  });
});

test("automatic tunnel details reject a different topology generation", () => {
  const base = { tunnelId: 94002, hopCount: 1, generation: "new-topology" };
  recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 0,
    fromHostId: 11,
    toHostId: 12,
    latencyMs: 8,
    isTimeout: false,
  });
  assert.equal(getTunnelAutoHopDetails({ ...base, generation: "old-topology" }), null);
});

test("automatic tunnel details reject samples from a different probe batch", () => {
  const base = { tunnelId: 94004, hopCount: 1, generation: "batch-v1" };
  recordTunnelAutoHopLatency({
    ...base,
    hopIndex: 0,
    fromHostId: 21,
    toHostId: 22,
    latencyMs: 15,
    isTimeout: false,
  });
  const details = getTunnelAutoHopDetails(base);
  assert.ok(details);
  assert.equal(getTunnelAutoHopDetails({
    ...base,
    referenceAt: details[0].recordedAt + 30_001,
  }), null);
});

test("automatic tunnel details remain isolated by relay and exit path keys", () => {
  const base = { tunnelId: 94006, hopCount: 1, generation: "branches-v1" };
  recordTunnelAutoHopLatency({
    ...base,
    pathKey: "primary",
    hopIndex: 0,
    fromHostId: 10,
    toHostId: 20,
    latencyMs: 12,
    isTimeout: false,
  });
  recordTunnelAutoHopLatency({
    ...base,
    pathKey: "exit-2",
    hopIndex: 0,
    fromHostId: 10,
    toHostId: 30,
    latencyMs: 27,
    isTimeout: false,
  });

  assert.equal(getTunnelAutoHopDetails(base), null);
  assert.deepEqual(
    getTunnelAutoHopDetails({ ...base, pathKey: "primary" })?.map(({ recordedAt: _recordedAt, ...detail }) => detail),
    [{ hopIndex: 0, hopCount: 1, fromHostId: 10, toHostId: 20, latencyMs: 12, isTimeout: false }],
  );
  assert.deepEqual(
    getTunnelAutoHopDetails({ ...base, pathKey: "exit-2" })?.map(({ recordedAt: _recordedAt, ...detail }) => detail),
    [{ hopIndex: 0, hopCount: 1, fromHostId: 10, toHostId: 30, latencyMs: 27, isTimeout: false }],
  );
});

test("a forced test clears every cached path for its tunnel", () => {
  const base = { tunnelId: 94008, hopCount: 1, generation: "clear-v1", hopIndex: 0 };
  for (const pathKey of ["primary", "exit-2"]) {
    recordTunnelAutoHopLatency({
      ...base,
      pathKey,
      fromHostId: 10,
      toHostId: pathKey === "primary" ? 20 : 30,
      latencyMs: 12,
      isTimeout: false,
    });
  }
  clearTunnelAutoHopLatencyState(base.tunnelId);
  assert.equal(getTunnelAutoHopDetails({ ...base, pathKey: "primary" }), null);
  assert.equal(getTunnelAutoHopDetails({ ...base, pathKey: "exit-2" }), null);
});

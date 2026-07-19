import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTunnelBranches, validateTunnelProbeSource } from "./agentReportRoutes";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { getTunnelAutoHopAggregate, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";

test("multi-exit tunnel stays available when at least one exit succeeds", () => {
  const summary = summarizeTunnelBranches([
    { latencyMs: 35, isTimeout: false },
    { latencyMs: null, isTimeout: true },
  ]);
  assert.deepEqual(summary, { unavailable: false, partial: true, latencyMs: 35 });
});

test("multi-exit tunnel is unavailable only when every exit fails", () => {
  const summary = summarizeTunnelBranches([
    { latencyMs: null, isTimeout: true },
    { latencyMs: 0, isTimeout: true },
  ]);
  assert.deepEqual(summary, { unavailable: true, partial: false, latencyMs: null });
});

test("tunnel hop aggregation never mixes topology generations", () => {
  assert.equal(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 10,
    isTimeout: false,
    generation: "old",
  }), null);
  assert.equal(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 1,
    hopCount: 2,
    latencyMs: 20,
    isTimeout: false,
    generation: "new",
  }), null);
  assert.deepEqual(recordTunnelAutoHopLatency({
    tunnelId: 91001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 12,
    isTimeout: false,
    generation: "new",
  }), { success: true, latencyMs: 32 });
});

test("tunnel relay paths aggregate independently and fail immediately", () => {
  const tunnelId = 91002;
  assert.equal(recordTunnelAutoHopLatency({
    tunnelId,
    pathKey: "relay-1",
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 12,
    isTimeout: false,
    generation: "relay-topology",
    allowEarlyFailure: true,
  }), null);
  assert.deepEqual(recordTunnelAutoHopLatency({
    tunnelId,
    pathKey: "relay-1",
    hopIndex: 1,
    hopCount: 2,
    latencyMs: 28,
    isTimeout: false,
    generation: "relay-topology",
    allowEarlyFailure: true,
  }), { success: true, latencyMs: 40 });
  assert.deepEqual(recordTunnelAutoHopLatency({
    tunnelId,
    pathKey: "relay-2",
    hopIndex: 0,
    hopCount: 2,
    latencyMs: null,
    isTimeout: true,
    generation: "relay-topology",
    allowEarlyFailure: true,
  }), { success: false, latencyMs: null });
  assert.deepEqual(getTunnelAutoHopAggregate(tunnelId, 2, "relay-topology", "relay-1", true), { success: true, latencyMs: 40 });
  assert.deepEqual(getTunnelAutoHopAggregate(tunnelId, 2, "relay-topology", "relay-2", true), { success: false, latencyMs: null });
});

test("tunnel relay probe validation accepts every entry and its matching relay path", async () => {
  const tunnel = { id: 91003, isEnabled: true, mode: "forwardx", relayMode: "failover" };
  const hops = [
    { hostId: 10, listenPort: 10010 },
    { hostId: 20, listenPort: 10020 },
    { hostId: 30, listenPort: 10030 },
    { hostId: 40, listenPort: 10040 },
  ];
  const context = { hops, exitNodes: [], entryHostIds: new Set([10, 11]), topologyKey: "relay-probe" };
  assert.equal(await validateTunnelProbeSource(11, tunnel, {
    tunnelId: tunnel.id,
    hopIndex: 0,
    hopCount: 2,
    seriesKey: "relay-2",
    targetPort: 10030,
    topologyKey: "relay-probe",
  }, context), true);
  assert.equal(await validateTunnelProbeSource(20, tunnel, {
    tunnelId: tunnel.id,
    hopIndex: 1,
    hopCount: 2,
    seriesKey: "relay-1",
    targetPort: 10040,
    topologyKey: "relay-probe",
  }, context), true);
  assert.equal(await validateTunnelProbeSource(20, tunnel, {
    tunnelId: tunnel.id,
    hopIndex: 1,
    hopCount: 2,
    seriesKey: "relay-2",
    targetPort: 10040,
    topologyKey: "relay-probe",
  }, context), false);
});

test("forward-chain hop aggregation never mixes topology generations", () => {
  assert.equal(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 8,
    isTimeout: false,
    generation: "old",
  }), null);
  assert.equal(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 1,
    hopCount: 2,
    latencyMs: 16,
    isTimeout: false,
    generation: "new",
  }), null);
  assert.deepEqual(recordForwardGroupAutoHopLatency({
    groupId: 92001,
    hopIndex: 0,
    hopCount: 2,
    latencyMs: 9,
    isTimeout: false,
    generation: "new",
  }), { success: true, latencyMs: 25 });
});

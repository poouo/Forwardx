import assert from "node:assert/strict";
import test from "node:test";
import {
  readyTunnelRelayAggregates,
  shouldAccountForwardRuleTraffic,
  summarizeTunnelBranches,
  trafficAccountingHostIds,
  tunnelProbeTargetHostId,
  validateTunnelProbeSource,
} from "./agentReportRoutes";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { getTunnelAutoHopAggregate, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { shouldUseLatencyCandidate } from "./repositories/metricsRepository";

test("older manual timeout cannot override a newer automatic latency success", () => {
  const automaticSuccess = { recordedAt: new Date("2026-07-19T10:05:00Z") };
  const oldManualTimeout = { recordedAt: new Date("2026-07-19T10:00:00Z") };
  const newManualResult = { recordedAt: new Date("2026-07-19T10:06:00Z") };
  assert.equal(shouldUseLatencyCandidate(automaticSuccess, oldManualTimeout), false);
  assert.equal(shouldUseLatencyCandidate(automaticSuccess, newManualResult), true);
});

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

test("traffic accounting accepts every ForwardX entry-group host", () => {
  const hosts = trafficAccountingHostIds(
    { id: 41, hostId: 5 },
    { id: 7, mode: "forwardx", entryHostId: 5, exitHostId: 9 },
    new Set([5, 6, 7]),
    undefined,
  );
  assert.deepEqual([...hosts].sort((left, right) => left - right), [5, 6, 7]);
  assert.equal(hosts.has(9), false);
});

test("traffic accounting accepts enabled load-balanced exit hosts", () => {
  const hosts = trafficAccountingHostIds(
    { id: 42, hostId: 5 },
    {
      id: 8,
      mode: "gost",
      entryHostId: 5,
      exitHostId: 9,
      loadBalanceEnabled: true,
      loadBalanceStrategy: "round_robin",
    },
    undefined,
    new Set([10, 11]),
  );
  assert.deepEqual([...hosts].sort((left, right) => left - right), [9, 10, 11]);
});

test("traffic accounting ignores extra exits when load balancing is disabled", () => {
  const hosts = trafficAccountingHostIds(
    { id: 43, hostId: 5 },
    {
      id: 9,
      mode: "realm",
      entryHostId: 5,
      exitHostId: 9,
      loadBalanceEnabled: false,
      loadBalanceStrategy: "round_robin",
    },
    undefined,
    new Set([10, 11]),
  );
  assert.deepEqual([...hosts], [9]);
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

test("tunnel relay summary waits for pending candidates after an early failure", () => {
  const failed = { success: false, latencyMs: null };
  const succeeded = { success: true, latencyMs: 25 };
  assert.deepEqual(readyTunnelRelayAggregates([
    { key: "relay-1", label: "relay 1", aggregate: failed },
    { key: "relay-2", label: "relay 2", aggregate: null },
  ]), []);
  assert.deepEqual(readyTunnelRelayAggregates([
    { key: "relay-1", label: "relay 1", aggregate: failed },
    { key: "relay-2", label: "relay 2", aggregate: succeeded },
  ]).map((item) => item.key), ["relay-1", "relay-2"]);
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

test("standard multi-hop probe validation accepts every configured entry for the first hop", async () => {
  const tunnel = { id: 91004, isEnabled: true, mode: "forwardx" };
  const hops = [
    { hostId: 10, listenPort: 10010 },
    { hostId: 20, listenPort: 10020 },
    { hostId: 30, listenPort: 10030 },
  ];
  const context = { hops, exitNodes: [], entryHostIds: new Set([10, 11]), topologyKey: "multi-entry-hop" };
  assert.equal(await validateTunnelProbeSource(11, tunnel, {
    tunnelId: tunnel.id,
    hopIndex: 0,
    hopCount: 2,
    targetPort: 10020,
    topologyKey: "multi-entry-hop",
  }, context), true);
  assert.equal(await validateTunnelProbeSource(12, tunnel, {
    tunnelId: tunnel.id,
    hopIndex: 0,
    hopCount: 2,
    targetPort: 10020,
    topologyKey: "multi-entry-hop",
  }, context), false);
});

test("direct multi-exit probes map each series to its actual exit host", () => {
  const tunnel = {
    entryHostId: 10,
    exitHostId: 20,
    loadBalanceEnabled: true,
    loadBalanceStrategy: "round_robin",
  };
  const exitNodes = [
    { seq: 0, hostId: 99, listenPort: 20099, isEnabled: false },
    { seq: 2, hostId: 31, listenPort: 20031, isEnabled: true },
    { seq: 1, hostId: 30, listenPort: 20030, isEnabled: true },
  ];
  const report = { tunnelId: 1 };
  assert.equal(tunnelProbeTargetHostId(tunnel, [], exitNodes, report, "primary"), 20);
  assert.equal(tunnelProbeTargetHostId(tunnel, [], exitNodes, report, "exit-2"), 30);
  assert.equal(tunnelProbeTargetHostId(tunnel, [], exitNodes, report, "exit-3"), 31);
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

test("forward-chain traffic counts only the first internal listener", () => {
  const group = {
    groupMode: "chain",
    members: [
      { id: 101, hostId: 1, priority: 0, isEnabled: true },
      { id: 102, hostId: 2, priority: 1, isEnabled: true },
    ],
  };
  const common = {
    forwardGroupId: 10,
    forwardGroupRuleId: 20,
    forwardGroupMemberId: 101,
  };

  assert.equal(shouldAccountForwardRuleTraffic({ ...common, hostId: 1 }, group), true);
  assert.equal(
    shouldAccountForwardRuleTraffic({ ...common, hostId: 9 }, group),
    false,
    "an external entry listener shares the first member id but must not be counted again",
  );
  assert.equal(
    shouldAccountForwardRuleTraffic({ ...common, hostId: 2, forwardGroupMemberId: 102 }, group),
    false,
  );
});

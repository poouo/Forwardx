import assert from "node:assert/strict";
import test from "node:test";
import { AgentTcpingReportGate } from "./agentTcpingReportGate";

function input(overrides: Record<string, unknown> = {}) {
  return {
    hostId: 7,
    results: [],
    tunnels: [],
    forwardGroups: [],
    services: [],
    ...overrides,
  } as any;
}

function tunnelHop(hopIndex: number, isTimeout = false) {
  return {
    tunnelId: 11,
    topologyKey: "topology-a",
    probeKey: `tunnel-11-hop-${hopIndex}`,
    hopIndex,
    hopCount: 2,
    latencyMs: isTimeout ? 0 : 10 + hopIndex,
    isTimeout,
  };
}

test("TCPing gate reports complete topologies on failure and recovery transitions", () => {
  const gate = new AgentTcpingReportGate();
  const now = Date.parse("2026-07-24T10:00:00Z");
  const healthy = [tunnelHop(0), tunnelHop(1)];
  const first = gate.plan(input({ tunnels: healthy }), now);
  assert.equal(first.tunnels.length, 2);
  first.commit();

  assert.equal(gate.plan(input({ tunnels: healthy }), now + 60_000).tunnels.length, 0);

  const failure = gate.plan(input({ tunnels: [tunnelHop(0), tunnelHop(1, true)] }), now + 61_000);
  assert.equal(failure.tunnels.length, 2);
  failure.commit();

  const recovery = gate.plan(input({ tunnels: healthy }), now + 62_000);
  assert.equal(recovery.tunnels.length, 2);
});

test("TCPing gate retries uncommitted work and emits five minute snapshots", () => {
  const gate = new AgentTcpingReportGate();
  const now = Date.parse("2026-07-24T10:00:00Z");
  const report = { ruleId: 21, latencyMs: 12, isTimeout: false, probeKey: "rule-21" };

  assert.equal(gate.plan(input({ results: [report] }), now).results.length, 1);
  const retry = gate.plan(input({ results: [report] }), now + 1_000);
  assert.equal(retry.results.length, 1);
  retry.commit();

  assert.equal(gate.plan(input({ results: [report] }), now + 4 * 60_000).results.length, 0);
  const snapshot = gate.plan(input({ results: [{ ...report, latencyMs: 99 }] }), now + 5 * 60_000 + 1_000);
  assert.equal(snapshot.results.length, 1, "latency-only changes remain quiet until the snapshot");
  assert.deepEqual([...snapshot.transitionRuleIds], [], "a stable snapshot must not retrigger failover");
});

test("TCPing gate marks rule failure and recovery as failover transitions", () => {
  const gate = new AgentTcpingReportGate();
  const now = Date.parse("2026-07-24T10:00:00Z");
  const healthy = { ruleId: 31, latencyMs: 8, isTimeout: false };
  const first = gate.plan(input({ results: [healthy] }), now);
  assert.deepEqual([...first.transitionRuleIds], [31]);
  first.commit();

  const failure = gate.plan(input({ results: [{ ...healthy, latencyMs: null, isTimeout: true }] }), now + 1_000);
  assert.deepEqual([...failure.transitionRuleIds], [31]);
  failure.commit();

  const recovery = gate.plan(input({ results: [healthy] }), now + 2_000);
  assert.deepEqual([...recovery.transitionRuleIds], [31]);
});

test("TCPing gate always preserves configured service history and forced reports", () => {
  const gate = new AgentTcpingReportGate();
  const now = Date.parse("2026-07-24T10:00:00Z");
  const reports = {
    results: [{ ruleId: 41, latencyMs: 4, isTimeout: false }],
    services: [{ serviceId: 51, latencyMs: 5, isTimeout: false }],
  };
  const first = gate.plan(input(reports), now);
  first.commit();

  const stable = gate.plan(input(reports), now + 1_000);
  assert.equal(stable.results.length, 0);
  assert.equal(stable.services.length, 1);

  const forced = gate.plan(input({ ...reports, force: true }), now + 2_000);
  assert.equal(forced.results.length, 1);
  assert.deepEqual([...forced.transitionRuleIds], [41]);
});

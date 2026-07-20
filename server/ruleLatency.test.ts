import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTunnelRuleLatencyProbe,
  combineTunnelRuleLatencySample,
  tunnelRuleLatencyTopologyKey,
  validateTunnelRuleLatencyReport,
} from "./ruleLatency";

const rule = {
  id: 71,
  tunnelId: 8,
  targetIp: "game.example.com",
  targetPort: 443,
  protocol: "tcp",
  isEnabled: true,
  pendingDelete: false,
};
const tunnel = { id: 8, exitHostId: 22, isEnabled: true };

test("tunnel rule latency probes are created only for the canonical exit host", () => {
  assert.equal(buildTunnelRuleLatencyProbe({ hostId: 11, rule, tunnel }), null);
  assert.deepEqual(buildTunnelRuleLatencyProbe({ hostId: 22, rule, tunnel }), {
    ruleId: 71,
    tunnelId: 8,
    targetIp: "game.example.com",
    targetPort: 443,
    method: "tcping",
    probeKey: tunnelRuleLatencyTopologyKey(rule, tunnel),
    topologyKey: tunnelRuleLatencyTopologyKey(rule, tunnel),
  });
});

test("tunnel rule latency reports reject entry hosts and stale topology", () => {
  const topologyKey = tunnelRuleLatencyTopologyKey(rule, tunnel);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 11,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey },
  }), false);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 22,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey: `${topologyKey}:old` },
  }), false);
  assert.equal(validateTunnelRuleLatencyReport({
    hostId: 22,
    rule,
    tunnel,
    report: { targetPort: 443, method: "tcping", topologyKey },
  }), true);
});

test("tunnel rule latency is the fresh tunnel path plus exit-to-target latency", () => {
  const nowMs = Date.parse("2026-07-20T10:00:00Z");
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: 6,
    tunnelIsTimeout: false,
    tunnelRecordedAt: new Date(nowMs - 1000),
    nowMs,
  }), { latencyMs: 137, isTimeout: false });
  assert.equal(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: 6,
    tunnelIsTimeout: false,
    tunnelRecordedAt: new Date(nowMs - 6 * 60 * 1000),
    nowMs,
  }), null);
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: 131,
    targetIsTimeout: false,
    tunnelLatencyMs: null,
    tunnelIsTimeout: true,
    tunnelRecordedAt: new Date(nowMs - 1000),
    nowMs,
  }), { latencyMs: null, isTimeout: true });
  assert.deepEqual(combineTunnelRuleLatencySample({
    targetLatencyMs: null,
    targetIsTimeout: true,
    nowMs,
  }), { latencyMs: null, isTimeout: true });
});

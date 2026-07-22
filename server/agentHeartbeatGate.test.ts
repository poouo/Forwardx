import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentReportedAddress } from "./agentAddressState";
import { AgentHeartbeatGate, buildBusyAgentHeartbeatResponse } from "./agentHeartbeatGate";

test("coalesces overlapping and recent heartbeats for one host without blocking", () => {
  let now = 10_000;
  const gate = new AgentHeartbeatGate(1000, () => now);
  const release = gate.tryAcquire(1);
  assert.ok(release);
  assert.equal(gate.tryAcquire(1), null);

  const otherHostRelease = gate.tryAcquire(2);
  assert.ok(otherHostRelease, "different hosts must reconcile in parallel");
  otherHostRelease();

  release();
  assert.equal(gate.tryAcquire(1), null, "recent duplicate should be coalesced");
  const forcedRelease = gate.tryAcquire(1, { force: true });
  assert.ok(forcedRelease, "SSE configuration refresh must bypass the recent window");
  forcedRelease();

  now += 1001;
  const nextRelease = gate.tryAcquire(1);
  assert.ok(nextRelease);
  nextRelease();
});

test("limits concurrent full heartbeats across different hosts", () => {
  const gate = new AgentHeartbeatGate(1000, () => 10_000, 2);
  const first = gate.tryAcquire(1);
  const second = gate.tryAcquire(2);
  assert.ok(first);
  assert.ok(second);
  assert.equal(gate.tryAcquire(3), null, "excess reconciliation must be rejected without entering the database queue");
  assert.equal(gate.tryAcquire(3, { force: true }), null, "forced refresh must still respect global backpressure");

  first();
  const third = gate.tryAcquire(3);
  assert.ok(third, "capacity must be available immediately after a reconciliation completes");
  third();
  second();
});

test("busy heartbeat responses preserve cached state sections on the Agent", () => {
  const response = buildBusyAgentHeartbeatResponse({
    panelUrl: "https://panel.example.test",
    requestLocalState: false,
  });
  const stateSections = [
    "runningRules",
    "ruleLatencyProbes",
    "tunnelProbes",
    "forwardGroupProbes",
    "hostProbeServices",
    "guardRules",
    "dnsWatch",
    "stateSignatures",
  ];
  for (const section of stateSections) {
    assert.equal(section in response, false, `${section} must be omitted from a coalesced heartbeat`);
  }
  assert.equal(response.nextInterval, 5);
  assert.equal(response.panelUrl, "https://panel.example.test");
});

test("empty address reports during Agent restart preserve the last valid addresses", () => {
  const existing = {
    ip: "198.51.100.8",
    ipv4: "198.51.100.8",
    ipv6: "2001:db8::8",
  };
  assert.deepEqual(mergeAgentReportedAddress({ ip: "unknown", ipv4: "", ipv6: "" }, existing), existing);
  assert.deepEqual(mergeAgentReportedAddress({ ipv6: "2001:db8::9" }, existing), {
    ...existing,
    ipv6: "2001:db8::9",
  });
});

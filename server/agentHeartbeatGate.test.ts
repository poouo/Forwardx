import assert from "node:assert/strict";
import test from "node:test";
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

test("busy heartbeat responses preserve cached state sections on the Agent", () => {
  const response = buildBusyAgentHeartbeatResponse({
    panelUrl: "https://panel.example.test",
    requestLocalState: false,
  });
  const stateSections = [
    "runningRules",
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

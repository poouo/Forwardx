import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentReportedAddress } from "./agentAddressState";
import { stableDesiredStateHash } from "./agentHeartbeatRoute";
import { hasAgentVersionChanged } from "./agentRouteUtils";
import { HOST_ONLINE_TTL_MS } from "./repositories/hostRepository";
import {
  clearAuthenticatedAgentActivity,
  hasRecentAuthenticatedAgentActivity,
  partitionHostsByRecentAgentActivity,
  recordAuthenticatedAgentActivity,
} from "./agentActivity";
import { isHostMetricsWatching, markHostMetricsWatching } from "./agentEvents";
import {
  AgentHeartbeatGate,
  AgentStableHeartbeatPlanCache,
  AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_PRESENCE_INTERVAL_SECONDS,
  buildBusyAgentHeartbeatResponse,
  buildPresenceAgentHeartbeatResponse,
  buildReportedRuntimeHeartbeatPatch,
  selectAgentHeartbeatInterval,
  selectAgentTrafficReportInterval,
  shouldPersistAgentPresence,
  shouldDeferAgentWorkForLocalState,
} from "./agentHeartbeatGate";

test("traffic reports use the steady window unless live metrics or strict accounting require it", () => {
  assert.equal(selectAgentTrafficReportInterval({ metricsWatching: false, strictAccounting: false }), 30);
  assert.equal(selectAgentTrafficReportInterval({ metricsWatching: true, strictAccounting: false }), 10);
  assert.equal(selectAgentTrafficReportInterval({ metricsWatching: false, strictAccounting: true }), 10);
});

test("traffic reports return to the steady window when a metrics watcher expires", () => {
  const hostId = 98_765;
  markHostMetricsWatching([hostId], 6_000, 10_000);
  assert.equal(selectAgentTrafficReportInterval({
    metricsWatching: isHostMetricsWatching(hostId, 15_999),
    strictAccounting: false,
  }), 10);
  assert.equal(selectAgentTrafficReportInterval({
    metricsWatching: isHostMetricsWatching(hostId, 16_000),
    strictAccounting: false,
  }), 30);
});

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
  assert.equal(gate.tryAcquire(3), null, "excess reconciliation must wait outside the database queue");
  assert.equal(gate.tryAcquire(3, { force: true }), null, "forced refresh must still respect global backpressure");

  first();
  const third = gate.tryAcquire(3);
  assert.ok(third, "capacity must be available immediately after a reconciliation completes");
  third();
  second();
});

test("serves saturated heartbeat reconciliation in FIFO order", () => {
  const gate = new AgentHeartbeatGate(1000, () => 10_000, 2);
  const first = gate.tryAcquire(1);
  const second = gate.tryAcquire(2);
  assert.ok(first);
  assert.ok(second);

  for (const hostId of [3, 4, 5, 6]) {
    assert.equal(gate.tryAcquire(hostId), null);
  }
  first();
  assert.equal(gate.tryAcquire(6, { force: true }), null, "forced work must not bypass older recovery work");

  const releases: Array<() => void> = [];
  for (const hostId of [3, 4, 5, 6]) {
    const release = gate.tryAcquire(hostId);
    assert.ok(release, `host ${hostId} should receive the next available slot`);
    releases.push(release);
    release();
  }
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
  assert.equal(response.metricsOnly, false);
});

test("presence responses keep the liveness cadence inside the ten-second failure window", () => {
  const response = buildPresenceAgentHeartbeatResponse({});
  assert.equal(AGENT_PRESENCE_INTERVAL_SECONDS, 5);
  assert.equal(response.nextPresenceInterval, AGENT_PRESENCE_INTERVAL_SECONDS);
  assert.ok(response.nextPresenceInterval * 2 <= 10);
});

test("stable heartbeat plans require a completed plan and exact Agent acknowledgements", () => {
  let now = 1_000;
  const cache = new AgentStableHeartbeatPlanCache(10_000, () => now);
  const input = {
    localStateSignature: "local-a",
    stateSignatures: { runningRules: "state-a", dnsWatch: "state-b" },
    agentVersion: "2.3.0",
    agentBootId: "boot-a",
    agentProcessStartedAt: 900,
    defaultNetworkInterface: "eth0",
    pluginInventorySignature: "plugins-a",
    mimicEnvironmentSignature: "mimic-a",
    agentLastReceivedRevision: 12,
    agentLastAppliedRevision: 12,
    agentLastReceivedHash: "plan-a",
    agentLastAppliedHash: "plan-a",
  };

  assert.equal(cache.match(7, input), null, "a panel restart must perform its first full plan");
  assert.equal(cache.remember(7, {
    plannedAt: now,
    configRevision: 12,
    desiredStateHash: "plan-a",
    localStateSignature: "local-a",
    stateSignatures: { runningRules: "state-a", dnsWatch: "state-b" },
    agentVersion: "2.3.0",
    agentBootId: "boot-a",
    agentProcessStartedAt: 900,
    defaultNetworkInterface: "eth0",
    pluginInventorySignature: "plugins-a",
    mimicEnvironmentSignature: "mimic-a",
    idleNextInterval: 60,
    panelUrl: "https://panel.example.test",
  }), true);
  assert.ok(cache.match(7, input));
  assert.equal(cache.match(7, { ...input, agentLastAppliedHash: "action-a" }), null);
  assert.equal(cache.match(7, { ...input, localStateSignature: "local-b" }), null);
  assert.equal(cache.match(7, { ...input, stateSignatures: { ...input.stateSignatures, dnsWatch: "state-c" } }), null);
});

test("desired-state aggregate hash ignores delivery timestamps and per-action transport hashes", () => {
  const action = { ruleId: 7, op: "apply", configRevision: 12, issuedAt: 100, configHash: "delivery-a" };
  assert.equal(
    stableDesiredStateHash([action]),
    stableDesiredStateHash([{ ...action, issuedAt: 200, configHash: "delivery-b" }]),
  );
  assert.notEqual(stableDesiredStateHash([action]), stableDesiredStateHash([{ ...action, ruleId: 8 }]));
});

test("an Agent version change requires a fresh desired-state reconciliation", () => {
  assert.equal(hasAgentVersionChanged("2.2.154", "2.2.155"), true);
  assert.equal(hasAgentVersionChanged("v2.2.155", "2.2.155"), false);
  assert.equal(hasAgentVersionChanged(null, "2.2.155"), true);
  assert.equal(hasAgentVersionChanged("2.2.155", ""), false);
});

test("stable heartbeat plans yield to work and periodic full audits", () => {
  let now = 1_000;
  const cache = new AgentStableHeartbeatPlanCache(10_000, () => now);
  cache.remember(8, {
    plannedAt: now,
    configRevision: 4,
    desiredStateHash: "hash-a",
    localStateSignature: "local-a",
    stateSignatures: { runningRules: "state-a" },
    agentVersion: "2.3.0",
    agentBootId: "boot-a",
    agentProcessStartedAt: 900,
    defaultNetworkInterface: "eth0",
    pluginInventorySignature: "plugins-a",
    mimicEnvironmentSignature: "mimic-a",
    idleNextInterval: 60,
    panelUrl: "https://panel.example.test",
  });
  const input = {
    localStateSignature: "local-a",
    stateSignatures: { runningRules: "state-a" },
    agentVersion: "2.3.0",
    agentBootId: "boot-a",
    agentProcessStartedAt: 900,
    defaultNetworkInterface: "eth0",
    pluginInventorySignature: "plugins-a",
    mimicEnvironmentSignature: "mimic-a",
    agentLastReceivedRevision: 4,
    agentLastAppliedRevision: 4,
    agentLastReceivedHash: "hash-a",
    agentLastAppliedHash: "hash-a",
  };

  for (const blocker of [
    { forceReconcile: true },
    { hasBlockingWork: true },
    { recoveryTriggered: true },
    { addressChanged: true },
    { hasDnsChanges: true },
    { hasLocalStateUpload: true },
    { hasEndpointEvents: true },
  ]) {
    assert.equal(cache.match(8, { ...input, ...blocker }), null);
  }
  now += 10_000;
  assert.equal(cache.match(8, input), null, "periodic audit must rebuild even when SSE invalidation was missed");
});

test("metrics watcher busy heartbeats explicitly select the metrics-only mode", () => {
  const response = buildBusyAgentHeartbeatResponse({
    panelUrl: "https://panel.example.test",
    requestLocalState: false,
    metricsWatching: true,
  });
  assert.equal(response.metricsOnly, true);
  assert.equal(response.nextInterval, 3);
});

test("metrics-only heartbeats do not erase the last reported mimic runtime state", () => {
  assert.deepEqual(buildReportedRuntimeHeartbeatPatch({
    hasLocalRuntimeState: false,
    mimicRuntimeStatus: "not-configured",
    mimicRuntimeMessage: null,
  }), {});
  const checkedAt = new Date("2026-07-24T00:00:00.000Z");
  assert.deepEqual(buildReportedRuntimeHeartbeatPatch({
    hasLocalRuntimeState: true,
    mimicRuntimeStatus: "established",
    mimicRuntimeMessage: "mimic@eth0:active",
    checkedAt,
  }), {
    mimicRuntimeStatus: "established",
    mimicRuntimeMessage: "mimic@eth0:active",
    mimicRuntimeCheckedAt: checkedAt,
  });
});

test("self-tests wait until a desired-state Agent uploads its requested local state", () => {
  assert.equal(shouldDeferAgentWorkForLocalState({ supportsDesiredState: true, requestLocalState: true }), true);
  assert.equal(shouldDeferAgentWorkForLocalState({ supportsDesiredState: true, requestLocalState: false }), false);
  assert.equal(shouldDeferAgentWorkForLocalState({ supportsDesiredState: false, requestLocalState: true }), false);
});

test("heartbeat intervals slow down only when the Agent has no interactive work", () => {
  const idle = {
    requestLocalState: false,
    hasInteractiveTasks: false,
    metricsWatching: false,
    serviceProbeIntervals: [],
  };
  assert.equal(selectAgentHeartbeatInterval(idle), AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, metricsWatching: true }), 3);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, hasInteractiveTasks: true }), 2);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, requestLocalState: true }), 2);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, serviceProbeIntervals: [20, 120] }), 20);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, serviceProbeIntervals: [1] }), 5);
  assert.equal(selectAgentHeartbeatInterval({ ...idle, serviceProbeIntervals: [0] }), 30);
  assert.ok(HOST_ONLINE_TTL_MS > AGENT_IDLE_HEARTBEAT_INTERVAL_SECONDS * 2 * 1000);
});

test("presence persists liveness only when the database heartbeat is old", () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  assert.equal(shouldPersistAgentPresence({ wasOnline: false, lastHeartbeat: new Date(now - 1_000), nowMs: now }), true);
  assert.equal(shouldPersistAgentPresence({ wasOnline: true, lastHeartbeat: new Date(now - 60_000), nowMs: now }), false);
  assert.equal(shouldPersistAgentPresence({ wasOnline: true, lastHeartbeat: new Date(now - 90_000), nowMs: now }), true);
});

test("authenticated Agent reports protect a host from a stale heartbeat sweep", () => {
  clearAuthenticatedAgentActivity();
  recordAuthenticatedAgentActivity(7, 1_000);

  assert.equal(hasRecentAuthenticatedAgentActivity(7, 1_500, 1_000), true);
  assert.deepEqual(
    partitionHostsByRecentAgentActivity([{ id: 7 }, { id: 8 }], 1_500, 1_000),
    { active: [{ id: 7 }], stale: [{ id: 8 }] },
  );
  assert.equal(hasRecentAuthenticatedAgentActivity(7, 2_001, 1_000), false);
  clearAuthenticatedAgentActivity();
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

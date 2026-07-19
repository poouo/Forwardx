import assert from "node:assert/strict";
import test from "node:test";
import {
  planGostTunnelProbeListeners,
  shouldReconcileGostRuntime,
  shouldReconcileNginxRuntime,
  tunnelExitRuntimeForwardType,
  tunnelHopRuntimeForwardType,
  tunnelRuleRuntimeForwardType,
  tunnelRuntimeFamily,
} from "./tunnelRuntimePlan";

test("keeps an idle GOST tunnel listening for latency probes", () => {
  const listeners = planGostTunnelProbeListeners(7, [{
    id: 11,
    mode: "tls",
    isEnabled: true,
    protocolEnabled: true,
    exitHostId: 7,
    listenPort: 21045,
    loadBalanceEnabled: false,
  }], new Map(), new Set());
  assert.deepEqual(listeners, [{
    tunnelId: 11,
    mode: "tls",
    listenPort: 21045,
    name: "fwx-tunnel-probe-11",
  }]);
});

test("lets business listeners replace probes and keeps idle extra exits probeable", () => {
  const listeners = planGostTunnelProbeListeners(7, [{
    id: 12,
    mode: "wss",
    isEnabled: true,
    protocolEnabled: true,
    exitHostId: 7,
    listenPort: 22001,
    loadBalanceEnabled: true,
  }], new Map([[12, [
    { id: 31, hostId: 7, listenPort: 22002, isEnabled: true },
    { id: 32, hostId: 8, listenPort: 22003, isEnabled: true },
  ]]]), new Set(["7:22001"]));
  assert.deepEqual(listeners, [{
    tunnelId: 12,
    mode: "wss",
    listenPort: 22002,
    name: "fwx-tunnel-probe-12-exit-31",
  }]);
});

test("does not listen on extra exits when the exit group strategy is disabled", () => {
  const listeners = planGostTunnelProbeListeners(7, [{
    id: 13,
    mode: "tls",
    isEnabled: true,
    protocolEnabled: true,
    exitHostId: 8,
    listenPort: 22011,
    loadBalanceEnabled: true,
    loadBalanceStrategy: "none",
  }], new Map([[13, [
    { id: 33, hostId: 7, listenPort: 22012, isEnabled: true },
  ]]]), new Set());
  assert.deepEqual(listeners, []);
});

test("does not plan probes for disabled protocols or non-GOST tunnels", () => {
  const listeners = planGostTunnelProbeListeners(7, [
    { id: 1, mode: "tls", isEnabled: false, exitHostId: 7, listenPort: 23001 },
    { id: 2, mode: "tls", isEnabled: true, protocolEnabled: false, exitHostId: 7, listenPort: 23002 },
    { id: 3, mode: "forwardx", isEnabled: true, protocolEnabled: true, exitHostId: 7, listenPort: 23003 },
    { id: 4, mode: "nginx_stream", isEnabled: true, protocolEnabled: true, exitHostId: 7, listenPort: 23004 },
    { id: 5, mode: "unsupported", isEnabled: true, protocolEnabled: true, exitHostId: 7, listenPort: 23005 },
  ], new Map(), new Set());
  assert.deepEqual(listeners, []);
});

test("keeps nginx tunnels out of the GOST runtime family", () => {
  const tunnel = { mode: "nginx_stream" };
  assert.equal(tunnelRuntimeFamily(tunnel), "nginx");
  assert.equal(tunnelExitRuntimeForwardType(tunnel), "nginx-tunnel-exit");
  assert.equal(tunnelHopRuntimeForwardType(tunnel), null);
  assert.equal(tunnelRuleRuntimeForwardType(tunnel), "nginx-tunnel");
});

test("keeps ForwardX and GOST tunnel action types unchanged", () => {
  assert.equal(tunnelExitRuntimeForwardType({ mode: "forwardx" }), "forwardx-tunnel");
  assert.equal(tunnelHopRuntimeForwardType({ mode: "forwardx" }), "forwardx-tunnel");
  assert.equal(tunnelRuleRuntimeForwardType({ mode: "forwardx" }), "forwardx");
  for (const mode of ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]) {
    assert.equal(tunnelExitRuntimeForwardType({ mode }), "gost-tunnel");
    assert.equal(tunnelHopRuntimeForwardType({ mode }), "gost-tunnel");
    assert.equal(tunnelRuleRuntimeForwardType({ mode }), "gost");
  }
});

test("rejects unknown tunnel modes instead of treating them as GOST", () => {
  const tunnel = { mode: "unsupported" };
  assert.equal(tunnelRuntimeFamily(tunnel), null);
  assert.equal(tunnelExitRuntimeForwardType(tunnel), null);
  assert.equal(tunnelHopRuntimeForwardType(tunnel), null);
  assert.equal(tunnelRuleRuntimeForwardType(tunnel), null);
});

test("reconciles a stale nginx runtime even when desired marker files are gone", () => {
  assert.equal(shouldReconcileNginxRuntime({
    configChanged: false,
    serviceUnhealthy: false,
    bootstrap: false,
    desiredRelevant: false,
    reportedHasWork: true,
  }), true);
  assert.equal(shouldReconcileNginxRuntime({
    configChanged: false,
    serviceUnhealthy: false,
    bootstrap: false,
    desiredRelevant: false,
    reportedHasWork: false,
  }), false);
});

test("periodically reconciles desired and stale GOST shared runtimes", () => {
  assert.equal(shouldReconcileGostRuntime({
    configChanged: false,
    serviceUnhealthy: false,
    bootstrap: false,
    desiredRelevant: true,
    reportedHasWork: false,
  }), true);
  assert.equal(shouldReconcileGostRuntime({
    configChanged: false,
    serviceUnhealthy: false,
    bootstrap: false,
    desiredRelevant: false,
    reportedHasWork: true,
  }), true);
  assert.equal(shouldReconcileGostRuntime({
    configChanged: false,
    serviceUnhealthy: false,
    bootstrap: false,
    desiredRelevant: false,
    reportedHasWork: false,
  }), false);
});

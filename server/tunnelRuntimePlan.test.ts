import assert from "node:assert/strict";
import test from "node:test";
import {
  planGostTunnelProbeListeners,
  planManualTunnelTestRefresh,
  shouldReconcileGostRuntime,
  shouldReconcileNginxRuntime,
  tunnelExitRuntimeForwardType,
  tunnelHopRuntimeForwardType,
  tunnelRuleRuntimeForwardType,
  tunnelRuntimeFamily,
} from "./tunnelRuntimePlan";
import {
  selectEntryGroupTunnelTestAddress,
  selectTunnelDialAddress,
} from "./tunnelAddressSelection";

test("keeps a configured IPv6 endpoint after runtime restart", () => {
  const exit = {
    entryIp: "209.33.172.59",
    ipv4: "209.33.172.59",
    ipv6: "2001:db8:43::1",
  };
  assert.equal(
    selectTunnelDialAddress({ connectHost: "2001:db8:43::1" }, exit),
    "2001:db8:43::1",
  );
});

test("entry-group direct tunnel test uses configured IPv6 instead of exit IPv4", () => {
  const exit = {
    entryIp: "209.33.172.59",
    ipv4: "209.33.172.59",
    ipv6: "2001:db8:43::1",
  };
  assert.equal(
    selectEntryGroupTunnelTestAddress({ connectHost: "2001:db8:43::1" }, null, exit),
    "2001:db8:43::1",
  );
});

test("entry-group multi-hop tunnel test uses the next hop configured address", () => {
  const nextHost = { entryIp: "203.0.113.20", ipv6: "2001:db8:20::1" };
  assert.equal(
    selectEntryGroupTunnelTestAddress(
      { connectHost: "2001:db8:43::1" },
      { connectHost: "2001:db8:20::1" },
      nextHost,
    ),
    "2001:db8:20::1",
  );
});

test("entry-group WireGuard test keeps the next hop private address", () => {
  const nextHost = {
    entryIp: "103.177.163.138",
    ipv4: "103.177.163.138",
    tunnelEntryIp: "10.23.0.8",
  };
  assert.equal(
    selectEntryGroupTunnelTestAddress(
      { connectHost: "10.99.0.9" },
      { connectHost: "10.23.0.8" },
      nextHost,
    ),
    "10.23.0.8",
  );
});

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

test("manual tests do not restart an already running multi-exit tunnel", () => {
  assert.equal(planManualTunnelTestRefresh({
    isRunning: true,
    loadBalanceEnabled: true,
    extraExitCount: 2,
  }), "none");
  assert.equal(planManualTunnelTestRefresh({
    isRunning: true,
    hopHostCount: 4,
  }), "none");
});

test("manual tests coordinate refresh only while tunnel runtime is stopped", () => {
  assert.equal(planManualTunnelTestRefresh({
    isRunning: false,
    loadBalanceEnabled: true,
    extraExitCount: 2,
  }), "coordinated");
  assert.equal(planManualTunnelTestRefresh({
    isRunning: false,
    hopHostCount: 4,
  }), "coordinated");
  assert.equal(planManualTunnelTestRefresh({ isRunning: false }), "endpoint");
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

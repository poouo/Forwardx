import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldReconcileGostRuntime,
  shouldReconcileNginxRuntime,
  tunnelExitRuntimeForwardType,
  tunnelHopRuntimeForwardType,
  tunnelRuleRuntimeForwardType,
  tunnelRuntimeFamily,
} from "./tunnelRuntimePlan";

test("keeps nginx tunnels out of the GOST runtime family", () => {
  for (const mode of ["nginx_stream", "nginx_tls"]) {
    const tunnel = { mode };
    assert.equal(tunnelRuntimeFamily(tunnel), "nginx");
    assert.equal(tunnelExitRuntimeForwardType(tunnel), "nginx-tunnel-exit");
    assert.equal(tunnelHopRuntimeForwardType(tunnel), null);
    assert.equal(tunnelRuleRuntimeForwardType(tunnel), "nginx-tunnel");
  }
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

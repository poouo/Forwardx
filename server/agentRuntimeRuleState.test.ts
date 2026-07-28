import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalForwardXTransportVersion, resolveRuleTrafficPortForHost } from "./agentRuntimeRuleState";

test("shared tunnel runtime keeps the public source port on entry hosts", () => {
  assert.equal(resolveRuleTrafficPortForHost({
    sourcePort: 53874,
    usesTunnelRuntime: true,
    isEntry: true,
    exitPorts: [],
  }), 53874);
});

test("shared tunnel runtime uses the internal listener on exit-only hosts", () => {
  assert.equal(resolveRuleTrafficPortForHost({
    sourcePort: 53874,
    usesTunnelRuntime: true,
    isEntry: false,
    exitPorts: [61560],
  }), 61560);
});

test("direct rules always keep their source port", () => {
  assert.equal(resolveRuleTrafficPortForHost({
    sourcePort: 55503,
    usesTunnelRuntime: false,
    isEntry: false,
    exitPorts: [60000],
  }), 55503);
});

test("local ForwardX transport version survives a deleted tunnel record", () => {
  assert.equal(resolveLocalForwardXTransportVersion({
    reportedTransportVersion: "v2",
    tunnel: undefined,
  }), "v2");
});

test("missing local ForwardX transport version stays unknown after tunnel deletion", () => {
  assert.equal(resolveLocalForwardXTransportVersion({
    reportedTransportVersion: undefined,
    tunnel: undefined,
  }), undefined);
});

test("legacy local state falls back to the retained tunnel version", () => {
  assert.equal(resolveLocalForwardXTransportVersion({
    tunnel: { mode: "forwardx", forwardxVersion: "v2" },
  }), "v2");
  assert.equal(resolveLocalForwardXTransportVersion({
    tunnel: { mode: "forwardx", forwardxVersion: "v1" },
  }), "v1");
});

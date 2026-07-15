import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuleTrafficPortForHost } from "./agentRuntimeRuleState";

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

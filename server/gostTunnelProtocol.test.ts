import assert from "node:assert/strict";
import test from "node:test";
import { planGostTunnelRuleProtocol } from "./gostTunnelProtocol";

test("uses an authenticated relay for TCP and UDP over one GOST tunnel", () => {
  const plan = planGostTunnelRuleProtocol({
    protocol: "both",
    tunnelId: 7,
    ruleId: 19,
    secretSeed: "tunnel-secret",
  });

  assert.equal(plan.entryNeedsTarget, true);
  assert.equal(plan.exitTargetDialType, null);
  assert.equal(plan.chainConnector.type, "relay");
  assert.equal(plan.exitHandler.type, "relay");
  assert.deepEqual(plan.chainConnector.auth, plan.exitHandler.auth);
  assert.equal(plan.chainConnector.auth?.username, "fwx-7-19");
  assert.equal(plan.chainConnector.auth?.password.length, 64);
  assert.deepEqual(plan.chainConnector.metadata, { nodelay: true });
});

test("keeps single-protocol GOST tunnels on the fixed-forward path", () => {
  for (const protocol of ["tcp", "udp"] as const) {
    const plan = planGostTunnelRuleProtocol({
      protocol,
      tunnelId: 7,
      ruleId: 19,
      secretSeed: "tunnel-secret",
    });

    assert.equal(plan.entryNeedsTarget, false);
    assert.equal(plan.chainConnector.type, "forward");
    assert.equal(plan.exitHandler.type, "forward");
    assert.equal(plan.exitTargetDialType, protocol);
    assert.equal(plan.chainConnector.auth, undefined);
  }
});

test("derives different relay credentials for different rules", () => {
  const first = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 19, secretSeed: "same-secret" });
  const second = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 20, secretSeed: "same-secret" });

  assert.notEqual(first.chainConnector.auth?.password, second.chainConnector.auth?.password);
});

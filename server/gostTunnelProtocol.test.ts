import assert from "node:assert/strict";
import test from "node:test";
import { planGostTunnelHopRelay, planGostTunnelRuleProtocol } from "./gostTunnelProtocol";

test("derives tunnel-level authentication for intermediate GOST relays", () => {
  const first = planGostTunnelHopRelay({ tunnelId: 7, secretSeed: "tunnel-secret" });
  const same = planGostTunnelHopRelay({ tunnelId: 7, secretSeed: "tunnel-secret" });
  const otherTunnel = planGostTunnelHopRelay({ tunnelId: 8, secretSeed: "tunnel-secret" });

  assert.equal(first.type, "relay");
  assert.equal(first.auth?.username, "fwx-hop-7");
  assert.equal(first.auth?.password.length, 64);
  assert.deepEqual(first.metadata, { nodelay: true });
  assert.deepEqual(first, same);
  assert.notEqual(first.auth?.password, otherTunnel.auth?.password);
});

test("uses an authenticated relay for every GOST tunnel rule protocol", () => {
  for (const protocol of ["tcp", "udp", "both"] as const) {
    const plan = planGostTunnelRuleProtocol({
      protocol,
      tunnelId: 7,
      ruleId: 19,
      secretSeed: "tunnel-secret",
    });

    assert.equal(plan.protocol, protocol);
    assert.equal(plan.entryNeedsTarget, true);
    assert.equal(plan.exitTargetDialType, null);
    assert.equal(plan.chainConnector.type, "relay");
    assert.equal(plan.exitHandler.type, "relay");
    assert.deepEqual(plan.chainConnector.auth, plan.exitHandler.auth);
    assert.equal(plan.chainConnector.auth?.username, "fwx-7-19");
    assert.equal(plan.chainConnector.auth?.password.length, 64);
    assert.deepEqual(plan.chainConnector.metadata, { nodelay: true });
    assert.deepEqual(plan.exitHandler.metadata, { nodelay: true });
  }
});

test("derives different relay credentials for different rules", () => {
  const first = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 19, secretSeed: "same-secret" });
  const second = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 20, secretSeed: "same-secret" });

  assert.notEqual(first.chainConnector.auth?.password, second.chainConnector.auth?.password);
});

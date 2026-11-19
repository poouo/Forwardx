import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { planGostTunnelHopRelay, planGostTunnelRuleProtocol } from "./gostTunnelProtocol";

test("GOST business listeners enable cumulative native traffic stats without replacing other metadata", () => {
  const source = readFileSync(new URL("./agentHeartbeatRoute.ts", import.meta.url), "utf8");
  const entries = source.slice(source.indexOf("const gostServiceConfig ="), source.indexOf("const tunnelGostChains ="));
  assert.match(entries, /name: `fwx-\$\{r.id\}-\$\{proto\}`/);
  assert.match(entries, /service\.metadata = \{ \.\.\.\(service\.metadata \|\| \{\}\), enableStats: true, "observer\.resetTraffic": false \}/);
  assert.ok(entries.indexOf("enableStats: true") > entries.indexOf("dialTimeout:"));
  const exits = source.slice(source.indexOf("name: `fwx-tunnel-exit-"), source.indexOf("const ruleTrafficPort ="));
  assert.doesNotMatch(exits, /enableStats: true/);
});

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
    assert.equal(plan.chainConnector.auth?.username, "fwx-exit-7");
    assert.equal(plan.chainConnector.auth?.password.length, 64);
    assert.deepEqual(plan.chainConnector.metadata, { nodelay: true });
    assert.deepEqual(plan.exitHandler.metadata, { nodelay: true });
  }
});

test("shares exit authentication across rules but isolates tunnels and secret rotations", () => {
  const first = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 19, secretSeed: "same-secret" });
  const second = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 20, secretSeed: "same-secret" });

  assert.deepEqual(first.chainConnector, second.chainConnector);
  const otherTunnel = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 8, ruleId: 19, secretSeed: "same-secret" });
  const rotated = planGostTunnelRuleProtocol({ protocol: "both", tunnelId: 7, ruleId: 19, secretSeed: "rotated-secret" });
  assert.notEqual(first.chainConnector.auth?.password, otherTunnel.chainConnector.auth?.password);
  assert.notEqual(first.chainConnector.auth?.password, rotated.chainConnector.auth?.password);
});

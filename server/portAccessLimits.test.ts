import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { onlyPortAccessLimitChanged, portAccessLimitAction, portAccessLimitSpecs } from "./portAccessLimits";

test("only effective per-IP changes bypass ordinary runtime restarts, even when the UI submits unchanged speed/connection limits", () => {
  const before = { maxIPs: 2, maxConnections: 100, gostRateLimitIn: 10, gostRateLimitOut: 20 };
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3 }), true);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 0 }), true);
  assert.equal(onlyPortAccessLimitChanged(before, before), false);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3, maxConnections: 200 }), false);
  assert.equal(onlyPortAccessLimitChanged(before, { ...before, maxIPs: 3, gostRateLimitIn: 30 }), false);
  assert.equal(onlyPortAccessLimitChanged(null, before), false);
});

test("all ordinary forwarding backends share TCP limits per user on the entry host", () => {
  const rules = ["iptables", "nftables", "realm", "socat", "gost", "nginx", "guard"].map((forwardType, i) => ({
    userId: 7, sourcePort: 22000 + i, protocol: i % 2 ? "both" : "tcp", forwardType,
  }));
  rules.push({ userId: 8, sourcePort: 65535, protocol: "tcp", forwardType: "realm" });
  const specs = portAccessLimitSpecs(rules, user => ({ maxIPs: user === 7 ? 2 : 3, maxConnections: 100 }));
  assert.deepEqual(specs, [
    { userId: 7, maxIPs: 2, ports: [22000, 22001, 22002, 22003, 22004, 22005, 22006] },
    { userId: 8, maxIPs: 3, ports: [65535] },
  ]);
});

test("UDP, tunnel rules, invalid ports and unlimited users do not receive ordinary TCP limits", () => {
  assert.deepEqual(portAccessLimitSpecs([
    { userId: 1, sourcePort: 22, protocol: "udp" },
    { userId: 1, sourcePort: 23, protocol: "tcp", tunnelId: 3 },
    { userId: 1, sourcePort: 65536, protocol: "tcp" },
    { userId: 2, sourcePort: 24, protocol: "both" },
  ], user => ({ maxIPs: user === 1 ? 2 : 0, maxConnections: 100 })), []);
});

test("canonical snapshots ignore rule ordering and duplicate ports", () => {
  const rules = [23, 22, 22].map(sourcePort => ({ userId: 1, sourcePort, protocol: "both" }));
  assert.deepEqual(portAccessLimitSpecs(rules, () => ({ maxIPs: 2 })), portAccessLimitSpecs(rules.reverse(), () => ({ maxIPs: 2 })));
});

test("empty snapshots remove limits; old Agents explicitly fail rather than silently succeeding", () => {
  assert.deepEqual(portAccessLimitAction([], true)?.portAccessLimits, []);
  assert.equal(portAccessLimitAction([], false), null);
  const specs = [{ userId: 1, maxIPs: 2, ports: [22] }];
  const action = portAccessLimitAction(specs, true)!;
  assert.equal(action.statusType, "runtime");
  assert.equal(action.sourcePort, 0);
  assert.deepEqual(action.commands, []);
  assert.match(portAccessLimitAction(specs, false)!.commands.join("\n"), /updated ForwardX Agent.*exit 1/);
});

test("heartbeat sync covers already-running rules without applying/restarting their runtime", () => {
  const source = readFileSync(new URL("./agentHeartbeatRoute.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const portLimits = portAccessLimitSpecs"), source.indexOf("const effectiveActions = dropStalePortRemoveActions"));
  assert.match(block, /agentHostRules/);
  assert.match(block, /!runtimeBool\(rule.pendingDelete\)/);
  assert.match(block, /runtimeBool\(rule.isEnabled\)/);
  assert.match(block, /isRuleProtocolEnabled/);
  assert.doesNotMatch(block, /rule.isRunning|restart|resetForward/);
  assert.match(source, /portAccessLimits: action\?\.portAccessLimits \|\| \[\]/);
});

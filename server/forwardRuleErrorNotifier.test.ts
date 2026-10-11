import assert from "node:assert/strict";
import test from "node:test";
import { isCurrentForwardRuleError, pruneForwardRuleErrorNotifyCache, shouldNotifyForwardRuleError } from "./forwardRuleErrorNotifier";

test("forward-rule notification cooldown expires and dynamic messages remain bounded by time", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now), true);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 1_000), false);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.2 failed", now + 1_000), true);
  assert.equal(pruneForwardRuleErrorNotifyCache(now + 6 * 60 * 1000), 2);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 6 * 60 * 1000), true);
});

test("queued errors do not notify for removed, disabled, recovered or edited rules", () => {
  const rule = { id: 1, hostId: 2, sourcePort: 12345, targetIp: "203.0.113.50", targetPort: 443, forwardType: "gost", protocol: "tcp", isEnabled: true, isRunning: false, pendingDelete: false, telegramErrorNotifyEnabled: true };
  assert.equal(isCurrentForwardRuleError(rule, rule), true);
  for (const current of [null, { ...rule, pendingDelete: true }, { ...rule, isEnabled: false }, { ...rule, isRunning: true }, { ...rule, telegramErrorNotifyEnabled: false }, { ...rule, sourcePort: 12346 }, { ...rule, forwardType: "realm" }, { ...rule, hostId: 3 }, { ...rule, targetIp: "203.0.113.51" }]) {
    assert.equal(isCurrentForwardRuleError(current, rule), false);
  }
});

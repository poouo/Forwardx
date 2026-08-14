import assert from "node:assert/strict";
import test from "node:test";
import { pruneForwardRuleErrorNotifyCache, shouldNotifyForwardRuleError } from "./forwardRuleErrorNotifier";

test("forward-rule notification cooldown expires and dynamic messages remain bounded by time", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now), true);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 1_000), false);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.2 failed", now + 1_000), true);
  assert.equal(pruneForwardRuleErrorNotifyCache(now + 6 * 60 * 1000), 2);
  assert.equal(shouldNotifyForwardRuleError(101, "dial target 192.0.2.1 failed", now + 6 * 60 * 1000), true);
});

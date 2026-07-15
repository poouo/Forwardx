import assert from "node:assert/strict";
import test from "node:test";
import { summarizeForwardGroupRuntime } from "./forwardGroupRuntimeStatus";

test("forward group runtime requires every expected managed child listener", () => {
  const base = {
    group: { id: 1, groupMode: "failover", isEnabled: true },
    members: [
      { id: 11, isEnabled: true },
      { id: 12, isEnabled: true },
    ],
    templateRules: [{ id: 100, isEnabled: true, pendingDelete: false }],
  };

  const partial = summarizeForwardGroupRuntime({
    ...base,
    childRules: [
      { id: 101, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 103, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
    ],
  });
  assert.equal(partial.status, "degraded");
  assert.equal(partial.expectedRuleCount, 2);
  assert.equal(partial.runningRuleCount, 1);
  assert.equal(partial.failedRuleCount, 1);
  assert.equal(partial.ruleStatuses[0]?.status, "degraded");

  const healthy = summarizeForwardGroupRuntime({
    ...base,
    childRules: [
      { id: 101, forwardGroupRuleId: 100, forwardGroupMemberId: 11, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 102, forwardGroupRuleId: 100, forwardGroupMemberId: 12, isEnabled: true, isRunning: true, pendingDelete: false },
    ],
  });
  assert.equal(healthy.status, "running");
  assert.equal(healthy.failedRuleCount, 0);
});

test("forward chain runtime includes external entry listeners", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 2, groupMode: "chain", entryGroupId: 9, isEnabled: true },
    members: [{ id: 21, hostId: 201, isEnabled: true }, { id: 22, hostId: 202, isEnabled: true }],
    entryMembers: [{ id: 91, hostId: 901, isEnabled: true }, { id: 92, hostId: 902, isEnabled: true }],
    templateRules: [{ id: 200, isEnabled: true, pendingDelete: false }],
    childRules: [],
  });

  assert.equal(summary.status, "pending");
  assert.equal(summary.expectedRuleCount, 4);
  assert.equal(summary.ruleStatuses[0]?.expectedRuleCount, 4);
});

test("saved forward group without template rules remains idle", () => {
  const summary = summarizeForwardGroupRuntime({
    group: { id: 3, groupMode: "port", isEnabled: true },
    members: [{ id: 31, isEnabled: true }],
  });
  assert.equal(summary.status, "idle");
  assert.equal(summary.expectedRuleCount, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { forwardGroupRouteMembers, forwardGroupSelfTestSource } from "./forwardGroup";

test("failover route follows the active member even when a higher-priority server recovers", () => {
  const members = [
    { id: 1, hostId: 10, priority: 0, isEnabled: true, host: { isOnline: true } },
    { id: 2, hostId: 20, priority: 1, isEnabled: true, host: { isOnline: true } },
    { id: 3, hostId: 30, priority: 2, isEnabled: false },
  ];
  assert.deepEqual(forwardGroupRouteMembers({ members, activeMemberId: 2 }).map(m => m.hostId), [20, 10]);
  assert.deepEqual(forwardGroupRouteMembers({ members, activeMemberId: 1 }).map(m => m.hostId), [10, 20]);
  assert.equal(members[0].id, 1, "do not reorder cached group data");
});

test("tunnel route follows its active member; serial chains never skip or reorder nodes", () => {
  const members = [{ id: 1, tunnelId: 10, priority: 0 }, { id: 2, tunnelId: 20, priority: 1 }];
  assert.equal(forwardGroupRouteMembers({ groupType: "tunnel", activeMemberId: 2, members })[0].tunnelId, 20);
  assert.equal(forwardGroupRouteMembers({ groupMode: "chain", activeMemberId: 2, members })[0].tunnelId, 10);
  assert.equal(forwardGroupRouteMembers({ members: [
    { id: 1, host: { isOnline: false } }, { id: 2, host: { isOnline: true } },
  ] })[0].id, 2);
});

test("test source labels come from the persisted route rather than the current group", () => {
  const snapshot = { kind: "forward-group", sourceLabel: "备用入口", targetLabel: "我的规则" };
  assert.deepEqual(forwardGroupSelfTestSource({ hostId: 2, requestMessage: JSON.stringify(snapshot) }), {
    hostId: 2, label: "备用入口", targetLabel: "我的规则",
  });
  for (const requestMessage of [null, "bad-json", JSON.stringify({ kind: "forward-chain" })]) {
    assert.equal(forwardGroupSelfTestSource({ hostId: 2, requestMessage }), null);
  }
});

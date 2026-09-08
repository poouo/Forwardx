import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FORWARD_GROUP_MEMBERS } from "../shared/forwardGroup";
import { normalizeForwardGroupMembers } from "./services/forwardGroupService";

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    memberType: "host" as const,
    hostId: index + 1,
    tunnelId: null,
    isEnabled: true,
  }));
}

test("forward chain and entry/exit groups allow up to the shared member limit", () => {
  for (const groupMode of ["chain", "entry", "exit"] as const) {
    const minimum = groupMode === "chain" ? 2 : 1;
    assert.doesNotThrow(() => normalizeForwardGroupMembers(groupMode, "host", members(minimum)));
    assert.doesNotThrow(() => normalizeForwardGroupMembers(groupMode, "host", members(MAX_FORWARD_GROUP_MEMBERS)));
    assert.throws(
      () => normalizeForwardGroupMembers(groupMode, "host", members(MAX_FORWARD_GROUP_MEMBERS + 1)),
      /需要配置|requires/,
    );
  }
});

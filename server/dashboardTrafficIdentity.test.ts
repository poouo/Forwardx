import assert from "node:assert/strict";
import test from "node:test";
import { resolveDashboardTrafficRuleIdentity } from "./dashboardTrafficIdentity";

test("uses the saved template identity for managed forward-chain children", () => {
  const identity = resolveDashboardTrafficRuleIdentity(901, {
    name: "[Chain:Tokyo] 1/2 internal child",
    forwardGroupRuleId: 77,
  }, new Map([[77, "Tokyo relay rule"]]));

  assert.deepEqual(identity, { id: 77, name: "Tokyo relay rule" });
});

test("does not expose an internal child name when its template is unavailable", () => {
  const identity = resolveDashboardTrafficRuleIdentity(901, {
    name: "[Chain:Tokyo] 1/2 internal child",
    forwardGroupRuleId: 77,
  }, new Map());

  assert.equal(identity.id, 77);
  assert.equal(identity.name.includes("[Chain:"), false);
});

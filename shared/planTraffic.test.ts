import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlanTrafficMode, planTrafficBytes, rulePlanTrafficMode, type PlanTrafficEntitlement } from "./planTraffic";

test("plan accounting defaults to two-way and one-way counts only outbound bytes", () => {
  for (const mode of [undefined, null, "", "invalid", "both"]) {
    assert.equal(normalizePlanTrafficMode(mode), "both");
    assert.equal(planTrafficBytes(mode, 100, 200), 300);
  }
  assert.equal(planTrafficBytes("outbound", 100, 200), 200);
  assert.equal(planTrafficBytes("outbound", 100, 0), 0);
  assert.equal(planTrafficBytes("both", NaN, -10), 0);
});

test("one-way plans apply only to their user's resource and allocated ports", () => {
  const sub: PlanTrafficEntitlement = { userId: 2, portRangeStart: 10000, portRangeEnd: 10009, trafficMode: "outbound", hostIds: [1], tunnelIds: [2], forwardGroupIds: [3] };
  const rule = { userId: 2, sourcePort: 10000, hostId: 1 };
  assert.equal(rulePlanTrafficMode(rule, [sub]), "outbound");
  assert.equal(rulePlanTrafficMode({ ...rule, sourcePort: 10009 }, [sub]), "outbound");
  for (const patch of [{ sourcePort: 9999 }, { sourcePort: 10010 }, { userId: 1 }, { hostId: 4 }]) {
    assert.equal(rulePlanTrafficMode({ ...rule, ...patch }, [sub]), "both");
  }
  assert.equal(rulePlanTrafficMode({ ...rule, hostId: 4, tunnelId: 2 }, [sub]), "outbound");
  assert.equal(rulePlanTrafficMode({ ...rule, hostId: 4, forwardGroupId: 3, sourcePort: 30000, quotaSourcePort: 10000 }, [sub]), "outbound");
  assert.equal(rulePlanTrafficMode(rule, [sub, { ...sub, trafficMode: "both" }]), "both");
  assert.equal(rulePlanTrafficMode(rule, []), "both");
});

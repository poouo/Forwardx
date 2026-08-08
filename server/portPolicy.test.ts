import assert from "node:assert/strict";
import test from "node:test";
import {
  combinePortPolicies,
  isPortAllowedByPolicy,
  pickAvailablePort,
  portPolicyFrom,
} from "./portPolicy";

test("disjoint subscription port ranges do not authorize the gap", () => {
  const plan = portPolicyFrom({
    portRanges: [
      { start: 10000, end: 10002 },
      { start: 10010, end: 10012 },
    ],
  });

  assert.equal(isPortAllowedByPolicy(10000, plan), true);
  assert.equal(isPortAllowedByPolicy(10011, plan), true);
  assert.equal(isPortAllowedByPolicy(10006, plan), false);

  const host = portPolicyFrom({ portRangeStart: 10001, portRangeEnd: 10011 });
  const effective = combinePortPolicies(host, plan);
  assert.equal(isPortAllowedByPolicy(10001, effective), true);
  assert.equal(isPortAllowedByPolicy(10006, effective), false);
  assert.equal(isPortAllowedByPolicy(10010, effective), true);

  const selected = pickAvailablePort(effective, new Set([10001, 10010]), { start: 10000, end: 10020 });
  assert.ok(selected === 10002 || selected === 10011 || selected === 10012);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  combinePortPolicies,
  isPortAllowedByPolicy,
  pickAvailablePort,
  portPolicyFrom,
  type PortPolicy,
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

test("combining policies preserves sparse ports across the full port domain", () => {
  const sparsePorts = Array.from({ length: 32768 }, (_, index) => index * 2 + 1);
  const sparse = portPolicyFrom({ portAllowlist: sparsePorts.join(",") });
  const fullRange = portPolicyFrom({ portRangeStart: 1, portRangeEnd: 65535 });
  const effective = combinePortPolicies(fullRange, sparse);

  assert.equal(effective.allowlist.length, sparsePorts.length);
  for (let port = 1; port <= 65535; port += 1) {
    assert.equal(isPortAllowedByPolicy(port, effective), port % 2 === 1, `unexpected policy result for ${port}`);
  }
});

test("combining policies keeps disjoint intersections compact", () => {
  const left = portPolicyFrom({
    portRanges: [
      { start: 1000, end: 2000 },
      { start: 10000, end: 20000 },
    ],
  });
  const right = portPolicyFrom({
    portRanges: [
      { start: 1500, end: 2500 },
      { start: 15000, end: 25000 },
    ],
  });

  const effective = combinePortPolicies(left, right);
  assert.deepEqual(effective, {
    rangeStart: 15000,
    rangeEnd: 20000,
    allowlist: [],
    ranges: [{ start: 1500, end: 2000 }],
  });
});

test("manually constructed unsorted policies retain lookup semantics", () => {
  const policy = {
    rangeStart: null,
    rangeEnd: null,
    allowlist: [6000, 1000],
    ranges: [
      { start: 9000, end: 9010 },
      { start: 2000, end: 2010 },
    ],
  };

  assert.equal(isPortAllowedByPolicy(1000, policy), true);
  assert.equal(isPortAllowedByPolicy(2005, policy), true);
  assert.equal(isPortAllowedByPolicy(5000, policy), false);
});

test("deny-all remains absorbing when policies are combined", () => {
  const denyAll = {
    rangeStart: 1000,
    rangeEnd: 2000,
    allowlist: [3000],
    denyAll: true,
  };
  const effective = combinePortPolicies(portPolicyFrom(null), denyAll);

  assert.equal(effective.denyAll, true);
  assert.equal(isPortAllowedByPolicy(1500, effective), false);
  assert.equal(isPortAllowedByPolicy(3000, effective), false);
});

test("interval intersection matches direct policy evaluation", () => {
  const policies: PortPolicy[] = [
    {
      rangeStart: -10,
      rangeEnd: 5000.5,
      allowlist: [65000, 12345],
      ranges: [{ start: 30000, end: 40000 }],
    },
    {
      rangeStart: 2500.25,
      rangeEnd: 35000.75,
      allowlist: [65000],
      ranges: [{ start: 12000, end: 13000 }, { start: 4500, end: 5500 }],
    },
    {
      rangeStart: null,
      rangeEnd: null,
      allowlist: [65000, 12345],
      ranges: [{ start: 1000, end: 32000 }],
    },
  ];
  const directAllows = (port: number, policy: PortPolicy) => !policy.denyAll && (
    (policy.rangeStart !== null && policy.rangeEnd !== null && port >= policy.rangeStart && port <= policy.rangeEnd)
    || (policy.ranges || []).some((range) => port >= range.start && port <= range.end)
    || policy.allowlist.includes(port)
  );
  const effective = combinePortPolicies(...policies);

  for (let port = 1; port <= 65535; port += 1) {
    assert.equal(
      isPortAllowedByPolicy(port, effective),
      policies.every((policy) => directAllows(port, policy)),
      `intersection differs at port ${port}`,
    );
  }
});

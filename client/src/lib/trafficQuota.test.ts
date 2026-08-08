import assert from "node:assert/strict";
import test from "node:test";
import { trafficQuotaBreakdown } from "./trafficQuota";

const now = new Date("2026-08-07T12:00:00.000Z").getTime();
const activePlan = (trafficLimit: number, purchasedAddon = 0, grantedAddon = 0) => ({
  status: "active",
  trafficLimit,
  activeTrafficAddonBytes: purchasedAddon + grantedAddon,
  purchasedTrafficAddonBytes: purchasedAddon,
  grantedTrafficAddonBytes: grantedAddon,
  expiresAt: "2026-09-07T12:00:00.000Z",
});

test("keeps manual, plan, and purchased add-on traffic as separate sources", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: true, manualTrafficLimit: 100 },
    [activePlan(100, 25, 10)],
    now,
  );

  assert.deepEqual(result.sources, [
    { kind: "manual", bytes: 100, unlimited: false },
    { kind: "plan", bytes: 100, unlimited: false },
    { kind: "addon", bytes: 25, unlimited: false },
    { kind: "grant", bytes: 10, unlimited: false },
  ]);
  assert.equal(result.totalBytes, 135);
  assert.equal(result.unlimited, false);
});

test("omits quota sources that do not exist", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: false, manualTrafficLimit: 0 },
    [activePlan(100)],
    now,
  );

  assert.deepEqual(result.sources, [
    { kind: "plan", bytes: 100, unlimited: false },
  ]);
});

test("keeps compatibility with an unsplit active add-on total", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: false, manualTrafficLimit: 0 },
    [{
      status: "active",
      trafficLimit: 100,
      activeTrafficAddonBytes: 20,
      expiresAt: "2026-09-07T12:00:00.000Z",
    }],
    now,
  );
  assert.deepEqual(result.sources, [
    { kind: "plan", bytes: 100, unlimited: false },
    { kind: "addon", bytes: 20, unlimited: false },
  ]);
  assert.equal(result.totalBytes, 120);
});

test("adds finite plan quotas and active add-ons across subscriptions", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: true, manualTrafficLimit: 80 },
    [activePlan(100, 10), activePlan(200, 20, 5)],
    now,
  );
  assert.deepEqual(result.sources, [
    { kind: "manual", bytes: 80, unlimited: false },
    { kind: "plan", bytes: 300, unlimited: false },
    { kind: "addon", bytes: 30, unlimited: false },
    { kind: "grant", bytes: 5, unlimited: false },
  ]);
  assert.equal(result.totalBytes, 335);
});

test("adds paid traffic after choosing the larger manual or plan base quota", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: true, manualTrafficLimit: 200 },
    [activePlan(100, 25, 10)],
    now,
  );

  assert.equal(result.totalBytes, 235);
});

test("represents an active unlimited manual or plan grant without inventing bytes", () => {
  assert.deepEqual(
    trafficQuotaBreakdown({ manualCanAddRules: true, manualTrafficLimit: 0 }, [], now),
    {
      sources: [{ kind: "manual", bytes: 0, unlimited: true }],
      totalBytes: 0,
      unlimited: true,
      hasQuota: true,
    },
  );

  const planResult = trafficQuotaBreakdown(
    { manualCanAddRules: true, manualTrafficLimit: 0 },
    [activePlan(0, 10)],
    now,
  );
  assert.deepEqual(planResult.sources, [
    { kind: "plan", bytes: 0, unlimited: true },
    { kind: "addon", bytes: 10, unlimited: false },
  ]);
  assert.equal(planResult.unlimited, true);
});

test("ignores cancelled and expired subscription quota", () => {
  const result = trafficQuotaBreakdown(
    { manualCanAddRules: false, manualTrafficLimit: 0 },
    [
      { ...activePlan(100, 20), status: "cancelled" },
      { ...activePlan(200, 30), expiresAt: "2026-08-06T12:00:00.000Z" },
    ],
    now,
  );
  assert.deepEqual(result, { sources: [], totalBytes: 0, unlimited: false, hasQuota: false });
});

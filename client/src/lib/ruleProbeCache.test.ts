import assert from "node:assert/strict";
import test from "node:test";
import { LINK_PROBE_FRESH_MS } from "@shared/linkProbePolicy";
import {
  buildStableRuleProbeMap,
  clearRuleProbeCache,
  hasRuleProbeAfterInvalidation,
  updateRuleProbeCache,
} from "./ruleProbeCache";

const now = Date.UTC(2026, 6, 27, 12, 0, 0);

function success(latencyMs: number, latestLatencyAt: number) {
  return {
    latestLatencyMs: latencyMs,
    latestLatencyIsTimeout: false,
    latestLatencyAt,
  };
}

test("a fresh cached probe survives a temporary missing traffic row", () => {
  const probe = success(42, now - 30_000);
  updateRuleProbeCache("temporary-gap", new Map([[11, probe]]));

  const stable = buildStableRuleProbeMap("temporary-gap", [11], new Map(), now);

  assert.equal(stable.get(11), probe);
});

test("probe caches are isolated by user", () => {
  updateRuleProbeCache("cache-owner", new Map([[12, success(18, now - 10_000)]]));

  const otherUser = buildStableRuleProbeMap("different-user", [12], new Map(), now);

  assert.equal(otherUser.has(12), false);
});

test("an out-of-order response cannot replace a newer cached probe", () => {
  const newest = success(25, now - 10_000);
  const older = success(90, now - 20_000);
  updateRuleProbeCache("out-of-order", new Map([[13, newest]]));
  updateRuleProbeCache("out-of-order", new Map([[13, older]]));

  const stable = buildStableRuleProbeMap("out-of-order", [13], new Map(), now);

  assert.equal(stable.get(13), newest);
});

test("an expired fallback is dropped while an authoritative current probe remains visible", () => {
  const oldProbe = success(61, now - LINK_PROBE_FRESH_MS - 1);
  updateRuleProbeCache("expired-fallback", new Map([[14, oldProbe]]));

  assert.equal(
    buildStableRuleProbeMap("expired-fallback", [14], new Map(), now).has(14),
    false,
  );
  assert.equal(
    buildStableRuleProbeMap("expired-fallback", [14], new Map([[14, oldProbe]]), now).get(14),
    oldProbe,
  );
});

test("invalidation blocks the old probe until a result recorded after the change arrives", () => {
  const beforeInvalidation = success(36, Date.now() - 10_000);
  updateRuleProbeCache("invalidated-rule", new Map([[15, beforeInvalidation]]));
  clearRuleProbeCache("invalidated-rule", [15]);
  const invalidated = new Set([15]);

  updateRuleProbeCache("invalidated-rule", new Map([[15, beforeInvalidation]]));
  assert.equal(
    hasRuleProbeAfterInvalidation("invalidated-rule", 15, beforeInvalidation),
    false,
  );
  assert.equal(
    buildStableRuleProbeMap("invalidated-rule", [15], new Map([[15, beforeInvalidation]]), Date.now(), invalidated).has(15),
    false,
  );

  // The server clock can trail the browser clock. A newly observed probe only
  // needs to be newer than the result that was visible before invalidation.
  const afterInvalidation = success(29, Number(beforeInvalidation.latestLatencyAt) + 1_000);
  updateRuleProbeCache("invalidated-rule", new Map([[15, afterInvalidation]]));
  assert.equal(
    hasRuleProbeAfterInvalidation("invalidated-rule", 15, afterInvalidation),
    true,
  );
  invalidated.delete(15);
  assert.equal(
    buildStableRuleProbeMap("invalidated-rule", [15], new Map(), Date.now(), invalidated).get(15),
    afterInvalidation,
  );
});

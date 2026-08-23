import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTrafficPaddingEnableAuthorized,
  canEnableTrafficPadding,
  trafficPaddingConfigurationRequiresAuthorization,
} from "./trafficPaddingAuthorization";

test("traffic padding enablement is reserved for administrators", () => {
  assert.equal(canEnableTrafficPadding({ role: "admin" } as any), true);
  assert.equal(canEnableTrafficPadding({ role: "user" } as any), false);
  assert.throws(() => assertTrafficPaddingEnableAuthorized({ role: "user" } as any));
});

test("padding updates only require authorization when the final enabled config changes", () => {
  const enabled = {
    trafficPaddingEnabled: true,
    trafficPaddingRatio: 10,
    trafficPaddingMaxMbps: 100,
  } as const;
  assert.equal(trafficPaddingConfigurationRequiresAuthorization(enabled, enabled), false);
  assert.equal(
    trafficPaddingConfigurationRequiresAuthorization(enabled, { ...enabled, trafficPaddingRatio: 15 }),
    true,
  );
  assert.equal(
    trafficPaddingConfigurationRequiresAuthorization(
      { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 },
      enabled,
    ),
    true,
  );
  assert.equal(
    trafficPaddingConfigurationRequiresAuthorization(enabled, {
      trafficPaddingEnabled: false,
      trafficPaddingRatio: 0,
      trafficPaddingMaxMbps: 0,
    }),
    false,
  );
  assert.equal(
    trafficPaddingConfigurationRequiresAuthorization(
      { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 },
      { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 },
    ),
    false,
  );
});

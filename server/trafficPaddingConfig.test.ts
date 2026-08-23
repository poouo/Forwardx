import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTrafficPadding } from "./trafficPaddingConfig";

const enabledConfig = { enabled: true } as const;
const disabledConfig = { enabled: false } as const;

test("traffic padding is disabled by the panel capability switch", () => {
  assert.deepEqual(
    effectiveTrafficPadding({ trafficPaddingEnabled: true, trafficPaddingRatio: 15, trafficPaddingMaxMbps: 5 }, { mode: "forwardx", forwardxVersion: "v1" }, disabledConfig),
    { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 },
  );
});

test("enabled capability preserves explicit per-tunnel values", () => {
  assert.deepEqual(
    effectiveTrafficPadding({ trafficPaddingEnabled: true, trafficPaddingRatio: 15, trafficPaddingMaxMbps: 5 }, { mode: "forwardx", forwardxVersion: "v1" }, enabledConfig),
    { trafficPaddingEnabled: true, trafficPaddingRatio: 15, trafficPaddingMaxMbps: 5 },
  );
});

test("unsupported runtimes remain disabled even when the capability is on", () => {
  assert.deepEqual(
    effectiveTrafficPadding({ trafficPaddingEnabled: true, trafficPaddingRatio: 15, trafficPaddingMaxMbps: 5 }, { mode: "tls", forwardxVersion: "v1" }, enabledConfig),
    { trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 },
  );
});

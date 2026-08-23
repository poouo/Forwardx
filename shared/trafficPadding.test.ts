import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTrafficPadding,
  trafficPaddingInputIsValid,
  trafficPaddingRuntimeSupported,
} from "./trafficPadding";

test("traffic padding defaults to disabled and zero values", () => {
  assert.deepEqual(normalizeTrafficPadding(undefined, { mode: "forwardx", forwardxVersion: "v1" }), {
    trafficPaddingEnabled: false,
    trafficPaddingRatio: 0,
    trafficPaddingMaxMbps: 0,
  });
});
test("disabled settings discard stale ratio and rate values", () => {
  assert.deepEqual(normalizeTrafficPadding({
    trafficPaddingEnabled: false,
    trafficPaddingRatio: 20,
    trafficPaddingMaxMbps: 100,
  }, { mode: "forwardx", forwardxVersion: "v1" }), {
    trafficPaddingEnabled: false,
    trafficPaddingRatio: 0,
    trafficPaddingMaxMbps: 0,
  });
});

test("supported V1 settings are clamped to safe bounds", () => {
  assert.deepEqual(normalizeTrafficPadding({
    trafficPaddingEnabled: true,
    trafficPaddingRatio: 500,
    trafficPaddingMaxMbps: 999999,
  }, { mode: "forwardx", forwardxVersion: "v1" }), {
    trafficPaddingEnabled: true,
    trafficPaddingRatio: 50,
    trafficPaddingMaxMbps: 1000,
  });
});

test("GOST and V2 runtimes cannot enable padding", () => {
  assert.equal(trafficPaddingRuntimeSupported({ mode: "tls", forwardxVersion: "v1" }), false);
  assert.equal(trafficPaddingRuntimeSupported({ mode: "forwardx", forwardxVersion: "v2" }), false);
  assert.deepEqual(normalizeTrafficPadding({ trafficPaddingEnabled: true, trafficPaddingRatio: 10 }, { mode: "tls", forwardxVersion: "v1" }).trafficPaddingEnabled, false);
});

test("input validation requires a whole-number ratio when enabled", () => {
  assert.equal(trafficPaddingInputIsValid({ trafficPaddingEnabled: false, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 }), true);
  assert.equal(trafficPaddingInputIsValid({ trafficPaddingEnabled: true, trafficPaddingRatio: 10, trafficPaddingMaxMbps: 0 }), true);
  assert.equal(trafficPaddingInputIsValid({ trafficPaddingEnabled: true, trafficPaddingRatio: 0, trafficPaddingMaxMbps: 0 }), false);
  assert.equal(trafficPaddingInputIsValid({ trafficPaddingEnabled: true, trafficPaddingRatio: 10.5, trafficPaddingMaxMbps: 0 }), false);
});

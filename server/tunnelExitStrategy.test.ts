import assert from "node:assert/strict";
import test from "node:test";
import { exitGroupUsesMultipleExits, normalizeExitGroupStrategy } from "../shared/exitStrategy";
import { forwardXExitStrategy, gostExitSelector, planExitGroupTunnelEndpoints } from "./tunnelExitStrategy";

test("normalizes exit-group strategies without enabling unknown values", () => {
  assert.equal(normalizeExitGroupStrategy("fallback"), "fallback");
  assert.equal(normalizeExitGroupStrategy("IP_HASH"), "ip_hash");
  assert.equal(normalizeExitGroupStrategy("unsupported"), "round_robin");
  assert.equal(exitGroupUsesMultipleExits("none"), false);
  assert.equal(exitGroupUsesMultipleExits("random"), true);
});

test("maps shared exit strategies to GOST and ForwardX selectors", () => {
  assert.deepEqual(gostExitSelector("fallback"), {
    strategy: "fifo",
    maxFails: 1,
    failTimeout: "5s",
  });
  assert.equal(gostExitSelector("random").strategy, "random");
  assert.equal(gostExitSelector("ip_hash").strategy, "hash");
  assert.equal(forwardXExitStrategy("none"), "round_robin");
  assert.equal(forwardXExitStrategy("ip_hash"), "ip_hash");
});

test("reorders exit-group endpoints without changing ports already assigned to a host", () => {
  const endpoints = planExitGroupTunnelEndpoints([
    { hostId: 2, priority: 0, connectHost: "2001:db8::2" },
    { hostId: 1, priority: 1 },
    { hostId: 3, priority: 2, isEnabled: false },
  ], [
    { hostId: 1, listenPort: 21001, mimicPort: 31001 },
    { hostId: 2, listenPort: 21002, mimicPort: 31002 },
    { hostId: 4, listenPort: 21004, mimicPort: 31004 },
  ]);

  assert.deepEqual(endpoints, [
    { hostId: 2, listenPort: 21002, mimicPort: 31002, connectHost: "2001:db8::2" },
    { hostId: 1, listenPort: 21001, mimicPort: 31001, connectHost: null },
  ]);
});

test("leaves a new exit-group member without a port so the repository can allocate one", () => {
  const endpoints = planExitGroupTunnelEndpoints([
    { hostId: 5, priority: 0 },
    { hostId: 2, priority: 1 },
  ], [
    { hostId: 2, listenPort: 22002, mimicPort: 0 },
  ]);

  assert.deepEqual(endpoints, [
    { hostId: 5, listenPort: 0, mimicPort: 0, connectHost: null },
    { hostId: 2, listenPort: 22002, mimicPort: 0, connectHost: null },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  approveMimicInterfaceRemovals,
  clearMimicRemovalGuardForTests,
} from "./mimicRemovalGuard";

test("mimic removal requires three complete empty snapshots and sixty seconds", () => {
  clearMimicRemovalGuardForTests();
  const observe = (now: number) => approveMimicInterfaceRemovals({
    hostId: 8,
    desiredInterfaces: [],
    reportedInterfaces: ["eth0"],
    completeSnapshot: true,
    now,
  });
  assert.equal(observe(1_000).size, 0);
  assert.equal(observe(31_000).size, 0);
  assert.equal(observe(61_000).has("eth0"), true);
});

test("mimic removal guard resets on reboot and desired config recovery", () => {
  clearMimicRemovalGuardForTests();
  const base = { hostId: 9, desiredInterfaces: [], reportedInterfaces: ["ens3"], completeSnapshot: true };
  approveMimicInterfaceRemovals({ ...base, now: 1_000 });
  approveMimicInterfaceRemovals({ ...base, now: 31_000 });
  assert.equal(approveMimicInterfaceRemovals({ ...base, now: 61_000, rebootDetected: true }).size, 0);
  assert.equal(approveMimicInterfaceRemovals({ ...base, desiredInterfaces: ["ens3"], now: 91_000 }).size, 0);
  assert.equal(approveMimicInterfaceRemovals({ ...base, now: 121_000 }).size, 0);
});

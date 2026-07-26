import assert from "node:assert/strict";
import test from "node:test";
import { MimicRuntimeLifecycleTracker } from "./mimicRuntimeLifecycle";

test("mimic runtime lifecycle stays stable for an unchanged healthy plan", () => {
  const tracker = new MimicRuntimeLifecycleTracker("panel-epoch");
  const input = {
    hostId: 8,
    planSignature: "eth0:remote=192.0.2.1:61500",
    resourceRevisionSignature: "tunnel:3:40",
    desired: true,
    repairNeeded: false,
    revision: 40,
  };

  assert.equal(tracker.observe(input), "config:40");
  assert.equal(tracker.observe({ ...input, revision: 41 }), "config:40");
});

test("mimic runtime lifecycle changes after an unobserved disable and re-enable", () => {
  const tracker = new MimicRuntimeLifecycleTracker("panel-epoch");
  const enabled = {
    hostId: 8,
    planSignature: "eth0:remote=192.0.2.1:61500",
    resourceRevisionSignature: "tunnel:3:40",
    desired: true,
    repairNeeded: false,
    revision: 40,
  };

  assert.equal(tracker.observe(enabled), "config:40");
  assert.equal(tracker.observe({
    ...enabled,
    resourceRevisionSignature: "tunnel:3:42",
    revision: 42,
  }), "config:42");
});

test("mimic runtime lifecycle changes when a plan is disabled and re-enabled", () => {
  const tracker = new MimicRuntimeLifecycleTracker("panel-epoch");
  const enabled = {
    hostId: 8,
    planSignature: "eth0:remote=192.0.2.1:61500",
    desired: true,
    repairNeeded: false,
    revision: 40,
  };

  assert.equal(tracker.observe(enabled), "config:40");
  assert.equal(tracker.observe({ ...enabled, planSignature: "empty", desired: false, revision: 41 }), "config:41");
  assert.equal(tracker.observe({ ...enabled, revision: 42 }), "config:42");
});

test("mimic runtime lifecycle advances once per unhealthy transition", () => {
  const tracker = new MimicRuntimeLifecycleTracker("panel-epoch");
  const healthy = {
    hostId: 8,
    planSignature: "eth0:local=0.0.0.0:61500",
    desired: true,
    repairNeeded: false,
    revision: 50,
  };

  assert.equal(tracker.observe(healthy), "config:50");
  assert.equal(tracker.observe({ ...healthy, repairNeeded: true }), "config:50:2");
  assert.equal(tracker.observe({ ...healthy, repairNeeded: true }), "config:50:2");
  assert.equal(tracker.observe(healthy), "config:50:2");
  assert.equal(tracker.observe({ ...healthy, repairNeeded: true }), "config:50:3");
});

test("mimic runtime lifecycle has a process-local fallback without a revision", () => {
  const tracker = new MimicRuntimeLifecycleTracker("panel-epoch");
  const enabled = { hostId: 8, planSignature: "eth0:local=:61500", desired: true, repairNeeded: false };

  assert.equal(tracker.observe(enabled), "panel-epoch:1");
  assert.equal(tracker.observe({ ...enabled, planSignature: "empty", desired: false }), "panel-epoch:2");
  assert.equal(tracker.observe(enabled), "panel-epoch:3");
});

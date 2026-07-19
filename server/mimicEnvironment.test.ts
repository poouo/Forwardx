import assert from "node:assert/strict";
import test from "node:test";
import { assertMimicEnvironment, mimicEnvironmentProblem } from "./mimicEnvironment";

test("Mimic environment accepts an online ready Agent", () => {
  assert.equal(mimicEnvironmentProblem({ name: "entry", isOnline: true, mimicAvailable: true, mimicStatus: "ready" }), null);
  assert.doesNotThrow(() => assertMimicEnvironment([
    { name: "entry", isOnline: true, mimicAvailable: true, mimicStatus: "ready" },
    { name: "exit", isOnline: true, mimicAvailable: true, mimicStatus: "ready" },
  ]));
});

test("Mimic environment explains missing CLI and module", () => {
  assert.match(mimicEnvironmentProblem({
    name: "entry",
    isOnline: true,
    mimicAvailable: false,
    mimicStatus: "command-missing",
  }) || "", /mimic.*mimic-dkms/i);
  assert.match(mimicEnvironmentProblem({
    name: "exit",
    isOnline: true,
    mimicAvailable: false,
    mimicStatus: "kernel-module-missing",
  }) || "", /内核模块/);
});

test("Mimic environment rejects offline and unreported Agents", () => {
  assert.throws(() => assertMimicEnvironment([
    { name: "offline", isOnline: false, mimicAvailable: true, mimicStatus: "ready" },
  ]), /离线/);
  assert.throws(() => assertMimicEnvironment([
    { name: "legacy", isOnline: true, mimicAvailable: null, mimicStatus: null },
  ]), /升级 Agent/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAgentPluginInventoriesForTest,
  getAgentPluginInventory,
  updateAgentPluginInventory,
} from "./agentPluginInventory";

test.beforeEach(() => clearAgentPluginInventoriesForTest());

test("tracks normalized plugin versions independently for each Agent", () => {
  assert.equal(updateAgentPluginInventory(1, { "Demo.Plugin": " 2.2.0 ", invalid: "" }, { "Demo.Plugin": " sync-abc " }, 10_000), true);
  assert.equal(updateAgentPluginInventory(2, {}, {}, 10_000), true);
  assert.equal(getAgentPluginInventory(1, 10_001)?.versions.get("demo.plugin"), "2.2.0");
  assert.equal(getAgentPluginInventory(1, 10_001)?.syncSignatures.get("demo.plugin"), "sync-abc");
  assert.equal(getAgentPluginInventory(2, 10_001)?.versions.size, 0);
});

test("ignores incomplete metrics-only reports and expires the last complete inventory", () => {
  assert.equal(updateAgentPluginInventory(1, { demo: "1.0.0" }, {}, 10_000), true);
  assert.equal(updateAgentPluginInventory(1, undefined, undefined, 10_000), false);
  assert.ok(getAgentPluginInventory(1, 10_001), "an inventory omission from metrics-only heartbeat must preserve the snapshot");
  assert.equal(updateAgentPluginInventory(1, { demo: "1.0.0" }, undefined, 10_001), false);
  assert.equal(getAgentPluginInventory(1, 10_002)?.versions.get("demo"), "1.0.0");
  assert.equal(getAgentPluginInventory(1, 10_000 + 2 * 60 * 1000 + 1), null);
});

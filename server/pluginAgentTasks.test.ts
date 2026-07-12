import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPluginAgentTasksForTest,
  enqueuePluginAgentTaskGroup,
  getPluginAgentTaskGroup,
  hasQueuedPluginAgentTasks,
  takePluginAgentTasks,
} from "./pluginAgentTasks";

test.beforeEach(() => clearPluginAgentTasksForTest());
test.after(() => clearPluginAgentTasksForTest());

test("keeps Agent tasks queued until the installed plugin version is eligible", () => {
  const group = enqueuePluginAgentTaskGroup({
    pluginId: "demo-plugin",
    pluginVersion: "2.2.0",
    actionId: "read-status",
    executor: "script",
    workingDirectory: "/var/lib/forwardx-agent/plugins/demo-plugin",
    entry: "run.sh",
    hosts: [{ id: 7, name: "Agent 7" }],
  });

  assert.deepEqual(takePluginAgentTasks(7, 2, () => false), []);
  assert.equal(hasQueuedPluginAgentTasks(7), true);
  assert.equal(getPluginAgentTaskGroup(group.groupId)?.status, "queued");

  const tasks = takePluginAgentTasks(7, 2, (task) => task.pluginVersion === "2.2.0");
  assert.equal(tasks.length, 1);
  assert.equal(hasQueuedPluginAgentTasks(7), false);
  assert.equal(getPluginAgentTaskGroup(group.groupId)?.status, "running");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPluginAgentTasksForTest,
  completePluginAgentTask,
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
    intent: "read",
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
  assert.equal(tasks[0]?.intent, "read");
  assert.equal(hasQueuedPluginAgentTasks(7), false);
  assert.equal(getPluginAgentTaskGroup(group.groupId)?.status, "running");
});

test("dispatches up to four independent plugin tasks for one Agent heartbeat", () => {
  for (let index = 0; index < 5; index += 1) {
    enqueuePluginAgentTaskGroup({
      pluginId: "demo-plugin",
      pluginVersion: "2.2.0",
      actionId: `read-${index}`,
      intent: "read",
      executor: "script",
      workingDirectory: "/var/lib/forwardx-agent/plugins/demo-plugin",
      entry: "run.sh",
      hosts: [{ id: 7, name: "Agent 7" }],
    });
  }

  assert.equal(takePluginAgentTasks(7, 4).length, 4);
  assert.equal(hasQueuedPluginAgentTasks(7), true);
  assert.equal(takePluginAgentTasks(7, 4).length, 1);
  assert.equal(hasQueuedPluginAgentTasks(7), false);
});

test("reports queue, Agent, and end-to-end task timings", () => {
  const group = enqueuePluginAgentTaskGroup({
    pluginId: "demo-plugin",
    pluginVersion: "2.2.0",
    actionId: "save-node",
    intent: "write",
    executor: "script",
    workingDirectory: "/var/lib/forwardx-agent/plugins/demo-plugin",
    entry: "run.sh",
    hosts: [{ id: 7, name: "Agent 7" }],
  });
  const task = takePluginAgentTasks(7, 1)[0];
  assert.ok(task);
  assert.equal(completePluginAgentTask(7, {
    taskId: task.taskId,
    groupId: task.groupId,
    pluginId: task.pluginId,
    actionId: task.actionId,
    success: true,
    data: { id: "node-1" },
    durationMs: 37,
  }), true);

  const result = getPluginAgentTaskGroup(group.groupId)?.results[0];
  assert.equal(result?.intent, "write");
  assert.equal(result?.agentDurationMs, 37);
  assert.ok((result?.queueDurationMs ?? -1) >= 0);
  assert.ok((result?.endToEndDurationMs ?? -1) >= (result?.queueDurationMs ?? 0));
  assert.ok(result?.queuedAt);
  assert.ok(result?.dispatchedAt);
  assert.ok(result?.completedAt);
});

test("promotes structured stdout errors reported by older Agents", () => {
  const group = enqueuePluginAgentTaskGroup({
    pluginId: "demo-plugin",
    pluginVersion: "2.2.0",
    actionId: "save-node",
    intent: "write",
    executor: "script",
    workingDirectory: "/var/lib/forwardx-agent/plugins/demo-plugin",
    entry: "run.sh",
    hosts: [{ id: 7, name: "Agent 7" }],
  });
  const task = takePluginAgentTasks(7, 1)[0];
  assert.ok(task);
  completePluginAgentTask(7, {
    taskId: task.taskId,
    groupId: task.groupId,
    pluginId: task.pluginId,
    actionId: task.actionId,
    success: false,
    output: JSON.stringify({ error: "节点应用失败", suggestion: "检查服务端口", nodeId: 9 }),
    error: "exit status 1",
    exitCode: 1,
  });

  const result = getPluginAgentTaskGroup(group.groupId)?.results[0];
  assert.equal(result?.error, "节点应用失败");
  assert.equal(result?.advice, "检查服务端口");
  assert.equal(result?.processError, "exit status 1");
  assert.deepEqual(result?.data, { error: "节点应用失败", suggestion: "检查服务端口", nodeId: 9 });
});

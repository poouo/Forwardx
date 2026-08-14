import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueLookingGlassAgentTask,
  getLookingGlassAgentTaskStatus,
  pruneLookingGlassAgentTaskStates,
  takeLookingGlassAgentTasks,
} from "./lookingGlassAgentTasks";

test("timed-out Looking Glass tasks leave the queue and are eventually removed", async () => {
  const hostId = 987654;
  const { task } = enqueueLookingGlassAgentTask(hostId, {
    method: "ping",
    target: "example.com",
    resolvedAddress: "192.0.2.1",
    resolvedAddresses: ["192.0.2.1"],
    family: 4,
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = getLookingGlassAgentTaskStatus(hostId, task.taskId);
  assert.equal(status?.status, "timeout");
  assert.deepEqual(takeLookingGlassAgentTasks(hostId), []);

  const updatedAt = new Date(status!.updatedAt).getTime();
  assert.equal(pruneLookingGlassAgentTaskStates(updatedAt + 16 * 60 * 1000), 1);
  assert.equal(getLookingGlassAgentTaskStatus(hostId, task.taskId), null);
});

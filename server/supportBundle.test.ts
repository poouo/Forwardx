import assert from "node:assert/strict";
import test from "node:test";
import { createSupportBundleTask, getSupportBundleTask, redactSupportValue } from "./supportBundle";

test("support bundle redaction removes nested credentials", () => {
  const value = redactSupportValue({ token: "abc", nested: { password: "def", message: "token=ghi" } });
  assert.deepEqual(value, { token: "[REDACTED]", nested: { password: "[REDACTED]", message: "token=[REDACTED]" } });
});

test("support bundle completes immediately for offline Agents", async () => {
  const task = createSupportBundleTask([{ id: 9, name: "offline", isOnline: false, agentToken: "hidden" }]);
  const status = await getSupportBundleTask(task.taskId);
  assert.equal(status?.complete, true);
  assert.equal(status?.hosts[0]?.status, "offline");
  assert.ok(status?.download?.content.includes("forwardx-support-bundle-v1"));
  assert.ok(!status?.download?.content.includes("hidden"));
});

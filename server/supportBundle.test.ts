import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TUNNEL_PATHS } from "./agentEncryptionMiddleware";
import { createSupportBundleTask, getSupportBundleTask, redactSupportValue } from "./supportBundle";

test("Agent support and migration reports are accepted through the encrypted sync tunnel", () => {
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/support-bundle-result"), true);
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/migration-rollback"), true);
});

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

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildForwardxManageIntentPrompt,
  buildForwardxQueryIntentPrompt,
  forwardxCoreSkill,
  forwardxManageIntentResponseSchema,
  forwardxQueryIntentResponseSchema,
} from "./forwardxCore";
import { aiSkillRegistry } from "./registry";

test("registers the versioned ForwardX core skill and exposes read/write tools", () => {
  assert.deepEqual(aiSkillRegistry.get("forwardx-core"), forwardxCoreSkill);
  assert.ok(forwardxCoreSkill.tools.some((tool) => tool.mode === "read"));
  assert.ok(forwardxCoreSkill.tools.some((tool) => tool.mode === "write" && tool.requiresConfirmation));
  assert.match(buildForwardxQueryIntentPrompt(), /forwardx-core@1\.0\.0/);
  assert.match(buildForwardxManageIntentPrompt(), /rules\.manage/);
});

test("rejects unknown intents and actions before Telegram can execute them", () => {
  assert.equal(forwardxQueryIntentResponseSchema.safeParse({ intent: "shell", keyword: "x" }).success, false);
  assert.equal(forwardxManageIntentResponseSchema.safeParse({ action: "run_command", writeLike: true }).success, false);
  assert.equal(forwardxManageIntentResponseSchema.safeParse({ action: "rule_disable", ruleId: "12", writeLike: true }).success, true);
});

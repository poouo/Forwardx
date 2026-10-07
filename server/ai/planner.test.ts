import assert from "node:assert/strict";
import test from "node:test";
import { ForwardxAiClient } from "./client";
import { planBotOperation, botPlanSchema } from "./planner";
import { resolveForwardxAiSettings } from "./settings";

const settings = resolveForwardxAiSettings({ deepseekAiEnabled: "true", deepseekApiKey: "test-only" });
function mockClient(outputs: unknown[], bodies: any[] = []) {
  return new ForwardxAiClient({ fetchImpl: (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: JSON.stringify(outputs.shift()) } }] });
  }) as typeof fetch });
}
test("plans a concrete multi-step goal after permission-filtered observation", async () => {
  const bodies: any[] = [];
  const read: string[] = [];
  const plan = await planBotOperation({ text: "给张三充值并续费", settings, actorRole: "admin",
    client: mockClient([
      { kind: "context", goal: "充值并续费", confidence: 0.9, tools: [{ name: "users", keyword: "张三" }] },
      { kind: "manage", goal: "充值并续费", confidence: 0.9, actions: [{ action: "balance_adjust", target: "2" }, { action: "renew", target: "2" }] },
    ], bodies), readContext: async (tool) => { read.push(tool); return { items: [{ id: 2, name: "张三" }] }; } });
  assert.deepEqual(read, ["users"]);
  assert.equal(plan.kind, "manage");
  if (plan.kind === "manage") assert.equal(plan.actions.length, 2);
  assert.match(bodies[1].messages[2].content, /张三/);
});
test("never calls an admin-only context tool for ordinary users and bounds reasoning loops", async () => {
  let reads = 0;
  const context = { kind: "context", goal: "查询", confidence: 0.4, tools: [{ name: "users" }] };
  const bodies: any[] = [];
  const plan = await planBotOperation({ text: "用户", actorRole: "user", settings,
    client: mockClient([context, context, context], bodies), readContext: async () => { reads++; return []; } });
  assert.equal(reads, 0);
  assert.equal(bodies.length, 3);
  assert.equal(plan.kind, "clarify");
  assert.match(bodies[1].messages[2].content, /Permission denied/);
});
test("unknown tools, arbitrary commands and oversized plans are rejected", () => {
  assert.equal(botPlanSchema.safeParse({ kind: "context", goal: "x", confidence: 1, tools: [{ name: "shell" }] }).success, false);
  assert.equal(botPlanSchema.safeParse({ kind: "manage", goal: "x", confidence: 1, actions: [{ action: "run_command" }] }).success, false);
  assert.equal(botPlanSchema.safeParse({ kind: "manage", goal: "x", confidence: 1, actions: Array.from({ length: 7 }, () => ({ action: "renew" })) }).success, false);
});
test("low-confidence writes become clarification instead of executable plans", async () => {
  const plan = await planBotOperation({ text: "调一下", actorRole: "admin", settings,
    client: mockClient([{ kind: "manage", goal: "调整", confidence: 0.3, actions: [{ action: "balance_adjust", target: "2", amountYuan: 50 }] }]), readContext: async () => [] });
  assert.equal(plan.kind, "clarify");
});
test("plans settings switches as ordered, controlled operations and preserves read/write separation", async () => {
  const bodies: any[] = [];
  const plan = await planBotOperation({ text: "关闭插件，再打开多设备登录", actorRole: "admin", settings,
    client: mockClient([{ kind: "manage", goal: "关闭插件并允许多设备登录", confidence: 0.95, actions: [
      { action: "panel_operation", tool: "settings.set", input: { key: "pluginsEnabled", value: false } },
      { action: "panel_operation", tool: "settings.set", input: { key: "allowMultiDeviceLogin", value: true } },
    ] }], bodies), readContext: async () => [] });
  assert.equal(plan.kind, "manage");
  assert.match(bodies[0].messages[0].content, /pluginsEnabled/);
  assert.match(bodies[0].messages[0].content, /expiry.list/);
  let reads = 0;
  const query = await planBotOperation({ text: "插件开启了吗", actorRole: "admin", settings, client: mockClient([
    { kind: "context", goal: "查询", confidence: 0.9, tools: [{ name: "panel", tool: "settings.set", input: { key: "pluginsEnabled", value: true } }] },
    { kind: "query", goal: "查询插件状态", confidence: 0.9, query: { intent: "panel_query", tool: "settings.read", input: { keyword: "插件" } } },
  ]), readContext: async () => { reads++; return []; } });
  assert.equal(reads, 0, "context cannot invoke a write tool");
  assert.equal(query.kind, "query");
});

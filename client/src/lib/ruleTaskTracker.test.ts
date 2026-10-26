import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { configureRuleTasks, dismissRuleTask, registerRuleTask, ruleTaskScope, ruleTaskTracker, submitRuleTask, updateRuleTasks, waitForRuleTask } from "./ruleTaskTracker";
import type { RuleTaskSnapshot } from "../../../shared/ruleTaskQueue";

const snapshot = (): RuleTaskSnapshot => ({ id: randomUUID(), requestId: randomUUID(), title: "批量导入", state: "queued", total: 3,
  completed: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, queuePosition: 1, createdAt: Date.now() });
const done = (task: RuleTaskSnapshot): RuleTaskSnapshot => ({ ...task, state: "completed", completed: 3, succeeded: 3, finishedAt: Date.now(), results: [] });

test("tracker recovers same-tab jobs, isolates accounts, detects restart and never replays lost submissions", async () => {
  const saved = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  try {
    const first = snapshot();
    registerRuleTask(101, "instance-1", first);
    assert.equal(ruleTaskTracker.snapshot().length, 1);
    dismissRuleTask(first.id);
    assert.equal(ruleTaskTracker.snapshot().length, 1, "cannot dismiss unfinished work");
    configureRuleTasks(102);
    assert.equal(ruleTaskTracker.snapshot().length, 0);
    configureRuleTasks(101);
    assert.equal(ruleTaskTracker.snapshot()[0].task.id, first.id);
    updateRuleTasks(102, "instance-1", [first.id], [done(first)]);
    assert.equal(ruleTaskTracker.snapshot()[0].task.completed, 0);
    const lost = assert.rejects(waitForRuleTask(101, first.id), /丢失|过期/);
    updateRuleTasks(101, "instance-2", [first.id], [done(first)]);
    await lost;
    assert.equal(ruleTaskTracker.snapshot()[0].lost, true);
    dismissRuleTask(first.id);
    assert.equal(ruleTaskTracker.snapshot().length, 0);

    let submits = 0, lookups = 0;
    const next = snapshot();
    const submission = submitRuleTask({
      enqueue: async input => { submits++; assert.match(input.requestId, /^[\da-f]{32}$/); next.requestId = input.requestId; throw Error("response lost"); },
      lookup: async input => { lookups++; assert.equal(input.requestId, next.requestId); return { instanceId: "instance-2", task: next }; },
    }, 101, "批量导入", [], () => { queueMicrotask(() => updateRuleTasks(101, "instance-2", [next.id], [done(next)])); });
    assert.equal((await submission).succeeded, 3);
    assert.equal(submits, 1); assert.equal(lookups, 1);
    await assert.rejects(submitRuleTask({ enqueue: async () => { submits++; throw Error("offline"); }, lookup: async () => { throw Error("offline"); } }, 101, "批量导入", []), /暂无法确认.*不要重复提交/);
    assert.equal(submits, 2);

    const active = snapshot();
    registerRuleTask(101, "instance-2", active);
    for (let index = 0; index < 25; index++) registerRuleTask(101, "instance-2", done(snapshot()));
    assert.equal(ruleTaskTracker.snapshot().length, 20);
    assert.ok(ruleTaskTracker.snapshot().some(row => row.task.id === active.id), "finished history cannot evict unfinished work");
    assert.doesNotMatch(saved.get(`forwardx.ruleTasks:${ruleTaskScope(101)}`)!, /"results"|"actions"|"token"/);
    const missing = assert.rejects(waitForRuleTask(101, active.id), /丢失/);
    updateRuleTasks(101, "instance-2", [active.id], [null]);
    await missing;

    const previous = snapshot();
    registerRuleTask(103, "instance-2", previous);
    let accept!: (value: { instanceId: string; task: RuleTaskSnapshot }) => void;
    const later = snapshot();
    const switched = submitRuleTask({ enqueue: () => new Promise(resolve => { accept = resolve; }), lookup: async () => ({ instanceId: "instance-2", task: null }) }, 103, "批量导入", []);
    const switchedRejected = assert.rejects(switched, /原账号/);
    configureRuleTasks(104);
    accept({ instanceId: "instance-2", task: later });
    await switchedRejected;
    assert.equal(ruleTaskTracker.snapshot().length, 0);
    configureRuleTasks(103);
    assert.deepEqual(new Set(ruleTaskTracker.snapshot().map(row => row.task.id)), new Set([previous.id, later.id]));
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

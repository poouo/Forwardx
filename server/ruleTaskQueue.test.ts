import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RuleTaskAuthorizationError, RuleTaskQueue, type RuleTaskActor } from "./ruleTaskQueue";
import type { RuleTaskAction } from "../shared/ruleTaskQueue";

const actor = (userId = 1): RuleTaskActor => ({ userId, sid: "session", kind: "browser", dev: false, requestId: randomUUID() });
const actions = (count: number): RuleTaskAction[] => Array.from({ length: count }, (_, id) => ({ operation: "delete", input: { id }, conflictStrategy: "error" }));
const request = (count = 1) => ({ requestId: randomUUID(), title: "批量删除", actions: actions(count) });
async function finished(queue: RuleTaskQueue, userId: number, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const task = queue.get(userId, id);
    if (task?.finishedAt) return task;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw Error("queue did not finish");
}

test("one global executor rotates users fairly and reports independent outcomes without replaying writes", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const queue = new RuleTaskQueue(async (owner, action) => {
    active++; peak = Math.max(peak, active);
    order.push(`${owner.userId}:${action.input.id}`);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (action.input.id === 1) throw Error("write outcome unknown");
    return action.input.id === 2 ? { skipped: true } : { id: 10 };
  });
  const first = queue.enqueue(actor(), request(3));
  const second = queue.enqueue(actor(2), request(1));
  assert.equal(first.state, "queued");
  assert.equal(second.queuePosition, 2);
  const [a, b] = await Promise.all([finished(queue, 1, first.id), finished(queue, 2, second.id)]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["1:0", "2:0", "1:1", "1:2"]);
  assert.deepEqual([a.completed, a.succeeded, a.failed, a.skipped], [3, 1, 1, 1]);
  assert.equal(a.results?.[1].error, "write outcome unknown");
  assert.equal(b.succeeded, 1);
});

test("request IDs deduplicate accepted work, reject mismatched payloads and isolate ownership", async () => {
  let writes = 0;
  const queue = new RuleTaskQueue(async () => { writes++; return {}; });
  const input = request();
  const first = queue.enqueue(actor(), input);
  assert.equal(queue.enqueue(actor(), input).id, first.id);
  assert.throws(() => queue.enqueue(actor(), { ...input, title: "other" }), /同一提交标识/);
  assert.equal(queue.get(2, first.id), null);
  assert.equal(queue.lookup(2, input.requestId), null);
  assert.equal(queue.cancel(2, first.id), null);
  assert.equal(queue.lookup(1, input.requestId)?.id, first.id);
  input.actions[0].input.id = 999; // caller mutation must not change accepted work
  await finished(queue, 1, first.id);
  assert.equal(writes, 1);
  const snapshot = queue.get(1, first.id)!;
  snapshot.results![0].status = "failed";
  assert.equal(queue.get(1, first.id)!.results![0].status, "succeeded");
  assert.doesNotMatch(JSON.stringify(snapshot), /session|"input"|"actions"/);
});

test("cancellation finishes the current item and leaves the remainder explicitly unexecuted", async () => {
  let release!: () => void;
  let signal!: () => void;
  const entered = new Promise<void>(resolve => { signal = resolve; });
  const queue = new RuleTaskQueue(async () => { signal(); await new Promise<void>(r => { release = r; }); return {}; });
  const id = queue.enqueue(actor(), request(3)).id;
  await entered;
  queue.cancel(1, id);
  release();
  const task = await finished(queue, 1, id);
  assert.equal(task.state, "cancelled");
  assert.deepEqual([task.completed, task.succeeded, task.cancelled], [3, 1, 2]);
});

test("revoked identity stops a job without checking or executing every remaining item", async () => {
  let calls = 0;
  const queue = new RuleTaskQueue(async () => { calls++; throw new RuleTaskAuthorizationError("revoked"); });
  const task = await finished(queue, 1, queue.enqueue(actor(), request(30)).id);
  assert.equal(calls, 1);
  assert.equal(task.failed, 1);
  assert.equal(task.cancelled, 29);
});

test("queue caps reject excess work but never evict an accepted unfinished job", async () => {
  const queue = new RuleTaskQueue(async () => ({}), { maxUserJobs: 1, maxJobs: 2, maxPendingItems: 3 });
  const first = queue.enqueue(actor(), request(2));
  assert.throws(() => queue.enqueue(actor(), request()), /队列已满/);
  assert.throws(() => queue.enqueue(actor(2), request(2)), /队列已满/);
  const second = queue.enqueue(actor(2), request());
  assert.throws(() => queue.enqueue(actor(3), request()), /队列已满/);
  assert.ok(queue.get(1, first.id));
  await Promise.all([finished(queue, 1, first.id), finished(queue, 2, second.id)]);
  const next = queue.enqueue(actor(3), request());
  assert.equal(queue.get(1, first.id), null);
  await finished(queue, 3, next.id);
  const huge = request(); huge.actions[0].input.text = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => queue.enqueue(actor(), huge), /过大/);
});

test("expired results are removed and queued cancellation performs no writes", async () => {
  let calls = 0;
  const queue = new RuleTaskQueue(async () => { calls++; return {}; }, { retentionMs: 5 });
  const task = queue.enqueue(actor(), request(2));
  queue.cancel(1, task.id);
  assert.equal((await finished(queue, 1, task.id)).cancelled, 2);
  assert.equal(calls, 0);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(queue.get(1, task.id), null);
});

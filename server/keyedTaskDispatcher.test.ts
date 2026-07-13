import assert from "node:assert/strict";
import test from "node:test";
import { KeyedTaskDispatcher } from "./keyedTaskDispatcher";

test("keeps one chat ordered while unrelated chats run concurrently", async () => {
  const dispatcher = new KeyedTaskDispatcher(2);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = dispatcher.enqueue("chat:1", async () => {
    events.push("chat1-first-start");
    await gate;
    events.push("chat1-first-end");
  });
  const second = dispatcher.enqueue("chat:1", async () => {
    events.push("chat1-second");
  });
  const unrelated = dispatcher.enqueue("chat:2", async () => {
    events.push("chat2");
  });
  await unrelated;
  assert.deepEqual(events, ["chat1-first-start", "chat2"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["chat1-first-start", "chat2", "chat1-first-end", "chat1-second"]);
  assert.equal(dispatcher.pendingCount, 0);
});

test("releases the keyed queue after a failed task", async () => {
  const dispatcher = new KeyedTaskDispatcher(1);
  await assert.rejects(dispatcher.enqueue("chat:1", async () => { throw new Error("failed"); }), /failed/);
  const result = await dispatcher.enqueue("chat:1", async () => 42);
  assert.equal(result, 42);
  await dispatcher.waitForIdle();
  assert.equal(dispatcher.activeCount, 0);
});

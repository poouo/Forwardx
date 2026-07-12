import assert from "node:assert/strict";
import test from "node:test";
import { clearKeyedTaskLocksForTest, keyedTaskDepth, withKeyedTaskLock } from "./keyedTaskLock";

test.beforeEach(() => clearKeyedTaskLocksForTest());

test("serializes one resource while unrelated resources run concurrently", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withKeyedTaskLock("rule:1", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = withKeyedTaskLock("rule:1", async () => {
    events.push("second-start");
  });
  const unrelated = withKeyedTaskLock("rule:2", async () => {
    events.push("unrelated");
  });

  await unrelated;
  assert.equal(keyedTaskDepth("rule:1"), 2);
  assert.deepEqual(events, ["first-start", "unrelated"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "unrelated", "first-end", "second-start"]);
  assert.equal(keyedTaskDepth("rule:1"), 0);
});

test("releases the queue after a task fails", async () => {
  await assert.rejects(
    withKeyedTaskLock("tunnel:9", async () => { throw new Error("failed"); }),
    /failed/,
  );
  const value = await withKeyedTaskLock("tunnel:9", async () => 42);
  assert.equal(value, 42);
  assert.equal(keyedTaskDepth("tunnel:9"), 0);
});

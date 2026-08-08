import assert from "node:assert/strict";
import test from "node:test";
import {
  clearKeyedTaskLocksForTest,
  keyedTaskDepth,
  withKeyedTaskLock,
  withTrafficBillingUserLock,
} from "./keyedTaskLock";

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

test("traffic billing user locks are reentrant without bypassing unrelated callers", async () => {
  const events: string[] = [];
  let releaseOuter!: () => void;
  const outerGate = new Promise<void>((resolve) => { releaseOuter = resolve; });

  const outer = withTrafficBillingUserLock(7, async () => {
    events.push("outer-start");
    await withTrafficBillingUserLock(7, async () => {
      events.push("nested");
    });
    await outerGate;
    events.push("outer-end");
  });
  const queued = withTrafficBillingUserLock(7, async () => {
    events.push("queued");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(keyedTaskDepth("traffic-billing-user:7"), 2);
  assert.deepEqual(events, ["outer-start", "nested"]);
  releaseOuter();
  await Promise.all([outer, queued]);
  assert.deepEqual(events, ["outer-start", "nested", "outer-end", "queued"]);
});

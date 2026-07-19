import assert from "node:assert/strict";
import test from "node:test";
import { chunkBatchItems, isBatchPortConflictError, runBatchOperations } from "./batchOperations";

test("batch operations keep order, limit concurrency, and retain individual failures", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await runBatchOperations([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 5 : 1));
    active -= 1;
    if (value === 3) throw new Error("three failed");
    return value * 10;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(results[0].status === "fulfilled" ? results[0].value : 0, 10);
  assert.match(results[2].status === "rejected" ? String(results[2].reason) : "", /three failed/);
  assert.equal(results[4].status === "fulfilled" ? results[4].value : 0, 50);
});

test("only port allocation failures use batch conflict handling", () => {
  assert.equal(isBatchPortConflictError(new Error("端口 10001 已被其他规则占用")), true);
  assert.equal(isBatchPortConflictError(new Error("Entry agent port 10001 is already used")), true);
  assert.equal(isBatchPortConflictError(new Error("Port 10001 is already used or being allocated")), true);
  assert.equal(isBatchPortConflictError(new Error("无权使用该转发组")), false);
  assert.equal(isBatchPortConflictError(new Error("主机不存在")), false);
});

test("batch item chunking preserves every item", () => {
  assert.deepEqual(chunkBatchItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkBatchItems([1, 2], 0), [[1], [2]]);
  assert.deepEqual(chunkBatchItems([], 500), []);
});

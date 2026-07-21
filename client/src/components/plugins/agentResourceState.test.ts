import assert from "node:assert/strict";
import test from "node:test";
import {
  failedResourceSnapshot,
  hydrateCachedResourceSnapshot,
  optimisticResourceData,
  pluginTaskFailureInfo,
} from "./agentResourceState";

test("extracts structured plugin errors before the process exit error", () => {
  const failure = pluginTaskFailureInfo({
    status: "error",
    error: "exit status 1",
    output: JSON.stringify({ 错误信息: "省份白名单应用失败", 处理建议: "检查 nftables", hostId: 7 }),
  });

  assert.equal(failure.message, "省份白名单应用失败");
  assert.equal(failure.advice, "检查 nftables");
  assert.equal(failure.processError, "exit status 1");
  assert.match(failure.detail, /hostId: 7/);
});

test("optimistically creates, updates, and deletes nested resource rows", () => {
  const initial = { items: [{ id: "a", name: "old" }] };
  const created = optimisticResourceData({
    data: initial,
    itemsPath: "items",
    rowKey: "id",
    kind: "create",
    form: { name: "new" },
    resultData: { success: true, message: "saved", item: { id: "b", active: true } },
  }) as any;
  assert.deepEqual(created.items, [
    { id: "a", name: "old" },
    { id: "b", name: "new", active: true },
  ]);

  const updated = optimisticResourceData({
    data: created,
    itemsPath: "items",
    rowKey: "id",
    kind: "update",
    currentRow: created.items[0],
    form: { id: "a", name: "edited" },
    resultData: { item: { online: true } },
  }) as any;
  assert.deepEqual(updated.items[0], { id: "a", name: "edited", online: true });

  const deleted = optimisticResourceData({
    data: updated,
    itemsPath: "items",
    rowKey: "id",
    kind: "delete",
    currentRow: updated.items[1],
  }) as any;
  assert.deepEqual(deleted.items, [{ id: "a", name: "edited", online: true }]);
});

test("failed refresh preserves the last successful source data", () => {
  const previous = { data: { items: [{ id: 1 }] }, loadedAt: 100 };
  const failed = failedResourceSnapshot(previous, {
    message: "Agent timeout",
    advice: "Retry later",
    detail: "hostId: 7",
  }, 200);

  assert.equal(failed.data, previous.data);
  assert.equal(failed.loadedAt, 100);
  assert.equal(failed.failedAt, 200);
  assert.equal(failed.error, "Agent timeout");
});

test("hydrates an empty resource view from the last Agent result without replacing fresher data", () => {
  const cached = { items: [{ id: "whitelist", ruleCount: 3685 }] };
  const hydrated = hydrateCachedResourceSnapshot(undefined, cached, "2026-07-21T15:30:00.000Z");
  assert.equal(hydrated?.data, cached);
  assert.equal(hydrated?.loadedAt, Date.parse("2026-07-21T15:30:00.000Z"));

  const current = { data: { items: [{ id: "whitelist", ruleCount: 3690 }] }, loadedAt: Date.now() };
  assert.equal(hydrateCachedResourceSnapshot(current, cached), current);
});

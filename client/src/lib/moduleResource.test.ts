import assert from "node:assert/strict";
import test from "node:test";
import { createModuleResource } from "./moduleResource";
import { canPrefetchClientRoute, clientRoutes, resolveClientRoute } from "../../../shared/clientRoutes";

test("route modules deduplicate imports and keep stable snapshots until a change", async () => {
  let resolve!: (value: { default: string }) => void;
  let calls = 0;
  const resource = createModuleResource(() => { calls++; return new Promise<{ default: string }>(done => { resolve = done; }); });
  const states: string[] = [];
  const unsubscribe = resource.subscribe(() => states.push(resource.getSnapshot().status));
  assert.equal(resource.getSnapshot(), resource.getSnapshot());
  const first = resource.load();
  assert.equal(resource.load(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ default: "Page" });
  await first;
  assert.equal(resource.getSnapshot().value?.default, "Page");
  await resource.load();
  assert.equal(calls, 1);
  assert.deepEqual(states, ["loading", "ready"]);
  unsubscribe();
});

test("a failed or synchronously throwing import can be retried without stale rejection", async () => {
  let calls = 0;
  const resource = createModuleResource(async () => {
    if (++calls === 1) throw new Error("offline");
    return "recovered";
  });
  await resource.load();
  assert.equal(resource.getSnapshot().status, "error");
  await resource.load();
  assert.equal(resource.getSnapshot().status, "ready");
  assert.equal(resource.getSnapshot().value, "recovered");
  const throwing = createModuleResource(() => { throw new Error("synchronous"); });
  await throwing.load();
  assert.equal(throwing.getSnapshot().status, "error");
});

test("path resolution covers known pages, dynamic IDs, query/hash and excludes public monitor paths", () => {
  for (const route of clientRoutes) {
    const path = route.path + ("prefix" in route ? "123" : "");
    assert.equal(resolveClientRoute(path + "?tab=x#details")?.page, route.page);
  }
  for (const path of ["/404", "/dev", "/session-wait", "/custom-pages/", "/plugins/sidebar/1/extra", "https://example.com/hosts"]) {
    assert.equal(resolveClientRoute(path), undefined);
  }
});

test("intent prefetch never imports administrator routes for ordinary or anonymous users", () => {
  for (const route of clientRoutes) {
    const path = route.path + ("prefix" in route ? "1" : "");
    assert.equal(canPrefetchClientRoute(path, "admin"), true);
    if ("admin" in route) {
      assert.equal(canPrefetchClientRoute(path, "user"), false);
      assert.equal(canPrefetchClientRoute(path), false);
    }
  }
  assert.equal(canPrefetchClientRoute("/rules", "user"), true);
  assert.equal(canPrefetchClientRoute("/rules"), false);
});

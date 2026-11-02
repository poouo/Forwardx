import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { IdleResourceCache } from "./idleResourceCache";

test("idle resources are lazy, share concurrent loads and stay alive during work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  let finishLoad!: (value: object) => void;
  let finishWork!: () => void;
  const cache = new IdleResourceCache(async () => {
    loads++;
    return new Promise<object>(resolve => { finishLoad = resolve; });
  }, 100);
  assert.equal(loads, 0);
  const value = {};
  const first = cache.use(4, async resource => {
    assert.equal(resource, value);
    await new Promise<void>(resolve => { finishWork = resolve; });
  });
  const second = cache.use(4, resource => resource);
  await Promise.resolve();
  assert.equal(loads, 1);
  t.mock.timers.tick(1000); // Loading has no eviction timer.
  finishLoad(value);
  assert.equal(await second, value);
  t.mock.timers.tick(1000); // One lookup is still active.
  assert.equal(await cache.use(4, resource => resource), value);
  assert.equal(loads, 1);
  finishWork();
  await first;
});

test("expiry starts after the last lookup, resets on reuse and is per family", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const loads = new Map<number, number>();
  const cache = new IdleResourceCache(async (key: number) => {
    loads.set(key, (loads.get(key) || 0) + 1);
    return {};
  }, 100);
  const v4 = await cache.use(4, value => value);
  t.mock.timers.tick(70);
  const v6 = await cache.use(6, value => value);
  assert.equal(await cache.use(4, value => value), v4);
  t.mock.timers.tick(99);
  assert.equal(await cache.use(6, value => value), v6); // Reset only IPv6.
  t.mock.timers.tick(1);
  assert.notEqual(await cache.use(4, value => value), v4);
  assert.equal(await cache.use(6, value => value), v6);
  assert.deepEqual([...loads], [[4, 2], [6, 1]]);
});

test("a failed load is retryable, but a lookup failure does not poison the resource", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  const cache = new IdleResourceCache(async () => {
    if (++loads === 1) throw new Error("missing asset");
    return {};
  }, 100);
  const failures = await Promise.allSettled([cache.use(4, v => v), cache.use(4, v => v)]);
  assert.ok(failures.every(result => result.status === "rejected"));
  assert.equal(loads, 1);
  const value = await cache.use(4, v => v);
  await assert.rejects(cache.use(4, () => { throw new Error("bad lookup"); }), /bad lookup/);
  assert.equal(await cache.use(4, v => v), value);
  assert.equal(loads, 2);
  t.mock.timers.tick(100);
  assert.notEqual(await cache.use(4, v => v), value);
  assert.equal(loads, 3);
});

test("idle resource timers do not keep a stopped panel alive", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { IdleResourceCache } from "./server/idleResourceCache.ts";
    await new IdleResourceCache(async () => ({}), 60_000).use(4, () => {});
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

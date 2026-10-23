import assert from "node:assert/strict";
import test from "node:test";
import { createQueryCache } from "./queryCache";
import { createDisplayQueryCache } from "./displayQueryCache";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const timing = { ttlMs: 100, staleMs: 200 };
const user = { id: 1, role: "user" };

test("cold bursts and expired bursts each execute one loader", async () => {
  let now = 0, calls = 0;
  const cache = createQueryCache({ now: () => now });
  let load = deferred<number>();
  const loader = () => { calls++; return load.promise; };
  const requests = Array.from({ length: 100 }, () => cache.get("one", timing, loader));
  await tick(); assert.equal(calls, 1);
  load.resolve(10);
  assert.deepEqual(await Promise.all(requests), Array(100).fill(10));
  now = 101; load = deferred<number>();
  assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => cache.get("one", timing, loader))), Array(100).fill(10));
  assert.equal(calls, 2, "stale reads do not wait for the one refresh");
  now = 400;
  const expired = cache.get("one", timing, loader);
  load.resolve(20); assert.equal(await expired, 20);
  assert.equal(calls, 2);
});

test("invalidate cannot resurrect old results or remove replacement loads", async () => {
  const cache = createQueryCache();
  const old = deferred<number>(), fresh = deferred<number>();
  const a = cache.get("one", timing, () => old.promise);
  cache.clear();
  const b = cache.get("one", timing, () => fresh.promise);
  old.resolve(1); assert.equal(await a, 1);
  fresh.resolve(2); assert.equal(await b, 2);
  assert.equal(await cache.get("one", timing, async () => 3), 2);
  cache.clear();
  const failed = deferred<number>();
  const failure = cache.get("one", timing, () => failed.promise);
  cache.clear();
  await cache.get("one", timing, async () => 4);
  failed.reject(new Error("old failure")); await assert.rejects(failure);
  assert.equal(await cache.get("one", timing, async () => 5), 4);
});

test("sync exceptions recover; failed refresh has a cooldown but never extends stale validity", async () => {
  let now = 0, calls = 0;
  const cache = createQueryCache({ now: () => now, retryMs: 50 });
  await assert.rejects(cache.get("one", timing, () => { throw new Error("sync"); }));
  await cache.get("one", timing, async () => 1);
  const failure = async () => { calls++; throw new Error("offline"); };
  now = 101;
  assert.equal(await cache.get("one", timing, failure), 1);
  await tick();
  now = 120;
  assert.equal(await cache.get("one", timing, failure), 1);
  assert.equal(calls, 1);
  now = 301;
  await assert.rejects(cache.get("one", timing, failure), /offline/);
  assert.equal(calls, 2);
});

test("entry/byte budgets, LRU and pending registrations stay bounded", async () => {
  const cache = createQueryCache({ maxEntries: 2, maxBytes: 20, sizeOf: (v) => String(v).length });
  await cache.get("a", timing, async () => "123");
  await cache.get("b", timing, async () => "456");
  await cache.get("a", timing, async () => "bad");
  await cache.get("c", timing, async () => "789");
  assert.equal(cache.size(), 2);
  assert.equal(await cache.get("a", timing, async () => "bad"), "123");
  await cache.get("large", timing, async () => "x".repeat(30));
  assert.ok(cache.bytes() <= 20);
  assert.equal(await cache.get("a", timing, async () => "bad"), "123");
  const pending = createQueryCache(1), load = deferred<number>();
  const first = pending.get("a", timing, () => load.promise);
  await assert.rejects(pending.get("b", timing, async () => 2), /busy/);
  load.resolve(1); await first;
  assert.equal(pending.size(), 1);
});

test("display keys isolate users, roles, filters and admin own/all", async () => {
  const cache = createDisplayQueryCache();
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.get(user, "page", { scope: "self" }, load), 1);
  assert.equal(await cache.get(user, "page", { scope: "self" }, load), 1);
  assert.equal(await cache.get({ ...user, id: 2 }, "page", { scope: "self" }, load), 2);
  assert.equal(await cache.get({ ...user, role: "admin" }, "page", { scope: "self" }, load), 3);
  assert.equal(await cache.get({ ...user, role: "admin" }, "page", { scope: "all" }, load), 4);
  assert.equal(await cache.get(user, "page", { scope: "self", search: "a" }, load), 5);
  cache.invalidate(user);
  assert.equal(await cache.get({ ...user, id: 2 }, "page", { scope: "self" }, load), 2);
  assert.equal(await cache.get(user, "page", { scope: "self" }, load), 6);
  assert.equal(await cache.get({ ...user, role: "admin" }, "page", { scope: "all" }, load), 7);
  cache.invalidate(); assert.equal(cache.stats().entries, 0);
});

test("overload bounds active work, queue length and wait; underlying SQL keeps its slot", async () => {
  const cache = createDisplayQueryCache({ concurrency: 1, maxQueued: 1, queueTimeoutMs: 25 });
  const slow = deferred<number>();
  const first = cache.get(user, "slow", {}, () => slow.promise);
  await tick();
  const queued = cache.get(user, "queued", {}, async () => 2);
  const rejectedQueue = assert.rejects(queued, { code: "SERVICE_UNAVAILABLE" });
  await assert.rejects(cache.get(user, "overflow", {}, async () => 3), { code: "SERVICE_UNAVAILABLE" });
  await rejectedQueue;
  assert.equal(cache.stats().active, 1);
  assert.equal(cache.stats().queued, 0);
  slow.resolve(1); assert.equal(await first, 1);
  assert.equal(await cache.get(user, "recovered", {}, async () => 4), 4);
});

test("shared physical metrics canonicalize IDs and keep all/empty distinct", async () => {
  const cache = createDisplayQueryCache();
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await cache.metrics("traffic", [2, 1, 1], load), 1);
  assert.equal(await cache.metrics("traffic", [1, 2], load), 1);
  assert.equal(await cache.metrics("traffic", [], load), 2);
  assert.equal(await cache.metrics("traffic", undefined, load), 3);
  cache.invalidate(user);
  assert.equal(await cache.metrics("traffic", [1, 2], load), 4);
});

test("expired entries are reclaimed with a paced sweep", async () => {
  let now = 0;
  const cache = createQueryCache({ now: () => now });
  await cache.get("old", timing, async () => "old");
  now = 1001;
  await cache.get("new", timing, async () => "new");
  assert.equal(cache.size(), 1);
});

test("queued loads resume in order and coalesced callers do not consume queue slots", async () => {
  const cache = createDisplayQueryCache({ concurrency: 1, maxQueued: 1 });
  const slow = deferred<number>();
  const a = cache.get(user, "slow", {}, () => slow.promise);
  await tick();
  let calls = 0;
  const queued = Array.from({ length: 100 }, () => cache.get(user, "next", {}, async () => ++calls));
  await tick();
  assert.equal(cache.stats().queued, 1);
  slow.resolve(10); await a;
  assert.deepEqual(await Promise.all(queued), Array(100).fill(1));
  assert.equal(calls, 1);
  assert.equal(cache.stats().active, 0);
});

test("stale display reads stay available while the read pool is busy", async () => {
  let now = 0;
  const cache = createDisplayQueryCache({ concurrency: 1, maxQueued: 1, now: () => now });
  await cache.get(user, "cached", {}, async () => 1, timing);
  const slow = deferred<number>();
  const blocking = cache.get(user, "blocking", {}, () => slow.promise);
  await tick(); now = 101;
  assert.equal(await cache.get(user, "cached", {}, async () => 2, timing), 1);
  await tick();
  assert.equal(cache.stats().active, 1);
  assert.equal(cache.stats().queued, 1);
  slow.resolve(10); await blocking; await tick();
  assert.equal(await cache.get(user, "cached", {}, async () => 3, timing), 2);
});

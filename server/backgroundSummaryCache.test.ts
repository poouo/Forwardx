import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundSummaryCache } from "./backgroundSummaryCache";

test("summaries isolate users, coalesce cold requests and refresh only in background", async () => {
  let now = 0, calls = 0;
  const cache = createBackgroundSummaryCache({ now: () => now, refreshMs: 60_000 });
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get("1:stats", load), cache.get("1:stats", load)]), [1, 1]);
  assert.equal(await cache.get("2:stats", load), 2);
  now = 61_000;
  assert.equal(await cache.get("1:stats", load), 1, "stale reads must not trigger work in HTTP requests");
  assert.equal(calls, 2);
  assert.deepEqual(await cache.refreshDue(), { refreshed: 2, failed: 0 });
  const first = await cache.get("1:stats", load);
  const second = await cache.get("2:stats", load);
  assert.deepEqual([first, second].sort(), [3, 4]);
  cache.clear([1]);
  assert.equal(await cache.get("1:stats", load), 5);
  assert.equal(await cache.get("2:stats", load), second);
});

test("failed refresh retains last success, backs off and never overlaps", async () => {
  let now = 0;
  const cache = createBackgroundSummaryCache({ now: () => now, refreshMs: 100 });
  await cache.get("1:stats", async () => 10);
  now = 101;
  await cache.get("1:stats", async () => { throw new Error("offline"); });
  assert.deepEqual(await cache.refreshDue(), { refreshed: 0, failed: 1 });
  assert.equal(await cache.get("1:stats", async () => 20), 10);
  assert.deepEqual(await cache.refreshDue(), { refreshed: 0, failed: 0 });
  now += 30_001;
  let release!: (value: number) => void;
  await cache.get("1:stats", () => new Promise<number>((resolve) => { release = resolve; }));
  const pass = cache.refreshDue();
  await Promise.resolve();
  assert.deepEqual(await cache.refreshDue(), { refreshed: 0, failed: 0 });
  release(20);
  await pass;
  assert.equal(await cache.get("1:stats", async () => 30), 20);
});

test("invalidation cannot resurrect pending work; LRU, byte and idle bounds apply", async () => {
  let now = 0;
  const cache = createBackgroundSummaryCache({ now: () => now, maxEntries: 2, maxBytes: 1024, idleMs: 100 });
  let release!: (value: string) => void;
  const pending = cache.get("1:stats", () => new Promise<string>((resolve) => { release = resolve; }));
  await Promise.resolve();
  cache.clear([1]);
  release("obsolete"); await pending;
  assert.equal(cache.size().entries, 0);
  await cache.get("1:stats", async () => "a");
  await cache.get("2:stats", async () => "b");
  await cache.get("1:stats", async () => "unused");
  await cache.get("3:stats", async () => "c");
  assert.equal(cache.size().entries, 2);
  assert.equal(await cache.get("2:stats", async () => "recomputed"), "recomputed");
  await cache.get("4:huge", async () => "x".repeat(2048));
  assert.ok(cache.size().bytes <= 1024);
  await cache.get("1:stats", async () => "a");
  now = 101;
  await cache.refreshDue();
  assert.deepEqual(cache.size(), { entries: 0, bytes: 0 });
  await assert.rejects(cache.get("1:fail", async () => { throw new Error("cold failure"); }));
  assert.equal(cache.size().entries, 0);
});

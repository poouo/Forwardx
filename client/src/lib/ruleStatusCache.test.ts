import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRuleStatusSnapshots,
  readRuleStatusSnapshot,
  readRuleStatusSnapshots,
  writeRuleStatusSnapshot,
  writeRuleStatusSnapshots,
} from "./ruleStatusCache";

type StorageMap = Map<string, string>;

function installStorage(options: { throwOnSet?: boolean } = {}) {
  const values: StorageMap = new Map();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.throwOnSet) throw new Error("quota exceeded");
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  } as Storage;
  const previousWindow = (globalThis as any).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return {
    values,
    restore() {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    },
  };
}

test("writes and reads normalized snapshots by user and rule", () => {
  const userId = `status-cache-${Date.now()}-one`;
  clearRuleStatusSnapshots(userId);
  assert.equal(writeRuleStatusSnapshot(userId, "42", {
    state: "RUNNING" as any,
    title: "running",
    updatedAt: 1_700_000_000,
  }), true);
  assert.deepEqual(readRuleStatusSnapshot(userId, 42), {
    state: "running",
    title: "running",
    updatedAt: 1_700_000_000_000,
  });
  assert.equal(readRuleStatusSnapshot(`${userId}-other`, 42), null);
  clearRuleStatusSnapshots(userId);
});

test("batch writes reject invalid IDs and preserve newer snapshots", () => {
  const userId = `status-cache-${Date.now()}-two`;
  clearRuleStatusSnapshots(userId);
  const written = writeRuleStatusSnapshots(userId, [
    [1, { state: "running", title: "new", updatedAt: 2000 }],
    [2, { state: "error", title: "failed", updatedAt: 1000 }],
    [0, { state: "pending", title: "ignored", updatedAt: 3000 }],
  ]);
  assert.equal(written, 2);
  assert.equal(writeRuleStatusSnapshot(userId, 1, { state: "pending", title: "old", updatedAt: 1999 }), false);
  assert.deepEqual([...readRuleStatusSnapshots(userId).keys()].sort((a, b) => a - b), [1, 2]);
  assert.equal(readRuleStatusSnapshot(userId, 1)?.title, "new");
  clearRuleStatusSnapshots(userId);
});

test("localStorage snapshots survive a fresh module cache lookup and selected cleanup", () => {
  const env = installStorage();
  const userId = `status-cache-${Date.now()}-storage`;
  try {
    clearRuleStatusSnapshots(userId);
    assert.equal(writeRuleStatusSnapshot(userId, 7, {
      state: "running",
      title: "stored",
      updatedAt: 1_800_000_000_000,
    }), true);
    const key = Array.from(env.values.keys()).find((item) => item.includes(encodeURIComponent(userId)));
    assert.ok(key);
    assert.match(env.values.get(key!) || "", /stored/);
    assert.equal(clearRuleStatusSnapshots(userId, [7]), 1);
    assert.equal(env.values.has(key!), false);
  } finally {
    clearRuleStatusSnapshots(userId);
    env.restore();
  }
});

test("malformed or unavailable storage never breaks the memory fallback", () => {
  const env = installStorage({ throwOnSet: true });
  const userId = `status-cache-${Date.now()}-broken`;
  try {
    const key = `forwardx.rules.visualStatus.v1.${encodeURIComponent(userId)}`;
    env.values.set(key, "{not-json");
    assert.equal(writeRuleStatusSnapshot(userId, 9, { state: "pending", title: "memory", updatedAt: 10 }), true);
    assert.equal(readRuleStatusSnapshot(userId, 9)?.title, "memory");
  } finally {
    clearRuleStatusSnapshots(userId);
    env.restore();
  }
});

test("selective cleanup loads and updates a persisted cache before memory is populated", () => {
  const env = installStorage();
  const userId = `status-cache-${Date.now()}-persisted-cleanup`;
  const key = `forwardx.rules.visualStatus.v1.${encodeURIComponent(userId)}`;
  env.values.set(key, JSON.stringify({
    version: 1,
    entries: {
      21: { state: "running", title: "remove", updatedAt: 1000 },
      22: { state: "error", title: "keep", updatedAt: 2000 },
    },
  }));
  try {
    assert.equal(clearRuleStatusSnapshots(userId, [21]), 1);
    assert.equal(readRuleStatusSnapshot(userId, 21), null);
    assert.equal(readRuleStatusSnapshot(userId, 22)?.title, "keep");
  } finally {
    clearRuleStatusSnapshots(userId);
    env.restore();
  }
});

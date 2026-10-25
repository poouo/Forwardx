import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  appendJsonLog,
  clearJsonLogFile,
  flushJsonLogWrites,
  pruneJsonLogFile,
  readRecentJsonLogPageAsync,
} from "./logFileStore";

test("JSON logs batch writes without losing order and serialize maintenance", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-"));
  const filePath = path.join(dir, "panel.jsonl");
  try {
    appendJsonLog(filePath, { id: "old", level: "info", message: "old", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    appendJsonLog(filePath, { id: "first", level: "info", message: "first", createdAt: new Date().toISOString() });
    appendJsonLog(filePath, { id: "second", level: "warn", message: "second", createdAt: new Date().toISOString() });
    await flushJsonLogWrites(filePath);

    const rawLines = (await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(rawLines.map((line) => JSON.parse(line).id), ["old", "first", "second"]);

    const page = await readRecentJsonLogPageAsync(filePath, { limit: 10 });
    assert.deepEqual(page.logs.map((entry) => entry.id), ["second", "first"]);
    await pruneJsonLogFile(filePath);
    assert.deepEqual((await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line).id), ["first", "second"]);

    appendJsonLog(filePath, { id: "before-clear", level: "info", message: "pending", createdAt: new Date().toISOString() });
    await clearJsonLogFile(filePath);
    assert.equal(await fs.promises.readFile(filePath, "utf8"), "");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("append, prune, and clear operations preserve call order under concurrency", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-order-"));
  const filePath = path.join(dir, "panel.jsonl");
  const entry = (id: string) => ({ id, level: "info", message: id, createdAt: new Date().toISOString() });
  try {
    appendJsonLog(filePath, entry("before-prune"));
    const pruning = pruneJsonLogFile(filePath);
    appendJsonLog(filePath, entry("before-clear"));
    const clearing = clearJsonLogFile(filePath);
    appendJsonLog(filePath, entry("after-clear"));

    await Promise.all([pruning, clearing]);
    await flushJsonLogWrites(filePath);
    const page = await readRecentJsonLogPageAsync(filePath, { limit: 10 });
    assert.deepEqual(page.logs.map((item) => item.id), ["after-clear"]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

for (const mode of ["bytes", "entries"] as const) {
  test(`slow log writes include queued operations in the ${mode} budget and recover`, async (t) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-budget-"));
    const filePath = path.join(dir, "panel.jsonl");
    const originalAppend = fs.promises.appendFile;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    let bytes = 0;
    let entries = 0;
    const warnings: string[] = [];
    t.mock.method(process.stderr, "write", (message: unknown) => { warnings.push(String(message)); return true; });
    t.mock.method(fs.promises, "appendFile", async (...args: Parameters<typeof originalAppend>) => {
      if (String(args[0]) === filePath) {
        writes++;
        const content = String(args[1]);
        bytes += Buffer.byteLength(content);
        entries += content.trim().split("\n").length;
        if (writes === 1) await blocked;
      }
      return originalAppend(...args);
    });
    try {
      const message = mode === "bytes" ? "x".repeat(256 * 1024) : "small";
      const rounds = mode === "bytes" ? 64 : 30;
      const batch = mode === "bytes" ? 1 : 500;
      for (let round = 0; round < rounds; round++) {
        for (let index = 0; index < batch; index++) {
          appendJsonLog(filePath, { id: round * batch + index, level: "info", message, createdAt: new Date().toISOString() });
        }
        // Each turn transfers another batch out of the pending buffer while
        // the very first filesystem write is still blocked.
        await nextTurn();
      }
      assert.equal(writes, 1);
      const flushing = flushJsonLogWrites(filePath);
      release();
      await flushing;
      assert.ok(bytes <= 4 * 1024 * 1024, `queued log payload exceeded budget: ${bytes}`);
      assert.ok(entries <= 10_000, `queued log entries exceeded budget: ${entries}`);
      assert.ok(warnings.some((message) => message.includes("log write backlog capped")));
      if (mode === "bytes") assert.ok(bytes > 3 * 1024 * 1024);
      else assert.equal(entries, 10_000);

      appendJsonLog(filePath, { id: "recovered", level: "info", message: "disk recovered", createdAt: new Date().toISOString() });
      await flushJsonLogWrites(filePath);
      const page = await readRecentJsonLogPageAsync(filePath, { limit: 1 });
      assert.equal(page.logs[0]?.id, "recovered", "released write budget must accept new logs");
    } finally {
      release();
      await flushJsonLogWrites(filePath);
      t.mock.restoreAll();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
}

test("dropping an oversized queued append releases evicted pending bytes", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-evict-"));
  const filePath = path.join(dir, "panel.jsonl");
  const originalAppend = fs.promises.appendFile;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(fs.promises, "appendFile", async (...args: Parameters<typeof originalAppend>) => {
    if (String(args[0]) === filePath && ++writes === 1) await blocked;
    return originalAppend(...args);
  });
  const entry = (id: string, bytes: number) => ({ id, level: "info", message: "x".repeat(bytes), createdAt: new Date().toISOString() });
  try {
    appendJsonLog(filePath, entry("writing", 3 * 1024 * 1024));
    await nextTurn();
    appendJsonLog(filePath, entry("evicted", 750 * 1024));
    appendJsonLog(filePath, entry("cannot-fit", 2 * 1024 * 1024));
    appendJsonLog(filePath, entry("fits-after-eviction", 800 * 1024));
    const flushing = flushJsonLogWrites(filePath);
    release();
    await flushing;
    const page = await readRecentJsonLogPageAsync(filePath, { limit: 10 });
    assert.deepEqual(page.logs.map((item) => item.id), ["fits-after-eviction", "writing"]);
  } finally {
    release();
    await flushJsonLogWrites(filePath);
    t.mock.restoreAll();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("failed log writes release the queued budget", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-failure-"));
  const filePath = path.join(dir, "panel.jsonl");
  const entry = (id: string) => ({ id, level: "info", message: "x".repeat(3 * 1024 * 1024), createdAt: new Date().toISOString() });
  try {
    t.mock.method(fs.promises, "appendFile", async () => { throw new Error("mock disk failure"); });
    t.mock.method(fs, "appendFileSync", () => { throw new Error("mock disk failure"); });
    t.mock.method(process.stderr, "write", () => true);
    appendJsonLog(filePath, entry("failed"));
    await flushJsonLogWrites(filePath);
    t.mock.restoreAll();

    appendJsonLog(filePath, entry("recovered"));
    await flushJsonLogWrites(filePath);
    const page = await readRecentJsonLogPageAsync(filePath, { limit: 1 });
    assert.equal(page.logs[0]?.id, "recovered");
  } finally {
    t.mock.restoreAll();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  appendJsonLog,
  clearJsonLogFile,
  datedJsonLogPath,
  flushJsonLogWrites,
  pruneJsonLogFile,
  readRecentJsonLogPageAsync,
  readRecentJsonLogsAsync,
} from "./logFileStore";

function dayAgo(days: number) {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() - days);
  return value;
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("daily JSON logs retain today and two previous dates across reads, filters, export and clear", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-days-"));
  const filePath = path.join(dir, "panel.jsonl");
  try {
    for (const age of [4, 3, 2, 1, 0]) {
      appendJsonLog(filePath, { id: age, level: age % 2 ? "warn" : "info", hostId: age === 1 ? 2 : 1, message: `day ${age}`, createdAt: dayAgo(age).toISOString() });
    }
    await flushJsonLogWrites(filePath);
    await fs.promises.writeFile(path.join(dir, "unrelated.2000-01-01.jsonl"), "untouched");
    await pruneJsonLogFile(filePath);
    assert.deepEqual((await fs.promises.readdir(dir)).sort(), [
      path.basename(filePath), path.basename(datedJsonLogPath(filePath, dayKey(dayAgo(1)))),
      path.basename(datedJsonLogPath(filePath, dayKey(dayAgo(2)))), "unrelated.2000-01-01.jsonl",
    ].sort());
    const page = await readRecentJsonLogPageAsync(filePath, { limit: 2 });
    assert.deepEqual(page.logs.map(entry => entry.id), [0, 1]);
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.summary, { all: 3, info: 2, warn: 1 });
    assert.deepEqual((await readRecentJsonLogPageAsync(filePath, { limit: 2, offset: 2 })).logs.map(entry => entry.id), [2]);
    assert.deepEqual((await readRecentJsonLogPageAsync(filePath, { level: "info", hostId: 1 })).logs.map(entry => entry.id), [0, 2]);
    assert.deepEqual((await readRecentJsonLogsAsync(filePath)).map(entry => entry.id), [2, 1, 0]);
    await clearJsonLogFile(filePath);
    assert.deepEqual(await readRecentJsonLogsAsync(filePath), []);
    assert.equal(await fs.promises.readFile(path.join(dir, "unrelated.2000-01-01.jsonl"), "utf8"), "untouched");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("midnight rotation preserves an existing archive and routes delayed writes by their original day", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-midnight-"));
  const filePath = path.join(dir, "panel.jsonl");
  const yesterday = dayAgo(1);
  const archive = datedJsonLogPath(filePath, dayKey(yesterday));
  const line = (id: string, createdAt: Date) => ({ id, createdAt: createdAt.toISOString(), level: "info", message: id });
  try {
    await fs.promises.writeFile(archive, JSON.stringify(line("earlier", yesterday)) + "\n");
    await fs.promises.writeFile(filePath, JSON.stringify(line("before-midnight", yesterday)) + "\n");
    await fs.promises.utimes(filePath, yesterday, yesterday);
    appendJsonLog(filePath, line("buffered-before-midnight", yesterday));
    appendJsonLog(filePath, line("today", new Date()));
    await flushJsonLogWrites(filePath);
    assert.deepEqual((await fs.promises.readFile(archive, "utf8")).trim().split("\n").map(value => JSON.parse(value).id), ["earlier", "before-midnight", "buffered-before-midnight"]);
    assert.deepEqual((await fs.promises.readFile(filePath, "utf8")).trim().split("\n").map(value => JSON.parse(value).id), ["today"]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("idle maintenance rotates yesterday's file and deletes expired files without new appends", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-idle-"));
  const filePath = path.join(dir, "panel.jsonl");
  const yesterday = dayAgo(1);
  const entry = (id: string, date: Date) => JSON.stringify({ id, level: "info", message: id, createdAt: date.toISOString() }) + "\n";
  try {
    // Simulate an old single-file installation containing several days.
    await fs.promises.writeFile(filePath, entry("expired", dayAgo(4)) + entry("boundary", dayAgo(2)) + entry("yesterday", yesterday));
    await fs.promises.utimes(filePath, yesterday, yesterday);
    const expired = datedJsonLogPath(filePath, dayKey(dayAgo(3)));
    await fs.promises.writeFile(expired, entry("expired-archive", dayAgo(3)));
    await pruneJsonLogFile(filePath);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(expired), false);
    assert.deepEqual((await readRecentJsonLogsAsync(filePath)).map(item => item.id), ["boundary", "yesterday"]);
    assert.deepEqual((await fs.promises.readFile(datedJsonLogPath(filePath, dayKey(yesterday)), "utf8")).trim().split("\n").map(value => JSON.parse(value).id), ["boundary", "yesterday"]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("automatic log rotation failures are reported without an unhandled rejection and recover", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-rotation-error-"));
  const filePath = path.join(dir, "panel.jsonl");
  const warnings: string[] = [];
  const originalStat = fs.promises.stat;
  try {
    t.mock.method(process.stderr, "write", (message: unknown) => { warnings.push(String(message)); return true; });
    t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof originalStat>) => {
      if (args[0] === filePath) throw new Error("mock rotation I/O failure");
      return originalStat(...args);
    });
    appendJsonLog(filePath, { id: "io-failed", level: "info", message: "failed", createdAt: new Date().toISOString() });
    await nextTurn();
    await nextTurn();
    assert.ok(warnings.some(message => message.includes("mock rotation I/O failure")));
    t.mock.restoreAll();
    appendJsonLog(filePath, { id: "recovered", level: "info", message: "recovered", createdAt: new Date().toISOString() });
    await flushJsonLogWrites(filePath);
    assert.equal((await readRecentJsonLogPageAsync(filePath)).logs[0]?.id, "recovered");
  } finally {
    t.mock.restoreAll();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("JSON logs batch writes without losing order and serialize maintenance", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forwardx-log-"));
  const filePath = path.join(dir, "panel.jsonl");
  try {
    appendJsonLog(filePath, { id: "old", level: "info", message: "old", createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString() });
    appendJsonLog(filePath, { id: "first", level: "info", message: "first", createdAt: new Date().toISOString() });
    appendJsonLog(filePath, { id: "second", level: "warn", message: "second", createdAt: new Date().toISOString() });
    await flushJsonLogWrites(filePath);

    const rawLines = (await fs.promises.readFile(filePath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(rawLines.map((line) => JSON.parse(line).id), ["first", "second"]);

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

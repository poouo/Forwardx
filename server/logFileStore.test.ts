import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
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

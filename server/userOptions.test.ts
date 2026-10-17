import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-user-options-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "users.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let repository: typeof import("./repositories/userRepository");
let router: typeof import("./routers/users").usersRouter;
const context = (role: "admin" | "user") => ({ user: { id: 1, username: "staff", role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, name TEXT, email TEXT, "displayRemark" TEXT, password TEXT, "sessionToken" TEXT)');
  for (let id = 1; id <= 65; id++) {
    await runtime.executeRaw('INSERT INTO users (id, username, name, email, "displayRemark", password, "sessionToken") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, `customer-${id}`, `Friend ${id}`, `friend-${id}@example.test`, id === 12 ? "朋友%_!专用" : null, "secret", "secret-session"]);
  }
  repository = await import("./repositories/userRepository");
  router = (await import("./routers/users")).usersRouter;
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("opening a user selector returns a populated, bounded first page without a search", async () => {
  const page = await repository.getUserOptionsPage({});
  assert.equal(page.items.length, 20);
  assert.deepEqual(page.items.map(user => user.id), Array.from({ length: 20 }, (_, index) => 65 - index));
  assert.equal(page.nextCursor, 46);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ["displayRemark", "email", "id", "name", "username"]);
});

test("cursor pages do not duplicate users, skip the current administrator or expose secrets", async () => {
  const ids: number[] = [];
  let cursor: number | undefined;
  do {
    const page = await repository.getUserOptionsPage({ cursor, excludeUserId: 60, limit: 20 });
    assert.ok(page.items.length <= 20);
    for (const user of page.items) {
      assert.ok(!("password" in user) && !("sessionToken" in user));
      ids.push(user.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 64);
  assert.equal(new Set(ids).size, 64);
  assert.ok(!ids.includes(60));
  assert.equal((await repository.getUserOptionsPage({ cursor: 1 })).items.length, 0);
});

test("user selection searches name, username, email, exact ID and literal wildcard remarks", async () => {
  for (const search of ["CUSTOMER-12", "Friend 12", "friend-12@EXAMPLE.test", "12", "#12", "朋友%_!专用"]) {
    const result = await repository.getUserOptionsPage({ search });
    assert.deepEqual(result.items.map(user => user.id), [12], search);
  }
  assert.equal((await repository.getUserOptionsPage({ search: "%_!" })).items[0]?.id, 12);
  assert.deepEqual((await repository.getUserOptionsPage({ search: "' OR 1=1 --" })).items, []);
  assert.deepEqual((await repository.getUserOptionsPage({ search: "missing" })).items, []);
});

test("selected users are hydrated independently of the current search page", async () => {
  assert.ok(!(await repository.getUserOptionsPage({ search: "customer-65" })).items.some(user => user.id === 12));
  assert.deepEqual((await repository.getUserOptionsByIds([12, 12, 1, 9999])).map(user => user.id).sort((a, b) => a - b), [1, 12]);
  assert.deepEqual(await repository.getUserOptionsByIds([]), []);
});

test("selector endpoints require administrator access and validate paging limits and IDs", async () => {
  const admin = router.createCaller(context("admin"));
  const regular = router.createCaller(context("user"));
  assert.equal((await admin.optionsPage({ search: "", limit: 20 })).items.length, 20);
  assert.equal((await admin.optionsByIds({ ids: [12] }))[0]?.id, 12);
  await assert.rejects(regular.optionsPage({ search: "", limit: 20 }), error => (error as any).code === "FORBIDDEN");
  await assert.rejects(regular.optionsByIds({ ids: [12] }), error => (error as any).code === "FORBIDDEN");
  for (const input of [{ limit: 51 }, { cursor: -1 }, { search: "a".repeat(129) }]) {
    await assert.rejects(admin.optionsPage(input as any), error => (error as any).code === "BAD_REQUEST");
  }
  await assert.rejects(admin.optionsByIds({ ids: Array.from({ length: 101 }, (_, i) => i + 1) }), error => (error as any).code === "BAD_REQUEST");
});

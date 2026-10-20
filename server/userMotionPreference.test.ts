import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-motion-preference-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "preferences.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let repository: typeof import("./repositories/userRepository");
let auth: typeof import("./routers/auth").authRouter;
const context = (user: any) => ({ user, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0, "lastSignedIn" INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO users (id, username, password) VALUES (1, 'existing', 'unused')");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  repository = await import("./repositories/userRepository");
  auth = (await import("./routers/auth")).authRouter;
  await runtime.insertAndGetId("users", { id: 2, username: "customer", password: "unused", role: "user" });
  await runtime.insertAndGetId("users", { id: 3, username: "staff", password: "unused", role: "admin" });
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("upgraded and newly created users default to enabled", async () => {
  for (const id of [1, 2, 3]) assert.equal((await repository.getUserById(id))?.animationsEnabled, true);
});

test("ordinary users and admins update only their own animation preference", async () => {
  const customer = await repository.getUserById(2);
  const staff = await repository.getUserById(3);
  const own = auth.createCaller(context(customer));
  const admin = auth.createCaller(context(staff));
  await own.updateProfile({ animationsEnabled: false, userId: 3 } as any);
  assert.equal((await repository.getUserById(2))?.animationsEnabled, false);
  assert.equal((await repository.getUserById(3))?.animationsEnabled, true);
  await admin.updateProfile({ animationsEnabled: false, userId: 1 } as any);
  assert.equal((await repository.getUserById(3))?.animationsEnabled, false);
  assert.equal((await repository.getUserById(1))?.animationsEnabled, true);
  await own.updateProfile({ animationsEnabled: true });
  assert.equal((await repository.getUserById(2))?.animationsEnabled, true);
  assert.equal((await repository.getUserById(3))?.animationsEnabled, false);
});

test("other profile edits preserve the saved preference and auth.me returns it", async () => {
  const before = await repository.getUserById(3);
  await auth.createCaller(context(before)).updateProfile({ name: "Updated staff" });
  const user = await repository.getUserById(3);
  assert.equal(user?.animationsEnabled, false);
  const profile = await auth.createCaller(context(user)).me();
  assert.equal(profile?.animationsEnabled, false);
});

test("unauthenticated clients and non-boolean values cannot modify preferences", async () => {
  await assert.rejects(() => auth.createCaller(context(null)).updateProfile({ animationsEnabled: false }), { code: "UNAUTHORIZED" });
  const user = await repository.getUserById(2);
  await assert.rejects(() => auth.createCaller(context(user)).updateProfile({ animationsEnabled: "false" } as any), { code: "BAD_REQUEST" });
  assert.equal((await repository.getUserById(2))?.animationsEnabled, true);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("password reset CLI changes only the selected administrator and revokes sessions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reset-admin-"));
  const databasePath = path.join(directory, "reset.db");
  const setupScript = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const password = await import(url("server/password.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "email", "role", "accountEnabled", "twoFactorEnabled") VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [1, "admin@example.com", password.hashPassword("old-password"), "Admin", "admin@example.com", "admin", 0, 1]);
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role", "accountEnabled") VALUES (?, ?, ?, ?, ?, ?)', [2, "other-admin", password.hashPassword("other-password"), "Other", "admin", 1]);
      const sessions = await import(url("server/repositories/sessionRepository.ts"));
      const session = await import(url("server/session.ts"));
      for (const [kind, sid] of [["browser", "browser-1"], ["mobile", "mobile-1"], ["telegram", "telegram-1"]]) {
        await sessions.createAuthSession({ userId: 1, sid, kind, expiresAt: new Date(Date.now() + 60_000) });
        await runtime.executeRaw('UPDATE "users" SET ' + (kind === "browser" ? '"browserSessionToken"' : kind === "mobile" ? '"mobileSessionToken"' : '"telegramSessionToken"') + ' = ? WHERE "id" = 1', [session.encodeSessionLease(sid)]);
      }
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const setup = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", setupScript], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath, FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);

  const reset = spawnSync(process.execPath, ["--import", "tsx", "server/resetAdminPasswordCli.ts", "--stdin"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath },
    input: "admin@example.com\nnew-password-123\nnew-password-123\n",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(reset.status, 0, reset.stderr || reset.stdout);
  assert.match(reset.stdout, /Administrator password reset: admin@example\.com/);

  const verifyScript = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const password = await import(url("server/password.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      const admin = await users.getUserById(1);
      assert.equal(password.verifyPassword("new-password-123", admin.password), true);
      assert.equal(password.verifyPassword("old-password", admin.password), false);
      assert.equal(Boolean(admin.accountEnabled), false);
      assert.equal(Boolean(admin.twoFactorEnabled), true);
      const sessions = await runtime.queryRaw('SELECT "revokedAt", "revokeReason" FROM "auth_sessions" WHERE "userId" = 1');
      assert.equal(sessions.length, 3);
      assert.ok(sessions.every((row) => row.revokedAt && row.revokeReason === "password_reset_cli"));
      const other = await users.getUserById(2);
      assert.equal(password.verifyPassword("other-password", other.password), true);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const verify = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", verifyScript], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath, FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reset CLI rejects ambiguous administrator selection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reset-admin-ambiguous-"));
  const databasePath = path.join(directory, "reset.db");
  const script = String.raw`
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const password = await import(url("server/password.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [1, "first-admin", password.hashPassword("first"), "admin", 2, "second-admin", password.hashPassword("second"), "admin"]);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const setup = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath, FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const reset = spawnSync(process.execPath, ["--import", "tsx", "server/resetAdminPasswordCli.ts", "--stdin"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: databasePath },
    input: "\nnew-password-123\nnew-password-123\n",
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    assert.notEqual(reset.status, 0);
    assert.match(reset.stderr, /ambiguous/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

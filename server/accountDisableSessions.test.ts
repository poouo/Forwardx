import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("disabling an account revokes every auth session and clears all leases", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-account-disable-"));
  const databasePath = path.join(directory, "session.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const session = await import(url("server/session.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role", "accountEnabled") VALUES (?, ?, ?, ?, ?, ?)', [1, "admin@example.com", "x", "Admin", "user", 1]);
      for (const [kind, sid] of [["browser", "browser-1"], ["mobile", "mobile-1"], ["telegram", "telegram-1"]]) {
        await sessions.createAuthSession({ userId: 1, sid, kind, expiresAt: new Date(Date.now() + 60_000) });
        await users.setUserSessionToken(1, kind, session.encodeSessionLease(sid), { touchUserUpdatedAt: false });
      }

      await users.setUserAccountEnabled(1, false);
      const rows = await runtime.queryRaw('SELECT "sid", "revokedAt", "revokeReason" FROM "auth_sessions" WHERE "userId" = ? ORDER BY "sid"', [1]);
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.revokedAt));
      assert.ok(rows.every((row) => row.revokeReason === "account_disabled"));
      const user = (await users.getUserById(1));
      assert.equal(Boolean(user.accountEnabled), false);
      assert.equal(user.browserSessionToken, null);
      assert.equal(user.mobileSessionToken, null);
      assert.equal(user.telegramSessionToken, null);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

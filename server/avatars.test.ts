import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("avatar defaults, saves and random selection retain quotas and uploaded images", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-avatars-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const avatars = await import(url("shared/avatar.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const id = await users.createUser({ username: "avatar-test", password: "test-password" });
      const registeredId = await users.registerUser({ username: "avatar-register", password: "test-password" });
      assert.ok(avatars.isBuiltinAvatarValue((await users.getUserById(id)).avatar));
      assert.ok(avatars.isBuiltinAvatarValue((await users.getUserById(registeredId)).avatar));
      const options = { actorRole: "user", countQuota: true };
      const upload = "data:image/png;base64,YQ==";
      await users.updateUserAvatarWithQuota(id, upload, options);
      assert.equal((await users.getUserById(id)).avatar, upload);
      await users.updateUserAccount(id, { avatar: avatars.migrateLegacyAvatarValue(upload) });
      assert.equal((await users.getUserById(id)).avatar, upload);
      const next = await users.updateUserAvatarRandomWithQuota(id, options);
      assert.ok(avatars.isBuiltinAvatarValue(next.avatar));
      assert.equal(next.quota.used, 2);
      assert.equal((await users.getUserById(id)).avatar, next.avatar);
      const third = await users.updateUserAvatarRandomWithQuota(id, options);
      assert.notEqual(third.avatar, next.avatar);
      assert.equal(third.quota.remaining, 0);
      await assert.rejects(users.updateUserAvatarRandomWithQuota(id, options), /每天最多修改/);
      // Admin edits still bypass self-service quotas.
      await users.updateUserAvatarWithQuota(id, upload, { actorRole: "admin", countQuota: true });
      assert.equal((await users.getUserById(id)).avatar, upload);
      for (let i = 0; i < avatars.AVATAR_RANDOM_WINDOW_LIMIT; i++) users.checkAvatarRandomRateLimit(987654);
      assert.throws(() => users.checkAvatarRandomRateLimit(987654), /过于频繁/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "avatars.db") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

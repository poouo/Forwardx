import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("network test hosts match the explicit host access boundary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-looking-glass-access-"));
  const databasePath = path.join(directory, "looking-glass.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const { lookingGlassRouter } = await import(moduleUrl("server/routers/lookingGlass.ts"));
    const quote = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const context = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
      await insert("users", ["id", "username", "password", "role"], [2, "viewer", "x", "user"]);
      for (const [id, name, ownerId] of [
        [1, "manual", 1],
        [2, "hidden", 1],
        [3, "owned", 2],
        [4, "public-billing", 1],
        [5, "subscription", 1],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
          [id, name, "198.51.100." + id, "198.51.100." + id, ownerId, 1, now],
        );
      }
      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      await insert("subscription_plans", ["id", "name"], [10, "network-test-host"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [10, 5]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status"], [20, 2, 10, "active"]);
      await insert(
        "traffic_billing_configs",
        ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"],
        [30, "host", 4, 1, 0, 1, 100],
      );
      await settings.setSetting("trafficBillingEnabled", "true");

      const userCaller = lookingGlassRouter.createCaller(context({
        id: 2,
        username: "viewer",
        role: "user",
        accountEnabled: true,
      }));
      const adminCaller = lookingGlassRouter.createCaller(context({
        id: 1,
        username: "admin",
        role: "admin",
        accountEnabled: true,
      }));

      assert.deepEqual(
        (await userCaller.hosts()).map((host) => Number(host.id)).sort((a, b) => a - b),
        [1, 3, 5],
      );
      assert.deepEqual(
        (await adminCaller.hosts()).map((host) => Number(host.id)).sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
      );

      await settings.setSetting("lookingGlassUserEnabled", "false");
      await assert.rejects(() => userCaller.hosts(), /管理员已关闭普通用户使用网络测试/);
      assert.equal((await adminCaller.hosts()).length, 5);
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

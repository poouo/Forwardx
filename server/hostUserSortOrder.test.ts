import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ordinary users persist an isolated order for owned and authorized hosts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-user-order-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));
    const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
    const pageIds = async (input) => (await hosts.getHostsPage(input)).items.map((host) => Number(host.id));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      for (const [id, username] of [[10, "viewer"], [20, "shared-owner"], [30, "other-viewer"]]) {
        await runtime.executeRaw(
          'INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)',
          [id, username, "hash", "user"],
        );
      }
      for (const [id, userId, sortOrder] of [
        [1, 10, 0],
        [2, 10, 1],
        [3, 20, 2],
        [4, 20, 3],
        [5, 10, 4],
      ]) {
        await runtime.executeRaw(
          'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId", "sortOrder") VALUES (?, ?, ?, ?, ?, ?)',
          [id, "host-" + id, "192.0.2." + id, "slave", userId, sortOrder],
        );
      }

      const viewerScope = { ownerUserId: 10, allowedHostIds: [3], sortUserId: 10 };
      assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [1, 2, 3, 5]);

      await hosts.reorderVisibleHostsForUser([2, 1], 10, [3], 0);
      assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [2, 1, 3, 5]);

      await hosts.reorderVisibleHostsForUser([5, 3], 10, [3], 2);
      assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 2 }), [2, 1]);
      assert.deepEqual(await pageIds({ ...viewerScope, page: 2, pageSize: 2 }), [5, 3]);
      assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 5, 3]);

      assert.deepEqual(await pageIds({ page: 1, pageSize: 10 }), [1, 2, 3, 4, 5]);
      assert.deepEqual(await pageIds({ ownerUserId: 30, allowedHostIds: [1, 2, 3, 5], sortUserId: 30, page: 1, pageSize: 10 }), [1, 2, 3, 5]);

      await assert.rejects(
        () => hosts.reorderVisibleHostsForUser([4], 10, [3], 0),
        /无权操作或不存在/,
      );
      assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 5, 3]);

      await hosts.reorderHosts([2, 1], undefined, 0);
      assert.deepEqual(await pageIds({ page: 1, pageSize: 10 }), [2, 1, 3, 4, 5]);
      assert.deepEqual(await pageIds({ ...viewerScope, page: 1, pageSize: 10 }), [2, 1, 5, 3]);

      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "userId", "sortOrder") VALUES (?, ?, ?, ?, ?, ?)',
        [6, "host-6", "192.0.2.6", "slave", 20, 5],
      );
      const changedScope = { ownerUserId: 10, allowedHostIds: [6], sortUserId: 10 };
      assert.deepEqual(await pageIds({ ...changedScope, page: 1, pageSize: 10 }), [2, 1, 5, 6]);
      await hosts.reorderVisibleHostsForUser([6, 5], 10, [6], 2);
      assert.deepEqual(await pageIds({ ...changedScope, page: 1, pageSize: 10 }), [2, 1, 6, 5]);
      assert.deepEqual(JSON.parse(await settings.getSetting("ui.hostOrder.user.10.v1")), [2, 1, 6, 5]);

      await settings.setSetting("ui.hostOrder.user.30.v1", "not-json");
      assert.deepEqual(await pageIds({ ownerUserId: 30, allowedHostIds: [1, 2, 3], sortUserId: 30, page: 1, pageSize: 10 }), [2, 1, 3]);
    } finally {
      await runtime.closeDatabase();
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward group and tunnel controlled toggles preserve independent restore causes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-toggle-"));
  const databasePath = path.join(directory, "toggle.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      const placeholders = values.map(() => "?").join(", ");
      await runtime.executeRaw(
        'INSERT INTO ' + q(table) + ' (' + columns.map(q).join(", ") + ') VALUES (' + placeholders + ')',
        values,
      );
    };

    await insert("hosts", ["id", "name", "ip", "userId"], [1, "entry", "10.0.0.1", 1]);
    await insert("hosts", ["id", "name", "ip", "userId"], [2, "exit", "10.0.0.2", 1]);
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [10, "tunnel group", "tunnel", "failover", null, "0.0.0.0", 1, 1],
    );
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [20, "entry group", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1],
    );
    await insert(
      "forward_groups",
      ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
      [21, "exit group", "host", "exit", null, "0.0.0.0", 1, 1],
    );
    await insert(
      "forward_group_members",
      ["id", "groupId", "memberType", "tunnelId", "priority", "isEnabled"],
      [101, 10, "tunnel", 30, 0, 1],
    );
    await insert(
      "forward_group_members",
      ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
      [201, 20, "host", 1, 0, 1],
    );
    await insert(
      "forward_group_members",
      ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
      [211, 21, "host", 2, 0, 1],
    );
    await insert(
      "tunnels",
      ["id", "name", "entryGroupId", "exitGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "isRunning"],
      [30, "controlled tunnel", 20, 21, 1, 2, "tls", 25000, 1, 1, 1],
    );
    await insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
      [100, 1, "template", "gost", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0],
    );
    await insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
      [110, 1, "managed child", "gost", "tcp", 30, 26000, 10, 100, 101, 0, 16000, "203.0.113.10", 80, 1, 1, 1],
    );

    const ruleState = async (id) => (await runtime.queryRaw(
      'SELECT "isEnabled", "disabledByGroup", "disabledByTunnel" FROM "forward_rules" WHERE "id" = ?',
      [id],
    ))[0];
    const tunnelState = async () => (await runtime.queryRaw(
      'SELECT "isEnabled", "disabledByGroup" FROM "tunnels" WHERE "id" = 30',
    ))[0];

    await forwardGroups.setForwardGroupEnabled(10, false);
    assert.deepEqual(await ruleState(110), { isEnabled: 0, disabledByGroup: 1, disabledByTunnel: 0 });

    await forwardGroups.setForwardGroupEnabled(20, false);
    assert.deepEqual(await tunnelState(), { isEnabled: 0, disabledByGroup: 1 });
    assert.deepEqual(await ruleState(110), { isEnabled: 0, disabledByGroup: 1, disabledByTunnel: 1 });

    await forwardGroups.setForwardGroupEnabled(10, true);
    assert.deepEqual(await ruleState(110), { isEnabled: 0, disabledByGroup: 0, disabledByTunnel: 1 });

    await forwardGroups.setForwardGroupEnabled(20, true);
    assert.deepEqual(await tunnelState(), { isEnabled: 1, disabledByGroup: 0 });
    assert.deepEqual(await ruleState(110), { isEnabled: 1, disabledByGroup: 0, disabledByTunnel: 0 });

    await forwardGroups.setForwardGroupEnabled(21, false);
    assert.deepEqual(await tunnelState(), { isEnabled: 0, disabledByGroup: 1 });
    assert.deepEqual(await ruleState(110), { isEnabled: 0, disabledByGroup: 0, disabledByTunnel: 1 });

    await forwardGroups.setForwardGroupEnabled(21, true);
    assert.deepEqual(await tunnelState(), { isEnabled: 1, disabledByGroup: 0 });
    assert.deepEqual(await ruleState(110), { isEnabled: 1, disabledByGroup: 0, disabledByTunnel: 0 });

    await runtime.closeDatabase();
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

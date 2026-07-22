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

    const runtimeGroups = await forwardGroups.getForwardGroups(undefined, { includeRuntime: true });
    const runtimeGroup = runtimeGroups.find((group) => Number(group.id) === 10);
    assert.equal(runtimeGroup.runtimeStatus, "running");
    assert.equal(runtimeGroup.runtimeExpectedRuleCount, 1);
    assert.equal(runtimeGroup.runtimeRunningRuleCount, 1);
    assert.equal(runtimeGroup.ruleRuntimeStatuses[0]?.templateRuleId, 100);

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
test("managed forward children recover stale automatic-disable state from enabled templates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-child-recovery-"));
  const databasePath = path.join(directory, "recovery.db");
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
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const childState = async (id) => (await runtime.queryRaw(
      'SELECT "isEnabled", "disabledByUser", "disabledByTunnel", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?',
      [id],
    ))[0];
    const assertRecovered = (state) => {
      assert.equal(Number(state.isEnabled), 1);
      assert.equal(Number(state.disabledByUser), 0);
      assert.equal(Number(state.disabledByTunnel), 0);
      assert.equal(state.protocolBlockReason, null);
    };

    try {
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId"], [1, "entry-a", "10.0.0.1", "10.0.0.1", 1]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId"], [2, "entry-b", "10.0.0.2", "10.0.0.2", 1]);

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "forwardType", "protocol", "targetIp", "userId", "isEnabled"],
        [40, "saved port", "host", "port", "realm", "both", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [401, 40, "host", 1, 0, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [400, 1, "port template", "realm", "both", 40, 1, 10889, "203.0.113.40", 443, 1, 1, 0, 0],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser", "disabledByTunnel", "protocolBlockReason"],
        [410, 1, "stale port child", "realm", "both", 40, 400, 401, 0, 10889, "203.0.113.40", 443, 1, 0, 0, 1, 0, null],
      );

      await forwardGroups.syncForwardGroupRules(40);
      assertRecovered(await childState(410));

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "forwardType", "protocol", "targetIp", "userId", "isEnabled"],
        [45, "failover group", "host", "failover", "realm", "both", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [451, 45, "host", 1, 0, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [450, 1, "failover template", "realm", "both", 45, 1, 10890, "203.0.113.45", 443, 1, 1, 0, 0],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [460, 1, "stale failover child", "realm", "both", 45, 450, 451, 0, 10890, "203.0.113.45", 443, 1, 0, 0, 1],
      );

      await forwardGroups.syncForwardGroupRules(45);
      assertRecovered(await childState(460));

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "forwardType", "protocol", "targetIp", "userId", "isEnabled"],
        [50, "forward chain", "host", "chain", "realm", "both", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "connectHost", "priority", "isEnabled"],
        [501, 50, "host", 1, null, 0, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "connectHost", "priority", "isEnabled"],
        [502, 50, "host", 2, "10.0.0.2", 1, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser"],
        [500, 1, "chain template", "realm", "both", 50, 1, 10871, "203.0.113.50", 443, 1, 1, 0, 0],
      );
      for (const [id, hostId, memberId, targetIp, targetPort] of [
        [510, 1, 501, "10.0.0.2", 10871],
        [520, 2, 502, "203.0.113.50", 443],
      ]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "disabledByUser", "disabledByTunnel", "protocolBlockReason"],
          [id, hostId, "stale chain child", "realm", "both", 50, 500, memberId, 0, 10871, targetIp, targetPort, 1, 0, 0, 1, 0, null],
        );
      }

      await forwardGroups.syncForwardGroupRules(50, { validatePorts: false });
      assertRecovered(await childState(510));
      assertRecovered(await childState(520));

      await runtime.executeRaw(
        'UPDATE "forward_rules" SET "isEnabled" = ?, "protocolBlockReason" = ? WHERE "id" = ?',
        [0, "host protocol policy block", 460],
      );
      await forwardGroups.syncForwardGroupRules(45);
      assert.deepEqual(await childState(460), {
        isEnabled: 0,
        disabledByUser: 0,
        disabledByTunnel: 0,
        protocolBlockReason: "host protocol policy block",
      });
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
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

test("forward chain rules deploy downstream first and external entries last", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-chain-deployment-"));
  const databasePath = path.join(directory, "deployment.db");
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
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      for (const [id, publicIp, privateIp] of [
        [1, "198.51.100.1", "10.0.0.1"],
        [2, "198.51.100.2", "10.0.0.2"],
        [3, "198.51.100.3", "10.0.0.3"],
        [4, "198.51.100.4", "10.0.0.4"],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "entryIp", "tunnelEntryIp", "userId"],
          [id, "host-" + id, publicIp, publicIp, publicIp, privateIp, 1],
        );
      }

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
        [60, "external entries", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [601, 60, "host", 4, 0, 1],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "entryGroupId", "forwardType", "protocol", "targetIp", "userId", "isEnabled"],
        [61, "three hop chain", "host", "chain", 60, "iptables", "both", "0.0.0.0", 1, 1],
      );
      for (const [id, hostId, connectHost, priority] of [
        [611, 1, null, 0],
        [612, 2, "10.0.0.2", 1],
        [613, 3, "10.0.0.3", 2],
      ]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "connectHost", "priority", "isEnabled"],
          [id, 61, "host", hostId, connectHost, priority, 1],
        );
      }
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [610, 4, "chain template", "iptables", "both", 61, 1, 18080, "203.0.113.80", 443, 1, 1, 0],
      );

      await forwardGroups.syncForwardGroupRules(61, { validatePorts: false });
      const children = await runtime.queryRaw(
        'SELECT "hostId", "name" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "id" ASC',
        [610],
      );
      assert.deepEqual(children.map((child) => Number(child.hostId)), [3, 2, 1, 4]);
      assert.match(String(children[0].name), /3\/3/);
      assert.match(String(children[3].name), /entry 1\/1/);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
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

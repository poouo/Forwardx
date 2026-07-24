import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("silent Agent activity automatically evaluates failover and entry groups at their liveness deadlines", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-liveness-"));
  const databasePath = path.join(directory, "liveness.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const activity = await import(moduleUrl("server/agentActivity.ts"));

      const q = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        const placeholders = values.map(() => "?").join(", ");
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
          values,
        );
      };
      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const [id, name, address] of [
        [1, "primary", "198.51.100.10"],
        [2, "standby", "198.51.100.20"],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
          [id, name, address, address, 1, 1, nowSeconds],
        );
      }

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds", "recoverSeconds", "autoFailback"],
        [10, "failover", "host", "failover", "failover.example.test", "A", "0.0.0.0", 1, 1, 101, "198.51.100.10", 60, 120, 0],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue"],
        [20, "entry", "host", "entry", "entry.example.test", "A", "0.0.0.0", 1, 1, 201, "198.51.100.10,198.51.100.20"],
      );
      for (const [id, groupId, hostId, priority] of [
        [101, 10, 1, 0],
        [102, 10, 2, 1],
        [201, 20, 1, 0],
        [202, 20, 2, 1],
      ]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [id, groupId, "host", hostId, priority, 1],
        );
      }
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [100, 1, "template", "iptables", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0],
      );
      for (const [id, hostId, memberId] of [[110, 1, 101], [120, 2, 102]]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "gostMode", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [id, hostId, "managed child", "iptables", "tcp", "direct", 10, 100, memberId, 0, 16000, "203.0.113.10", 80, 1, 1, 1],
        );
      }

      const now = Date.now();
      activity.recordAuthenticatedAgentActivity(2, now);
      activity.recordAuthenticatedAgentActivity(1, now - 151_000);

      const deadline = Date.now() + 3_000;
      let failoverState;
      let entryState;
      do {
        [failoverState] = await runtime.queryRaw(
          'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
        );
        [entryState] = await runtime.queryRaw(
          'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 20',
        );
        if (Number(failoverState?.activeMemberId) === 102 && entryState?.lastDdnsValue === "198.51.100.20") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);

      assert.equal(Number(failoverState?.activeMemberId), 102, "failover group did not react to Agent silence");
      assert.equal(failoverState?.lastDdnsValue, "198.51.100.20");
      assert.equal(Number(entryState?.activeMemberId), 202, "entry group retained the silent Agent");
      assert.equal(entryState?.lastDdnsValue, "198.51.100.20");
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
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward group sync creates an enabled child listener for every enabled member", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-listeners-"));
  const databasePath = path.join(directory, "listeners.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      for (const [id, ip] of [[1, "198.51.100.10"], [2, "198.51.100.20"]]) {
        await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [id, "host-" + id, ip, ip, 1, 1, now]);
      }
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp",
        "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback",
      ], [10, "group", "host", "failover", "edge.example.test", "A", "0.0.0.0", 1, 1, null, 60, 120, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
      ], [100, 1, "template", "iptables", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0]);

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      const children = await runtime.queryRaw(
        'SELECT "forwardGroupMemberId", "hostId", "sourcePort", "isEnabled", "pendingDelete" FROM "forward_rules" WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0 ORDER BY "forwardGroupMemberId"',
        [10],
      );
      assert.deepEqual(children, [
        { forwardGroupMemberId: 101, hostId: 1, sourcePort: 16000, isEnabled: 1, pendingDelete: 0 },
        { forwardGroupMemberId: 102, hostId: 2, sourcePort: 16000, isEnabled: 1, pendingDelete: 0 },
      ]);

      const beforeResync = await runtime.queryRaw(
        'SELECT "updatedAt" FROM "forward_rules" WHERE "id" = 101',
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await forwardGroups.syncForwardGroupRules(10, { preserveRuntime: true });
      const afterResync = await runtime.queryRaw(
        'SELECT "updatedAt" FROM "forward_rules" WHERE "id" = 101',
      );
      assert.notEqual(afterResync[0]?.updatedAt, beforeResync[0]?.updatedAt, "a stopped child must be re-dispatched");
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

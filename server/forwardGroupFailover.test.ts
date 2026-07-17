import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward group switches after its configured heartbeat failure window", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-failover-"));
  const databasePath = path.join(directory, "failover.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const requests = [];
    const webhook = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));
      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const address = webhook.address();
      assert.ok(address && typeof address === "object");
      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "webhook",
        ddnsWebhookUrl: "http://127.0.0.1:" + address.port + "/ddns",
        ddnsWebhookMethod: "POST",
        ddnsTtl: "60",
      });

      const q = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        const placeholders = values.map(() => "?").join(", ");
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
          values,
        );
      };
      const now = Math.floor(Date.now() / 1000);

      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [1, "primary", "198.51.100.10", "198.51.100.10", 1, 1, now - 45],
      );
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [2, "standby", "198.51.100.20", "198.51.100.20", 1, 1, now],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback"],
        [10, "failover", "host", "failover", "edge.example.test", "A", "0.0.0.0", 1, 1, 101, 60, 120, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [101, 10, "host", 1, 0, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [102, 10, "host", 2, 1, 1],
      );
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

      await forwardGroups.runForwardGroupFailover(10);
      let state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 101);
      assert.equal(state.lastDdnsValue, "198.51.100.10");

      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ? WHERE "id" = 1', [now - 75]);
      assert.equal((await hosts.getHostById(1)).isOnline, true, "global 150 second host TTL should not have expired yet");

      await forwardGroups.runForwardGroupFailover(10);
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 102);
      assert.equal(state.lastDdnsValue, "198.51.100.20");
      assert.deepEqual(requests.map((request) => request.value), ["198.51.100.10", "198.51.100.20"]);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
      await new Promise((resolve) => webhook.close(resolve));
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

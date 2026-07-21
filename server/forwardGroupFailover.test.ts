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
      const ddns = await import(moduleUrl("server/ddns.ts"));
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
      assert.deepEqual(requests.map((request) => request.values), [["198.51.100.10"], ["198.51.100.20"]]);

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "healthySince" = ? WHERE "id" = 101', [now - 130]);
      await forwardGroups.runForwardGroupFailover(10);
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(Number(state.activeMemberId), 101);
      assert.equal(state.lastDdnsValue, "198.51.100.10");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10"], "failover groups must keep exactly one DDNS record");

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "failoverSeconds"],
        [20, "entry", "host", "entry", "entry.example.test", "A", "0.0.0.0", 1, 1, 60],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [201, 20, "host", 1, 0, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [202, 20, "host", 2, 1, 1],
      );

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ?', [now]);
      await forwardGroups.runForwardGroupFailover(20);
      let entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"]);

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0 WHERE "id" = 1');
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 202);
      assert.equal(entryState.lastDdnsValue, "198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.equal(requests.at(-1).action, "replace");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.20"], "entry groups must remove only the offline host record");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 1, "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(Number(entryState.activeMemberId), 201);
      assert.equal(entryState.lastDdnsValue, "198.51.100.10,198.51.100.20");
      assert.equal(entryState.lastStatus, "healthy");
      assert.deepEqual(requests.at(-1).values, ["198.51.100.10", "198.51.100.20"], "entry groups must restore the recovered host record");

      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0');
      await forwardGroups.runForwardGroupFailover(20);
      entryState = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 20',
      ))[0];
      assert.equal(entryState.activeMemberId, null);
      assert.equal(entryState.lastDdnsValue, null);
      assert.equal(entryState.lastStatus, "down");
      assert.equal(requests.at(-1).action, "delete");
      assert.deepEqual(requests.at(-1).values, []);

      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ?', [now - 75]);
      await forwardGroups.runForwardGroupFailover(10, { forceSync: true });
      state = (await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue", "lastStatus" FROM "forward_groups" WHERE "id" = 10',
      ))[0];
      assert.equal(state.activeMemberId, null);
      assert.equal(state.lastDdnsValue, null);
      assert.equal(state.lastStatus, "down");
      assert.equal(requests.at(-1).domain, "edge.example.test");
      assert.equal(requests.at(-1).action, "delete");
      assert.deepEqual(requests.at(-1).values, []);

      await settings.setSettings({
        ddnsEnabled: "true",
        ddnsProvider: "cloudflare",
        ddnsCloudflareZoneId: "zone-1",
        ddnsCloudflareApiToken: "token-1",
        ddnsTtl: "60",
      });
      let cloudflareRecords = [
        { id: "old-1", name: "edge.cloudflare.test", type: "A", content: "198.51.100.10", proxied: false },
        { id: "old-2", name: "edge.cloudflare.test", type: "A", content: "198.51.100.20", proxied: false },
      ];
      globalThis.fetch = async (rawUrl, init = {}) => {
        const url = String(rawUrl);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "GET") {
          return new Response(JSON.stringify({ success: true, result: cloudflareRecords }), { status: 200 });
        }
        if (method === "DELETE") {
          const id = decodeURIComponent(url.split("/").at(-1));
          cloudflareRecords = cloudflareRecords.filter((record) => record.id !== id);
          return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
        }
        if (method === "POST") {
          const payload = JSON.parse(String(init.body || "{}"));
          cloudflareRecords.push({ id: "new-" + (cloudflareRecords.length + 1), ...payload });
          return new Response(JSON.stringify({ success: true, result: payload }), { status: 200 });
        }
        throw new Error("unexpected Cloudflare request " + method + " " + url);
      };
      await ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: ["198.51.100.20"],
      });
      assert.deepEqual(cloudflareRecords.map((record) => record.content), ["198.51.100.20"]);
      await ddns.updateDdnsRecordValues({
        groupId: 99,
        domain: "edge.cloudflare.test",
        recordType: "A",
        values: [],
      });
      assert.deepEqual(cloudflareRecords, []);
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

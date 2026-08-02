import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite Agent traffic route is atomic, idempotent, and follows the current tunnel topology", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-traffic-route-"));
  const databasePath = path.join(directory, "traffic-route.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import express from "express";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));
    const metrics = await import(url("server/repositories/metricsRepository.ts"));

    const hostIds = [
      1,
      10, 11, 12, 19,
      20, 21, 22, 23, 24,
      30, 31, 32,
      40, 41, 42,
      50, 51, 52,
    ];
    const producerByHost = new Map(hostIds.map((hostId) => [hostId, "route-producer-" + hostId]));
    let server;

    function tokenForHost(hostId) {
      return "route-token-" + hostId;
    }

    async function postTraffic(baseUrl, hostId, reportId, ruleId, bytesIn = 10, bytesOut = 20) {
      const response = await fetch(baseUrl + "/api/agent/traffic", {
        method: "POST",
        headers: {
          authorization: "Bearer " + tokenForHost(hostId),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reportId,
          reportProducerId: producerByHost.get(hostId),
          stats: [{ ruleId, bytesIn, bytesOut, connections: 1 }],
        }),
      });
      const body = await response.json();
      return { status: response.status, body };
    }

    async function trafficRows(ruleId) {
      return runtime.queryRaw(
        'SELECT "hostId", SUM("bytesIn") AS "bytesIn", SUM("bytesOut") AS "bytesOut", SUM("connections") AS "connections" FROM "traffic_stats" WHERE "ruleId" = ? GROUP BY "hostId" ORDER BY "hostId"',
        [ruleId],
      );
    }

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?)',
        [1, "route-admin", "hash", "Route Admin", "admin", 0],
      );
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?)',
        [2, "ordinary-rule-user", "hash", "Ordinary Rule User", "user", 0],
      );
      for (const hostId of hostIds) {
        await runtime.executeRaw(
          'INSERT INTO "hosts" ("id", "name", "ip", "hostType", "agentToken", "userId") VALUES (?, ?, ?, ?, ?, ?)',
          [hostId, "route-host-" + hostId, "127.0.0." + ((hostId % 250) + 1), "slave", tokenForHost(hostId), 1],
        );
      }

      await runtime.executeRaw(
        'INSERT INTO "forward_groups" ("id", "name", "groupMode", "targetIp", "isEnabled", "userId") VALUES (?, ?, ?, ?, ?, ?)',
        [201, "forwardx-entry", "entry", "127.0.0.1", 1, 1],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
        [2011, 201, "host", 11, 10, 1, 2012, 201, "host", 12, 20, 0],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_groups" ("id", "name", "groupMode", "targetIp", "isEnabled", "userId") VALUES (?, ?, ?, ?, ?, ?)',
        [700, "admin-owned-shared-group", "failover", "127.0.0.1", 1, 1],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
        [7001, 700, "host", 20, 10, 1],
      );

      const tunnels = [
        [200, "forwardx", 10, 19, "forwardx", 201, 0, "round_robin"],
        [300, "gost", 20, 21, "tls", null, 1, "round_robin"],
        [400, "nginx", 30, 31, "nginx_stream", null, 1, "round_robin"],
        [500, "no-lb", 40, 41, "tls", null, 0, "round_robin"],
        [600, "none-strategy", 50, 51, "nginx_stream", null, 1, "none"],
      ];
      for (const [id, name, entryHostId, exitHostId, mode, entryGroupId, loadBalanceEnabled, strategy] of tunnels) {
        await runtime.executeRaw(
          'INSERT INTO "tunnels" ("id", "name", "entryGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, name, entryGroupId, entryHostId, exitHostId, mode, 20000 + id, loadBalanceEnabled, strategy, 1],
        );
      }

      const exitNodes = [
        [3001, 300, 1, 22, 30301, 1],
        [3002, 300, 2, 23, 30302, 0],
        [4001, 400, 1, 32, 30401, 1],
        [5001, 500, 1, 42, 30501, 1],
        [6001, 600, 1, 52, 30601, 1],
      ];
      for (const node of exitNodes) {
        await runtime.executeRaw(
          'INSERT INTO "tunnel_exit_nodes" ("id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
          node,
        );
      }
      await runtime.executeRaw(
        'INSERT INTO "forward_rule_tunnel_exits" ("ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort") VALUES (?, ?, ?, ?, ?, ?)',
        [300, 300, 3002, 2, 24, 30303],
      );

      const rules = [
        [100, 1, "local", null],
        [200, 10, "forwardx", 200],
        [300, 20, "gost", 300],
        [400, 30, "nginx", 400],
        [500, 40, "no-lb", 500],
        [600, 50, "none-strategy", 600],
      ];
      for (const [id, hostId, name, tunnelId] of rules) {
        await runtime.executeRaw(
          'INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, hostId, name, id === 400 || id === 600 ? "nginx" : "gost", "tcp", tunnelId, 10000 + id, "127.0.0.1", 80, 1],
        );
      }
      await runtime.executeRaw(
        'INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "tunnelId", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [700, 20, "ordinary-template", "gost", "tcp", 300, 700, 1, 10700, "127.0.0.1", 80, 2],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "tunnelId", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [701, 20, "stale-admin-child", "gost", "tcp", 300, 700, 700, 7001, 10700, "127.0.0.1", 80, 1],
      );

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const authorization = String(req.headers.authorization || "");
        req.agentToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        next();
      });
      reports.registerAgentReportRoutes(app);
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = "http://127.0.0.1:" + address.port;

      const first = await postTraffic(baseUrl, 1, "local-idempotent", 100, 100, 200);
      const duplicate = await postTraffic(baseUrl, 1, "local-idempotent", 100, 100, 200);
      assert.equal(first.status, 200);
      assert.equal(first.body.success, true);
      assert.deepEqual(duplicate, { status: 200, body: { success: true, duplicate: true } });
      assert.deepEqual(await trafficRows(100), [
        { hostId: 1, bytesIn: 100, bytesOut: 200, connections: 1 },
      ]);

      let injectedFailures = 0;
      runtime.requireSqlite().function("agent_traffic_fail_once", () => {
        injectedFailures += 1;
        if (injectedFailures === 1) throw new Error("injected first traffic write failure");
        return 1;
      });
      await runtime.executeRaw(
        'CREATE TRIGGER "agent_traffic_fail_once_trigger" BEFORE INSERT ON "traffic_stats" BEGIN SELECT agent_traffic_fail_once(); END',
      );
      const failed = await postTraffic(baseUrl, 1, "retry-after-rollback", 100, 5, 7);
      const retried = await postTraffic(baseUrl, 1, "retry-after-rollback", 100, 5, 7);
      assert.equal(failed.status, 500);
      assert.equal(retried.status, 200);
      assert.equal(retried.body.success, true);
      await runtime.executeRaw('DROP TRIGGER "agent_traffic_fail_once_trigger"');

      let concurrentFailures = 0;
      runtime.requireSqlite().function("agent_traffic_concurrent_fail_once", () => {
        concurrentFailures += 1;
        if (concurrentFailures === 1) throw new Error("injected concurrent traffic write failure");
        return 1;
      });
      await runtime.executeRaw(
        'CREATE TRIGGER "agent_traffic_concurrent_fail_once_trigger" BEFORE INSERT ON "traffic_stats" BEGIN SELECT agent_traffic_concurrent_fail_once(); END',
      );
      const concurrent = await Promise.all([
        postTraffic(baseUrl, 1, "concurrent-rollback", 100, 2, 3),
        postTraffic(baseUrl, 1, "concurrent-rollback", 100, 2, 3),
      ]);
      assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 500]);
      await runtime.executeRaw('DROP TRIGGER "agent_traffic_concurrent_fail_once_trigger"');
      assert.equal(
        (await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "traffic_stats" WHERE "ruleId" = ? AND "bytesIn" = ? AND "bytesOut" = ?', [100, 2, 3]))[0].count,
        1,
      );

      await runtime.executeRaw('ALTER TABLE "tunnel_exit_nodes" RENAME TO "tunnel_exit_nodes_unavailable"');
      const topologyFailure = await postTraffic(baseUrl, 21, "topology-rollback", 300, 11, 13);
      assert.equal(topologyFailure.status, 500);
      assert.equal(
        (await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "agent_traffic_reports" WHERE "hostId" = ? AND "reportId" = ?', [21, "topology-rollback"]))[0].count,
        0,
      );
      await runtime.executeRaw('ALTER TABLE "tunnel_exit_nodes_unavailable" RENAME TO "tunnel_exit_nodes"');
      const topologyRetry = await postTraffic(baseUrl, 21, "topology-rollback", 300, 11, 13);
      assert.equal(topologyRetry.status, 200);
      assert.equal(topologyRetry.body.success, true);

      const ordinaryFirst = await postTraffic(baseUrl, 21, "ordinary-owner-first", 701, 37, 43);
      const ordinarySecond = await postTraffic(baseUrl, 21, "ordinary-owner-second", 701, 5, 7);
      assert.equal(ordinaryFirst.status, 200);
      assert.equal(ordinaryFirst.body.success, true);
      assert.equal(ordinarySecond.status, 200);
      assert.equal(ordinarySecond.body.success, true);

      for (const request of [
        [10, "forwardx-primary", 200],
        [11, "forwardx-enabled-member", 200],
        [12, "forwardx-disabled-member", 200],
        [21, "gost-primary-exit", 300],
        [22, "gost-enabled-extra-exit", 300],
        [23, "gost-disabled-extra-exit", 300],
        [24, "gost-stale-rule-exit", 300],
        [31, "nginx-primary-exit", 400],
        [32, "nginx-enabled-extra-exit", 400],
        [41, "no-lb-primary-exit", 500],
        [42, "no-lb-extra-exit", 500],
        [51, "none-primary-exit", 600],
        [52, "none-extra-exit", 600],
      ]) {
        const [hostId, reportId, ruleId] = request;
        const result = await postTraffic(baseUrl, hostId, reportId, ruleId);
        assert.equal(result.status, 200, reportId);
        assert.equal(result.body.success, true, reportId);
      }

      assert.deepEqual(await trafficRows(200), [
        { hostId: 10, bytesIn: 10, bytesOut: 20, connections: 1 },
        { hostId: 11, bytesIn: 10, bytesOut: 20, connections: 1 },
      ]);
      assert.deepEqual(await trafficRows(300), [
        { hostId: 21, bytesIn: 21, bytesOut: 33, connections: 2 },
        { hostId: 22, bytesIn: 10, bytesOut: 20, connections: 1 },
      ]);
      assert.deepEqual(await trafficRows(400), [
        { hostId: 31, bytesIn: 10, bytesOut: 20, connections: 1 },
        { hostId: 32, bytesIn: 10, bytesOut: 20, connections: 1 },
      ]);
      assert.deepEqual(await trafficRows(500), [
        { hostId: 41, bytesIn: 10, bytesOut: 20, connections: 1 },
      ]);
      assert.deepEqual(await trafficRows(600), [
        { hostId: 51, bytesIn: 10, bytesOut: 20, connections: 1 },
      ]);
      assert.deepEqual(await trafficRows(701), [
        { hostId: 21, bytesIn: 42, bytesOut: 50, connections: 2 },
      ]);
      assert.deepEqual(
        await runtime.queryRaw('SELECT "userId", "bytesIn", "bytesOut", "connections" FROM "forward_rule_traffic_counters" WHERE "ruleId" = ?', [701]),
        [{ userId: 2, bytesIn: 42, bytesOut: 50, connections: 2 }],
      );
      assert.deepEqual(
        await runtime.queryRaw('SELECT "bytesIn", "bytesOut", "connections" FROM "user_traffic_counters" WHERE "userId" = ?', [2]),
        [{ bytesIn: 42, bytesOut: 50, connections: 2 }],
      );
      const ordinarySummary = await metrics.getTrafficCounterSummaryByRule({
        userId: 2,
        ruleIds: [700],
        includeLatency: false,
      });
      assert.deepEqual(
        ordinarySummary.map(({ ruleId, bytesIn, bytesOut, connections }) => ({ ruleId, bytesIn, bytesOut, connections })),
        [{ ruleId: 700, bytesIn: 42, bytesOut: 50, connections: 2 }],
      );

      const adminSummed = (await runtime.queryRaw(
        'SELECT COALESCE(SUM("bytesIn" + "bytesOut"), 0) AS "total" FROM "traffic_stats" WHERE "ruleId" <> ?',
        [701],
      ))[0].total;
      const ordinarySummed = (await runtime.queryRaw(
        'SELECT COALESCE(SUM("bytesIn" + "bytesOut"), 0) AS "total" FROM "traffic_stats" WHERE "ruleId" = ?',
        [701],
      ))[0].total;
      const admin = (await runtime.queryRaw('SELECT "trafficUsed" FROM "users" WHERE "id" = 1'))[0];
      const ordinary = (await runtime.queryRaw('SELECT "trafficUsed" FROM "users" WHERE "id" = 2'))[0];
      assert.equal(admin.trafficUsed, adminSummed, "admin quota traffic must include only admin-owned rules");
      assert.equal(ordinary.trafficUsed, ordinarySummed, "ordinary quota traffic must include its shared-resource rules");
    } finally {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 90_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

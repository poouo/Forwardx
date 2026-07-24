import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("traffic reports batch raw samples and counters without losing totals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-batch-"));
  const databasePath = path.join(directory, "traffic.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    const rules = await import(url("server/repositories/forwardRuleRepository.ts"));
    const billing = await import(url("server/repositories/trafficBillingRepository.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const sqlite = runtime.requireSqlite();
      const countStatements = async (work) => {
        const originalPrepare = sqlite.prepare;
        let count = 0;
        sqlite.prepare = function (...args) {
          count += 1;
          return originalPrepare.apply(this, args);
        };
        try {
          return { value: await work(), count };
        } finally {
          sqlite.prepare = originalPrepare;
        }
      };
      await runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 100, bytesOut: 50, connections: 1 }, userId: 7 },
          { stat: { ruleId: 11, hostId: 5, bytesIn: 20, bytesOut: 10, connections: 2 }, userId: 7 },
          { stat: { ruleId: 12, hostId: 5, bytesIn: 7, bytesOut: 8, connections: 1 }, userId: 7 },
        ]);
      });

      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stats"))[0].count, 3);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 127, bytesOut: 68, connections: 4 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT ruleId, bytesIn, bytesOut, connections FROM forward_rule_traffic_counters ORDER BY ruleId"),
        [
          { ruleId: 11, bytesIn: 120, bytesOut: 60, connections: 3 },
          { ruleId: 12, bytesIn: 7, bytesOut: 8, connections: 1 },
        ],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT ruleId, bytesIn, bytesOut, connections FROM traffic_stat_buckets ORDER BY ruleId"),
        [
          { ruleId: 11, bytesIn: 120, bytesOut: 60, connections: 3 },
          { ruleId: 12, bytesIn: 7, bytesOut: 8, connections: 1 },
        ],
      );

      await runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 5, bytesOut: 6, connections: 1 }, userId: 7 },
        ]);
      });
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stats"))[0].count, 4);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 132, bytesOut: 74, connections: 5 }],
      );

      await Promise.all(Array.from({ length: 20 }, () => runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 1, bytesOut: 2, connections: 1 }, userId: 7 },
        ]);
      })));
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 152, bytesOut: 114, connections: 25 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE ruleId = 11 AND hostId = 5"),
        [{ bytesIn: 145, bytesOut: 106, connections: 24 }],
      );

      await metrics.recordHostTrafficSample(5, { bytesIn: 1000, bytesOut: 2000 });
      await metrics.recordHostTrafficSample(5, { bytesIn: 1300, bytesOut: 2600 });
      await metrics.recordHostTrafficSample(5, { bytesIn: 100, bytesOut: 200 });
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, lastSystemIn, lastSystemOut, lastDeltaIn, lastDeltaOut FROM host_traffic_counters WHERE hostId = 5"),
        [{ bytesIn: 300, bytesOut: 600, lastSystemIn: 100, lastSystemOut: 200, lastDeltaIn: 0, lastDeltaOut: 0 }],
      );

      await runtime.executeRaw("INSERT INTO users (id, username, password, trafficLimit, trafficUsed, expiresAt) VALUES (7, 'traffic-user', 'hash', 1000, 100, 2000000000)");
      const userUpdate = await countStatements(() => users.addUserTraffic(7, 150));
      const updatedUser = userUpdate.value;
      assert.equal(userUpdate.count, 1);
      assert.equal(updatedUser.trafficUsed, 250);
      assert.ok(updatedUser.expiresAt instanceof Date);

      await runtime.executeRaw("INSERT INTO tunnels (id, name, entryHostId, exitHostId, mode, listenPort, trafficMultiplier, userId) VALUES (21, 'traffic-tunnel', 5, 6, 'tls', 22021, 130, 7)");
      await runtime.executeRaw("INSERT INTO forward_groups (id, name, groupMode, targetIp, trafficMultiplier, userId) VALUES (31, 'traffic-chain', 'chain', '127.0.0.1', 170, 7)");
      await runtime.executeRaw("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority) VALUES (311, 31, 'host', 5, 20), (312, 31, 'host', 6, 10)");
      await runtime.executeRaw("INSERT INTO forward_rules (id, hostId, name, tunnelId, forwardGroupId, forwardGroupRuleId, forwardGroupMemberId, sourcePort, targetIp, targetPort, userId) VALUES (11, 5, 'chain-rule', 21, 31, 310, 312, 12011, '127.0.0.1', 80, 7), (12, 5, 'local-rule', NULL, NULL, NULL, NULL, 12012, '127.0.0.1', 80, 7)");

      const contextQuery = await countStatements(() => rules.getForwardRuleTrafficContextsByIds([12, 11, 11, 0]));
      const contexts = contextQuery.value;
      assert.equal(contextQuery.count, 2);
      assert.equal(contexts.length, 2);
      const contextsById = new Map(contexts.map((context) => [Number(context.rule.id), context]));
      assert.deepEqual(contextsById.get(11).group.members.map((member) => Number(member.id)), [312, 311]);
      assert.equal(contextsById.get(11).tunnel.exitHostId, 6);
      assert.equal(contextsById.get(11).tunnel.trafficMultiplier, 130);
      assert.equal(contextsById.get(12).group, null);
      assert.equal(contextsById.get(12).tunnel, null);

      await runtime.executeRaw("INSERT INTO traffic_billing_configs (resourceType, resourceId, enabled, requiresPermission, pricePerGbCents, multiplier) VALUES ('host', 5, 1, 0, 1, 100), ('tunnel', 21, 1, 0, 1, 100), ('forward_group', 31, 1, 0, 1, 100)");
      let resourceQuery = await countStatements(() => billing.findTrafficBillingResourcesForRules(contexts.map((context) => context.rule)));
      let resources = resourceQuery.value;
      assert.equal(resourceQuery.count, 1);
      assert.equal(resources.get(11).resourceType, "forward_group");
      assert.equal(resources.get(12).resourceType, "host");
      await runtime.executeRaw("UPDATE traffic_billing_configs SET enabled = 0 WHERE resourceType = 'forward_group' AND resourceId = 31");
      resourceQuery = await countStatements(() => billing.findTrafficBillingResourcesForRules(contexts.map((context) => context.rule)));
      resources = resourceQuery.value;
      assert.equal(resourceQuery.count, 1);
      assert.equal(resources.get(11).resourceType, "tunnel");
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

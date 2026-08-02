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
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      await assert.rejects(
        runtime.withDatabaseTransaction(async () => {
          assert.equal(await metrics.claimAgentTrafficReport(5, "producer-report-1", "agent-producer"), true);
          throw new Error("rollback traffic report");
        }),
        /rollback traffic report/,
      );
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "producer-report-1", "agent-producer")), true);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "producer-report-1", "agent-producer")), false);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "producer-report-2", "agent-producer")), true);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "producer-report-2", "agent-producer")), false);
      const concurrentClaims = await Promise.all(Array.from({ length: 8 }, () =>
        runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "concurrent-report", "fxp-producer"))));
      assert.equal(concurrentClaims.filter(Boolean).length, 1);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "legacy-retained")), true);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "legacy-expired")), true);
      const nowSeconds = Math.floor(Date.now() / 1000);
      await runtime.executeRaw("UPDATE agent_traffic_reports SET receivedAt = ? WHERE producerId IS NOT NULL", [nowSeconds - 30 * 24 * 60 * 60]);
      await runtime.executeRaw("UPDATE agent_traffic_reports SET receivedAt = ? WHERE reportId = 'legacy-retained'", [nowSeconds - 8 * 24 * 60 * 60]);
      assert.equal(await runtime.withDatabaseTransaction(() => metrics.claimAgentTrafficReport(5, "legacy-retained")), false);
      await runtime.executeRaw("UPDATE agent_traffic_reports SET receivedAt = ? WHERE reportId = 'legacy-expired'", [nowSeconds - 8 * 24 * 60 * 60]);
      await metrics.cleanOldTrafficStats(72);
      assert.deepEqual(
        await runtime.queryRaw("SELECT producerId, reportId FROM agent_traffic_reports ORDER BY producerId, reportId"),
        [
          { producerId: null, reportId: "legacy-retained" },
          { producerId: "agent-producer", reportId: "producer-report-2" },
          { producerId: "fxp-producer", reportId: "concurrent-report" },
        ],
      );

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

      assert.deepEqual(metrics.allocateHostTrafficCorrection({ bytesIn: 300, bytesOut: 600 }, 450, "both"), { bytesIn: 150, bytesOut: 300 });
      assert.deepEqual(metrics.allocateHostTrafficCorrection({ bytesIn: 300, bytesOut: 600 }, 450, "outbound"), { bytesIn: 300, bytesOut: 450 });
      assert.deepEqual(metrics.allocateHostTrafficCorrection({ bytesIn: 300, bytesOut: 600 }, 450, "max"), { bytesIn: 225, bytesOut: 450 });
      assert.deepEqual(metrics.allocateHostTrafficCorrection({ bytesIn: 0, bytesOut: 0 }, 450, "both"), { bytesIn: 0, bytesOut: 450 });

      await metrics.correctHostTraffic(5, 450, "both");
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, lastSystemIn, lastSystemOut, lastDeltaIn, lastDeltaOut FROM host_traffic_counters WHERE hostId = 5"),
        [{ bytesIn: 150, bytesOut: 300, lastSystemIn: 100, lastSystemOut: 200, lastDeltaIn: 0, lastDeltaOut: 0 }],
      );
      await metrics.recordHostTrafficSample(5, { bytesIn: 150, bytesOut: 300 });
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, lastSystemIn, lastSystemOut, lastDeltaIn, lastDeltaOut FROM host_traffic_counters WHERE hostId = 5"),
        [{ bytesIn: 200, bytesOut: 400, lastSystemIn: 150, lastSystemOut: 300, lastDeltaIn: 50, lastDeltaOut: 100 }],
      );

      await metrics.correctHostTraffic(6, 700, "max");
      await metrics.recordHostTrafficSample(6, { bytesIn: 1000, bytesOut: 2000 });
      await metrics.recordHostTrafficSample(6, { bytesIn: 1100, bytesOut: 2200 });
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, lastSystemIn, lastSystemOut, lastDeltaIn, lastDeltaOut FROM host_traffic_counters WHERE hostId = 6"),
        [{ bytesIn: 100, bytesOut: 900, lastSystemIn: 1100, lastSystemOut: 2200, lastDeltaIn: 100, lastDeltaOut: 200 }],
      );

      await runtime.executeRaw("INSERT INTO users (id, username, password, role, trafficLimit, trafficUsed, expiresAt) VALUES (1, 'traffic-admin', 'hash', 'admin', 0, 0, 2000000000), (7, 'traffic-user', 'hash', 'user', 1000, 100, 2000000000)");
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
      assert.equal(contextQuery.count, 3);
      assert.equal(contexts.length, 2);
      const contextsById = new Map(contexts.map((context) => [Number(context.rule.id), context]));
      assert.deepEqual(
        contextsById.get(11).group.members.map((member) => [Number(member.id), Number(member.hostId)]),
        [[312, 6], [311, 5]],
      );
      assert.equal(contextsById.get(11).tunnel.exitHostId, 6);
      assert.equal(contextsById.get(11).tunnel.trafficMultiplier, 130);
      assert.equal(contextsById.get(12).group, null);
      assert.equal(contextsById.get(12).tunnel, null);

      await runtime.executeRaw("INSERT INTO traffic_billing_configs (resourceType, resourceId, enabled, requiresPermission, pricePerGbCents, multiplier) VALUES ('host', 5, 1, 0, 1, 100), ('tunnel', 21, 1, 0, 1, 100), ('forward_group', 31, 1, 0, 1, 100)");

      await billing.setTrafficBillingEnabled(false);
      await runtime.executeRaw('ALTER TABLE "system_settings" RENAME TO "system_settings_unavailable"');
      try {
        await assert.rejects(
          billing.getTrafficBillingEnabledForWrite(),
          /system_settings|no such table/i,
        );
        await assert.rejects(
          billing.billTrafficUsage({
            userId: 7,
            ruleId: 12,
            bytes: 1024,
            resourceType: "host",
            resourceId: 5,
          }),
          /system_settings|no such table/i,
        );
        await assert.rejects(
          billing.settleTrafficBillingRuleOnDelete({
            userId: 7,
            ruleId: 12,
            resourceType: "host",
            resourceId: 5,
          }),
          /system_settings|no such table/i,
        );
        await assert.rejects(
          runtime.withDatabaseTransaction(async () => {
            assert.equal(await metrics.claimAgentTrafficReport(5, "billing-switch-query-failure", "agent-producer"), true);
            await billing.billTrafficUsage({
              userId: 7,
              ruleId: 12,
              bytes: 1024,
              resourceType: "host",
              resourceId: 5,
            });
          }),
          /system_settings|no such table/i,
        );
        assert.equal(
          (await runtime.queryRaw("SELECT COUNT(*) AS count FROM agent_traffic_reports WHERE reportId = 'billing-switch-query-failure'"))[0].count,
          0,
          "a failed strict billing lookup must roll back the report claim",
        );
        assert.equal(
          (await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_billing_rule_usage WHERE ruleId = 12"))[0].count,
          0,
          "a failed strict billing lookup must not commit usage",
        );
      } finally {
        await runtime.executeRaw('ALTER TABLE "system_settings_unavailable" RENAME TO "system_settings"');
      }

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

      const trafficSince = new Date(Date.now() - 60 * 60 * 1000);
      await runtime.executeRaw("UPDATE forward_rules SET createdAt = ? WHERE id IN (11, 12)", [Math.floor(trafficSince.getTime() / 1000)]);
      await runtime.executeRaw("UPDATE forward_rules SET forwardGroupRuleId = NULL WHERE id = 11");
      await settings.setSetting("trafficStatBucketsBackfilled", "v3");
      await runtime.executeRaw("DELETE FROM traffic_stat_buckets WHERE ruleId = 12");
      await runtime.executeRaw("UPDATE traffic_stat_buckets SET bytesIn = 1, bytesOut = 2, connections = 1 WHERE ruleId = 11");

      await runtime.executeRaw("INSERT INTO forward_groups (id, name, groupMode, targetIp, userId) VALUES (32, 'shared-failover', 'failover', '127.0.0.1', 1)");
      await runtime.executeRaw("INSERT INTO forward_groups (id, name, groupMode, targetIp, userId) VALUES (33, 'unrelated-group', 'failover', '127.0.0.1', 1)");
      await runtime.executeRaw("INSERT INTO forward_group_members (id, groupId, memberType, hostId, priority) VALUES (321, 32, 'host', 5, 10)");
      await runtime.executeRaw("INSERT INTO forward_rules (id, hostId, name, forwardGroupId, forwardGroupRuleId, forwardGroupMemberId, isForwardGroupTemplate, sourcePort, targetIp, targetPort, userId, createdAt) VALUES (13, 5, 'ordinary-template', 32, NULL, NULL, 1, 12013, '127.0.0.1', 80, 7, ?), (14, 5, 'stale-admin-child', 32, 13, 321, 0, 12013, '127.0.0.1', 80, 1, ?), (15, 5, 'invalid-cross-group-parent', 33, 13, NULL, 0, 12015, '127.0.0.1', 80, 1, ?)", [Math.floor(trafficSince.getTime() / 1000), Math.floor(trafficSince.getTime() / 1000), Math.floor(trafficSince.getTime() / 1000)]);
      const ownershipContexts = await rules.getForwardRuleTrafficContextsByIds([14, 15]);
      assert.deepEqual(
        ownershipContexts.map((context) => ({ id: Number(context.rule.id), userId: Number(context.rule.userId) })).sort((a, b) => a.id - b.id),
        [{ id: 14, userId: 7 }, { id: 15, userId: 1 }],
      );
      const currentSeconds = Math.floor(Date.now() / 1000);
      const currentBucket = Math.floor(currentSeconds / (30 * 60)) * (30 * 60);
      await runtime.executeRaw("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, connections, recordedAt) VALUES (14, 5, 31, 47, 2, ?)", [currentSeconds]);
      await runtime.executeRaw("INSERT INTO forward_rule_traffic_counters (ruleId, hostId, userId, bytesIn, bytesOut, connections) VALUES (14, 5, 1, 31, 47, 2), (999, 5, 1, 53, 59, 3)");
      await runtime.executeRaw("INSERT INTO user_traffic_counters (userId, bytesIn, bytesOut, connections) VALUES (1, 84, 106, 5)");
      await runtime.executeRaw("INSERT INTO traffic_stat_buckets (bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections) VALUES (?, 30, 1, 14, 5, 31, 47, 2)", [currentBucket]);

      const ordinaryDaily = await metrics.getTrafficSummaryByRule({ userId: 7, ruleIds: [13], since: trafficSince, includeLatency: false });
      const ordinaryTotal = await metrics.getTrafficCounterSummaryByRule({ userId: 7, ruleIds: [13], includeLatency: false });
      assert.deepEqual(ordinaryDaily.map(({ ruleId, bytesIn, bytesOut, connections }) => ({ ruleId, bytesIn, bytesOut, connections })), [
        { ruleId: 13, bytesIn: 31, bytesOut: 47, connections: 2 },
      ]);
      assert.deepEqual(ordinaryTotal.map(({ ruleId, bytesIn, bytesOut, connections }) => ({ ruleId, bytesIn, bytesOut, connections })), [
        { ruleId: 13, bytesIn: 31, bytesOut: 47, connections: 2 },
      ]);
      assert.deepEqual(await metrics.getTrafficSummaryByRule({ userId: 1, ruleIds: [13], since: trafficSince, includeLatency: false }), []);

      await metrics.ensureUserTrafficCountersBackfilled();
      assert.deepEqual(
        await runtime.queryRaw("SELECT userId FROM forward_rule_traffic_counters WHERE ruleId = 14"),
        [{ userId: 7 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT DISTINCT userId FROM traffic_stat_buckets WHERE ruleId = 14"),
        [{ userId: 7 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT userId, bytesIn, bytesOut, connections FROM user_traffic_counters ORDER BY userId"),
        [
          { userId: 1, bytesIn: 53, bytesOut: 59, connections: 3 },
          { userId: 7, bytesIn: 183, bytesOut: 161, connections: 27 },
        ],
      );

      const countersBeforeFailedBackfill = await runtime.queryRaw(
        "SELECT ruleId, hostId, userId, bytesIn, bytesOut, connections FROM forward_rule_traffic_counters ORDER BY ruleId, hostId",
      );
      const usersBeforeFailedBackfill = await runtime.queryRaw(
        "SELECT userId, bytesIn, bytesOut, connections FROM user_traffic_counters ORDER BY userId",
      );
      await runtime.executeRaw("CREATE TRIGGER traffic_counter_backfill_fail BEFORE INSERT ON forward_rule_traffic_counters BEGIN SELECT RAISE(FAIL, 'forced traffic counter backfill failure'); END");
      try {
        await assert.rejects(
          metrics.ensureUserTrafficCountersBackfilled({ force: true }),
          /forced traffic counter backfill failure/,
        );
      } finally {
        await runtime.executeRaw("DROP TRIGGER traffic_counter_backfill_fail");
      }
      assert.deepEqual(
        await runtime.queryRaw("SELECT ruleId, hostId, userId, bytesIn, bytesOut, connections FROM forward_rule_traffic_counters ORDER BY ruleId, hostId"),
        countersBeforeFailedBackfill,
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT userId, bytesIn, bytesOut, connections FROM user_traffic_counters ORDER BY userId"),
        usersBeforeFailedBackfill,
      );

      const partialBucketSummary = await metrics.getTrafficSummaryByRule({
        userId: 7,
        ruleIds: [11, 12],
        since: trafficSince,
        includeLatency: false,
      });
      const summaryByRule = new Map(partialBucketSummary.map((row) => [Number(row.ruleId), row]));
      assert.deepEqual(
        {
          bytesIn: summaryByRule.get(11)?.bytesIn,
          bytesOut: summaryByRule.get(11)?.bytesOut,
          connections: summaryByRule.get(11)?.connections,
        },
        { bytesIn: 145, bytesOut: 106, connections: 24 },
      );
      assert.deepEqual(
        {
          bytesIn: summaryByRule.get(12)?.bytesIn,
          bytesOut: summaryByRule.get(12)?.bytesOut,
          connections: summaryByRule.get(12)?.connections,
        },
        { bytesIn: 7, bytesOut: 8, connections: 1 },
      );

      await runtime.executeRaw("DELETE FROM traffic_stat_buckets");
      const emptyBucketRuleSeries = await metrics.getTrafficSeriesByRule(12, { bucketMinutes: 30, since: trafficSince });
      assert.deepEqual(
        emptyBucketRuleSeries.map((row) => ({ bytesIn: row.bytesIn, bytesOut: row.bytesOut, connections: row.connections })),
        [{ bytesIn: 7, bytesOut: 8, connections: 1 }],
      );
      const emptyBucketGlobalSeries = await metrics.getGlobalTrafficSeries({ bucketMinutes: 30, since: trafficSince, userId: 7 });
      assert.equal(emptyBucketGlobalSeries.reduce((sum, row) => sum + row.bytesIn, 0), 183);
      assert.equal(emptyBucketGlobalSeries.reduce((sum, row) => sum + row.bytesOut, 0), 161);

      await runtime.executeRaw("DROP TABLE traffic_stat_buckets");
      const ruleSeries = await metrics.getTrafficSeriesByRule(12, { bucketMinutes: 30, since: trafficSince });
      assert.deepEqual(
        ruleSeries.map((row) => ({ bytesIn: row.bytesIn, bytesOut: row.bytesOut, connections: row.connections })),
        [{ bytesIn: 7, bytesOut: 8, connections: 1 }],
      );
      const globalSeries = await metrics.getGlobalTrafficSeries({ bucketMinutes: 30, since: trafficSince, userId: 7 });
      assert.equal(globalSeries.reduce((sum, row) => sum + row.bytesIn, 0), 183);
      assert.equal(globalSeries.reduce((sum, row) => sum + row.bytesOut, 0), 161);
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

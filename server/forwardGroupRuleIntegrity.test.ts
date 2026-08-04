import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("repairs orphaned and legacy forward-group rule references without touching valid rules", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-rule-integrity-"));
  const databasePath = path.join(directory, "integrity.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const integrity = await import(moduleUrl("server/forwardGroupRuleIntegrity.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password") VALUES (9, \'owner\', \'test\')');
    await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "userId") VALUES (7, \'host-7\', \'192.0.2.7\', 9), (8, \'host-8\', \'192.0.2.8\', 9)');
    await runtime.executeRaw('INSERT INTO "forward_groups" ("id", "name", "groupMode", "targetIp", "userId") VALUES (10, \'group-10\', \'failover\', \'127.0.0.1\', 9), (20, \'group-20\', \'failover\', \'127.0.0.1\', 9)');
    await runtime.executeRaw('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId", "updatedAt") VALUES (100, 10, \'host\', 7, 0, 11, 1), (101, 10, \'host\', 7, 1, 30, 1), (102, 10, \'host\', 7, 2, 999, 1), (103, 10, \'host\', 7, 3, 31, 1), (200, 20, \'host\', 7, 0, NULL, 1)');

    const insertRule = (id, hostId, forwardGroupId, forwardGroupRuleId, forwardGroupMemberId, isTemplate) => runtime.executeRaw(
      'INSERT INTO "forward_rules" ("id", "hostId", "name", "sourcePort", "targetIp", "targetPort", "userId", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "isEnabled", "pendingDelete", "isRunning", "updatedAt") VALUES (?, ?, ?, ?, \'127.0.0.1\', 80, 9, ?, ?, ?, ?, 1, 0, 1, 1)',
      [id, hostId, 'rule-' + id, 10000 + id, forwardGroupId, forwardGroupRuleId, forwardGroupMemberId, isTemplate ? 1 : 0],
    );

    await insertRule(10, 7, 10, null, null, true);
    await insertRule(20, 7, 20, null, null, true);
    await insertRule(11, 7, 10, 10, 100, false);
    await insertRule(12, 7, 10, 999, 100, false);
    await insertRule(13, 7, 10, 10, 999, false);
    await insertRule(14, 7, 10, 20, 100, false);
    await insertRule(15, 7, 10, 10, 200, false);
    await insertRule(16, 7, 999, 10, 100, false);
    await insertRule(17, 8, 10, 999, 100, false);
    await insertRule(30, 7, null, null, null, false);
    await insertRule(31, 7, null, null, null, false);
    await runtime.executeRaw('UPDATE "forward_rules" SET "name" = \'[组] group-10\', "sourcePort" = 1, "targetPort" = 1 WHERE "id" = 30');
    await runtime.executeRaw('UPDATE "system_settings" SET "value" = \'true\' WHERE "key" = \'trafficBillingEnabled\'');
    await runtime.executeRaw('INSERT INTO "traffic_billing_rule_usage" ("userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb", "pendingMilliCents", "settled") VALUES (9, 12, \'forward_group\', 10, 123, 0, 0, 0), (9, 17, \'forward_group\', 10, 456, 0, 0, 0), (9, 30, \'host\', 7, 789, 0, 0, 0)');

    assert.deepEqual(await integrity.repairForwardGroupRuleIntegrity(7), {
      orphanRules: 5,
      legacyRules: 1,
      legacyPointers: 4,
      orphanTemplates: 0,
    });

    assert.deepEqual(
      await runtime.queryRaw('SELECT "id", "isEnabled", "pendingDelete", "isRunning" FROM "forward_rules" ORDER BY "id"'),
      [
        { id: 10, isEnabled: 1, pendingDelete: 0, isRunning: 1 },
        { id: 11, isEnabled: 1, pendingDelete: 0, isRunning: 1 },
        { id: 12, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 13, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 14, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 15, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 16, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 17, isEnabled: 1, pendingDelete: 0, isRunning: 1 },
        { id: 20, isEnabled: 1, pendingDelete: 0, isRunning: 1 },
        { id: 30, isEnabled: 0, pendingDelete: 1, isRunning: 1 },
        { id: 31, isEnabled: 1, pendingDelete: 0, isRunning: 1 },
      ],
    );
    assert.deepEqual(
      await runtime.queryRaw('SELECT "id", "ruleId" FROM "forward_group_members" ORDER BY "id"'),
      [
        { id: 100, ruleId: null },
        { id: 101, ruleId: null },
        { id: 102, ruleId: null },
        { id: 103, ruleId: null },
        { id: 200, ruleId: null },
      ],
    );
    assert.deepEqual(
      await runtime.queryRaw('SELECT "ruleId", "settled" FROM "traffic_billing_rule_usage" ORDER BY "ruleId"'),
      [
        { ruleId: 12, settled: 1 },
        { ruleId: 17, settled: 0 },
        { ruleId: 30, settled: 1 },
      ],
    );

    assert.deepEqual(await integrity.repairForwardGroupRuleIntegrity(), {
      orphanRules: 1,
      legacyRules: 0,
      legacyPointers: 0,
      orphanTemplates: 0,
    });
    assert.deepEqual(
      await runtime.queryRaw('SELECT "isEnabled", "pendingDelete", "isRunning" FROM "forward_rules" WHERE "id" = 17'),
      [{ isEnabled: 0, pendingDelete: 1, isRunning: 1 }],
    );
    assert.deepEqual(
      await runtime.queryRaw('SELECT "ruleId", "settled" FROM "traffic_billing_rule_usage" ORDER BY "ruleId"'),
      [
        { ruleId: 12, settled: 1 },
        { ruleId: 17, settled: 1 },
        { ruleId: 30, settled: 1 },
      ],
    );
    assert.deepEqual(await integrity.repairForwardGroupRuleIntegrity(), {
      orphanRules: 0,
      legacyRules: 0,
      legacyPointers: 0,
      orphanTemplates: 0,
    });
    await runtime.closeDatabase();
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
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("host deletion checks convert a hidden legacy member rule into releasable cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-rule-blocker-"));
  const databasePath = path.join(directory, "blocker.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name") VALUES (9, \'owner\', \'test\', \'Owner\')');
    await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "userId") VALUES (7, \'host-7\', \'192.0.2.7\', 9)');
    await runtime.executeRaw('INSERT INTO "forward_groups" ("id", "name", "groupMode", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId") VALUES (10, \'legacy\', \'failover\', \'iptables\', \'both\', 12000, \'127.0.0.1\', 80, 9)');
    await runtime.executeRaw('INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "ruleId") VALUES (100, 10, \'host\', 7, 0, 30)');
    await runtime.executeRaw('INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "gostMode", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isRunning") VALUES (30, 7, \'[组] legacy\', \'iptables\', \'both\', \'direct\', 12000, \'127.0.0.1\', 80, 9, 1, 0, 1)');

    assert.deepEqual(await hosts.getHostRuleDeleteBlockers(7), {
      ruleCount: 0,
      ruleOwners: [],
      managedRuleCount: 0,
      managedRuleOwners: [],
      pendingCleanupCount: 1,
    });
    assert.deepEqual(await runtime.queryRaw('SELECT "ruleId" FROM "forward_group_members" WHERE "id" = 100'), [{ ruleId: null }]);
    assert.equal(await hosts.releaseHostPendingRuleCleanup(7), 1);
    assert.deepEqual(await hosts.getHostRuleDeleteBlockers(7), {
      ruleCount: 0,
      ruleOwners: [],
      managedRuleCount: 0,
      managedRuleOwners: [],
      pendingCleanupCount: 0,
    });
    await runtime.closeDatabase();
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
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

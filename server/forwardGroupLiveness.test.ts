import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("confirmed Agent offline overrides fresh forwarding health and triggers DDNS failover", () => {
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
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const hostStatus = await import(moduleUrl("server/hostStatusNotifier.ts"));

      const q = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        const placeholders = values.map(() => "?").join(", ");
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
          values,
        );
      };
      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const [id, name, address, lastHeartbeat] of [
        [1, "primary", "198.51.100.10", nowSeconds - 151],
        [2, "standby", "198.51.100.20", nowSeconds],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
          [id, name, address, address, 1, 1, lastHeartbeat],
        );
      }

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds", "recoverSeconds", "autoFailback"],
        [10, "failover", "host", "failover", "failover.example.test", "A", "0.0.0.0", 1, 1, 101, "198.51.100.10", 10, 120, 0],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds", "recoverSeconds"],
        [20, "entry", "host", "entry", "entry.example.test", "A", "0.0.0.0", 1, 1, 201, "198.51.100.10,198.51.100.20", 10, 10],
      );
      for (const [id, groupId, hostId, priority] of [
        [101, 10, 1, 0],
        [102, 10, 2, 1],
        [201, 20, 1, 0],
        [202, 20, 2, 1],
      ]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled", "healthStatus", "lastCheckedAt", "healthySince"],
          [id, groupId, "host", hostId, priority, 1, "healthy", nowSeconds, nowSeconds - 20],
        );
      }
      await runtime.executeRaw('UPDATE "forward_group_members" SET "failureSince" = ? WHERE "id" IN (101, 201)', [nowSeconds - 20]);
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
        await insert(
          "tcping_stats",
          ["ruleId", "hostId", "latencyMs", "isTimeout", "healthStatus", "healthPending", "recordedAt"],
          [id, hostId, 10, 0, "healthy", 0, nowSeconds],
        );
      }

      const offlineAt = Date.now();
      await hostStatus.handlePresenceCapableHostOffline({
        kind: "confirmed-offline",
        hostId: 1,
        agentVersion: "2.2.186",
        transitionEpoch: 1,
        lastSeenAt: (nowSeconds - 20) * 1000,
        deadlineAt: offlineAt,
        offlineAt,
        lastOfflineAt: offlineAt,
        confirmedOffline: true,
        isCurrent: () => true,
      });
      const deadline = Date.now() + 2_000;
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

      assert.equal((await runtime.queryRaw('SELECT "isOnline" FROM "hosts" WHERE "id" = 1'))[0]?.isOnline, 0);
      assert.equal(Number(failoverState?.activeMemberId), 102);
      assert.equal(failoverState?.lastDdnsValue, "198.51.100.20");
      assert.equal(Number(entryState?.activeMemberId), 202);
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

test("presence-capable hosts stay eligible during panel startup grace", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-startup-grace-"));
  const databasePath = path.join(directory, "startup-grace.db");
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
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const fastLiveness = await import(moduleUrl("server/agentFastLiveness.ts"));
      const now = Math.floor(Date.now() / 1000);

      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "agentVersion") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [1, "primary", "198.51.100.10", "198.51.100.10", 1, 0, now - 300, "2.2.171"],
      );
      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2, "standby", "198.51.100.20", "198.51.100.20", 1, 1, now],
      );
      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "isOnline", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [3, "never connected", "198.51.100.30", "198.51.100.30", 1, 0, now - 300, now - 300],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [30, "startup grace", "host", "failover", "0.0.0.0", 1, 1, 301, "198.51.100.10", 0],
      );
      for (const [id, hostId, priority] of [[301, 1, 0], [302, 2, 1]]) {
        await runtime.executeRaw(
          'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
          [id, 30, "host", hostId, priority, 1],
        );
      }
      await runtime.executeRaw(
        'INSERT INTO "forward_groups" ("id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId", "lastDdnsValue", "failoverSeconds") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [31, "legacy no heartbeat", "host", "failover", "0.0.0.0", 1, 1, 311, "198.51.100.30", 0],
      );
      for (const [id, hostId, priority] of [[311, 3, 0], [312, 2, 1]]) {
        await runtime.executeRaw(
          'INSERT INTO "forward_group_members" ("id", "groupId", "memberType", "hostId", "priority", "isEnabled") VALUES (?, ?, ?, ?, ?, ?)',
          [id, 31, "host", hostId, priority, 1],
        );
      }

      assert.equal(await groups.primeForwardGroupHostLivenessDeadlines(), 1);
      assert.equal(fastLiveness.getPresenceCapableHostLivenessSnapshot(1)?.confirmedOffline, false);
      await groups.runForwardGroupFailover(30);

      const [state] = await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 30',
      );
      assert.equal(Number(state?.activeMemberId), 301);
      assert.equal(state?.lastDdnsValue, "198.51.100.10");

      await groups.runForwardGroupFailover(31);
      const [legacyState] = await runtime.queryRaw(
        'SELECT "activeMemberId", "lastDdnsValue" FROM "forward_groups" WHERE "id" = 31',
      );
      assert.equal(Number(legacyState?.activeMemberId), 312, "a legacy host with no activity cannot remain available forever");
      assert.equal(legacyState?.lastDdnsValue, "198.51.100.20");
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

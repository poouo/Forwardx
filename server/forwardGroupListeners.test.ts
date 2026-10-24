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
        "id", "name", "groupType", "groupMode", "forwardType", "failoverRuntimeInheritanceEnabled", "proxyProtocolSend", "proxyProtocolVersion", "domain", "recordType", "targetIp",
        "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback",
      ], [10, "group", "host", "failover", " GOST ", 1, 1, 2, "edge.example.test", "A", "0.0.0.0", 1, 1, null, 60, 120, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
      ], [100, 1, "template", "realm", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 0]);

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10);
      const children = await runtime.queryRaw(
        'SELECT "forwardGroupMemberId", "hostId", "sourcePort", "forwardType", "proxyProtocolSend", "proxyProtocolVersion", "isEnabled", "pendingDelete" FROM "forward_rules" WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0 ORDER BY "forwardGroupMemberId"',
        [10],
      );
      assert.deepEqual(children, [
        { forwardGroupMemberId: 101, hostId: 1, sourcePort: 16000, forwardType: "gost", proxyProtocolSend: 1, proxyProtocolVersion: 2, isEnabled: 1, pendingDelete: 0 },
        { forwardGroupMemberId: 102, hostId: 2, sourcePort: 16000, forwardType: "gost", proxyProtocolSend: 1, proxyProtocolVersion: 2, isEnabled: 1, pendingDelete: 0 },
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

test("maintenance skips unchanged unavailable children without suppressing config changes or recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-maintenance-"));
  const databasePath = path.join(directory, "maintenance.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(key => '"' + key + '"').join(',')
        + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const rows = () => runtime.queryRaw('SELECT * FROM forward_rules WHERE forwardGroupId = 10 AND isForwardGroupTemplate = 0 AND pendingDelete = 0 ORDER BY id');
    const clear = () => runtime.executeRaw('DELETE FROM rule_updates');
    const changedHosts = async (groupId = 10) => (await runtime.queryRaw(
      'SELECT DISTINCT r.hostId FROM rule_updates u JOIN forward_rules r ON r.id = u.ruleId WHERE r.forwardGroupId = ? ORDER BY r.hostId', [groupId]
    )).map(row => Number(row.hostId));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      for (const id of [1, 2, 3, 4]) {
        await insert('hosts', { id, name: 'host-' + id, ip: '198.51.100.' + id, userId: 1,
          isOnline: id === 2 ? 0 : 1, lastHeartbeat: id === 4 ? now - 3600 : now,
          trafficLimit: id === 3 ? 1000 : 0, trafficFailoverEnabled: id === 3 ? 1 : 0,
          trafficFailoverExcluded: id === 3 ? 1 : 0 });
      }
      await insert('forward_groups', { id: 10, name: 'group', groupType: 'host', groupMode: 'failover',
        forwardType: 'gost', failoverRuntimeInheritanceEnabled: 1, targetIp: '0.0.0.0', userId: 1, isEnabled: 1 });
      for (const hostId of [1, 2, 3, 4]) {
        await insert('forward_group_members', { id: 100 + hostId, groupId: 10, memberType: 'host', hostId, priority: hostId, isEnabled: 1 });
      }
      const addTemplate = (id) => insert('forward_rules', { id, hostId: 1, name: 'template-' + id,
        forwardType: 'gost', protocol: 'tcp', forwardGroupId: 10, isForwardGroupTemplate: 1,
        sourcePort: 16000 + id, targetIp: '203.0.113.80', targetPort: 80, userId: 1, isEnabled: 1, isRunning: 0 });
      await addTemplate(1000);
      await addTemplate(2000);
      const groups = await import(moduleUrl('server/repositories/forwardGroupRepository.ts'));
      const sync = () => groups.syncForwardGroupRules(10, { preserveRuntime: true });
      await sync();
      assert.equal((await rows()).length, 8);
      await runtime.executeRaw('CREATE TABLE rule_updates (ruleId INTEGER NOT NULL)');
      await runtime.executeRaw('CREATE TRIGGER audit_rule_update AFTER UPDATE ON forward_rules BEGIN INSERT INTO rule_updates VALUES (NEW.id); END');
      await sync();
      await sync();
      assert.deepEqual(await changedHosts(), [1], 'only online stopped children should be re-dispatched');

      // Metadata is still synchronized, without clearing an unavailable child's diagnostic.
      await runtime.executeRaw("UPDATE forward_rules SET runtimeDiagnostic = 'keep diagnostic' WHERE forwardGroupId = 10 AND isForwardGroupTemplate = 0");
      await runtime.executeRaw("UPDATE forward_rules SET name = 'renamed', telegramErrorNotifyEnabled = 1 WHERE isForwardGroupTemplate = 1");
      await clear();
      await sync();
      const renamed = await rows();
      assert.ok(renamed.every(row => row.name === '[Group:group] renamed' && row.telegramErrorNotifyEnabled === 1));
      assert.ok(renamed.filter(row => row.hostId !== 1).every(row => row.runtimeDiagnostic === 'keep diagnostic'));
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [1], 'metadata must not be rewritten when unchanged');

      await runtime.executeRaw('UPDATE forward_rules SET targetPort = 81 WHERE isForwardGroupTemplate = 1');
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [1, 2, 3, 4], 'configuration changes must reach unavailable hosts too');
      assert.ok((await rows()).every(row => row.targetPort === 81));

      await runtime.executeRaw('UPDATE hosts SET isOnline = 1, lastHeartbeat = ? WHERE id IN (2, 4)', [now]);
      await runtime.executeRaw('UPDATE hosts SET trafficFailoverExcluded = 0 WHERE id = 3');
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [1, 2, 3, 4], 'recovery must use a new host snapshot on the very next sync');

      // Running children are preserved, but previously omitted runtime fields must still be reconciled.
      await runtime.executeRaw('UPDATE forward_rules SET isRunning = 1 WHERE forwardGroupId = 10 AND isForwardGroupTemplate = 0');
      await runtime.executeRaw('UPDATE forward_rules SET blockHttp = 1 WHERE hostId = 2 AND isForwardGroupTemplate = 0');
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [2]);
      assert.ok((await rows()).filter(row => row.hostId === 2).every(row => row.blockHttp === 0));

      await runtime.executeRaw("UPDATE forward_rules SET isEnabled = 0, isRunning = 0, protocolBlockReason = 'blocked' WHERE hostId = 3 AND isForwardGroupTemplate = 0");
      await clear();
      await sync();
      assert.ok(!(await changedHosts()).includes(3), 'an unchanged blocked child must not be rewritten on an online host');
      await runtime.executeRaw('UPDATE forward_rules SET isEnabled = 1, protocolBlockReason = NULL WHERE hostId = 3 AND isForwardGroupTemplate = 0');

      const deletedId = (await rows()).find(row => row.hostId === 2).id;
      await runtime.executeRaw('UPDATE hosts SET isOnline = 0 WHERE id = 2');
      await runtime.executeRaw('UPDATE forward_rules SET pendingDelete = 1, isEnabled = 0, isRunning = 1 WHERE id = ?', [deletedId]);
      await sync();
      assert.equal((await rows()).filter(row => row.hostId === 2).length, 2, 'pending-delete children cannot be preserved as active listeners');
      assert.equal(Number((await runtime.queryRaw('SELECT pendingDelete FROM forward_rules WHERE id = ?', [deletedId]))[0].pendingDelete), 1);
      await runtime.executeRaw('UPDATE hosts SET isOnline = 1 WHERE id = 2');

      // Host SELECTs must not grow with template count. Count real SQL, not mocks.
      let hostSelects = 0;
      let restorePrepare;
      await runtime.withSqliteExclusive(sqlite => {
        const prepare = sqlite.prepare;
        sqlite.prepare = function(sql, ...args) {
          if (/\bfrom\s+"?hosts"?\b/i.test(sql)) hostSelects++;
          return prepare.call(this, sql, ...args);
        };
        restorePrepare = () => { sqlite.prepare = prepare; };
      });
      const measure = async () => {
        await runtime.executeRaw('UPDATE forward_rules SET isRunning = 1 WHERE forwardGroupId = 10 AND isForwardGroupTemplate = 0');
        hostSelects = 0;
        await sync();
        return hostSelects;
      };
      const small = await measure();
      for (let id = 3000; id < 3020; id++) await addTemplate(id);
      await sync();
      const large = await measure();
      restorePrepare();
      assert.ok(small > 0, 'SQL instrumentation must see host reads');
      assert.equal(large, small, 'host SELECT count must be independent of template count');

      // A disabled dependency should converge once, then perform zero rule UPDATEs.
      await runtime.executeRaw('UPDATE forward_groups SET isEnabled = 0 WHERE id = 10');
      await runtime.executeRaw('UPDATE forward_rules SET isRunning = 1 WHERE isForwardGroupTemplate = 1');
      await sync();
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [], 'disabled rules/templates must not be repeatedly rewritten');

      await runtime.executeRaw('DELETE FROM forward_group_members WHERE id = 104');
      await sync();
      assert.ok((await runtime.queryRaw('SELECT pendingDelete FROM forward_rules WHERE hostId = 4 AND isForwardGroupTemplate = 0')).every(row => row.pendingDelete === 1),
        'removed members must still have their listeners marked for deletion');
      await clear();
      await sync();
      assert.deepEqual(await changedHosts(), [], 'pending-delete listeners must not be rewritten every round');

      // The same no-op guarantee applies to chain children and disabled chain members.
      await runtime.executeRaw('UPDATE hosts SET isOnline = 0 WHERE id IN (2, 3)');
      await insert('forward_groups', { id: 20, name: 'chain', groupType: 'host', groupMode: 'chain',
        forwardType: 'gost', targetIp: '0.0.0.0', userId: 1, isEnabled: 1 });
      for (const hostId of [2, 3]) await insert('forward_group_members', {
        id: 200 + hostId, groupId: 20, memberType: 'host', hostId, priority: hostId, isEnabled: 1 });
      await insert('forward_rules', { id: 5000, hostId: 2, name: 'chain template', forwardType: 'gost', protocol: 'tcp',
        forwardGroupId: 20, isForwardGroupTemplate: 1, sourcePort: 31000, targetIp: '203.0.113.90', targetPort: 443,
        userId: 1, isEnabled: 1, isRunning: 0 });
      await groups.syncForwardGroupRules(20, { preserveRuntime: true });
      await clear();
      await groups.syncForwardGroupRules(20, { preserveRuntime: true });
      assert.deepEqual(await changedHosts(20), [], 'unchanged stopped chain children on offline hosts must not be rewritten');
      await runtime.executeRaw('UPDATE forward_rules SET targetPort = 444 WHERE id = 5000');
      await clear();
      await groups.syncForwardGroupRules(20, { preserveRuntime: true });
      assert.deepEqual(await changedHosts(20), [3], 'the final chain hop must still receive target changes');

      // Tunnel members use the same batched entry-host policy and no-op logic.
      await insert('tunnels', { id: 30, name: 'tls tunnel', mode: 'tls', entryHostId: 2, exitHostId: 3,
        listenPort: 35000, userId: 1, isEnabled: 1, isRunning: 1 });
      await insert('forward_groups', { id: 30, name: 'tunnel group', groupType: 'tunnel', groupMode: 'failover',
        targetIp: '0.0.0.0', userId: 1, isEnabled: 1 });
      await insert('forward_group_members', { id: 301, groupId: 30, memberType: 'tunnel', tunnelId: 30, priority: 0, isEnabled: 1 });
      await insert('forward_rules', { id: 6000, hostId: 2, name: 'tunnel template', forwardType: 'gost', protocol: 'tcp',
        forwardGroupId: 30, isForwardGroupTemplate: 1, sourcePort: 33000, targetIp: '203.0.113.100', targetPort: 443,
        userId: 1, isEnabled: 1, isRunning: 0 });
      await groups.syncForwardGroupRules(30, { preserveRuntime: true });
      await clear();
      await groups.syncForwardGroupRules(30, { preserveRuntime: true });
      assert.deepEqual(await changedHosts(30), [], 'unchanged offline tunnel children must not be rewritten');
      await runtime.executeRaw('UPDATE tunnels SET isEnabled = 0 WHERE id = 30');
      await groups.syncForwardGroupRules(30, { preserveRuntime: true });
      await clear();
      await groups.syncForwardGroupRules(30, { preserveRuntime: true });
      assert.deepEqual(await changedHosts(30), [], 'a disabled member tunnel must converge without repeated rule writes');
    } finally {
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

test("legacy failover groups keep child runtime fields until explicitly opted in", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-runtime-compat-"));
  const databasePath = path.join(directory, "runtime-compat.db");
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
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"], [1, "host-1", "198.51.100.10", "198.51.100.10", 1, 1, now]);
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "forwardType", "failoverRuntimeInheritanceEnabled",
        "proxyProtocolSend", "proxyProtocolVersion", "targetIp", "userId", "isEnabled",
      ], [10, "legacy", "host", "failover", "gost", 0, 1, 2, "0.0.0.0", 1, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
      ], [100, 1, "template", "realm", "tcp", 10, 1, 16000, "203.0.113.10", 80, 1, 1, 1]);

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      await forwardGroups.syncForwardGroupRules(10, { preserveRuntime: true });
      let children = await runtime.queryRaw(
        'SELECT "id", "forwardType", "proxyProtocolSend" FROM "forward_rules" WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0',
        [10],
      );
      assert.deepEqual(children.map((row) => ({ forwardType: row.forwardType, proxyProtocolSend: Number(row.proxyProtocolSend) })), [{ forwardType: "realm", proxyProtocolSend: 0 }]);
      const childId = Number(children[0].id);

      // Model the child state written by v2.3.278 and verify a background sync
      // does not silently rewrite it while the compatibility flag is off.
      await runtime.executeRaw('UPDATE "forward_rules" SET "forwardType" = ?, "proxyProtocolSend" = ?, "isRunning" = 1 WHERE "id" = ?', ["gost", 1, childId]);
      await forwardGroups.syncForwardGroupRules(10, { preserveRuntime: true });
      children = await runtime.queryRaw('SELECT "forwardType", "proxyProtocolSend" FROM "forward_rules" WHERE "id" = ?', [childId]);
      assert.deepEqual(children.map((row) => ({ forwardType: row.forwardType, proxyProtocolSend: Number(row.proxyProtocolSend) })), [{ forwardType: "gost", proxyProtocolSend: 1 }]);

      // An explicit group save opts in and intentionally reconciles the child.
      await forwardGroups.updateForwardGroup(10, { failoverRuntimeInheritanceEnabled: true });
      await forwardGroups.syncForwardGroupRules(10, { preserveRuntime: true });
      children = await runtime.queryRaw('SELECT "forwardType", "proxyProtocolSend", "proxyProtocolVersion" FROM "forward_rules" WHERE "id" = ?', [childId]);
      assert.deepEqual(children.map((row) => ({ forwardType: row.forwardType, proxyProtocolSend: Number(row.proxyProtocolSend), proxyProtocolVersion: Number(row.proxyProtocolVersion) })), [{ forwardType: "gost", proxyProtocolSend: 1, proxyProtocolVersion: 2 }]);
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

test("legacy failover compatibility scan only warns and never rewrites child rules", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-runtime-scan-"));
  const databasePath = path.join(directory, "runtime-scan.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const db = await import(moduleUrl("server/db.ts"));
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO \"" + table + "\" (" + columns.map((column) => "\"" + column + "\"").join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("forward_groups", [
        "id", "name", "groupMode", "forwardType", "failoverRuntimeInheritanceEnabled",
        "proxyProtocolSend", "proxyProtocolVersion", "targetIp", "userId",
      ], [10, "legacy", "failover", "realm", 0, 1, 2, "0.0.0.0", 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "proxyProtocolSend", "proxyProtocolVersion", "userId",
      ], [100, 1, "template", "realm", "tcp", 10, 1, 16000, "203.0.113.10", 80, 0, 1, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "proxyProtocolSend", "proxyProtocolVersion", "userId",
      ], [101, 1, "child", "realm", "tcp", 10, 100, 0, 16000, "203.0.113.10", 80, 1, 2, 1]);
      // Tunnel members derive runtime options from the tunnel, so they must not
      // be reported as a legacy group-level inheritance mismatch.
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "tunnelId", "proxyProtocolSend", "proxyProtocolVersion", "userId",
      ], [102, 1, "tunnel-child", "gost", "tcp", 10, 100, 0, 16001, "203.0.113.10", 80, 77, 0, 1, 1]);

      const before = await runtime.queryRaw(
        'SELECT "id", "forwardType", "proxyProtocolSend", "proxyProtocolVersion" FROM "forward_rules" WHERE "id" IN (101, 102) ORDER BY "id"',
      );
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      let affected;
      try {
        affected = await db.warnLegacyForwardGroupRuntimeInheritanceOnce();
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(affected, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /no rules were changed/);
      assert.match(warnings[0], /child rule IDs=101/);

      const after = await runtime.queryRaw(
        'SELECT "id", "forwardType", "proxyProtocolSend", "proxyProtocolVersion" FROM "forward_rules" WHERE "id" IN (101, 102) ORDER BY "id"',
      );
      assert.deepEqual(after, before);
      const marker = await runtime.queryRaw('SELECT "value" FROM "system_settings" WHERE "key" = ?', ["forward-group-runtime-inheritance-compat-v1"]);
      assert.equal(marker.length, 1);

      const secondWarnings = [];
      console.warn = (...args) => secondWarnings.push(args.join(" "));
      try {
        assert.equal(await db.warnLegacyForwardGroupRuntimeInheritanceOnce(), 0);
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(secondWarnings.length, 0);
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

test("forward chain allocates independent downstream listener ports", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-chain-ports-"));
  const databasePath = path.join(directory, "chain-ports.db");
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
      for (const [id, ip, rangeStart, rangeEnd] of [
        [1, "198.51.100.10", 12000, 12009],
        [2, "198.51.100.20", 22000, 22009],
        [3, "198.51.100.30", 32000, 32009],
        [4, "198.51.100.40", 42000, 42009],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "entryIp", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
          [id, "host-" + id, ip, ip, ip, 1, 1, now, rangeStart, rangeEnd],
        );
      }
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "forwardType", "targetIp", "userId", "isEnabled"],
        [20, "disjoint ranges", "host", "chain", "iptables", "0.0.0.0", 1, 1],
      );
      for (const [id, hostId, priority] of [[201, 1, 0], [202, 2, 1], [203, 3, 2]]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [id, 20, "host", hostId, priority, 1],
        );
      }
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [200, 1, "chain template", "iptables", "tcp", 20, 1, 12005, "203.0.113.80", 443, 1, 1, 0],
      );

      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const metrics = await import(moduleUrl("server/repositories/metricsRepository.ts"));
      await forwardGroups.validateForwardGroupRuleConfig(20, {
        sourcePort: 12005,
        protocol: "tcp",
        excludeTemplateRuleId: 200,
      });
      assert.deepEqual(await forwardGroups.getForwardGroupEntryPortRange(20), { start: 12000, end: 12009 });
      const available = await forwardGroups.findAvailableForwardGroupPort(20, 200, null, "tcp");
      assert.ok(available >= 12000 && available <= 12009, "public port was constrained by downstream ranges: " + available);

      await forwardGroups.syncForwardGroupRules(20);
      const children = await runtime.queryRaw(
        'SELECT "hostId", "sourcePort", "targetIp", "targetPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"',
        [200],
      );
      assert.equal(children.length, 3);
      assert.equal(Number(children[0].sourcePort), 12005);
      assert.ok(Number(children[1].sourcePort) >= 22000 && Number(children[1].sourcePort) <= 22009);
      assert.ok(Number(children[2].sourcePort) >= 32000 && Number(children[2].sourcePort) <= 32009);
      assert.equal(String(children[0].targetIp), "198.51.100.20");
      assert.equal(Number(children[0].targetPort), Number(children[1].sourcePort));
      assert.equal(String(children[1].targetIp), "198.51.100.30");
      assert.equal(Number(children[1].targetPort), Number(children[2].sourcePort));
      assert.equal(String(children[2].targetIp), "203.0.113.80");
      assert.equal(Number(children[2].targetPort), 443);

      const directProbes = await forwardGroups.getForwardGroupChainProbes(20, {
        includeFinalTarget: true,
        templateRule: {
          id: 200,
          sourcePort: 12005,
          targetIp: "203.0.113.80",
          targetPort: 443,
          protocol: "tcp",
        },
      });
      assert.deepEqual(directProbes.map((probe) => [probe.fromHostId, probe.targetPort]), [
        [1, Number(children[1].sourcePort)],
        [2, Number(children[2].sourcePort)],
        [3, 443],
      ]);

      const originalPorts = children.map((child) => Number(child.sourcePort));
      await forwardGroups.syncForwardGroupRules(20, { preserveRuntime: true });
      const resynced = await runtime.queryRaw(
        'SELECT "sourcePort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"',
        [200],
      );
      assert.deepEqual(resynced.map((child) => Number(child.sourcePort)), originalPorts);

      // Match the actual create route: a new template synchronizes all members,
      // but unchanged healthy children of existing templates must stay running.
      await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "forwardGroupId" = ? AND "isForwardGroupTemplate" = 0', [20]);
      const existingBeforeAdd = await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"', [200]);
      await forwardGroups.withForwardGroupSyncTransaction(20, () => insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [299, 1, "new chain template", "iptables", "tcp", 20, 1, 12006, "203.0.113.81", 443, 1, 1, 0],
      ), { preserveRuntime: true });
      const existingAfterAdd = await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"', [200]);
      assert.deepEqual(existingAfterAdd, existingBeforeAdd, "adding a rule rewrote or stopped existing chain listeners");
      const newChildren = await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "forwardGroupRuleId" = ?', [299]);
      assert.equal(newChildren.length, 3);
      assert.ok(newChildren.every((child) => Number(child.isRunning) === 0), "new listeners were incorrectly treated as already applied");

      const secondHopTargetPort = Number(children[1].targetPort);
      await runtime.executeRaw(
        'DELETE FROM "forward_rules" WHERE "forwardGroupRuleId" = ? AND "hostId" = ?',
        [200, 3],
      );
      await forwardGroups.syncForwardGroupRules(20, { validatePorts: false, createMissing: false });
      const partialChildren = await runtime.queryRaw(
        'SELECT "hostId", "targetPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"',
        [200],
      );
      assert.equal(partialChildren.length, 2, "incremental sync must not recreate a missing listener");
      assert.equal(
        Number(partialChildren[1].targetPort),
        secondHopTargetPort,
        "incremental sync must not point an existing hop at an uncreated listener port",
      );

      await forwardGroups.syncForwardGroupRules(20);

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
        [30, "external entry", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [301, 30, "host", 4, 0, 1],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "entryGroupId", "forwardType", "targetIp", "userId", "isEnabled"],
        [40, "external chain", "host", "chain", 30, "iptables", "0.0.0.0", 1, 1],
      );
      for (const [id, hostId, priority] of [[401, 1, 0], [402, 2, 1]]) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [id, 40, "host", hostId, priority, 1],
        );
      }
      assert.equal(
        await forwardGroups.getForwardGroupDefaultHostId(40),
        4,
        "an external-entry chain template must belong to its public entry host",
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [400, 4, "external chain template", "iptables", "tcp", 40, 1, 42005, "203.0.113.90", 8443, 1, 1, 0],
      );
      assert.deepEqual(await forwardGroups.getForwardGroupEntryPortRange(40), { start: 42000, end: 42009 });
      await forwardGroups.validateForwardGroupRuleConfig(40, {
        sourcePort: 42005,
        protocol: "tcp",
        excludeTemplateRuleId: 400,
      });
      await forwardGroups.syncForwardGroupRules(40);
      const externalChildren = await runtime.queryRaw(
        'SELECT "id", "hostId", "forwardGroupMemberId", "sourcePort", "targetPort" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "hostId"',
        [400],
      );
      assert.equal(externalChildren.length, 3);
      assert.ok(Number(externalChildren[0].sourcePort) >= 12000 && Number(externalChildren[0].sourcePort) <= 12009);
      assert.ok(Number(externalChildren[1].sourcePort) >= 22000 && Number(externalChildren[1].sourcePort) <= 22009);
      assert.equal(Number(externalChildren[2].sourcePort), 42005);
      assert.equal(Number(externalChildren[2].targetPort), Number(externalChildren[0].sourcePort));

      const externalProbes = await forwardGroups.getForwardGroupChainProbes(40, {
        includeFinalTarget: true,
        templateRule: {
          id: 400,
          sourcePort: 42005,
          targetIp: "203.0.113.90",
          targetPort: 8443,
          protocol: "tcp",
        },
      });
      assert.deepEqual(externalProbes.map((probe) => [probe.fromHostId, probe.targetPort]), [
        [4, Number(externalChildren[0].sourcePort)],
        [1, Number(externalChildren[1].sourcePort)],
        [2, 8443],
      ]);

      for (const [child, bytesIn] of [
        [externalChildren[0], 100],
        [externalChildren[1], 500],
        [externalChildren[2], 900],
      ]) {
        await insert(
          "forward_rule_traffic_counters",
          ["ruleId", "hostId", "userId", "bytesIn", "bytesOut", "connections"],
          [Number(child.id), Number(child.hostId), 1, bytesIn, bytesIn, 1],
        );
      }
      const traffic = await metrics.getTrafficCounterSummaryByRule({ ruleIds: [400], includeLatency: false });
      assert.equal(
        traffic.reduce((total, item) => total + Number(item.bytesIn) + Number(item.bytesOut), 0),
        200,
        "external entry and downstream listeners must not double-count chain traffic",
      );
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

test("forward chain synchronization is atomic and skips unnecessary allocations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-chain-atomic-"));
  const databasePath = path.join(directory, "chain-atomic.db");
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
    const addHost = (id, start, end) => insert(
      "hosts",
      ["id", "name", "ip", "ipv4", "entryIp", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
      [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, "198.51.100." + id, 1, 1, Math.floor(Date.now() / 1000), start, end],
    );
    const addChain = async (groupId, hostIds, entryGroupId = null) => {
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "entryGroupId", "forwardType", "targetIp", "userId", "isEnabled"],
        [groupId, "chain-" + groupId, "host", "chain", entryGroupId, "iptables", "0.0.0.0", 1, 1],
      );
      for (const [index, hostId] of hostIds.entries()) {
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [groupId * 10 + index + 1, groupId, "host", hostId, index, 1],
        );
      }
    };
    const addTemplate = (id, groupId, hostId, sourcePort, enabled = 1, createdAt = null) => insert(
      "forward_rules",
      ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "createdAt", "updatedAt"],
      [id, hostId, "template-" + id, "iptables", "tcp", groupId, 1, sourcePort, "203.0.113.80", 443, 1, enabled, 0, createdAt || Math.floor(Date.now() / 1000), createdAt || Math.floor(Date.now() / 1000)],
    );

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const forwardGroups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const taskLocks = await import(moduleUrl("server/keyedTaskLock.ts"));
      await insert(
        "users",
        ["id", "username", "password", "role", "canAddRules", "accountEnabled"],
        [1, "admin", "x", "admin", 1, 1],
      );

      for (const [id, start, end] of [
        [11, 11000, 11009], [12, 12000, 12009], [13, 13000, 13009],
        [21, 21000, 21009], [22, 22000, 22000],
        [31, 31000, 31009], [32, 32000, 32000],
        [41, 41000, 41009], [42, 42000, 42000],
        [51, 51000, 51009],
        [61, 61000, 61009], [62, 62000, 62009],
        [71, 63000, 63009], [72, 64000, 64009], [73, 65000, 65009],
        [81, 15000, 15009], [82, 16000, 16009],
      ]) await addHost(id, start, end);

      await addChain(100, [11, 12, 13]);
      await addTemplate(1000, 100, 11, 11001);
      await runtime.executeRaw(
        'CREATE TRIGGER "fail_chain_middle" BEFORE INSERT ON "forward_rules" '
          + 'WHEN NEW."forwardGroupRuleId" = 1000 AND NEW."hostId" = 12 '
          + 'BEGIN SELECT RAISE(ABORT, "injected-chain-write-failure"); END',
      );
      await assert.rejects(() => forwardGroups.syncForwardGroupRules(100), /injected-chain-write-failure/);
      await runtime.executeRaw('DROP TRIGGER "fail_chain_middle"');
      assert.equal(
        Number((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "forward_rules" WHERE "forwardGroupRuleId" = 1000'))[0].count),
        0,
        "a mid-chain write failure left a partial child topology",
      );

      await addChain(200, [21, 22]);
      await addTemplate(2000, 200, 21, 21001, 1, 200);
      await addTemplate(2001, 200, 21, 21002, 1, 100);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete"],
        [2099, 21, "stale-child", "iptables", "tcp", 200, 2000, 9999, 0, 21009, "203.0.113.80", 443, 1, 1, 1, 0],
      );
      await assert.rejects(() => forwardGroups.syncForwardGroupRules(200));
      const failedReplacementRows = await runtime.queryRaw(
        'SELECT "id", "pendingDelete" FROM "forward_rules" WHERE "forwardGroupRuleId" IS NOT NULL ORDER BY "id"',
      );
      assert.deepEqual(
        failedReplacementRows.filter((row) => Number(row.id) >= 2000 && Number(row.id) < 3000),
        [{ id: 2099, pendingDelete: 0 }],
        "allocation failure did not restore the previous child topology",
      );

      await addChain(300, [31, 32]);
      await addTemplate(3000, 300, 31, 31001, 1, 200);
      await addTemplate(3001, 300, 31, 31002, 0, 100);
      await forwardGroups.syncForwardGroupRules(300);
      const enabledTemplateChildren = await runtime.queryRaw(
        'SELECT "forwardGroupRuleId" FROM "forward_rules" WHERE "forwardGroupId" = 300 AND "forwardGroupRuleId" IS NOT NULL ORDER BY "id"',
      );
      assert.deepEqual(enabledTemplateChildren.map((row) => Number(row.forwardGroupRuleId)), [3000, 3000]);

      await addChain(400, [41, 42]);
      await addTemplate(4000, 400, 41, 41001);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [4099, 42, "occupied", "iptables", "tcp", 42000, "203.0.113.90", 443, 1, 1, 1],
      );
      await forwardGroups.syncForwardGroupRules(400, { createMissing: false, validatePorts: false });
      assert.equal(
        Number((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "forward_rules" WHERE "forwardGroupRuleId" = 4000'))[0].count),
        0,
      );

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"],
        [500, "entry-500", "host", "entry", "entry.example.test", "0.0.0.0", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [5001, 500, "host", 51, 0, 1],
      );
      await addChain(501, [51], 500);
      await assert.rejects(
        () => forwardGroups.validateForwardGroupRuleConfig(501, { sourcePort: 51001, protocol: "tcp" }),
        /Entry group host cannot also be used inside the port forwarding chain/,
      );

      await addChain(600, [61, 62]);
      await runtime.executeRaw(
        'CREATE TRIGGER "fail_new_chain_child" BEFORE INSERT ON "forward_rules" '
          + 'WHEN NEW."forwardGroupId" = 600 AND NEW."isForwardGroupTemplate" = 0 AND NEW."hostId" = 62 '
          + "BEGIN SELECT RAISE(ABORT, 'injected-new-chain-failure'); END",
      );
      await assert.rejects(
        () => forwardGroups.withForwardGroupSyncTransaction(600, () => addTemplate(6000, 600, 61, 61001)),
        /injected-new-chain-failure/,
      );
      assert.equal(
        Number((await runtime.queryRaw('SELECT COUNT(*) AS "count" FROM "forward_rules" WHERE "forwardGroupId" = 600'))[0].count),
        0,
        "a failed initial chain sync left its visible template behind",
      );

      await addChain(700, [71, 72]);
      await addTemplate(7000, 700, 71, 63001);
      await forwardGroups.syncForwardGroupRules(700);
      const forwardGroupService = await import(moduleUrl("server/services/forwardGroupService.ts"));
      await assert.rejects(() => forwardGroupService.updateForwardGroupFromInput(700, {
        name: "chain-700",
        groupMode: "chain",
        groupType: "host",
        protocol: "tcp",
        forwardType: "iptables",
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
        isEnabled: true,
        members: [
          { memberType: "host", hostId: 72, priority: 0, isEnabled: true },
          { memberType: "host", hostId: 71, priority: 1, isEnabled: true },
        ],
      }), /入口端口必须在允许范围内：64000-64009/);
      assert.deepEqual(
        (await runtime.queryRaw('SELECT "hostId" FROM "forward_group_members" WHERE "groupId" = 700 ORDER BY "priority"'))
          .map((row) => Number(row.hostId)),
        [71, 72],
        "an incompatible entry reorder did not restore the previous chain order",
      );
      await runtime.executeRaw(
        'CREATE TRIGGER "fail_updated_chain_child" BEFORE INSERT ON "forward_rules" '
          + 'WHEN NEW."forwardGroupId" = 700 AND NEW."isForwardGroupTemplate" = 0 AND NEW."hostId" = 73 '
          + "BEGIN SELECT RAISE(ABORT, 'injected-updated-chain-failure'); END",
      );
      await assert.rejects(() => forwardGroupService.updateForwardGroupFromInput(700, {
        name: "changed-chain-700",
        groupMode: "chain",
        groupType: "host",
        protocol: "tcp",
        forwardType: "iptables",
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
        isEnabled: true,
        members: [
          { memberType: "host", hostId: 71, priority: 0, isEnabled: true },
          { memberType: "host", hostId: 73, priority: 1, isEnabled: true },
        ],
      }), /injected-updated-chain-failure/);
      assert.equal(
        String((await runtime.queryRaw('SELECT "name" FROM "forward_groups" WHERE "id" = 700'))[0].name),
        "chain-700",
      );
      assert.deepEqual(
        (await runtime.queryRaw('SELECT "hostId" FROM "forward_group_members" WHERE "groupId" = 700 ORDER BY "priority"'))
          .map((row) => Number(row.hostId)),
        [71, 72],
        "a failed chain edit did not restore its previous members",
      );
      assert.deepEqual(
        (await runtime.queryRaw('SELECT "hostId", "pendingDelete" FROM "forward_rules" WHERE "forwardGroupRuleId" = 7000 ORDER BY "hostId"'))
          .map((row) => ({ hostId: Number(row.hostId), pendingDelete: Number(row.pendingDelete) })),
        [{ hostId: 71, pendingDelete: 0 }, { hostId: 72, pendingDelete: 0 }],
        "a failed chain edit did not restore its previous child topology",
      );

      await addChain(800, [81, 82]);
      await addTemplate(8000, 800, 81, 15001);
      await forwardGroups.syncForwardGroupRules(800);
      await runtime.executeRaw(
        'CREATE TRIGGER "fail_chain_rule_edit" BEFORE UPDATE ON "forward_rules" '
          + 'WHEN OLD."forwardGroupRuleId" = 8000 AND OLD."hostId" = 82 '
          + "BEGIN SELECT RAISE(ABORT, 'injected-chain-rule-edit-failure'); END",
      );
      const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
      const rules = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      await assert.rejects(
        () => rules.update({ id: 8000, targetPort: 8443 }),
        /injected-chain-rule-edit-failure/,
      );
      assert.equal(
        Number((await runtime.queryRaw('SELECT "targetPort" FROM "forward_rules" WHERE "id" = 8000'))[0].targetPort),
        443,
        "a failed rule edit left the visible chain template changed",
      );

      await addChain(900, [11, 12]);
      await addTemplate(9000, 900, 11, 11003);
      await forwardGroups.syncForwardGroupRules(900);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete"],
        [9099, 13, "stale-locked-child", "iptables", "tcp", 900, 9000, 9999, 0, 13001, "203.0.113.80", 443, 1, 1, 1, 0],
      );
      const billingLockKey = taskLocks.trafficBillingUserLockKey(1);
      let releaseBillingLock;
      let billingLockReady;
      const billingLockReleased = new Promise((resolve) => { releaseBillingLock = resolve; });
      const billingLockStarted = new Promise((resolve) => { billingLockReady = resolve; });
      const billingLock = taskLocks.withKeyedTaskLock(billingLockKey, async () => {
        billingLockReady();
        await billingLockReleased;
      });
      await billingLockStarted;
      const lockedSync = forwardGroups.syncForwardGroupRules(900);
      const lockQueueDeadline = Date.now() + 2_000;
      while (taskLocks.keyedTaskDepth(billingLockKey) < 2 && Date.now() < lockQueueDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(taskLocks.keyedTaskDepth(billingLockKey), 2, "chain cleanup did not defer billing until commit");
      const independentWrite = runtime.withDatabaseTransaction(() => runtime.executeRaw(
        'UPDATE "forward_groups" SET "name" = ? WHERE "id" = ?',
        ["chain-900-updated", 900],
      ));
      const databaseReleased = await Promise.race([
        independentWrite.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      releaseBillingLock();
      await Promise.all([billingLock, lockedSync, independentWrite]);
      assert.equal(databaseReleased, true, "chain cleanup waited for billing while holding the database transaction");
      assert.equal(
        Number((await runtime.queryRaw('SELECT "pendingDelete" FROM "forward_rules" WHERE "id" = 9099'))[0].pendingDelete),
        1,
      );
      await assert.rejects(
        () => runtime.withDatabaseTransaction(() => forwardGroups.syncForwardGroupRules(900)),
        /sync lock must be acquired before starting a database transaction/,
      );
      await assert.rejects(
        () => runtime.withDatabaseTransaction(() => forwardGroups.withForwardGroupSyncTransaction(900, async () => {})),
        /sync transaction must start before a database transaction/,
      );
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

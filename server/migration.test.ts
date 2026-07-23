import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMigrationRuntimeExpectations,
  pruneMigrationSnapshotForPanelBackup,
  type MigrationImportedIds,
  type MigrationSnapshot,
} from "./migration";
import {
  approveMigrationRequest,
  consumeApprovedMigrationRequest,
  consumeTakeoverToken,
  createMigrationCode,
  createMigrationRequest,
  prepareTakeoverToken,
} from "./migrationCodes";

function snapshot(tables: MigrationSnapshot["tables"]): MigrationSnapshot {
  return {
    version: 1,
    exportedAt: 2_000_000,
    tables,
  };
}

const importedIds: MigrationImportedIds = {
  hosts: { 1: 101, 2: 102 },
  tunnels: { 10: 110 },
  forwardRules: { 20: 120, 21: 121 },
};

test("essential snapshot pruning keeps business data and removes rebuildable history", () => {
  const result = pruneMigrationSnapshotForPanelBackup({
    ...snapshot({
      users: [{ id: 1, username: "admin" }],
      forward_rules: [{ id: 2, userId: 1 }],
      traffic_stats: [{ id: 3, ruleId: 2 }],
      traffic_stat_buckets: [{ id: 4, ruleId: 2 }],
      host_metrics: [{ id: 5, hostId: 1 }],
    }),
    dataScope: "essential",
    takeoverToken: "takeover-token",
  });
  assert.equal(result.tables.users.length, 1);
  assert.equal(result.tables.forward_rules.length, 1);
  assert.equal(result.tables.traffic_stats, undefined);
  assert.equal(result.tables.traffic_stat_buckets, undefined);
  assert.equal(result.tables.host_metrics, undefined);
  assert.equal(result.takeoverToken, "takeover-token");
});

test("backup import reports partial success after row-level failures instead of throwing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-partial-import-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        tables: {
          forward_rules: [{
            id: 1,
            hostId: 999,
            userId: 999,
            name: "orphan",
            forwardType: "gost",
            protocol: "tcp",
            sourcePort: 12000,
            targetIp: "example.com",
            targetPort: 443,
          }],
        },
      });
      assert.equal(result.success, true);
      assert.equal(result.partial, true);
      assert.equal(result.skippedRows, 1);
      assert.match(result.warnings[0], /其余数据已经导入/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("essential migration skips rebuildable history while SQLite direct migration copies the full database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-scope-migration-"));
  const sourcePath = path.join(directory, "source.db");
  const targetPath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import BetterSqlite3 from "better-sqlite3";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    const sourcePath = process.env.FORWARDX_SOURCE_DB;
    const targetPath = process.env.SQLITE_PATH;
    const now = Math.floor(Date.now() / 1000);

    const source = new BetterSqlite3(sourcePath);
    await schema.ensureDatabaseSchema(source);
    source.prepare("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'hash', 'admin')").run();
    source.prepare("INSERT INTO auth_sessions (id, sid, userId, kind, expiresAt) VALUES (1, 'session-1', 1, 'browser', ?)").run(now + 3600);
    source.prepare("INSERT INTO hosts (id, name, ip, userId, isOnline, lastHeartbeat) VALUES (1, 'edge', '192.0.2.1', 1, 1, ?)").run(now);
    source.prepare("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId, isEnabled, isRunning) VALUES (1, 'tunnel', 1, 1, 22000, 1, 1, 1)").run();
    source.prepare("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, tunnelId, sourcePort, targetIp, targetPort, userId, isEnabled, isRunning) VALUES (1, 1, 'rule', 'gost', 'tcp', 1, 12000, 'example.com', 443, 1, 1, 1)").run();
    source.prepare("INSERT INTO host_metrics (id, hostId, cpuUsage, recordedAt) VALUES (1, 1, 77, ?)").run(now);
    source.prepare("INSERT INTO tcping_stats (id, ruleId, hostId, latencyMs, isTimeout, recordedAt) VALUES (1, 1, 1, 33, 0, ?)").run(now);
    source.prepare("INSERT INTO host_traffic_counters (id, hostId, bytesIn, bytesOut) VALUES (1, 1, 1000, 2000)").run();
    source.prepare("INSERT INTO traffic_stat_buckets (id, bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections) VALUES (1, ?, 30, 1, 1, 1, 500, 600, 2)").run(now);
    source.prepare("UPDATE system_settings SET value = 'https://old.example.com' WHERE key = 'panelPublicUrl'").run();
    source.close();

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: sourcePath } });
      const exportProgress = [];
      const essential = await migration.exportMigrationSnapshot("https://old.example.com", {
        dataScope: "essential",
        onProgress: (progress) => exportProgress.push(progress),
      });
      assert.equal(essential.dataScope, "essential");
      assert.equal(essential.tables.users.length, 1);
      assert.equal(essential.tables.host_traffic_counters.length, 1);
      assert.equal(essential.tables.host_metrics, undefined);
      assert.equal(essential.tables.tcping_stats, undefined);
      assert.equal(essential.tables.traffic_stat_buckets, undefined);
      assert.equal(essential.tables.config_audit_events, undefined);
      assert.equal(exportProgress[0].status, "reading");
      assert.equal(exportProgress.at(-1).status, "complete");
      assert.equal(exportProgress.at(-1).tableIndex, exportProgress.at(-1).tableTotal);
      const full = await migration.exportMigrationSnapshot("https://old.example.com", { dataScope: "full" });
      assert.equal(full.tables.traffic_stat_buckets.length, 1);
      await runtime.closeDatabase();

      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: targetPath } });
      await schema.ensureDatabaseSchema();
      const direct = await migration.importDirectSqliteBackup({
        kind: "sqlite-direct",
        filePath: sourcePath,
        meta: {
          version: 1,
          format: "forwardx-sqlite-backup-v1",
          exportedAt: Date.now(),
          appVersion: "test",
          sourcePanelUrl: "https://old.example.com",
          takeoverToken: "TOKEN",
          dataScope: "full",
          byteLength: 1,
          sha256: "0".repeat(64),
        },
      }, "https://new.example.com");

      assert.equal(direct.result.transferMode, "sqlite-direct");
      assert.equal(direct.result.dataScope, "full");
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM users"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM host_metrics"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM tcping_stats"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stat_buckets"))[0].count, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM auth_sessions"))[0].count, 1);
      assert.equal(Number((await runtime.queryRaw("SELECT isOnline FROM hosts WHERE id = 1"))[0].isOnline), 0);
      assert.equal(Number((await runtime.queryRaw("SELECT isRunning FROM tunnels WHERE id = 1"))[0].isRunning), 0);
      assert.equal(Number((await runtime.queryRaw("SELECT isRunning FROM forward_rules WHERE id = 1"))[0].isRunning), 0);
      assert.equal((await runtime.queryRaw("SELECT value FROM system_settings WHERE key = 'panelPublicUrl'"))[0].value, "https://new.example.com");
    } finally {
      await runtime.closeDatabase();
    }

    const unchangedSource = new BetterSqlite3(sourcePath, { readonly: true });
    assert.equal(Number(unchangedSource.prepare("SELECT isOnline FROM hosts WHERE id = 1").get().isOnline), 1);
    unchangedSource.close();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        SQLITE_PATH: targetPath,
        FORWARDX_SOURCE_DB: sourcePath,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("structured restore batches 3,000 rules, isolates invalid rows, and preserves cumulative traffic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-structured-migration-"));
  const databasePath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    const now = Math.floor(Date.now() / 1000);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'temporary', 'admin')");

      const metrics = Array.from({ length: 10_000 }, (_, index) => ({
        id: 1_000 + index,
        hostId: 100,
        cpuUsage: index % 100,
        recordedAt: now + index,
      }));
      const rules = Array.from({ length: 3_000 }, (_, index) => ({
        id: 300 + index,
        hostId: 100,
        name: "rule-" + index,
        forwardType: "gost",
        protocol: index % 2 === 0 ? "tcp" : "udp",
        tunnelId: 200,
        sourcePort: 12_000 + index,
        targetIp: "target-" + index + ".example.com",
        targetPort: 20_000 + index,
        userId: 10,
        isEnabled: 1,
        isRunning: 1,
      }));
      const buckets = Array.from({ length: 240 }, (_, index) => ({
        id: 3_000 + index,
        bucketStart: now + index * 1_800,
        bucketMinutes: 30,
        userId: 10,
        ruleId: 300,
        hostId: 100,
        bytesIn: 1_000 + index,
        bytesOut: 2_000 + index,
        connections: index,
        updatedAt: now,
      }));
      const progress = [];
      const startedAt = Date.now();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        dataScope: "full",
        tables: {
          users: [{ id: 10, username: "admin", password: "source", role: "admin" }],
          hosts: [{ id: 100, name: "edge", ip: "192.0.2.1", userId: 10, isOnline: 1 }],
          tunnels: [{ id: 200, name: "tunnel", entryHostId: 100, exitHostId: 100, listenPort: 22000, userId: 10, isEnabled: 1, isRunning: 1 }],
          forward_rules: rules,
          host_metrics: [...metrics, { id: 99_999, hostId: 100, cpuUsage: 50, recordedAt: null }],
          forward_rule_traffic_counters: [{ id: 400, ruleId: 300, hostId: 100, userId: 10, bytesIn: 123456, bytesOut: 654321, connections: 7 }],
          user_traffic_counters: [{ id: 500, userId: 10, bytesIn: 123456, bytesOut: 654321, connections: 7 }],
          traffic_stat_buckets: buckets,
        },
      }, {
        onProgress: (value, step) => progress.push({ value, step }),
      });

      assert.equal(result.mode, "restore");
      assert.equal(result.partial, false);
      assert.equal(result.inserted.forward_rules, rules.length);
      assert.equal(result.inserted.host_metrics, metrics.length);
      assert.equal(result.skipped.host_metrics, 1);
      assert.equal(result.inserted.traffic_stat_buckets, buckets.length);
      assert.equal(result.reused.users, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM host_metrics"))[0].count, metrics.length);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, rules.length);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules WHERE isRunning <> 0"))[0].count, 0);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stat_buckets"))[0].count, buckets.length);
      assert.deepEqual(
        await runtime.queryRaw("SELECT id, userId, isOnline FROM hosts WHERE id = 100"),
        [{ id: 100, userId: 1, isOnline: 0 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT id, hostId, userId, isRunning FROM forward_rules WHERE id = 300"),
        [{ id: 300, hostId: 100, userId: 1, isRunning: 0 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE id = 400"),
        [{ bytesIn: 123456, bytesOut: 654321, connections: 7 }],
      );
      assert.ok(progress.some((item) => item.step.includes("host_metrics") && item.step.includes("/")));
      assert.ok(new Set(progress.map((item) => item.value)).size > 5);
      assert.ok(Date.now() - startedAt < 15_000, "3,000-rule structured migration exceeded 15 seconds");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental structured migration batches generated IDs and keeps valid rules when one row fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-incremental-migration-"));
  const databasePath = path.join(directory, "target.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migration = await import(moduleUrl("server/migration.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'temporary', 'admin')");
      await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId, agentToken) VALUES (1, 'existing', '192.0.2.1', 1, 'existing-token')");
      await runtime.executeRaw("INSERT INTO forward_rules (id, hostId, name, forwardType, protocol, sourcePort, targetIp, targetPort, userId) VALUES (1, 1, 'existing-rule', 'gost', 'tcp', 15000, 'existing.example.com', 443, 1)");
      await runtime.executeRaw("INSERT INTO forward_rule_traffic_counters (id, ruleId, hostId, userId, bytesIn, bytesOut, connections) VALUES (1, 1, 1, 1, 777, 888, 9)");
      await runtime.executeRaw("INSERT INTO user_traffic_counters (id, userId, bytesIn, bytesOut, connections) VALUES (1, 1, 777, 888, 9)");

      const rules = Array.from({ length: 3_000 }, (_, index) => ({
        id: 300 + index,
        hostId: 100,
        name: "incremental-rule-" + index,
        forwardType: "gost",
        protocol: index % 2 === 0 ? "tcp" : "udp",
        sourcePort: 16_000 + index,
        targetIp: "incremental-" + index + ".example.com",
        targetPort: 24_000 + index,
        userId: 10,
        isEnabled: true,
        isRunning: true,
      }));
      let importedIds = null;
      const startedAt = Date.now();
      const result = await migration.importMigrationSnapshot({
        version: 1,
        exportedAt: Date.now(),
        dataScope: "essential",
        tables: {
          users: [{ id: 10, username: "admin", password: "source", role: "admin" }],
          hosts: [{ id: 100, name: "new-edge", ip: "198.51.100.10", userId: 10, agentToken: "new-token", isOnline: true }],
          forward_rules: [
            ...rules,
            { id: 99_999, hostId: 100, name: null, forwardType: "gost", protocol: "tcp", sourcePort: 30_000, targetIp: "invalid.example.com", targetPort: 443, userId: 10 },
          ],
        },
      }, {
        onImportedIds: (value) => { importedIds = value; },
      });

      assert.equal(result.mode, "incremental");
      assert.equal(result.partial, true);
      assert.equal(result.inserted.forward_rules, rules.length);
      assert.equal(result.skipped.forward_rules, 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules"))[0].count, rules.length + 1);
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM forward_rules WHERE isRunning <> 0"))[0].count, 0);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE id = 1"),
        [{ bytesIn: 777, bytesOut: 888, connections: 9 }],
      );
      assert.ok(importedIds);
      assert.notEqual(importedIds.hosts[100], 100);
      const [importedHost] = await runtime.queryRaw("SELECT id, agentToken, isOnline FROM hosts WHERE id = ?", [importedIds.hosts[100]]);
      assert.equal(importedHost.agentToken, "new-token");
      assert.equal(importedHost.isOnline, 0);
      const [firstRule] = await runtime.queryRaw("SELECT id, hostId, userId FROM forward_rules WHERE name = ?", ["incremental-rule-0"]);
      assert.equal(firstRule.hostId, importedIds.hosts[100]);
      assert.equal(firstRule.userId, 1);
      assert.equal(importedIds.forwardRules[300], firstRule.id);
      assert.ok(Date.now() - startedAt < 15_000, "3,000-rule incremental migration exceeded 15 seconds");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration runtime expectations include fresh hosts and previously running resources", () => {
  const result = buildMigrationRuntimeExpectations(snapshot({
    hosts: [
      { id: 1, isOnline: true, lastHeartbeat: 1_990 },
      { id: 2, isOnline: true, lastHeartbeat: 1_000 },
    ],
    tunnels: [{ id: 10, isEnabled: true, isRunning: true }],
    forward_rules: [
      { id: 20, isEnabled: true, isRunning: true, pendingDelete: false },
      { id: 21, isEnabled: true, isRunning: false, pendingDelete: false },
    ],
  }), importedIds);

  assert.deepEqual(result.hostIds, [101]);
  assert.deepEqual(result.ruleIds, [120]);
  assert.deepEqual(result.tunnelIds, [110]);
  assert.deepEqual(result.allImportedHostIds, [101, 102]);
});

test("migration refuses active forwarding when no online Agent can be verified", () => {
  assert.throws(() => buildMigrationRuntimeExpectations(snapshot({
    hosts: [{ id: 1, isOnline: false, lastHeartbeat: 1_990 }],
    forward_rules: [{ id: 20, isEnabled: true, isRunning: true, pendingDelete: false }],
  }), importedIds), /没有可验证的在线 Agent/);
});

test("takeover token is target-bound and can only commit after prepare", () => {
  const code = createMigrationCode();
  const target = "https://new.example.com";
  const request = createMigrationRequest(code.code, target);
  assert.ok(request);
  assert.ok(approveMigrationRequest(request.id));
  const takeover = consumeApprovedMigrationRequest(request.id, code.code, target);
  assert.ok(takeover);

  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
  assert.equal(prepareTakeoverToken(takeover.takeoverToken, "https://other.example.com"), null);
  assert.ok(prepareTakeoverToken(takeover.takeoverToken, target));
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, "https://other.example.com"), false);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), true);
  assert.equal(consumeTakeoverToken(takeover.takeoverToken, target), false);
});

test("migration approval binds the selected data scope and SQLite transfer request", () => {
  const code = createMigrationCode();
  const request = createMigrationRequest(code.code, "https://new.example.com", {
    dataScope: "full",
    targetDatabaseType: "sqlite",
    directSqliteRequested: true,
  });
  assert.equal(request?.dataScope, "full");
  assert.equal(request?.targetDatabaseType, "sqlite");
  assert.equal(request?.directSqliteRequested, true);
  assert.ok(request && approveMigrationRequest(request.id));
  const takeover = request
    ? consumeApprovedMigrationRequest(request.id, code.code, "https://new.example.com")
    : null;
  assert.equal(takeover?.dataScope, "full");
  assert.equal(takeover?.directSqliteRequested, true);
});

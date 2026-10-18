import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";

// Opt-in only. Never migrate or clear the database named in the supplied URL:
// all work happens in a unique test database created and dropped by this test.
test("real MySQL upgrades legacy fields without altering business data and cleans a backlog in bounded passes", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL,
  timeout: 120_000,
}, async () => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_upgrade_test_${randomBytes(8).toString("hex")}`;
  assert.match(database, /^forwardx_upgrade_test_[a-f0-9]{16}$/);
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema, getDatabaseTableDefs } = await import("./dbSchema");
  const { deleteExpiredHistoryRows } = await import("./repositories/historyRetention");
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    const pool = runtime.getPool()!;
    await ensureDatabaseSchema(pool);
    await pool.query("INSERT INTO users (id, username, password, role, balanceCents) VALUES (1, 'upgrade-admin', 'test-hash', 'admin', 12345)");
    await pool.query("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'existing-host', '192.0.2.10', 1)");
    await pool.query("INSERT INTO forward_rules (id, name, hostId, userId, sourcePort, targetIp, targetPort, forwardType) VALUES (1, 'existing-gost-rule', 1, 1, 10000, '198.51.100.10', 25565, 'gost')");
    await pool.query("INSERT INTO payment_orders (id, outTradeNo, userId, provider, paymentType, status, subject, amountCents) VALUES (1, 'existing-paid-order', 1, 'epay', 'alipay', 'completed', 'existing purchase', 1000)");
    const missing: Record<string, string[]> = {
      hosts: ["hostStatusNotifyEnabled"], forward_rules: ["runtimeDiagnostic"], forward_group_members: ["syncDiagnostic"],
      tunnels: ["v3Transport", "v3Host", "v3Path", "v3UserAgent", "v3ServerName", "v3Multiplex"],
      payment_orders: ["merchantIdentity", "failureReason", "lastPaymentCheckAt"],
    };
    await pool.query("ALTER TABLE payment_orders DROP INDEX idx_payment_orders_status_lastPaymentCheckAt");
    for (const [table, columns] of Object.entries(missing)) {
      for (const column of columns) await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
    }
    for (const table of ["operations_traffic_daily", "operations_source_daily", "operations_source_status", "operations_ip_geo"]) {
      await pool.query(`DROP TABLE \`${table}\``);
    }
    const snapshots = new Map<string, unknown>();
    for (const table of ["users", "hosts", "forward_rules", "payment_orders"]) {
      const [rows] = await pool.query(`SELECT * FROM \`${table}\` ORDER BY id`);
      snapshots.set(table, rows);
    }
    await ensureDatabaseSchema(pool);
    await ensureDatabaseSchema(pool);
    for (const [table, before] of snapshots) {
      const [after] = await pool.query<any[]>(`SELECT * FROM \`${table}\` ORDER BY id`);
      for (const row of after) for (const column of missing[table] || []) delete row[column];
      assert.deepEqual(after, before, `${table}: business data must survive both upgrade and restart`);
    }
    for (const definition of getDatabaseTableDefs()) {
      const [rows] = await pool.query<any[]>(`SHOW COLUMNS FROM \`${definition.name}\``);
      assert.deepEqual(new Set(rows.map(row => row.Field)), new Set(definition.columns.map(column => column.name)));
    }
    const [hostDefaults] = await pool.query<any[]>("SELECT hostStatusNotifyEnabled FROM hosts WHERE id = 1");
    assert.equal(Number(hostDefaults[0].hostStatusNotifyEnabled), 1);
    const now = Math.floor(Date.now() / 1000);
    for (let offset = 0; offset < 2501; offset += 500) {
      const rows = Array.from({ length: Math.min(500, 2501 - offset) }, () => [1, 1, 10, 20, 1]);
      await pool.query("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, recordedAt) VALUES ?", [rows]);
    }
    await pool.execute("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, recordedAt) VALUES (?, ?, ?, ?, ?)", [1, 1, 123, 456, now]);
    assert.equal(await deleteExpiredHistoryRows("traffic_stats", "recordedAt", now - 72 * 3600, { maxBatches: 1 }), 2000);
    assert.equal(await deleteExpiredHistoryRows("traffic_stats", "recordedAt", now - 72 * 3600), 501);
    const [remaining] = await pool.query<any[]>("SELECT bytesIn, bytesOut, recordedAt FROM traffic_stats");
    assert.deepEqual(remaining.map(row => [Number(row.bytesIn), Number(row.bytesOut), row.recordedAt]), [[123, 456, now]]);
  } finally {
    await runtime.closeDatabase();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

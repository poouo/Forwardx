import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

// Opt-in only: never modify existing schemas. All tables/data are owned by a
// uniquely named scratch schema created and dropped by this test.
test("real PostgreSQL initializes, upgrades without data loss and restarts without DDL", {
  skip: !process.env.FORWARDX_TEST_POSTGRES_URL,
  timeout: 120_000,
}, async () => {
  const schema = `forwardx_upgrade_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^forwardx_upgrade_test_[a-f0-9]{16}$/);
  const admin = new pg.Pool({ connectionString: process.env.FORWARDX_TEST_POSTGRES_URL, max: 1, connectionTimeoutMillis: 5000 });
  const pool = new pg.Pool({ connectionString: process.env.FORWARDX_TEST_POSTGRES_URL, max: 1,
    connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
  const statements: string[] = [];
  const target = { async query(sql: string, params?: any[]) {
    statements.push(sql);
    return pool.query(sql, params);
  } };
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await ensureDatabaseSchema(target as pg.Pool);
    await pool.query("INSERT INTO users (id, username, password, role, \"balanceCents\") VALUES (1, 'upgrade-admin', 'test-hash', 'admin', 12345)");
    await pool.query("INSERT INTO hosts (id, name, ip, \"userId\") VALUES (1, 'existing-host', '192.0.2.10', 1)");
    await pool.query("INSERT INTO system_settings (\"key\", value, \"updatedAt\") VALUES ('upgrade-test-keep', 'unchanged', 1)");
    const before = (await pool.query('SELECT id, username, "balanceCents" FROM users')).rows;
    await pool.query('ALTER TABLE hosts DROP COLUMN "hostStatusNotifyEnabled"');
    await pool.query('DROP INDEX "idx_payment_orders_status_lastPaymentCheckAt"');
    statements.length = 0;
    await ensureDatabaseSchema(target as pg.Pool);
    assert.equal(statements.filter(sql => /^ALTER TABLE/.test(sql)).length, 1);
    assert.equal(statements.filter(sql => /^CREATE INDEX/.test(sql)).length, 1);
    assert.deepEqual((await pool.query('SELECT id, username, "balanceCents" FROM users')).rows, before);
    assert.equal((await pool.query('SELECT "hostStatusNotifyEnabled" FROM hosts WHERE id = 1')).rows[0].hostStatusNotifyEnabled, true);
    assert.equal((await pool.query("SELECT value FROM system_settings WHERE \"key\" = 'upgrade-test-keep'")).rows[0].value, "unchanged");
    for (const table of getDatabaseTableDefs()) {
      const actual = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, table.name]);
      assert.deepEqual(new Set(actual.rows.map(row => row.column_name)), new Set(table.columns.map(column => column.name)), table.name);
    }
    statements.length = 0;
    await ensureDatabaseSchema(target as pg.Pool);
    assert.equal(statements.some(sql => /^(CREATE|ALTER)/.test(sql)), false);
    // Resolve an existing table further down search_path without issuing DDL.
    await pool.query(`SET search_path TO forwardx_nonexistent_test_schema, "${schema}"`);
    statements.length = 0;
    await ensureDatabaseSchema(target as pg.Pool);
    assert.equal(statements.some(sql => /^(CREATE|ALTER)/.test(sql)), false);
  } finally {
    await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

function postgresSchema(missing: string[] = [], fail?: RegExp, code = "42501") {
  const defs = getDatabaseTableDefs();
  const queries: string[] = [];
  const columns = new Map(defs.map(table => [table.name, new Set(table.columns
    .filter(column => !missing.includes(`${table.name}.${column.name}`)).map(column => column.name))]));
  const indexes = new Map(defs.map(table => [table.name, new Set([
    ...(table.indexes || []).map(cols => `idx_${table.name}_${cols.join("_")}`.slice(0, 60)),
    ...(table.unique || []).map(cols => `uniq_${table.name}_${cols.join("_")}`.slice(0, 60)),
  ])]));
  const error = Object.assign(new Error("simulated PostgreSQL schema failure"), { code });
  const pool = { async query(sql: string, params: any[] = []) {
    queries.push(sql);
    if (fail?.test(sql)) throw error;
    if (sql.includes("pg_catalog.pg_attribute")) return { rows: params[0].flatMap((name: string) =>
      [...(columns.get(name) || [])].map(column_name => ({ table_name: name, column_name }))) };
    if (sql.includes("pg_catalog.pg_index")) return { rows: [...indexes].flatMap(([table_name, names]) =>
      [...names].map(index_name => ({ table_name, index_name }))) };
    const creation = sql.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/);
    if (creation) columns.set(creation[1], new Set(defs.find(table => table.name === creation[1])!.columns.map(column => column.name)));
    const addition = sql.match(/^ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/);
    if (addition) columns.get(addition[1])!.add(addition[2]);
    const index = sql.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)" ON "([^"]+)"/);
    if (index) indexes.get(index[2])!.add(index[1]);
    return { rows: sql.startsWith("SELECT") ? [{ value: "already-backfilled" }] : [] };
  } };
  return { pool, columns, indexes, queries, error };
}

test("PostgreSQL normal restarts inspect in bulk without duplicate column/table/index DDL", async () => {
  const state = postgresSchema();
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.filter(sql => /pg_catalog.pg_attribute/.test(sql)).length, 1);
  assert.equal(state.queries.filter(sql => /pg_catalog.pg_index/.test(sql)).length, 1);
  assert.equal(state.queries.some(sql => /^(CREATE|ALTER)/.test(sql)), false);
  assert.equal(state.queries.filter(sql => sql.startsWith("INSERT INTO system_settings")).length, 3,
    "default settings are seeded in a single batch, plus two legacy feature settings");
});

test("PostgreSQL only adds missing fields/indexes and upgrades become no-ops on restart", async () => {
  const state = postgresSchema(["hosts.hostStatusNotifyEnabled", "host_ip_switch_attempts.cooldownUntil"]);
  state.indexes.get("payment_orders")!.delete("idx_payment_orders_status_lastPaymentCheckAt");
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.filter(sql => sql.startsWith("ALTER TABLE")).length, 2);
  assert.equal(state.queries.filter(sql => sql.startsWith("CREATE INDEX")).length, 1);
  assert.ok(state.queries.some(sql => sql.includes('ADD COLUMN IF NOT EXISTS "cooldownUntil"')));
  state.queries.length = 0;
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.some(sql => /^(CREATE|ALTER)/.test(sql)), false);
});

test("PostgreSQL creates missing tables and rechecks their actual shape for concurrent initialization", async () => {
  const state = postgresSchema();
  state.columns.delete("host_ip_switch_attempts");
  state.indexes.set("host_ip_switch_attempts", new Set());
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.filter(sql => sql.startsWith("CREATE TABLE")).length, 1);
  assert.equal(state.queries.filter(sql => sql.includes("pg_catalog.pg_attribute")).length, 2);
  assert.equal(state.queries.some(sql => sql.startsWith("ALTER TABLE")), false);
});

for (const [fail, code] of [
  [/pg_catalog.pg_attribute/, "42501"], [/pg_catalog.pg_index/, "42501"],
  [/^ALTER TABLE/, "42501"], [/^ALTER TABLE/, "55P03"], [/^ALTER TABLE/, "53100"],
  [/^CREATE UNIQUE INDEX/, "23505"],
] as const) test(`PostgreSQL ${code} errors during ${fail.source} are not swallowed`, async () => {
  const state = postgresSchema(["hosts.hostStatusNotifyEnabled"], fail, code);
  state.indexes.get("users")!.clear();
  await assert.rejects(ensureDatabaseSchema(state.pool as any), error => error === state.error);
});

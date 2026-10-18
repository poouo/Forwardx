import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";
import { describeDatabaseError } from "./databaseHealthState";

function legacyMysql(missing: string[], failure?: { match: RegExp; code: string; errno?: number }) {
  const queries: string[] = [];
  const columnTypes = new Map(getDatabaseTableDefs().map(table => [table.name,
    new Map(table.columns.filter(column => !missing.includes(`${table.name}.${column.name}`))
      .map(column => [column.name, column.type === "longtext" ? "longtext" : column.type as string])),
  ]));
  const indexNames = new Map(getDatabaseTableDefs().map(table => [table.name, new Set([
    ...(table.indexes || []).map(columns => `idx_${table.name}_${columns.join("_")}`.slice(0, 60)),
    ...(table.unique || []).map(columns => `uniq_${table.name}_${columns.join("_")}`.slice(0, 60)),
  ])]));
  const error = Object.assign(new Error("simulated migration failure"), { code: failure?.code, errno: failure?.errno });
  const pool = {
    getConnection() { throw new Error("unused"); },
    async query(sql: string) {
      queries.push(sql);
      if (failure?.match.test(sql)) throw error;
      const table = sql.match(/`([^`]+)`/)?.[1];
      if (sql.startsWith("SHOW COLUMNS")) return [[...columnTypes.get(table!)!].map(([Field, Type]) => ({ Field, Type })), []];
      if (sql.startsWith("SHOW INDEX")) return [[...indexNames.get(table!)!].map(Key_name => ({ Key_name })), []];
      const addition = sql.match(/^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` (\w+)/);
      if (addition) columnTypes.get(addition[1])!.set(addition[2], addition[3].toLowerCase());
      return [sql.startsWith("SELECT") ? [{ key: "already-backfilled" }] : [], []];
    },
    async execute() { return [[], []]; },
  };
  return { pool, queries, error, columnTypes, indexNames };
}

test("MySQL adds missing legacy fields once without re-altering existing columns or indexes", async () => {
  const missing = ["hosts.hostStatusNotifyEnabled", "forward_rules.runtimeDiagnostic", "forward_group_members.syncDiagnostic",
    "tunnels.v3Transport", "tunnels.v3Host", "tunnels.v3Path", "tunnels.v3UserAgent", "tunnels.v3ServerName", "tunnels.v3Multiplex",
    "payment_orders.merchantIdentity", "payment_orders.failureReason", "payment_orders.lastPaymentCheckAt"];
  const state = legacyMysql(missing);
  state.indexNames.get("payment_orders")!.delete("idx_payment_orders_status_lastPaymentCheckAt");
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.filter(sql => /ALTER TABLE.*ADD COLUMN/.test(sql)).length, 12);
  assert.equal(state.queries.filter(sql => /ALTER TABLE.*ADD INDEX/.test(sql)).length, 1);
  assert.equal(state.queries.some(sql => /MODIFY COLUMN/.test(sql)), false);
  state.indexNames.get("payment_orders")!.add("idx_payment_orders_status_lastPaymentCheckAt");
  state.queries.length = 0;
  await ensureDatabaseSchema(state.pool as any);
  assert.equal(state.queries.some(sql => sql.startsWith("ALTER TABLE")), false,
    "normal restarts must not issue thousands of duplicate ALTERs");
});

for (const [code, errno] of [["ER_TABLEACCESS_DENIED_ERROR", 1142], ["ER_LOCK_WAIT_TIMEOUT", 1205],
  ["ER_TOO_BIG_ROWSIZE", 1118], ["ER_RECORD_FILE_FULL", 1114], ["ECONNRESET", undefined]] as const) {
  test(`MySQL required column failure ${code} aborts schema initialization`, async () => {
    const state = legacyMysql(["hosts.hostStatusNotifyEnabled"], { match: /ALTER TABLE `hosts` ADD COLUMN `hostStatusNotifyEnabled`/, code, errno });
    await assert.rejects(ensureDatabaseSchema(state.pool as any), error => error === state.error);
    assert.equal(describeDatabaseError(state.error, true)?.code, code);
  });
}

test("MySQL ignores only duplicate column/index names, not duplicate business data", async () => {
  const duplicateColumn = legacyMysql(["hosts.hostStatusNotifyEnabled"], { match: /ALTER TABLE `hosts` ADD COLUMN/, code: "ER_DUP_FIELDNAME", errno: 1060 });
  await ensureDatabaseSchema(duplicateColumn.pool as any);
  for (const code of ["ER_DUP_KEYNAME", "ER_DUP_ENTRY"]) {
    const state = legacyMysql([], { match: /ALTER TABLE `payment_orders` ADD INDEX/, code });
    state.indexNames.get("payment_orders")!.delete("idx_payment_orders_status_lastPaymentCheckAt");
    if (code === "ER_DUP_KEYNAME") await ensureDatabaseSchema(state.pool as any);
    else await assert.rejects(ensureDatabaseSchema(state.pool as any), error => error === state.error);
  }
});

test("MySQL existing TEXT columns are widened, while failed metadata inspection is not ignored", async () => {
  const state = legacyMysql([]);
  state.columnTypes.get("system_settings")!.set("value", "text");
  await ensureDatabaseSchema(state.pool as any);
  assert.deepEqual(state.queries.filter(sql => /MODIFY COLUMN/.test(sql)), ["ALTER TABLE `system_settings` MODIFY COLUMN `value` LONGTEXT NULL"]);
  const denied = legacyMysql([], { match: /^SHOW COLUMNS/, code: "ER_TABLEACCESS_DENIED_ERROR" });
  await assert.rejects(ensureDatabaseSchema(denied.pool as any), error => error === denied.error);
});

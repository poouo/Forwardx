import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { writeMysqlTrafficCounters } from "./mysqlTrafficCounters";

for (const keys of [["userId"], ["ruleId", "hostId"], ["bucketStart", "bucketMinutes", "ruleId", "hostId"]]) {
  test(`MySQL counter update-only batches preserve totals for ${keys.join("/")}`, async () => {
    const db = new Database(":memory:");
    const columns = [...keys, "bytesIn", "bytesOut", "connections", "updatedAt"];
    db.exec(`CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns.map(c => `\`${c}\` INTEGER NOT NULL`).join(",")}, UNIQUE (${keys.join(",")}))`);
    const rows = Array.from({ length: 130 }, (_, n) => [...keys.map((_, i) => i ? 1 : n + 1), 100, 200, 3, 10]);
    let inserts = 0, queries = 0;
    const database = {
      query: async (sql: string, params: Array<number | string>) => { queries++; return db.prepare(sql).all(...params) as Record<string, number | string>[]; },
      execute: async (sql: string, params: Array<number | string>) => {
        if (sql.startsWith("INSERT")) inserts++;
        // Execute the same bound values and UPDATE expressions in a real DB;
        // only the dialect-specific insert conflict spelling is translated.
        const sqlite = sql.replace("ON DUPLICATE KEY UPDATE", `ON CONFLICT (${keys.join(",")}) DO UPDATE SET`)
          .replace(/VALUES\((`[^`]+`)\)/g, "excluded.$1");
        return db.prepare(sqlite).run(...params);
      },
    };
    const batch = { table: "counters", columns, keys, rows, add: ["bytesIn", "bytesOut", "connections"], replace: ["updatedAt"] };
    try {
      await writeMysqlTrafficCounters(batch, database);
      assert.equal(inserts, 3); assert.equal(queries, 3);
      inserts = queries = 0;
      await writeMysqlTrafficCounters({ ...batch, rows: [...rows].reverse().map(row => [...row.slice(0, keys.length), 5, 7, 1, 20]) }, database);
      assert.equal(inserts, 0, "existing rows must never enter INSERT path"); assert.equal(queries, 3);
      assert.deepEqual(db.prepare("SELECT COUNT(*) n,SUM(bytesIn) i,SUM(bytesOut) o,SUM(connections) c,MIN(updatedAt) t FROM counters").get(),
        { n: 130, i: 130 * 105, o: 130 * 207, c: 130 * 4, t: 20 });
      await writeMysqlTrafficCounters({ ...batch, rows: [rows[0], [...rows[0].map((v, i) => i === 0 ? 999 : v)]] }, database);
      assert.equal(inserts, 1);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM counters").get() as any).n, 131);
      db.exec("BEGIN");
      await writeMysqlTrafficCounters(batch, database);
      db.exec("ROLLBACK");
      assert.equal((db.prepare("SELECT SUM(bytesIn) n FROM counters").get() as any).n, 130 * 105 + 200);
    } finally { db.close(); }
  });
}

test("MySQL operations batches preserve string keys, names and additive values", async () => {
  const db = new Database(":memory:");
  const keys = ["dayStart", "ip", "resourceKey"];
  db.exec("CREATE TABLE daily (id INTEGER PRIMARY KEY AUTOINCREMENT, dayStart INTEGER, ip TEXT, resourceKey TEXT, name TEXT, bytesIn INTEGER, UNIQUE(dayStart,ip,resourceKey))");
  let inserts = 0;
  const database = {
    query: async (sql: string, params: Array<number | string>) => db.prepare(sql).all(...params) as Record<string, number | string>[],
    execute: async (sql: string, params: Array<number | string>) => {
      if (sql.startsWith("INSERT")) inserts++;
      return db.prepare(sql.replace("ON DUPLICATE KEY UPDATE", "ON CONFLICT(dayStart,ip,resourceKey) DO UPDATE SET").replace(/VALUES\((`[^`]+`)\)/g, "excluded.$1")).run(...params);
    },
  };
  const batch = { table: "daily", columns: [...keys, "name", "bytesIn"], keys, add: ["bytesIn"], replace: ["name"], rows: [[1, "2001:db8::1", "host:1", "old", 100], [1, "203.0.113.1", "group:2", "second", 200]] };
  try {
    await writeMysqlTrafficCounters(batch, database); inserts = 0;
    await writeMysqlTrafficCounters({ ...batch, rows: [[1, "2001:db8::1", "host:1", "new's name", 5]] }, database);
    assert.equal(inserts, 0);
    assert.deepEqual(db.prepare("SELECT name,bytesIn FROM daily WHERE ip=?").get("2001:db8::1"), { name: "new's name", bytesIn: 105 });
    assert.equal((db.prepare("SELECT SUM(bytesIn) n FROM daily").get() as any).n, 305);
  } finally { db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

test("MySQL and PostgreSQL create and migrate nullable fractional load columns", async () => {
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [getDatabaseTableDefs().find(def => def.name === table)!.columns
            .filter(column => !["load1", "load5", "load15"].includes(column.name))
            .map(column => ({ Field: column.name, Type: column.type })), []];
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    const type = kind === "mysql" ? "DOUBLE" : "DOUBLE PRECISION";
    for (const name of ["load1", "load5", "load15"]) {
      const column = `${quote}${name}${quote} ${type}`;
      const create = queries.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote}host_metrics${quote}`));
      assert.ok(create?.includes(column), `${kind} CREATE must retain decimals`);
      const alter = queries.find(sql => sql.startsWith(`ALTER TABLE ${quote}host_metrics${quote} ADD COLUMN ${column}`));
      assert.ok(alter, `${kind} upgrades existing metrics tables`);
      assert.ok(!alter.includes("NOT NULL"));
      assert.ok(!alter.includes("DEFAULT 0"));
    }
  }
});

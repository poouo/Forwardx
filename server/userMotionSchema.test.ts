import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

test("MySQL and PostgreSQL default new and upgraded accounts to animations enabled", async () => {
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [getDatabaseTableDefs().find(def => def.name === table)!.columns
            .filter(column => column.name !== "animationsEnabled")
            .map(column => ({ Field: column.name, Type: column.type })), []];
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    const column = `${quote}animationsEnabled${quote} BOOLEAN NOT NULL DEFAULT ${kind === "mysql" ? "1" : "TRUE"}`;
    assert.ok(queries.some(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote}users${quote}`) && sql.includes(column)), kind);
    assert.ok(queries.some(sql => sql.startsWith(`ALTER TABLE ${quote}users${quote} ADD COLUMN ${column}`)), kind);
  }
});

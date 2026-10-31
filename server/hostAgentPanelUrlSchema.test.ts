import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

test("MySQL and PostgreSQL create and migrate per-host Agent URLs with backward-compatible defaults", async () => {
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [getDatabaseTableDefs().find(def => def.name === table)!.columns
            .filter(column => !["agentPanelUrlEnabled", "agentPanelUrl"].includes(column.name))
            .map(column => ({ Field: column.name, Type: column.type })), []];
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    const create = queries.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote}hosts${quote}`));
    assert.ok(create?.includes(`${quote}agentPanelUrlEnabled${quote}`));
    assert.ok(create?.includes(`${quote}agentPanelUrl${quote}`));
    const add = `ALTER TABLE ${quote}hosts${quote} ADD COLUMN ${kind === "postgresql" ? "IF NOT EXISTS " : ""}`;
    const flag = queries.find(sql => sql.startsWith(`${add}${quote}agentPanelUrlEnabled${quote}`));
    assert.ok(flag && /NOT NULL DEFAULT (?:0|FALSE)/i.test(flag), `${kind}: switch defaults off on upgrade`);
    const url = queries.find(sql => sql.startsWith(`${add}${quote}agentPanelUrl${quote}`));
    assert.ok(url && /TEXT/.test(url) && !url.includes("NOT NULL"), `${kind}: URL is optional`);
  }
});

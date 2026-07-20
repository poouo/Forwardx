import assert from "node:assert/strict";
import test from "node:test";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

function mysqlPool() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    getConnection() {
      throw new Error("not used");
    },
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return [[], []];
    },
    async execute() {
      return [[], []];
    },
  };
  return { pool, queries };
}

test("MySQL system settings use LONGTEXT and upgrade an existing TEXT value column", async () => {
  const definition = getDatabaseTableDefs().find((table) => table.name === "system_settings");
  assert.equal(definition?.columns.find((column) => column.name === "value")?.type, "longtext");

  const { pool, queries } = mysqlPool();
  await ensureDatabaseSchema(pool as any);

  const create = queries.find((entry) => entry.sql.startsWith("CREATE TABLE IF NOT EXISTS `system_settings`"));
  assert.match(create?.sql || "", /`value` LONGTEXT/);
  assert.equal(
    queries.some((entry) => entry.sql === "ALTER TABLE `system_settings` MODIFY COLUMN `value` LONGTEXT NULL"),
    true,
  );
});

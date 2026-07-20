import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("history cleanup predicates use time-leading SQLite indexes", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const cases = [
      ["forward_group_events", "createdAt"],
      ["tunnel_latency_stats", "recordedAt"],
      ["forward_group_latency_stats", "recordedAt"],
      ["forward_tests", "updatedAt"],
    ] as const;
    for (const [table, column] of cases) {
      const plan = sqlite.prepare(
        `EXPLAIN QUERY PLAN DELETE FROM "${table}" WHERE "${column}" < ?`,
      ).all(1) as Array<{ detail?: string }>;
      const detail = plan.map((row) => String(row.detail || "")).join(" | ");
      assert.match(detail, /USING INDEX/i, `${table}.${column}: ${detail}`);
      assert.match(detail, new RegExp(column, "i"), `${table}.${column}: ${detail}`);
    }
  } finally {
    sqlite.close();
  }
});

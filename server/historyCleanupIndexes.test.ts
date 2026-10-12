import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("history cleanup predicates use time-leading SQLite indexes", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const cases = [
      ["tcping_stats", "recordedAt"],
      ["host_probe_service_stats", "recordedAt"],
      ["host_availability_intervals", "endAt"],
      ["forward_group_events", "createdAt"],
      ["tunnel_latency_stats", "recordedAt"],
      ["forward_group_latency_stats", "recordedAt"],
      ["probe_counter_snapshots", "recordedAt"],
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

test("service history and latest-status reads use dedicated composite indexes", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    for (const sql of [
      'SELECT * FROM host_probe_service_stats WHERE serviceId = 1 AND hostId = 2 AND recordedAt >= 100 AND recordedAt < 200',
      'SELECT id FROM host_probe_service_stats WHERE serviceId = 1 ORDER BY id DESC LIMIT 1',
      'SELECT id FROM host_probe_service_stats WHERE serviceId = 1 AND hostId = 2 ORDER BY id DESC LIMIT 1',
    ]) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join(" | ");
      assert.match(detail, /USING.*INDEX/i);
      assert.doesNotMatch(detail, /USE TEMP B-TREE/i, detail);
    }
  } finally { sqlite.close(); }
});

test("host status sweeps use the online-heartbeat SQLite index", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const plan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM "hosts"
       WHERE "isOnline" = 1
         AND "lastHeartbeat" IS NOT NULL
         AND "lastHeartbeat" < ?`,
    ).all(1) as Array<{ detail?: string }>;
    const detail = plan.map((row) => String(row.detail || "")).join(" | ");
    assert.match(detail, /USING INDEX/i, detail);
    assert.match(detail, /isOnline.*lastHeartbeat/i, detail);

    const updatePlan = sqlite.prepare(
      `EXPLAIN QUERY PLAN UPDATE "hosts" SET "isOnline" = 0, "updatedAt" = ?
       WHERE "id" = ?
         AND "isOnline" = 1
         AND "lastHeartbeat" IS NOT NULL
         AND "lastHeartbeat" < ?`,
    ).all(2, 1, 1) as Array<{ detail?: string }>;
    assert.match(updatePlan.map((row) => String(row.detail || "")).join(" | "), /PRIMARY KEY|INTEGER PRIMARY KEY/i);
  } finally {
    sqlite.close();
  }
});

test("host availability interval reads seek one host without sorting or scanning the entire table", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const detail = (sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM host_availability_intervals
      WHERE hostId = 1 AND endAt >= 100 AND startAt <= 200
        AND (startAt > 0 OR (startAt = 0 AND id > 0)) ORDER BY startAt, id LIMIT 2000`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    assert.match(detail, /USING.*INDEX.*hostId/i);
    assert.doesNotMatch(detail, /USE TEMP B-TREE|SCAN host_availability_intervals/i);
  } finally { sqlite.close(); }
});

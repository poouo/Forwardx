import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

for (const dialect of ["mysql", "postgresql", "sqlite"]) {
  test(`${dialect} history cleanup binds filters but not LIMIT and yields between bounded batches`, () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const dialect = process.env.FORWARDX_TEST_DIALECT;
      const quote = (name) => dialect === "mysql"
        ? '\x60' + name.replaceAll('\x60', '\x60\x60') + '\x60'
        : '"' + name.replaceAll('"', '""') + '"';
      const calls = [];
      let counts = [2000, 2000, 7];
      let yielded = false;
      let failure;
      mock.module(moduleUrl("server/dbRuntime.ts"), {
        namedExports: {
          getDatabaseKind: () => dialect,
          quoteDbIdentifier: quote,
          rawAffectedRows: (result) => Number(result.affectedRows ?? result.changes ?? result.rowCount ?? 0),
          executeRaw: async (sql, params) => {
            if (failure) throw failure;
            if (calls.length === 1) assert.equal(yielded, true);
            calls.push({ sql, params: [...params] });
            assert.match(sql, /LIMIT 2000\b/);
            assert.doesNotMatch(sql, /LIMIT\s+\?/i, "MySQL must not receive a DOUBLE LIMIT binding");
            assert.equal((sql.match(/\?/g) || []).length, params.length);
            const count = counts.shift();
            assert.notEqual(count, undefined, "cleanup must stop after a partial or empty batch");
            return dialect === "mysql" ? { affectedRows: count }
              : dialect === "sqlite" ? { changes: count } : { rowCount: count };
          },
        },
      });
      const { deleteExpiredHistoryRows } = await import(moduleUrl("server/repositories/historyRetention.ts"));
      setImmediate(() => { yielded = true; });
      assert.equal(await deleteExpiredHistoryRows("traffic_stat_buckets", "bucketStart", 12345, {
        whereSql: quote("bucketMinutes") + " = ?",
        whereParams: [30],
      }), 4007);
      assert.equal(calls.length, 3);
      for (const { sql, params } of calls) {
        assert.deepEqual(params, [30, 12345]);
        assert.ok(sql.startsWith("DELETE FROM " + quote("traffic_stat_buckets")));
        assert.ok(sql.includes(quote("bucketMinutes") + " = ? AND " + quote("bucketStart") + " < ?"));
        assert.ok(sql.includes("ORDER BY " + quote("bucketStart") + " ASC, " + quote("id") + " ASC"));
        if (dialect === "mysql") assert.match(sql, /FROM \(SELECT[\s\S]+\) expired_history/);
        else assert.doesNotMatch(sql, /expired_history/);
      }
      calls.length = 0;
      counts = [0];
      assert.equal(await deleteExpiredHistoryRows("host_metrics", "recordedAt", 54321), 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, [54321]);
      failure = new Error("database unavailable");
      await assert.rejects(deleteExpiredHistoryRows("host_metrics", "recordedAt", 54321),
        (error) => error === failure);
    `;
    const result = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "--eval", script,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, FORWARDX_TEST_DIALECT: dialect },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

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

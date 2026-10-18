import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("real database startup leaves expired traffic for background maintenance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-startup-retention-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
  process.env.SQLITE_PATH = path.join(directory, "test.db");
  process.env.JWT_SECRET = "isolated-startup-retention-test";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { setSetting } = await import("./repositories/settingsRepository");
  const { initDatabase } = await import("./db");
  try {
    runtime.writeDatabaseConfig({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await runtime.connectDatabase();
    await ensureDatabaseSchema();
    // A panel upgraded from the previous release already has these backfills.
    await setSetting("trafficStatBucketsBackfilled", "v3");
    await setSetting("traffic-billing-rule-usage-v1", "1");
    await runtime.withSqliteExclusive(sqlite => {
      const insert = sqlite.prepare("INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, recordedAt) VALUES (1, 1, 10, 20, 1)");
      sqlite.transaction(() => { for (let i = 0; i < 6001; i++) insert.run(); })();
      sqlite.prepare("INSERT INTO traffic_stat_buckets (bucketStart, userId, ruleId, hostId, bytesIn, bytesOut) VALUES (1, 1, 1, 1, 60010, 120020)").run();
    });
    const result = await initDatabase();
    assert.equal(result.ready, true);
    assert.equal((await runtime.queryRaw<{ count: number }>("SELECT COUNT(*) AS count FROM traffic_stats"))[0].count, 6001);
    assert.equal((await runtime.queryRaw<{ count: number }>("SELECT COUNT(*) AS count FROM traffic_stat_buckets"))[0].count, 1);
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

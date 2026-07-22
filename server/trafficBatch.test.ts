import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("traffic reports batch raw samples and counters without losing totals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-batch-"));
  const databasePath = path.join(directory, "traffic.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 100, bytesOut: 50, connections: 1 }, userId: 7 },
          { stat: { ruleId: 11, hostId: 5, bytesIn: 20, bytesOut: 10, connections: 2 }, userId: 7 },
          { stat: { ruleId: 12, hostId: 5, bytesIn: 7, bytesOut: 8, connections: 1 }, userId: 7 },
        ]);
      });

      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stats"))[0].count, 3);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 127, bytesOut: 68, connections: 4 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT ruleId, bytesIn, bytesOut, connections FROM forward_rule_traffic_counters ORDER BY ruleId"),
        [
          { ruleId: 11, bytesIn: 120, bytesOut: 60, connections: 3 },
          { ruleId: 12, bytesIn: 7, bytesOut: 8, connections: 1 },
        ],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT ruleId, bytesIn, bytesOut, connections FROM traffic_stat_buckets ORDER BY ruleId"),
        [
          { ruleId: 11, bytesIn: 120, bytesOut: 60, connections: 3 },
          { ruleId: 12, bytesIn: 7, bytesOut: 8, connections: 1 },
        ],
      );

      await runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 5, bytesOut: 6, connections: 1 }, userId: 7 },
        ]);
      });
      assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS count FROM traffic_stats"))[0].count, 4);
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 132, bytesOut: 74, connections: 5 }],
      );

      await Promise.all(Array.from({ length: 20 }, () => runtime.withDatabaseTransaction(async () => {
        await metrics.insertTrafficStatsBatch([
          { stat: { ruleId: 11, hostId: 5, bytesIn: 1, bytesOut: 2, connections: 1 }, userId: 7 },
        ]);
      })));
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM user_traffic_counters WHERE userId = 7"),
        [{ bytesIn: 152, bytesOut: 114, connections: 25 }],
      );
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, connections FROM forward_rule_traffic_counters WHERE ruleId = 11 AND hostId = 5"),
        [{ bytesIn: 145, bytesOut: 106, connections: 24 }],
      );

      await metrics.recordHostTrafficSample(5, { bytesIn: 1000, bytesOut: 2000 });
      await metrics.recordHostTrafficSample(5, { bytesIn: 1300, bytesOut: 2600 });
      await metrics.recordHostTrafficSample(5, { bytesIn: 100, bytesOut: 200 });
      assert.deepEqual(
        await runtime.queryRaw("SELECT bytesIn, bytesOut, lastSystemIn, lastSystemOut, lastDeltaIn, lastDeltaOut FROM host_traffic_counters WHERE hostId = 5"),
        [{ bytesIn: 300, bytesOut: 600, lastSystemIn: 100, lastSystemOut: 200, lastDeltaIn: 0, lastDeltaOut: 0 }],
      );
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

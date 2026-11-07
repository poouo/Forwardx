import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite host metric summaries seek only the latest two rows per host", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-metrics-"));
  const databasePath = path.join(directory, "metrics.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    let queueYielded = false;
    setImmediate(() => { queueYielded = true; });
    await Promise.all(Array.from({ length: 200 }, () => runtime.queryRaw("SELECT 1")));
    assert.equal(queueYielded, true, "a busy SQLite queue must periodically yield to timers and HTTP work");

    const now = Math.floor(Date.now() / 1000);
    await runtime.withSqliteExclusive((sqlite) => {
      const insert = sqlite.prepare(
        `INSERT INTO host_metrics (hostId, cpuUsage, networkIn, networkOut, recordedAt)
         VALUES (?, ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        insert.run(1, 10, 100, 200, now - 10);
        insert.run(1, 20, 130, 250, now);
        insert.run(2, 30, 500, 700, now - 20);
        insert.run(2, 40, 560, 760, now);
        for (let hostId = 1_000; hostId <= 1_100; hostId += 1) {
          insert.run(hostId, 1, hostId, hostId, now);
        }
        for (let index = 0; index < 2_100; index += 1) {
          insert.run(99, 1, index, index, now - 100 * 60 * 60 - index);
        }
      })();
    });

    const summaries = await metrics.getLatestHostMetricRows([2, 1]);
    await runtime.executeRaw('UPDATE host_metrics SET load1 = ?, load5 = ?, load15 = ? WHERE hostId = ? AND recordedAt = ?', [0, 1.23, 2.34, 1, now]);
    const loadSummaries = await metrics.getLatestHostMetricRows([1, 2]);
    const withLoad = loadSummaries.find((row: any) => Number(row.hostId) === 1) as any;
    const withoutLoad = loadSummaries.find((row: any) => Number(row.hostId) === 2) as any;
    assert.deepEqual([withLoad.load1, withLoad.load5, withLoad.load15], [0, 1.23, 2.34]);
    assert.deepEqual([withoutLoad.load1, withoutLoad.load5, withoutLoad.load15], [null, null, null]);
    assert.equal(summaries.length, 2);
    const first = summaries.find((row: any) => Number(row.hostId) === 1) as any;
    assert.equal(first.cpuUsage, 20);
    assert.equal(first.networkSpeedIn, 3);
    assert.equal(first.networkSpeedOut, 5);

    const snapshots = await metrics.getLatestHostMetricSnapshots([1, 2]);
    assert.deepEqual(
      snapshots.map((row) => [row.hostId, row.rn]),
      [[1, 1], [1, 2], [2, 1], [2, 2]],
    );

    assert.deepEqual(metrics.summarizeHostInstantTraffic([...snapshots].reverse()), {
      currentTrafficIn: 6, currentTrafficOut: 8, currentTrafficTotal: 14, measuredHosts: 2,
    });
    await runtime.withSqliteExclusive((sqlite) => {
      const insert = sqlite.prepare('INSERT INTO host_metrics (hostId,networkIn,networkOut,uptime,recordedAt) VALUES (?,?,?,?,?)');
      // Missing baseline, counter reset, reboot, duplicate timestamp, stale data,
      // arrival jitter, legitimate idle host, long reporting gap.
      insert.run(11, null, 0, 100, now - 3); insert.run(11, 9_000_000, 0, 103, now);
      insert.run(12, 9000, 0, 100, now - 3); insert.run(12, 0, 0, 103, now);
      insert.run(13, 100, 100, 100, now - 3); insert.run(13, 10_000, 10_000, 1, now);
      insert.run(14, 0, 0, 100, now); insert.run(14, 9000, 9000, 101, now);
      insert.run(15, 0, 0, 100, now - 303); insert.run(15, 9000, 9000, 103, now - 300);
      insert.run(16, 0, 0, 100, now - 1); insert.run(16, 3000, 6000, 103, now);
      insert.run(17, 100, 100, 100, now - 3); insert.run(17, 100, 100, 103, now);
      insert.run(18, 0, 0, 100, now - 300); insert.run(18, 9000, 9000, 400, now);
    });
    const regressionIds = [11,12,13,14,15,16,17,18];
    const regressionRows = await metrics.getLatestHostMetricRows(regressionIds);
    const byId = new Map(regressionRows.map((row: any) => [row.hostId, row]));
    assert.equal(byId.get(11)?.networkSpeedIn, null, "missing baseline must not create a spike");
    assert.equal(byId.get(12)?.networkSpeedIn, null, "reset counters are unknown, not idle");
    for (const id of [13,14,15,18]) assert.equal(byId.get(id)?.networkSpeedIn, null);
    assert.equal(byId.get(16)?.networkSpeedIn, 1000, "collection uptime avoids arrival jitter");
    assert.equal(byId.get(17)?.networkSpeedIn, 0, "real idle samples remain measured");
    const regressionSummary = metrics.summarizeHostInstantTraffic(await metrics.getLatestHostMetricSnapshots(regressionIds));
    assert.equal(regressionSummary.currentTrafficIn, 1000);
    assert.equal(regressionSummary.currentTrafficOut, 2000);
    assert.equal(regressionSummary.measuredHosts, 4, "two partially valid and two fully valid hosts");
    assert.deepEqual(metrics.summarizeHostInstantTraffic([]), {
      currentTrafficIn: null, currentTrafficOut: null, currentTrafficTotal: null, measuredHosts: 0,
    }, "no samples must stay unknown rather than looking like idle zero traffic");

    const reverseHostIds = Array.from({ length: 101 }, (_, index) => 1_100 - index);
    const crossBatchSnapshots = await metrics.getLatestHostMetricSnapshots(reverseHostIds);
    assert.deepEqual(
      crossBatchSnapshots.map((row) => row.hostId),
      [...reverseHostIds].sort((a, b) => a - b),
      "SQLite metric batches must preserve the previous global host ordering",
    );

    const plan = await runtime.queryRaw<{ detail?: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, hostId, recordedAt FROM host_metrics
        WHERE hostId = ?
        ORDER BY recordedAt DESC, id DESC
        LIMIT 2`,
      [1],
    );
    assert.match(plan.map((row) => String(row.detail || "")).join(" | "), /idx_host_metrics_hostId_recordedAt/i);

    await metrics.cleanOldHostMetrics(72);
    const [{ count }] = await runtime.queryRaw<{ count: number }>(
      `SELECT COUNT(*) AS count FROM host_metrics WHERE hostId = ?`,
      [99],
    );
    assert.equal(Number(count), 0);

    const expiredAt = now - 200 * 60 * 60;
    await runtime.withSqliteExclusive((sqlite) => {
      sqlite.prepare(
        `INSERT INTO agent_traffic_reports (hostId, producerId, reportId, receivedAt)
         VALUES (?, NULL, ?, ?)`,
      ).run(1, "expired-report", expiredAt);
      sqlite.prepare(
        `INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, connections, recordedAt)
         VALUES (?, ?, 0, 0, 0, ?)`,
      ).run(1, 1, expiredAt);
      sqlite.prepare(
        `INSERT INTO traffic_stat_buckets
           (bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections, updatedAt)
         VALUES (?, 30, 1, 1, 1, 0, 0, 0, ?)`,
      ).run(expiredAt, expiredAt);
      sqlite.prepare(
        `INSERT INTO tcping_stats (ruleId, hostId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT INTO forward_group_latency_stats (groupId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT INTO tunnel_latency_stats (tunnelId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT OR REPLACE INTO system_settings (key, value, updatedAt)
         VALUES ('traffic-billing-rule-usage-v1', 'ready', ?)`,
      ).run(now);
    });

    await metrics.cleanOldTrafficStats(72);
    await metrics.cleanOldTrafficStatBuckets(72);
    await metrics.cleanOldTcpingStats(72);
    await metrics.cleanOldTunnelLatencyStats(72);
    for (const table of [
      "agent_traffic_reports",
      "traffic_stats",
      "traffic_stat_buckets",
      "tcping_stats",
      "forward_group_latency_stats",
      "tunnel_latency_stats",
    ]) {
      const rows = await runtime.queryRaw<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`);
      assert.equal(Number(rows[0]?.count || 0), 0, table);
    }
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

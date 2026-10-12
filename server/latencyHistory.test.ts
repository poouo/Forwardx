import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { LATENCY_HISTORY_HOURS, latencyChartBucketSeconds } from "../shared/latencyHistory";
import { latencyHistoryWindowInput, resolveLatencyHistoryWindow } from "./latencyHistoryWindow";

test("history windows support 30 days and bounded, explicit calendar-day ranges", () => {
  const schema = z.object(latencyHistoryWindowInput);
  assert.equal(schema.parse({ hours: 720 }).hours, LATENCY_HISTORY_HOURS);
  assert.throws(() => schema.parse({ hours: 721 }));
  const now = Date.parse("2026-10-12T12:00:00Z");
  const range = resolveLatencyHistoryWindow({ hours: 24, startAt: new Date("2026-10-01T16:00:00Z"), endAt: new Date("2026-10-02T16:00:00Z") }, now);
  assert.equal(range.hours, 24);
  assert.equal(range.longHistory, true);
  assert.equal(range.until.toISOString(), "2026-10-02T16:00:00.000Z");
  assert.throws(() => resolveLatencyHistoryWindow({ startAt: new Date(now) }, now));
  assert.throws(() => resolveLatencyHistoryWindow({ startAt: new Date(now), endAt: new Date(now - 1) }, now));
  assert.throws(() => resolveLatencyHistoryWindow({ startAt: new Date(now - 40 * 86400_000), endAt: new Date(now) }, now));
  assert.ok(latencyChartBucketSeconds(720) >= 1800);
  // Explicit local midnight boundaries support the 23/25-hour DST days.
  const boundaries = Array.from({ length: 31 }, (_, index) => new Date(now - 29 * 86400_000 + index * 86400_000 + (index >= 10 ? 3600_000 : 0)));
  assert.equal(resolveLatencyHistoryWindow({ hours: 720, startAt: boundaries[0], endAt: boundaries[30], dayBoundaries: boundaries }, now).dayBoundaries?.length, 31);
  const invalid = [...boundaries];
  invalid[10] = invalid[9];
  assert.throws(() => resolveLatencyHistoryWindow({ startAt: invalid[0], endAt: invalid[30], dayBoundaries: invalid }, now));
});

test("raw latency history retains a month, seeks daily windows and bounds chart responses without truncation", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  const services = await import("./repositories/hostProbeServiceRepository");
  const counters = await import("./repositories/probeCounterRepository");
  const { rulesRouter: selfTestRulesRouter } = await import("./routers/rules");
  const { hostsRouter } = await import("./routers/hosts");
  const { tunnelsRouter } = await import("./routers/tunnels");
  const { forwardGroupsRouter } = await import("./routers/forwardGroups");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-latency-month-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "history.db") } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor((now - 10 * 86400) / 86400) * 86400;
    const end = start + 86400;
    const since = new Date(start * 1000);
    const until = new Date(end * 1000);
    const monthSince = new Date((now - 30 * 86400) * 1000);
    const days = Array.from({ length: 31 }, (_, index) => new Date((Math.floor(now / 86400) * 86400 - 29 * 86400 + index * 86400) * 1000));
    await runtime.withSqliteExclusive((sqlite) => {
      sqlite.transaction(() => {
        sqlite.prepare("INSERT INTO host_probe_services (id, name, targetIp, targetPort, userId) VALUES (9, 'test', 'example.test', 443, 1)").run();
        sqlite.prepare("INSERT INTO tunnels (id, name, entryHostId, exitHostId, listenPort, userId) VALUES (9, 'test', 1, 2, 10009, 1)").run();
        sqlite.prepare("INSERT INTO forward_groups (id, name, groupMode, groupType, targetIp, userId) VALUES (9, 'test', 'chain', 'host', 'example.test', 1)").run();
        for (const [id, owner] of [[301, 1], [302, 1], [303, 2]]) sqlite.prepare(
          "INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, userId) VALUES (?, 1, 'test', ?, 'example.test', 443, ?)",
        ).run(id, id + 10000, owner);
        const insert = sqlite.prepare("INSERT INTO tcping_stats (ruleId, hostId, latencyMs, isTimeout, probeCount, probeSuccesses, recordedAt) VALUES (?, 1, ?, ?, ?, ?, ?)");
        for (const [at, latency, success] of [[start - 1, 888, 5], [start + 120, 10, 4], [start + 130, 20, 5], [start + 140, null, 0], [end, 999, 5]] as const)
          insert.run(301, latency, success === 0 ? 1 : 0, 5, success, at);
        for (let index = 0; index < 20_000; index++) insert.run(302, 30, 0, 3, 3, now - 60 - index * 120);
        for (const [id, table, column] of [[9, "tunnel_latency_stats", "tunnelId"], [9, "forward_group_latency_stats", "groupId"], [9, "host_probe_service_stats", "serviceId"]] as const) {
          const host = table === "host_probe_service_stats" ? ", hostId" : "";
          const hostValue = host ? ", 1" : "";
          const statement = sqlite.prepare(`INSERT INTO ${table} (${column}, latencyMs, isTimeout, probeCount, probeSuccesses, recordedAt${host}) VALUES (?, ?, ?, 5, ?, ?${hostValue})`);
          for (const [at, latency, success] of [[start - 1, 888, 5], [start + 120, 10, 4], [start + 130, 20, 5], [start + 140, null, 0], [end, 999, 5]] as const)
            statement.run(id, latency, success === 0 ? 1 : 0, success, at);
        }
        sqlite.prepare("INSERT INTO host_probe_service_stats (serviceId, hostId, latencyMs, recordedAt) VALUES (9, 2, 123, ?)").run(now);
        // More than a cleanup batch must be deleted without erasing day 29.
        for (const [table, column] of [["tcping_stats", "ruleId"], ["host_probe_service_stats", "serviceId"], ["tunnel_latency_stats", "tunnelId"], ["forward_group_latency_stats", "groupId"]]) {
          const host = table === "tcping_stats" || table === "host_probe_service_stats" ? ", hostId" : "";
          const statement = sqlite.prepare(`INSERT INTO ${table} (${column}, recordedAt${host}) VALUES (399, ?${host ? ", 1" : ""})`);
          for (let index = 0; index < 2100; index++) statement.run(now - 31 * 86400);
          statement.run(now - 29 * 86400);
        }
      })();
    });

    const options = { since, until, bucketSeconds: 300 };
    for (const rows of [await metrics.getTcpingSeriesByRule(301, options), await metrics.getTunnelLatencySeries(9, options), await metrics.getForwardGroupLatencySeries(9, options)]) {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].probeCount, 15);
      assert.equal(rows[0].probeSuccesses, 9);
      assert.equal(rows[0].latencyMs, 16);
      assert.equal((rows[0] as any).minLatencyMs, 10);
      assert.equal((rows[0] as any).maxLatencyMs, 20);
    }
    const serviceRows = await services.getHostProbeServiceSeries({ serviceIds: [9], hostId: 1, hours: 24, since, until });
    assert.equal(serviceRows.reduce((sum, row) => sum + row.probeCount, 0), 15);
    assert.equal(serviceRows[0].maxLatencyMs, 20);
    assert.equal((await services.getLatestHostProbeServiceStats([9])).get(9)?.latencyMs, 123);
    assert.equal((await services.getLatestHostProbeServiceStats([9], 1)).get(9)?.latencyMs, 999);

    const month = await metrics.getTcpingSeriesByRule(302, { since: monthSince, bucketSeconds: latencyChartBucketSeconds(720) });
    assert.ok(month.length <= 1440);
    assert.ok(month[0].recordedAt.getTime() < (now - 27 * 86400) * 1000, "must retain the beginning, not only the latest 2880 raw rows");
    assert.equal(month.reduce((sum, row) => sum + row.probeCount, 0), 60_000);
    const daily = await metrics.getTcpingSeriesByRule(302, { since: days[0], until: days[30], bucketSeconds: 86400, dayBoundaries: days });
    assert.ok(daily.length <= 30);
    assert.ok(daily.some((row) => row.probeCount > 1024), "a daily aggregate is not a single wire batch");
    assert.equal(daily.reduce((sum, row) => sum + row.probeCount, 0), 60_000);
    assert.equal(Number((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM tcping_stats WHERE ruleId = 302"))[0].count), 20_000, "chart aggregation must not discard raw history");

    const snapshot = (count: number, successes: number) => ({ kind: "rule" as const, refId: 301, hostId: 1, probeKey: "key", epoch: "epoch", totalCount: count, totalSuccesses: successes, batchCount: 5, batchSuccesses: 4 });
    await counters.insertProbeCounterSnapshots([snapshot(100, 90)], new Date((start - 60) * 1000));
    await counters.insertProbeCounterSnapshots([snapshot(120, 108)], new Date((start + 600) * 1000));
    await counters.insertProbeCounterSnapshots([snapshot(900, 800)], until);
    const stats = await counters.getProbeCounterStatistics("rule", 301, since, until);
    assert.equal(stats.total, 20);
    assert.equal(stats.successes, 18, "next day's snapshot must not enter this day's loss statistics");

    const context = (id: number) => ({ req: { headers: {} }, res: {}, user: { id, role: "user", accountEnabled: true } } as any);
    const caller = selfTestRulesRouter.createCaller(context(1));
    const routeRows = await caller.tcpingSeries({ ruleId: 301, hours: 24, startAt: since, endAt: until });
    assert.equal(routeRows.reduce((sum, row) => sum + row.probeCount, 0), 15);
    await assert.rejects(caller.tcpingSeries({ ruleId: 303, hours: 720 }), /无权/);
    const routeDaily = await caller.tcpingSeries({ ruleId: 302, hours: 720, startAt: days[0], endAt: days[30], dayBoundaries: days });
    assert.equal(routeDaily.reduce((sum, row) => sum + row.probeCount, 0), 60_000);
    const serviceCaller = hostsRouter.createCaller(context(1));
    const serviceDaily = await serviceCaller.probeServiceSeries({ serviceIds: [9], hostId: 1, hours: 720, startAt: days[0], endAt: days[30], dayBoundaries: days });
    const serviceDay = serviceDaily.find((row) => row.dayStart === start * 1000);
    assert.equal(serviceDay?.probeCount, 15);
    assert.equal(serviceDay?.maxLatencyMs, 20);
    assert.deepEqual(await hostsRouter.createCaller(context(2)).probeServiceSeries({ serviceIds: [9], hostId: 1, hours: 720 }), []);
    for (const rows of [
      await tunnelsRouter.createCaller(context(1)).latencySeries({ tunnelId: 9, hours: 24, startAt: since, endAt: until }),
      await forwardGroupsRouter.createCaller(context(1)).latencySeries({ groupId: 9, hours: 24, startAt: since, endAt: until }),
    ]) assert.equal(rows.reduce((sum, row) => sum + row.probeCount, 0), 15);

    let yielded = false;
    setImmediate(() => { yielded = true; });
    await metrics.cleanOldTcpingStats();
    await metrics.cleanOldTunnelLatencyStats();
    await services.cleanOldHostProbeServiceStats();
    assert.equal(yielded, true);
    for (const table of ["tcping_stats", "host_probe_service_stats", "tunnel_latency_stats", "forward_group_latency_stats"]) {
      const rows = await runtime.queryRaw<any>(`SELECT recordedAt FROM ${table} WHERE ${table === "tcping_stats" ? "ruleId" : table === "host_probe_service_stats" ? "serviceId" : table === "tunnel_latency_stats" ? "tunnelId" : "groupId"} = 399`);
      assert.equal(rows.length, 1, table);
      assert.equal(Number(rows[0].recordedAt), now - 29 * 86400, table);
    }
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

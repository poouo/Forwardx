import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasAgentProbeCounter, isAgentTcpingResult } from "../shared/agentDtos";
import { probeCounterInsertSql, probeCounterSnapshot } from "./repositories/probeCounterRepository";
import { AgentProbeCounterReportGate } from "./agentProbeCounterReportGate";

test("counter persistence stays throttled without losing epoch baselines or failure/recovery transitions", () => {
  const gate = new AgentProbeCounterReportGate(2, 30 * 60_000);
  const row = (count: number, successes = count, epoch = "epoch-1", batchSuccesses = 3) => probeCounterSnapshot("rule", 1, 1,
    { probeCounterEpoch: epoch, probeTotalCount: count, probeTotalSuccesses: successes,
      probeCount: 3, probeSuccesses: batchSuccesses })!;
  const first = gate.plan([row(3)], false, 1_000);
  assert.equal(first.rows.length, 1);
  assert.equal(gate.plan([row(3)], false, 2_000).rows.length, 1, "failed DB writes must be retried");
  first.commit();
  assert.equal(gate.plan([row(6)], false, 3_000).rows.length, 0);
  const failed = gate.plan([row(9, 8, "epoch-1", 2)], false, 4_000);
  assert.equal(failed.rows.length, 1);
  failed.commit();
  const recovered = gate.plan([row(12, 11)], false, 5_000);
  assert.equal(recovered.rows.length, 1);
  recovered.commit();
  assert.equal(gate.plan([row(12)], true, 6_000).rows.length, 0, "retry is not a new probe");
  assert.equal(gate.plan([row(6)], true, 6_000).rows.length, 0, "late POST must not replace high water mark");
  assert.equal(gate.plan([row(900)], false, 305_000).rows.length, 1);
  assert.equal(gate.plan([row(3, 3, "epoch-2")], false, 6_000).rows.length, 1, "new Agent epoch needs a baseline despite unchanged health");
  const older = gate.plan([row(18)], true, 8_000);
  const newer = gate.plan([row(21)], true, 9_000);
  newer.commit(); older.commit();
  assert.equal(gate.plan([row(21)], true, 10_000).rows.length, 0);
  gate.plan([row(3, 3, "epoch-2")], true, 11_000).commit();
  gate.plan([row(3, 3, "epoch-3")], true, 12_000).commit();
  assert.equal(gate.plan([row(21)], false, 13_000).rows.length, 1, "capacity eviction reclaims oldest state");
  assert.equal(gate.plan([row(3, 3, "epoch-3")], false, 31 * 60_000).rows.length, 1, "expired state is reclaimed");
});

test("cumulative telemetry is optional, bounded and cannot reinterpret current health counters", () => {
  const report = { ruleId: 1, probeCount: 3, probeSuccesses: 2, probeCounterEpoch: "epoch-1", probeTotalCount: 30, probeTotalSuccesses: 28 };
  assert.ok(isAgentTcpingResult({ ruleId: 1 }));
  assert.ok(isAgentTcpingResult(report));
  for (const overrides of [{ probeTotalCount: 1 }, { probeTotalSuccesses: 30 }, { probeTotalSuccesses: -1 },
    { probeCounterEpoch: "x".repeat(65) }, { probeTotalCount: 1_000_000_001 }, { probeTotalCount: 3.5 },
    { probeTotalSuccesses: undefined }, { probeCounterEpoch: "bad string" }]) {
    assert.equal(isAgentTcpingResult({ ...report, ...overrides }), false, JSON.stringify(overrides));
  }
  assert.equal(hasAgentProbeCounter({}), false);
  assert.equal(probeCounterSnapshot("rule", 1, 1, {}), null);
  const row = probeCounterSnapshot("rule", 1, 1, report)!;
  assert.equal(row.batchCount, 3);
  assert.equal(row.batchSuccesses, 2);
  assert.match(row.probeKey, /^[a-f0-9]{64}$/);
  assert.notEqual(row.probeKey, probeCounterSnapshot("rule", 1, 2, report)!.probeKey);
  assert.match(probeCounterInsertSql(2, "mysql"), /ON DUPLICATE KEY UPDATE/);
  assert.match(probeCounterInsertSql(2, "postgresql"), /ON CONFLICT .* DO NOTHING/);
});

test("SQLite cumulative probe statistics deduplicate retries, include suppressed probes, and respect windows/epochs/permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-probe-counters-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import http from "node:http";
    import express from "express";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const counters = await import(url("server/repositories/probeCounterRepository.ts"));
    const metrics = await import(url("server/repositories/metricsRepository.ts"));
    await import(url("server/routers.ts"));
    const { rulesRouter: selfTestRulesRouter } = await import(url("server/routers/rules.ts"));
    const { forwardGroupsRouter } = await import(url("server/routers/forwardGroups.ts"));
    const { tunnelsRouter } = await import(url("server/routers/tunnels.ts"));
    const { recordForwardGroupAutoHopLatency } = await import(url("server/forwardGroupAutoLatencyState.ts"));
    const reports = await import(url("server/agentReportRoutes.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    const since = new Date((now - 1200) * 1000);
    const row = (kind, refId, hostId, count, successes, extra = {}) => counters.probeCounterSnapshot(kind, refId, hostId, {
      probeCounterEpoch: "epoch-1", probeCount: 3, probeSuccesses: 3,
      probeTotalCount: count, probeTotalSuccesses: successes, ...extra,
    });
    const save = (items, seconds) => counters.insertProbeCounterSnapshots(items.filter(Boolean), new Date(seconds * 1000));
    // Equivalent to 1000 real collections, a single wholly failed batch:
    // only state transitions + steady snapshots cross the network.
    await save([row("rule", 1, 1, 3, 3)], now - 1000);
    await save([row("rule", 1, 1, 453, 450, { probeSuccesses: 0 })], now - 850);
    await save([row("rule", 1, 1, 456, 453)], now - 849);
    const final = row("rule", 1, 1, 3000, 2997);
    await save([final, final], now - 1);
    await save([final], now); // Response lost and HTTP payload retried.
    await save([row("rule", 1, 1, 2000, 1997)], now); // Older POST arrives late.
    let stats = await counters.getProbeCounterStatistics("rule", 1, since);
    assert.equal(stats.total, 3000);
    assert.equal(stats.successes, 2997);
    assert.equal((stats.total - stats.successes) / stats.total * 100, 0.1);
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "probe_counter_snapshots" WHERE "refId"=1'))[0].n, 5);
    // Existing stream: count difference since the latest pre-window baseline.
    await save([row("rule", 2, 1, 600, 590)], now - 1300);
    await save([row("rule", 2, 1, 900, 885)], now - 1100);
    stats = await counters.getProbeCounterStatistics("rule", 2, since);
    assert.equal(stats.total, 300);
    assert.equal(stats.successes, 295);
    // New observation of an old epoch: do not count unobserved lifetime.
    await save([row("rule", 3, 1, 90000, 89997)], now - 100);
    stats = await counters.getProbeCounterStatistics("rule", 3, since);
    assert.equal(stats.total, 3);
    assert.equal(stats.successes, 3);
    // Restart resets must not subtract earlier traffic or merge streams.
    await save([row("rule", 3, 1, 3, 2, { probeCounterEpoch: "epoch-2", probeSuccesses: 2 })], now - 10);
    stats = await counters.getProbeCounterStatistics("rule", 3, since);
    assert.equal(stats.total, 6);
    assert.equal(stats.successes, 5);
    // Cached failing hop affects path health but not independent counters.
    const hop = (hopIndex, probeSuccesses) => ({ groupId: 10, hopIndex, hopCount: 2, latencyMs: 4, isTimeout: false,
      probeCount: 3, probeSuccesses, generation: "g1" });
    recordForwardGroupAutoHopLatency(hop(0, 2));
    await save([row("forwardGroup", 10, 1, 3, 2, { probeSuccesses: 2, hopIndex: 0 })], now - 100);
    for (let i = 1; i <= 20; i++) {
      const health = recordForwardGroupAutoHopLatency(hop(1, 3));
      assert.equal(health.probeSuccesses, 2, "do not relax cached health checks");
      await save([row("forwardGroup", 10, 2, i * 3, i * 3, { hopIndex: 1 })], now - 100 + i);
    }
    stats = await counters.getProbeCounterStatistics("forwardGroup", 10, since);
    assert.equal(stats.total, 63);
    assert.equal(stats.successes, 62, "one failing probe, not twenty reuses of it");
    assert.equal((await counters.getProbeCounterStatistics("rule", 9999, since)).available, false);
    // Access checks on all three summary APIs, using real database entities.
    const insert = (table, columns, values) => runtime.executeRaw('INSERT INTO "' + table + '" (' + columns.map(c => '"'+c+'"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    await insert("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","userId"], [1,1,"test","realm","tcp",10001,"localhost",443,7]);
    await insert("forward_groups", ["id","name","groupMode","groupType","targetIp","userId"], [10,"chain","chain","host","localhost",7]);
    await insert("tunnels", ["id","name","entryHostId","exitHostId","mode","listenPort","userId"], [20,"tunnel",1,2,"forwardx",20020,7]);
    const ctx = id => ({ req: { headers: {} }, res: {}, user: { id, role: "user", accountEnabled: true }, authSession: null });
    const owner = selfTestRulesRouter.createCaller(ctx(7));
    assert.equal((await owner.probeStatistics({ruleId:1,hours:24})).total, 3000);
    await assert.rejects(selfTestRulesRouter.createCaller(ctx(8)).probeStatistics({ruleId:1,hours:24}), /无权/);
    await assert.rejects(forwardGroupsRouter.createCaller(ctx(8)).probeStatistics({groupId:10,hours:24}), /permission|权限|无权/i);
    await assert.rejects(tunnelsRouter.createCaller(ctx(8)).probeStatistics({tunnelId:20,hours:24}), /permission/i);
    assert.equal((await forwardGroupsRouter.createCaller(ctx(7)).probeStatistics({groupId:10,hours:24})).total, 63);
    // Real report endpoint: counters are authorized before storage, stable
    // health still stays gated, and a new epoch always gets its own baseline.
    for (const id of [1,2]) await insert("hosts", ["id","name","ip","hostType","agentToken","userId"],
      [id,"host-"+id,"127.0.0."+id,"slave","probe-token-"+id,7]);
    await insert("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","userId"], [50,1,"wire","realm","tcp",10050,"localhost",443,7]);
    const app = express();
    app.use(express.json());
    app.use((req,res,next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
    reports.registerAgentReportRoutes(app);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = "http://127.0.0.1:" + server.address().port + "/api/agent/tcping";
    const wire = {ruleId:50,sourcePort:10050,targetIp:"localhost",targetPort:443,method:"tcping",
      latencyMs:8,isTimeout:false,probeCount:3,probeSuccesses:3,probeCounterEpoch:"wire-1",probeTotalCount:3,probeTotalSuccesses:3};
    const post = async (hostId, body) => {
      const response = await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer probe-token-"+hostId},body:JSON.stringify(body)});
      const result = await response.json();
      assert.equal(response.status,200,JSON.stringify(result));
    };
    try {
      await post(1,{results:[wire]});
      await post(1,{results:[{...wire,probeTotalCount:6,probeTotalSuccesses:6}]});
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "tcping_stats" WHERE "ruleId"=50'))[0].n,1,"healthy rows stay throttled");
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "probe_counter_snapshots" WHERE "refId"=50'))[0].n,1,"stable target snapshots do not add per-cycle database writes");
      await post(1,{results:[{...wire,probeCounterEpoch:"wire-restarted"}]});
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "probe_counter_snapshots" WHERE "refId"=50'))[0].n,2,"restarted counter baseline survives unchanged health gate");
      const complete = {...wire,probeTotalCount:3000,probeTotalSuccesses:2997,probeSuccesses:2};
      await post(1,{results:[complete]});
      await post(1,{results:[complete]});
      await post(2,{results:[{...wire,probeCounterEpoch:"unauthorized"}]});
      await post(1,{results:[{...wire,targetPort:444,probeCounterEpoch:"wrong-port"}]});
      stats = await counters.getProbeCounterStatistics("rule",50,since);
      assert.equal(stats.total,3003);
      assert.equal(stats.successes,3000);
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "probe_counter_snapshots" WHERE "refId"=50'))[0].n,3,"HTTP duplicates and unauthorized reports are not real attempts");
      const tunnelWire = {...wire,ruleId:undefined,sourcePort:undefined,tunnelId:20,targetIp:"127.0.0.2",targetPort:20020,method:"tcp",probeCounterEpoch:"tunnel-wire"};
      await post(1,{tunnels:[tunnelWire]});
      await post(2,{tunnels:[{...tunnelWire,probeCounterEpoch:"wrong-source"}]});
      await post(1,{force:true,tunnels:[{...tunnelWire,probeTotalCount:300,probeTotalSuccesses:299,probeSuccesses:2}]});
      stats = await counters.getProbeCounterStatistics("tunnel",20,since);
      assert.equal(stats.total,300);
      assert.equal(stats.successes,299);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    // Retention batches reclaim old snapshots with a time-leading index.
    await save([row("rule", 999, 1, 3, 3)], now - 80 * 3600);
    await metrics.cleanOldTcpingStats(72);
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "probe_counter_snapshots" WHERE "refId"=999'))[0].n, 0);
    await runtime.closeDatabase();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"), NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

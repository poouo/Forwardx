import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planManualTunnelProbes, aggregateManualTunnelProbes } from "./tunnelManualProbe";

const hosts = new Map([1, 2, 3, 4, 5, 6].map(id => [id, { name: `host-${id}`, ipv4: `192.0.2.${id}` }]));
const tunnel = { id: 1, userId: 1, entryHostId: 1, exitHostId: 4, listenPort: 4004, mode: "tls" };
const hops = [1, 2, 3, 4].map(hostId => ({ hostId, listenPort: 4000 + hostId }));

test("manual probes treat failover relays as alternatives, never a serial relay chain", () => {
  const probes = planManualTunnelProbes({ tunnel: { ...tunnel, relayMode: "failover" }, hops,
    exits: [], entryHostIds: [1, 5], hosts });
  assert.equal(probes.length, 6, "shared relay-to-exit edges are probed only once");
  assert.equal(probes.some(probe => probe.fromHostId === 2 && probe.toHostId === 3), false);
  assert.equal(probes.find(probe => probe.fromHostId === 2 && probe.toHostId === 4)?.pathKeys.length, 2);
  const summary = aggregateManualTunnelProbes(probes.map(probe => ({ ...probe,
    success: probe.toHostId !== 3 && probe.fromHostId !== 3, latencyMs: 10,
  })));
  assert.deepEqual(summary, { success: true, latencyMs: 20, available: 2, total: 4 });
});

test("multi-entry direct probes include every enabled exit with its configured port and address", () => {
  const probes = planManualTunnelProbes({ tunnel: { ...tunnel, loadBalanceEnabled: true, loadBalanceStrategy: "round_robin" },
    hops: [], entryHostIds: [1, 5], hosts,
    exits: [{ hostId: 6, listenPort: 6006, connectHost: "nat.example.test" }, { hostId: 2, listenPort: 22, isEnabled: "0" }],
  });
  assert.equal(probes.length, 4);
  assert.deepEqual(probes.filter(probe => probe.toHostId === 6).map(probe => [probe.targetIp, probe.targetPort]),
    [["nat.example.test", 6006], ["nat.example.test", 6006]]);
});

test("multi-entry serial paths share downstream hops and require a complete path", () => {
  const probes = planManualTunnelProbes({ tunnel, hops, entryHostIds: [1, 5], exits: [], hosts });
  assert.equal(probes.length, 4);
  const details = probes.map(probe => ({ ...probe, success: true, latencyMs: 10 }));
  details[0].success = false;
  assert.deepEqual(aggregateManualTunnelProbes(details), { success: true, latencyMs: 30, available: 1, total: 2 });
  details.find(detail => detail.fromHostId === 3)!.success = false;
  assert.equal(aggregateManualTunnelProbes(details).success, false);
});

test("invalid endpoint ports are rejected before publishing a batch", () => {
  for (const port of [0, 65536, 1.5]) assert.throws(() => planManualTunnelProbes({
    tunnel: { ...tunnel, listenPort: port }, hops: [], exits: [], entryHostIds: [1], hosts,
  }), /TARGET_INVALID/);
});

test("durable batches recover after a real process restart and preserve timeout/generation boundaries", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-manual-probe-"));
  const databasePath = path.join(directory, "probe.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const url = name => pathToFileURL(path.join(process.cwd(), name)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    try {
      if (process.env.FORWARDX_PROBE_STAGE === "seed") {
        // Start with the pre-upgrade table, so this also verifies additive
        // schema migration rather than testing only a brand-new database.
        await runtime.executeRaw("CREATE TABLE forward_tests (id INTEGER PRIMARY KEY AUTOINCREMENT, ruleId INTEGER NOT NULL, hostId INTEGER NOT NULL, userId INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', listenOk INTEGER NOT NULL DEFAULT 0, targetReachable INTEGER NOT NULL DEFAULT 0, forwardOk INTEGER NOT NULL DEFAULT 0, latencyMs INTEGER, message TEXT, createdAt INTEGER NOT NULL DEFAULT (unixepoch()), updatedAt INTEGER NOT NULL DEFAULT (unixepoch()))");
      }
      await (await import(url("server/dbSchema.ts"))).ensureDatabaseSchema();
      const tests = await import(url("server/repositories/forwardTestRepository.ts"));
      const metrics = await import(url("server/repositories/metricsRepository.ts"));
      const manual = await import(url("server/tunnelManualProbe.ts"));
      const chain = await import(url("server/forwardChainManualProbe.ts"));
      const now = Math.floor(Date.now() / 1000);
      const tunnel = { id: 1, userId: 1, name: "test", entryHostId: 1, exitHostId: 3, listenPort: 4003, isRunning: true };
      const probes = [
        { fromHostId: 1, toHostId: 2, targetIp: "192.0.2.2", targetPort: 4002, hopIndex: 0, hopCount: 2, pathKeys: ["main"], routeLabel: "A -> B", hopLabel: "1/2 1->2" },
        { fromHostId: 2, toHostId: 3, targetIp: "192.0.2.3", targetPort: 4003, hopIndex: 1, hopCount: 2, pathKeys: ["main"], routeLabel: "B -> C", hopLabel: "2/2 2->3" },
      ];
      const loadTunnel = async () => (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = 1'))[0];
      const batchRows = batchId => runtime.queryRaw('SELECT * FROM "forward_tests" WHERE "batchId" = ? ORDER BY "id"', [batchId]);
      if (process.env.FORWARDX_PROBE_STAGE === "seed") {
        await runtime.insertAndGetId("tunnels", tunnel);
        // A surrounding rollback must not expose rows or a pending summary.
        await assert.rejects(runtime.withDatabaseTransaction(async () => {
          await manual.queueManualTunnelProbeBatch(tunnel, probes);
          throw new Error("rollback");
        }), /rollback/);
        assert.equal((await runtime.queryRaw('SELECT * FROM "forward_tests"')).length, 0);
        assert.equal((await loadTunnel()).lastTestStatus, null);
        const old = await manual.queueManualTunnelProbeBatch(tunnel, probes);
        assert.equal((await batchRows(old.batchId)).length, 2);
        assert.equal((await manual.queueManualTunnelProbeBatch(tunnel, probes)).batchId, old.batchId, "repeat click reuses the live batch");
        await metrics.insertTunnelLatencyStat({ tunnelId: 1, latencyMs: 4, isTimeout: false }, { preserveMessage: true });
        assert.equal((await loadTunnel()).lastTestStatus, "pending", "periodic probes cannot finish a manual batch");
        const oldRows = await batchRows(old.batchId);
        await tests.completeForwardTestIfActive(oldRows[1].id, { status: "success", latencyMs: 11 });
        assert.equal(await manual.settleManualTunnelProbeBatch(old.batchId), false);
        const partial = JSON.parse((await loadTunnel()).lastTestMessage);
        assert.equal(partial.details[0].pending, true);
        assert.equal(partial.details[1].pending, false);
        assert.equal(partial.details[1].latencyMs, 11);
        // A changed topology supersedes, but is never overwritten by old reports.
        const newer = await manual.queueManualTunnelProbeBatch(tunnel, probes.map(probe => ({ ...probe, targetPort: probe.targetPort + 1 })));
        assert.notEqual(newer.batchId, old.batchId);
        await tests.completeForwardTestIfActive(oldRows[0].id, { status: "success", latencyMs: 12 });
        await manual.settleManualTunnelProbeBatch(old.batchId);
        assert.equal(JSON.parse((await loadTunnel()).lastTestMessage).batchId, newer.batchId);
        for (const row of await batchRows(newer.batchId)) {
          await tests.completeForwardTestIfActive(row.id, { status: "success", latencyMs: 13 });
        }
        // Simulate a process exiting after durable reports but before finalization.
        for (let hop = 0; hop < 2; hop++) {
          const id = await tests.createForwardTest({ ruleId: 19, hostId: hop + 1, userId: 1, batchId: "fc-restart",
            message: JSON.stringify({ kind: "forward-chain", groupId: 9, hopLabel: String(hop), routeLabel: hop ? "B -> C" : "A -> B", method: "tcp" }) });
          await tests.completeForwardTestIfActive(id, { status: "success", latencyMs: 7 });
        }
      } else {
        await manual.recoverManualTunnelProbeBatches();
        const recovered = await loadTunnel();
        assert.equal(recovered.lastTestStatus, "success");
        assert.equal(recovered.lastLatencyMs, 26);
        assert.equal(Number(recovered.isRunning), 1, "probe completion never changes runtime state");
        const batch = (await runtime.queryRaw('SELECT "batchId" FROM "forward_tests" WHERE "batchId" LIKE \'tp-%\' ORDER BY "id" DESC LIMIT 1'))[0].batchId;
        const samplesBefore = (await runtime.queryRaw('SELECT * FROM "tunnel_latency_stats"')).length;
        await Promise.all([manual.settleManualTunnelProbeBatch(batch), manual.settleManualTunnelProbeBatch(batch)]);
        assert.equal((await runtime.queryRaw('SELECT * FROM "tunnel_latency_stats"')).length, samplesBefore, "duplicate reports cannot add duplicate history");
        await chain.recoverManualForwardChainBatches();
        const summary = await tests.getLatestForwardTest(19);
        assert.equal(summary.latencyMs, 14);
        assert.equal(JSON.parse(summary.message).details.length, 2);
        assert.equal(await chain.settleManualForwardChainBatch("fc-restart"), false);
        // Renewing a delivery lease must not move the original runtime deadline.
        const id = await tests.createForwardTest({ ruleId: 0, hostId: 20, userId: 1,
          message: JSON.stringify({ kind: "tunnel-hop", tunnelId: 1 }) });
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 40, now - 10, id]);
        assert.equal(await tests.markForwardTestRunning(id), true);
        assert.equal(Number((await tests.getForwardTestById(id)).firstDispatchedAt.getTime()) / 1000, now - 40);
        await runtime.executeRaw('UPDATE "forward_tests" SET "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 46, now, id]);
        assert.equal(await tests.markForwardTestRunning(id), false);
        assert.equal((await tests.getPendingForwardTestsByHost(20)).length, 0);
        assert.equal((await metrics.timeoutStaleForwardTests(8, () => 45)).some(row => row.id === id), true);
        const ancient = await tests.createForwardTest({ ruleId: 0, hostId: 21, userId: 1 });
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "createdAt" = ?, "firstDispatchedAt" = ?, "updatedAt" = ? WHERE "id" = ?', [now - 91, now, now, ancient]);
        assert.equal(await tests.markForwardTestRunning(ancient), false);
        assert.equal((await metrics.timeoutStaleForwardTests(8, () => 45)).some(row => row.id === ancient), true);
        const alternatives = probes.map((probe, index) => ({ ...probe, fromHostId: 1, hopIndex: 0, hopCount: 1, pathKeys: ["exit-" + index] }));
        const partialBatch = await manual.queueManualTunnelProbeBatch(tunnel, alternatives);
        const partialRows = await batchRows(partialBatch.batchId);
        await tests.completeForwardTestIfActive(partialRows[0].id, { status: "success", latencyMs: 5 });
        await runtime.executeRaw('UPDATE "forward_tests" SET "status" = \'running\', "firstDispatchedAt" = ? WHERE "id" = ?', [now - 46, partialRows[1].id]);
        await metrics.timeoutStaleForwardTests(8, () => 45);
        assert.equal(await manual.settleManualTunnelProbeBatch(partialBatch.batchId), true);
        assert.equal((await loadTunnel()).lastLatencyMs, 5, "a timed-out alternative does not invalidate a complete healthy path");
        assert.equal((await loadTunnel()).lastTestStatus, "success");
        assert.equal(await tests.completeForwardTestIfActive(partialRows[1].id, { status: "success", latencyMs: 7 }), false);
        // Repair the exact pre-upgrade success + pending-details contradiction.
        await runtime.executeRaw('UPDATE "tunnels" SET "lastTestStatus" = \'success\', "lastTestMessage" = ?, "lastTestAt" = ? WHERE "id" = 1',
          [JSON.stringify({ kind: "tunnel-hop-pending", generatedAt: new Date((now - 120) * 1000).toISOString(), details: [{ pending: true }] }), now]);
        await manual.recoverManualTunnelProbeBatches();
        assert.equal((await loadTunnel()).lastTestStatus, "failed");
        assert.equal(JSON.parse((await loadTunnel()).lastTestMessage).details[0].pending, false);
      }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    for (const stage of ["seed", "recover"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath,
          FORWARDX_PROBE_STAGE: stage, FORWARDX_LOG_DIR: directory }, encoding: "utf8", timeout: 60_000,
      });
      assert.equal(result.status, 0, `${stage}: ${result.stderr || result.stdout}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

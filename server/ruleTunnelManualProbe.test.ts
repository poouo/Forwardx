import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRuleTunnelProbeResult } from "./ruleTunnelProbeResult";

function sample(id: number, pathKeys: string[], status = "pending", latencyMs: number | null = null) {
  const requestMessage = JSON.stringify({ tunnelId: 4, pathKeys, fromHostId: id });
  return { id, ruleId: 2, requestMessage, message: requestMessage, status, latencyMs };
}

for (const first of [0, 1, 2]) test(`entry/target result ${first} can arrive first without completing other segments`, () => {
  const rows = [sample(1, ["a"]), sample(2, ["b"]), sample(3, ["a", "b"])];
  for (const index of [first, ...[0, 1, 2].filter(index => index !== first)]) {
    rows[index].status = "success";
    rows[index].latencyMs = 10 + index;
    const result = buildRuleTunnelProbeResult(rows)!;
    const details = JSON.parse(result.message).details;
    assert.equal(details[index].latencyMs, 10 + index);
    assert.equal(details[index].pending, false);
    assert.equal(result.status === "running", rows.some(row => row.status === "pending"));
    rows.forEach((row, index) => assert.equal(details[index].pending, row.status === "pending"));
  }
  assert.equal(buildRuleTunnelProbeResult(rows)?.latencyMs, 23, "take the maximum available complete path, not sum parallel entries");
});

test("an unreported entry is pending, then explicitly times out without discarding a healthy path", () => {
  const rows = [sample(1, ["a"], "success", 6), sample(2, ["b"]), sample(3, ["a", "b"], "success", 1)];
  assert.equal(buildRuleTunnelProbeResult(rows)?.status, "running");
  assert.equal(buildRuleTunnelProbeResult(rows)?.latencyMs, 7);
  rows[1].status = "timeout";
  const result = buildRuleTunnelProbeResult(rows)!;
  assert.equal(result.status, "success");
  const details = JSON.parse(result.message).details;
  assert.equal(details[0].latencyMs, 6);
  assert.equal(details[1].pending, false);
  assert.match(details[1].message, /未在截止时间内收到/);
  assert.equal(result.latencyMs, 7);
  rows[2].status = "failed";
  assert.notEqual(buildRuleTunnelProbeResult(rows)?.status, "success", "every path requires its exit-to-target result");
});

test("rule tunnel batches stream durable results, isolate generations and recover after process restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-probe-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { pathToFileURL } from "node:url";
    import path from "node:path";
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const db = await mod("server/db.ts");
    const batches = await mod("server/ruleTunnelManualProbe.ts");
    const metrics = await mod("server/repositories/metricsRepository.ts");
    const { selfTestRulesRouter } = await mod("server/routers/rules.selfTest.ts");
    const { Router } = await import("express");
    const { registerAgentSelfTestRoutes } = await mod("server/agentSelfTestRoutes.ts");
    const router = Router(); registerAgentSelfTestRoutes(router);
    const request = async (route, hostId, body = {}) => {
      let result;
      await router.stack.find(layer => layer.route?.path === route).route.stack[0].handle(
        { agentToken: "token-" + hostId, body },
        { json: value => result = value, status: code => { throw new Error("HTTP " + code); } });
      return result;
    };
    const caller = selfTestRulesRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
    const rowsFor = batchId => runtime.queryRaw('SELECT * FROM forward_tests WHERE batchId = ? ORDER BY id', [batchId]);
    const start = async () => {
      const result = await caller.startSelfTest({ ruleId: 2 });
      const row = await db.getForwardTestById(result.id);
      return rowsFor(row.batchId);
    };
    const report = async (row, latencyMs) => request("/api/agent/selftest-result", row.hostId,
      { testId: row.id, targetReachable: true, latencyMs });
    const details = result => JSON.parse(result.message).details;
    try {
      if (process.env.FORWARDX_PROBE_STAGE === "seed") {
        for (let id = 1; id <= 3; id++) await runtime.insertAndGetId("hosts", {
          id, name: "host-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id,
          userId: 1, isOnline: true, agentToken: "token-" + id,
        });
        await runtime.insertAndGetId("forward_groups", { id: 1, name: "entries", userId: 1, groupMode: "entry", groupType: "host", isEnabled: true, targetIp: "198.51.100.1" });
        for (let id = 1; id <= 2; id++) await runtime.insertAndGetId("forward_group_members", {
          groupId: 1, memberType: "host", hostId: id, isEnabled: true,
        });
        await runtime.insertAndGetId("tunnels", { id: 4, userId: 1, name: "multi-entry", entryHostId: 1,
          entryGroupId: 1, exitHostId: 3, listenPort: 4003, mode: "tls", isEnabled: true });
        await runtime.insertAndGetId("forward_rules", { id: 2, userId: 1, name: "rule", hostId: 1, tunnelId: 4,
          sourcePort: 12000, targetIp: "198.51.100.1", targetPort: 443, protocol: "tcp", forwardType: "gost-tunnel" });
        const unauthorized = selfTestRulesRouter.createCaller({ user: { id: 9, role: "user" }, req: { headers: {} }, res: {} });
        await assert.rejects(() => unauthorized.startSelfTest({ ruleId: 2 }), /无权操作/);
        const rows = await start();
        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map(row => row.hostId), [1, 2, 3]);
        const initial = await db.getLatestForwardTest(2);
        assert.equal(initial.status, "running");
        assert.equal(details(initial).every(detail => detail.pending), true);
        for (const row of rows) {
          const pulled = await request("/api/agent/selftest-pull", row.hostId);
          assert.equal(pulled.selfTests.some(test => test.testId === row.id), true);
        }
        // The second entry wins this race; the target then arrives while entry 1 waits.
        await report(rows[1], 8);
        await report(rows[2], 1);
        const partial = await db.getLatestForwardTest(2, { includeActive: false });
        assert.equal(partial.id, initial.id, "logical test id does not change with report order");
        assert.equal(partial.status, "running");
        assert.deepEqual(details(partial).map(detail => detail.pending), [true, false, false]);
        assert.equal(details(partial)[1].latencyMs, 8);
        assert.equal(await batches.settleRuleTunnelProbeBatch(rows[0].batchId), false);
        assert.equal((await runtime.queryRaw('SELECT * FROM tcping_stats WHERE ruleId = 2')).length, 0);
        // Finish the last row but deliberately simulate a crash before finalization.
        await db.completeForwardTestIfActive(rows[0].id, { status: "success", latencyMs: 6 });
      } else {
        await batches.recoverRuleTunnelProbeBatches();
        const completed = await db.getLatestForwardTest(2);
        assert.equal(completed.status, "success");
        assert.equal(completed.latencyMs, 9);
        assert.deepEqual(details(completed).map(detail => detail.latencyMs), [6, 8, 1]);
        const oldRows = await rowsFor(completed.batchId);
        await batches.recoverRuleTunnelProbeBatches();
        assert.equal((await runtime.queryRaw('SELECT * FROM tcping_stats WHERE ruleId = 2')).length, 1);
        assert.equal((await report(oldRows[0], 99)).ignored, true, "duplicate reports cannot overwrite a received segment");
        const fresh = await start();
        assert.equal(details(await db.getLatestForwardTest(2)).every(detail => detail.pending), true, "do not reuse yesterday's samples");
        await report(oldRows[1], 99);
        assert.equal((await db.getLatestForwardTest(2)).batchId, fresh[0].batchId, "late old generation cannot replace the new test");
        await report(fresh[0], 6);
        await report(fresh[2], 1);
        const now = Math.floor(Date.now() / 1000);
        await runtime.executeRaw('UPDATE forward_tests SET createdAt = ?, updatedAt = ? WHERE id = ?', [now - 91, now - 91, fresh[1].id]);
        await metrics.timeoutStaleForwardTests(8, () => 45);
        await batches.recoverRuleTunnelProbeBatches();
        const partialSuccess = await db.getLatestForwardTest(2);
        assert.equal(partialSuccess.status, "success");
        assert.equal(partialSuccess.latencyMs, 7);
        assert.equal(details(partialSuccess).some(detail => detail.pending), false);
        assert.match(details(partialSuccess)[1].message, /未在截止时间/);
        assert.equal((await runtime.queryRaw('SELECT * FROM tcping_stats WHERE ruleId = 2')).length, 2);
        assert.equal((await runtime.queryRaw('SELECT lastTestStatus FROM tunnels WHERE id = 4'))[0].lastTestStatus, null,
          "rule probes do not modify tunnel running/testing state");
      }
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    for (const stage of ["seed", "recover"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "probe.db"),
          FORWARDX_PROBE_STAGE: stage, FORWARDX_LOG_DIR: directory }, encoding: "utf8", timeout: 90_000,
      });
      assert.equal(result.status, 0, `${stage}: ${result.stderr || result.stdout}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

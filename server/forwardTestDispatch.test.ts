import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const driver of ["mysql", "postgresql"] as const) {
  test(`${driver}: self-test activation cannot lend its transaction connection to the background sweep`, () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      import mysql from "mysql2/promise";
      import pg from "pg";
      const runtime = await import("./server/dbRuntime.ts");
      const { databaseHealth } = await import("./server/databaseHealthState.ts");
      const { selfTestSweepActivity, startSelfTestSweepTimer } = await import("./server/selfTestTiming.ts");
      const { createForwardTest } = await import("./server/repositories/forwardTestRepository.ts");
      const driver = process.env.DATABASE_TYPE;
      const originalMysql = mysql.createPool;
      const originalPg = pg.Pool.prototype.connect;
      let checkouts = 0;
      const checkout = async () => {
        checkouts++;
        const query = async argument => {
          const sql = typeof argument === "string" ? argument : argument.text || argument.sql;
          const rows = [{ id: 1, ok: 1, version: "8.0.24" }];
          return driver === "mysql"
            ? [/^INSERT/i.test(sql) ? { insertId: 1 } : rows, []]
            : { rows, rowCount: 1 };
        };
        return { query, execute: query, beginTransaction: async () => {}, commit: async () => {},
          rollback: async () => {}, release() {}, destroy() {} };
      };
      mysql.createPool = () => ({ getConnection: checkout, end: async () => {} });
      pg.Pool.prototype.connect = checkout;
      let stop = () => {};
      let complete;
      const swept = new Promise(resolve => { complete = resolve; });
      let commitComplete;
      const committed = new Promise(resolve => { commitComplete = resolve; });
      const errors = [];
      const inheritedTransactions = [];
      let sweepCheckouts = 0;
      try {
        const credentials = { host: "127.0.0.1", port: 12345, user: "test", password: "test-only", database: "test" };
        await runtime.connectDatabase({ type: driver, [driver]: credentials });
        databaseHealth.healthy();
        stop = startSelfTestSweepTimer(async () => {
          await committed;
          inheritedTransactions.push(runtime.isDatabaseTransactionActive());
          const before = checkouts;
          try { await runtime.queryRaw("SELECT sweep"); }
          catch (error) { errors.push({ code: error.code, message: error.message }); }
          sweepCheckouts += checkouts - before;
          complete();
        }, { intervalMs: 5 });
        await runtime.withDatabaseTransaction(async () => {
          assert.equal(runtime.isDatabaseTransactionActive(), true);
          // The real repository wakes the sweep inside the self-test transaction.
          await createForwardTest({ ruleId: 1, hostId: 1, userId: 1, status: "pending" });
        });
        commitComplete();
        let deadline;
        try {
          await Promise.race([swept, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("sweep never ran")), 2000);
          })]);
        } finally { clearTimeout(deadline); }
        stop();
        assert.deepEqual(errors, [], "a committed self-test must not poison the sweep with a released lease");
        assert.deepEqual(inheritedTransactions, [false]);
        assert.equal(sweepCheckouts, 1, "background sweep must check out its own connection");
        assert.equal(databaseHealth.snapshot().state, "healthy");
      } finally {
        stop();
        await runtime.closeDatabase();
        databaseHealth.healthy();
        mysql.createPool = originalMysql;
        pg.Pool.prototype.connect = originalPg;
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: driver }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

test("forward self-test leases recover lost deliveries and give claimed work a fresh timeout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-selftest-dispatch-"));
  const databasePath = path.join(directory, "dispatch.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const tests = await import(url("server/repositories/forwardTestRepository.ts"));
      const metrics = await import(url("server/repositories/metricsRepository.ts"));
      const indexes = await runtime.queryRaw('PRAGMA index_list("forward_tests")');
      const indexColumns = await Promise.all(indexes.map(async (index) => (
        (await runtime.queryRaw('PRAGMA index_info("' + String(index.name).replaceAll('"', '""') + '")'))
          .map((column) => String(column.name))
      )));
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,createdAt"), true);
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,updatedAt"), true);
      const now = Math.floor(Date.now() / 1000);
      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, 0, 10, 1, "pending", now, now],
      );

      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.deepEqual(await tests.getPendingForwardTestsByHost(10), []);
      assert.equal(await tests.markForwardTestRunning(1), false);

      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 20, 1]);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "success", latencyMs: 12 }), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "failed" }), false);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2, 0, 11, 1, "running", now - 60, now],
      );
      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual(await metrics.timeoutStaleForwardTests(30), []);
      assert.equal(await tests.completeForwardTestIfActive(2, { status: "success", latencyMs: 9 }), true);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [3, 0, 12, 1, "running", now - 60, now - 40],
      );
      const timedOut = await metrics.timeoutStaleForwardTests(30);
      assert.deepEqual(timedOut.map((row) => Number(row.id)), [3]);
      assert.equal(await tests.hasActiveForwardTests(), false);
      assert.equal(await tests.completeForwardTestIfActive(3, { status: "success", latencyMs: 9 }), false);
      const timeoutRow = (await runtime.queryRaw('SELECT "status" FROM "forward_tests" WHERE "id" = ?', [3]))[0];
      assert.equal(timeoutRow.status, "timeout");

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          4, 4, 14, 1, "running", JSON.stringify({ kind: "direct" }), now - 60, now - 10,
          5, 0, 15, 1, "running", JSON.stringify({ kind: "tunnel", tunnelId: 5 }), now - 60, now - 10,
        ],
      );
      const timeoutForTest = (row) => {
        try {
          const kind = JSON.parse(String(row.message || "{}"))?.kind;
          return kind === "tunnel" ? 30 : 8;
        } catch {
          return 8;
        }
      };
      const shortTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(shortTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[4, 8]]);
      assert.equal(await tests.hasActiveForwardTests(), true);

      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 40, 5]);
      const runtimeTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(runtimeTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[5, 30]]);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          6, 20, 20, 1, "success", now, now,
          7, 20, 20, 1, "failed", now, now,
        ],
      );
      const latestCompleted = await tests.getLatestForwardTest(20, { includeActive: false });
      assert.equal(Number(latestCompleted?.id), 7, "completed rows with equal timestamps must prefer the larger id");

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          8, 20, 20, 1, "pending", now, now,
          9, 20, 20, 1, "running", now, now,
        ],
      );
      const latestActive = await tests.getLatestForwardTest(20);
      assert.equal(Number(latestActive?.id), 9, "active rows with equal timestamps must prefer the larger id");
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

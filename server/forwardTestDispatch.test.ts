import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward self-test leases recover lost deliveries and keep an absolute timeout", () => {
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
      const now = Math.floor(Date.now() / 1000);
      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, 0, 10, 1, "pending", now, now],
      );

      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.deepEqual(await tests.getPendingForwardTestsByHost(10), []);
      assert.equal(await tests.markForwardTestRunning(1), false);

      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 20, 1]);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "success", latencyMs: 12 }), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "failed" }), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2, 0, 11, 1, "running", now - 60, now],
      );
      const timedOut = await metrics.timeoutStaleForwardTests(30);
      assert.deepEqual(timedOut.map((row) => Number(row.id)), [2]);
      assert.equal(await tests.completeForwardTestIfActive(2, { status: "success", latencyMs: 9 }), false);
      const timeoutRow = (await runtime.queryRaw('SELECT "status" FROM "forward_tests" WHERE "id" = ?', [2]))[0];
      assert.equal(timeoutRow.status, "timeout");
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

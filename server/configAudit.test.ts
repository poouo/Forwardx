import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashConfig } from "./configAudit";

test("config hashes are stable and exclude volatile runtime fields", () => {
  const left = hashConfig({ name: "rule", updatedAt: 1, isRunning: false, password: "first" });
  const right = hashConfig({ password: "first", isRunning: true, updatedAt: 2, name: "rule" });
  assert.equal(left, right);
  assert.notEqual(left, hashConfig({ name: "rule", password: "second" }));
});

test("SQLite schema records a redacted monotonic configuration audit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-config-audit-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const audit = await import(moduleUrl("server/configAudit.ts"));
    const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await audit.runWithConfigAuditContext({ actorUserId: 7, actorName: "admin", source: "test" }, async () => {
        const id = await hosts.createHost({ name: "edge", ip: "127.0.0.1", userId: 7, agentToken: "top-secret" });
        await hosts.updateHost(id, { name: "edge-2" });
      });
      const rows = await runtime.queryRaw('SELECT "id", "actorUserId", "afterJson" FROM "config_audit_events" ORDER BY "id"');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].actorUserId, 7);
      assert.ok(rows[1].id > rows[0].id);
      assert.match(rows[0].afterJson, /\[REDACTED\]/);
      assert.doesNotMatch(rows[0].afterJson, /top-secret/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

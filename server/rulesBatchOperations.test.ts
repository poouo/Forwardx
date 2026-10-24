import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("bulk rule operations preserve statistics and enforce ownership, readonly and paused states", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-batch-rules-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const insert = async (table, data) => {
      const quote = (name) => '"' + name + '"';
      await runtime.executeRaw("INSERT INTO " + quote(table) + " (" + Object.keys(data).map(quote).join(", ") + ") VALUES (" + Object.values(data).map(() => "?").join(", ") + ")", Object.values(data));
    };
    const caller = (id, role) => rulesRouter.createCaller({
      req: { headers: {} }, res: { clearCookie() {} },
      user: { id, username: "test-" + id, role, accountEnabled: true },
      authSession: null, authFailureReason: null,
    });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      for (const id of [1, 2, 3]) await insert("users", { id, username: "test-" + id, password: "x", role: id === 1 ? "admin" : "user", accountEnabled: 1, canAddRules: 1, balanceCents: 1000 });
      await insert("hosts", { id: 1, name: "test-entry", ip: "198.51.100.10", userId: 1 });
      const base = { hostId: 1, userId: 1, name: "test", forwardType: "iptables", protocol: "tcp", targetIp: "203.0.113.10", targetPort: 443, isEnabled: 1, isRunning: 1, quotaUsedIn: 1234, quotaUsedOut: 5678 };
      await insert("forward_rules", { ...base, id: 1, sourcePort: 15001 });
      await insert("forward_rules", { ...base, id: 2, sourcePort: 15002, userId: 2, isEnabled: 0, disabledByUser: 1 });
      await insert("forward_rules", { ...base, id: 3, sourcePort: 15003, userId: 2 });
      await insert("forward_rules", { ...base, id: 4, sourcePort: 15004, pendingDelete: 1 });
      await insert("forward_rules", { ...base, id: 5, sourcePort: 15005, userId: 2, adminManaged: 1 });
      await insert("forward_rule_traffic_counters", { ruleId: 1, hostId: 1, userId: 1, bytesIn: 1234, bytesOut: 5678 });
      const admin = caller(1, "admin"), customer = caller(2, "user");
      await admin.restart({ id: 1 });
      const [running] = await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = 1');
      assert.equal(Number(running.isEnabled), 1);
      assert.equal(Number(running.isRunning), 0);
      assert.equal(Number(running.quotaUsedIn), 1234);
      assert.equal(Number(running.quotaUsedOut), 5678);
      const [traffic] = await runtime.queryRaw('SELECT * FROM "forward_rule_traffic_counters" WHERE "ruleId" = 1');
      assert.equal(Number(traffic.bytesIn), 1234);
      assert.equal(Number(traffic.bytesOut), 5678);
      assert.equal((await customer.restart({ id: 2 })).skipped, true);
      const [paused] = await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = 2');
      assert.equal(Number(paused.isEnabled), 0);
      assert.equal(Number(paused.disabledByUser), 1);
      await assert.rejects(() => customer.restart({ id: 1 }), /无权/);
      await assert.rejects(() => customer.restart({ id: 3 }), /无权|权限/);
      await assert.rejects(() => customer.restart({ id: 5 }), /仅可查看/);
      await assert.rejects(() => admin.restart({ id: 4 }), /已删除/);
      await admin.toggle({ id: 1, isEnabled: false });
      assert.equal((await admin.restart({ id: 1 })).skipped, true);
      const deleted = await customer.deleteBatch({ ids: [1, 2] });
      assert.deepEqual(deleted.deletedIds, [2]);
      assert.deepEqual(deleted.failures.map(item => item.id), [1]);
      await assert.rejects(() => admin.restart({ id: 0 }));
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "batch.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

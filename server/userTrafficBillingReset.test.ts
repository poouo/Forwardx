import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manual user traffic reset rebases billing display without changing billing ledgers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-user-traffic-reset-"));
  const databasePath = path.join(directory, "traffic-reset.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      const users = await import(moduleUrl("server/repositories/userRepository.ts"));
      const commands = await import(moduleUrl("server/services/userCommandService.ts"));

      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role", "trafficLimit", "trafficUsed", "balanceCents") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [7, "billing-admin", "hash", "admin", 1000, 800, 1234],
      );
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role", "trafficBillingResetBytes") VALUES (?, ?, ?, ?, ?)',
        [8, "clamped-user", "hash", "user", 999],
      );
      await runtime.executeRaw(
        'INSERT INTO "traffic_billing_usage" ("userId", "resourceType", "resourceId", "totalBytes", "billedGb") VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
        [7, "host", 11, 150, 1, 7, "tunnel", 22, 350, 2, 8, "host", 33, 10, 0],
      );
      await runtime.executeRaw(
        'INSERT INTO "traffic_billing_rule_usage" ("userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb") VALUES (?, ?, ?, ?, ?, ?)',
        [7, 70, "host", 11, 150, 1],
      );
      await runtime.executeRaw(
        'INSERT INTO "traffic_billing_records" ("userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [7, 70, "host", 11, 150, 1, 25, 1234],
      );

      const initialPage = await users.getUsersPage({ page: 1, pageSize: 20 });
      const initialById = new Map(initialPage.items.map((user) => [Number(user.id), user]));
      assert.equal(Number(initialById.get(7)?.trafficBillingUsed), 500);
      assert.equal(Number(initialById.get(8)?.trafficBillingUsed), 0, "display usage must not go negative");
      assert.equal(Number((await users.getAllUsers()).find((user) => Number(user.id) === 7)?.trafficBillingUsed), 500);

      const ledgersBefore = {
        usage: await runtime.queryRaw('SELECT "userId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_usage" WHERE "userId" = ? ORDER BY "resourceType", "resourceId"', [7]),
        ruleUsage: await runtime.queryRaw('SELECT "userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_rule_usage" WHERE "userId" = ?', [7]),
        records: await runtime.queryRaw('SELECT "userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents" FROM "traffic_billing_records" WHERE "userId" = ?', [7]),
      };

      await commands.resetUserTrafficCommand({ actor: { id: 7, role: "admin" }, targetUserId: 7 });

      let user = await users.getUserById(7);
      assert.equal(Number(user?.trafficUsed), 0);
      assert.equal(Number(user?.trafficBillingResetBytes), 500);
      assert.equal(Number(user?.balanceCents), 1234);
      assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 0);
      assert.deepEqual(
        await runtime.queryRaw('SELECT "userId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_usage" WHERE "userId" = ? ORDER BY "resourceType", "resourceId"', [7]),
        ledgersBefore.usage,
      );
      assert.deepEqual(
        await runtime.queryRaw('SELECT "userId", "ruleId", "resourceType", "resourceId", "totalBytes", "billedGb" FROM "traffic_billing_rule_usage" WHERE "userId" = ?', [7]),
        ledgersBefore.ruleUsage,
      );
      assert.deepEqual(
        await runtime.queryRaw('SELECT "userId", "ruleId", "resourceType", "resourceId", "bytes", "billedGb", "amountCents", "balanceAfterCents" FROM "traffic_billing_records" WHERE "userId" = ?', [7]),
        ledgersBefore.records,
      );

      await runtime.executeRaw(
        'UPDATE "traffic_billing_usage" SET "totalBytes" = "totalBytes" + ? WHERE "userId" = ? AND "resourceType" = ? AND "resourceId" = ?',
        [125, 7, "host", 11],
      );
      await runtime.executeRaw('UPDATE "users" SET "trafficUsed" = ? WHERE "id" = ?', [99, 7]);
      assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 125);

      await users.resetUserTraffic(7);
      user = await users.getUserById(7);
      assert.equal(Number(user?.trafficUsed), 0);
      assert.equal(Number(user?.trafficBillingResetBytes), 500, "scheduled package reset must retain the billing display baseline");
      assert.equal(Number((await users.getUsersPage({ page: 1, pageSize: 20 })).items.find((item) => Number(item.id) === 7)?.trafficBillingUsed), 125);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

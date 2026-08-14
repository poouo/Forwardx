import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("security-sensitive database workflows remain atomic under concurrency", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-security-concurrency-"));
  const databasePath = path.join(directory, "security.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const traffic = await import(url("server/repositories/trafficBillingRepository.ts"));
    const settings = await import(url("server/repositories/settingsRepository.ts"));
    const GB = 1024 * 1024 * 1024;

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      const loginCode = "APPSECURITYCONCURRENCYLOGINCODE01";
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role", "telegramLoginCode", "telegramLoginCodeExpiresAt") VALUES (?, ?, ?, ?, ?, ?)',
        [1, "telegram-user", "hash", "user", loginCode, Math.floor(Date.now() / 1000) + 300],
      );
      const loginConsumers = await Promise.all(
        Array.from({ length: 12 }, () => users.consumeTelegramLoginCode(loginCode)),
      );
      assert.equal(loginConsumers.filter(Boolean).length, 1, "a Telegram login code must create at most one session candidate");
      assert.equal((await users.getUserById(1)).telegramLoginCode, null);

      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        [2, "plan-user-a", "hash", "user", 3, "plan-user-b", "hash", "user"],
      );
      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "userId", "portRangeStart", "portRangeEnd") VALUES (?, ?, ?, ?, ?, ?)',
        [10, "subscription-host", "127.0.0.1", 1, 20000, 20009],
      );
      await runtime.executeRaw(
        'INSERT INTO "subscription_plans" ("id", "name", "durationDays", "portCount", "trafficLimit") VALUES (?, ?, ?, ?, ?)',
        [20, "concurrent-plan", 30, 2, 0],
      );
      await runtime.executeRaw(
        'INSERT INTO "subscription_plan_hosts" ("planId", "hostId") VALUES (?, ?)',
        [20, 10],
      );
      const subscriptions = await Promise.all([
        billing.applySubscriptionToUser(2, 20, "admin"),
        billing.applySubscriptionToUser(3, 20, "admin"),
      ]);
      const ranges = subscriptions
        .map((item) => [Number(item.portRangeStart), Number(item.portRangeEnd)])
        .sort((left, right) => left[0] - right[0]);
      assert.deepEqual(ranges, [[20000, 20001], [20002, 20003]]);

      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "role", "balanceCents") VALUES (?, ?, ?, ?, ?)',
        [7, "billing-user", "hash", "user", 100],
      );
      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "userId") VALUES (?, ?, ?, ?)',
        [5, "billing-host", "127.0.0.1", 7],
      );
      await runtime.executeRaw(
        'INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [12, 5, "billing-rule", "gost", "tcp", 12012, "127.0.0.1", 80, 7],
      );
      await runtime.executeRaw(
        'INSERT INTO "traffic_billing_configs" ("resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier") VALUES (?, ?, ?, ?, ?, ?)',
        ["host", 5, 1, 0, 1, 100],
      );
      await settings.setSetting("trafficBillingEnabled", "true");
      await Promise.all(Array.from({ length: 8 }, () => traffic.billTrafficUsage({
        userId: 7,
        ruleId: 12,
        bytes: GB / 4,
        resourceType: "host",
        resourceId: 5,
      })));

      const [usage] = await runtime.queryRaw(
        'SELECT "totalBytes", "billedGb" FROM "traffic_billing_usage" WHERE "userId" = ? AND "resourceType" = ? AND "resourceId" = ?',
        [7, "host", 5],
      );
      const [ruleUsage] = await runtime.queryRaw(
        'SELECT "totalBytes", "billedGb" FROM "traffic_billing_rule_usage" WHERE "ruleId" = ?',
        [12],
      );
      const [billed] = await runtime.queryRaw(
        'SELECT COUNT(*) AS "count", COALESCE(SUM("amountCents"), 0) AS "amount" FROM "traffic_billing_records" WHERE "userId" = ?',
        [7],
      );
      const [billingUser] = await runtime.queryRaw('SELECT "balanceCents" FROM "users" WHERE "id" = ?', [7]);
      assert.deepEqual({ totalBytes: Number(usage.totalBytes), billedGb: Number(usage.billedGb) }, { totalBytes: 2 * GB, billedGb: 2 });
      assert.deepEqual({ totalBytes: Number(ruleUsage.totalBytes), billedGb: Number(ruleUsage.billedGb) }, { totalBytes: 2 * GB, billedGb: 2 });
      assert.deepEqual({ count: Number(billed.count), amount: Number(billed.amount) }, { count: 2, amount: 2 });
      assert.equal(Number(billingUser.balanceCents), 98);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

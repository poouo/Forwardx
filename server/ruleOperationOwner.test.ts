import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("administrator rule operations use the selected owner without bypassing user limits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-owner-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const insert = async (table, columns, values) => {
      const quote = (name) => '"' + name + '"';
      await runtime.executeRaw("INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")", values);
    };
    const caller = (id, role) => rulesRouter.createCaller({
      req: { headers: {} }, res: { clearCookie() {} },
      user: { id, username: "test-" + id, role, accountEnabled: true },
      authSession: null, authFailureReason: null,
    });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('UPDATE "system_settings" SET "value" = ? WHERE "key" = ?', ["true", "trafficBillingEnabled"]);
      for (const id of [1, 2, 3]) {
        await insert("users", ["id", "username", "password", "role", "canAddRules", "balanceCents", "accountEnabled"], [id, "test-" + id, "x", id === 1 ? "admin" : "user", 1, 1000, id === 3 ? 0 : 1]);
      }
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [2, "entry", "198.51.100.10", "198.51.100.10", 2, 1, Math.floor(Date.now() / 1000), 10000, 20000]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [70, "host", 2, 1, 0, 1, 100]);
      await insert("subscription_plans", ["id", "name"], [50, "limited-ports"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 2]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "portRangeStart", "portRangeEnd"], [60, 2, 50, "active", 17000, 18000]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [10, "customer-group", "host", "port", "", "0.0.0.0", 2, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 2, 0, 1]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
      const admin = caller(1, "admin");
      const customer = caller(2, "user");
      const base = { hostId: 2, name: "test-rule", forwardType: "iptables", protocol: "tcp", sourcePort: 16000, targetIp: "203.0.113.20", targetPort: 8080 };
      const self = await admin.create(base);
      const explicitSelf = await admin.create({ ...base, userId: 1, sourcePort: 16001 });
      const selected = await admin.create({ ...base, userId: 2, sourcePort: 17500 });
      const grouped = await admin.create({ ...base, hostId: undefined, forwardGroupId: 10, userId: 2, sourcePort: 0 });
      assert.ok(grouped.sourcePort >= 17000 && grouped.sourcePort <= 18000);
      const owners = await runtime.queryRaw('SELECT "id", "userId" FROM "forward_rules" WHERE "id" IN (?, ?, ?, ?) ORDER BY "id"', [self.id, explicitSelf.id, selected.id, grouped.id]);
      assert.deepEqual(owners.map((row) => Number(row.userId)), [1, 1, 2, 2]);
      await assert.rejects(() => admin.create({ ...base, userId: 2, sourcePort: 16002 }), /源端口必须在允许范围/);
      await assert.rejects(() => customer.create({ ...base, userId: 1, sourcePort: 17501 }), /无权操作其他用户/);
      await assert.rejects(() => admin.create({ ...base, userId: 3, sourcePort: 17501 }), /已被禁用/);
      await assert.rejects(() => admin.create({ ...base, userId: 999, sourcePort: 17501 }), /不存在/);
      assert.deepEqual(await admin.effectivePortPolicy({ hostId: 2, userId: 2 }), { rangeText: "17000-18000" });
      assert.equal((await admin.checkPort({ hostId: 2, userId: 2, sourcePort: 16002 })).used, true);
      const random = await admin.randomPort({ hostId: 2, userId: 2, protocol: "tcp" });
      assert.ok(random.port >= 17000 && random.port <= 18000);
      await assert.rejects(() => customer.randomPort({ hostId: 2, userId: 1 }), /无权操作其他用户/);
      const selectedReset = await admin.resetTraffic({ scope: "all", userId: 2 });
      assert.ok(selectedReset.requestedRuleIds.includes(selected.id));
      assert.ok(selectedReset.requestedRuleIds.includes(grouped.id));
      assert.ok(!selectedReset.requestedRuleIds.includes(self.id));
      const selfReset = await admin.resetTraffic({ scope: "all", userId: 1 });
      assert.deepEqual(selfReset.requestedRuleIds, [self.id, explicitSelf.id]);
      const allReset = await admin.resetTraffic({ scope: "all" });
      assert.ok(allReset.requestedRuleIds.includes(self.id));
      assert.ok(allReset.requestedRuleIds.includes(selected.id));
      await assert.rejects(() => customer.resetTraffic({ scope: "all", userId: 1 }), /无权重置其他用户/);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "owner.db") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

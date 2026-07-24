import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward-group port checks cover every entry and exclude the edited template children", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-port-check-"));
  const databasePath = path.join(directory, "port-check.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, now, 17000, 18000]);
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp",
        "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback",
      ], [10, "saved-forward", "host", "port", "", "A", "0.0.0.0", 1, 1, null, 60, 120, 1]);
      await insert("forward_groups", [
        "id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp",
        "userId", "isEnabled", "activeMemberId", "failoverSeconds", "recoverSeconds", "autoFailback",
      ], [11, "private-forward", "host", "port", "", "A", "0.0.0.0", 1, 1, null, 60, 120, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate",
        "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
      ], [100, 1, "template", "iptables", "tcp", 10, 1, 17500, "203.0.113.10", 80, 1, 1, 0]);
      await insert("forward_rules", [
        "id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId",
        "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning",
      ], [101, 1, "child", "iptables", "tcp", 10, 100, 101, 0, 17500, "203.0.113.10", 80, 1, 1, 0]);

      const caller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 10, sourcePort: 17500, protocol: "tcp" }),
        { used: true },
      );
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 10, sourcePort: 17501, protocol: "tcp" }),
        { used: false },
      );
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 10, sourcePort: 17500, excludeRuleId: 100, protocol: "tcp" }),
        { used: false },
      );
      assert.deepEqual(
        await caller.checkPort({ forwardGroupId: 10, sourcePort: 16000, protocol: "tcp" }),
        { used: true, reason: "入口端口必须在允许范围内：17000-18000" },
      );

      await insert("subscription_plans", ["id", "name"], [50, "limited-ports"]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "portRangeStart", "portRangeEnd"], [60, 2, 50, "active", 17400, 17600]);
      const userCaller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 2, username: "viewer", role: "user", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      assert.deepEqual(
        await userCaller.checkPort({ forwardGroupId: 10, sourcePort: 17501, protocol: "tcp" }),
        { used: false },
      );
      assert.deepEqual(
        await userCaller.checkPort({ forwardGroupId: 10, sourcePort: 17700, protocol: "tcp" }),
        { used: true, reason: "套餐端口必须在 17400-17600 范围内" },
      );
      await assert.rejects(
        () => userCaller.checkPort({ forwardGroupId: 11, sourcePort: 17501, protocol: "tcp" }),
        /无权使用该转发组/,
      );
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

test("direct-host create, port lookup, enable, and update paths enforce subscription port ranges", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-port-enable-"));
  const databasePath = path.join(directory, "port-enable.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const callerContext = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('UPDATE "system_settings" SET "value" = ? WHERE "key" = ?', ["true", "trafficBillingEnabled"]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "balanceCents"], [1, "admin", "x", "admin", 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "balanceCents"], [2, "limited", "x", "user", 1, 1000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [1, "entry", "198.51.100.10", "198.51.100.10", 1, 1, Math.floor(Date.now() / 1000), 10000, 20000]);
      await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [2, "limited-entry", "198.51.100.11", "198.51.100.11", 2, 1, Math.floor(Date.now() / 1000), 10000, 20000]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [70, "host", 2, 1, 0, 1, 100]);
      await insert("forward_groups", ["id", "name", "groupType", "groupMode", "domain", "targetIp", "userId", "isEnabled"], [10, "limited-group", "host", "port", "", "0.0.0.0", 2, 1]);
      await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
      await insert("subscription_plans", ["id", "name"], [50, "limited-ports"]);
      await insert("subscription_plan_hosts", ["planId", "hostId"], [50, 2]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [50, 10]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "portRangeStart", "portRangeEnd"], [60, 2, 50, "active", 17000, 18000]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"], [102, 2, "toggle-rule", "iptables", "tcp", 16000, "203.0.113.10", 80, 2, 0, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"], [104, 2, "update-rule", "iptables", "tcp", 16001, "203.0.113.10", 80, 2, 0, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"], [103, 1, "group-template", "iptables", "tcp", 10, 1, 16000, "203.0.113.10", 80, 2, 0, 0]);

      const limitedUser = { id: 2, username: "limited", role: "user", accountEnabled: true };
      const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
      const limitedCaller = rulesRouter.createCaller(callerContext(limitedUser));
      const adminCaller = rulesRouter.createCaller(callerContext(admin));

      assert.deepEqual(
        await limitedCaller.checkPort({ hostId: 2, sourcePort: 16999, protocol: "tcp" }),
        { used: true, reason: "套餐端口必须在允许范围内：17000-18000" },
      );
      assert.deepEqual(
        await limitedCaller.checkPort({ hostId: 2, sourcePort: 17500, protocol: "tcp" }),
        { used: false },
      );
      const randomPort = await limitedCaller.randomPort({ hostId: 2, protocol: "tcp" });
      assert.ok(randomPort.port >= 17000 && randomPort.port <= 18000, "random port escaped plan range: " + randomPort.port);

      const directRule = {
        hostId: 2,
        name: "limited-direct-rule",
        forwardType: "iptables",
        protocol: "tcp",
        sourcePort: 16999,
        targetIp: "203.0.113.20",
        targetPort: 8080,
        isEnabled: true,
      };
      await assert.rejects(
        () => limitedCaller.create(directRule),
        /源端口必须在允许范围内：17000-18000/,
      );
      const created = await limitedCaller.create({ ...directRule, name: "limited-direct-rule-in-range", sourcePort: 17500 });
      assert.equal(created.sourcePort, 17500);
      assert.ok(Number(created.id) > 0);
      assert.deepEqual(
        await runtime.queryRaw('SELECT "hostId", "sourcePort", "userId" FROM "forward_rules" WHERE "id" = ?', [created.id]),
        [{ hostId: 2, sourcePort: 17500, userId: 2 }],
      );

      await assert.rejects(() => limitedCaller.toggle({ id: 102, isEnabled: true }), /套餐端口/);
      await adminCaller.toggle({ id: 102, isEnabled: true });
      assert.equal(Number((await runtime.queryRaw('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = ?', [102]))[0].isEnabled), 1);

      await assert.rejects(() => limitedCaller.update({ id: 104, isEnabled: true }), /套餐端口/);
      await adminCaller.update({ id: 104, isEnabled: true });
      assert.equal(Number((await runtime.queryRaw('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = ?', [104]))[0].isEnabled), 1);

      await assert.rejects(() => limitedCaller.toggle({ id: 103, isEnabled: true }), /套餐端口/);
      await adminCaller.toggle({ id: 103, isEnabled: true });
      assert.equal(Number((await runtime.queryRaw('SELECT "isEnabled" FROM "forward_rules" WHERE "id" = ?', [103]))[0].isEnabled), 1);
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

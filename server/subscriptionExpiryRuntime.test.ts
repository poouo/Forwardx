import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("expiring one of several subscriptions refreshes runtime without stopping the others", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-subscription-expiry-runtime-"));
  const databasePath = path.join(directory, "subscription-expiry.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const billing = await import(moduleUrl("server/repositories/billingRepository.ts"));
    const access = await import(moduleUrl("server/linkAccessView.ts"));
    const events = await import(moduleUrl("server/agentEvents.ts"));
    const quote = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    const snapshot = (name, hostId) => JSON.stringify({
      name,
      portCount: 1,
      trafficLimit: 1000,
      rateLimitMbps: 0,
      maxRules: 20,
      maxConnections: 2000,
      maxIPs: 10,
      hostIds: [hostId],
      tunnelIds: [],
      forwardGroupIds: [],
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [1, "owner", "x", "admin", 1, 1, 1]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled"], [2, "subscriber", "x", "user", 1, 0, 1]);
      for (const [id, name] of [[1, "expired-host"], [2, "active-host"]]) {
        await insert("hosts", ["id", "name", "ip", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"], [id, name, "198.51.100." + id, 1, 1, now, 10000, 20000]);
      }
      for (const [id, name, hostId] of [[1, "expired-plan", 1], [2, "active-plan", 2]]) {
        await insert("subscription_plans", ["id", "name", "durationDays", "portCount", "trafficLimit", "maxRules", "maxConnections", "maxIPs"], [id, name, 30, 1, 1000, 20, 2000, 10]);
        await insert("subscription_plan_hosts", ["planId", "hostId"], [id, hostId]);
      }
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "source", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt"], [11, 2, 1, "active", "admin", snapshot("expired-plan", 1), 10000, 10000, now - 86400, now - 1]);
      await insert("user_subscriptions", ["id", "userId", "planId", "status", "source", "planSnapshot", "portRangeStart", "portRangeEnd", "startedAt", "expiresAt"], [12, 2, 2, "active", "admin", snapshot("active-plan", 2), 10001, 10001, now - 86400, now + 86400]);
      const ruleColumns = ["id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
      await insert("forward_rules", ruleColumns, [101, 1, "expired-rule", "iptables", "tcp", 10000, "203.0.113.1", 80, 2, 1, 1]);
      await insert("forward_rules", ruleColumns, [102, 2, "active-rule", "iptables", "tcp", 10001, "203.0.113.2", 80, 2, 1, 1]);

      const writes = [];
      const eventResponse = { write: (value) => writes.push(value), end() {} };
      events.registerAgentEventClient(1, "expiry-test-token", eventResponse);
      await billing.expireUserSubscriptions();
      events.unregisterAgentEventClient(1, eventResponse);

      const [expired] = await runtime.queryRaw('SELECT "status" FROM "user_subscriptions" WHERE "id" = ?', [11]);
      const [active] = await runtime.queryRaw('SELECT "status" FROM "user_subscriptions" WHERE "id" = ?', [12]);
      assert.equal(expired.status, "expired");
      assert.equal(active.status, "active");
      assert.ok(writes.length > 0, "subscription expiry must invalidate the Agent heartbeat plan");

      const rules = await runtime.queryRaw('SELECT "id", "userId", "hostId", "tunnelId", "forwardGroupId", "isEnabled", "isRunning" FROM "forward_rules" ORDER BY "id"');
      assert.equal(Number(rules[0].isRunning), 1, "a remaining active subscription must not reset unrelated runtime state");
      assert.equal(Number(rules[1].isRunning), 1, "a remaining active subscription must stay running");
      access.clearLinkAccessScopeCache();
      const gated = await access.gateForwardRulesForRuntime(rules);
      assert.equal(gated[0].isEnabled, false, "the expired subscription resource must be removed from runtime");
      assert.equal(gated[0].resourceAccessDenied, true);
      assert.equal(Number(gated[1].isEnabled), 1, "the second subscription resource must remain usable");
      assert.equal(gated[1].resourceAccessDenied, undefined);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

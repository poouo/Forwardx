import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("group rule tests follow active host/tunnel members and persist their selected runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-selftest-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const db = await mod("server/db.ts");
    const { selfTestRulesRouter } = await mod("server/routers/rules.selfTest.ts");
    const utils = await mod("server/agentRouteUtils.ts");
    const { Router } = await import("express");
    const { registerAgentSelfTestRoutes } = await mod("server/agentSelfTestRoutes.ts");
    const insert = async (table, data) => {
      const keys = Object.keys(data);
      await runtime.executeRaw('INSERT INTO "' + table + '" (' + keys.map(k => '"' + k + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')', Object.values(data));
    };
    const now = Math.floor(Date.now() / 1000);
    const caller = selfTestRulesRouter.createCaller({ user: { id: 1, role: "user" }, req: { headers: {} }, res: {} });
    const state = async id => db.getForwardTestById(id);
    const start = async () => state((await caller.startSelfTest({ ruleId: 100 })).id);
    const agentRouter = Router();
    registerAgentSelfTestRoutes(agentRouter);
    const route = path => agentRouter.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
    const request = async (path, hostId, body = {}) => {
      let result;
      await route(path)({ agentToken: "token-" + hostId, body }, { json: value => result = value, status: code => { throw new Error("HTTP " + code); } });
      return result;
    };
    try {
      // Agents belong to an enabled administrator; the rule caller stays a regular user.
      await insert("users", { id: 1000, username: "agent-admin", password: "unused", role: "admin", accountEnabled: 1 });
      await insert("users", { id: 1, username: "rule-user", password: "unused", role: "user", accountEnabled: 1 });
      for (let id = 1; id <= 4; id++) await insert("hosts", { id, name: "host-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id, userId: 1000, isOnline: 1, agentToken: "token-" + id, lastHeartbeat: id === 1 ? now - 600 : now });
      await insert("forward_groups", { id: 10, name: "failover", groupMode: "failover", groupType: "host", userId: 1, domain: "entry.example.test", activeMemberId: 102, isEnabled: 1, targetIp: "203.0.113.10" });
      for (const [id, hostId, priority] of [[101, 1, 0], [102, 2, 1]]) await insert("forward_group_members", { id, groupId: 10, memberType: "host", hostId, priority, isEnabled: 1 });
      const rule = { userId: 1, name: "my-rule", sourcePort: 18000, targetIp: "203.0.113.10", targetPort: 443, forwardType: "gost", protocol: "tcp", isEnabled: 1, pendingDelete: 0, forwardGroupId: 10 };
      await insert("forward_rules", { ...rule, id: 100, hostId: 1, isForwardGroupTemplate: 1 });
      for (const [id, hostId, memberId] of [[110, 1, 101], [120, 2, 102]]) await insert("forward_rules", { ...rule, id, hostId, forwardGroupRuleId: 100, forwardGroupMemberId: memberId });

      const first = await start();
      assert.equal(first.ruleId, 100, "results belong to the user's logical rule");
      assert.equal(first.hostId, 2, "offline first member must not receive tests after failover");
      const meta = utils.parseSelfTestMeta(first.requestMessage);
      assert.equal(meta.kind, "forward-group");
      assert.equal(meta.runtimeRuleId, 120);
      assert.equal(meta.sourceLabel, "host-2");

      // Recovery must not override the still-active member when auto-failback is off.
      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ? WHERE "id" = 1', [now]);
      assert.equal((await start()).hostId, 2);
      await runtime.executeRaw('UPDATE "forward_groups" SET "activeMemberId" = 101 WHERE "id" = 10');
      const returned = await start();
      assert.equal(returned.hostId, 1, "follow the actual switch back");

      // Changes after enqueue cannot silently re-target a pending test.
      await runtime.executeRaw('UPDATE "forward_rules" SET "targetPort" = 8443 WHERE "id" = 100');
      const pulled = await request("/api/agent/selftest-pull", 2);
      const payload = pulled.selfTests.find(test => test.testId === first.id);
      assert.equal(payload.ruleId, 120);
      assert.equal(payload.targetPort, 443);
      assert.deepEqual(payload, utils.buildMetaAgentSelfTestPayload(first, meta), "heartbeat and dedicated pull share the same snapshot builder");
      await request("/api/agent/selftest-result", 2, { testId: first.id, targetReachable: true, latencyMs: 12 });
      assert.equal((await state(first.id)).status, "success");
      assert.equal((await db.getLatestForwardTest(100, { includeActive: false })).id, first.id);
      assert.equal(utils.parseSelfTestMeta((await state(first.id)).requestMessage).runtimeRuleId, 120);
      assert.equal((await runtime.queryRaw('SELECT "hostId" FROM "tcping_stats" WHERE "ruleId" = 100'))[0].hostId, 2);

      const unauthorized = selfTestRulesRouter.createCaller({ user: { id: 9, role: "user" }, req: { headers: {} }, res: {} });
      await assert.rejects(() => unauthorized.startSelfTest({ ruleId: 100 }), /无权操作/);
      await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat" = ? WHERE "id" = 1', [now - 600]);
      await assert.rejects(() => start(), /活动入口/, "do not probe a standby while the actual active route is still offline");
      await runtime.executeRaw('UPDATE "forward_groups" SET "activeMemberId" = 102 WHERE "id" = 10');
      await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = 1 WHERE "id" = 120');
      await assert.rejects(() => start(), /活动入口/, "never reuse a retired child listener");
      await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = 0 WHERE "id" = 120');
      await runtime.executeRaw('UPDATE "forward_groups" SET "isEnabled" = 0 WHERE "id" = 10');
      await assert.rejects(() => start(), /停用/);

      // A group without a domain has no singular DDNS route: use an available listener.
      await runtime.executeRaw('UPDATE "forward_groups" SET "isEnabled" = 1, "domain" = NULL, "activeMemberId" = NULL WHERE "id" = 10');
      assert.equal((await start()).hostId, 2);

      // Tunnel members must execute the existing tunnel+target test, not direct template testing.
      for (const [id, entryHostId, exitHostId] of [[20, 1, 3], [21, 2, 4]]) await insert("tunnels", { id, name: "tunnel-" + id, entryHostId, exitHostId, userId: 1, listenPort: 19000 + id, mode: "tls", isEnabled: 1 });
      await runtime.executeRaw('UPDATE "forward_groups" SET "groupType" = ?, "domain" = ?, "activeMemberId" = 102 WHERE "id" = 10', ["tunnel", "entry.example.test"]);
      for (const [memberId, tunnelId, childId] of [[101, 20, 110], [102, 21, 120]]) {
        await runtime.executeRaw('UPDATE "forward_group_members" SET "memberType" = ?, "hostId" = NULL, "tunnelId" = ? WHERE "id" = ?', ["tunnel", tunnelId, memberId]);
        await runtime.executeRaw('UPDATE "forward_rules" SET "tunnelId" = ? WHERE "id" = ?', [tunnelId, childId]);
      }
      const viaTunnel = await start();
      assert.equal(viaTunnel.hostId, 4, "use the active tunnel's exit to test its target");
      const tunnelMeta = utils.parseSelfTestMeta(viaTunnel.requestMessage);
      assert.equal(tunnelMeta.kind, "forward-via-tunnel");
      assert.equal(tunnelMeta.tunnelId, 21);
      assert.equal(tunnelMeta.entryHostId, 2);
      assert.equal(tunnelMeta.targetPort, 443, "use runtime child parameters, not stale template fields");
      assert.equal(utils.buildMetaAgentSelfTestPayload(viaTunnel, tunnelMeta).tunnelId, 21);

      // Testing must not rewrite the template's metadata or trigger a failover.
      assert.equal((await db.getForwardRuleById(100)).hostId, 1);
      assert.equal((await db.getForwardGroupById(10)).activeMemberId, 102);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

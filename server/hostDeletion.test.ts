import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("member removal synchronizes templates, preserves healthy siblings and safely deletes only unused hosts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-delete-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const mod = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await mod("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await (await mod("server/dbSchema.ts")).ensureDatabaseSchema();
    const groups = await mod("server/repositories/forwardGroupRepository.ts");
    const rules = await mod("server/repositories/forwardRuleRepository.ts");
    const deletion = await mod("server/hostDeletion.ts");
    const insert = async (table, data) => {
      const keys = Object.keys(data);
      await runtime.executeRaw('INSERT INTO "' + table + '" (' + keys.map(k => '"' + k + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')', Object.values(data));
    };
    const now = Math.floor(Date.now() / 1000);
    for (let id = 1; id <= 17; id++) await insert("hosts", {
      id, name: "host-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id,
      userId: 1, isOnline: 1, lastHeartbeat: now,
    });
    const member = (hostId, priority = 0) => ({ memberType: "host", hostId, priority, isEnabled: true });
    const group = async (id, members, groupMode = "failover", extra = {}) => {
      await insert("forward_groups", { id, name: "group-" + id, userId: 1, groupMode, groupType: "host", forwardType: "gost", protocol: "tcp", targetIp: "203.0.113.50", targetPort: 443, isEnabled: 1, ...extra });
      await groups.replaceForwardGroupMembers(id, members);
    };
    const template = async (id, groupId, hostId, port) => {
      await insert("forward_rules", { id, hostId, name: "template-" + id, userId: 1, forwardType: "gost", protocol: "tcp", sourcePort: port, targetIp: "203.0.113.50", targetPort: 443, forwardGroupId: groupId, isForwardGroupTemplate: 1, isEnabled: 1, isRunning: 1 });
      await groups.syncForwardGroupRules(groupId);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "forwardGroupRuleId" = ?', [id]);
    };
    try {
      await group(10, [member(1), member(2, 1)]);
      await template(100, 10, 1, 18000);
      const before = await runtime.queryRaw('SELECT "id", "hostId" FROM "forward_rules" WHERE "forwardGroupRuleId" = 100');
      const removed = before.find(r => r.hostId === 1);
      const kept = before.find(r => r.hostId === 2);
      await groups.replaceForwardGroupMembers(10, [member(2)]);
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 100'), [{ hostId: 2 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isRunning", "pendingDelete" FROM "forward_rules" WHERE "id" = ?', [kept.id]), [{ isRunning: 1, pendingDelete: 0 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isEnabled", "pendingDelete" FROM "forward_rules" WHERE "id" = ?', [removed.id]), [{ isEnabled: 0, pendingDelete: 1 }]);
      let impact = await deletion.prepareHostDeletion(1);
      assert.equal(impact.blocked, false);
      assert.equal(impact.pendingCleanupCount, 1);
      await assert.rejects(() => deletion.deleteHostWithImpact(1, true), /清理/);
      await rules.updateRuleRunningStatus(removed.id, false);
      await deletion.deleteHostWithImpact(1);
      assert.deepEqual(await runtime.queryRaw('SELECT "id" FROM "hosts" WHERE "id" = 1'), []);
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 100'), [{ hostId: 2 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = ?', [kept.id]), [{ isRunning: 1 }]);

      // Existing deployments with stale template host IDs self-heal during preview.
      await group(11, [member(6)]);
      await template(200, 11, 6, 18001);
      await runtime.executeRaw('UPDATE "forward_rules" SET "hostId" = 5 WHERE "id" = 200');
      impact = await deletion.prepareHostDeletion(5);
      assert.equal(impact.blocked, false);
      await deletion.deleteHostWithImpact(5);
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 200'), [{ hostId: 6 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "forwardGroupRuleId" = 200'), [{ isRunning: 1 }]);

      // Removing the first chain node changes the next listener, not the unchanged tail.
      await group(16, [member(13), member(14, 1), member(15, 2)], "chain");
      await template(500, 16, 13, 18100);
      const chainBefore = await runtime.queryRaw('SELECT "id", "hostId" FROM "forward_rules" WHERE "forwardGroupRuleId" = 500');
      const tail = chainBefore.find(r => r.hostId === 15);
      const service = await mod("server/services/forwardGroupService.ts");
      const chain = await groups.getForwardGroupById(16);
      await service.updateForwardGroupFromInput(16, { ...chain, members: [member(14), member(15, 1)] });
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 500'), [{ hostId: 14 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = ?', [tail.id]), [{ isRunning: 1 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "sourcePort", "isRunning" FROM "forward_rules" WHERE "forwardGroupRuleId" = 500 AND "hostId" = 14'), [{ sourcePort: 18100, isRunning: 0 }]);

      // Entry-group replacement propagates template ownership into dependent chains.
      await group(17, [member(16)], "entry");
      await group(18, [member(17)], "chain", { entryGroupId: 17 });
      await template(600, 18, 16, 18101);
      const downstream = (await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "forwardGroupRuleId" = 600 AND "hostId" = 17'))[0];
      await groups.replaceForwardGroupMembers(17, [member(13)]);
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 600'), [{ hostId: 13 }]);
      assert.deepEqual(await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = ?', [downstream.id]), [{ isRunning: 1 }]);

      // Disabled direct rules and group membership without rules are real dependencies.
      await insert("forward_rules", { id: 300, hostId: 3, name: "disabled-rule", userId: 1, forwardType: "gost", protocol: "tcp", sourcePort: 18002, targetIp: "203.0.113.50", targetPort: 443, isEnabled: 0 });
      impact = await deletion.getHostDeletionImpact(3);
      assert.equal(impact.rules.items[0].name, "disabled-rule");
      await assert.rejects(() => deletion.deleteHostWithImpact(3, true), /disabled-rule/);
      const { hostsRouter } = await mod("server/routers/hosts.ts");
      const caller = hostsRouter.createCaller({ user: { id: 99, role: "user" }, req: { headers: {} }, res: {} });
      for (const action of ["prepareDelete", "deleteImpact", "delete"]) {
        await assert.rejects(() => caller[action]({ id: 3 }), /无权操作/);
      }
      assert.deepEqual(await runtime.queryRaw('SELECT "id" FROM "hosts" WHERE "id" = 3'), [{ id: 3 }]);
      await group(12, [member(4)], "entry");
      assert.equal((await deletion.getHostDeletionImpact(4)).groups.count, 1);
      await assert.rejects(() => deletion.deleteHostWithImpact(4, true), /group-12/);

      // Primary, relay and extra exit references all block, even when disabled.
      await insert("tunnels", { id: 20, name: "disabled-tunnel", userId: 1, entryHostId: 7, exitHostId: 8, listenPort: 19000, isEnabled: 0 });
      await insert("tunnel_hops", { tunnelId: 20, hostId: 10, seq: 1 });
      await insert("tunnel_exit_nodes", { tunnelId: 20, hostId: 11, seq: 1, listenPort: 19000 });
      for (const hostId of [7, 8, 10, 11]) {
        impact = await deletion.getHostDeletionImpact(hostId);
        assert.equal(impact.tunnels.items[0].name, "disabled-tunnel");
        await assert.rejects(() => deletion.deleteHostWithImpact(hostId, true), /disabled-tunnel/);
      }
      await insert("forward_rule_tunnel_exits", { ruleId: 300, tunnelId: 20, exitNodeId: 1, exitSeq: 1, exitHostId: 12, tunnelExitPort: 19001 });
      assert.equal((await deletion.getHostDeletionImpact(12)).rules.count, 1);

      // Offline cleanup needs explicit consent and never bypasses live references.
      await insert("forward_rules", { id: 400, hostId: 9, name: "retired", userId: 1, forwardType: "gost", protocol: "tcp", sourcePort: 18003, targetIp: "203.0.113.50", targetPort: 443, isEnabled: 0, isRunning: 1, pendingDelete: 1 });
      await runtime.executeRaw('UPDATE "hosts" SET "isOnline" = 0 WHERE "id" = 9');
      await assert.rejects(() => deletion.deleteHostWithImpact(9), /离线/);
      await deletion.deleteHostWithImpact(9, true);
      assert.deepEqual(await runtime.queryRaw('SELECT "id" FROM "hosts" WHERE "id" = 9'), []);
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

test("deletion preview and mutation enforce host ownership and UI cannot force-delete actual dependencies", () => {
  const source = fs.readFileSync("server/routers/hosts.ts", "utf8");
  for (const name of ["prepareDelete", "deleteImpact", "delete"]) {
    const start = source.indexOf(`    ${name}: protectedProcedure`);
    assert.ok(start >= 0);
    const block = source.slice(start, source.indexOf("      }),", start));
    assert.match(block, /ctx.user.role !== "admin" && host.userId !== ctx.user.id/);
  }
  const ui = fs.readFileSync("client/src/components/hosts/HostDeleteDialog.tsx", "utf8");
  assert.match(ui, /data.blocked \|\| waiting \|\| \(offlineCleanup && !confirmOfflineCleanup\)/);
  assert.match(ui, /prepareDelete\(\{ id: hostId \}\)/);
  assert.match(ui, /refetchIntervalInBackground: false/);
});

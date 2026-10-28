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
      assert.equal((await deletion.getHostDeletionImpact(13)).groups.items.find(item => item.id === 16)?.groupMode, "chain");
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
        await assert.rejects(() => caller[action]({ id: 3 }), { code: "FORBIDDEN" });
      }
      assert.deepEqual(await runtime.queryRaw('SELECT "id" FROM "hosts" WHERE "id" = 3'), [{ id: 3 }]);
      await group(12, [member(4)], "entry");
      assert.equal((await deletion.getHostDeletionImpact(4)).groups.count, 1);
      assert.equal((await deletion.getHostDeletionImpact(4)).groups.items[0].groupMode, "entry");
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

test("disabled topology changes and historical tombstones release only obsolete host bindings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-delete-regression-"));
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
    const hosts = await mod("server/repositories/hostRepository.ts");
    const deletion = await mod("server/hostDeletion.ts");
    const insert = async (table, data) => {
      const keys = Object.keys(data);
      await runtime.executeRaw('INSERT INTO "' + table + '" (' + keys.map(k => '"' + k + '"').join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')', Object.values(data));
    };
    const member = (hostId, priority = 0) => ({ memberType: "host", hostId, priority, isEnabled: true });
    const group = async (id, members, groupMode = "failover", extra = {}) => {
      await insert("forward_groups", { id, name: "group-" + id, userId: 1, groupMode, groupType: "host", forwardType: "gost", protocol: "tcp", targetIp: "203.0.113.50", targetPort: 443, isEnabled: 1, ...extra });
      await groups.replaceForwardGroupMembers(id, members);
    };
    const template = async (id, groupId, hostId, port) => {
      await insert("forward_rules", { id, hostId, name: "template-" + id, userId: 1, forwardType: "gost", protocol: "tcp", sourcePort: port, targetIp: "203.0.113.50", targetPort: 443, forwardGroupId: groupId, isForwardGroupTemplate: 1, isEnabled: 1 });
      await groups.syncForwardGroupRules(groupId);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "forwardGroupRuleId" = ?', [id]);
    };
    const child = async (templateId, hostId) => (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupRuleId" = ? AND "hostId" = ? AND "pendingDelete" = 0', [templateId, hostId]))[0];
    const state = async (id) => (await runtime.queryRaw('SELECT "isRunning", "pendingDelete" FROM "forward_rules" WHERE "id" = ?', [id]))[0];
    const now = Math.floor(Date.now() / 1000);
    try {
      for (let id = 1; id <= 40; id++) await insert("hosts", { id, name: "host-" + id, ip: "198.51.100." + id, ipv4: "198.51.100." + id, userId: 1, isOnline: 1, lastHeartbeat: now });

      // A truly deleted group cannot block deletion through orphan members.
      await insert("forward_group_members", { groupId: 99999, memberType: "host", hostId: 39 });
      assert.equal((await deletion.getHostDeletionImpact(39)).groups.count, 0);
      assert.equal((await deletion.prepareHostDeletion(39)).blocked, false);

      // Historical modes must be visible wherever runtime/impact normalize
      // them to failover; an exact SQL enum filter used to hide these rows.
      for (const [index, legacyMode] of ["", "legacy"].entries()) {
        const id = 120 + index;
        await group(id, [member(30 + index)], legacyMode);
        const impact = await deletion.getHostDeletionImpact(30 + index);
        assert.equal(impact.groups.items[0].groupMode, "failover");
        const page = await groups.getForwardGroupsPage({ page: 1, pageSize: 12, groupMode: "failover", search: "group-" + id });
        assert.equal(page.totalItems, 1);
        assert.equal(page.items[0].id, id);
        assert.equal(page.items[0].groupMode, "failover");
        assert.equal((await groups.getForwardGroupsPage({ page: 1, pageSize: 12, groupMode: "chain", search: "group-" + id })).totalItems, 0);
      }

      // All three early-return paths must clean old external-entry children.
      for (const [index, disabled] of ["chain", "template", "entry"].entries()) {
        const oldHost = index * 4 + 1, downstreamHost = oldHost + 1, newHost = oldHost + 2, retainedHost = oldHost + 3;
        const entryGroup = 100 + index * 2, chainGroup = entryGroup + 1, templateId = 1000 + index * 100;
        await group(entryGroup, [member(oldHost), member(retainedHost, 1)], "entry");
        await group(chainGroup, [member(downstreamHost)], "chain", { entryGroupId: entryGroup });
        await template(templateId, chainGroup, oldHost, 18000 + index);
        const obsolete = await child(templateId, oldHost);
        const downstream = await child(templateId, downstreamHost);
        const retained = await child(templateId, retainedHost);
        if (disabled === "template") {
          await rules.updateForwardRule(templateId, { isEnabled: false });
        } else {
          await groups.setForwardGroupEnabled(disabled === "entry" ? entryGroup : chainGroup, false);
        }
        await groups.replaceForwardGroupMembers(entryGroup, [member(newHost), member(retainedHost, 1)]);
        assert.deepEqual(await state(obsolete.id), { isRunning: 1, pendingDelete: 1 }, disabled);
        assert.equal((await state(downstream.id)).pendingDelete, 0, "retain downstream topology: " + disabled);
        assert.equal((await state(retained.id)).pendingDelete, 0, "retain current disabled entry: " + disabled);
        assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = ?', [templateId]), [{ hostId: newHost }]);

        // Emulate a pre-fix stale row: its member still belongs to the chain.
        await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = 0, "isRunning" = 0 WHERE "id" = ?', [obsolete.id]);
        let impact = await deletion.prepareHostDeletion(oldHost);
        assert.equal(impact.blocked, false, "historical topology repair: " + disabled);
        assert.equal(impact.pendingCleanupCount, 1);
        await assert.rejects(() => deletion.deleteHostWithImpact(oldHost), /清理/);
        await rules.markForwardRulesNotRunning([obsolete.id]);
        await rules.markForwardRulePendingDelete(obsolete.id);
        await groups.syncForwardGroupRules(chainGroup);
        assert.deepEqual(await state(obsolete.id), { isRunning: 0, pendingDelete: 1 }, "do not re-arm acknowledged removal");
        await rules.updateRuleRunningStatus(obsolete.id, false);
        await deletion.deleteHostWithImpact(oldHost);
        assert.equal((await state(retained.id)).pendingDelete, 0);
      }

      // An existing member ID is not sufficient when its host changed.
      await group(110, [member(13)]);
      await template(1400, 110, 13, 18010);
      const oldDirect = await child(1400, 13);
      await runtime.executeRaw('UPDATE "forward_group_members" SET "hostId" = 14 WHERE "groupId" = 110');
      assert.equal((await deletion.prepareHostDeletion(13)).blocked, false);
      await groups.syncForwardGroupRules(110);
      assert.deepEqual(await state(oldDirect.id), { isRunning: 1, pendingDelete: 1 });
      assert.ok(await child(1400, 14));
      await rules.updateRuleRunningStatus(oldDirect.id, false);
      await deletion.deleteHostWithImpact(13);

      // Tunnel members can change entry host without changing member/tunnel IDs.
      await insert("tunnels", { id: 200, name: "moving tunnel", entryHostId: 15, exitHostId: 17, mode: "tls", listenPort: 19000, userId: 1, isEnabled: 1 });
      await group(111, [{ memberType: "tunnel", tunnelId: 200, priority: 0, isEnabled: true }], "failover", { groupType: "tunnel" });
      await template(1500, 111, 15, 18011);
      const oldTunnel = await child(1500, 15);
      await runtime.executeRaw('UPDATE "tunnels" SET "entryHostId" = 16 WHERE "id" = 200');
      await groups.syncForwardGroupRules(111);
      assert.deepEqual(await state(oldTunnel.id), { isRunning: 1, pendingDelete: 1 }, "old entry must not be repurposed");
      const newTunnel = await child(1500, 16);
      assert.ok(newTunnel && newTunnel.id !== oldTunnel.id);
      await rules.updateRuleRunningStatus(newTunnel.id, true);
      assert.equal((await deletion.prepareHostDeletion(15)).blocked, false);
      assert.deepEqual(await state(newTunnel.id), { isRunning: 1, pendingDelete: 0 });
      await rules.updateRuleRunningStatus(oldTunnel.id, false);
      await deletion.deleteHostWithImpact(15);
      await assert.rejects(() => deletion.deleteHostWithImpact(16, true), /moving tunnel/);
      await assert.rejects(() => deletion.deleteHostWithImpact(17, true), /moving tunnel/);

      // Group deletion: templates cannot receive Agent acknowledgements.
      await group(112, [member(18), member(19, 1)]);
      await template(1600, 112, 18, 18012);
      const deletedChildren = await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "forwardGroupRuleId" = 1600');
      await groups.deleteForwardGroup(112);
      assert.deepEqual(await state(1600), { isRunning: 0, pendingDelete: 1 });
      assert.equal((await deletion.prepareHostDeletion(18)).pendingCleanupCount, 1);
      for (const row of deletedChildren) await rules.updateRuleRunningStatus(row.id, false);
      // Historical releases marked a template running forever; repair it.
      await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "id" = 1600');
      assert.equal((await deletion.getHostDeletionImpact(18)).pendingCleanupCount, 0);
      assert.equal((await deletion.prepareHostDeletion(18)).pendingCleanupCount, 0);
      assert.deepEqual(await state(1600), { isRunning: 0, pendingDelete: 1 });
      assert.equal((await hosts.getHostRuleDeleteBlockers(18)).pendingCleanupCount, 0);
      await deletion.deleteHostWithImpact(18);

      // Empty historical groups retain the user's logical template on deletion.
      await group(113, [member(20)]);
      await template(1700, 113, 20, 18013);
      const emptyChild = await child(1700, 20);
      await runtime.executeRaw('DELETE FROM "forward_group_members" WHERE "groupId" = 113');
      assert.equal((await deletion.prepareHostDeletion(20)).blocked, false);
      await rules.updateRuleRunningStatus(emptyChild.id, false);
      await deletion.deleteHostWithImpact(20);
      assert.deepEqual(await state(1700), { isRunning: 0, pendingDelete: 0 });
      await groups.replaceForwardGroupMembers(113, [member(21)]);
      assert.ok(await child(1700, 21));
      assert.deepEqual(await runtime.queryRaw('SELECT "hostId" FROM "forward_rules" WHERE "id" = 1700'), [{ hostId: 21 }]);

      // Collection groups must not leave phantom template cleanup either.
      await group(114, [member(22)]);
      await template(1800, 114, 22, 18014);
      const collectionChild = await child(1800, 22);
      await runtime.executeRaw('UPDATE "forward_groups" SET "groupMode" = ? WHERE "id" = 114', ["entry"]);
      await groups.syncForwardGroupRules(114);
      assert.deepEqual(await state(1800), { isRunning: 0, pendingDelete: 1 });
      assert.equal((await deletion.prepareHostDeletion(22)).blocked, true, "actual membership still blocks");
      await rules.updateRuleRunningStatus(collectionChild.id, false);
      await groups.deleteForwardGroup(114);
      await deletion.deleteHostWithImpact(22);

      // Startup/periodic purge also heals old template tombstones, never a real listener.
      await insert("forward_rules", { id: 1900, hostId: 23, userId: 1, name: "old-template", sourcePort: 18015, targetIp: "203.0.113.50", targetPort: 443, isForwardGroupTemplate: 1, pendingDelete: 1, isRunning: 1 });
      await insert("forward_rules", { id: 1901, hostId: 23, userId: 1, name: "real-cleanup", sourcePort: 18016, targetIp: "203.0.113.50", targetPort: 443, pendingDelete: 1, isRunning: 1 });
      await rules.purgeSettledPendingForwardRuleDeletes();
      assert.equal(await state(1900), undefined);
      assert.deepEqual(await state(1901), { isRunning: 1, pendingDelete: 1 });
      await assert.rejects(() => deletion.deleteHostWithImpact(23, true), /清理/);
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

test("deletion preview and mutation require administrators and UI cannot force-delete actual dependencies", () => {
  const source = fs.readFileSync("server/routers/hosts.ts", "utf8");
  for (const name of ["prepareDelete", "deleteImpact", "delete"]) {
    const start = source.indexOf(`    ${name}: adminProcedure`);
    assert.ok(start >= 0);
    const block = source.slice(start, source.indexOf("      }),", start));
    assert.match(block, /ctx.user.role !== "admin" && host.userId !== ctx.user.id/);
  }
  const ui = fs.readFileSync("client/src/components/hosts/HostDeleteDialog.tsx", "utf8");
  assert.match(ui, /data.blocked \|\| waiting \|\| \(offlineCleanup && !confirmOfflineCleanup\)/);
  assert.match(ui, /prepareDelete\(\{ id: hostId \}\)/);
  assert.match(ui, /refetchIntervalInBackground: false/);
  assert.match(ui, /utils\.hosts\.deleteImpact\.setData\(\{ id: data.hostId \}, data\)/);
  assert.match(ui, /utils\.hosts\.deleteImpact\.invalidate\(\{ id: data.hostId \}\)/);
  assert.doesNotMatch(ui, /href: "\/forward-groups"/);
});

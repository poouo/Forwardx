import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("revoked resource grants stop owned rules without hiding or deleting them", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-rule-resource-auth-"));
  const databasePath = path.join(directory, "resource-auth.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const trafficBilling = await import(moduleUrl("server/repositories/trafficBillingRepository.ts"));
    const ruleRepository = await import(moduleUrl("server/repositories/forwardRuleRepository.ts"));
    const linkAccess = await import(moduleUrl("server/linkAccessView.ts"));
    const { usersRouter } = await import(moduleUrl("server/routers/users.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const { trafficBillingRouter } = await import(moduleUrl("server/routers/trafficBilling.ts"));
    const { reconcileTrafficBillingAuthorization } = await import(moduleUrl("server/trafficBillingAuthorization.ts"));
    const { RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON } = await import(moduleUrl("server/ruleResourceAuthorization.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };
    const context = (user) => ({
      req: { headers: {} },
      res: { clearCookie() {} },
      user,
      authSession: null,
      authFailureReason: null,
    });
    const state = async (id) => {
      const [row] = await runtime.queryRaw(
        'SELECT "name", "hostId", "tunnelId", "forwardGroupId", "isEnabled", "isRunning", "pendingDelete", "protocolBlockReason" FROM "forward_rules" WHERE "id" = ?',
        [id],
      );
      return row;
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await trafficBilling.setTrafficBillingEnabled(true);
      const now = Math.floor(Date.now() / 1000);

      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "balanceCents"], [1, "admin", "x", "admin", 1, 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "balanceCents"], [2, "member", "x", "user", 1, 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "balanceCents"], [3, "other", "x", "user", 1, 1, 1, 1000]);
      await insert("users", ["id", "username", "password", "role", "canAddRules", "manualCanAddRules", "accountEnabled", "balanceCents"], [4, "billing-only", "x", "user", 1, 0, 1, 1000]);

      for (const [id, name, ownerId] of [
        [1, "manual-entry", 1],
        [2, "replacement-entry", 1],
        [3, "public-billing-entry", 1],
        [4, "private-billing-entry", 1],
        [5, "owned-entry", 2],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "portRangeStart", "portRangeEnd"],
          [id, name, "198.51.100." + id, "198.51.100." + id, ownerId, 1, now, 10000, 30000],
        );
      }
      await insert(
        "tunnels",
        ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "manual-tunnel", 1, 2, "tls", 24010, 1, 1],
      );
      for (const [id, name, hostId] of [
        [20, "manual-port-forward", 1],
        [21, "replacement-port-forward", 2],
        [22, "public-billing-port-forward", 3],
        [23, "private-billing-port-forward", 4],
        [24, "private-billing-with-manual-grant", 1],
        [25, "member-private-billing-port-forward", 4],
      ]) {
        await insert(
          "forward_groups",
          ["id", "name", "groupType", "groupMode", "domain", "recordType", "targetIp", "userId", "isEnabled"],
          [id, name, "host", "port", "", "A", "0.0.0.0", 1, 1],
        );
        await insert(
          "forward_group_members",
          ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
          [200 + id, id, "host", hostId, 0, 1],
        );
      }

      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 4]);
      await insert("user_tunnel_permissions", ["userId", "tunnelId"], [2, 10]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 20]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 24]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 25]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [30, "host", 3, 1, 0, 1, 100]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [31, "host", 4, 1, 1, 1, 100]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [32, "forward_group", 22, 1, 0, 1, 100]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [33, "forward_group", 23, 1, 1, 1, 100]);
      await insert("traffic_billing_configs", ["id", "resourceType", "resourceId", "enabled", "requiresPermission", "pricePerGbCents", "multiplier"], [34, "forward_group", 24, 1, 1, 1, 100]);
      await insert("user_traffic_billing_permissions", ["userId", "resourceType", "resourceId"], [2, "host", 4]);
      await insert("user_traffic_billing_permissions", ["userId", "resourceType", "resourceId"], [2, "forward_group", 23]);

      const directColumns = ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
      await insert("forward_rules", directColumns, [100, 1, "manual-host-rule", "iptables", "tcp", null, 11100, "203.0.113.10", 80, 2, 1, 1]);
      await insert("forward_rules", directColumns, [101, 1, "manual-tunnel-rule", "gost", "tcp", 10, 11200, "203.0.113.11", 80, 2, 1, 1]);
      await insert("forward_rules", directColumns, [104, 3, "public-billing-rule", "iptables", "tcp", null, 11400, "203.0.113.14", 80, 2, 1, 1]);
      await insert("forward_rules", directColumns, [105, 4, "private-billing-rule", "iptables", "tcp", null, 11500, "203.0.113.15", 80, 2, 1, 1]);
      await insert("forward_rules", directColumns, [106, 5, "owned-host-rule", "iptables", "tcp", null, 11600, "203.0.113.16", 80, 2, 1, 1]);
      await insert("forward_rules", directColumns, [107, 1, "other-user-rule", "iptables", "tcp", null, 11700, "203.0.113.17", 80, 3, 1, 1]);
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [102, 1, "manual-group-rule", "iptables", "tcp", 20, 1, 11300, "203.0.113.12", 80, 2, 1, 0],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [103, 1, "managed-child", "iptables", "tcp", 20, 102, 220, 0, 11300, "203.0.113.12", 80, 2, 1, 1],
      );
      const syncRuleIds = (await ruleRepository.getForwardRulesForUserSync(2)).map((rule) => Number(rule.id));
      assert.ok(syncRuleIds.includes(103), "user runtime refresh must include managed group children");
      assert.equal(syncRuleIds.includes(102), false, "user runtime refresh must not treat the visible template as a listener");
      for (const [id, hostId, name, groupId, sourcePort] of [
        [108, 3, "public-billing-group-rule", 22, 11800],
        [109, 4, "private-billing-group-rule", 23, 11900],
        [110, 1, "private-billing-manual-only-rule", 24, 12000],
        [111, 4, "member-private-billing-group-rule", 25, 12100],
      ]) {
        await insert(
          "forward_rules",
          ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
          [id, hostId, name, "iptables", "tcp", groupId, 1, sourcePort, "203.0.113.20", 80, 2, 1, 0],
        );
      }

      const admin = { id: 1, username: "admin", role: "admin", accountEnabled: true };
      const member = { id: 2, username: "member", role: "user", accountEnabled: true, allowedForwardTypes: null };
      const adminUsers = usersRouter.createCaller(context(admin));
      const adminTrafficBilling = trafficBillingRouter.createCaller(context(admin));
      const memberRules = rulesRouter.createCaller(context(member));

      await adminUsers.setHostPermissions({ userId: 2, hostIds: [4] });
      assert.equal(Number((await state(100)).isEnabled), 0);
      assert.equal((await state(100)).protocolBlockReason, RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON);
      assert.equal(Number((await state(101)).isEnabled), 1, "tunnel grant must not depend on a separate host grant");
      assert.equal(Number((await state(102)).isEnabled), 1, "group grant must cover its own topology");
      assert.equal(Number((await state(104)).isEnabled), 1, "public billing resource must remain usable without an extra grant");
      assert.equal(Number((await state(105)).isEnabled), 1, "explicit private billing grant must remain usable");
      assert.equal(Number((await state(106)).isEnabled), 1, "user-owned resource must remain usable");
      assert.equal(Number((await state(108)).isEnabled), 1, "public billing groups must not require an extra grant");
      assert.equal(Number((await state(109)).isEnabled), 1, "explicit private billing group grants must remain usable");
      assert.equal(Number((await state(110)).isEnabled), 0, "a normal group grant must not bypass required billing authorization");
      assert.equal(Number((await state(111)).isEnabled), 1, "a group member billing grant must keep the group usable");

      await adminUsers.setTunnelPermissions({ userId: 2, tunnelIds: [] });
      assert.equal(Number((await state(101)).isEnabled), 0);
      assert.equal((await state(101)).protocolBlockReason, RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON);

      await adminUsers.setForwardGroupPermissions({ userId: 2, forwardGroupIds: [24, 25] });
      assert.equal(Number((await state(102)).isEnabled), 0);
      assert.equal((await state(102)).protocolBlockReason, RULE_RESOURCE_AUTHORIZATION_REVOKED_REASON);
      assert.equal(Number((await state(103)).isEnabled), 0, "managed child must stop with its revoked template");

      await adminUsers.setTrafficBillingPermissions({ userId: 2, hostIds: [], tunnelIds: [], forwardGroupIds: [] });
      assert.equal(Number((await state(104)).isEnabled), 1, "public billing resource must ignore explicit billing grants");
      assert.equal(Number((await state(105)).isEnabled), 0, "private billing resource must stop after its grant is removed");
      assert.equal(Number((await state(108)).isEnabled), 1, "public billing group must ignore explicit billing grants");
      assert.equal(Number((await state(109)).isEnabled), 0, "private billing group must stop after its grant is removed");
      assert.equal(Number((await state(111)).isEnabled), 0, "a group must stop when an enabled member loses required billing permission");
      assert.equal(Number((await state(106)).isEnabled), 1);
      assert.equal(Number((await state(107)).isEnabled), 1, "another user's rule must not be changed");

      const visibleIds = (await memberRules.list()).map((rule) => Number(rule.id));
      assert.ok(visibleIds.includes(100));
      assert.ok(visibleIds.includes(101));
      assert.ok(visibleIds.includes(102));
      assert.ok(!visibleIds.includes(103));
      assert.equal(Number((await memberRules.getById({ id: 102 }))?.id), 102);
      assert.equal(await memberRules.getById({ id: 103 }), null);

      await assert.rejects(() => memberRules.toggle({ id: 100, isEnabled: true }), /权限|授权/);
      await assert.rejects(() => memberRules.toggle({ id: 101, isEnabled: true }), /无权使用该隧道/);
      await assert.rejects(() => memberRules.toggle({ id: 102, isEnabled: true }), /无权.*转发组/);
      await assert.rejects(() => memberRules.toggle({ id: 110, isEnabled: true }), /计费资源.*权限|授权/);
      await assert.rejects(() => memberRules.toggle({ id: 111, isEnabled: true }), /计费成员.*授权/);

      const usableGroupIds = (await (await import(moduleUrl("server/routers/forwardGroups.ts"))).forwardGroupsRouter
        .createCaller(context(member)).options()).map((group) => Number(group.id));
      assert.ok(usableGroupIds.includes(22));
      assert.ok(!usableGroupIds.includes(23));
      assert.ok(!usableGroupIds.includes(24));
      assert.ok(!usableGroupIds.includes(25));

      const hostConfig = await adminTrafficBilling.saveConfig({
        resourceType: "host",
        resourceId: 5,
        enabled: true,
        requiresPermission: true,
        pricePerGbMilliCents: 1000,
      });
      assert.equal(Number((await state(106)).isEnabled), 0, "saving a private billing config must immediately revoke an ungranted owned rule");
      await adminTrafficBilling.saveConfig({
        id: Number(hostConfig.id),
        resourceType: "host",
        resourceId: 5,
        enabled: true,
        requiresPermission: false,
        pricePerGbMilliCents: 1000,
      });
      await memberRules.toggle({ id: 106, isEnabled: true });
      assert.equal(Number((await state(106)).isEnabled), 1, "a public billing config must become usable without a stale access cache");
      await adminTrafficBilling.deleteConfig({ id: Number(hostConfig.id) });
      assert.equal(Number((await state(106)).isEnabled), 1, "deleting a billing config must preserve access to the user's own host");

      const [billingOnlyBeforeDisable] = await runtime.queryRaw(
        'SELECT "canAddRules", "manualCanAddRules" FROM "users" WHERE "id" = ?',
        [4],
      );
      assert.equal(Number(billingOnlyBeforeDisable.canAddRules), 1);
      assert.equal(Number(billingOnlyBeforeDisable.manualCanAddRules), 0);
      await adminTrafficBilling.setEnabled({ enabled: false });
      const [billingOnlyAfterDisable] = await runtime.queryRaw(
        'SELECT "canAddRules" FROM "users" WHERE "id" = ?',
        [4],
      );
      assert.equal(Number(billingOnlyAfterDisable.canAddRules), 0, "closing the last billing access path must restore a rule-less user to the manual/plan baseline");
      await memberRules.toggle({ id: 110, isEnabled: true });
      assert.equal(Number((await state(110)).isEnabled), 1, "disabling global billing must restore the normal manual group grant immediately");
      await runtime.executeRaw('UPDATE "system_settings" SET "value" = ? WHERE "key" = ?', ["true", "trafficBillingEnabled"]);
      assert.equal(
        (await trafficBilling.getTrafficBillingAccessSnapshot(2)).status,
        "ready",
        "a disabled-state cache must not bypass billing enabled by another panel instance",
      );
      await adminTrafficBilling.setEnabled({ enabled: true });
      assert.equal(Number((await state(110)).isEnabled), 0, "re-enabling billing must immediately reconcile private resources");

      await adminUsers.setHostPermissions({ userId: 2, hostIds: [2] });
      await memberRules.update({ id: 100, hostId: 2, forwardType: "iptables", tunnelId: null, forwardGroupId: null, isEnabled: true });
      await memberRules.update({ id: 101, hostId: 2, forwardType: "iptables", tunnelId: null, forwardGroupId: null, isEnabled: true });
      assert.equal(Number((await state(100)).hostId), 2);
      assert.equal(Number((await state(100)).isEnabled), 1);
      assert.equal((await state(100)).protocolBlockReason, null);
      assert.equal(Number((await state(101)).tunnelId || 0), 0);
      assert.equal(Number((await state(101)).isEnabled), 1);
      assert.equal((await state(101)).protocolBlockReason, null);

      await adminUsers.setForwardGroupPermissions({ userId: 2, forwardGroupIds: [21] });
      const restrictedMemberRules = rulesRouter.createCaller(context({ ...member, allowedForwardTypes: "gost" }));
      await assert.rejects(
        () => restrictedMemberRules.update({ id: 102, forwardGroupId: null, hostId: 3, forwardType: "iptables", tunnelId: null, isEnabled: true }),
        /没有使用 iptables 转发方式的权限/,
      );
      await restrictedMemberRules.update({
        id: 100,
        name: "manual-host-rule-renamed",
        hostId: 2,
        forwardType: "iptables",
        tunnelId: null,
        forwardGroupId: null,
      });
      assert.equal((await state(100)).name, "manual-host-rule-renamed", "an unchanged full-form route must not block an unrelated edit");
      await assert.rejects(
        () => restrictedMemberRules.update({ id: 100, hostId: 3, forwardType: "iptables", tunnelId: null, forwardGroupId: null }),
        /没有使用 iptables 转发方式的权限/,
      );
      await assert.rejects(
        () => restrictedMemberRules.update({ id: 100, forwardGroupId: 21, forwardType: "iptables", isEnabled: true }),
        /没有使用 iptables 转发方式的权限/,
      );
      await assert.rejects(
        () => restrictedMemberRules.create({
          name: "restricted-group-create",
          forwardGroupId: 21,
          forwardType: "gost",
          protocol: "tcp",
          sourcePort: 12200,
          targetIp: "203.0.113.30",
          targetPort: 80,
        }),
        /没有使用 iptables 转发方式的权限/,
      );
      await assert.rejects(
        () => memberRules.update({ id: 102, forwardGroupId: null, hostId: 2, forwardType: "iptables", tunnelId: null, isEnabled: true }),
        /普通端口转发请先创建转发组或转发链/,
      );
      await assert.rejects(
        () => restrictedMemberRules.update({ id: 102, forwardGroupId: 21, forwardType: "iptables", isEnabled: true }),
        /没有使用 iptables 转发方式的权限/,
      );
      await memberRules.update({ id: 102, forwardGroupId: 21, isEnabled: true });
      assert.equal(Number((await state(102)).forwardGroupId), 21);
      assert.equal(Number((await state(102)).isEnabled), 1);
      assert.equal((await state(102)).protocolBlockReason, null);
      assert.equal(Number((await state(102)).pendingDelete), 0);
      await restrictedMemberRules.update({ id: 102, name: "manual-group-rule-renamed", forwardGroupId: 21, forwardType: "iptables" });
      assert.equal((await state(102)).name, "manual-group-rule-renamed", "an unchanged group route must remain editable");

      await runtime.executeRaw('DROP TABLE "user_traffic_billing_permissions"');
      const degradedSnapshot = await trafficBilling.getTrafficBillingAccessSnapshot(2);
      assert.equal(degradedSnapshot.status, "degraded");
      assert.ok(degradedSnapshot.activeResourceIds.hostIds.includes(4));
      assert.ok(degradedSnapshot.usableResourceIds.hostIds.includes(3), "public billing resources remain usable without a permission-table join");
      assert.ok(!degradedSnapshot.usableResourceIds.hostIds.includes(4), "private billing resources fail closed without a permission-table join");
      linkAccess.clearLinkAccessScopeCache();
      const degradedScope = await linkAccess.getLinkAccessScope(member);
      assert.equal(degradedScope.useHostIds.has(5), true, "an unconfigured owned host must remain usable when the permission join fails");
      assert.equal(degradedScope.useHostIds.has(4), false, "an active billing host must fail closed when permission lookup fails");
      assert.equal(degradedScope.useGroupIds.has(23), false, "an active billing group must fail closed when permission lookup fails");

      await runtime.executeRaw('DROP TABLE "forward_group_members"');
      linkAccess.clearLinkAccessScopeCache();
      const missingTopologyScope = await linkAccess.getLinkAccessScope(member);
      assert.equal(missingTopologyScope.useGroupIds.has(21), false, "group roots must fail closed when member topology cannot be verified");
      assert.equal(missingTopologyScope.useHostIds.has(5), true, "a group-topology failure must not hide unrelated direct resources");

      const userFailureResult = await reconcileTrafficBillingAuthorization("test-missing-group-topology");
      assert.ok(userFailureResult.failures.some((failure) => failure.userId !== null), "per-user reconciliation failures must be reported");
      const configWrittenWithUserFailures = await adminTrafficBilling.saveConfig({
        resourceType: "host",
        resourceId: 5,
        enabled: true,
        requiresPermission: false,
        pricePerGbMilliCents: 1000,
      });
      assert.equal(Number(configWrittenWithUserFailures.resourceId), 5, "a per-user reconciliation failure must not reject a saved config");

      await runtime.executeRaw('DROP TABLE "users"');
      const enumerationFailureResult = await reconcileTrafficBillingAuthorization("test-missing-users");
      assert.equal(enumerationFailureResult.failures.length, 1);
      assert.equal(enumerationFailureResult.failures[0].userId, null);
      assert.match(enumerationFailureResult.failures[0].error, /^user enumeration failed:/);
      assert.deepEqual(await adminTrafficBilling.setEnabled({ enabled: false }), { enabled: false });
      assert.deepEqual(await adminTrafficBilling.deleteConfig({ id: Number(configWrittenWithUserFailures.id) }), { success: true });
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const scriptPath = path.join(directory, "resource-auth.mjs");
    fs.writeFileSync(scriptPath, script, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

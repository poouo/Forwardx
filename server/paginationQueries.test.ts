import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pageResult, pageWindowForTotal } from "../shared/pagination";

test("page helpers clamp stale pages after the last item is removed", () => {
  assert.deepEqual(pageWindowForTotal({ page: 8, pageSize: 12 }, 13), {
    page: 2,
    pageSize: 12,
    offset: 12,
  });
  assert.deepEqual(pageResult(["last"], 13, { page: 8, pageSize: 12 }), {
    items: ["last"],
    page: 2,
    pageSize: 12,
    totalItems: 13,
    totalPages: 2,
  });
});
test("database-backed list queries page, search, scope, and hydrate only requested rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-pagination-"));
  const databasePath = path.join(directory, "pagination.db");
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
      const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));
      const tunnels = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const rules = await import(moduleUrl("server/repositories/forwardRuleRepository.ts"));
      const billing = await import(moduleUrl("server/repositories/billingRepository.ts"));

      const quote = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        await runtime.executeRaw(
          "INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
          values,
        );
      };
      const now = Math.floor(Date.now() / 1000);

      await insert("users", ["id", "username", "password", "name", "role", "balanceCents"], [1, "admin", "x", "Admin", "admin", 100]);
      await insert("users", ["id", "username", "password", "name", "role", "balanceCents"], [2, "alice", "x", "Alice Edge", "user", 200]);

      await insert(
        "hosts",
        [
          "id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "sortOrder", "agentVersion",
          "geoCountryCode", "geoCountryName", "geoRegion", "geoEmoji", "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt",
        ],
        [
          1, "Tokyo Entry", "192.0.2.10", "192.0.2.10", 1, 1, now, 0, "2.2.157",
          "JP", "Japan", "Tokyo", "JP", 35676000, 139650000, now,
        ],
      );
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "sortOrder", "agentVersion"],
        [2, "Singapore Exit", "192.0.2.20", "192.0.2.20", 1, 1, now, 1, "2.2.158"],
      );
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "sortOrder", "agentVersion"],
        [3, "Unused Node", "192.0.2.30", "192.0.2.30", 2, 0, now - 3600, 2, "2.2.157"],
      );

      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "sortOrder"],
        [10, "Saved Port", "host", "port", "127.0.0.1", 1, 1, 0],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "sortOrder"],
        [11, "Private Chain", "host", "chain", "127.0.0.1", 1, 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [1001, 10, "host", 1, 0, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [1101, 11, "host", 2, 0, 1],
      );

      await insert(
        "tunnels",
        ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "sortOrder"],
        [20, "Singapore Path", 1, 2, "tls", 62000, 1, 1, 0],
      );
      await insert(
        "tunnels",
        ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "sortOrder"],
        [21, "Unused Path", 2, 3, "forwardx", 62001, 2, 1, 1],
      );

      const ruleColumns = [
        "id", "hostId", "name", "forwardType", "protocol", "tunnelId", "forwardGroupId",
        "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort",
        "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "sortOrder",
      ];
      await insert("forward_rules", ruleColumns, [100, 1, "Direct Alpha", "iptables", "tcp", null, null, null, null, 0, 10000, "example.com", 443, 2, 1, 0, 0]);
      await insert("forward_rules", ruleColumns, [101, 1, "Tunnel Beta", "gost", "both", 20, null, null, null, 0, 10001, "game.example", 9000, 2, 1, 0, 1]);
      await insert("forward_rules", ruleColumns, [102, 1, "Port Template", "iptables", "tcp", null, 10, null, null, 1, 10002, "port.example", 80, 2, 1, 0, 2]);
      await insert("forward_rules", ruleColumns, [103, 1, "Managed Child", "iptables", "tcp", null, 10, 102, 1001, 0, 10002, "port.example", 80, 2, 1, 0, 3]);
      await insert("forward_rules", ruleColumns, [104, 2, "Chain Template", "iptables", "tcp", null, 11, null, null, 1, 10003, "chain.example", 80, 2, 1, 0, 3]);

      const userPage = await users.getUsersPage({ page: 9, pageSize: 1 });
      assert.equal(userPage.totalItems, 2);
      assert.equal(userPage.page, 2);
      assert.equal(userPage.items.length, 1);
      assert.deepEqual(await users.getUserManagementCounts(), {
        totalUsers: 2,
        adminUsers: 1,
        activeSubscriptions: 0,
      });

      const hostPage = await hosts.getHostsPage({ page: 1, pageSize: 1, search: "Tokyo" });
      assert.equal(hostPage.totalItems, 1);
      assert.equal(hostPage.items[0].id, 1);
      const hostSecondPage = await hosts.getHostsPage({ page: 2, pageSize: 2 });
      assert.equal(hostSecondPage.totalItems, 3);
      assert.deepEqual(hostSecondPage.items.map((item) => Number(item.id)), [3]);
      assert.deepEqual(
        hostSecondPage.versionCounts
          .map((item) => [item.agentVersion, item.online, Number(item.count)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1])),
        [
          ["2.2.157", false, 1],
          ["2.2.157", true, 1],
          ["2.2.158", true, 1],
        ],
      );
      const hostSummary = await hosts.getHostSummaryScope({ ownerUserId: 2, allowedHostIds: [1] });
      assert.equal(hostSummary.totalHosts, 2);
      assert.equal(hostSummary.onlineHosts, 1);
      assert.deepEqual(hostSummary.hostIds.map(Number).sort((a, b) => a - b), [1, 3]);
      const hostStatuses = await hosts.getHostStatusRows({
        ownerUserId: 2,
        allowedHostIds: [1],
        hostIds: [1, 2, 3],
      });
      assert.deepEqual(hostStatuses.map((item) => Number(item.id)).sort((a, b) => a - b), [1, 3]);
      const hostOptions = await hosts.getHostOptions(2, [1]);
      const tokyoOption = hostOptions.find((item) => Number(item.id) === 1);
      assert.deepEqual(
        {
          countryCode: tokyoOption?.geoCountryCode,
          countryName: tokyoOption?.geoCountryName,
          region: tokyoOption?.geoRegion,
          latitude: tokyoOption?.geoLatitudeMicro,
          longitude: tokyoOption?.geoLongitudeMicro,
        },
        {
          countryCode: "JP",
          countryName: "Japan",
          region: "Tokyo",
          latitude: 35676000,
          longitude: 139650000,
        },
      );

      const tunnelPage = await tunnels.getTunnelsPage({ page: 1, pageSize: 10, search: "Tokyo Entry" });
      assert.equal(tunnelPage.totalItems, 1);
      assert.equal(tunnelPage.items[0].id, 20);

      const groupPage = await groups.getForwardGroupsPage({
        page: 1,
        pageSize: 10,
        groupMode: "port",
        search: "Tokyo Entry",
      });
      assert.equal(groupPage.totalItems, 1);
      assert.equal(groupPage.items[0].id, 10);
      assert.equal(groupPage.items[0].members.length, 1);

      const visibleRuleInput = {
        ownerUserId: 2,
        allowedForwardGroupIds: [10],
        entryHostId: null,
        category: "all",
        search: "",
      };
      const rulePage = await rules.getForwardRulesPage({ ...visibleRuleInput, page: 9, pageSize: 2 });
      assert.equal(rulePage.totalItems, 3);
      assert.equal(rulePage.scopeTotalItems, 3);
      assert.equal(rulePage.page, 2);
      assert.deepEqual(rulePage.categoryCounts, { all: 3, local: 2, tunnel: 1, chain: 0, group: 0 });
      assert.equal(rulePage.items.length, 1);
      assert.notEqual(rulePage.items[0].id, 104);

      const tunnelSearch = await rules.getForwardRulesPage({
        ...visibleRuleInput,
        page: 1,
        pageSize: 10,
        search: "Singapore Exit",
      });
      assert.deepEqual(tunnelSearch.items.map((item) => Number(item.id)), [101]);

      const tunnelCategorySearch = await rules.getForwardRulesPage({
        ...visibleRuleInput,
        page: 1,
        pageSize: 10,
        search: "tunnel",
      });
      assert.deepEqual(tunnelCategorySearch.items.map((item) => Number(item.id)), [101]);

      const entryFiltered = await rules.getForwardRulesPage({
        ...visibleRuleInput,
        page: 1,
        pageSize: 10,
        entryHostId: 1,
      });
      assert.equal(entryFiltered.totalItems, 3);

      const mapBatch = await rules.getForwardRuleMapBatch(visibleRuleInput, 2, 2);
      assert.equal(mapBatch.totalItems, 3);
      assert.equal(mapBatch.items.length, 1);
      assert.equal(mapBatch.nextCursor, undefined);

      for (const [id, name, active, sortOrder] of [
        [30, "Basic", 1, 0],
        [31, "Plus", 1, 1],
        [32, "Archive", 0, 2],
      ]) {
        await insert("subscription_plans", ["id", "name", "isActive", "sortOrder"], [id, name, active, sortOrder]);
      }
      await insert("subscription_plan_hosts", ["planId", "hostId"], [30, 1]);
      await insert("subscription_plan_tunnels", ["planId", "tunnelId"], [31, 20]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [30, 10]);
      await insert("subscription_plan_forward_groups", ["planId", "forwardGroupId"], [32, 11]);

      const planPage = await billing.listSubscriptionPlansPage({ page: 2, pageSize: 2 });
      assert.equal(planPage.totalItems, 3);
      assert.equal(planPage.items.length, 1);
      assert.ok(Array.isArray(planPage.items[0].forwardGroupRefs));
      const planSummary = await billing.getSubscriptionPlanSummary();
      assert.equal(planSummary.totalItems, 3);
      assert.equal(planSummary.activeItems, 2);
      assert.deepEqual(planSummary.resources, {
        legacyHosts: 1,
        tunnels: 1,
        ports: 1,
        chains: 1,
        groups: 0,
        otherForwardResources: 0,
      });

      await insert("redemption_codes", ["id", "code", "type", "isActive", "usedAt"], [40, "R1", "balance", 1, null]);
      await insert("redemption_codes", ["id", "code", "type", "isActive", "usedAt"], [41, "R2", "balance", 1, now]);
      await insert("redemption_codes", ["id", "code", "type", "isActive", "usedAt"], [42, "R3", "balance", 0, null]);
      await insert("discount_codes", ["id", "code", "discountType", "discountValue", "isActive", "maxUses", "usedCount", "expiresAt"], [50, "D1", "percent", 10, 1, 0, 0, null]);
      await insert("discount_codes", ["id", "code", "discountType", "discountValue", "isActive", "maxUses", "usedCount", "expiresAt"], [51, "D2", "percent", 10, 1, 0, 0, now - 1]);
      await insert("discount_codes", ["id", "code", "discountType", "discountValue", "isActive", "maxUses", "usedCount", "expiresAt"], [52, "D3", "percent", 10, 1, 1, 1, null]);

      const billingSummary = await billing.getBillingAdminSummary();
      assert.deepEqual(billingSummary, {
        userCount: 2,
        totalBalanceCents: 300,
        activeRedemptionCodes: 1,
        activeDiscountCodes: 1,
      });
      const unusedCodes = await billing.listRedemptionCodesPage({ page: 1, pageSize: 1, usage: "unused" });
      assert.equal(unusedCodes.totalItems, 2);
      assert.equal(unusedCodes.items.length, 1);
      const discountPage = await billing.listDiscountCodesPage({ page: 2, pageSize: 2 });
      assert.equal(discountPage.totalItems, 3);
      assert.equal(discountPage.items.length, 1);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canUseForwardRuleResource,
  expandLinkAccessScope,
  filterTunnelFieldsForUser,
  type LinkAccessScope,
} from "./linkAccessView";
import { publicLinkAvailabilitySummary } from "./linkAvailabilitySummary";
import { filterForwardGroupFieldsForUse } from "./repositories/forwardGroupRepository";

const scope: LinkAccessScope = {
  hostIds: new Set([1]),
  tunnelIds: new Set([10]),
  groupIds: new Set([20]),
};

test("shared resource permissions expand to enabled topology members", () => {
  const expanded = expandLinkAccessScope({
    hostIds: [1, "bad", 0],
    tunnelIds: [],
    groupIds: [100],
    groups: [
      { id: 100, entryGroupId: 90 },
      // A cycle must terminate and keep both explicitly reachable groups.
      { id: 90, entryGroupId: 100 },
      { id: 70 },
      { id: 80 },
    ],
    members: [
      { groupId: 100, memberType: "host", hostId: 2, isEnabled: true },
      { groupId: 100, memberType: "host", hostId: 3, isEnabled: "0" },
      { groupId: 100, memberType: "tunnel", tunnelId: 10, isEnabled: 1 },
      { groupId: 100, memberType: "tunnel", tunnelId: 999, isEnabled: 1 },
      { groupId: 90, memberType: "host", hostId: 4 },
    ],
    tunnels: [
      { id: 10, entryHostId: 5, exitHostId: 6, entryGroupId: 70, exitGroupId: 80 },
    ],
    tunnelHops: [
      { tunnelId: 10, hostId: 7 },
    ],
    tunnelExitNodes: [
      { tunnelId: 10, hostId: 8 },
    ],
  });

  assert.deepEqual(Array.from(expanded.groupIds).sort((a, b) => a - b), [70, 80, 90, 100]);
  assert.deepEqual(Array.from(expanded.tunnelIds).sort((a, b) => a - b), []);
  assert.deepEqual(Array.from(expanded.hostIds).sort((a, b) => a - b), [1]);
  assert.deepEqual(Array.from(expanded.groupHostIds?.get(100) || []).sort((a, b) => a - b), [2, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(expanded.groupHostIds?.get(90) || []).sort((a, b) => a - b), [4]);
  assert.deepEqual(Array.from(expanded.groupTunnelIds?.get(100) || []).sort((a, b) => a - b), [10]);
  assert.deepEqual(Array.from(expanded.useHostIds || []), [1]);
  assert.deepEqual(Array.from(expanded.useTunnelIds || []), []);
  assert.deepEqual(Array.from(expanded.useGroupIds || []), [100]);
  assert.equal(canUseForwardRuleResource({ forwardGroupId: 100 }, expanded), true);
  assert.equal(canUseForwardRuleResource({ forwardGroupId: 90 }, expanded), false);
  assert.equal(canUseForwardRuleResource({ tunnelId: 10 }, expanded), false);
  assert.equal(canUseForwardRuleResource({ hostId: 2 }, expanded), false);
});

test("direct tunnel permissions include tunnel topology hosts", () => {
  const expanded = expandLinkAccessScope({
    tunnelIds: [11],
    tunnels: [{ id: 11, entryHostId: 21, exitHostId: 22, entryGroupId: 31, exitGroupId: 32 }],
    tunnelHops: [{ tunnelId: 11, hostId: 23 }],
    tunnelExitNodes: [
      { tunnelId: 11, hostId: 24, isEnabled: true },
      { tunnelId: 11, hostId: 25, isEnabled: false },
    ],
    groups: [{ id: 31 }, { id: 32 }],
  });

  assert.deepEqual(Array.from(expanded.tunnelIds), [11]);
  assert.deepEqual(Array.from(expanded.hostIds).sort((a, b) => a - b), [21, 22, 23, 24]);
  assert.deepEqual(Array.from(expanded.groupIds).sort((a, b) => a - b), [31, 32]);
  assert.deepEqual(Array.from(expanded.useHostIds || []), []);
  assert.deepEqual(Array.from(expanded.useTunnelIds || []), [11]);
  assert.deepEqual(Array.from(expanded.useGroupIds || []), []);
  assert.equal(canUseForwardRuleResource({ tunnelId: 11 }, expanded), true);
  assert.equal(canUseForwardRuleResource({ hostId: 21 }, expanded), false);
  assert.equal(canUseForwardRuleResource({ forwardGroupId: 31 }, expanded), false);
});

test("runtime gate disables revoked root resources without promoting expanded topology", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-link-runtime-gate-"));
  const databasePath = path.join(directory, "runtime-gate.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const access = await import(moduleUrl("server/linkAccessView.ts"));
    const quote = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + quote(table) + " (" + columns.map(quote).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);

      await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
      await insert("users", ["id", "username", "password", "role"], [2, "member", "x", "user"]);
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [1, "topology-only", "192.0.2.1", "192.0.2.1", 1, 1, now],
      );
      await insert(
        "hosts",
        ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat"],
        [2, "directly-authorized", "192.0.2.2", "192.0.2.2", 1, 1, now],
      );
      await insert(
        "tunnels",
        ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "authorized-tunnel", 1, 2, "tls", 24010, 1, 1],
      );
      await insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"],
        [20, "authorized-group", "host", "port", "127.0.0.1", 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"],
        [201, 20, "host", 1, 0, 1],
      );
      await insert("user_host_permissions", ["userId", "hostId"], [2, 1]);
      await insert("user_host_permissions", ["userId", "hostId"], [2, 2]);
      await insert("user_tunnel_permissions", ["userId", "tunnelId"], [2, 10]);
      await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [2, 20]);

      await runtime.executeRaw(
        'DELETE FROM "user_host_permissions" WHERE "userId" = ? AND "hostId" = ?',
        [2, 1],
      );
      access.clearLinkAccessScopeCache();

      const revoked = { id: 100, userId: 2, hostId: 1, tunnelId: null, forwardGroupId: null, isEnabled: true };
      const allowedTunnel = { id: 101, userId: 2, hostId: 1, tunnelId: 10, forwardGroupId: null, isEnabled: true };
      const allowedGroup = { id: 102, userId: 2, hostId: 1, tunnelId: null, forwardGroupId: 20, isEnabled: true };
      const allowedHost = { id: 103, userId: 2, hostId: 2, tunnelId: null, forwardGroupId: null, isEnabled: true };
      const adminRule = { id: 104, userId: 1, hostId: 1, tunnelId: null, forwardGroupId: null, isEnabled: true };
      const gated = await access.gateForwardRulesForRuntime([
        revoked,
        allowedTunnel,
        allowedGroup,
        allowedHost,
        adminRule,
      ]);

      assert.equal(revoked.isEnabled, true, "the saved rule must not be mutated");
      assert.notStrictEqual(gated[0], revoked);
      assert.equal(gated[0].isEnabled, false);
      assert.equal(gated[0].resourceAccessDenied, true);
      assert.strictEqual(gated[1], allowedTunnel);
      assert.strictEqual(gated[2], allowedGroup);
      assert.strictEqual(gated[3], allowedHost);
      assert.strictEqual(gated[4], adminRule);
      assert.equal(gated.slice(1).some((rule) => rule.resourceAccessDenied), false);
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

test("shared tunnel status does not expose hosts outside the user's host scope", () => {
  const filtered = filterTunnelFieldsForUser({
    id: 10,
    entryHostId: 1,
    exitHostId: 2,
    certPem: "certificate",
    certKeyPem: "private-key",
    secret: "secret",
    entryHost: { id: 1, name: "visible", ip: "192.0.2.1", lastHeartbeat: 100 },
    exitHost: { id: 2, name: "hidden", ip: "192.0.2.2", lastHeartbeat: 200 },
    hopHostIds: [1, 2],
    hopConnectHosts: ["192.0.2.1", "192.0.2.2"],
    hopHosts: [{ id: 1, name: "visible" }, { id: 2, name: "hidden" }],
    loadBalanceExits: [{ hostId: 3, connectHost: "192.0.2.3", host: { id: 3, name: "hidden-exit" } }],
    entryGroup: { id: 30, members: [{ id: 300, hostId: 2 }] },
    lastTestMessage: "TUNNEL_TEST_TARGET_INVALID target=hidden.example.test port=65432",
    latestLatencySeries: [{ seriesLabel: "hidden.example.test (host 2):65432", latencyMs: 42 }],
    availability: { status: "available", available: true, source: "hosts", message: "online" },
  }, scope) as any;

  assert.equal(filtered.entryHost.name, "visible");
  assert.equal(filtered.exitHost, null);
  assert.equal(filtered.entryHostId, 1);
  assert.equal(filtered.exitHostId, null);
  assert.equal(filtered.connectHost, null);
  assert.deepEqual(filtered.hopHostIds, [1]);
  assert.deepEqual(filtered.hopConnectHosts, ["192.0.2.1"]);
  assert.deepEqual(filtered.loadBalanceExits, []);
  assert.equal("entryGroup" in filtered, false);
  assert.equal("lastTestMessage" in filtered, false);
  assert.equal("latestLatencySeries" in filtered, false);
  assert.equal("certPem" in filtered, false);
  assert.equal("certKeyPem" in filtered, false);
  assert.equal("secret" in filtered, false);
  assert.equal(filtered.availability.status, "available");
  assert.equal(JSON.stringify(filtered).includes("hidden"), false);
  assert.equal(JSON.stringify(filtered).includes("192.0.2.2"), false);
  assert.equal(JSON.stringify(filtered).includes("hidden.example.test"), false);
  assert.equal(JSON.stringify(filtered).includes('"lastHeartbeat":200'), false);
});

test("shared group keeps an accurate summary while removing unauthorized members", () => {
  const availability = publicLinkAvailabilitySummary({
    status: "degraded",
    available: true,
    source: "hosts",
    message: "partially online",
    usableHostIds: new Set([1, 2]),
    usableMemberIds: new Set([101, 102, 103]),
  }, [101, 103]);
  const [filtered] = filterForwardGroupFieldsForUse([{
    id: 20,
    name: "shared",
    groupMode: "failover",
    availability,
    members: [
      { id: 101, memberType: "host", hostId: 1, host: { id: 1, name: "visible", ip: "192.0.2.1" } },
      { id: 102, memberType: "host", hostId: 2, host: { id: 2, name: "hidden", ip: "192.0.2.2" } },
      { id: 103, memberType: "tunnel", tunnelId: 10, host: { id: 2, name: "hidden-entry", ip: "192.0.2.2" } },
      { id: 104, memberType: "tunnel", tunnelId: 11, host: { id: 1, name: "visible-but-member-hidden" } },
    ],
  }], scope) as any[];

  assert.deepEqual(filtered.members.map((member: any) => member.id), [101, 103]);
  assert.equal(filtered.members[0].host.name, "visible");
  assert.equal(filtered.members[1].host, null);
  assert.equal(filtered.members[1].connectHost, null);
  assert.equal(filtered.members[1].entryAddress, null);
  assert.deepEqual(filtered.availability.usableMemberIds, [101, 103]);
  assert.equal(filtered.availability.status, "degraded");
});

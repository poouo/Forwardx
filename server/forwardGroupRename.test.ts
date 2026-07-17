import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward resource renames propagate without restarting unchanged runtimes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-group-rename-"));
  const databasePath = path.join(directory, "rename.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
    const service = await import(moduleUrl("server/services/forwardGroupService.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      const placeholders = values.map(() => "?").join(", ");
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
        values,
      );
    };
    const baseInput = (overrides) => ({
      name: "resource",
      remark: null,
      groupMode: "failover",
      groupType: "host",
      protocol: "tcp",
      forwardType: "iptables",
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
      proxyProtocolVersion: 1,
      tcpFastOpen: false,
      zeroCopy: false,
      udpOverTcp: false,
      udpOverTcpPort: null,
      failoverEnabled: false,
      failoverStrategy: "fallback",
      failoverTargets: [],
      domain: null,
      recordType: "A",
      failoverSeconds: 60,
      recoverSeconds: 120,
      trafficMultiplier: 100,
      chinaHealthCheckEnabled: false,
      chinaHealthCheckTarget: null,
      telegramSwitchNotifyEnabled: false,
      ddnsAutoResolveEnabled: false,
      autoFailback: true,
      isEnabled: true,
      members: [],
      ...overrides,
    });
    const insertTemplate = async (id, groupId, hostId, name, sourcePort) => {
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [id, hostId, name, "iptables", "tcp", groupId, 1, sourcePort, "203.0.113.10", 443, 1, 1, 0],
      );
      await groups.syncForwardGroupRules(groupId);
      await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning" = 1 WHERE "forwardGroupRuleId" = ?', [id]);
    };
    const managedChildren = (templateId) => runtime.queryRaw(
      'SELECT "id", "name", "isRunning" FROM "forward_rules" WHERE "forwardGroupRuleId" = ? ORDER BY "id"',
      [templateId],
    );

    try {
      const now = Math.floor(Date.now() / 1000);
      for (const [id, publicIp, privateIp] of [
        [1, "198.51.100.1", "10.0.0.1"],
        [2, "198.51.100.2", "10.0.0.2"],
        [3, "198.51.100.3", "10.0.0.3"],
      ]) {
        await insert(
          "hosts",
          ["id", "name", "ip", "ipv4", "entryIp", "tunnelEntryIp", "userId", "isOnline", "lastHeartbeat"],
          [id, "host-" + id, publicIp, publicIp, publicIp, privateIp, 1, 1, now],
        );
      }

      const failoverInput = baseInput({
        name: "failover-old",
        members: [{ memberType: "host", hostId: 1, priority: 0, isEnabled: true }],
      });
      const failoverId = await service.createForwardGroupFromInput(failoverInput, 1);
      await insertTemplate(100, failoverId, 1, "failover-template", 16000);
      const updatedFailover = await service.updateForwardGroupFromInput(failoverId, {
        ...failoverInput,
        name: "failover-new",
      });
      const failoverChildren = await managedChildren(100);
      assert.equal(updatedFailover.name, "failover-new");
      assert.equal(failoverChildren.length, 1);
      assert.equal(failoverChildren[0].name, "[Group:failover-new] failover-template");
      assert.equal(Number(failoverChildren[0].isRunning), 1);

      const chainMembers = [
        { memberType: "host", hostId: 1, connectHost: null, priority: 0, isEnabled: true },
        { memberType: "host", hostId: 2, connectHost: "10.0.0.2", priority: 1, isEnabled: true },
      ];
      const chainInput = baseInput({
        name: "chain-old",
        groupMode: "chain",
        members: chainMembers,
      });
      const chainId = await service.createForwardGroupFromInput(chainInput, 1);
      await insertTemplate(200, chainId, 1, "chain-template", 18000);
      await service.updateForwardGroupFromInput(chainId, { ...chainInput, name: "chain-new" });
      const chainChildren = await managedChildren(200);
      assert.equal(chainChildren.length, 2);
      assert.ok(chainChildren.every((rule) => String(rule.name).startsWith("[Chain:chain-new]")));
      assert.ok(chainChildren.every((rule) => Number(rule.isRunning) === 1));

      const exitInput = baseInput({
        name: "exit-old",
        groupMode: "exit",
        members: [{ memberType: "host", hostId: 2, connectHost: "10.0.0.2", priority: 0, isEnabled: true }],
      });
      const exitGroupId = await service.createForwardGroupFromInput(exitInput, 1);
      await insert(
        "tunnels",
        ["id", "name", "exitGroupId", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled", "isRunning"],
        [300, "controlled-tunnel", exitGroupId, 1, 2, "forwardx", 25000, 1, 1, 1],
      );
      await insert(
        "forward_rules",
        ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"],
        [310, 1, "tunnel-rule", "gost", "tcp", 300, 25001, 17000, "203.0.113.20", 443, 1, 1, 1],
      );

      const renamedExit = await service.updateForwardGroupFromInput(exitGroupId, {
        ...exitInput,
        name: "exit-new",
      });
      let tunnelState = (await runtime.queryRaw('SELECT "isRunning" FROM "tunnels" WHERE "id" = 300'))[0];
      let tunnelRuleState = (await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = 310'))[0];
      assert.equal(renamedExit.name, "exit-new");
      assert.equal(Number(tunnelState.isRunning), 1, "rename-only update must not restart the tunnel");
      assert.equal(Number(tunnelRuleState.isRunning), 1, "rename-only update must not reset referenced rules");

      await service.updateForwardGroupFromInput(exitGroupId, {
        ...exitInput,
        name: "exit-new",
        members: [{ memberType: "host", hostId: 3, connectHost: "10.0.0.3", priority: 0, isEnabled: true }],
      });
      tunnelState = (await runtime.queryRaw('SELECT "isRunning" FROM "tunnels" WHERE "id" = 300'))[0];
      tunnelRuleState = (await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = 310'))[0];
      assert.equal(Number(tunnelState.isRunning), 0, "exit topology changes must refresh referenced tunnels");
      assert.equal(Number(tunnelRuleState.isRunning), 0, "exit topology changes must reset referenced rules");

      const listedExit = (await groups.getForwardGroups()).find((group) => Number(group.id) === Number(exitGroupId));
      assert.equal(listedExit.name, "exit-new");
      assert.equal(Number(listedExit.members[0].hostId), 3);
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
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

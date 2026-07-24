import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";

test("tunnel probe topology ignores runtime timestamps and status", () => {
  const base = {
    id: 1,
    isEnabled: true,
    mode: "forwardx",
    entryHostId: 10,
    exitHostId: 20,
    listenPort: 3000,
    updatedAt: new Date(1),
    isRunning: false,
  };
  const first = tunnelProbeTopologyKey(base);
  const second = tunnelProbeTopologyKey({ ...base, updatedAt: new Date(999999), isRunning: true, lastLatencyMs: 20 });
  assert.equal(first, second);
  assert.notEqual(first, tunnelProbeTopologyKey({ ...base, listenPort: 3001 }));
});

test("tunnel probe topology follows the active exit strategy", () => {
  const base = {
    id: 2,
    isEnabled: true,
    mode: "forwardx",
    entryHostId: 10,
    exitHostId: 20,
    listenPort: 3000,
    loadBalanceEnabled: true,
  };
  const exitNodes = [{ id: 1, hostId: 21, listenPort: 3001, isEnabled: true }];
  const disabled = tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "none" }, [], exitNodes);
  assert.equal(
    disabled,
    tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "none" }, [], [{ ...exitNodes[0], listenPort: 3999 }]),
  );
  assert.notEqual(
    disabled,
    tunnelProbeTopologyKey({ ...base, loadBalanceStrategy: "round_robin" }, [], exitNodes),
  );
});

test("forward-chain topology is stable across probe ordering and changes with a target", () => {
  const probes = [
    { fromHostId: 1, hopIndex: 0, hopCount: 2, targetIp: "a.example", targetPort: 1000, method: "tcp" },
    { fromHostId: 2, hopIndex: 1, hopCount: 2, targetIp: "b.example", targetPort: 1000, method: "tcp" },
  ];
  const first = forwardGroupProbeTopologyKey(9, probes);
  assert.equal(first, forwardGroupProbeTopologyKey(9, [...probes].reverse()));
  assert.notEqual(first, forwardGroupProbeTopologyKey(9, [{ ...probes[0], targetPort: 1001 }, probes[1]]));
});

test("heartbeat probe repositories batch chain, China-health, and tunnel topology", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-heartbeat-probes-"));
  const databasePath = path.join(directory, "probes.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    try {
      const groups = await import(moduleUrl("server/repositories/forwardGroupRepository.ts"));
      const tunnels = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
      const q = (name) => '"' + name + '"';
      const insert = async (table, columns, values) => {
        await runtime.executeRaw(
          "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
          values,
        );
      };

      await insert("hosts", ["id", "name", "ip", "entryIp", "tunnelEntryIp", "userId"], [1, "entry", "198.51.100.1", "entry.example.test", null, 1]);
      await insert("hosts", ["id", "name", "ip", "entryIp", "tunnelEntryIp", "userId"], [2, "first", "198.51.100.2", "public-2.example.test", "10.0.0.2", 1]);
      await insert("hosts", ["id", "name", "ip", "entryIp", "tunnelEntryIp", "userId"], [3, "last", "198.51.100.3", "edge-3.example.test", null, 1]);
      await insert("hosts", ["id", "name", "ip", "entryIp", "tunnelEntryIp", "userId"], [4, "exit", "198.51.100.4", null, null, 1]);
      await insert("hosts", ["id", "name", "ip", "entryIp", "tunnelEntryIp", "userId"], [5, "disabled", "198.51.100.5", null, null, 1]);

      const addGroup = (values) => insert(
        "forward_groups",
        ["id", "name", "groupType", "groupMode", "entryGroupId", "targetIp", "userId", "isEnabled", "chinaHealthCheckEnabled", "chinaHealthCheckTarget"],
        values,
      );
      await addGroup([10, "entry group", "host", "entry", null, "0.0.0.0", 1, 1, 1, "entry-health.example.test:81"]);
      await addGroup([20, "external chain", "host", "chain", 10, "0.0.0.0", 1, 1, 0, null]);
      await addGroup([21, "direct chain", "host", "chain", null, "0.0.0.0", 1, 1, 0, null]);
      await addGroup([22, "disabled chain", "host", "chain", null, "0.0.0.0", 1, 0, 0, null]);
      await addGroup([30, "health group", "tunnel", "failover", null, "0.0.0.0", 1, 1, 1, "health.example.test:82"]);
      await addGroup([31, "disabled health", "host", "failover", null, "0.0.0.0", 1, 0, 1, "disabled.example.test:83"]);

      const addHostMember = (id, groupId, hostId, priority, isEnabled = 1, connectHost = null) => insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "hostId", "connectHost", "priority", "isEnabled"],
        [id, groupId, "host", hostId, connectHost, priority, isEnabled],
      );
      await addHostMember(101, 10, 1, 0);
      await addHostMember(102, 10, 5, 1, 0);
      await addHostMember(201, 20, 2, 0, 1, "10.0.0.2");
      await addHostMember(202, 20, 3, 1);
      await addHostMember(203, 20, 4, 2, 0);
      await addHostMember(211, 21, 1, 0);
      await addHostMember(212, 21, 2, 1, 1, "10.0.0.2");
      await addHostMember(213, 21, 3, 2, 0);
      await addHostMember(221, 22, 1, 0);
      await addHostMember(222, 22, 2, 1);
      await addHostMember(301, 30, 1, 0);
      await addHostMember(303, 30, 5, 2, 0);
      await addHostMember(311, 31, 1, 0);

      await insert(
        "tunnels",
        ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [400, "health tunnel", 1, 4, "forwardx", 24000, 1, 1],
      );
      await insert(
        "forward_group_members",
        ["id", "groupId", "memberType", "tunnelId", "priority", "isEnabled"],
        [302, 30, "tunnel", 400, 1, 1],
      );
      await insert("tunnel_hops", ["id", "tunnelId", "seq", "hostId", "listenPort"], [4012, 400, 2, 4, 24002]);
      await insert("tunnel_hops", ["id", "tunnelId", "seq", "hostId", "listenPort"], [4010, 400, 0, 1, 24000]);
      await insert("tunnel_hops", ["id", "tunnelId", "seq", "hostId", "listenPort"], [4011, 400, 1, 2, 24001]);

      const snapshot = await groups.getForwardGroupProbeTopologyForHost(1);
      assert.deepEqual(snapshot.chainGroups.map((group) => group.groupId).sort((a, b) => a - b), [20, 21]);
      for (const chain of snapshot.chainGroups) {
        assert.deepEqual(chain.probes, await groups.getForwardGroupChainProbes(chain.groupId));
      }
      const externalChain = snapshot.chainGroups.find((group) => group.groupId === 20);
      assert.equal(externalChain.probes[0].fromHostId, 1);
      assert.equal(externalChain.probes[0].targetIp, "10.0.0.2", "stored private connectHost should win over the public ingress address");
      assert.equal(externalChain.probes[1].targetIp, "edge-3.example.test");
      assert.equal(externalChain.probes.length, 2, "disabled chain members must not create probes");

      const legacyChinaProbes = await groups.getForwardGroupChinaHealthProbesForHost(1);
      assert.deepEqual(snapshot.chinaHealthProbes, legacyChinaProbes);
      assert.deepEqual(snapshot.chinaHealthProbes.map((probe) => probe.memberId).sort((a, b) => a - b), [101, 301, 302]);
      assert.equal(snapshot.chinaHealthProbes.find((probe) => probe.memberId === 302).fromHostId, 1, "tunnel members should probe from the tunnel entry host");

      const hops = await tunnels.getTunnelHopsByTunnelIds([400, 0, 400, 999]);
      assert.deepEqual(hops.map((hop) => [Number(hop.tunnelId), Number(hop.seq)]), [[400, 0], [400, 1], [400, 2]]);
      assert.deepEqual(await tunnels.getTunnelHopsByTunnelIds([]), []);
    } finally {
      await runtime.closeDatabase();
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

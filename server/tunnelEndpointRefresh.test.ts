import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("probe-only refresh and the real rule self-test preserve tunnel readiness", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-refresh-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await load("server/dbRuntime.ts");
    const streams = [];
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await (await load("server/dbSchema.ts")).ensureDatabaseSchema();
      const events = await load("server/agentEvents.ts");
      const state = await load("server/tunnelRuntimeStatus.ts");
      const auto = await load("server/tunnelAutoLatencyState.ts");
      const multi = await load("server/tunnelMultiEntryLatencyState.ts");
      const { pushTunnelEndpointRefresh } = await load("server/routers/helpers.ts");
      const { selfTestRulesRouter } = await load("server/routers/rules.selfTest.ts");
      const insert = async (table, columns, values) => runtime.executeRaw(
        'INSERT INTO "' + table + '" (' + columns.map((name) => '"' + name + '"').join(',') +
        ') VALUES (' + values.map(() => '?').join(',') + ')', values,
      );
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "listenPort", "userId", "mode", "isRunning", "entryGroupId"],
        [1, "test tunnel", 1, 3, 17003, 1, "forwardx", 1, 10]);
      for (const hostId of [1, 2, 3]) {
        await insert("tunnel_hops", ["tunnelId", "seq", "hostId", "listenPort"], [1, hostId - 1, hostId, 17000 + hostId]);
      }
      await insert("forward_groups", ["id", "name", "groupMode", "groupType", "targetIp", "userId", "isEnabled"],
        [10, "entries", "entry", "host", "0.0.0.0", 1, 1]);
      for (const [hostId, enabled] of [[4, 1], [5, 0]]) {
        await insert("forward_group_members", ["groupId", "memberType", "hostId", "isEnabled"], [10, "host", hostId, enabled]);
      }
      await insert("tunnel_exit_nodes", ["tunnelId", "seq", "hostId", "listenPort"], [1, 0, 6, 17006]);
      await insert("forward_rules", ["id", "name", "hostId", "userId", "sourcePort", "targetIp", "targetPort", "protocol", "forwardType", "tunnelId"],
        [1, "test rule", 1, 1, 18001, "target.example.test", 443, "tcp", "realm", 1]);
      const responses = new Map();
      for (const hostId of [1, 2, 3, 4, 5, 6]) {
        class Response extends EventEmitter {
          writes = [];
          write(value) { this.writes.push(value); return true; }
          end() { this.emit("finish"); }
        }
        const response = new Response();
        responses.set(hostId, response);
        streams.push(events.registerAgentEventClient(hostId, "test-token", response));
      }
      const tunnel = { id: 1, name: "test tunnel", entryHostId: 1, exitHostId: 3, entryGroupId: 10 };
      const readyHosts = [1, 2, 3, 4, 6];
      const seedReady = () => readyHosts.forEach((hostId) => state.recordTunnelRuntimeHostStatus(1, hostId, true));
      const assertReady = () => readyHosts.forEach((hostId) => assert.equal(state.getTunnelRuntimeHostStatus(1, hostId), true));
      const assertProbeSources = () => {
        for (const hostId of [1, 2, 4]) assert.equal(events.hasHostTcpingRequest(hostId), true);
        for (const hostId of [3, 5, 6]) assert.equal(events.hasHostTcpingRequest(hostId), false);
      };
      seedReady();
      const generation = state.getTunnelRuntimeGeneration(1);
      const hopBase = { tunnelId: 1, hopCount: 2, generation: "same-topology" };
      for (const hopIndex of [0, 1]) auto.recordTunnelAutoHopLatency({ ...hopBase, hopIndex, latencyMs: 3, isTimeout: false });
      const entryBase = { tunnelId: 1, expectedEntryHostIds: [1, 4], hopCount: 1, generation: "same-topology" };
      for (const sourceHostId of [1, 4]) multi.recordTunnelMultiEntryLatency({ ...entryBase, sourceHostId, hopIndex: 0, latencyMs: 3, isTimeout: false });
      assert.ok(auto.getTunnelAutoHopDetails(hopBase));
      assert.ok(multi.getTunnelMultiEntryLatency(entryBase));
      const refreshed = await pushTunnelEndpointRefresh(tunnel, "not-a-special-reason", { urgent: true, refreshMode: "probe" });
      assertReady();
      assert.equal(state.getTunnelRuntimeGeneration(1), generation);
      assertProbeSources();
      assert.deepEqual(refreshed.hostPushed.map((item) => item.hostId).sort(), [1, 2, 3, 4, 6]);
      assert.ok(refreshed.hostPushed.every((item) => item.pushed));
      assert.equal(responses.get(5).writes.length, 0);
      assert.equal(auto.getTunnelAutoHopDetails(hopBase), null, "new probes cannot aggregate with old hop results");
      assert.equal(multi.getTunnelMultiEntryLatency(entryBase), null);

      // Exercise the actual tRPC caller, not just the helper option.
      const caller = selfTestRulesRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {} }, res: {} });
      for (const mode of ["forwardx", "tls", "nginx_stream"]) {
        await runtime.executeRaw('UPDATE "tunnels" SET "mode" = ? WHERE "id" = 1', [mode]);
        const result = await caller.startSelfTest({ ruleId: 1 });
        assert.ok(result.id > 0);
        assertReady();
        assertProbeSources();
        assert.equal(state.getTunnelRuntimeGeneration(1), generation);
        const row = (await runtime.queryRaw('SELECT "message" FROM "forward_tests" WHERE "id" = ?', [result.id]))[0];
        assert.equal(JSON.parse(row.message).kind, "forward-via-tunnel");
      }

      // Probe mode preserves actual failures/unknown states; it does not invent readiness.
      state.recordTunnelRuntimeHostStatus(1, 2, false);
      await pushTunnelEndpointRefresh(tunnel, "probe-during-failure", { refreshMode: "probe" });
      assert.equal(state.getTunnelRuntimeHostStatus(1, 2), false);
      state.clearTunnelRuntimeStatus(1);
      const unknownGeneration = state.getTunnelRuntimeGeneration(1);
      await pushTunnelEndpointRefresh(tunnel, "probe-before-recovery", { refreshMode: "probe" });
      assert.equal(state.getTunnelRuntimeHostStatus(1, 1), undefined);
      assert.equal(state.getTunnelRuntimeGeneration(1), unknownGeneration);
      assertProbeSources();

      // forceTcping alone must not turn a configuration refresh into probe-only mode.
      for (const options of [undefined, { urgent: true }, { refreshMode: "runtime", forceTcping: true }, { forceTcping: true }]) {
        seedReady();
        const before = state.getTunnelRuntimeGeneration(1);
        await pushTunnelEndpointRefresh(tunnel, "configuration-changed", options);
        assert.equal(state.getTunnelRuntimeHostStatus(1, 1), undefined);
        assert.equal(state.getTunnelRuntimeHostStatus(1, 2), undefined);
        assert.equal(state.getTunnelRuntimeGeneration(1), before + 1);
      }
      assert.equal(Number((await runtime.queryRaw('SELECT "isRunning" FROM "tunnels" WHERE "id" = 1'))[0].isRunning), 1);
    } finally {
      streams.forEach((stream) => stream.close());
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "refresh.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deferred tcping stays interactive without bypassing tunnel apply readiness", () => {
  const source = fs.readFileSync(path.resolve("server/agentHeartbeatRoute.ts"), "utf8");
  const dispatch = source.slice(source.indexOf("const tcpingRequested = hasHostTcpingRequest"), source.indexOf("const nextInterval = selectAgentHeartbeatInterval", source.indexOf("const tcpingRequested = hasHostTcpingRequest")));
  assert.match(dispatch, /const forceTcping = tcpingRequested && !hasTunnelApplyActions/);
  assert.match(dispatch, /if \(forceTcping\) clearHostTcpingRequest\(host.id\)/);
  assert.match(dispatch, /const hasInteractiveTasks = [\s\S]*\|\| tcpingRequested/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("real tunnel reports refresh gated live samples and incomplete snapshots without fabricated history or overwriting manual tests", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-reporting-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import http from "node:http";
    import express from "express";
    import { pathToFileURL } from "node:url";
    const load = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await load("server/dbRuntime.ts");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    let server;
    try {
      await (await load("server/dbSchema.ts")).ensureDatabaseSchema();
      const db = await load("server/db.ts");
      const state = await load("server/tunnelMultiEntryLatencyState.ts");
      const { tunnelProbeTopologyKey } = await load("server/probeTopology.ts");
      const insert = (table, columns, values) => runtime.executeRaw('INSERT INTO "' + table + '" ('
        + columns.map(c => '"' + c + '"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
      await runtime.insertAndGetId("users", { id: 7, username: "report-admin", password: "unused", role: "admin", accountEnabled: true });
      for (const id of [11,12,20,30,99]) await insert("hosts",
        ["id","name","ip","hostType","agentToken","userId"], [id,"host-"+id,"192.0.2."+id,"slave","probe-token-"+id,7]);
      await insert("forward_groups", ["id","name","groupMode","groupType","targetIp","userId"],
        [1,"entries","entry","host","localhost",7]);
      for (const hostId of [11,12]) await insert("forward_group_members", ["groupId","memberType","hostId"], [1,"host",hostId]);
      await insert("tunnels", ["id","name","entryHostId","exitHostId","entryGroupId","mode","listenPort","userId"],
        [1,"multi",11,30,1,"forwardx",27002,7]);
      for (const [seq,hostId] of [[0,11],[1,20],[2,30]]) await insert("tunnel_hops",
        ["tunnelId","seq","hostId","listenPort"], [1,seq,hostId,27000+seq]);
      const tunnel = await db.getTunnelById(1);
      const hops = await db.getTunnelHops(1);
      const topologyKey = tunnelProbeTopologyKey(tunnel, hops, []);
      const base = { tunnelId: 1, expectedEntryHostIds: [11,12], hopCount: 2,
        generation: topologyKey + ":entries:11,12" };
      const app = express();
      app.use(express.json());
      app.use((req,res,next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
      (await load("server/agentReportRoutes.ts")).registerAgentReportRoutes(app);
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const endpoint = "http://127.0.0.1:" + server.address().port + "/api/agent/tcping";
      const wire = (hostId, latencyMs) => ({ tunnelId: 1, topologyKey, hopCount: 2,
        hopIndex: hostId === 20 ? 1 : 0, targetPort: hostId === 20 ? 27002 : 27001, latencyMs, isTimeout: false });
      const post = async (hostId, report = wire(hostId, 6), force = false) => {
        const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json",
          authorization: "Bearer probe-token-"+hostId }, body: JSON.stringify({ tunnels: [report], force }) });
        assert.equal(res.status, 200, await res.text());
      };
      const diagram = async () => JSON.parse((await db.getTunnelById(1)).lastTestMessage);
      const historySize = async () => Number((await runtime.queryRaw('SELECT COUNT(*) AS n FROM "tunnel_latency_stats"'))[0].n);

      await post(11);
      assert.equal(await historySize(), 0, "missing shared hops are not synthetic timeout samples");
      let details = (await diagram()).details;
      assert.equal(details.find(d => d.fromHostId === 11).latencyMs, 6);
      assert.equal(details.find(d => d.fromHostId === 12).pending, true,
        "even an incomplete aggregate must replace the previous diagram");
      await post(12, wire(12,8));
      assert.equal(await historySize(), 0);
      assert.ok((await diagram()).details.every(d => !d.pending));
      await post(20, wire(20,1));
      assert.equal((await diagram()).totalLatencyMs, 9);
      const rows = await historySize();
      assert.ok(rows > 0);
      // No cumulative metadata: old Agents must refresh live memory too.
      await post(11, wire(11,55));
      assert.equal(state.getTunnelMultiEntryHopDetails(base).find(d => d.fromHostId === 11).latencyMs,55);
      assert.equal(await historySize(), rows, "suppressed samples do not increase history writes");
      await post(99, wire(99,99), true);
      await post(11, { ...wire(11,99), topologyKey: "obsolete" }, true);
      assert.equal(state.getTunnelMultiEntryHopDetails(base).find(d => d.fromHostId === 11).latencyMs,55,
        "live refresh still validates source and topology before accepting data");

      // Clear only memory, leaving the independent report gate intact.
      state.clearTunnelMultiEntryLatencyState(1);
      await post(11, wire(11,6));
      assert.equal(state.getTunnelMultiEntryHopDetails(base).length, 1,
        "a panel state reset is repopulated even when the history gate is closed");
      await post(12, wire(12,8));
      await post(20, wire(20,1), true);
      assert.equal((await diagram()).details.length, 3);
      assert.equal((await diagram()).totalLatencyMs, 9);

      const manual = JSON.stringify({ kind: "tunnel-hop-pending", batchId: "tp-test", details: [{ pending:true }] });
      await runtime.executeRaw('UPDATE "tunnels" SET "lastTestStatus" = ?, "lastTestMessage" = ? WHERE "id" = 1', ["pending",manual]);
      await post(11, wire(11,6), true);
      assert.equal((await db.getTunnelById(1)).lastTestMessage, manual,
        "complete automatic samples cannot overwrite a running manual batch");
      state.clearTunnelMultiEntryLatencyState(1);
      const beforePartial = await historySize();
      await post(11, wire(11,6), true);
      assert.equal((await db.getTunnelById(1)).lastTestMessage, manual,
        "incomplete automatic snapshots use the same atomic manual-batch guard");
      assert.equal(await historySize(), beforePartial);
      await runtime.executeRaw('UPDATE "tunnels" SET "lastTestStatus" = ? WHERE "id" = 1', ["success"]);
      await post(11, wire(11,7), true);
      assert.equal((await diagram()).kind, "tunnel-entry-group-summary");
      assert.equal((await diagram()).details.find(d => d.fromHostId === 11).latencyMs, 7);
      assert.equal(await historySize(), beforePartial);
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "probe.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"), NODE_ENV: "test" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

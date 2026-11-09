import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("host management and public monitoring exclude offline historic speeds without hiding counters", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-live-network-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));
    try {
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await schema.ensureDatabaseSchema();
      const now = Math.floor(Date.now()/1000);
      await runtime.executeRaw('INSERT INTO users (id,username,password,role) VALUES (1,?,?,?)', ["admin","x","admin"]);
      for (const [id,online,heartbeat] of [[1,1,now],[2,0,now],[3,1,now-3600]]) {
        await runtime.executeRaw('INSERT INTO hosts (id,name,ip,userId,isOnline,lastHeartbeat) VALUES (?,?,?,1,?,?)', [id,"host-"+id,"192.0.2."+id,online,heartbeat]);
        await runtime.executeRaw('INSERT INTO host_metrics (hostId,networkIn,networkOut,uptime,recordedAt) VALUES (?,0,0,100,?)', [id,now-3]);
        await runtime.executeRaw('INSERT INTO host_metrics (hostId,networkIn,networkOut,uptime,recordedAt) VALUES (?,?,?,103,?)', [id,id*3000,id*6000,now]);
      }
      const admin = hostsRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
      const summary = await admin.summary();
      assert.equal(summary.totalHosts,3);
      assert.equal(summary.onlineHosts,1);
      assert.equal(summary.currentTrafficIn,1000);
      assert.equal(summary.currentTrafficOut,2000);
      assert.equal(summary.measuredHosts,1);
      const offlineSummary = await admin.summary({search:"host-2"});
      assert.equal(offlineSummary.totalHosts,1);
      assert.equal(offlineSummary.currentTrafficIn,null);
      assert.equal(offlineSummary.currentTrafficOut,null);
      const rows = await admin.latestMetricsSummary({hostIds:[1,2,3]});
      assert.equal(rows.find(row=>row.hostId===1).networkSpeedIn,1000);
      const activeRow = rows.find(row=>row.hostId===1);
      assert.ok(activeRow.networkSampleAgeMs >= 0 && activeRow.networkSampleAgeMs < 5000);
      const { stampHostNetworkMetrics, hostNetworkSpeed } = await import(url("shared/hostNetworkSpeed.ts"));
      const browserNow = Date.now() - 3600000;
      assert.equal(hostNetworkSpeed(stampHostNetworkMetrics([activeRow], browserNow)[0], undefined, {now:browserNow}).in, 1000);
      const rawMetrics = await admin.metrics({hostId:1,limit:2,live:true});
      assert.ok(rawMetrics.every(row => row.networkSampleAgeMs >= 0));
      for (const id of [2,3]) {
        const row = rows.find(row=>row.hostId===id);
        assert.equal(row.networkSpeedIn,null);
        assert.equal(row.networkSpeedOut,null);
        assert.equal(row.networkIn,id*3000);
      }
      await db.setSettings({publicHostMonitorEnabled:"true",publicHostMonitorPath:"network-test"});
      const anonymous = hostsRouter.createCaller({user:null,req:{headers:{}},res:{}});
      const monitor = await anonymous.publicMonitor({path:"network-test"});
      assert.equal(monitor.summary.currentTrafficIn,1000);
      assert.equal(monitor.metrics.find(row=>row.hostId===2).networkSpeedIn,null);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

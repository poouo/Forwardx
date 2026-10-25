import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("port resource display resets are scoped, persistent, transactional and independent of quotas and history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-resource-reset-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const runtime = await import("./server/dbRuntime.ts");
      const database = {type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}};
      await runtime.connectDatabase(database);
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const metrics = await import("./server/repositories/metricsRepository.ts");
      const { forwardGroupsRouter } = await import("./server/routers/forwardGroups.ts");
      const caller = (role,id) => forwardGroupsRouter.createCaller({user:{id,role},req:{headers:{}},res:{}});
      const admin = caller("admin",1), user = caller("user",2);
      const insert = async (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
      const report = async (ruleId,hostId,bytesIn,bytesOut,userId=2) => metrics.insertTrafficStatsBatch([{stat:{ruleId,hostId,bytesIn,bytesOut,connections:1,recordedAt:new Date()},userId}]);
      const summary = async (id,userId) => (await metrics.getForwardGroupTrafficSummaries([id],userId)).get(id);
      const snapshot = async () => {
        const result = {};
        for (const table of ["traffic_stats","traffic_stat_buckets","user_traffic_counters","forward_rule_traffic_counters","users","forward_rules","operations_traffic_daily","traffic_billing_usage","traffic_billing_rule_usage","agent_traffic_reports"]) result[table] = await runtime.queryRaw('SELECT * FROM "'+table+'" ORDER BY "id"');
        return result;
      };
      try {
        for (const id of [1,2,3]) await insert("users",{id,username:"user"+id,password:"unused",name:"User",role:id===1?"admin":"user",accountEnabled:1,trafficLimit:100000,trafficUsed:1234});
        for (const id of [1,2]) await insert("hosts",{id,name:"host"+id,ip:"198.51.100."+id,userId:1,isOnline:1});
        for (const [id,groupMode] of [[10,"port"],[11,"port"],[12,"port"],[20,"entry"]]) await insert("forward_groups",{id,name:"group"+id,groupMode,groupType:"host",targetIp:"127.0.0.1",userId:1,...(id===10?{entryGroupId:20}:{})});
        const rule = {hostId:1,name:"rule",forwardType:"gost",protocol:"tcp",sourcePort:10000,targetIp:"203.0.113.1",targetPort:443,userId:2,isEnabled:1};
        for (const [id,groupId,userId] of [[101,10,2],[102,10,3],[103,11,2]]) await insert("forward_rules",{...rule,id,sourcePort:id+10000,forwardGroupId:groupId,userId});
        await report(101,1,100,200); await report(101,2,10,20); await report(102,1,30,40,3); await report(103,1,900,800);
        assert.equal((await summary(10)).totalBytes,400);
        const before = await snapshot();
        const portPage = await admin.listPage({groupMode:"port",page:1,pageSize:12}); // warm display cache
        assert.equal(portPage.items.find(row=>row.id===10).trafficSummary.totalBytes,400);
        await assert.rejects(user.resetTraffic({id:10}),(error)=>error.code==="FORBIDDEN");
        await assert.rejects(admin.resetTraffic({id:20}),/仅端口转发/);
        await assert.rejects(admin.resetTraffic({id:999}),/不存在/);
        await assert.rejects(admin.resetTraffic({id:-1}));
        await admin.resetTraffic({id:10});
        assert.deepEqual(await snapshot(),before,"reset must not mutate rule counters, quotas, billing, runtime, reports or history");
        for (const owner of [undefined,2,3]) {
          const totals = await summary(10,owner);
          assert.equal(totals.totalBytes,0); assert.equal(totals.daily.totalBytes,0);
        }
        assert.equal((await summary(10)).ruleCount,2);
        assert.equal((await summary(11)).totalBytes,1700);
        assert.equal((await summary(20)).totalBytes,400,"related entry group must keep its own totals");
        assert.equal((await admin.listPage({groupMode:"port",page:1,pageSize:12})).items.find(row=>row.id===10).trafficSummary.totalBytes,0,"reset invalidates display cache");
        await runtime.closeDatabase(); await runtime.connectDatabase(database);
        assert.equal((await summary(10)).totalBytes,0,"offsets survive restart");
        await report(101,1,5,7); await report(101,2,1,2); await report(102,1,3,4,3);
        assert.equal((await summary(10)).totalBytes,22); assert.equal((await summary(10)).daily.totalBytes,22);
        assert.equal((await summary(10,2)).totalBytes,15); assert.equal((await summary(10,3)).totalBytes,7);
        await assert.rejects(runtime.withDatabaseTransaction(async()=>{await metrics.resetPortForwardResourceTraffic(10);throw new Error("rollback-test");}),/rollback-test/);
        assert.equal((await summary(10)).totalBytes,22,"failed reset rolls back previous offsets");
        await admin.resetTraffic({id:10});
        assert.equal((await summary(10)).totalBytes,0,"repeated reset replaces, not adds offsets");
        assert.equal((await runtime.queryRaw('SELECT * FROM resource_traffic_baselines WHERE groupId=10')).length,3);
        // A prior reset day's offset must not subtract from today's daily sum.
        await runtime.executeRaw('UPDATE resource_traffic_baselines SET resetDay=resetDay-86400 WHERE groupId=10');
        assert.equal((await summary(10)).daily.totalBytes,422);
        assert.equal((await summary(10)).totalBytes,0);
        await metrics.resetRuleTrafficStats([101]);
        await report(101,1,4,6);
        assert.equal((await summary(10,2)).totalBytes,10,"rule resets clear stale display offsets too");
        await admin.resetTraffic({id:12});
        assert.equal((await summary(12)).totalBytes,0,"empty resources never expand into all rules");
        await admin.resetTraffic({id:11});
        await runtime.executeRaw('UPDATE forward_rules SET pendingDelete=1,isRunning=0 WHERE id=103');
        await (await import("./server/repositories/forwardRuleRepository.ts")).finalizeForwardRuleDelete(103);
        assert.equal((await runtime.queryRaw('SELECT id FROM resource_traffic_baselines WHERE ruleId=103')).length,0,"rule deletion removes obsolete offsets");
      } finally { await runtime.closeDatabase(); }
    `], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory,"test.db"), FORWARDX_LOG_DIR: path.join(directory,"logs") }, encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

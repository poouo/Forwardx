import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("resource summaries isolate linked rules, empty resources and shared-user usage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-resource-traffic-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const runtime = await import("./server/dbRuntime.ts");
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const metrics = await import("./server/repositories/metricsRepository.ts");
      const { billingStartOfCalendarDay } = await import("./shared/billingTime.ts");
      const expected = (totals) => ({...totals,daily:{bytesIn:totals.bytesIn,bytesOut:totals.bytesOut,totalBytes:totals.totalBytes}});
      const insert = async (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
      try {
        for (const id of [1,2]) await insert("users",{id,username:"user"+id,password:"unused",name:"User"+id,role:id===1?"admin":"user",accountEnabled:1});
        await insert("hosts",{id:1,name:"host",ip:"198.51.100.1",userId:1,isOnline:1});
        for (const [id,groupMode] of [[1,"port"],[2,"entry"],[3,"exit"],[4,"port"]]) {
          await insert("forward_groups",{id,name:"resource"+id,groupMode,groupType:"host",targetIp:"127.0.0.1",userId:1});
        }
        await insert("tunnels",{id:5,name:"tunnel",entryGroupId:2,exitGroupId:3,entryHostId:1,exitHostId:1,listenPort:12000,userId:1});
        const rule = {hostId:1,name:"test",forwardType:"gost",protocol:"tcp",sourcePort:10000,targetIp:"203.0.113.1",targetPort:443,userId:1,isEnabled:0};
        await insert("forward_rules",{...rule,id:10,forwardGroupId:1});
        await insert("forward_rules",{...rule,id:11,sourcePort:10001,tunnelId:5,userId:2});
        await insert("forward_rules",{...rule,id:12,sourcePort:10002}); // unrelated host traffic
        await insert("forward_rules",{...rule,id:13,sourcePort:10003,forwardGroupId:1,pendingDelete:1});
        const report = async (ruleId,bytesIn,bytesOut,userId=1,recordedAt=new Date()) => metrics.insertTrafficStatsBatch([{stat:{ruleId,hostId:1,bytesIn,bytesOut,connections:1,recordedAt},userId}]);
        await report(10,100,200);
        await report(11,30,40,2);
        await report(12,9000,9000);
        await report(13,8000,8000);
        const ids = [1,2,3,4];
        const totals = await metrics.getForwardGroupTrafficSummaries(ids);
        assert.deepEqual(totals.get(1),expected({bytesIn:100,bytesOut:200,totalBytes:300,ruleCount:1}));
        for (const id of [2,3]) assert.deepEqual(totals.get(id),expected({bytesIn:30,bytesOut:40,totalBytes:70,ruleCount:1}));
        assert.deepEqual(totals.get(4),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}));
        assert.equal((await metrics.getForwardGroupTrafficSummaries(ids,2)).get(1).totalBytes,0);
        assert.equal((await metrics.getForwardGroupTrafficSummaries(ids,1)).get(2).totalBytes,0);
        assert.equal((await metrics.getForwardGroupTrafficSummaries([1,1,-1,NaN])).size,1);
        // Pagination attaches totals *after* resource ACL filtering. Permission
        // to use an administrator's resource must not reveal their traffic.
        await (await import("./server/repositories/permissionRepository.ts")).setUserForwardGroupPermissions(2,[1,2]);
        const { forwardGroupsRouter } = await import("./server/routers/forwardGroups.ts");
        const caller = forwardGroupsRouter.createCaller({user:{id:2,role:"user"},req:{headers:{}},res:{}});
        const page = await caller.listPage({page:1,pageSize:12,groupMode:"port"});
        assert.equal(page.items.length,1);
        assert.equal(page.items[0].id,1);
        assert.equal(page.items[0].trafficSummary.totalBytes,0);
        assert.equal(page.items[0].trafficSummary.daily.totalBytes,0);
        const entryPage = await caller.listPage({page:1,pageSize:12,groupMode:"entry"});
        assert.equal(entryPage.items[0].trafficSummary.totalBytes,70);
        assert.equal(entryPage.items[0].trafficSummary.daily.totalBytes,70);
        assert.equal(entryPage.items[0].trafficSummary.ruleCount,1);
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([5])).get(5),expected({bytesIn:30,bytesOut:40,totalBytes:70,ruleCount:1}));
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([5],1)).get(5),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}));
        assert.equal((await metrics.getTunnelTrafficSummaries([])).size,0);
        assert.equal((await metrics.getTunnelTrafficSummaries([5,5,-1,NaN])).size,1);
        // A tunnel used through a failover template counts that logical rule
        // once, and only includes its own children rather than other tunnels.
        for (const id of [2,3]) await insert("hosts",{id,name:"host"+id,ip:"198.51.100."+id,userId:1,isOnline:1});
        for (const [id,groupMode] of [[7,"failover"],[8,"entry"],[9,"exit"],[10,"chain"]]) {
          await insert("forward_groups",{id,name:"resource"+id,groupMode,groupType:"host",targetIp:"127.0.0.1",userId:1,...(id===10?{entryGroupId:2}:{})});
        }
        await insert("tunnels",{id:6,name:"other tunnel",entryGroupId:8,exitGroupId:9,entryHostId:3,exitHostId:3,listenPort:12001,userId:1});
        await insert("tunnels",{id:7,name:"unused tunnel",entryHostId:1,exitHostId:1,listenPort:12002,userId:1});
        for (const [id,tunnelId] of [[701,5],[702,6]]) await insert("forward_group_members",{id,groupId:7,memberType:"tunnel",tunnelId});
        await insert("forward_rules",{...rule,id:20,sourcePort:10100,userId:2,forwardGroupId:7,isForwardGroupTemplate:1});
        for (const [id,hostId,tunnelId,memberId] of [[21,1,5,701],[22,2,5,701],[23,3,6,702]]) {
          await insert("forward_rules",{...rule,id,sourcePort:10100,hostId,tunnelId,forwardGroupId:7,forwardGroupRuleId:20,forwardGroupMemberId:memberId,userId:id===21?1:2});
        }
        await report(21,10,20,2);
        await report(22,3,7,2);
        await report(23,100,200,2);
        await insert("forward_rules",{...rule,id:24,tunnelId:5,forwardGroupId:7,forwardGroupRuleId:20,pendingDelete:1});
        await insert("forward_rules",{...rule,id:26,forwardGroupId:7,isForwardGroupTemplate:1,pendingDelete:1});
        await insert("forward_rules",{...rule,id:25,tunnelId:5,forwardGroupId:7,forwardGroupRuleId:26});
        await insert("forward_rules",{...rule,id:27,tunnelId:5,forwardGroupId:7,forwardGroupRuleId:10});
        for (const id of [24,25,27]) await report(id,9000,9000);
        await insert("forward_rules",{...rule,id:30,userId:2,forwardGroupId:10,isForwardGroupTemplate:1});
        await report(30,5,5,2);
        const tunnelTotals = await metrics.getTunnelTrafficSummaries([5,6,7]);
        assert.deepEqual(tunnelTotals.get(5),expected({bytesIn:43,bytesOut:67,totalBytes:110,ruleCount:2}));
        assert.deepEqual(tunnelTotals.get(6),expected({bytesIn:100,bytesOut:200,totalBytes:300,ruleCount:1}));
        assert.deepEqual(tunnelTotals.get(7),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}));
        const indirectGroups = await metrics.getForwardGroupTrafficSummaries([2,3,7,8,9,10],2);
        assert.equal(indirectGroups.get(2).ruleCount,3);
        assert.equal(indirectGroups.get(2).totalBytes,120);
        assert.equal(indirectGroups.get(3).ruleCount,2);
        assert.equal(indirectGroups.get(3).totalBytes,110);
        for (const id of [8,9]) {
          assert.equal(indirectGroups.get(id).ruleCount,1);
          assert.equal(indirectGroups.get(id).totalBytes,300);
        }
        assert.equal(indirectGroups.get(7).ruleCount,1);
        assert.equal(indirectGroups.get(7).totalBytes,340);
        assert.equal(indirectGroups.get(7).daily.totalBytes,340);
        assert.equal(indirectGroups.get(2).daily.totalBytes,120);
        assert.equal(indirectGroups.get(10).ruleCount,1);
        // Shared tunnel endpoints attach only the caller's usage, not admin data.
        await insert("forward_rules",{...rule,id:40,tunnelId:5});
        await report(40,1000,2000);
        await (await import("./server/repositories/permissionRepository.ts")).setUserTunnelPermissions(2,[5]);
        const { tunnelsRouter } = await import("./server/routers/tunnels.ts");
        const tunnelCaller = tunnelsRouter.createCaller({user:{id:2,role:"user"},req:{headers:{}},res:{}});
        const sharedTunnels = await tunnelCaller.listPage({page:1,pageSize:12});
        assert.equal(sharedTunnels.items.length,1);
        assert.deepEqual(sharedTunnels.items[0].trafficSummary,expected({bytesIn:43,bytesOut:67,totalBytes:110,ruleCount:2}));
        const adminCaller = tunnelsRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
        const adminTunnels = await adminCaller.listPage({page:1,pageSize:12});
        assert.deepEqual(adminTunnels.items.find(t=>t.id===5).trafficSummary,expected({bytesIn:1043,bytesOut:2067,totalBytes:3110,ruleCount:3}));
        await runtime.executeRaw('UPDATE "forward_rules" SET "pendingDelete" = 1 WHERE "id" = 11');
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([5],2)).get(5),expected({bytesIn:13,bytesOut:27,totalBytes:40,ruleCount:1}));
        await metrics.resetRuleTrafficStats([20]);
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([5],2)).get(5),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:1}));
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([6],2)).get(6),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:1}));
        // Saved references are counted even before a disabled rule has any
        // runtime children. Stale children of a removed member are ignored.
        await insert("forward_groups",{id:12,name:"unapplied tunnel group",groupMode:"failover",groupType:"tunnel",targetIp:"127.0.0.1",userId:1});
        await insert("forward_group_members",{id:1201,groupId:12,memberType:"tunnel",tunnelId:7,isEnabled:0});
        await insert("forward_rules",{...rule,id:50,userId:2,forwardGroupId:12,isForwardGroupTemplate:1});
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([7],2)).get(7),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:1}));
        await runtime.executeRaw('DELETE FROM "forward_group_members" WHERE "id" = 701');
        assert.deepEqual((await metrics.getTunnelTrafficSummaries([5],2)).get(5),expected({bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}));
        assert.equal((await metrics.getForwardGroupTrafficSummaries([2],2)).get(2).ruleCount,1);
        // More than one bounded batch, including many rules with no reports.
        for (let id=100;id<305;id++) await insert("forward_rules",{...rule,id,sourcePort:20000+id,forwardGroupId:4});
        await report(100,1,2);
        await report(304,3,4);
        assert.deepEqual((await metrics.getForwardGroupTrafficSummaries([4])).get(4),expected({bytesIn:4,bytesOut:6,totalBytes:10,ruleCount:205}));
        // A natural-day boundary, not a rolling 24 hours: the immediately
        // preceding sample affects cumulative totals but never today's usage.
        const midnight = billingStartOfCalendarDay(new Date());
        await report(100,100,200,1,new Date(midnight.getTime()-1000));
        await report(100,10,20,1,midnight);
        const dated = (await metrics.getForwardGroupTrafficSummaries([4])).get(4);
        assert.equal(dated.totalBytes,340);
        assert.deepEqual(dated.daily,{bytesIn:14,bytesOut:26,totalBytes:40});
        // Bucket-only data must survive raw-history cleanup as well.
        await metrics.ensureTrafficStatBucketsBackfilled();
        await runtime.executeRaw('DELETE FROM "traffic_stats" WHERE "ruleId" IN (100,304)');
        assert.deepEqual((await metrics.getForwardGroupTrafficSummaries([4])).get(4),dated);
        await metrics.resetRuleTrafficStats([100,304]);
        assert.deepEqual((await metrics.getForwardGroupTrafficSummaries([4])).get(4).daily,{bytesIn:0,bytesOut:0,totalBytes:0});
      } finally { await runtime.closeDatabase(); }
    `], {cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60_000,windowsHide:true});
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

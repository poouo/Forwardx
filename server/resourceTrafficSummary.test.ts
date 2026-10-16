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
        const report = async (ruleId,bytesIn,bytesOut,userId=1) => metrics.insertTrafficStatsBatch([{stat:{ruleId,hostId:1,bytesIn,bytesOut,connections:1,recordedAt:new Date()},userId}]);
        await report(10,100,200);
        await report(11,30,40,2);
        await report(12,9000,9000);
        await report(13,8000,8000);
        const ids = [1,2,3,4];
        const totals = await metrics.getForwardGroupTrafficSummaries(ids);
        assert.deepEqual(totals.get(1),{bytesIn:100,bytesOut:200,totalBytes:300,ruleCount:1});
        for (const id of [2,3]) assert.deepEqual(totals.get(id),{bytesIn:30,bytesOut:40,totalBytes:70,ruleCount:1});
        assert.deepEqual(totals.get(4),{bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0});
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
        const entryPage = await caller.listPage({page:1,pageSize:12,groupMode:"entry"});
        assert.equal(entryPage.items[0].trafficSummary.totalBytes,70);
        // More than one bounded batch, including many rules with no reports.
        for (let id=100;id<305;id++) await insert("forward_rules",{...rule,id,sourcePort:20000+id,forwardGroupId:4});
        await report(100,1,2);
        await report(304,3,4);
        assert.deepEqual((await metrics.getForwardGroupTrafficSummaries([4])).get(4),{bytesIn:4,bytesOut:6,totalBytes:10,ruleCount:205});
      } finally { await runtime.closeDatabase(); }
    `], {cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60_000,windowsHide:true});
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

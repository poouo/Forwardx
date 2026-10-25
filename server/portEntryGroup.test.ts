import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("direct port resources fan out to an entry group and preserve unrelated listeners", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-port-entry-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const runtime = await import("./server/dbRuntime.ts");
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const groups = await import("./server/repositories/forwardGroupRepository.ts");
      const service = await import("./server/services/forwardGroupService.ts");
      const metrics = await import("./server/repositories/metricsRepository.ts");
      const ruleRepository = await import("./server/repositories/forwardRuleRepository.ts");
      const { rulesRouter } = await import("./server/routers/rules.ts");
      const admin = rulesRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
      const insert = async (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
      const base = {name:"entries",groupMode:"entry",groupType:"host",domain:"entries.example.test",recordType:"A",ddnsAutoResolveEnabled:false,forwardType:"gost",protocol:"both",isEnabled:true,autoFailback:true,failoverSeconds:60,recoverSeconds:120};
      const member = id => ({memberType:"host",hostId:id,isEnabled:true});
      const children = id => runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupRuleId"=? AND "pendingDelete"=0 ORDER BY "id"',[id]);
      try {
        await insert("users",{id:1,username:"admin",password:"unused",name:"Admin",role:"admin",accountEnabled:1,canAddRules:1,manualCanAddRules:1,maxRules:100,maxPorts:100});
        for (const id of [1,2,3,4]) await insert("hosts",{id,name:"host-"+id,ip:"198.51.100."+id,ipv4:"198.51.100."+id,entryIp:"198.51.100."+id,userId:1,isOnline:1,lastHeartbeat:Math.floor(Date.now()/1000),portRangeStart:10000,portRangeEnd:id===2?10010:10020});
        const entryId = await service.createForwardGroupFromInput({...base,members:[member(1),member(2)]},1);
        const portInput = {...base,name:"direct",groupMode:"port",entryGroupId:entryId,members:[],domain:null};
        const portId = await service.createForwardGroupFromInput(portInput,1);
        assert.equal((await groups.getForwardGroupById(portId)).members.length,2);
        await assert.rejects(groups.validateForwardGroupRuleConfig(portId,{sourcePort:10015,protocol:"tcp"}),/入口端口|port/i);
        assert.deepEqual(await groups.getForwardGroupRuleEntryHostIds(portId),[1,2]);
        await insert("forward_rules",{id:100,hostId:1,name:"test",forwardType:"gost",protocol:"tcp",forwardGroupId:portId,isForwardGroupTemplate:1,sourcePort:10000,targetIp:"203.0.113.10",targetPort:443,userId:1,isEnabled:1});
        await groups.syncForwardGroupRules(portId);
        let rules = await children(100);
        assert.equal(rules.length,2);
        assert.ok(rules.every(r=>r.forwardType==="gost" && !r.tunnelId && r.sourcePort===10000 && r.targetIp==="203.0.113.10"));
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=1 WHERE "forwardGroupRuleId"=100');
        let runtimeResource = (await groups.getForwardGroups(undefined,{includeRuntime:true,ids:[portId]}))[0];
        assert.equal(runtimeResource.entryRuntime.runningHostCount,2);
        assert.equal(runtimeResource.entryRuntime.expectedHostCount,2);
        const initialIds = (await children(100)).map(r=>Number(r.id));
        await insert("forward_rules",{id:200,hostId:1,name:"second",forwardType:"gost",protocol:"tcp",forwardGroupId:portId,isForwardGroupTemplate:1,sourcePort:10001,targetIp:"203.0.113.10",targetPort:443,userId:1,isEnabled:1});
        await groups.syncForwardGroupRules(portId);
        assert.ok((await children(100)).every(r=>r.isRunning));
        assert.deepEqual((await children(100)).map(r=>Number(r.id)),initialIds);
        // Changing an entry collection automatically materializes new resource members.
        await service.updateForwardGroupFromInput(entryId,{...base,members:[member(1),member(2),member(3)]});
        rules = await children(100);
        assert.equal(rules.length,3);
        assert.ok(rules.filter(r=>r.hostId!==3).every(r=>r.isRunning));
        // One newly added host has a conflicting port. Other hosts remain healthy.
        await insert("forward_rules",{id:300,hostId:4,name:"occupied",forwardType:"realm",protocol:"tcp",sourcePort:10000,targetIp:"203.0.113.20",targetPort:443,userId:1,isEnabled:1});
        await service.updateForwardGroupFromInput(entryId,{...base,members:[member(1),member(2),member(3),member(4)]});
        assert.equal((await children(100)).length,3);
        assert.match((await groups.getForwardGroupById(portId)).lastMessage,/host=4/);
        let failedMember = (await groups.getForwardGroupById(portId)).members.find(m=>m.hostId===4);
        assert.equal(JSON.parse(failedMember.syncDiagnostic).attempts,1);
        assert.equal(JSON.parse(failedMember.syncDiagnostic).failedRuleCount,1);
        await runtime.executeRaw('DELETE FROM "forward_rules" WHERE "id"=300');
        await groups.reconcilePortEntryGroups();
        assert.equal((await children(100)).length,3,"background retry must honor its earliest retry time");
        const expired = JSON.parse(failedMember.syncDiagnostic);
        expired.nextRetryAt=0;
        await runtime.executeRaw('UPDATE "forward_group_members" SET "syncDiagnostic"=? WHERE "id"=?',[JSON.stringify(expired),failedMember.id]);
        await groups.reconcilePortEntryGroups();
        assert.equal((await children(100)).length,4);
        assert.equal((await groups.getForwardGroupById(portId)).lastMessage,null);
        assert.equal((await groups.getForwardGroupById(portId)).members.find(m=>m.hostId===4).syncDiagnostic,null);
        const apiInput = {forwardGroupId:portId,name:"api rule",forwardType:"gost",protocol:"tcp",sourcePort:10002,targetIp:"203.0.113.40",targetPort:443};
        await assert.rejects(admin.create({...apiInput,targetIp:"198.51.100.2",targetPort:10002}),/转发死循环/);
        const apiRule = await admin.create(apiInput);
        assert.equal((await children(apiRule.id)).length,4);
        await assert.rejects(admin.update({id:apiRule.id,targetIp:"198.51.100.2",targetPort:10002}),/转发死循环/);
        await admin.update({id:apiRule.id,targetPort:8443});
        assert.ok((await children(apiRule.id)).every(r=>r.targetPort===8443));
        await assert.rejects(groups.deleteForwardGroup(entryId),/仍被端口转发引用/);
        // Each entry is an independent data path; count each report exactly once.
        for (const rule of await children(100)) {
          await metrics.insertTrafficStatsBatch([{stat:{ruleId:Number(rule.id),hostId:Number(rule.hostId),bytesIn:100,bytesOut:200,connections:1,recordedAt:new Date()},userId:1}]);
        }
        const traffic = async () => (await metrics.getTrafficCounterSummaryByRule({ruleIds:[100],userId:1})).reduce((sum,row)=>sum+row.bytesIn+row.bytesOut,0);
        assert.equal(await traffic(),1200);
        // Resource totals count each logical rule once, not parent + children,
        // and shared-resource users never see other users' counters.
        await insert("users",{id:2,username:"other",password:"unused",name:"Other",role:"user",accountEnabled:1});
        await insert("forward_rules",{id:9000,hostId:1,name:"other user",forwardType:"gost",protocol:"tcp",forwardGroupId:portId,isForwardGroupTemplate:1,sourcePort:10009,targetIp:"203.0.113.10",targetPort:443,userId:2,isEnabled:1});
        await groups.syncForwardGroupRules(portId);
        for (const rule of await children(9000)) {
          await metrics.insertTrafficStatsBatch([{stat:{ruleId:Number(rule.id),hostId:Number(rule.hostId),bytesIn:25,bytesOut:50,connections:1,recordedAt:new Date()},userId:2}]);
        }
        const resourceTraffic = async (userId) => metrics.getForwardGroupTrafficSummaries([portId,entryId],userId);
        for (const id of [portId,entryId]) {
          assert.deepEqual((await resourceTraffic()).get(id),{bytesIn:500,bytesOut:1000,totalBytes:1500,ruleCount:4,daily:{bytesIn:500,bytesOut:1000,totalBytes:1500}});
          assert.equal((await resourceTraffic(1)).get(id).totalBytes,1200);
          assert.equal((await resourceTraffic(2)).get(id).totalBytes,300);
        }
        assert.equal((await metrics.getForwardGroupTrafficSummaries([])).size,0);
        const { forwardGroupsRouter } = await import("./server/routers/forwardGroups.ts");
        const groupAdmin = forwardGroupsRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
        const resourcePage = await groupAdmin.listPage({page:1,pageSize:12,groupMode:"port"});
        assert.equal(resourcePage.items.find(g=>g.id===portId).trafficSummary.totalBytes,1500);
        await service.updateForwardGroupFromInput(entryId,{...base,members:[member(1),member(3)]});
        assert.deepEqual((await children(100)).map(r=>Number(r.hostId)).sort(),[1,3]);
        assert.equal(await traffic(),1200,"removing an entry must not erase historical logical-rule usage");
        const removed = await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "forwardGroupRuleId"=100 AND "pendingDelete"=1');
        for (const rule of removed) {
          await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=0 WHERE "id"=?',[rule.id]);
          await ruleRepository.finalizeForwardRuleDelete(Number(rule.id));
        }
        await ruleRepository.purgeSettledPendingForwardRuleDeletes();
        assert.equal(await traffic(),1200,"Agent cleanup must retain the accounting links");
        assert.equal((await resourceTraffic()).get(portId).totalBytes,1500,"resource totals must retain removed-entry usage too");
        await groups.setForwardGroupEnabled(entryId,false);
        assert.ok((await children(100)).every(r=>!r.isEnabled));
        await groups.setForwardGroupEnabled(entryId,true);
        assert.ok((await children(100)).every(r=>r.isEnabled));
        await service.updateForwardGroupFromInput(entryId,{...base,members:[member(1),{...member(3),isEnabled:false}]});
        assert.equal((await children(100)).find(r=>r.hostId===3).isEnabled,0);
        assert.equal((await children(100)).find(r=>r.hostId===1).isEnabled,1);
        await service.updateForwardGroupFromInput(entryId,{...base,members:[member(1),member(3)]});
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=1 WHERE "forwardGroupRuleId"=200 AND "pendingDelete"=0');
        await runtime.executeRaw('UPDATE "forward_rules" SET "targetPort"=8443,"protocol"=\'both\' WHERE "id"=100');
        await groups.syncForwardGroupRules(portId);
        assert.ok((await children(100)).every(r=>r.targetPort===8443 && r.protocol==="both"));
        assert.ok((await children(200)).every(r=>r.isRunning),"editing one rule must preserve other running rules");
        await metrics.resetRuleTrafficStats([100]);
        assert.equal(await traffic(),0);
        assert.equal((await resourceTraffic()).get(portId).totalBytes,300,"logical reset also updates resource totals");
        await groupAdmin.resetTraffic({id:portId});
        assert.equal((await resourceTraffic()).get(portId).totalBytes,0,"display reset includes every entry without clearing logical rule usage");
        assert.equal((await resourceTraffic()).get(entryId).totalBytes,300,"entry-group totals are independent of the port resource reset");
        const activeOtherChildren = await children(9000);
        for (const rule of activeOtherChildren) await metrics.insertTrafficStatsBatch([{stat:{ruleId:Number(rule.id),hostId:Number(rule.hostId),bytesIn:1,bytesOut:2,connections:1,recordedAt:new Date()},userId:2}]);
        assert.equal((await resourceTraffic()).get(portId).totalBytes,activeOtherChildren.length*3,"new entry traffic starts accumulating immediately");
        assert.equal((await metrics.getTrafficCounterSummaryByRule({ruleIds:[9000],userId:2})).reduce((sum,row)=>sum+row.bytesIn+row.bytesOut,0),300+activeOtherChildren.length*3);
        await assert.rejects(service.createForwardGroupFromInput(portInput,2),/无权/);
        await assert.rejects(service.createForwardGroupFromInput({...portInput,entryGroupId:null,members:[member(1),member(2)]},1),/1 台/);
        await groups.deleteForwardGroup(portId);
        assert.equal((await runtime.queryRaw('SELECT id FROM resource_traffic_baselines WHERE groupId=?',[portId])).length,0,"resource deletion cleans its display offsets");
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=0 WHERE "pendingDelete"=1');
        await ruleRepository.purgeSettledPendingForwardRuleDeletes();
        assert.equal((await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "forwardGroupRuleId"=100')).length,0,"archived links are released with the logical rule");
      } finally { await runtime.closeDatabase(); }
    `], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory,"test.db"), FORWARDX_LOG_DIR: path.join(directory,"logs") }, encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

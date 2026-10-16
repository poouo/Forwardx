import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("managed entry diagnostics accept only current authorized reports and preflight validates saves", () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"forwardx-entry-diagnostics-"));
  try {
    const result=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",String.raw`
      import assert from "node:assert/strict";
      import express from "express";
      const runtime=await import("./server/dbRuntime.ts");
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const groups=await import("./server/repositories/forwardGroupRepository.ts");
      const service=await import("./server/services/forwardGroupService.ts");
      const {updateAgentToolInventory}=await import("./server/agentToolInventory.ts");
      const insert=async(table,data)=>runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
      let server;
      try {
        await insert("users",{id:1,username:"admin",password:"unused",role:"admin",accountEnabled:1});
        for(const id of [1,2]) await insert("hosts",{id,name:"host"+id,ip:"198.51.100."+id,userId:1,isOnline:1,lastHeartbeat:Math.floor(Date.now()/1000),agentToken:"test-token-"+id,portRangeStart:10000,portRangeEnd:10020});
        await insert("forward_groups",{id:1,name:"entries",groupMode:"entry",groupType:"host",domain:"entry.test",targetIp:"0.0.0.0",userId:1});
        await insert("forward_group_members",{groupId:1,memberType:"host",hostId:1,isEnabled:1});
        const input={name:"port",groupMode:"port",groupType:"host",entryGroupId:1,forwardType:"gost",protocol:"tcp",isEnabled:true,autoFailback:true,failoverSeconds:60,recoverSeconds:120,members:[]};
        updateAgentToolInventory(1,{gost:false},Date.now());
        await assert.rejects(service.createForwardGroupFromInput(input,1),/缺少转发工具/);
        updateAgentToolInventory(1,{gost:true},Date.now());
        const portId=await service.createForwardGroupFromInput(input,1);
        await insert("forward_rules",{id:100,name:"logical",hostId:1,sourcePort:10000,targetIp:"203.0.113.1",targetPort:443,forwardType:"gost",protocol:"tcp",forwardGroupId:portId,isForwardGroupTemplate:1,userId:1});
        await groups.syncForwardGroupRules(portId);
        const child=(await runtime.queryRaw('SELECT "id" FROM "forward_rules" WHERE "forwardGroupRuleId"=100'))[0];
        const app=express(); app.use(express.json());
        // Test-only trusted-token adapter; production uses encrypted auth middleware.
        app.use((req,res,next)=>{req.agentToken="test-token-"+String(req.headers["x-test-host"] || 1);next();});
        (await import("./server/agentStatusRoutes.ts")).registerAgentStatusRoutes(app);
        server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});
        const base="http://127.0.0.1:"+server.address().port;
        const report=async(payload,host=1)=>{
          const response=await fetch(base+"/api/agent/rule-status",{method:"POST",headers:{"content-type":"application/json","x-test-host":String(host)},body:JSON.stringify({ruleId:Number(child.id),sourcePort:10000,targetPort:443,protocol:"tcp",forwardType:"gost",...payload})});
          return {status:response.status,body:await response.json()};
        };
        const epoch=Date.now();
        assert.equal((await report({isRunning:false,message:"bind failed",issuedAt:epoch,consecutiveFailures:3,retryNotBefore:epoch+30000},2)).status,403);
        assert.equal((await report({isRunning:false,message:"bind failed",issuedAt:epoch,consecutiveFailures:3,retryNotBefore:epoch+30000})).status,200);
        // The existing rate-limited status line includes bounded retry context.
        const logger=await import("./server/_core/panelLogger.ts");
        const failureLogs=await logger.getPanelLogs();
        assert.ok(failureLogs.some(row=>row.message.includes("consecutiveFailures=3") && row.message.includes("retryNotBefore=")));
        await report({isRunning:false,message:"bind failed",issuedAt:epoch,consecutiveFailures:4,retryNotBefore:epoch+30000});
        assert.equal((await logger.getPanelLogs()).filter(row=>row.message.startsWith("[Rule] status rule=")).length,1,"repeat failure must not add one line per heartbeat");
        let resource=(await groups.getForwardGroups(undefined,{includeRuntime:true,ids:[portId]}))[0];
        assert.equal(resource.entryRuntime.nodes[0].runtimeErrors[0].message,"bind failed");
        assert.equal(resource.entryRuntime.nodes[0].runtimeErrors[0].consecutiveFailures,4);
        assert.equal((await report({isRunning:true,issuedAt:epoch+1})).status,200);
        assert.ok((await logger.getPanelLogs()).some(row=>row.message.includes("transition=recovered-or-started")));
        assert.equal((await report({isRunning:false,issuedAt:epoch,message:"old failure"})).body.stale,true);
        resource=(await groups.getForwardGroups(undefined,{includeRuntime:true,ids:[portId]}))[0];
        assert.equal(resource.entryRuntime.runningHostCount,1);
        assert.equal(resource.entryRuntime.nodes[0].runtimeErrors.length,0);
        updateAgentToolInventory(1,{gost:false},Date.now()+2);
        await assert.rejects(groups.validateForwardGroupRuleConfig(portId,{sourcePort:10001,protocol:"tcp"}),/缺少转发工具/);
        assert.equal((await runtime.queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id"=?',[child.id]))[0].isRunning,1,"failed preflight must preserve existing runtime");
        const filtered=groups.filterForwardGroupFieldsForUse([resource]);
        assert.equal(filtered[0].entryRuntime,undefined,"shared use projections must not reveal other users' node errors");
      } finally {if(server) await new Promise(resolve=>server.close(resolve));await runtime.closeDatabase();}
    `],{cwd:process.cwd(),env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:60_000,windowsHide:true});
    assert.equal(result.status,0,result.stderr || result.stdout);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

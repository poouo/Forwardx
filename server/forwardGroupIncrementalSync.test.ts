import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("failover template mutations preserve unrelated children and bounded pending health", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-failover-incremental-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      import { mock } from "node:test";
      import http from "node:http";
      const runtime = await import("./server/dbRuntime.ts");
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const groups = await import("./server/repositories/forwardGroupRepository.ts");
      const { rulesRouter } = await import("./server/routers/rules.ts");
      const admin = rulesRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
      const insert = (table, data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
      const children = () => runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "forwardGroupId"=10 AND "forwardGroupRuleId" IS NOT NULL AND "pendingDelete"=0 ORDER BY "id"');
      const members = () => runtime.queryRaw('SELECT * FROM "forward_group_members" WHERE "groupId"=10 ORDER BY "id"');
      let time = Date.now();
      mock.timers.enable({apis:["Date"],now:time});
      const dnsRequests = [];
      const webhook = http.createServer((req,res)=>{
        let body="";
        req.on("data",chunk=>{body+=chunk;});
        req.on("end",()=>{dnsRequests.push(JSON.parse(body));res.writeHead(204);res.end();});
      });
      do {
        await new Promise(resolve=>webhook.listen(0,"127.0.0.1",resolve));
        if (webhook.address().port > 10080) break;
        await new Promise(resolve=>webhook.close(resolve));
      } while(true);
      const now = () => Math.floor(time / 1000);
      const acknowledge = async () => {
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=1, "runtimeDiagnostic"=NULL WHERE "forwardGroupRuleId" IS NOT NULL');
        for (const rule of await children()) await insert("tcping_stats",{ruleId:rule.id,hostId:rule.hostId,latencyMs:10,isTimeout:0,healthStatus:"healthy",recordedAt:now()});
      };
      try {
        await insert("users",{id:1,username:"admin",password:"unused",role:"admin",accountEnabled:1,canAddRules:1});
        await (await import("./server/repositories/settingsRepository.ts")).setSettings({ddnsEnabled:"true",ddnsProvider:"webhook",ddnsWebhookMethod:"POST",ddnsWebhookUrl:"http://127.0.0.1:"+webhook.address().port+"/ddns"});
        await insert("forward_groups",{id:10,name:"failover",domain:"failover.test",groupMode:"failover",groupType:"host",forwardType:"realm",protocol:"tcp",targetIp:"0.0.0.0",userId:1,isEnabled:1,failoverSeconds:1});
        for (let id=1;id<=6;id++) {
          await insert("hosts",{id,name:"host-"+id,ip:"198.51.100."+id,userId:1,isOnline:1,lastHeartbeat:now(),agentToken:"issue25-token-"+id,agentVersion:"2.2.214"});
          await insert("forward_group_members",{id:100+id,groupId:10,memberType:"host",hostId:id,priority:id,isEnabled:1});
        }
        const input = {forwardGroupId:10,name:"template",forwardType:"realm",protocol:"tcp",targetIp:"203.0.113.10",targetPort:443};
        for (let i=0;i<12;i++) await insert("forward_rules",{id:1000+i,hostId:1,...input,sourcePort:16000+i,isForwardGroupTemplate:1,userId:1,isEnabled:1});
        await groups.syncForwardGroupRules(10,{preserveRuntime:true});
        await acknowledge();
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        assert.ok((await members()).every(m=>m.healthStatus==="healthy"));
        assert.equal((await groups.getForwardGroupById(10)).activeMemberId,101);
        const dnsCount = dnsRequests.length;
        // Observe real writes, including identical-value updates and ACK races.
        await runtime.executeRaw('CREATE TABLE rule_writes (ruleId INTEGER)');
        await runtime.executeRaw('CREATE TRIGGER track_rule_writes AFTER UPDATE ON forward_rules BEGIN INSERT INTO rule_writes VALUES (NEW.id); END');
        const clearWrites = () => runtime.executeRaw('DELETE FROM rule_writes');
        const writtenChildren = async () => (await runtime.queryRaw('SELECT DISTINCT w.ruleId FROM rule_writes w JOIN forward_rules r ON r.id=w.ruleId WHERE r.forwardGroupRuleId IS NOT NULL')).map(r=>Number(r.ruleId));
        const assertOnlyTemplateWritten = async id => {
          const allowed = new Set((await children()).filter(r=>r.forwardGroupRuleId===id).map(r=>r.id));
          assert.ok((await writtenChildren()).every(id=>allowed.has(id)),"only the edited template's children may be rewritten");
          assert.ok((await children()).filter(r=>r.forwardGroupRuleId!==id && r.isEnabled).every(r=>r.isRunning),"unrelated listeners remain running");
        };
        await clearWrites();
        const created = await admin.create({...input,sourcePort:16100});
        await assertOnlyTemplateWritten(created.id);
        assert.ok((await members()).every(m=>m.healthStatus!=="unhealthy" && !m.failureSince),"first ACK is pending, not a member failure");
        assert.equal(dnsRequests.length,dnsCount,"adding a template must not switch or rewrite DNS");
        const newChildren = (await children()).filter(r=>r.forwardGroupRuleId===created.id);
        assert.equal(newChildren.length,6);
        await runtime.executeRaw("CREATE TRIGGER fail_partial_sync BEFORE INSERT ON forward_rules WHEN NEW.sourcePort=16101 AND NEW.hostId=6 AND NEW.forwardGroupRuleId IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected child failure'); END");
        await assert.rejects(admin.create({...input,sourcePort:16101}),/injected child failure/);
        assert.deepEqual(await runtime.queryRaw('SELECT id FROM forward_rules WHERE sourcePort=16101'),[],"failed fan-out must roll back both template and already-created children");
        await runtime.executeRaw('DROP TRIGGER fail_partial_sync');
        await clearWrites();
        const sqlite = runtime.getSqlite();
        const prepare = sqlite.prepare;
        const queries = [];
        sqlite.prepare = function(sql) { queries.push(sql); return prepare.call(this,sql); };
        await groups.runForwardGroupFailover(10);
        sqlite.prepare = prepare;
        assert.ok(queries.length < 100,"unchanged 78-child sweep must use bounded batched queries: "+queries.length);
        await groups.runForwardGroupFailover(10);
        assert.deepEqual(await writtenChildren(),[],"maintenance must not repeatedly rewrite awaiting-ACK children");
        await acknowledge();
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        await clearWrites();
        await admin.update({id:created.id,targetPort:8443});
        await assertOnlyTemplateWritten(created.id);
        assert.ok((await children()).filter(r=>r.forwardGroupRuleId===created.id).every(r=>r.targetPort===8443 && !r.isRunning));
        await clearWrites();
        await admin.toggle({id:created.id,isEnabled:false});
        await assertOnlyTemplateWritten(created.id);
        assert.ok((await children()).filter(r=>r.forwardGroupRuleId===created.id).every(r=>!r.isEnabled));
        await clearWrites();
        await admin.toggle({id:created.id,isEnabled:true});
        await assertOnlyTemplateWritten(created.id);
        await acknowledge();
        await clearWrites();
        await admin.restart({id:1000});
        await assertOnlyTemplateWritten(1000);
        // A stopped Agent with an explicit runtime error must still fail.
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=0, "runtimeDiagnostic"=? WHERE "id"=?',[JSON.stringify({message:"bind failed",reportedAt:time}),newChildren[0].id]);
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        assert.equal((await members())[0].healthStatus,"unhealthy");
        assert.ok((await members())[0].failureSince);
        // The initial pending window is bounded and cannot be extended by sweeps.
        time += 301000;
        mock.timers.tick(301000);
        await runtime.executeRaw('UPDATE "hosts" SET "lastHeartbeat"=?',[now()]);
        await groups.runForwardGroupFailover(10);
        assert.ok((await members()).every(m=>m.healthStatus==="unhealthy"),"missing ACKs must eventually be failures");
        await acknowledge();
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        await runtime.executeRaw('UPDATE "forward_rules" SET "isRunning"=0, "runtimeDiagnostic"=? WHERE "id"=?',[JSON.stringify({message:"bind failed",reportedAt:time}),newChildren[0].id]);
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        time += 11000;
        mock.timers.tick(11000);
        await groups.runForwardGroupFailover(10,{skipRuleSync:true});
        assert.equal((await groups.getForwardGroupById(10)).activeMemberId,102,"real failures must still switch to a healthy standby");
        assert.deepEqual(dnsRequests.at(-1).values,["198.51.100.2"]);
        // Maintenance no longer rewrites stopped children, so prove that the
        // real Agent heartbeat still emits the repair action on its own.
        const express = (await import("express")).default;
        const app = express();
        app.use(express.json());
        app.use((req,_res,next)=>{req.agentToken="issue25-token-1";next();});
        (await import("./server/agentHeartbeatRoute.ts")).registerAgentHeartbeatRoute(app);
        const server = app.listen(0,"127.0.0.1");
        await new Promise(resolve=>server.once("listening",resolve));
        try {
          const rules = (await children()).filter(r=>r.hostId===1).map(r=>({ruleId:r.id,port:r.sourcePort,protocol:r.protocol,forwardType:r.forwardType,targetIp:r.targetIp,targetPort:r.targetPort,ready:!!r.isRunning}));
          const response = await fetch("http://127.0.0.1:"+server.address().port+"/api/agent/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentVersion:"2.2.214",forceReconcile:true,localState:{rules,tunnels:[],services:[]}})});
          const body = await response.json();
          assert.equal(response.status,200,JSON.stringify(body));
          assert.ok(body.desiredState.actions.some(a=>a.ruleId===newChildren[0].id && a.op==="apply" && !a.knownRunning),"stopped child must still receive an Agent repair action");
        } finally {
          server.closeAllConnections();
          await new Promise(resolve=>server.close(resolve));
        }
      } finally {
        mock.timers.reset();
        await runtime.closeDatabase();
        await new Promise(resolve=>webhook.close(resolve));
      }
    `], {cwd:process.cwd(), env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"sync.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},encoding:"utf8",timeout:90_000});
    assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, {recursive:true,force:true});
  }
});

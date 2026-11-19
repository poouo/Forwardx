import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("upgrading an online Agent reconciles existing rate Guards and carries their configuration over SSE", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-guard-recovery-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import express from "express";
    const runtime = await import("./server/dbRuntime.ts");
    await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
    await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
    const {registerAgentHeartbeatRoute}=await import("./server/agentHeartbeatRoute.ts");
    const {registerAgentEventClient}=await import("./server/agentEvents.ts");
    const {decryptPayload}=await import("./server/agentCrypto.ts");
    await (await import("./server/repositories/settingsRepository.ts")).setSettings({forwardProtocols:JSON.stringify({nginx:true})});
    const insert=async(table,data)=>runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
    const now=Math.floor(Date.now()/1000);
    await insert("users",{id:1,username:"admin",password:"unused",role:"admin"});
    await insert("users",{id:2,username:"limited",password:"unused",role:"admin",gostRateLimitIn:4,gostRateLimitOut:4});
    await insert("hosts",{id:1,name:"guard-upgrade",ip:"192.0.2.1",userId:1,isOnline:1,lastHeartbeat:now,agentVersion:"2.3.301",agentToken:"guard-test-token"});
    const types=["iptables","nftables","realm","socat","nginx"];
    for(const [index,forwardType] of types.entries()) await insert("forward_rules",{
      id:index+1,name:forwardType,hostId:1,userId:2,sourcePort:24000+index,
      targetIp:"192.0.2.10",targetPort:80,protocol:"both",forwardType,isEnabled:1,isRunning:1,
    });
    await insert("forward_rules",{id:10,name:"disabled",hostId:1,userId:2,sourcePort:24010,targetIp:"192.0.2.10",targetPort:80,protocol:"tcp",forwardType:"iptables",isEnabled:0,isRunning:0});
    await insert("forward_rules",{id:11,name:"unlimited",hostId:1,userId:1,sourcePort:24011,targetIp:"192.0.2.10",targetPort:80,protocol:"tcp",forwardType:"iptables",isEnabled:1,isRunning:1});
    class Stream extends EventEmitter { frames=[]; write(frame){this.frames.push(frame);return true;} end(){} }
    const stream=new Stream();
    const client=registerAgentEventClient(1,"guard-test-token",stream);
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.agentToken="guard-test-token";next();});
    registerAgentHeartbeatRoute(app);
    const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
    const beat=async(extra={})=>{
      const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/agent/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentVersion:"2.3.302",forceReconcile:true,...extra})});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
    };
    try {
      // Upgrade while the database still marks every old rule as running.
      // Recovery must not depend on the availability of the first local snapshot.
      let body=await beat();
      const actions=body.desiredState?.actions||[];
      for(const [index,type] of types.entries()) {
        assert.ok(actions.some(a=>a.ruleId===index+1&&a.forwardType==="guard"&&a.op==="apply"),type+" Guard must be part of reconciliation even when isRunning=1");
        const guard=body.guardRules.find(g=>g.ruleId===index+1);
        assert.equal(guard.limitIn,500000);assert.equal(guard.limitOut,500000);
      }
      const messages=stream.frames.map(frame=>decryptPayload(JSON.parse(frame.split("data: ")[1]),"guard-test-token",{validateTimestamp:false}));
      const push=messages.findLast(message=>message.type==="agent-desired-state").data;
      assert.deepEqual(push.guardRules,body.guardRules,"SSE must contain the complete Guard snapshot, including its rates");
      assert.equal(push.stateSignatures.guardRules,body.stateSignatures.guardRules);
      assert.ok(!body.guardRules.some(g=>g.ruleId===10||g.ruleId===11),"disabled and unlimited kernel rules must not gain Guards");
      // After restart, on-disk Guard markers survive but in-process listeners do not.
      body=await beat({agentProcessId:202,localState:{rules:types.map((_,index)=>({ruleId:index+1,port:24000+index,protocol:"both",forwardType:"guard",targetIp:"192.0.2.10",targetPort:80,ready:false})),tunnels:[],services:[]}});
      for(let id=1;id<=5;id++) assert.ok(body.desiredState.actions.some(a=>a.ruleId===id&&a.forwardType==="guard"&&!a.knownRunning),"missing live Guard must be repaired for rule "+id);
    } finally { client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

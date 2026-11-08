import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function isolated(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-member-regression-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd:process.cwd(), encoding:"utf8", timeout:60_000,
      env:{...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"test.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},
    });
    assert.equal(result.status,0,result.error?.stack || result.stderr || result.stdout);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
}

const fixture = String.raw`
  import assert from "node:assert/strict";
  const runtime = await import("./server/dbRuntime.ts");
  await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
  await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
  const groups = await import("./server/repositories/forwardGroupRepository.ts");
  const db = await import("./server/db.ts");
  const insert = async (table,data) => runtime.executeRaw('INSERT INTO "'+table+'" ('+Object.keys(data).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(data).map(()=>'?').join(',')+')',Object.values(data));
  const now = Math.floor(Date.now()/1000);
  await insert("users",{id:1,username:"admin",password:"unused",role:"admin",accountEnabled:1});
  for(const id of [1,2,3]) await insert("hosts",{id,name:"entry-"+id,ip:"198.51.100."+id,ipv4:"198.51.100."+id,userId:1,isOnline:1,lastHeartbeat:now,agentToken:"token-"+id});
  const rule = {userId:1,name:"logical",sourcePort:16000,targetIp:"203.0.113.10",targetPort:443,forwardType:"iptables",protocol:"tcp",isEnabled:1,forwardGroupId:10};
  const member = (hostId,priority=hostId) => ({memberType:"host",hostId,priority,isEnabled:true});
  const state = async () => (await runtime.queryRaw('SELECT * FROM forward_groups WHERE id=10'))[0];
`;

test("saving members cannot resurrect removed or changed-IP DDNS addresses, and healthy reports restore selection", () => isolated(fixture + String.raw`
  const http = await import("node:http");
  const writes=[];
  const webhook=http.createServer((req,res)=>{let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{writes.push(JSON.parse(body));res.writeHead(204);res.end();});});
  await new Promise(resolve=>webhook.listen(0,"127.0.0.1",resolve));
  try {
    await (await import("./server/repositories/settingsRepository.ts")).setSettings({ddnsEnabled:"true",ddnsProvider:"webhook",ddnsWebhookMethod:"POST",ddnsWebhookUrl:"http://127.0.0.1:"+webhook.address().port+"/ddns"});
    await insert("forward_groups",{id:10,name:"failover",groupMode:"failover",groupType:"host",domain:"isolated.example.test",recordType:"A",targetIp:"0.0.0.0",userId:1,isEnabled:1,activeMemberId:101,lastDdnsValue:"198.51.100.1",failoverSeconds:10,recoverSeconds:10});
    for(const id of [1,2]) {
      await insert("forward_group_members",{id:100+id,groupId:10,memberType:"host",hostId:id,priority:id,isEnabled:1,failureSince:now-120});
      await insert("forward_rules",{...rule,id:110+id,hostId:id,isRunning:1,forwardGroupRuleId:100,forwardGroupMemberId:100+id,gostMode:"direct"});
      await insert("tcping_stats",{ruleId:110+id,hostId:id,healthStatus:"unhealthy",isTimeout:1,recordedAt:now});
    }
    await insert("forward_rules",{...rule,id:100,hostId:1,isForwardGroupTemplate:1});
    await groups.replaceForwardGroupMembers(10,[member(2)],{skipSync:true,deferRefresh:true});
    assert.equal((await state()).activeMemberId,null,"removed active identities must be cleared immediately");
    const service=await import("./server/services/forwardGroupService.ts");
    await service.updateForwardGroupFromInput(10,{name:"failover",groupMode:"failover",groupType:"host",forwardType:"iptables",protocol:"tcp",domain:"isolated.example.test",recordType:"A",failoverSeconds:10,recoverSeconds:10,autoFailback:false,isEnabled:true,members:[member(2),member(3)]});
    assert.ok(writes.length);
    assert.ok(writes.every(record=>!record.values.includes("198.51.100.1")),"the old non-member must never be sent to the provider");
    assert.equal((await state()).lastDdnsValue,"198.51.100.2");
    assert.equal((await state()).lastStatus,"down","fallback must not invent a healthy route");
    await runtime.executeRaw('UPDATE forward_rules SET isRunning=1 WHERE forwardGroupRuleId=100 AND hostId=2');
    await insert("tcping_stats",{ruleId:112,hostId:2,healthStatus:"healthy",isTimeout:0,latencyMs:12,recordedAt:now+1});
    await groups.runForwardGroupFailover(10,{skipRuleSync:true});
    assert.equal((await state()).activeMemberId,102);
    assert.equal((await state()).lastStatus,"healthy");
    assert.equal((await groups.getForwardGroupRuleForSelfTest(await db.getForwardRuleById(100),await groups.getForwardGroupById(10))).rule.hostId,2);
    // Same member, new IP: neither historical IP nor a disabled member is a valid fallback.
    await runtime.executeRaw('UPDATE hosts SET ipv4=?,ip=? WHERE id=2',["198.51.100.22","198.51.100.22"]);
    await insert("tcping_stats",{ruleId:112,hostId:2,healthStatus:"unhealthy",isTimeout:1,recordedAt:now+2});
    const before=writes.length;
    await groups.runForwardGroupFailover(10,{forcePriority:true,forceSync:true,skipRuleSync:true});
    assert.equal(writes.at(-1).value,"198.51.100.22");
    assert.ok(writes.slice(before).every(record=>!record.values.includes("198.51.100.2")));
    await groups.replaceForwardGroupMembers(10,[{...member(2),isEnabled:false},member(3)],{skipSync:true});
    assert.equal((await state()).activeMemberId,null);
    await groups.runForwardGroupFailover(10,{forcePriority:true,forceSync:true,skipRuleSync:true});
    assert.equal((await state()).lastDdnsValue,"198.51.100.3");
    await groups.replaceForwardGroupMembers(10,[{...member(2),isEnabled:false},{...member(3),isEnabled:false}],{skipSync:true});
    await groups.runForwardGroupFailover(10,{forcePriority:true,forceSync:true,skipRuleSync:true});
    assert.deepEqual(writes.at(-1).values,[],"no enabled member may not leave a retired DNS address behind");
    assert.equal((await state()).lastDdnsValue,null);
  } finally {webhook.close();}
  process.exit(0);
`));

test("port self-test fans out after adding members, publishes partial results and retains snapshots and authorization", () => isolated(fixture + String.raw`
  const {selfTestRulesRouter}=await import("./server/routers/rules.selfTest.ts");
  const caller=selfTestRulesRouter.createCaller({user:{id:1,role:"admin"},req:{headers:{}},res:{}});
  await insert("forward_groups",{id:10,name:"port",groupMode:"port",groupType:"host",targetIp:"0.0.0.0",userId:1,isEnabled:1});
  await insert("forward_rules",{...rule,id:100,hostId:1,isForwardGroupTemplate:1});
  for(const id of [1,2]) {
    await insert("forward_group_members",{id:100+id,groupId:10,memberType:"host",hostId:id,priority:id,isEnabled:1});
    await insert("forward_rules",{...rule,id:110+id,hostId:id,forwardGroupRuleId:100,forwardGroupMemberId:100+id});
  }
  const first=await caller.startSelfTest({ruleId:100});
  assert.equal(first.queued,2);
  await insert("forward_group_members",{id:103,groupId:10,memberType:"host",hostId:3,priority:3,isEnabled:1});
  await insert("forward_rules",{...rule,id:113,hostId:3,forwardGroupRuleId:100,forwardGroupMemberId:103});
  const next=await caller.startSelfTest({ruleId:100});
  assert.equal(next.queued,3);
  const second=await db.getForwardTestById(next.id);
  const rows=await runtime.queryRaw('SELECT * FROM forward_tests WHERE batchId=? ORDER BY hostId',[second.batchId]);
  assert.deepEqual(rows.map(row=>row.hostId),[1,2,3]);
  const {Router}=await import("express");
  const router=Router();
  (await import("./server/agentSelfTestRoutes.ts")).registerAgentSelfTestRoutes(router);
  const request=async (url,hostId,body={})=>{
    let output;
    let status=200;
    const res={json:value=>output=value,status:code=>{status=code;return res;}};
    await router.stack.find(layer=>layer.route?.path===url).route.stack[0].handle({agentToken:"token-"+hostId,body},res);
    if(status!==200) throw new Error("HTTP "+status);
    return output;
  };
  await runtime.executeRaw('UPDATE forward_rules SET targetPort=8443 WHERE id=112');
  const payload=(await request("/api/agent/selftest-pull",2)).selfTests.find(test=>test.testId===rows[1].id);
  assert.equal(payload.targetPort,443,"enqueued tests cannot be redirected by later edits");
  await assert.rejects(request("/api/agent/selftest-result",1,{testId:rows[1].id,targetReachable:true,latencyMs:12}),/HTTP 404/);
  await request("/api/agent/selftest-result",2,{testId:rows[1].id,targetReachable:true,latencyMs:12});
  let latest=await db.getLatestForwardTest(100);
  assert.equal(latest.status,"running");
  let details=JSON.parse(latest.message).details;
  assert.equal(details.length,3);
  assert.equal(details.find(row=>row.fromHostId===2).latencyMs,12);
  assert.equal(details.find(row=>row.fromHostId===1).pending,true);
  await request("/api/agent/selftest-result",1,{testId:rows[0].id,targetReachable:true,latencyMs:7});
  await request("/api/agent/selftest-result",3,{testId:rows[2].id,targetReachable:false,message:"unreachable"});
  latest=await db.getLatestForwardTest(100);
  assert.equal(latest.status,"success");
  assert.equal(latest.latencyMs,12,"parallel paths are not summed");
  assert.equal(JSON.parse(latest.message).details.filter(row=>row.success).length,2);
  // Late duplicate reports cannot overwrite the completed batch.
  await request("/api/agent/selftest-result",2,{testId:rows[1].id,targetReachable:false});
  assert.equal((await db.getLatestForwardTest(100)).latencyMs,12);
  // Pure UDP uses ping, and an offline node remains visible instead of disappearing.
  await runtime.executeRaw('UPDATE forward_rules SET protocol=? WHERE forwardGroupId=10',["udp"]);
  await runtime.executeRaw('UPDATE hosts SET isOnline=0,lastHeartbeat=? WHERE id=3',[now-600]);
  await (await import("./server/agentActivity.ts")).clearAuthenticatedAgentActivity(3);
  await caller.startSelfTest({ruleId:100});
  details=JSON.parse((await db.getLatestForwardTest(100)).message).details;
  assert.equal(details.length,3);
  assert.ok(details.every(row=>row.method==="ping"));
  assert.match(details.find(row=>row.fromHostId===3).message,/离线/);
  const latestBatch=(await db.getLatestForwardTest(100)).batchId;
  await runtime.executeRaw('UPDATE forward_tests SET createdAt=?,updatedAt=? WHERE batchId=? AND status=?',[now-100,now-100,latestBatch,"pending"]);
  await (await import("./server/repositories/metricsRepository.ts")).timeoutStaleForwardTests(8);
  latest=await db.getLatestForwardTest(100);
  assert.equal(latest.status,"timeout");
  assert.ok(JSON.parse(latest.message).details.every(detail=>!detail.pending),"missing Agent reports must finish instead of spinning forever");
  const unauthorized=selfTestRulesRouter.createCaller({user:{id:9,role:"user"},req:{headers:{}},res:{}});
  await assert.rejects(unauthorized.startSelfTest({ruleId:100}),/无权操作/);
  process.exit(0);
`));

test("real heartbeats recover 7/7 typed direct listeners and Guard backends without restart or fabricated health", () => isolated(fixture + String.raw`
  const express=(await import("express")).default;
  await insert("forward_groups",{id:10,name:"port",groupMode:"port",groupType:"host",targetIp:"0.0.0.0",userId:1,isEnabled:1});
  await insert("forward_group_members",{id:102,groupId:10,memberType:"host",hostId:2,priority:0,isEnabled:1});
  for(let index=0;index<7;index++) {
    await insert("forward_rules",{...rule,id:100+index,sourcePort:16000+index,hostId:2,forwardType:"realm",isForwardGroupTemplate:1});
    await insert("forward_rules",{...rule,id:200+index,sourcePort:16000+index,hostId:2,forwardType:"realm",forwardGroupRuleId:100+index,forwardGroupMemberId:102,isRunning:index<5?1:0,
      runtimeDiagnostic:index<5?null:JSON.stringify({message:"old failure",reportedAt:Date.now()})});
  }
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.agentToken="token-2";next();});
  (await import("./server/agentHeartbeatRoute.ts")).registerAgentHeartbeatRoute(app);
  const server=await new Promise(resolve=>{const server=app.listen(0,"127.0.0.1",()=>resolve(server));});
  const beat=async(states)=>{
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/agent/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentVersion:"2.2.210",forceReconcile:true,localState:{rules:states,tunnels:[],services:[]}})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
  };
  const local=Array.from({length:7},(_,index)=>({ruleId:200+index,port:16000+index,forwardType:"realm",protocol:"tcp",targetIp:rule.targetIp,targetPort:443,ready:true}));
  try {
    let result=await beat(local);
    let children=await runtime.queryRaw('SELECT isRunning,runtimeDiagnostic FROM forward_rules WHERE forwardGroupRuleId>=100');
    assert.equal(children.filter(child=>child.isRunning).length,7);
    assert.ok(children.every(child=>!child.runtimeDiagnostic),"recovered diagnostics must be cleared");
    const actions=result.desiredState?.actions || result.actions || [];
    assert.ok(!actions.some(action=>[205,206].includes(action.ruleId)&&action.op==="apply"&&!action.knownRunning),"matching healthy listeners must be offered for non-disruptive adoption");
    let summary=(await groups.getForwardGroups(undefined,{includeRuntime:true,ids:[10]}))[0].entryRuntime;
    assert.equal(summary.nodes[0].runningRuleCount,7);
    await runtime.executeRaw('UPDATE forward_rules SET proxyProtocolSend=1,isRunning=0 WHERE id=205');
    result=await beat(local);
    const updatedAction=(result.desiredState?.actions || result.actions || []).find(action=>action.ruleId===205&&action.op==="apply");
    assert.ok(updatedAction,"status recovery must not suppress changed runtime options on the same endpoint");
    const embeddedConfigs=(updatedAction.preCommands || []).map(command=>/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(command)?.[1]).filter(Boolean);
    assert.ok(embeddedConfigs.some(encoded=>Buffer.from(encoded,"base64").toString("utf8").includes("send_proxy = true")),"updated Realm settings must still reach the Agent");
    local[6].ready=false;
    await beat(local);
    assert.equal((await db.getForwardRuleById(206)).isRunning,false,"an open but unready runtime must not count as healthy");
    // The exact same backend is now wrapped by the host's protocol guard.
    await runtime.executeRaw('UPDATE hosts SET blockHttp=1 WHERE id=2');
    await runtime.executeRaw('UPDATE forward_rules SET isRunning=0 WHERE id IN (205,206)');
    local.forEach(item=>{item.forwardType="guard";item.ready=true;});
    result=await beat(local);
    assert.equal((await db.getForwardRuleById(205)).isRunning,true);
    assert.equal((await db.getForwardRuleById(206)).isRunning,true);
    assert.ok(!(result.desiredState?.actions || result.actions || []).some(action=>[205,206].includes(action.ruleId)&&action.op==="apply"&&!action.knownRunning),"Guard synchronization must preserve matching known-running listeners");
    local[6].targetPort=8443;
    await beat(local);
    assert.equal((await db.getForwardRuleById(206)).isRunning,false,"stale target/configuration cannot repair the status");
  } finally {server.close();}
  process.exit(0);
`));

test("a DDNS request in flight cannot commit a member removed while the provider was responding", () => isolated(fixture + String.raw`
  const http=await import("node:http");
  let started;
  const requestStarted=new Promise(resolve=>started=resolve);
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let count=0;
  const webhook=http.createServer((req,res)=>{req.resume();req.on("end",async()=>{
    count++;
    if(count===1){started();await gate;}
    res.writeHead(204);res.end();
  });});
  await new Promise(resolve=>webhook.listen(0,"127.0.0.1",resolve));
  try {
    await (await import("./server/repositories/settingsRepository.ts")).setSettings({ddnsEnabled:"true",ddnsProvider:"webhook",ddnsWebhookMethod:"POST",ddnsWebhookUrl:"http://127.0.0.1:"+webhook.address().port+"/ddns"});
    await insert("forward_groups",{id:10,name:"failover",groupMode:"failover",groupType:"host",targetIp:"0.0.0.0",userId:1,isEnabled:1,domain:"isolated.example.test",recordType:"A",activeMemberId:101,lastDdnsValue:"198.51.100.1"});
    await insert("forward_group_members",{id:101,groupId:10,memberType:"host",hostId:1,priority:0,isEnabled:1});
    const pending=groups.runForwardGroupFailover(10,{forceSync:true});
    await requestStarted;
    await groups.replaceForwardGroupMembers(10,[member(2)],{skipSync:true});
    release();await pending;
    assert.notEqual((await state()).activeMemberId,101,"old provider response must not restore the deleted selection");
    const deadline=Date.now()+5000;
    while((await state()).lastDdnsValue!=="198.51.100.2" && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal((await state()).lastDdnsValue,"198.51.100.2");
    const current=await groups.getForwardGroupById(10);
    assert.ok(current.members.some(member=>member.id===current.activeMemberId&&member.hostId===2));
  } finally {release();webhook.close();}
  process.exit(0);
`));

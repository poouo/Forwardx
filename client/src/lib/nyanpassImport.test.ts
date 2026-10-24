import assert from "node:assert/strict";
import test from "node:test";
import {createImportedRule,parseCompatibleRuleTransferText,validateNyanpassImportTarget} from "./nyanpassImport";
import {runBatchOperations} from "./batchOperations";
import {RULE_TRANSFER_FILE_KIND,RULE_TRANSFER_FILE_VERSION,serializeRuleTransferText} from "./ruleTransfer";

const row=(extra:Record<string,unknown>={})=>({name:"ny test",listen_port:10001,dest:["example.com:443"],...extra});
const parse=(raw:unknown)=>parseCompatibleRuleTransferText(JSON.stringify(raw));
const resource={groupMode:"port",groupType:"host",forwardType:"gost",proxyProtocolReceive:false,proxyProtocolSend:false};
const rules=(raw:unknown)=>{const result=parse(raw);assert.equal(result.ok,true,!result.ok?result.error:"");return result.ok?result.file.rules:[];};
const validate=(raw:unknown,extra:Record<string,any>={})=>validateNyanpassImportTarget(rules(raw),{resource,scope:"local",protocol:"tcp",admin:true,...extra});

test("ny official JSON lines retain names, fixed/random ports and IPv6 targets, always disabled",()=>{
  const text="\uFEFF"+JSON.stringify(row())+"\r\n\r\n"+JSON.stringify(row({name:"v6",listen_port:0,dest:["[2001:db8::1]:65535"]}))+"\n";
  const result=parseCompatibleRuleTransferText(text);
  assert.equal(result.ok,true);
  if(!result.ok)return;
  assert.equal(result.file.importSource,"nyanpass");
  assert.deepEqual(result.file.rules.map(rule=>[rule.name,rule.sourcePort,rule.targetIp,rule.targetPort,rule.isEnabled]),[["ny test",10001,"example.com",443,false],["v6",0,"2001:db8::1",65535,false]]);
});

test("native versioned imports preserve existing enabled state and never opt into ny",()=>{
  const native={kind:RULE_TRANSFER_FILE_KIND,version:RULE_TRANSFER_FILE_VERSION,rules:[{name:"native",sourcePort:1234,targetIp:"example.com",targetPort:443,isEnabled:true}]};
  const result=parse(native);
  assert.equal(result.ok,true);
  if(result.ok){assert.equal(result.file.importSource,undefined);assert.equal(result.file.rules[0].isEnabled,true);}
  assert.equal(parse({...native,version:999}).ok,false);
});

test("ny targets/policies convert only supported TCP GOST multi-target semantics",()=>{
  for(const [source,expected] of [["round","round_robin"],["random","random"],["ip_hash","ip_hash"],["failover","fallback"]]){
    const item=row({dest:["a.example:443","[2001:db8::2]:8443"],dest_policy:source});
    assert.equal(rules(item)[0].failoverStrategy,expected);
    assert.deepEqual(rules(item)[0].failoverTargets,[{targetIp:"2001:db8::2",targetPort:8443}]);
    assert.equal(validate(item),null);
    for(const extra of [{protocol:"both"},{protocol:"udp"},{scope:"chain"},{scope:"tunnel"},{resource:{...resource,forwardType:"realm"}}]) assert.ok(validate(item,extra));
  }
});

test("ny PROXY is never silently overridden by resource-level settings",()=>{
  for(const [send,version] of [[1,1],[3,2]]){
    const item=row({accept_proxy_protocol:1,proxy_protocol:send});
    assert.equal(rules(item)[0].proxyProtocolVersion,version);
    assert.ok(validate(item));
    const selected={...resource,proxyProtocolReceive:true,proxyProtocolSend:true,proxyProtocolVersion:version};
    assert.equal(validate(item,{resource:selected}),null);
    assert.equal(validate(item,{resource:{...selected,forwardType:"realm"}}),null);
    assert.ok(validate(item,{resource:selected,protocol:"both"}));
    assert.ok(validate(item,{resource:{...selected,proxyProtocolVersion:version===1?2:1}}));
  }
  assert.ok(validate(row(),{resource:{...resource,proxyProtocolSend:true}}),"plain ny import must not acquire unexpected PROXY headers");
  assert.ok(validate(row(),{scope:"tunnel",resource:{proxyProtocolExitSend:true}}));
  assert.equal(parse(row({proxy_protocol:2})).ok,false,"UDP PROXY must not become TCP-only silently");
});

test("ny rate limits convert bytes/sec exactly and retain administrator-only permission",()=>{
  const item=row({speed_limit:1250000});
  assert.equal(rules(item)[0].rateLimitMbps,10);
  assert.equal(validate(item),null);
  assert.ok(validate(item,{admin:false}));
  assert.equal(parse(row({speed_limit:1})).ok,false,"do not round a cap away");
  assert.equal(rules(row({speed_limit:0}))[0].rateLimitMbps,undefined);
});

test("experimental parsing fails closed on unsupported or malformed settings",()=>{
  for(const extra of [
    {ip_limit:1},{connection_limit:10},{tls:{}},{dest_policy:"least_load"},{new_feature:true},{paused:true},
    {accept_proxy_protocol:"0"},{proxy_protocol:true},{speed_limit:-1},{listen_port:"123"},{listen_port:65536},
    {dest:[]},{dest:["2001:db8::1:443"]},{dest:["[::::]:443"]},{dest:["999.0.0.1:443"]},{dest:["http://example.com:443"]},{dest:["host:0"]},
    {dest:Array(12).fill("example.com:443")},{name:""},
  ]) assert.equal(parse(row(extra)).ok,false,JSON.stringify(extra));
  assert.equal(parseCompatibleRuleTransferText(JSON.stringify(row())+"\nnot json").ok,false);
  assert.equal(parse(Array(501).fill(row())).ok,false);
  assert.equal(parseCompatibleRuleTransferText(" ").ok,false);
  assert.equal(parseCompatibleRuleTransferText("x".repeat(5*1024*1024+1)).ok,false);
  assert.equal(parseCompatibleRuleTransferText("old#1000#host#443").ok,false);
});

test("ny batch keeps conflicting ports and retains only failures for retry; native fallback remains",async()=>{
  const imported=rules([row(),row({listen_port:10002}),row({listen_port:0})]);
  const calls:number[]=[];
  const result=await runBatchOperations(imported,2,rule=>createImportedRule(rule.sourcePort,true,async port=>{
    assert.equal(rule.isEnabled,false);
    calls.push(port);
    if(port===10001) throw new Error("Entry agent port 10001 is already used");
    return port;
  }));
  assert.equal(result.filter(item=>item.status==="fulfilled").length,2);
  const failed=result.filter(item=>item.status==="rejected").map(item=>item.item);
  assert.deepEqual(failed.map(rule=>rule.sourcePort),[10001]);
  assert.deepEqual(calls.sort((a,b)=>a-b),[0,10001,10002]);
  const nativeCalls:number[]=[];
  await createImportedRule(10001,false,async port=>{nativeCalls.push(port);if(port)throw new Error("Entry agent port 10001 is already used");return port;});
  assert.deepEqual(nativeCalls,[10001,0]);
});

test("user-assigned import ports never fall back on conflicts or authorization ranges", async () => {
  for (const message of ["Entry agent port 10001 is already used", "源端口必须在允许范围内：20000-20999"]) {
    const calls: number[] = [];
    await assert.rejects(createImportedRule(10001, true, async port => {
      calls.push(port);
      throw new Error(message);
    }), error => error instanceof Error && error.message === message);
    assert.deepEqual(calls, [10001]);
  }
});

test("file importer recognizes exported TXT without treating it as experimental ny JSON", async () => {
  const original = rules([row({ listen_port: 12345 }), row({ listen_port: 12346, dest: ["[2001:db8::1]:53"] }), row({ listen_port: 0 })]);
  const parsed = parseCompatibleRuleTransferText(serializeRuleTransferText(original));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.importSource, "text");
  assert.deepEqual(parsed.file.rules.map(({ sourcePort, targetIp, targetPort }) => ({ sourcePort, targetIp, targetPort })), original.map(({ sourcePort, targetIp, targetPort }) => ({ sourcePort, targetIp, targetPort })));
  for (const text of ["[2001:db8::1]:53", "[2001:db8::1] : 53", "[2001:db8::1]：53"]) {
    const ipv6 = parseCompatibleRuleTransferText(text);
    assert.ok(ipv6.ok);
    assert.equal(ipv6.file.importSource, "text");
  }
  const calls: number[] = [];
  await assert.rejects(createImportedRule(parsed.file.rules[0].sourcePort, parsed.file.importSource === "text", async port => {
    calls.push(port); throw new Error("Entry agent port 12345 is already used");
  }));
  assert.deepEqual(calls, [12345], "TXT round-trip never silently replaces a fixed listener");
});

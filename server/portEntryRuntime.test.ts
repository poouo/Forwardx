import assert from "node:assert/strict";
import test from "node:test";
import { summarizePortEntryRuntime } from "./portEntryRuntime";
import { nextPortEntrySyncDiagnostic, parsePortEntrySyncDiagnostic, parseRuleRuntimeDiagnostic } from "../shared/portEntryDiagnostics";
import { updateAgentToolInventory, getAgentToolAvailability } from "./agentToolInventory";
import { portForwardToolPreflight, missingPortForwardToolMessage } from "./portForwardToolPreflight";

const group = {isEnabled:true};
const members = [1,2,3].map((id) => ({id,hostId:id,memberType:"host",isEnabled:true,host:{name:`host${id}`,isOnline:id!==3}}));
const templates = [{id:100,isEnabled:true},{id:200,isEnabled:true},{id:300,isEnabled:false}];
const child = (memberId:number, parent:number, running=true) => ({id:memberId*1000+parent,hostId:memberId,forwardGroupMemberId:memberId,forwardGroupRuleId:parent,isEnabled:true,isRunning:running});

test("entry counts require every active rule and an online non-excluded host", () => {
  const children = [child(1,100),child(1,200),child(1,200),child(2,100),child(3,100),child(3,200)];
  const summary = summarizePortEntryRuntime({group,members,templates,children});
  assert.equal(summary.runningHostCount,1);
  assert.equal(summary.expectedHostCount,3);
  assert.deepEqual(summary.nodes.map((node) => node.status),["running","degraded","offline"]);
  assert.equal(summary.nodes[0].runningRuleCount,2);
  const excluded = structuredClone(members);
  Object.assign(excluded[0].host,{trafficFailoverEnabled:true,trafficFailoverExcluded:true,trafficLimit:1});
  assert.equal(summarizePortEntryRuntime({group,members:excluded,templates,children}).nodes[0].status,"excluded");
});

test("disabled dependencies, disabled members and empty resources do not claim healthy listeners", () => {
  const summary = summarizePortEntryRuntime({group,members,templates,children:[],dependencyEnabled:false});
  assert.equal(summary.expectedHostCount,0);
  assert.ok(summary.nodes.every((node) => node.status==="disabled"));
  const idle = summarizePortEntryRuntime({group,members,templates:[],children:[]});
  assert.equal(idle.runningHostCount,0);
  assert.ok(idle.nodes.every((node) => node.status==="idle"));
});

test("sync attempts survive repeated failures, bound examples and reset on recovery", () => {
  const errors = Array.from({length:20},(_,ruleId)=>({ruleId,message:"port occupied"}));
  const first = nextPortEntrySyncDiagnostic(null,errors,1000)!;
  assert.equal(first.failedRuleCount,20);
  assert.equal(first.errors.length,3);
  const next = nextPortEntrySyncDiagnostic(JSON.stringify(first),errors,2000)!;
  assert.equal(next.attempts,2);
  assert.equal(next.firstFailedAt,1000);
  assert.equal(next.nextRetryAt,62000);
  assert.equal(nextPortEntrySyncDiagnostic(next,[],3000),null);
  assert.equal(parsePortEntrySyncDiagnostic("invalid"),null);
  assert.equal((parsePortEntrySyncDiagnostic({...next, unexpected:"not exposed"}) as any).unexpected,undefined);
  assert.equal(parseRuleRuntimeDiagnostic("{}"),null);
});

test("fresh typed tool discovery blocks known missing tools but leaves older or offline Agents unconfirmed", () => {
  const now=Date.now();
  updateAgentToolInventory(901,{realm:false,gost:true,nftables:"true"},now,now);
  assert.equal(getAgentToolAvailability(901,"realm",now).status,"missing");
  assert.equal(getAgentToolAvailability(901,"nftables",now).status,"unknown");
  assert.equal(getAgentToolAvailability(901,"gost",now+180001).status,"unknown");
  updateAgentToolInventory(901,{realm:false},now,now);
  const offline=portForwardToolPreflight([{id:901,name:"offline",isOnline:false}],"realm");
  assert.equal(offline[0].status,"unknown");
  assert.equal(portForwardToolPreflight([{id:901,name:"offline",isOnline:"0"}],"realm")[0].status,"unknown");
  assert.equal(missingPortForwardToolMessage(offline,"realm"),null);
  assert.match(missingPortForwardToolMessage(portForwardToolPreflight([{id:901,name:"entry",isOnline:true}],"realm"),"realm")!,/entry/);
  updateAgentToolInventory(901,{realm:true},now+1,now+1);
  updateAgentToolInventory(901,{realm:false},now,now+1);
  assert.equal(getAgentToolAvailability(901,"realm",now+1).status,"available");
  updateAgentToolInventory(902,{realm:false},now-180001,now);
  assert.equal(getAgentToolAvailability(902,"realm",now).status,"unknown");
});

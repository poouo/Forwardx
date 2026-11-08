import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { portEntryProbeHosts } from "./portEntryProbePlan";
import { LinkTestProbeView, parseLinkTestMessage } from "../components/LinkTestLatencySummary";
import { buildPortEntrySelfTestResult } from "../../../server/portEntrySelfTest";
import { forwardGroupSelfTestSource } from "../../../shared/forwardGroup";

test("ordinary port plans include every enabled entry, including nested hosts and offline nodes", () => {
  const group={groupMode:"port",members:[1,2,3,4].map(id=>({memberType:"host",hostId:id,isEnabled:id!==4,priority:id,host:{id,name:`entry-${id}`,isOnline:id!==3}}))};
  assert.deepEqual(portEntryProbeHosts(group).map(entry=>entry.label),["entry-1","entry-2","entry-3"]);
  assert.equal(portEntryProbeHosts({...group,groupMode:"failover"}).length,0);
  const entries=portEntryProbeHosts(group);
  const rows=entries.map((entry,index)=>({id:index+1,batchId:"pe-example",hostId:entry.hostId,requestMessage:JSON.stringify({kind:"forward-group",groupId:10,sourceLabel:entry.label,targetLabel:"service"}),status:index===1?"success":"pending",latencyMs:index===1?12:null}));
  const result=buildPortEntrySelfTestResult(rows)!;
  assert.equal(forwardGroupSelfTestSource(result),null,"a parallel batch must not be collapsed to its last row's single source");
  const html=renderToStaticMarkup(<LinkTestProbeView parsed={parseLinkTestMessage(result.message)} isTesting isSuccess={false}
    plannedSegments={entries.map(entry=>({from:entry.label,to:"service",fromHostId:entry.hostId,hopIndex:0,hopCount:1}))} />);
  for(const entry of entries) assert.match(html,new RegExp(entry.label));
  assert.match(html,/12/);
  assert.equal(JSON.parse(result.message).details.filter((detail:any)=>detail.pending).length,2);
});

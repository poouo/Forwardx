import assert from "node:assert/strict";
import test from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {PortEntryRuntimeSummary} from "./PortEntryRuntimeSummary";

test("entry details are collapsed and distinguish sync attempts from Agent execution failures", () => {
  const html=renderToStaticMarkup(<PortEntryRuntimeSummary summary={{expectedHostCount:1,runningHostCount:0,nodes:[{
    memberId:1,hostId:1,hostName:"host1",online:true,status:"pending",expectedRuleCount:2,runningRuleCount:0,configuredRuleCount:1,
    syncDiagnostic:{attempts:3,failedRuleCount:1,firstFailedAt:1000,lastFailedAt:2000,nextRetryAt:62000,errors:[{ruleId:100,message:"port occupied"}]},
    runtimeErrors:[{ruleId:200,runtimeRuleId:201,message:"listener not ready",reportedAt:2000,consecutiveFailures:2,retryNotBefore:32000}],
  }]}}/>);
  assert.match(html,/<details/);
  assert.doesNotMatch(html,/<details[^>]*open/);
  assert.match(html,/入口节点 0\/1/);
  assert.match(html,/配置同步失败/);
  assert.match(html,/连续失败 2 次/);
  assert.match(html,/Agent 最早重试/);
  assert.match(html,/不代表端到端业务探测/);
});

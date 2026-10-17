import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {PortEntryRuntimeSummary, PortEntryRuntimeDetails} from "./PortEntryRuntimeSummary";
import type { PortEntryRuntimeSummary as Summary } from "../../../shared/portEntryDiagnostics";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../i18n";

const summary: Summary = {expectedHostCount:1,runningHostCount:0,nodes:[{
    memberId:1,hostId:1,hostName:"host1",online:true,status:"pending",expectedRuleCount:2,runningRuleCount:0,configuredRuleCount:1,
    syncDiagnostic:{attempts:3,failedRuleCount:1,firstFailedAt:1000,lastFailedAt:2000,nextRetryAt:62000,errors:[{ruleId:100,message:"port occupied"}]},
    runtimeErrors:[{ruleId:200,runtimeRuleId:201,message:"listener not ready",reportedAt:2000,consecutiveFailures:2,retryNotBefore:32000}],
  }]};

test("entry cards render only a dialog trigger, not inline diagnostic content", () => {
  const html=renderToStaticMarkup(<PortEntryRuntimeSummary summary={summary} resourceName="port-example" />);
  assert.match(html,/aria-haspopup="dialog"/);
  assert.match(html,/aria-expanded="false"/);
  assert.match(html,/入口节点 0\/1/);
  assert.match(html,/节点详情/);
  assert.doesNotMatch(html,/<details|<summary|host1|配置同步失败|listener not ready/);
  assert.equal(renderToStaticMarkup(<PortEntryRuntimeSummary />), "");
});

test("dialog body distinguishes sync attempts from Agent execution failures and scrolls internally", () => {
  const html=renderToStaticMarkup(<PortEntryRuntimeDetails summary={summary} />);
  assert.match(html,/host1/);
  assert.match(html,/配置同步失败/);
  assert.match(html,/连续失败 2 次/);
  assert.match(html,/Agent 最早重试/);
  assert.match(html,/不代表端到端业务探测/);
  assert.match(html,/min-h-0.*overflow-y-auto/);
  assert.match(html,/overflow-wrap:anywhere/);
});

test("node diagnostics support English, idle nodes and empty resources", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<PortEntryRuntimeDetails summary={summary} />);
    assert.doesNotMatch(html,/\p{Script=Han}/u);
    assert.match(html,/host1|listener not ready/);
    const idle = { ...summary, nodes: [{ ...summary.nodes[0], status: "idle" as const, expectedRuleCount: 0, runningRuleCount: 0, syncDiagnostic: null, runtimeErrors: [] }] };
    const idleHtml = renderToStaticMarkup(<PortEntryRuntimeDetails summary={idle} />);
    assert.doesNotMatch(idleHtml,/配置同步失败|listener not ready/);
    const emptyHtml = renderToStaticMarkup(<PortEntryRuntimeSummary summary={{ expectedHostCount: 0, runningHostCount: 0, nodes: [] }} />);
    assert.match(emptyHtml,/0\/0/);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("node details use the portaled dialog with bounded height and a close action in all layouts", () => {
  const source = readFileSync("client/src/components/PortEntryRuntimeSummary.tsx", "utf8");
  assert.match(source,/<DialogTrigger asChild>/);
  assert.match(source,/<DialogContent className="flex max-h-\[85svh\] flex-col/);
  assert.match(source,/<DialogClose asChild>/);
  assert.doesNotMatch(source,/<details|<summary/);
  const dialog = readFileSync("client/src/components/ui/dialog.tsx", "utf8");
  assert.match(dialog,/<DialogPortal>/);
  const groups = readFileSync("client/src/pages/ForwardGroups.tsx", "utf8");
  assert.match(groups,/<PortEntryRuntimeSummary summary=\{group.entryRuntime\} resourceName=\{group.name\}/);
  assert.equal((groups.match(/renderGroupMembers\(group\)/g) || []).length, 2);
  assert.match(groups,/renderGroupMembers\(group, true\)/);
});

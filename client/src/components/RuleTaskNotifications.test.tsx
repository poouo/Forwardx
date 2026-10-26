import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleTaskProgress } from "./RuleTaskNotifications";
import type { RuleTaskSnapshot } from "../../../shared/ruleTaskQueue";

const task: RuleTaskSnapshot = { id: "job", requestId: "request", title: "批量导入", state: "running", total: 10,
  completed: 4, succeeded: 3, failed: 1, skipped: 0, cancelled: 0, queuePosition: 0, createdAt: 1 };

test("progress shows processed/total, a percentage, separate failures and truthful terminal status", () => {
  const running = renderToStaticMarkup(<RuleTaskProgress task={task} onStop={() => {}} />);
  assert.match(running, /执行中 4 \/ 10/);
  assert.match(running, /40%/);
  assert.match(running, /成功 3 · 失败 1 · 跳过 0/);
  assert.match(running, /停止排队/);
  assert.match(running, /aria-valuenow="4"/);
  const success = renderToStaticMarkup(<RuleTaskProgress task={{ ...task, state: "completed", completed: 10, succeeded: 10, failed: 0, finishedAt: 2 }} />);
  assert.match(success, /执行成功 10 \/ 10/);
  assert.match(success, /100%/);
  assert.doesNotMatch(success, /停止排队/);
  const failed = renderToStaticMarkup(<RuleTaskProgress task={{ ...task, state: "completed", completed: 10, failed: 2, finishedAt: 2 }} />);
  assert.match(failed, /部分执行失败/);
  assert.doesNotMatch(failed, /<span>执行成功/);
  const stopped = renderToStaticMarkup(<RuleTaskProgress task={{ ...task, state: "cancelled", completed: 10, cancelled: 6, finishedAt: 2 }} />);
  assert.match(stopped, /已停止 4 \/ 10/);
  assert.match(stopped, /40%/);
  assert.match(stopped, /未执行 6/);
  const lost = renderToStaticMarkup(<RuleTaskProgress task={task} lost />);
  assert.match(lost, /任务状态待核对/);
  assert.match(lost, /不要重复提交/);
  assert.doesNotMatch(lost, /role="progressbar"/);
});

test("global notifications survive navigation and both batch dialogs can close after acceptance", () => {
  const app = readFileSync("client/src/App.tsx", "utf8");
  assert.equal((app.match(/<RuleTaskNotifications \/>/g) || []).length, 1);
  const rules = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.match(rules, /copyActionPending \|\| ruleTaskEnqueued/);
  assert.match(rules, /disabled=\{importingRules && !ruleTaskEnqueued\}/);
  assert.match(rules, /submitRuleTask\(/);
  for (const title of ["批量复制", "批量编辑", "批量启用", "批量暂停", "批量重启", "批量删除", "批量导入"]) assert.ok(rules.includes(`"${title}"`));
});

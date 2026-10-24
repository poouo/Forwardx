import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ruleBatchStages, ruleBatchCanAdvance, ruleBatchCategory, ruleBatchModes, ruleBatchModeAvailable } from "./ruleBatchFlow";
import { matchesPersonalRuleGroup } from "../../../shared/ruleGroups";

const ready = { busy: false, selectedRules: 3, selectedTargets: 2, importSourceReady: true, importTargetReady: true };

test("batch categories keep all six operations and hide personal grouping outside own scope", () => {
  assert.deepEqual(ruleBatchModes("manage", true), ["operate", "copy", "edit", "groups"]);
  assert.deepEqual(ruleBatchModes("manage", false), ["operate", "copy", "edit"]);
  assert.deepEqual(ruleBatchModes("transfer", false), ["import", "export"]);
  for (const category of ["manage", "transfer"] as const) {
    for (const mode of ruleBatchModes(category, true)) assert.equal(ruleBatchCategory(mode), category);
  }
});

test("category defaults and dropdown options respect rules and permissions", () => {
  const empty = { hasRules: false, canAdd: true, isOwnRuleScope: true };
  const existing = { hasRules: true, canAdd: false, isOwnRuleScope: false };
  const firstMode = (category: "manage" | "transfer", access: typeof empty) =>
    ruleBatchModes(category, access.isOwnRuleScope).find((mode) => ruleBatchModeAvailable(mode, access));
  assert.equal(firstMode("transfer", empty), "import");
  assert.equal(firstMode("manage", empty), "groups");
  assert.equal(firstMode("transfer", existing), "export");
  assert.equal(firstMode("manage", existing), "operate");
  assert.equal(firstMode("manage", { ...empty, isOwnRuleScope: false }), undefined);
  assert.equal(firstMode("transfer", { ...empty, canAdd: false }), undefined);
  assert.equal(ruleBatchModeAvailable("groups", existing), false);
  for (const mode of ["operate", "copy", "edit", "export"] as const) {
    assert.equal(ruleBatchModeAvailable(mode, empty), false);
    assert.equal(ruleBatchModeAvailable(mode, existing), true);
  }
});

test("batch modes have compact single-column workflows", () => {
  assert.deepEqual(ruleBatchStages("copy"), ["selectRules", "configureTarget", "confirm"]);
  assert.deepEqual(ruleBatchStages("edit"), ["selectRules", "editRules"]);
  assert.deepEqual(ruleBatchStages("import"), ["importSource", "configureTarget", "confirm"]);
  for (const mode of ["operate", "export", "groups"] as const) {
    assert.deepEqual(ruleBatchStages(mode), [mode]);
    assert.equal(ruleBatchCanAdvance(mode, 1, ready), false);
  }
});

test("copy and edit require rules, and copy requires targets before confirmation", () => {
  assert.equal(ruleBatchCanAdvance("copy", 1, { ...ready, selectedTargets: 0 }), true);
  assert.equal(ruleBatchCanAdvance("copy", 1, { ...ready, selectedRules: 0 }), false);
  assert.equal(ruleBatchCanAdvance("copy", 2, { ...ready, selectedTargets: 0 }), false);
  assert.equal(ruleBatchCanAdvance("copy", 2, { ...ready, selectedRules: 0 }), false);
  assert.equal(ruleBatchCanAdvance("copy", 2, ready), true);
  assert.equal(ruleBatchCanAdvance("copy", 3, ready), false);
  assert.equal(ruleBatchCanAdvance("edit", 1, { ...ready, selectedTargets: 0 }), true);
  assert.equal(ruleBatchCanAdvance("edit", 1, { ...ready, selectedRules: 0 }), false);
});

test("import validates content first without requiring a target; busy workflows never advance", () => {
  assert.equal(ruleBatchCanAdvance("import", 1, { ...ready, importTargetReady: false }), true);
  assert.equal(ruleBatchCanAdvance("import", 1, { ...ready, importSourceReady: false }), false);
  assert.equal(ruleBatchCanAdvance("import", 2, { ...ready, importTargetReady: false }), false);
  assert.equal(ruleBatchCanAdvance("import", 2, { ...ready, importSourceReady: false }), false);
  assert.equal(ruleBatchCanAdvance("import", 2, ready), true);
  for (const mode of ["copy", "edit", "import"] as const) {
    assert.equal(ruleBatchCanAdvance(mode, 1, { ...ready, busy: true }), false);
    assert.equal(ruleBatchCanAdvance(mode, 0, ready), false);
  }
});

test("batch dialog keeps a compact fixed shell, removes split layouts and retains import content", () => {
  const source = readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8");
  const start = source.indexOf('<Dialog open={showCopyDialog}');
  const batch = source.slice(start, source.indexOf('<Dialog open={!!resetTrafficTarget}', start));
  assert.match(batch, /grid-rows-\[auto_minmax\(0,1fr\)_auto\].*sm:max-w-\[640px\]/);
  assert.match(batch, /ref=\{copyBodyRef\}.*min-h-0 touch-pan-y.*overflow-y-auto overscroll-contain/);
  assert.doesNotMatch(batch, /lg:grid-cols|md:grid-cols|<ArrowRight /);
  assert.doesNotMatch(batch, /左侧|右侧|copySelectedRules\.map/);
  assert.doesNotMatch(batch, /resetImportDialog\(\)/);
  assert.match(batch, /batchStep === 1 &&/);
  assert.match(batch, /batchStep === 2 &&/);
  assert.match(batch, /batchIsFinalStep && \(isBatchCopyMode \|\| isBatchImportMode\)/);
  const footer = batch.slice(batch.indexOf("<DialogFooter"));
  for (const operation of ["enable", "pause", "restart"]) assert.ok(footer.includes(`handleBatchRuleOperation("${operation}")`));
  assert.ok(footer.includes("handleBatchDeleteRules"));
  assert.ok(footer.includes("!batchCanAdvance"));
});

test("batch header uses two categories and a guarded operation dropdown", () => {
  const source = readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8");
  const start = source.indexOf('<Dialog open={showCopyDialog}');
  const header = source.slice(start, source.indexOf('</DialogHeader>', start));
  assert.match(header, /grid grid-cols-2 gap-1/);
  assert.doesNotMatch(header, /sm:grid-cols-3/);
  assert.match(header, /batchCategories\.map/);
  assert.match(header, /disabled = copyActionPending \|\| !nextMode/);
  assert.match(header, /<Select value=\{copyManageMode\}.*switchCopyManageMode.*disabled=\{copyActionPending\}/);
  assert.match(header, /htmlFor="batch-manage-operation"/);
  assert.match(header, /ruleBatchModes\(batchCategory, isOwnRuleScope\)\.map/);
  assert.match(header, /disabled=\{!ruleBatchModeAvailable\(mode, batchAccess\)\}/);
});

test("grouping has stable height and shares the fixed batch footer and pending guard", () => {
  const source = readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8");
  const start = source.indexOf('<Dialog open={showCopyDialog}');
  const batch = source.slice(start, source.indexOf('<Dialog open={!!resetTrafficTarget}', start));
  assert.match(batch, /isBatchGroupMode && "h-\[min\(720px,85svh\)\]"/);
  assert.match(batch, /<RuleGroupBulkEditor editor=\{batchGroupEditor\}/);
  const footerStart = batch.indexOf("<DialogFooter");
  for (const action of ["RuleGroupBulkPagination", "RuleGroupBulkApplyButton"]) {
    assert.ok(batch.indexOf(`<${action} editor={batchGroupEditor}`) > footerStart);
  }
  assert.match(source, /useRuleGroupBulkEditor\(\{ enabled: showCopyDialog && isOwnRuleScope \}\)/);
  assert.match(source, /const copyActionPending = [^;]*batchGroupEditor\.isPending/);
  const groups = readFileSync(new URL("../components/rules/PersonalRuleGroups.tsx", import.meta.url), "utf8");
  const editorStart = groups.indexOf("export function RuleGroupBulkEditor(");
  const editor = groups.slice(editorStart, groups.indexOf("export function RuleGroupBulkPagination", editorStart));
  assert.match(editor, /min-h-48/);
  assert.doesNotMatch(editor, /overflow-y-auto|max-h-\[|应用到|上一页|下一页/);
  const hook = groups.slice(groups.indexOf("export function useRuleGroupBulkEditor"), editorStart);
  assert.match(hook, /scope: "self", page, pageSize: 20/);
  assert.match(hook, /enabled, staleTime: 10_000, refetchOnWindowFocus: false/);
  assert.match(hook, /if \(enabled\) return;[\s\S]*setIds\(\[\]\);[\s\S]*updateGroupIds\(\[\]\)/);
  assert.match(hook, /if \(!canApply\) return/);
});

test("bulk personal-group filters include all, ungrouped and one membership", () => {
  assert.equal(matchesPersonalRuleGroup(undefined, null), true);
  assert.equal(matchesPersonalRuleGroup([1, 2], null), true);
  assert.equal(matchesPersonalRuleGroup(undefined, 0), true);
  assert.equal(matchesPersonalRuleGroup([], 0), true);
  assert.equal(matchesPersonalRuleGroup([1, 2], 0), false);
  assert.equal(matchesPersonalRuleGroup([1, 2], 2), true);
  assert.equal(matchesPersonalRuleGroup([1, 2], 3), false);
  assert.equal(matchesPersonalRuleGroup(undefined, 2), false);
  const source = readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8");
  assert.match(source, /setCopyRulePersonalGroupId\(isOwnRuleScope \? activePersonalGroupId : null\)/);
  assert.match(source, /matchesPersonalRuleGroup\(rule.personalGroupIds, isOwnRuleScope \? copyRulePersonalGroupId : null\)/);
  assert.match(source, /setCopyRulePersonalGroupId\(value === "all" \? null : Number\(value\)\);\s*setCopyRuleIds\(\[\]\)/);
});

test("group changes reset selected rules and page; header controls align without extra scrollbars", () => {
  const source = readFileSync(new URL("../components/rules/PersonalRuleGroups.tsx", import.meta.url), "utf8");
  for (const setter of ["setGroupIds", "setMode"]) {
    const start = source.indexOf(`const ${setter} =`);
    const handler = source.slice(start, source.indexOf("};", start));
    assert.match(handler, /setPage\(1\)/);
    assert.match(handler, /setIds\(\[\]\)/);
  }
  assert.match(source, /personalGroupChange: mode === "replace" \? undefined : \{ mode, groupIds \}/);
  assert.match(source, /flex h-7 items-center/);
  assert.match(source, /className="h-10 w-full justify-start text-left font-normal"/);
});

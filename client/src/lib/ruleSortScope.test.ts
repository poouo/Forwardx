import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCompleteRuleSortScope } from "./ruleSortScope";

const categories = ["local", "tunnel", "chain", "group"] as const;

for (const category of categories) {
  test(`${category}: permits the type-only filter selected by the category tab`, () => {
    assert.equal(isCompleteRuleSortScope(category, category), true);
    assert.equal(isCompleteRuleSortScope(category, "all"), true);
  });

  test(`${category}: rejects individual resources and other categories`, () => {
    for (const resourceType of categories) {
      assert.equal(isCompleteRuleSortScope(category, `${resourceType}:123`), false);
      if (resourceType !== category) {
        assert.equal(isCompleteRuleSortScope(category, resourceType), false);
      }
    }
  });
}

test("mixed categories are not sortable", () => {
  for (const resource of ["all", ...categories, "local:123"]) {
    assert.equal(isCompleteRuleSortScope("all", resource), false);
  }
});

test("rule list uses complete-scope validation and retains other safety gates", () => {
  const source = readFileSync(new URL("../pages/Rules.tsx", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("const ruleSortingEnabled ="), source.indexOf("const ruleSortableItems ="));
  assert.match(gate, /isCompleteRuleSortScope\(ruleCategory, filterResource\)/);
  assert.match(gate, /!pagedRules\.some\(isAdminManagedRule\)/);
  assert.match(gate, /effectiveViewMode !== "globe"/);
  assert.match(gate, /ruleSearchQuery\.trim\(\)\.length === 0/);
  assert.match(gate, /filterUser !== "all"/);
  assert.match(gate, /!rulePageQuery\.isPlaceholderData/);
});

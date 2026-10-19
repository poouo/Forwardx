import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("both product managers use shared sortable cards, table rows, optimistic saves and rollback", () => {
  for (const file of ["../pages/Plans.tsx", "./TrafficBillingConfigManager.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /useOptimisticSortableOrder\(/);
    assert.match(source, /useSortableReorder\(/);
    assert.match(source, /strategy=\{\w+ === "card" \? "rect" : "vertical"\}/);
    assert.equal((source.match(/<SortableDragHandle /g) || []).length, 2);
    assert.match(source, /itemKind="row" disabled=/);
    assert.match(source, /<TableRow \{\.\.\.itemProps\} className="group\/sortable"/);
    assert.match(source, /onError: \(\) => \w+\.release\(requestId\)/);
    assert.match(source, /onSettled: \(\) => \w+\.resync\(requestId,/);
    assert.doesNotMatch(source, /AutoAnimateContainer as=\{TableBody\}/);
  }
  const plans = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  assert.match(plans, /startIndex: \(planPagination.currentPage - 1\) \* planPagination.pageSize/);
  assert.match(plans, /planPageQuery.isPlaceholderData \|\| reorderPlans.isPending/);
});

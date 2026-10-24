import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("both product managers use sortable cards only, with optimistic saves and rollback", () => {
  for (const file of ["../pages/Plans.tsx", "./TrafficBillingConfigManager.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /useOptimisticSortableOrder\(/);
    assert.match(source, /useSortableReorder\(/);
    assert.match(source, /<SortableReorderContext sortable=\{\w+\} strategy="rect">/);
    assert.equal((source.match(/<SortableDragHandle /g) || []).length, 1);
    assert.doesNotMatch(source, /<Table|itemKind="row"|ViewMode|列表视图|卡片视图|\.viewMode/);
    assert.match(source, /onError: \(\) => \w+\.release\(requestId\)/);
    assert.match(source, /onSettled: \(\) => \w+\.resync\(requestId,/);
    assert.doesNotMatch(source, /AutoAnimateContainer as=\{TableBody\}/);
  }
  const plans = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  assert.match(plans, /startIndex: \(planPagination.currentPage - 1\) \* planPagination.pageSize/);
  assert.match(plans, /planPageQuery.isPlaceholderData \|\| reorderPlans.isPending/);
});

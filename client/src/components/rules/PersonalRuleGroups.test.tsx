import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleGroupBulkApplyButton, RuleGroupBulkPagination } from "./PersonalRuleGroups";

type Editor = Parameters<typeof RuleGroupBulkApplyButton>[0]["editor"];
function editor(overrides: Partial<Editor> = {}): Editor {
  return {
    ids: [1, 2, 3], canApply: true, isPending: false, apply: async () => {},
    page: 1, setPage: () => {}, query: { data: { page: 1, totalPages: 3 }, isFetching: false },
    ...overrides,
  } as Editor;
}

test("group Apply renders independently in the footer with count and disabled state", () => {
  const active = renderToStaticMarkup(<RuleGroupBulkApplyButton editor={editor()} />);
  assert.match(active, /应用到 3 条规则/);
  assert.match(active, /type="button"/);
  assert.doesNotMatch(active, /disabled=""/);
  for (const ids of [[], [1, 2]]) {
    const disabled = renderToStaticMarkup(<RuleGroupBulkApplyButton editor={editor({ ids, canApply: false })} />);
    assert.match(disabled, /disabled=""/);
  }
});

test("group footer pagination disables page changes while fetching or saving", () => {
  const ready = renderToStaticMarkup(<RuleGroupBulkPagination editor={editor()} />);
  assert.equal((ready.match(/disabled=""/g) || []).length, 1);
  assert.match(ready, /1 \/ 3/);
  for (const state of [editor({ isPending: true }), editor({ query: { data: { page: 1, totalPages: 3 }, isFetching: true } as Editor["query"] })]) {
    const html = renderToStaticMarkup(<RuleGroupBulkPagination editor={state} />);
    assert.equal((html.match(/disabled=""/g) || []).length, 2);
  }
  const last = renderToStaticMarkup(<RuleGroupBulkPagination editor={editor({ page: 3, query: { data: { page: 3, totalPages: 3 }, isFetching: false } as Editor["query"] })} />);
  assert.equal((last.match(/disabled=""/g) || []).length, 1);
  assert.match(last, /3 \/ 3/);
});

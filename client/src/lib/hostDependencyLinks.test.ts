import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { useUrlTab } from "../hooks/useUrlTab";
import { hostDependencyGroupTarget } from "./hostDependencyLinks";

test("host dependencies navigate to their real resource type, not the old failover-only page", () => {
  for (const [mode, tab, label] of [
    ["port", "ports", "端口转发"], ["failover", "groups", "转发组"],
    ["chain", "chains", "转发链"], ["entry", "entries", "入口组"], ["exit", "exits", "出口组"],
  ]) assert.deepEqual(hostDependencyGroupTarget(mode), { href: `/tunnels?tab=${tab}`, label });
  for (const mode of [null, undefined, "", "legacy", "__proto__", "constructor"]) {
    assert.deepEqual(hostDependencyGroupTarget(mode), hostDependencyGroupTarget("failover"));
  }
});

test("resource query failures are distinct from an authoritative empty list", () => {
  const ui = fs.readFileSync("client/src/pages/ForwardGroups.tsx", "utf8");
  assert.match(ui, /groupPageQuery.isError \? \([\s\S]*?role="alert"[\s\S]*?groupPageQuery.refetch\(\)[\s\S]*?visibleGroups.length > 0/);
});

test("resource links select the requested tab using Wouter's separate search value", () => {
  const values = ["tunnels", "ports", "chains", "groups", "entries", "exits"] as const;
  function Preview() {
    const [tab] = useUrlTab({ values, defaultValue: "tunnels" });
    return createElement("span", null, tab);
  }
  for (const tab of values) {
    const html = renderToStaticMarkup(createElement(Router, { ssrPath: "/tunnels", ssrSearch: `?tab=${tab}`, children: createElement(Preview) }));
    assert.equal(html, `<span>${tab}</span>`);
  }
  assert.equal(renderToStaticMarkup(createElement(Router, { ssrPath: "/tunnels", ssrSearch: "?tab=invalid", children: createElement(Preview) })), "<span>tunnels</span>");
});

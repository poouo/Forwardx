import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Send } from "lucide-react";
import { SlidingTabsList, shouldUseCompactTabs, tabScrollTarget } from "./sliding-tabs";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { DialogFooter } from "./dialog";
import { Button } from "./button";

test("sliding tabs reserve intrinsic translated label, icon and badge widths", () => {
  const html = renderToStaticMarkup(<Tabs value="notifications">
    <SlidingTabsList activeValue="notifications" onValueChange={() => {}} ariaLabel="Settings" items={[
      { value: "system", label: "System Configuration" },
      { value: "notifications", label: "Notification Channels", icon: Send, badge: 1234 },
      { value: "backup", label: "Backup & Restore" },
    ]} />
  </Tabs>);
  assert.match(html, /repeat\(3, minmax\(max-content, auto\)\)/);
  assert.match(html, /width:max-content/);
  assert.match(html, /max-w-full overflow-x-auto/);
  assert.match(html, /Notification Channels/);
  assert.match(html, /1234/);
  assert.match(html, /min-w-max whitespace-nowrap/);
  assert.match(html, /data-state="active"[^>]*id="[^"]*-trigger-notifications"/);
  assert.doesNotMatch(html, /minmax\(0, 1fr\)|truncate/);
});

test("narrow section navigation folds only when its actual labels overflow", () => {
  assert.equal(shouldUseCompactTabs(320, 740), true, "phone with six sections");
  assert.equal(shouldUseCompactTabs(553, 740), true, "narrow desktop window");
  assert.equal(shouldUseCompactTabs(620, 660), true, "dialog in a wide viewport");
  assert.equal(shouldUseCompactTabs(320, 280), false, "two fitting sections stay one-tap");
  assert.equal(shouldUseCompactTabs(767, 900), true);
  assert.equal(shouldUseCompactTabs(768, 900), false, "desktop retains its scrollable tabs");
  assert.equal(shouldUseCompactTabs(320, 320.5), false, "ignore subpixel rounding");
  assert.equal(shouldUseCompactTabs(0, 740), false, "hidden/unmeasured container");
});

test("all section switchers use their existing controlled change handlers", () => {
  const bindings: Record<string, readonly string[]> = {
    Settings: ["handleTabChange"],
    Hosts: ["setActiveManageTab"],
    Tunnels: ["setActiveSection"],
    Rules: ["handleRuleCategoryChange", "setRouteMode"],
    Users: ["handleManageTypeChange"],
    Plans: ["setActiveTab"],
    Payments: ["setActiveTab"],
    Billing: ["setActiveTab"],
    Plugins: ["setActiveSection"],
  };
  for (const [page, handlers] of Object.entries(bindings)) {
    const source = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
    const lists = source.match(/<SlidingTabsList\b[\s\S]*?\/>/g) || [];
    assert.equal(lists.length, handlers.length, page);
    for (const [index, handler] of handlers.entries()) {
      assert.ok(lists[index].includes(`onValueChange={${handler}}`), `${page}: ${handler}`);
      assert.match(lists[index], /ariaLabel=/);
    }
  }
  const component = readFileSync("client/src/components/ui/sliding-tabs.tsx", "utf8");
  assert.match(component, /aria-hidden=\{compact \|\| undefined\} inert=\{compact \|\| undefined\}/);
  assert.match(component, /shouldUseCompactTabs\(container.clientWidth, list.offsetWidth\)/);
  assert.match(component, /textValue=\{item.label\} disabled=\{item.disabled\}/);
});

test("standard tabs wrap long labels and dialog actions may grow without shrinking icons", () => {
  const html = renderToStaticMarkup(<>
    <Tabs value="a"><TabsList className="grid grid-cols-2"><TabsTrigger value="a">Long translated action</TabsTrigger></TabsList></Tabs>
    <DialogFooter><Button><Send />Save Notification Settings</Button></DialogFooter>
  </>);
  assert.match(html, /min-h-10 flex-wrap/);
  assert.match(html, /whitespace-normal text-center/);
  assert.match(html, /responsive-actions/);
  assert.match(html, /sm:flex-wrap/);
  assert.match(html, /\[&amp;&gt;svg\]:shrink-0/);
});

test("tab roots can shrink inside dialog grids without changing Radix semantics", () => {
  const html = renderToStaticMarkup(<Tabs defaultValue="a" orientation="vertical" className="space-y-4" id="dialog-tabs">
    <TabsList><TabsTrigger value="a">Section</TabsTrigger></TabsList>
  </Tabs>);
  assert.match(html, /class="min-w-0 space-y-4"/);
  assert.match(html, /id="dialog-tabs"/);
  assert.match(html, /data-orientation="vertical"/);
  assert.match(html, /aria-selected="true"/);
});

test("tab scrolling only reveals clipped labels and clamps to the local scroller", () => {
  assert.equal(tabScrollTarget(0, 300, 900, 30, 120), 0, "visible labels stay still");
  assert.equal(tabScrollTarget(0, 300, 900, 300, 160), 160, "reveal right edge");
  assert.equal(tabScrollTarget(300, 300, 900, 180, 120), 180, "reveal left edge");
  assert.equal(tabScrollTarget(0, 300, 900, 150, 420), 150, "oversized label starts at its left edge");
  assert.equal(tabScrollTarget(0, 300, 250, 50, 200), 0, "no overflow");
  assert.equal(tabScrollTarget(0, 300, 900, 820, 100), 600, "clamp at right end");
  assert.equal(tabScrollTarget(0, 300, 900, -10, 100), 0, "clamp at left end");
});

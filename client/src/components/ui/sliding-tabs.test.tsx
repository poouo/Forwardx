import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Send } from "lucide-react";
import { SlidingTabsList, tabScrollTarget } from "./sliding-tabs";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { DialogFooter } from "./dialog";
import { Button } from "./button";

test("sliding tabs reserve intrinsic translated label, icon and badge widths", () => {
  const html = renderToStaticMarkup(<Tabs value="notifications">
    <SlidingTabsList activeValue="notifications" ariaLabel="Settings" items={[
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

test("tab scrolling only reveals clipped labels and clamps to the local scroller", () => {
  assert.equal(tabScrollTarget(0, 300, 900, 30, 120), 0, "visible labels stay still");
  assert.equal(tabScrollTarget(0, 300, 900, 300, 160), 160, "reveal right edge");
  assert.equal(tabScrollTarget(300, 300, 900, 180, 120), 180, "reveal left edge");
  assert.equal(tabScrollTarget(0, 300, 900, 150, 420), 150, "oversized label starts at its left edge");
  assert.equal(tabScrollTarget(0, 300, 250, 50, 200), 0, "no overflow");
  assert.equal(tabScrollTarget(0, 300, 900, 820, 100), 600, "clamp at right end");
  assert.equal(tabScrollTarget(0, 300, 900, -10, 100), 0, "clamp at left end");
});

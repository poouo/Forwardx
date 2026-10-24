import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSidebarSwipeRecognizer } from "./sidebarSwipe";

const start = { x: 24, y: 200, open: false, side: "left" as const, viewportWidth: 390 };

test("swipe opens from the left region and closes from the drawer or backdrop", () => {
  const g = createSidebarSwipeRecognizer();
  assert.equal(g.start(start), true);
  assert.equal(g.move({ x: 42, y: 202 }), true);
  assert.deepEqual(g.end({ x: 110, y: 206 }), { claimed: true, open: true });
  for (const x of [150, 350]) {
    g.start({ ...start, open: true, x });
    assert.deepEqual(g.end({ x: x - 90, y: 205 }), { claimed: true, open: false });
  }
});

test("opening only starts near the drawer edge and short drags do not toggle", () => {
  const g = createSidebarSwipeRecognizer();
  assert.equal(g.start({ ...start, x: 100 }), false);
  assert.equal(g.end({ x: 200, y: 200 }).open, null);
  assert.equal(g.start({ ...start, x: 70 }), true);
  assert.deepEqual(g.end({ x: 95, y: 200 }), { claimed: true, open: null });
  g.start(start);
  assert.deepEqual(g.end({ x: 25, y: 201 }), { claimed: false, open: null });
});

test("vertical, diagonal and initially opposite gestures never become sidebar swipes", () => {
  const g = createSidebarSwipeRecognizer();
  for (const first of [{ x: 26, y: 225 }, { x: 50, y: 225 }, { x: 8, y: 200 }]) {
    g.start(start);
    assert.equal(g.move(first), false);
    assert.deepEqual(g.end({ x: 150, y: 228 }), { claimed: false, open: null });
  }
  g.start(start);
  g.move({ x: 65, y: 202 });
  assert.equal(g.end({ x: 10, y: 204 }).open, null);
});

test("touch cancellation and subsequent gestures cannot reuse a previous start", () => {
  const g = createSidebarSwipeRecognizer();
  g.start(start);
  g.move({ x: 70, y: 200 });
  g.cancel();
  assert.deepEqual(g.end({ x: 160, y: 200 }), { claimed: false, open: null });
  g.start(start);
  assert.equal(g.end({ x: 110, y: 200 }).open, true);
  assert.equal(g.end({ x: 10, y: 200 }).open, null);
});

test("right-side drawers mirror the gesture and narrow screens retain a small edge region", () => {
  const g = createSidebarSwipeRecognizer();
  g.start({ ...start, x: 370, side: "right" });
  assert.equal(g.end({ x: 290, y: 204 }).open, true);
  g.start({ ...start, open: true, x: 200, side: "right" });
  assert.equal(g.end({ x: 280, y: 204 }).open, false);
  assert.equal(g.start({ ...start, viewportWidth: 320, x: 70 }), false);
});

test("mobile-only binding guards dialogs, controls, horizontal scrollers and synthetic clicks", () => {
  const sidebar = readFileSync("client/src/components/ui/sidebar.tsx", "utf8");
  const binding = readFileSync("client/src/lib/sidebarSwipe.ts", "utf8");
  assert.match(sidebar, /if \(!isMobile \|\| collapsible === "none"\) return/);
  assert.match(sidebar, /return bindSidebarSwipe\(document/);
  assert.match(sidebar, /data-sidebar-wrapper=""/);
  assert.match(binding, /dialogScrollLock/);
  assert.match(binding, /scrollWidth > node.clientWidth/);
  assert.match(binding, /touches.length !== 1/);
  assert.match(binding, /result.claimed && event.cancelable\) event.preventDefault/);
  assert.match(binding, /removeEventListener\("touchmove", onMove, true\)/);
});

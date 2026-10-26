import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { globeTooltipPosition } from "./globeTooltipPosition";

const bounds = { left: 120, top: 80, right: 820, bottom: 540 };
const size = { width: 300, height: 240 };

test("a tall tooltip flips above before it reaches the bottom UI", () => {
  // 140px from the bottom: the library's 100px threshold used to miss this.
  const point = globeTooltipPosition(bounds, { x: 480, y: 400 }, size);
  assert.equal(point.y, 144);
  assert.ok(point.y + size.height < 400);
});

test("globe tooltip remains inside every stage and visible-viewport edge", () => {
  for (const x of [120, 130, 480, 810, 820]) {
    for (const y of [80, 90, 300, 530, 540]) {
      const point = globeTooltipPosition(bounds, { x, y }, size);
      assert.ok(point.x >= bounds.left + 12);
      assert.ok(point.y >= bounds.top + 12);
      assert.ok(point.x + size.width <= bounds.right - 12);
      assert.ok(point.y + size.height <= bounds.bottom - 12);
    }
  }
});

test("short or partially scrolled viewports constrain large tooltip dimensions", () => {
  const visible = { left: 0, top: 0, right: 260, bottom: 190 };
  const limits = globeTooltipPosition(visible, { x: 250, y: 180 }, size);
  assert.equal(limits.maxWidth, 236);
  assert.equal(limits.maxHeight, 166);
  const fitted = globeTooltipPosition(visible, { x: 250, y: 180 }, { width: limits.maxWidth, height: limits.maxHeight });
  assert.equal(fitted.x, 12);
  assert.equal(fitted.y, 12);
});

test("shared tooltip resets the black shell, clears stacking traps and cleans up tracking", () => {
  const source = readFileSync("client/src/components/GlobeWorkspace.tsx", "utf8");
  assert.match(source, /return trackGlobeTooltip\(element\)/);
  assert.doesNotMatch(source, /className="absolute inset-0 z-\[1\]"/);
  const css = readFileSync("client/src/styles/globe.css", "utf8");
  assert.match(css, /\.globe-stage \.float-tooltip-kap\s*\{[^}]*padding: 0;[^}]*background: transparent;[^}]*z-index: 4;/s);
  const tracking = readFileSync("client/src/lib/globeTooltipPosition.ts", "utf8");
  assert.match(tracking, /Math\.min\(window.innerHeight, rect.bottom\)/);
  assert.match(tracking, /cancelAnimationFrame\(frame\)/);
  assert.match(tracking, /observer.disconnect\(\)/);
  assert.match(tracking, /resizeObserver\?\.disconnect\(\)/);
  assert.match(tracking, /removeEventListener\("mousemove", move\)/);
  assert.match(tracking, /removeEventListener\("scroll", schedule, true\)/);
});

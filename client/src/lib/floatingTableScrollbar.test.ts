import assert from "node:assert/strict";
import test from "node:test";
import { floatingScrollbarLayout } from "./floatingTableScrollbar";

const example = {
  rect: { left: 240, top: 300, right: 1440, bottom: 2400 },
  viewport: { left: 0, top: 0, right: 1440, bottom: 900 },
  clientWidth: 1200, scrollWidth: 2100,
};

test("long wide tables have a control in the visible viewport with an identical scroll range", () => {
  const layout = floatingScrollbarLayout(example);
  assert.deepEqual(layout, { left: 240, top: 880, width: 1200, contentWidth: 2100 });
  assert.equal(layout!.contentWidth - layout!.width, example.scrollWidth - example.clientWidth);
});

test("return to the natural scrollbar at the table bottom and hide outside the viewport", () => {
  for (const rect of [
    { ...example.rect, bottom: 880 },
    { ...example.rect, top: -2200, bottom: -100 },
    { ...example.rect, top: 950 },
    { ...example.rect, top: 870 },
  ]) assert.equal(floatingScrollbarLayout({ ...example, rect }), null);
});

test("no extra control for fitting, empty or mobile-hidden tables", () => {
  for (const [clientWidth, scrollWidth] of [[1200, 1200], [1200, 1201], [0, 2100], [0, 0]]) {
    assert.equal(floatingScrollbarLayout({ ...example, clientWidth, scrollWidth }), null);
  }
});

test("clipped width and nested scrollports keep the same scroll distance", () => {
  const layout = floatingScrollbarLayout({ ...example, viewport: { left: 300, top: 120, right: 1000, bottom: 700 } });
  assert.deepEqual(layout, { left: 300, top: 680, width: 700, contentWidth: 1600 });
  assert.equal(layout!.contentWidth - layout!.width, 900);
});

test("columns resized to fit hide the control; widening them restores the range", () => {
  assert.equal(floatingScrollbarLayout({ ...example, scrollWidth: 1190 }), null);
  assert.equal(floatingScrollbarLayout({ ...example, scrollWidth: 2500 })?.contentWidth, 2500);
});

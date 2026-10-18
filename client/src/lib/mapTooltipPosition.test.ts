import assert from "node:assert/strict";
import test from "node:test";
import { mapTooltipPosition } from "./mapTooltipPosition";

const base = { width: 820, height: 460, tooltipWidth: 288, tooltipHeight: 280 };
function check(input: Parameters<typeof mapTooltipPosition>[0]) {
  const point = mapTooltipPosition(input);
  assert.ok(point.x >= 8 && point.y >= 8);
  assert.ok(point.x + input.tooltipWidth <= input.width - 8);
  assert.ok(point.y + input.tooltipHeight <= input.height - 8);
  const region = input.region;
  assert.ok(point.x + input.tooltipWidth <= region.left || point.x >= region.right ||
    point.y + input.tooltipHeight <= region.top || point.y >= region.bottom, `tooltip overlaps active province: ${JSON.stringify(point)}`);
  return point;
}

test("Taiwan and eastern-edge provinces flip to the left instead of clamping over the hovered region", () => {
  const region = { left: 690, right: 718, top: 305, bottom: 357 };
  const point = check({ ...base, region, pointer: { x: 706, y: 330 } });
  assert.ok(point.x + base.tooltipWidth <= region.left - 16);
});

test("western, northern and southern provinces remain visible with all four tooltip placements", () => {
  for (const [x, y] of [[25, 170], [410, 25], [410, 420], [790, 170], [400, 230]]) {
    check({ ...base, region: { left: x - 12, right: x + 12, top: y - 12, bottom: y + 12 }, pointer: { x, y } });
  }
});

test("avoid the whole province, not just the point under the cursor", () => {
  const region = { left: 220, right: 490, top: 100, bottom: 340 };
  check({ ...base, region, pointer: { x: 255, y: 180 } });
});

test("measured content growth and narrow maps can change the chosen side", () => {
  const input = { width: 440, height: 460, tooltipWidth: 288, region: { left: 310, right: 335, top: 350, bottom: 385 }, pointer: { x: 325, y: 370 } };
  for (const tooltipHeight of [180, 280, 310]) {
    const point = check({ ...input, tooltipHeight });
    assert.ok(point.y + tooltipHeight <= input.region.top);
  }
});

test("oversized regions fall back deterministically without negative or off-map coordinates", () => {
  const input = { ...base, region: { left: 10, right: 810, top: 10, bottom: 450 }, pointer: { x: 400, y: 220 } };
  const point = mapTooltipPosition(input);
  assert.ok(point.x >= 8 && point.x + base.tooltipWidth <= base.width - 8);
  assert.ok(point.y >= 8 && point.y + base.tooltipHeight <= base.height - 8);
  assert.deepEqual(mapTooltipPosition(input), point);
  const edgePointer = { x: 780, y: 220 };
  const edgePosition = mapTooltipPosition({ ...input, pointer: edgePointer });
  assert.ok(edgePosition.x + base.tooltipWidth < edgePointer.x || edgePosition.x > edgePointer.x ||
    edgePosition.y + base.tooltipHeight < edgePointer.y || edgePosition.y > edgePointer.y, "keep the hovered point visible even if the full region cannot fit");
});

type Rect = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };

/** Prefer a nearby side with enough room. Clamping alone can move a tooltip
 * back over the province, so compare all four sides after applying bounds. */
export function mapTooltipPosition({ width, height, tooltipWidth, tooltipHeight, region, pointer }: {
  width: number; height: number; tooltipWidth: number; tooltipHeight: number;
  region: Rect; pointer: Point;
}): Point {
  const padding = 8, gap = 16;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const fit = (point: Point): Point => ({
    x: clamp(point.x, padding, width - tooltipWidth - padding),
    y: clamp(point.y, padding, height - tooltipHeight - padding),
  });
  const avoid = {
    left: Math.min(region.left, pointer.x) - gap,
    top: Math.min(region.top, pointer.y) - gap,
    right: Math.max(region.right, pointer.x) + gap,
    bottom: Math.max(region.bottom, pointer.y) + gap,
  };
  const candidates = [
    { x: avoid.right, y: pointer.y - 24 },
    { x: avoid.left - tooltipWidth, y: pointer.y - 24 },
    { x: pointer.x - tooltipWidth / 2, y: avoid.top - tooltipHeight },
    { x: pointer.x - tooltipWidth / 2, y: avoid.bottom },
  ].map(fit);
  const overlap = (point: Point) => Math.max(0, Math.min(point.x + tooltipWidth, avoid.right) - Math.max(point.x, avoid.left)) *
    Math.max(0, Math.min(point.y + tooltipHeight, avoid.bottom) - Math.max(point.y, avoid.top));
  const score = (point: Point) => overlap(point) +
    (pointer.x >= point.x - padding && pointer.x <= point.x + tooltipWidth + padding &&
      pointer.y >= point.y - padding && pointer.y <= point.y + tooltipHeight + padding ? width * height * 2 : 0);
  // If every side is too small (e.g. zoomed/narrow layouts), stay in bounds and
  // obscure as little of the active province as physically possible.
  return candidates.reduce((best, point) => score(point) < score(best) ? point : best);
}

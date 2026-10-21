export type ScrollViewport = { left: number; top: number; right: number; bottom: number };
export type FloatingScrollbarLayout = { left: number; top: number; width: number; contentWidth: number };

/** Match the table's scroll range, even when an ancestor clips its visible width. */
export function floatingScrollbarLayout({
  rect, viewport, clientWidth, scrollWidth, barHeight = 16,
}: {
  rect: ScrollViewport;
  viewport: ScrollViewport;
  clientWidth: number;
  scrollWidth: number;
  barHeight?: number;
}): FloatingScrollbarLayout | null {
  const range = scrollWidth - clientWidth;
  const left = Math.max(rect.left, viewport.left);
  const right = Math.min(rect.right, viewport.right);
  const visibleTop = Math.max(rect.top, viewport.top);
  const visibleBottom = Math.min(rect.bottom, viewport.bottom);
  // Use the real scrollbar when the table bottom is already in view. Keep
  // floating controls out of very small slivers and hidden/mobile tables.
  if (clientWidth <= 0 || range <= 1 || right - left < 64
    || visibleBottom - visibleTop < 64 || rect.bottom <= viewport.bottom + 1) return null;
  return { left, top: visibleBottom - barHeight - 4, width: right - left, contentWidth: right - left + range };
}

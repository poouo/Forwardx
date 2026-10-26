type Bounds = { left: number; top: number; right: number; bottom: number };

/** Use the actual tooltip height, not float-tooltip's fixed 100px flip threshold. */
export function globeTooltipPosition(bounds: Bounds, pointer: { x: number; y: number }, size: { width: number; height: number }) {
  const padding = 12, gap = 16;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const below = pointer.y + gap;
  const above = pointer.y - gap - size.height;
  const y = below + size.height <= bounds.bottom - padding ? below
    : above >= bounds.top + padding ? above
      : bounds.bottom - pointer.y >= pointer.y - bounds.top ? below : above;
  return {
    x: clamp(pointer.x - size.width / 2, bounds.left + padding, bounds.right - padding - size.width),
    y: clamp(y, bounds.top + padding, bounds.bottom - padding - size.height),
    maxWidth: Math.max(1, bounds.right - bounds.left - padding * 2),
    maxHeight: Math.max(1, bounds.bottom - bounds.top - padding * 2),
  };
}

/** One frame per pointer/layout change; no render-loop work or React state updates. */
export function trackGlobeTooltip(stage: HTMLElement) {
  let pointer: { x: number; y: number } | undefined;
  let tooltip: HTMLElement | null = null;
  let frame = 0;
  const position = () => {
    frame = 0;
    if (!pointer) return;
    const next = stage.querySelector<HTMLElement>(".float-tooltip-kap");
    if (next !== tooltip) {
      if (tooltip) resizeObserver?.unobserve(tooltip);
      tooltip = next;
      if (tooltip) resizeObserver?.observe(tooltip);
    }
    if (!tooltip) return;
    const rect = stage.getBoundingClientRect();
    const bounds = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(window.innerWidth, rect.right), bottom: Math.min(window.innerHeight, rect.bottom) };
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
    const limits = globeTooltipPosition(bounds, pointer, { width: 0, height: 0 });
    tooltip.style.setProperty("--globe-tooltip-max-width", `${limits.maxWidth}px`);
    tooltip.style.setProperty("--globe-tooltip-max-height", `${limits.maxHeight}px`);
    const size = tooltip.getBoundingClientRect();
    if (!size.width || !size.height) return;
    const point = globeTooltipPosition(bounds, pointer, size);
    const origin = (tooltip.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? rect;
    tooltip.style.setProperty("--globe-tooltip-x", `${point.x - origin.left}px`);
    tooltip.style.setProperty("--globe-tooltip-y", `${point.y - origin.top}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
  const move = (event: MouseEvent) => { pointer = { x: event.clientX, y: event.clientY }; schedule(); };
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resizeObserver?.observe(stage);
  // Content can arrive after mousemove (the globe raycaster runs independently).
  // Do not observe styles: both float-tooltip and our positioning write them.
  const observer = new MutationObserver(schedule);
  observer.observe(stage, { childList: true, subtree: true, characterData: true });
  stage.addEventListener("mousemove", move, { passive: true });
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    resizeObserver?.disconnect();
    stage.removeEventListener("mousemove", move);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
  };
}

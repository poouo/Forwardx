type Point = { x: number; y: number };
type SwipeStart = Point & { open: boolean; side: "left" | "right"; viewportWidth: number };

const EDGE_WIDTH = 72;
const DIRECTION_SLOP = 10;
const SWIPE_DISTANCE = 56;
const HORIZONTAL_RATIO = 1.35;

/** Lock the initial direction so vertical scrolling cannot turn into a drawer swipe. */
export function createSidebarSwipeRecognizer() {
  let start: SwipeStart | null = null;
  let claimed = false;
  const cancel = () => { start = null; claimed = false; };
  const move = (point: Point) => {
    if (!start) return false;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const x = Math.abs(dx);
    const y = Math.abs(dy);
    const direction = (start.side === "left" ? 1 : -1) * (start.open ? -1 : 1);
    if (!claimed) {
      if (Math.max(x, y) < DIRECTION_SLOP) return false;
      if (y > x || dx * direction < 0 || (Math.max(x, y) > 24 && x < y * HORIZONTAL_RATIO)) {
        cancel();
        return false;
      }
      if (x >= y * HORIZONTAL_RATIO) claimed = true;
    }
    return claimed;
  };
  return {
    start(value: SwipeStart) {
      cancel();
      const edge = Math.min(EDGE_WIDTH, value.viewportWidth * 0.2);
      const fromEdge = value.side === "left" ? value.x : value.viewportWidth - value.x;
      if (value.open || (fromEdge >= 0 && fromEdge <= edge)) start = value;
      return start !== null;
    },
    move,
    end(point: Point): { claimed: boolean; open: boolean | null } {
      move(point);
      const active = start;
      const result = {
        claimed,
        open: active && claimed && Math.abs(point.x - active.x) >= SWIPE_DISTANCE
          && Math.abs(point.x - active.x) >= Math.abs(point.y - active.y) * HORIZONTAL_RATIO
          && (point.x - active.x) * (active.side === "left" ? 1 : -1) * (active.open ? -1 : 1) > 0
          ? !active.open : null,
      };
      cancel();
      return result;
    },
    cancel,
  };
}

const IGNORE_TARGET = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], canvas, video, .recharts-wrapper, [data-sidebar-swipe-ignore]';

function canStartFrom(target: EventTarget | null, doc: Document) {
  if (!(target instanceof Element) || !target.closest('[data-sidebar-wrapper]') || target.closest(IGNORE_TARGET)) return false;
  for (let node: Element | null = target; node && node !== doc.body; node = node.parentElement) {
    // Horizontal tables, day strips and custom scrollers own their gestures.
    if (node.scrollWidth > node.clientWidth + 2 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)) return false;
  }
  return true;
}

/** Touch listeners do not add an invisible hit area over page controls. */
export function bindSidebarSwipe(doc: Document, options: {
  side: "left" | "right";
  getOpen: () => boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const gesture = createSidebarSwipeRecognizer();
  let touchId: number | null = null;
  const blocked = () => Boolean(doc.body.dataset.dialogScrollLock || doc.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  ));
  const cancel = () => { gesture.cancel(); touchId = null; };
  const onStart = (event: TouchEvent) => {
    cancel();
    if (event.touches.length !== 1 || blocked() || !canStartFrom(event.target, doc)) return;
    const touch = event.touches[0];
    if (gesture.start({ x: touch.clientX, y: touch.clientY, open: options.getOpen(), side: options.side, viewportWidth: doc.documentElement.clientWidth })) touchId = touch.identifier;
  };
  const onMove = (event: TouchEvent) => {
    if (touchId === null) return;
    if (event.touches.length !== 1 || blocked() || !event.cancelable) { cancel(); return; }
    const touch = Array.from(event.touches).find(item => item.identifier === touchId);
    if (touch && gesture.move({ x: touch.clientX, y: touch.clientY })) event.preventDefault();
  };
  const onEnd = (event: TouchEvent) => {
    if (touchId === null) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === touchId);
    if (!touch || blocked() || event.touches.length) { cancel(); return; }
    const result = gesture.end({ x: touch.clientX, y: touch.clientY });
    touchId = null;
    // Suppress the synthetic click on a menu link/backdrop after a horizontal drag.
    if (result.claimed && event.cancelable) event.preventDefault();
    if (result.open !== null) options.onOpenChange(result.open);
  };
  doc.addEventListener("touchstart", onStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", onMove, { capture: true, passive: false });
  doc.addEventListener("touchend", onEnd, { capture: true, passive: false });
  doc.addEventListener("touchcancel", cancel, { capture: true, passive: true });
  return () => {
    cancel();
    doc.removeEventListener("touchstart", onStart, true);
    doc.removeEventListener("touchmove", onMove, true);
    doc.removeEventListener("touchend", onEnd, true);
    doc.removeEventListener("touchcancel", cancel, true);
  };
}

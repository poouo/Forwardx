import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "@/i18n";
import { floatingScrollbarLayout, type FloatingScrollbarLayout, type ScrollViewport } from "@/lib/floatingTableScrollbar";

/** A reachable horizontal scrollbar outside transformed/clipped table cards. */
export default function FloatingTableScrollbar({ target, enabled }: {
  target: RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const drag = useRef<{ pointer: number; x: number; offset: number; scale: number } | null>(null);
  const [layout, setLayout] = useState<FloatingScrollbarLayout | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const scroller = target.current;
    if (!enabled || !scroller) return;
    let frame = 0;
    const ancestors: HTMLElement[] = [];
    for (let node = scroller.parentElement; node; node = node.parentElement) ancestors.push(node);
    const clipped = ancestors.map(node => {
      const style = getComputedStyle(node);
      return { node, x: /auto|scroll|hidden|clip/.test(style.overflowX), y: /auto|scroll|hidden|clip/.test(style.overflowY) };
    }).filter(item => item.x || item.y);

    const syncFromTable = () => {
      setOffset(scroller.scrollLeft);
    };
    const measure = () => {
      frame = 0;
      const visual = window.visualViewport;
      const viewport: ScrollViewport = {
        left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
        right: (visual?.offsetLeft ?? 0) + (visual?.width ?? document.documentElement.clientWidth),
        bottom: (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
      };
      for (const { node, x, y } of clipped) {
        // The root scrollport is already represented by the viewport above.
        if (node === document.body || node === document.documentElement) continue;
        const bounds = node.getBoundingClientRect();
        if (x) {
          viewport.left = Math.max(viewport.left, bounds.left + node.clientLeft);
          viewport.right = Math.min(viewport.right, bounds.left + node.clientLeft + node.clientWidth);
        }
        if (y) {
          viewport.top = Math.max(viewport.top, bounds.top + node.clientTop);
          viewport.bottom = Math.min(viewport.bottom, bounds.top + node.clientTop + node.clientHeight);
        }
      }
      const bounds = scroller.getBoundingClientRect();
      const next = floatingScrollbarLayout({
        rect: { left: bounds.left + scroller.clientLeft, right: bounds.left + scroller.clientLeft + scroller.clientWidth, top: bounds.top, bottom: bounds.bottom },
        viewport, clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth,
      });
      setLayout(previous => previous?.left === next?.left && previous?.top === next?.top
        && previous?.width === next?.width && previous?.contentWidth === next?.contentWidth ? previous : next);
      syncFromTable();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const onScroll = (event: Event) => {
      if (event.target === scroller) syncFromTable();
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    for (const node of [scroller, ...ancestors, ...(scroller.firstElementChild ? [scroller.firstElementChild] : [])]) resize.observe(node);
    const intersection = new IntersectionObserver(schedule);
    intersection.observe(scroller);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("animationend", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [target, enabled]);

  if (!enabled || !layout) return null;
  const range = layout.contentWidth - layout.width;
  const thumbWidth = Math.max(32, layout.width * layout.width / layout.contentWidth);
  const travel = layout.width - thumbWidth;
  const moveTo = (value: number) => {
    if (!target.current) return;
    target.current.scrollLeft = Math.max(0, Math.min(range, value));
    setOffset(target.current.scrollLeft);
  };
  return createPortal(
    <div data-floating-table-scrollbar="" tabIndex={0} role="scrollbar" aria-label={t("左右滚动表格")}
      aria-orientation="horizontal" aria-controls={target.current?.id}
      aria-valuemin={0} aria-valuemax={Math.round(range)} aria-valuenow={Math.round(offset)}
      className="floating-table-scrollbar"
      style={{ left: layout.left, top: layout.top, width: layout.width }}
      onPointerDown={event => {
        if (event.button !== 0 || travel <= 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
        const thumbLeft = Math.min(travel, offset / range * travel);
        if (x < thumbLeft || x > thumbLeft + thumbWidth) moveTo((x - thumbWidth / 2) / travel * range);
        drag.current = { pointer: event.pointerId, x: event.clientX, offset: target.current?.scrollLeft ?? 0, scale: range / travel };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (active?.pointer === event.pointerId) moveTo(active.offset + (event.clientX - active.x) * active.scale);
      }}
      onPointerUp={event => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const current = target.current?.scrollLeft ?? 0;
        const page = target.current?.clientWidth ?? layout.width;
        const next = { ArrowLeft: current - 40, ArrowRight: current + 40, PageUp: current - page, PageDown: current + page, Home: 0, End: range }[event.key];
        if (next !== undefined) { event.preventDefault(); moveTo(next); }
      }}>
      <div className="floating-table-scrollbar-thumb" style={{ width: thumbWidth, left: Math.min(travel, offset / range * travel) }} />
    </div>, document.body,
  );
}

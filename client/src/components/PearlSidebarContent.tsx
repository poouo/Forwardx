import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { SidebarContent, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { rememberSidebarScroll } from "@/lib/sidebarScroll";
import { useMotionEnabled } from "./MotionPolicy";

type Marker = { left: number; top: number; width: number; height: number; viewport: number; rail: number; mode: string };
// The existing page architecture remounts the shell on navigation. Remember only
// the last marker geometry (not a DOM node) to keep the sliding rail continuous.
let lastMarker: Marker | null = null;

export default function PearlSidebarContent({ activeKey, scrollKey, className, children, ...props }: ComponentProps<typeof SidebarContent> & { activeKey: string; scrollKey: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const { state, isMobile } = useSidebar();
  const motionEnabled = useMotionEnabled();

  useLayoutEffect(() => {
    const content = contentRef.current;
    const marker = markerRef.current;
    if (!content || !marker) return;
    const scroll = rememberSidebarScroll(content, `${scrollKey}:${isMobile ? "mobile" : state}`);
    const interruptScrollRestore = (event: Event) => {
      if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      scroll.interrupt();
    };
    content.addEventListener("scroll", scroll.save, { passive: true });
    const scrollInputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const name of scrollInputEvents) content.addEventListener(name, interruptScrollRestore, { passive: true });
    let frame = 0;
    let animation: Animation | undefined;
    let first = true;
    let measured: Marker | null = null;
    let observer: ResizeObserver | null = null;
    let observedActive: HTMLElement | null = null;
    const heights = new WeakMap<Element, number>();
    const container = content.closest('[data-sidebar="container"]');
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => {
      // Restore before measuring the active marker and before the first paint.
      // Mutation/resize observations retry if async menu items were missing.
      scroll.restore();
      const active = content.querySelector<HTMLElement>('[data-sidebar="menu-button"][data-active="true"]');
      if (observedActive !== active) {
        if (observedActive) observer?.unobserve(observedActive);
        observedActive = active;
        if (active) observer?.observe(active);
      }
      if (!active) {
        marker.hidden = true;
        delete content.dataset.indicatorReady;
        lastMarker = null;
        measured = null;
        return;
      }
      const bounds = content.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      const next: Marker = {
        left: target.left - bounds.left + content.scrollLeft,
        top: target.top - bounds.top + content.scrollTop,
        width: target.width, height: target.height,
        viewport: window.innerWidth, rail: bounds.width,
        mode: isMobile ? "mobile" : state,
      };
      // ResizeObserver fires once on registration. Don't cancel a navigation
      // animation (or touch styles on every data refresh) for identical bounds.
      if (measured && Object.keys(next).every(key => next[key as keyof Marker] === measured![key as keyof Marker])) return;
      measured = next;
      marker.hidden = false;
      // Let CSS track the rail's width. Re-measuring every menu item during
      // the width transition used to force geometry reads/writes every frame.
      const centered = !isMobile && state === "collapsed";
      const buttonStyle = getComputedStyle(active);
      Object.assign(marker.style, {
        left: centered ? `calc(50% - ${next.width / 2}px)` : `${next.left}px`,
        // Menus use symmetric gutters. Measuring the right gap while the rail
        // is still narrow would capture the button's padding-clamped width.
        right: centered ? `calc(50% - ${next.width / 2}px)` : `${next.left}px`,
        minWidth: `${parseFloat(buttonStyle.paddingLeft) + parseFloat(buttonStyle.paddingRight)}px`,
        top: `${next.top}px`, height: `${next.height}px`,
      });
      content.dataset.indicatorReady = "true";
      const previous = lastMarker;
      animation?.cancel();
      if (first && previous && previous.mode === next.mode && previous.viewport === next.viewport && previous.rail === next.rail
        && (previous.left !== next.left || previous.top !== next.top)
        && motionEnabled && !document.hidden && !reducedMotion.matches
        && typeof marker.animate === "function") {
        animation = marker.animate([
          { transform: `translate(${previous.left - next.left}px, ${previous.top - next.top}px)` },
          { transform: "translate(0, 0)" },
        ], { duration: 480, easing: "cubic-bezier(.22,1,.36,1)" });
      }
      lastMarker = next;
      first = false;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(entries => {
      // Width-only changes are handled by the marker's left/right anchors.
      // Height changes (footer, active item) still need fresh vertical geometry.
      let heightChanged = false;
      for (const entry of entries) {
        const height = entry.contentRect.height;
        if (heights.get(entry.target) !== height) heightChanged = true;
        heights.set(entry.target, height);
      }
      if (heightChanged) schedule();
    }) : null;
    observer?.observe(content);
    measure();
    // Refresh the saved geometry once at the end, including interrupted/rapid
    // toggles, so subsequent page navigation starts at the actual final rail.
    const finishResize = (event: Event) => {
      if (event.target === container && (event as TransitionEvent).propertyName === "width") schedule();
    };
    container?.addEventListener("transitionend", finishResize);
    container?.addEventListener("transitioncancel", finishResize);
    window.addEventListener("resize", schedule);
    // Navigation can be populated asynchronously (plugins/custom pages).
    // Only watch child lists; watching our own style attributes would loop.
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { childList: true, subtree: true });
    const settle = () => { if (document.hidden || reducedMotion.matches) animation?.cancel(); };
    document.addEventListener("visibilitychange", settle);
    reducedMotion.addEventListener("change", settle);
    return () => {
      scroll.save();
      content.removeEventListener("scroll", scroll.save);
      for (const name of scrollInputEvents) content.removeEventListener(name, interruptScrollRestore);
      cancelAnimationFrame(frame);
      animation?.cancel();
      observer?.disconnect();
      mutations.disconnect();
      container?.removeEventListener("transitionend", finishResize);
      container?.removeEventListener("transitioncancel", finishResize);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", settle);
      reducedMotion.removeEventListener("change", settle);
    };
  }, [activeKey, scrollKey, state, isMobile, motionEnabled]);

  return <SidebarContent ref={contentRef} className={cn("pearl-nav-content", className)} {...props}>
    <span ref={markerRef} className="pearl-nav-indicator" aria-hidden="true" hidden />
    {children}
  </SidebarContent>;
}

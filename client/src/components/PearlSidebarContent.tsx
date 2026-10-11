import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { SidebarContent, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type Marker = { left: number; top: number; width: number; height: number; viewport: number; rail: number };
// The existing page architecture remounts the shell on navigation. Remember only
// the last marker geometry (not a DOM node) to keep the sliding rail continuous.
let lastMarker: Marker | null = null;

export default function PearlSidebarContent({ activeKey, className, children, ...props }: ComponentProps<typeof SidebarContent> & { activeKey: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const { state, isMobile } = useSidebar();

  useLayoutEffect(() => {
    const content = contentRef.current;
    const marker = markerRef.current;
    if (!content || !marker) return;
    let frame = 0;
    let animation: Animation | undefined;
    let first = true;
    let measured: Marker | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => {
      const active = content.querySelector<HTMLElement>('[data-sidebar="menu-button"][data-active="true"]');
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
      };
      // ResizeObserver fires once on registration. Don't cancel a navigation
      // animation (or touch styles on every data refresh) for identical bounds.
      if (measured && Object.keys(next).every(key => next[key as keyof Marker] === measured![key as keyof Marker])) return;
      measured = next;
      marker.hidden = false;
      Object.assign(marker.style, { left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px` });
      content.dataset.indicatorReady = "true";
      const previous = lastMarker;
      animation?.cancel();
      if (first && previous && previous.viewport === next.viewport && previous.rail === next.rail
        && (previous.left !== next.left || previous.top !== next.top)
        && !document.hidden && !reducedMotion.matches
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
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(content);
    content.querySelectorAll('[data-sidebar="menu-button"]').forEach(button => observer?.observe(button));
    // Navigation can be populated asynchronously (plugins/custom pages).
    // Only watch child lists; watching our own style attributes would loop.
    const mutations = new MutationObserver(schedule);
    mutations.observe(content, { childList: true, subtree: true });
    const settle = () => { if (document.hidden || reducedMotion.matches) animation?.cancel(); };
    document.addEventListener("visibilitychange", settle);
    reducedMotion.addEventListener("change", settle);
    return () => {
      cancelAnimationFrame(frame);
      animation?.cancel();
      observer?.disconnect();
      mutations.disconnect();
      document.removeEventListener("visibilitychange", settle);
      reducedMotion.removeEventListener("change", settle);
    };
  }, [activeKey, state, isMobile]);

  return <SidebarContent ref={contentRef} className={cn("pearl-nav-content", className)} {...props}>
    <span ref={markerRef} className="pearl-nav-indicator" aria-hidden="true" hidden />
    {children}
  </SidebarContent>;
}

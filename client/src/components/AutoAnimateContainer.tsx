import autoAnimate from "@formkit/auto-animate";
import {
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { useMotionEnabled } from "./MotionPolicy";

type AutoAnimateContainerProps<T extends ElementType = "div"> = {
  as?: T;
  children: ReactNode;
  className?: string;
  duration?: number;
  layout?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "children" | "className">;

const standardCardGridClassPattern = /\bstandard-card-grid(?:-compact)?\b/;
const LAYOUT_ANIMATION_CHILD_LIMIT = 36;

function isDialogMotionLocked() {
  if (typeof document === "undefined") return false;
  const lockUntil = Number(document.body.dataset.dialogMotionLockUntil || "0");
  return document.body.hasAttribute("data-dialog-motion-lock")
    || document.body.hasAttribute("data-dialog-scroll-lock")
    || document.body.hasAttribute("data-scroll-locked")
    || Date.now() < lockUntil;
}

function measureChildren(container: Element) {
  const rects = new Map<Element, DOMRect>();
  Array.from(container.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    if (window.getComputedStyle(child).display === "none") return;
    rects.set(child, child.getBoundingClientRect());
  });
  return rects;
}

function getVisibleChildCount(container: Element) {
  let count = 0;
  Array.from(container.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    if (window.getComputedStyle(child).display === "none") return;
    count += 1;
  });
  return count;
}

export default function AutoAnimateContainer<T extends ElementType = "div">({
  as,
  children,
  className,
  duration = 180,
  layout,
  ...props
}: AutoAnimateContainerProps<T>) {
  const motionEnabled = useMotionEnabled();
  const elementRef = useRef<Element | null>(null);
  const previousRectsRef = useRef<Map<Element, DOMRect>>(new Map());
  const frameRef = useRef<number | null>(null);
  const animationsRef = useRef<WeakMap<Element, Animation>>(new WeakMap());
  const Component = (as || "div") as ElementType;
  const animateLayout = layout ?? standardCardGridClassPattern.test(className || "");
  const setRef = useCallback((node: Element | null) => {
    elementRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const container = elementRef.current;
    if (!motionEnabled) {
      Array.from(container?.children || []).forEach(child => {
        child.getAnimations?.().forEach(animation => animation.cancel());
      });
      return;
    }
    if (!(container instanceof HTMLElement)) return;
    // A grid has its own layout animator below. Running both controllers on
    // the same nodes can remeasure an in-flight transform and compound it.
    if (animateLayout) return;
    const controller = autoAnimate(container, {
      duration,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    // Fully release observers and polling when disabled, rather than just hiding motion.
    return () => controller.destroy?.();
  }, [animateLayout, duration, motionEnabled, as]);

  useLayoutEffect(() => {
    const container = elementRef.current;
    if (!motionEnabled || !animateLayout || !container || typeof window === "undefined" || typeof ResizeObserver === "undefined") {
      previousRectsRef.current = new Map();
      return;
    }

    const animateFromPreviousLayout = () => {
      if (getVisibleChildCount(container) > LAYOUT_ANIMATION_CHILD_LIMIT) {
        previousRectsRef.current = new Map();
        return;
      }

      if (isDialogMotionLocked()) {
        previousRectsRef.current = measureChildren(container);
        return;
      }

      const previousRects = previousRectsRef.current;
      const visibleRects = measureChildren(container);
      const animatedChildren = new Set<Element>();
      Array.from(container.children).forEach((child) => {
        if (animationsRef.current.has(child)) animatedChildren.add(child);
        animationsRef.current.get(child)?.cancel();
      });
      const nextRects = measureChildren(container);

      if (previousRects.size > 0) {
        nextRects.forEach((nextRect, child) => {
          const previousRect = animatedChildren.has(child) ? visibleRects.get(child) : previousRects.get(child);
          if (!previousRect) return;

          const deltaX = previousRect.left - nextRect.left;
          const deltaY = previousRect.top - nextRect.top;
          const moved = Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5;
          // Resize text through layout, never by scaling a rasterized card.
          if (!moved) return;

          if (typeof (child as HTMLElement).animate !== "function") return;
          const animation = (child as HTMLElement).animate(
            [
              {
                transform: `translate(${deltaX}px, ${deltaY}px)`,
                transformOrigin: "top left",
              },
              {
                transform: "none",
                transformOrigin: "top left",
              },
            ],
            {
              duration,
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            },
          );
          animationsRef.current.set(child, animation);
          animation.onfinish = () => {
            if (animationsRef.current.get(child) === animation) animationsRef.current.delete(child);
            animation.cancel();
          };
          animation.oncancel = () => {
            if (animationsRef.current.get(child) === animation) animationsRef.current.delete(child);
          };
        });
      }

      previousRectsRef.current = nextRects;
    };

    animateFromPreviousLayout();
    const observer = new ResizeObserver(() => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        animateFromPreviousLayout();
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      previousRectsRef.current = new Map();
      Array.from(container.children).forEach((child) => animationsRef.current.get(child)?.cancel());
    };
  }, [animateLayout, duration, motionEnabled]);

  return (
    <Component ref={setRef} className={cn(className)} {...props}>
      {children}
    </Component>
  );
}

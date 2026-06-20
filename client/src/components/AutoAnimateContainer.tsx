import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";

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

function shouldSkipMotion() {
  return typeof window === "undefined"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function AutoAnimateContainer<T extends ElementType = "div">({
  as,
  children,
  className,
  duration = 180,
  layout,
  ...props
}: AutoAnimateContainerProps<T>) {
  const elementRef = useRef<Element | null>(null);
  const previousRectsRef = useRef<Map<Element, DOMRect>>(new Map());
  const frameRef = useRef<number | null>(null);
  const animationsRef = useRef<WeakMap<Element, Animation>>(new WeakMap());
  const [parent] = useAutoAnimate<Element>({
    duration,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
  const Component = (as || "div") as ElementType;
  const animateLayout = layout ?? standardCardGridClassPattern.test(className || "");
  const setRef = useCallback((node: Element | null) => {
    elementRef.current = node;
    parent(node);
  }, [parent]);

  useLayoutEffect(() => {
    const container = elementRef.current;
    if (!animateLayout || !container || typeof window === "undefined" || typeof ResizeObserver === "undefined") {
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

      if (previousRects.size > 0 && !shouldSkipMotion()) {
        nextRects.forEach((nextRect, child) => {
          const previousRect = animatedChildren.has(child) ? visibleRects.get(child) : previousRects.get(child);
          if (!previousRect) return;

          const deltaX = previousRect.left - nextRect.left;
          const deltaY = previousRect.top - nextRect.top;
          const scaleX = nextRect.width > 0 ? previousRect.width / nextRect.width : 1;
          const scaleY = nextRect.height > 0 ? previousRect.height / nextRect.height : 1;
          const moved = Math.abs(deltaX) >= 0.5 || Math.abs(deltaY) >= 0.5;
          const resized = Math.abs(1 - scaleX) >= 0.01 || Math.abs(1 - scaleY) >= 0.01;
          if (!moved && !resized) return;

          if (typeof (child as HTMLElement).animate !== "function") return;
          const animation = (child as HTMLElement).animate(
            [
              {
                transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
                transformOrigin: "top left",
              },
              {
                transform: "translate(0, 0) scale(1, 1)",
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
  }, [animateLayout, duration]);

  return (
    <Component ref={setRef} className={cn(className)} {...props}>
      {children}
    </Component>
  );
}

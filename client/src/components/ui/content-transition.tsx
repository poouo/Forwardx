import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useMotionEnabled } from "@/components/MotionPolicy";

/** Update in place so switches never blank the panel or remount its controls. */
export function ContentTransition({ transitionKey, className, children }: {
  transitionKey: string;
  className?: string;
  children: ReactNode;
}) {
  const enabled = useMotionEnabled();
  const elementRef = useRef<HTMLDivElement>(null);
  const previousKeyRef = useRef(transitionKey);

  useLayoutEffect(() => {
    const changed = previousKeyRef.current !== transitionKey;
    previousKeyRef.current = transitionKey;
    const element = elementRef.current;
    if (!changed || !enabled || !element || typeof element.animate !== "function") return;
    const animation = element.animate(
      [{ transform: "translateY(4px)" }, { transform: "none" }],
      { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    animation.onfinish = () => animation.cancel();
    return () => animation.cancel();
  }, [enabled, transitionKey]);

  return <div ref={elementRef} data-content-transition="" className={className}>{children}</div>;
}

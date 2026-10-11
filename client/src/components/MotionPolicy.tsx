import { MotionConfig } from "motion/react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const MotionEnabledContext = createContext(false);
export const useMotionEnabled = () => useContext(MotionEnabledContext);

function motionAllowed() {
  return typeof document !== "undefined" && !document.hidden
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Share the OS motion preference with all existing Motion components. */
export default function MotionPolicy({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(motionAllowed);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      root.toggleAttribute("data-forwardx-motion-paused", document.hidden);
      setEnabled(motionAllowed());
    };
    update();
    document.addEventListener("visibilitychange", update);
    media.addEventListener("change", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      media.removeEventListener("change", update);
      root.removeAttribute("data-forwardx-motion-paused");
    };
  }, []);
  return <MotionConfig reducedMotion="user"><MotionEnabledContext.Provider value={enabled}>{children}</MotionEnabledContext.Provider></MotionConfig>;
}

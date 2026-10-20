import { MotionConfig } from "motion/react";
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { applyMotionPreference, areAnimationsEnabled, canAnimate } from "@/lib/motionPreference";

const MotionEnabledContext = createContext(false);
export const useMotionEnabled = () => useContext(MotionEnabledContext);

function motionAllowed() {
  return typeof document !== "undefined" && canAnimate(true, document.hidden,
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Account preference, OS accessibility and background visibility share one policy. */
export default function MotionPolicy({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const preferenceEnabled = areAnimationsEnabled(user);
  const [environmentAllowed, setEnvironmentAllowed] = useState(motionAllowed);
  const enabled = preferenceEnabled && environmentAllowed;
  useLayoutEffect(() => {
    const root = document.documentElement;
    applyMotionPreference(root, preferenceEnabled);
    return () => root.removeAttribute("data-forwardx-motion-disabled");
  }, [preferenceEnabled]);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      root.toggleAttribute("data-forwardx-motion-paused", document.hidden);
      setEnvironmentAllowed(motionAllowed());
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
  return <MotionConfig reducedMotion={enabled ? "user" : "always"} transition={enabled ? undefined : { duration: 0, delay: 0 }}><MotionEnabledContext.Provider value={enabled}>{children}</MotionEnabledContext.Provider></MotionConfig>;
}

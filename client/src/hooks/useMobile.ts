import { useEffect, useState } from "react";
import { mobileAuth } from "@/lib/mobileAuth";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState<boolean>(() => mobileAuth.isNative ||
    (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches));

  useEffect(() => {
    if (mobileAuth.isNative) {
      setIsMobile(true);
      return;
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

import { AnimatePresence, motion, useIsPresent } from "motion/react";
import type { ReactNode } from "react";
import { useMotionEnabled } from "@/components/MotionPolicy";

function ContentPanel({ children, className }: { children: ReactNode; className?: string }) {
  const enabled = useMotionEnabled();
  const present = useIsPresent();
  return <motion.div
    className={className}
    inert={!present}
    aria-hidden={!present || undefined}
    initial={enabled ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }}
    exit={enabled ? { opacity: 0, y: -4 } : { opacity: 1, y: 0 }}
    transition={{ duration: enabled ? (present ? 0.34 : 0.12) : 0, ease: [0.22, 1, 0.36, 1] }}
  >{children}</motion.div>;
}

/** Finite staged reveal; refreshes under the same key do not replay it. */
export function ContentTransition({ transitionKey, className, children }: {
  transitionKey: string;
  className?: string;
  children: ReactNode;
}) {
  return <AnimatePresence mode="wait" initial={false}>
    <ContentPanel key={transitionKey} className={className}>{children}</ContentPanel>
  </AnimatePresence>;
}

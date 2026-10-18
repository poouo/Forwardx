// Let outgoing text disappear before revealing the new labels. Opacity-only
// transitions keep glyphs crisp and avoid overlapping translated form text.
export function loginContentMotion(reducedMotion: boolean) {
  return {
    initial: reducedMotion ? false as const : { opacity: 0 },
    animate: {
      opacity: 1,
      transition: { duration: reducedMotion ? 0 : .30, delay: reducedMotion ? 0 : .14, ease: "easeOut" as const },
    },
    exit: {
      opacity: 0,
      pointerEvents: "none" as const,
      transition: { duration: reducedMotion ? 0 : .12, ease: "easeIn" as const },
    },
  };
}

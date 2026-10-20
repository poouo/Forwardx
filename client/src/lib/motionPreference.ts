/** Missing preferences (including existing accounts) keep animations enabled. */
export function areAnimationsEnabled(user: { animationsEnabled?: boolean | null } | null | undefined) {
  return user?.animationsEnabled !== false;
}

export function canAnimate(enabled: boolean, hidden: boolean, reducedMotion: boolean) {
  return enabled && !hidden && !reducedMotion;
}

export function applyMotionPreference(root: HTMLElement, enabled: boolean) {
  root.toggleAttribute("data-forwardx-motion-disabled", !enabled);
}

export const PENDING_FEEDBACK_DELAY_MS = 200;
export const PENDING_FEEDBACK_MIN_VISIBLE_MS = 300;

// Only delay the visual feedback, never the request, result or duplicate-click guard.
export function createPendingFeedback(onChange: (visible: boolean) => void) {
  let pending = false;
  let visible = false;
  let disposed = false;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  return {
    setPending(next: boolean) {
      if (disposed || next === pending) return;
      pending = next;
      cancel();
      if (pending && !visible) {
        timer = setTimeout(() => {
          timer = undefined;
          visible = true;
          shownAt = Date.now();
          onChange(true);
        }, PENDING_FEEDBACK_DELAY_MS);
      } else if (!pending && visible) {
        timer = setTimeout(() => {
          timer = undefined;
          visible = false;
          onChange(false);
        }, Math.max(0, PENDING_FEEDBACK_MIN_VISIBLE_MS - (Date.now() - shownAt)));
      }
    },
    dispose() { disposed = true; cancel(); },
  };
}

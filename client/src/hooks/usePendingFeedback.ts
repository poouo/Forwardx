import { useEffect, useRef, useState } from "react";
import { createPendingFeedback } from "@/lib/pendingFeedback";

export function usePendingFeedback(pending: boolean) {
  const [visible, setVisible] = useState(false);
  const feedback = useRef<ReturnType<typeof createPendingFeedback> | null>(null);
  useEffect(() => {
    const controller = createPendingFeedback(setVisible);
    feedback.current = controller;
    return () => { controller.dispose(); feedback.current = null; };
  }, []);
  useEffect(() => { feedback.current?.setPending(pending); }, [pending]);
  return visible;
}

import { useEffect, useRef, useState } from "react";
import type { LinkSpeedStatus } from "@shared/linkSpeed";
import { LinkSpeedPlayback } from "@/lib/linkSpeedPlayback";

export function useLinkSpeedPlayback(
  status: LinkSpeedStatus | null | undefined,
  animated: boolean,
) {
  const buffer = useRef(new LinkSpeedPlayback());
  const [view, setView] = useState({ id: "", count: 0, pending: false });
  useEffect(() => {
    if (!status) return;
    const playback = buffer.current;
    playback.receive(status, performance.now(), animated);
    const publish = () => setView((previous) => {
      const next = {
        id: playback.id,
        count: playback.count,
        pending: playback.pending,
      };
      return previous.id === next.id && previous.count === next.count &&
        previous.pending === next.pending ? previous : next;
    });
    publish();
    if (!playback.pending) return;
    const timer = window.setInterval(() => {
      playback.advance(performance.now());
      publish();
      if (!playback.pending) window.clearInterval(timer);
    }, 25);
    return () => window.clearInterval(timer);
  }, [status, animated]);
  const immediate = !animated || status?.state === "error" ||
    status?.state === "cancelled" ||
    (view.id !== status?.id && status?.state === "completed");
  const count = view.id === status?.id ? view.count : 0;
  return {
    samples: immediate
      ? status?.samples ?? []
      : status?.samples.slice(0, count) ?? [],
    pending: !immediate && !!status && (view.pending || count < status.samples.length),
  };
}

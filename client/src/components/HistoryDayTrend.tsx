import { historyTrendGradient, type HistoryTrendSegment } from "@/lib/historyDayTrend";

/** One CSS strip per day, not dozens of DOM nodes or per-day requests. */
export function HistoryDayTrendBand({ segments }: { segments: HistoryTrendSegment[] }) {
  return <span aria-hidden="true" data-history-trend="true"
    className="pointer-events-none absolute inset-0.5 rounded-[2px] bg-background"
    style={{ backgroundImage: historyTrendGradient(segments) }} />;
}

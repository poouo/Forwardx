import { normalizeLatencyProbeCounts } from "./latencyChart";

import type { HistoryTrendSegment } from "@shared/latencyHistory";
export type { HistoryTrendSegment } from "@shared/latencyHistory";
export type HistoryTrendWindow = { startAt: Date; endAt: Date };

function bounds(day: HistoryTrendWindow, now: number) {
  return [day.startAt.getTime(), Math.min(day.endAt.getTime(), now)];
}

type ProbeTrendSample = {
  recordedAt: Date | string; seriesKey?: string | null;
  isTimeout?: boolean | null; probeCount?: number | null; probeSuccesses?: number | null;
};

const colors = { good: "#10b98140", warning: "#f59e0b50", bad: "#ef444470", none: "var(--color-muted)" };
export function historyTrendGradient(segments: HistoryTrendSegment[]) {
  if (!segments.length) return undefined;
  const runs: HistoryTrendSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.from - b.from)) {
    const previous = runs[runs.length - 1];
    if (previous?.health === segment.health && Math.abs(previous.to - segment.from) < 1e-9) previous.to = segment.to;
    else runs.push({ ...segment });
  }
  const stops = runs.flatMap(segment =>
    [`${colors[segment.health]} ${segment.from * 100}%`, `${colors[segment.health]} ${segment.to * 100}%`]);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** Small sampling buckets show a trend, not invented continuous uptime. */
export function probeDayTrend(day: HistoryTrendWindow, samples: ProbeTrendSample[], now = Date.now()): HistoryTrendSegment[] {
  const [start, end] = bounds(day, now);
  if (end <= start) return [];
  const count = 48;
  const buckets = Array.from({ length: count }, () => ({ total: 0, successes: 0 }));
  const hasTotal = samples.some(row => row.seriesKey === "total");
  for (const row of samples) {
    if (hasTotal && row.seriesKey && row.seriesKey !== "total") continue;
    const at = new Date(row.recordedAt).getTime();
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const bucket = buckets[Math.min(count - 1, Math.floor((at - start) / (end - start) * count))];
    const probes = normalizeLatencyProbeCounts(row);
    bucket.total += probes.probeCount;
    bucket.successes += probes.probeSuccesses;
  }
  return buckets.map((bucket, index) => {
    const loss = bucket.total ? (bucket.total - bucket.successes) / bucket.total * 100 : null;
    return { from: index / count, to: (index + 1) / count,
      health: loss == null ? "none" : loss <= 1 ? "good" : loss <= 5 ? "warning" : "bad" };
  });
}

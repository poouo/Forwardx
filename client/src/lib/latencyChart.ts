export const MAX_LATENCY_CHART_MS = 500;

export type LatencyStabilitySample = {
  latency: number;
  isTimeout?: boolean | null;
};

export type LatencyStabilityRating = {
  label: string;
  className: string;
};

export type LatencyStabilityStats = {
  total: number;
  timeout: number;
  valid: number;
  lossRate: number;
  max: number | null;
  min: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  jitter: number | null;
  spikeRate: number;
  maxLossRun: number;
  score: number | null;
  rating: LatencyStabilityRating;
};

export function isLatencySeriesCacheFresh<T extends { recordedAt: string | Date }>(
  series: T[] | null | undefined,
  maxLatestAgeMs = 10 * 60 * 1000,
) {
  if (!series?.length) return false;
  const latest = series.reduce((max, item) => {
    const time = new Date(item.recordedAt).getTime();
    return Number.isFinite(time) ? Math.max(max, time) : max;
  }, 0);
  const now = Date.now();
  return latest > 0 && latest >= now - maxLatestAgeMs && latest <= now + 60_000;
}

export function clipLatencyForChart(latency: number) {
  if (!Number.isFinite(latency) || latency <= 0) return 0;
  return Math.min(MAX_LATENCY_CHART_MS, latency);
}

export function getLatencyYAxisMax(maxLatency: number, fallback = 120) {
  if (!Number.isFinite(maxLatency) || maxLatency <= 0) return fallback;

  const clipped = clipLatencyForChart(maxLatency);
  const padding =
    clipped < 20 ? 1.35
      : clipped < 50 ? 1.25
        : clipped < 150 ? 1.2
          : clipped < 300 ? 1.15
            : 1.1;
  const padded = Math.max(clipped + 1, clipped * padding);
  const step = getNiceLatencyStep(padded / 5);
  const rounded = Math.ceil(padded / step) * step;
  return Math.min(MAX_LATENCY_CHART_MS, Math.max(1, Math.ceil(rounded)));
}

export function getLatencyYAxisTicks(yMax: number) {
  if (!Number.isFinite(yMax) || yMax <= 0) return [0];
  const max = Math.ceil(yMax);
  const step = getNiceLatencyStep(max / 6);
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

function getNiceLatencyStep(rawStep: number) {
  if (!Number.isFinite(rawStep) || rawStep <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const candidates = magnitude >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const selected = candidates.find((step) => normalized <= step) ?? 10;
  return selected * magnitude;
}

export function getLatencyStabilityStats(samples: LatencyStabilitySample[]): LatencyStabilityStats {
  const total = samples.length;
  const timeout = samples.filter((sample) => !!sample.isTimeout).length;
  const lossRate = total > 0 ? (timeout / total) * 100 : 0;
  const values = samples
    .filter((sample) => !sample.isTimeout && Number.isFinite(sample.latency) && sample.latency > 0)
    .map((sample) => sample.latency)
    .sort((a, b) => a - b);
  const valid = values.length;
  const maxLossRun = getMaxLossRun(samples);

  if (total === 0) {
    return {
      total,
      timeout,
      valid,
      lossRate,
      max: null,
      min: null,
      avg: null,
      p50: null,
      p95: null,
      jitter: null,
      spikeRate: 0,
      maxLossRun,
      score: null,
      rating: getLatencyStabilityRating(null),
    };
  }

  if (valid === 0) {
    const score = applyStabilityCaps(0, lossRate, null, maxLossRun);
    return {
      total,
      timeout,
      valid,
      lossRate,
      max: null,
      min: null,
      avg: null,
      p50: null,
      p95: null,
      jitter: null,
      spikeRate: 0,
      maxLossRun,
      score,
      rating: getLatencyStabilityRating(score),
    };
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const deviations = values.map((value) => Math.abs(value - p50)).sort((a, b) => a - b);
  const jitter = percentile(deviations, 50);
  const spikeThreshold = p50 + Math.max(50, jitter * 4);
  const spikeRate = values.filter((value) => value > spikeThreshold).length / Math.max(valid, 1);

  const lossScore = interpolateScore(lossRate, [
    [0, 100],
    [0.1, 98],
    [1, 90],
    [3, 75],
    [5, 55],
    [10, 30],
    [20, 10],
    [35, 0],
  ]);
  const latencyScore = interpolateScore(p50, [
    [20, 100],
    [60, 97],
    [120, 92],
    [200, 84],
    [300, 74],
    [500, 58],
    [800, 40],
    [1200, 22],
  ]);
  const jitterScore = Math.min(
    interpolateScore(jitter, [
      [3, 100],
      [10, 96],
      [25, 86],
      [60, 66],
      [120, 42],
      [250, 15],
    ]),
    interpolateScore(jitter / Math.max(p50, 1), [
      [0.03, 100],
      [0.08, 96],
      [0.16, 84],
      [0.3, 64],
      [0.6, 38],
      [1, 15],
    ])
  );
  const spikeScore = Math.min(
    interpolateScore(p95 / Math.max(p50, 1), [
      [1.1, 100],
      [1.35, 92],
      [1.8, 76],
      [2.5, 55],
      [4, 28],
      [6, 10],
    ]),
    interpolateScore(spikeRate * 100, [
      [0, 100],
      [1, 96],
      [3, 88],
      [8, 70],
      [15, 45],
      [30, 18],
    ])
  );
  const continuityScore = interpolateScore(maxLossRun, [
    [0, 100],
    [1, 88],
    [2, 76],
    [4, 55],
    [8, 30],
    [16, 10],
  ]);

  const rawScore =
    lossScore * 0.4
    + jitterScore * 0.2
    + spikeScore * 0.18
    + latencyScore * 0.17
    + continuityScore * 0.05;
  const score = applyStabilityCaps(Math.round(rawScore), lossRate, p50, maxLossRun);

  return {
    total,
    timeout,
    valid,
    lossRate,
    max: values[valid - 1],
    min: values[0],
    avg: Math.round(sum / valid),
    p50: Math.round(p50),
    p95: Math.round(p95),
    jitter: Math.round(jitter),
    spikeRate,
    maxLossRun,
    score,
    rating: getLatencyStabilityRating(score),
  };
}

export function getLatencyStabilityRating(score: number | null): LatencyStabilityRating {
  if (score === null) return { label: "暂无", className: "text-muted-foreground" };
  if (score >= 90) return { label: "优秀", className: "text-emerald-600 dark:text-emerald-400" };
  if (score >= 80) return { label: "良好", className: "text-lime-600 dark:text-lime-400" };
  if (score >= 65) return { label: "一般", className: "text-yellow-600 dark:text-yellow-400" };
  if (score >= 45) return { label: "较差", className: "text-orange-600 dark:text-orange-400" };
  if (score >= 25) return { label: "不稳定", className: "text-rose-600 dark:text-rose-400" };
  return { label: "严重不可用", className: "text-destructive" };
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (percentileValue / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function interpolateScore(value: number, points: Array<[number, number]>) {
  if (!Number.isFinite(value)) return 0;
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [limit, score] = points[index];
    const [prevLimit, prevScore] = points[index - 1];
    if (value <= limit) {
      const ratio = (value - prevLimit) / Math.max(limit - prevLimit, 1);
      return prevScore + (score - prevScore) * ratio;
    }
  }
  return points[points.length - 1][1];
}

function getMaxLossRun(samples: LatencyStabilitySample[]) {
  let current = 0;
  let max = 0;
  for (const sample of samples) {
    if (sample.isTimeout) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function applyStabilityCaps(score: number, lossRate: number, p50: number | null, maxLossRun: number) {
  let capped = Math.max(0, Math.min(100, score));
  if (lossRate >= 20) capped = Math.min(capped, 10);
  else if (lossRate >= 10) capped = Math.min(capped, 25);
  else if (lossRate >= 5) capped = Math.min(capped, 45);
  else if (lossRate >= 1) capped = Math.min(capped, 70);

  if (maxLossRun >= 12) capped = Math.min(capped, 35);
  else if (maxLossRun >= 6) capped = Math.min(capped, 55);

  if (p50 !== null) {
    if (p50 >= 1200) capped = Math.min(capped, 55);
    else if (p50 >= 800) capped = Math.min(capped, 65);
    else if (p50 >= 500) capped = Math.min(capped, 75);
    else if (p50 >= 300) capped = Math.min(capped, 85);
    else if (p50 >= 200) capped = Math.min(capped, 92);
  }

  return Math.round(capped);
}

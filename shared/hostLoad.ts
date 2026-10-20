export type HostLoadMetric = { load1?: unknown; load5?: unknown; load15?: unknown };

export function normalizeLoadValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseHostLoadAverage(value: unknown) {
  const values = Array.isArray(value) ? value : [];
  return {
    load1: normalizeLoadValue(values[0]),
    load5: normalizeLoadValue(values[1]),
    load15: normalizeLoadValue(values[2]),
  };
}

export function formatHostLoad(metric?: HostLoadMetric | null): string {
  return [metric?.load1, metric?.load5, metric?.load15]
    .map((value) => normalizeLoadValue(value)?.toFixed(2) ?? "—")
    .join(" / ");
}

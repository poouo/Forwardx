import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type LatencyTimeRangeHours = 24 | 12 | 6 | 3 | 1 | 0.5;

export const DEFAULT_LATENCY_TIME_RANGE_HOURS: LatencyTimeRangeHours = 24;

export const LATENCY_TIME_RANGE_OPTIONS: Array<{ value: string; hours: LatencyTimeRangeHours; label: string }> = [
  { value: "24", hours: 24, label: "24H" },
  { value: "12", hours: 12, label: "12H" },
  { value: "6", hours: 6, label: "6H" },
  { value: "3", hours: 3, label: "3H" },
  { value: "1", hours: 1, label: "1H" },
  { value: "0.5", hours: 0.5, label: "0.5H" },
];

export function latencyTimeRangeLabel(hours: number) {
  const option = LATENCY_TIME_RANGE_OPTIONS.find((item) => item.hours === hours);
  return option?.label || `${hours}H`;
}

export function filterLatencySeriesByTimeRange<T extends { recordedAt: string | Date }>(
  series: T[] | null | undefined,
  hours: number,
) {
  if (!series?.length) return [];
  const rangeMs = Math.max(0.5, Number(hours) || DEFAULT_LATENCY_TIME_RANGE_HOURS) * 60 * 60 * 1000;
  const times = series
    .map((item) => new Date(item.recordedAt).getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return [];
  const latestPointAt = Math.max(...times);
  const now = Date.now();
  const anchor = Math.abs(latestPointAt - now) > 60 * 1000 ? latestPointAt : now;
  const cutoff = anchor - rangeMs;
  return series.filter((item) => {
    const time = new Date(item.recordedAt).getTime();
    return Number.isFinite(time) && time >= cutoff && time <= anchor + 60 * 1000;
  });
}

export function LatencyTimeRangeSelect({
  value,
  onChange,
  className,
}: {
  value: LatencyTimeRangeHours;
  onChange: (value: LatencyTimeRangeHours) => void;
  className?: string;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        const option = LATENCY_TIME_RANGE_OPTIONS.find((item) => item.value === next);
        if (option) onChange(option.hours);
      }}
    >
      <SelectTrigger className={cn("h-8 w-24 shrink-0 text-xs", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {LATENCY_TIME_RANGE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

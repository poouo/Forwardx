import { useEffect, useMemo, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { HistoryDaySelector } from "@/components/HistoryDaySelector";
import { HistoryDayTrendBand } from "@/components/HistoryDayTrend";
import { probeDayTrend } from "@/lib/historyDayTrend";
import { LATENCY_HISTORY_DAYS } from "@shared/latencyHistory";
import { latencyHistoryPollingInterval, type LatencyTimeRangeHours } from "./LatencyTimeRangeSelect";

export function localHistoryDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function latencyHistoryDays(now = new Date()) {
  return Array.from({ length: LATENCY_HISTORY_DAYS }, (_, index) => {
    const startAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - LATENCY_HISTORY_DAYS + 1 + index);
    const endAt = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate() + 1);
    return { index: index + 1, date: localHistoryDate(startAt), label: `${startAt.getMonth() + 1}/${startAt.getDate()}`, startAt, endAt };
  });
}

/** Today ends at the current time; completed local calendar days stay whole. */
export function latencyHistoryDayDomain(day: { startAt: Date; endAt: Date } | undefined, now = Date.now()): [number, number] | null {
  if (!day) return null;
  const start = day.startAt.getTime();
  // Avoid a degenerate numeric axis at exactly midnight, before any data exists.
  return [start, Math.max(start + 1, Math.min(now, day.endAt.getTime()))];
}

export function useLatencyHistoryDays(hours: LatencyTimeRangeHours, open: boolean, recentInterval: number | false) {
  const [now, setNow] = useState(() => Date.now());
  const [today, setToday] = useState(() => localHistoryDate(new Date()));
  // null keeps the existing rolling-range selector available.
  const [selectedDay, setSelectedDay] = useState<string | null>(() => localHistoryDate(new Date()));
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const current = Date.now();
      const next = localHistoryDate(new Date(current));
      if (next !== today) setSelectedDay((selected) => selected === today ? next : selected);
      setNow(current);
      setToday(next);
    };
    update();
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [open, today]);
  const days = useMemo(() => latencyHistoryDays(new Date(`${today}T12:00:00`)), [today]);
  const selected = days.find((day) => day.date === selectedDay);
  const historical = !!selected && selected.date !== today;
  return {
    days, selectedDay: selected?.date || null, setSelectedDay,
    today: () => setSelectedDay(today),
    label: selected ? selected.date : `${hours}H`,
    input: selected ? { hours: 24, startAt: selected.startAt, endAt: selected.endAt } : { hours },
    summaryInput: { hours: 720, startAt: days[0].startAt, endAt: days[days.length - 1].endAt, includeTrend: true,
      dayBoundaries: [...days.map((day) => day.startAt), days[days.length - 1].endAt] },
    refetchInterval: historical ? false : latencyHistoryPollingInterval(selected ? 24 : hours, open, recentInterval),
    filter<T extends { recordedAt: string | Date }>(rows: T[] | null | undefined) {
      const end = Math.min(Date.now(), selected?.endAt.getTime() ?? Date.now());
      const start = selected?.startAt.getTime() ?? end - hours * 3600_000;
      return (rows || []).filter((row) => {
        const at = new Date(row.recordedAt).getTime();
        return at >= start && at < end;
      });
    },
    // Only the visual domain advances. Keep query boundaries at midnight so
    // the clock never creates a new query/cache key every thirty seconds.
    domain: latencyHistoryDayDomain(selected, now),
  };
}

export type LatencyDaySample = {
  dayStart?: number;
  recordedAt: Date | string;
  latencyMs?: number | null;
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
  probeCount?: number | null;
  probeSuccesses?: number | null;
  serviceId?: number;
  seriesKey?: string | null;
  isTimeout?: boolean | null;
};

export function summarizeLatencyDays(samples: LatencyDaySample[]) {
  const summaries = new Map<string, { total: number; successes: number; sum: number; latencyWeight: number; min: number | null; max: number | null }>();
  const hasTotal = samples.some((sample) => sample.seriesKey === "total");
  for (const sample of samples) {
    if (hasTotal && sample.seriesKey && sample.seriesKey !== "total") continue;
    const date = localHistoryDate(new Date(sample.dayStart ?? sample.recordedAt));
    const entry = summaries.get(date) || { total: 0, successes: 0, sum: 0, latencyWeight: 0, min: null, max: null };
    const total = Math.max(0, Number(sample.probeCount) || 0);
    const successes = Math.max(0, Math.min(total, Number(sample.probeSuccesses) || 0));
    entry.total += total;
    entry.successes += successes;
    if (successes > 0 && sample.latencyMs != null) {
      entry.sum += sample.latencyMs * successes;
      entry.latencyWeight += successes;
      entry.min = Math.min(entry.min ?? Infinity, sample.minLatencyMs ?? sample.latencyMs);
      entry.max = Math.max(entry.max ?? 0, sample.maxLatencyMs ?? sample.latencyMs);
    }
    summaries.set(date, entry);
  }
  return summaries;
}

export function latencyDayHealth(total: number, successes: number) {
  if (total <= 0) return "none";
  const loss = (total - successes) / total * 100;
  return loss <= 1 ? "good" : loss <= 5 ? "warning" : "bad";
}

export function LatencyHistoryTodayButton({ onClick }: { onClick: () => void }) {
  return <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-3 text-xs" onClick={onClick}>{t("当天")}</Button>;
}

export function LatencyHistoryDayStrip({ days, selectedDay, onSelect, samples = [], loading = false, error = false }: {
  days: ReturnType<typeof latencyHistoryDays>;
  selectedDay: string | null;
  onSelect: (date: string) => void;
  samples?: LatencyDaySample[];
  loading?: boolean;
  error?: boolean;
}) {
  const summaries = useMemo(() => summarizeLatencyDays(samples), [samples]);
  const trends = useMemo(() => {
    const byDate = new Map<string, LatencyDaySample[]>();
    for (const row of samples) {
      const date = localHistoryDate(new Date(row.dayStart ?? row.recordedAt));
      const rows = byDate.get(date) || [];
      rows.push(row);
      byDate.set(date, rows);
    }
    return new Map(days.map(day => [day.date, probeDayTrend(day, byDate.get(day.date) || [])]));
  }, [days, samples]);
  return <HistoryDaySelector selectedDay={selectedDay} onSelect={onSelect} ariaLabel={t("延迟历史日期")}
    items={days.map((day) => {
      const summary = summaries.get(day.date);
      const health = loading || error ? "none" : latencyDayHealth(summary?.total || 0, summary?.successes || 0);
      const label = error ? t("加载失败") : loading ? t("加载中") : health === "none" ? t("无数据") : health === "good" ? t("优秀") : health === "warning" ? t("一般") : t("异常");
      const loss = summary?.total ? (summary.total - summary.successes) / summary.total * 100 : null;
      return { date: day.date, health, label, trend: <HistoryDayTrendBand segments={loading || error ? [] : trends.get(day.date) || []} />, tooltip: <>
      <p className="font-medium">{day.date} · {label}</p>
      {!loading && !error && summary && summary.total > 0 && <>
        <p>{t("上报探测样本")}：{summary.total.toLocaleString()} · {t("失败率")}：{loss!.toFixed(2)}%</p>
        <p>{t("平均延迟")}：{summary.latencyWeight ? `${Math.round(summary.sum / summary.latencyWeight)} ms` : "—"}</p>
        <p>{t("最小延迟")}：{summary.min == null ? "—" : `${summary.min} ms`} · {t("最大延迟")}：{summary.max == null ? "—" : `${summary.max} ms`}</p>
      </>}
      <p className="text-[10px] opacity-75">{t("按上报样本失败率：绿色 ≤1%，黄色 ≤5%，红色 >5%。")}</p>
      </> };
    })} />;
}

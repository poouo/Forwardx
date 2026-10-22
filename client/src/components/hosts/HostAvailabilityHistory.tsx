import { useEffect, useMemo, useState } from "react";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { HistoryDaySelector } from "@/components/HistoryDaySelector";
import { HistoryDayTrendBand } from "@/components/HistoryDayTrend";
import { latencyHistoryDays, localHistoryDate } from "@/components/LatencyHistoryDays";
import type { AvailabilityDay, AvailabilityInterval } from "@shared/hostAvailability";

export function availabilityHealth(day?: AvailabilityDay) {
  if (day?.uptimePercent == null || !day.observedSeconds) return "none";
  return day.uptimePercent >= 99.9 ? "good" : day.uptimePercent >= 99 ? "warning" : "bad";
}

export function availabilityDuration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60), rest = value % 60;
  return `${hours ? `${hours}h ` : ""}${minutes || hours ? `${minutes}m ` : ""}${rest}s`;
}

function timeLabel(seconds: number) {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour12: false });
}

export function HostAvailabilityHistory({ days, summaries = [], selectedDay, onSelect, detail, loading, error, detailLoading, detailError }: {
  days: ReturnType<typeof latencyHistoryDays>;
  summaries?: AvailabilityDay[];
  selectedDay: string | null;
  onSelect: (date: string) => void;
  detail?: { days: AvailabilityDay[]; intervals: AvailabilityInterval[] };
  loading?: boolean; error?: boolean; detailLoading?: boolean; detailError?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  useEffect(() => { setVisibleCount(50); }, [selectedDay]);
  const byDate = useMemo(() => new Map(summaries.map((day) => [localHistoryDate(new Date(day.startAt * 1000)), day])), [summaries]);
  const selected = days.find((day) => day.date === selectedDay);
  const summary = detail?.days[0];
  const periods = useMemo(() => {
    if (!selected || !detail) return [];
    const start = selected.startAt.getTime() / 1000;
    const end = summary?.endAt ?? selected.endAt.getTime() / 1000;
    const result: { start: number; end: number; status: "online" | "offline" | "unknown"; incident?: boolean }[] = [];
    let cursor = start;
    for (const row of detail.intervals) {
      const from = Math.max(start, row.startAt), to = Math.min(end, row.endAt);
      if (to <= from) continue;
      if (from > cursor) result.push({ start: cursor, end: from, status: "unknown" });
      result.push({ start: from, end: to, status: row.online ? "online" : "offline", incident: row.offlineIncident && row.startAt >= start });
      cursor = Math.max(cursor, to);
    }
    if (cursor < end) result.push({ start: cursor, end, status: "unknown" });
    return result;
  }, [detail, selected, summary]);
  return <section className="space-y-2" aria-label={t("主机在线稳定性")}>
    <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
      <span className="font-medium">{t("主机在线稳定性")}</span>
      <span className="text-muted-foreground">{t("在线率：绿 ≥99.9% · 黄 ≥99% · 红 <99%")}</span>
    </div>
    <HistoryDaySelector selectedDay={selectedDay} onSelect={onSelect} ariaLabel={t("在线历史日期")}
      items={days.map((day) => {
        const value = byDate.get(day.date);
        const health = loading || error ? "none" : availabilityHealth(value);
        const partial = !!value?.observedSeconds && value.unknownSeconds > 0;
        const status = error ? t("加载失败") : loading ? t("加载中") : health === "none" ? t("无数据") : health === "good" ? t("优秀") : health === "warning" ? t("一般") : t("异常");
        const label = `${status}${partial ? ` · ${t("部分监测")}` : ""}`;
        return { date: day.date, health, partial, label, trend: <HistoryDayTrendBand segments={loading || error ? [] : value?.trend || []} />, tooltip: <>
          <p className="font-medium">{day.date} · {label}</p>
          {!loading && !error && value && <>
            <p>{t("在线率")}：{value.uptimePercent == null ? "—" : `${value.uptimePercent.toFixed(3)}%`} · {t("离线次数")}：{value.offlineCount}</p>
            <p>{t("离线时长")}：{availabilityDuration(value.offlineSeconds)} · {t("监测覆盖率")}：{value.coveragePercent == null ? "—" : `${value.coveragePercent.toFixed(1)}%`}</p>
          </>}
          <p className="text-[10px] opacity-75">{t("按已监测时长计算在线率；斜纹表示当天存在未监测时段。")}</p>
        </> };
      })} />
    {!selected ? <p className="text-xs text-muted-foreground">{t("点击日期查看当天稳定性详情。")}</p>
      : detailError ? <p role="alert" className="text-xs text-destructive">{t("在线稳定性加载失败，请稍后重试。")}</p>
      : detailLoading ? <p className="text-xs text-muted-foreground">{t("加载中")}</p>
      : summary && <>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[[t("在线率"), summary.uptimePercent == null ? "—" : `${summary.uptimePercent.toFixed(3)}%`], [t("离线次数"), String(summary.offlineCount)], [t("离线时长"), availabilityDuration(summary.offlineSeconds)], [t("监测覆盖率"), summary.coveragePercent == null ? "—" : `${summary.coveragePercent.toFixed(1)}%`]].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="truncate text-sm font-semibold tabular-nums">{value}</p></div>)}
        </div>
        <details key={selectedDay} className="rounded-lg border border-border/50 px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium">{selectedDay} · {t("在线与离线时段")}</summary>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {periods.slice(0, visibleCount).map((period) => <div key={`${period.start}:${period.status}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 tabular-nums">
              <span className={period.status === "offline" ? "text-destructive" : "text-muted-foreground"}>{t(period.status === "online" ? "在线" : period.status === "offline" ? "离线" : "未监测")}{period.incident ? ` · ${t("离线事件")}` : ""}</span>
              <span>{timeLabel(period.start)} – {timeLabel(period.end)} · {availabilityDuration(period.end - period.start)}</span>
            </div>)}
            {!periods.length && <p className="text-muted-foreground">{t("无数据")}</p>}
            {visibleCount < periods.length && <Button size="sm" variant="ghost" onClick={() => setVisibleCount((count) => count + 50)}>{t("更多时段")}</Button>}
          </div>
        </details>
        <p className="text-[10px] text-muted-foreground">{t("在线转为离线记一次，跨天持续离线不重复计数；以面板监测到的 Agent 状态为准。")}</p>
      </>}
  </section>;
}

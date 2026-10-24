import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import type { LatencyStabilityStats as LatencyStabilityStatsValue } from "@/lib/latencyChart";
import type { ReactNode } from "react";
import type { ProbeStatistics } from "@shared/probeStatistics";
import { HelpDetails } from "@/components/ui/help-details";

type LatencyStabilityStatsProps = {
  stats: LatencyStabilityStatsValue;
  sampleLabel?: string;
  failureLabel?: string;
  counterStatistics?: ProbeStatistics | null;
  description?: string;
};

function formatLatency(value: number | null) {
  return value === null ? "--" : `${value} ms`;
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pearl-hover-card latency-stat-card min-w-0 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 sm:rounded-lg sm:px-3 sm:py-2">
      <p title={label} className="break-words text-[10px] leading-snug text-muted-foreground sm:text-[11px]">{label}</p>
      <div className="mt-0.5 min-w-0 sm:mt-1">{children}</div>
    </div>
  );
}

export function LatencyStabilityStats({
  stats,
  sampleLabel = translateText("统计次数"),
  failureLabel = translateText("探测失败率"),
  counterStatistics,
  description,
}: LatencyStabilityStatsProps) {
  return (
    <div className="space-y-2" data-latency-stats="true">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6.5rem),1fr))] gap-1.5 sm:gap-2">
        <StatCard label={sampleLabel}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">{counterStatistics !== undefined && !counterStatistics?.available ? "--" : stats.total}</p>
        </StatCard>
        <StatCard label={translateText("最大延迟")}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.max)}</p>
        </StatCard>
        <StatCard label={failureLabel}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">
            {stats.total === 0 ? "--" : `${stats.lossRate.toFixed(2)}%`}
          </p>
        </StatCard>
        <StatCard label={translateText("最小延迟")}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.min)}</p>
        </StatCard>
        <StatCard label={translateText("平均延迟")}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.avg)}</p>
        </StatCard>
        <StatCard label={translateText("探测稳定性")}>
          <p className="break-words text-xs font-semibold tabular-nums sm:text-sm">
            {stats.score === null ? "--" : `${stats.score}/100`}
          </p>
          <p className={`break-words text-[10px] font-medium sm:text-[11px] ${stats.rating.className}`}>
            {stats.rating.label}
          </p>
        </StatCard>
      </div>
      {counterStatistics !== undefined && (
        <>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {counterStatistics?.available
            ? translateText("按已上报的累计探测次数统计；截至 {0}。", [counterStatistics.latestAt ? new Date(counterStatistics.latestAt).toLocaleString(getFormatLocale()) : translateText("最后上报")])
            : translateText("暂无累计探测统计，请升级 Agent 并等待上报。")}
          {" "}{translateText("探测统计，不代表业务丢包。")}
        </p>
        <HelpDetails title={translateText("统计口径")}>
          {!counterStatistics?.available && <p>{translateText("暂无累计探测统计，请升级 Agent 并等待上报。旧记录省略了稳定成功探测，无法准确计算失败率与稳定性。")}</p>}
          <p>{description || translateText("仅包含支持累计计数的 Agent 自首次上报后可观察到的探测；不补算旧数据，时间边界受上报间隔影响。")}</p>
        </HelpDetails>
        </>
      )}
    </div>
  );
}

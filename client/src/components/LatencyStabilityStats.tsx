import type { LatencyStabilityStats as LatencyStabilityStatsValue } from "@/lib/latencyChart";
import type { ReactNode } from "react";

type LatencyStabilityStatsProps = {
  stats: LatencyStabilityStatsValue;
  sampleLabel?: string;
};

function formatLatency(value: number | null) {
  return value === null ? "--" : `${value} ms`;
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="latency-stat-card min-w-0 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 sm:rounded-lg sm:px-3 sm:py-2">
      <p className="truncate text-[10px] text-muted-foreground sm:text-[11px]">{label}</p>
      <div className="mt-0.5 min-w-0 sm:mt-1">{children}</div>
    </div>
  );
}

export function LatencyStabilityStats({
  stats,
  sampleLabel = "统计次数",
}: LatencyStabilityStatsProps) {
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 sm:gap-2" data-latency-stats="true">
      <StatCard label={sampleLabel}>
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">{stats.total}</p>
      </StatCard>
      <StatCard label="最大延迟">
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.max)}</p>
      </StatCard>
      <StatCard label="丢包率">
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">
          {stats.total === 0 ? "--" : `${stats.lossRate.toFixed(2)}%`}
        </p>
      </StatCard>
      <StatCard label="最小延迟">
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.min)}</p>
      </StatCard>
      <StatCard label="平均延迟">
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">{formatLatency(stats.avg)}</p>
      </StatCard>
      <StatCard label="稳定性">
        <p className="truncate text-xs font-semibold tabular-nums sm:text-sm">
          {stats.score === null ? "--" : `${stats.score}/100`}
        </p>
        <p className={`truncate text-[10px] font-medium sm:text-[11px] ${stats.rating.className}`}>
          {stats.rating.label}
        </p>
      </StatCard>
    </div>
  );
}

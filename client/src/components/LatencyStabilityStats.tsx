import type { LatencyStabilityStats as LatencyStabilityStatsValue } from "@/lib/latencyChart";

type LatencyStabilityStatsProps = {
  stats: LatencyStabilityStatsValue;
  sampleLabel?: string;
};

function formatLatency(value: number | null) {
  return value === null ? "--" : `${value} ms`;
}

export function LatencyStabilityStats({
  stats,
  sampleLabel = "统计次数",
}: LatencyStabilityStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-6" data-latency-stats="true">
      <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">{sampleLabel}</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">{stats.total}</p>
      </div>
      <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">最大延迟</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">{formatLatency(stats.max)}</p>
      </div>
      <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">丢包率</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">
          {stats.total === 0 ? "--" : `${stats.lossRate.toFixed(2)}%`}
        </p>
      </div>
      <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">最小延迟</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">{formatLatency(stats.min)}</p>
      </div>
      <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">平均延迟</p>
        <p className="mt-1 text-sm font-semibold tabular-nums">{formatLatency(stats.avg)}</p>
      </div>
      <div className="latency-stat-card col-span-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 sm:col-span-1">
        <p className="text-[11px] text-muted-foreground">稳定性</p>
        <div className="mt-1 flex min-w-0 items-baseline gap-2 sm:block">
          <p className="text-sm font-semibold tabular-nums">
            {stats.score === null ? "--" : `${stats.score}/100`}
          </p>
          <p className={`truncate text-[11px] font-medium ${stats.rating.className}`}>
            {stats.rating.label}
          </p>
        </div>
      </div>
    </div>
  );
}

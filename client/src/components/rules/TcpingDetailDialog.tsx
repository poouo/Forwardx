import { useEffect, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { clipLatencyForChart, getLatencyYAxisMax, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { trpc } from "@/lib/trpc";

type TcpingChartPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
};

type TcpingSeriesDatum = {
  recordedAt: string | Date;
  latencyMs?: number | null;
  isTimeout?: boolean | null;
};

const tcpingSeriesCache = new Map<number, TcpingSeriesDatum[]>();
const tcpingAnimatedKeys = new Set<number>();

/** 格式化时间标签：显示 MM/DD HH:mm */
function formatTcpingTime(dateStr: string | Date): string {
  const d = new Date(dateStr);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

/** TCPing Tooltip */
function TcpingTooltipContent({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  const latency = data.latency;
  const isTimeout = data.isTimeout;
  return (
    <div className="pointer-events-none rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground mb-1">{data.fullLabel || label}</p>
      {isTimeout ? (
        <p className="text-sm font-semibold text-destructive">超时</p>
      ) : latency > 0 ? (
        <p className="text-sm font-semibold tabular-nums">
          <span className={latency < 50 ? "text-emerald-500" : latency < 100 ? "text-chart-3" : latency < 200 ? "text-amber-500" : "text-destructive"}>
            {latency}ms
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">无数据</p>
      )}
    </div>
  );
}

function TcpingDetailDialog({
  ruleId,
  ruleName,
  open,
  onOpenChange,
}: {
  ruleId: number;
  ruleName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading } = trpc.rules.tcpingSeries.useQuery(
    { ruleId, hours: 24 },
    { enabled: open, refetchInterval: open ? 30000 : false }
  );
  const cachedData = tcpingSeriesCache.get(ruleId);
  const seriesData = (data ?? cachedData) as TcpingSeriesDatum[] | undefined;
  const showInitialLoading = isLoading && !seriesData;

  useEffect(() => {
    if (data) {
      tcpingSeriesCache.set(ruleId, data as TcpingSeriesDatum[]);
    }
  }, [data, ruleId]);

  const chartData = useMemo<TcpingChartPoint[]>(() => {
    if (!seriesData || seriesData.length === 0) return [];
    return seriesData.map((d: TcpingSeriesDatum): TcpingChartPoint => ({
      label: formatTcpingTime(d.recordedAt),
      fullLabel: formatTcpingTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      chartLatency: d.isTimeout ? 0 : clipLatencyForChart(Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [seriesData]);

  const yMax = useMemo(() => {
    if (!chartData || chartData.length === 0) return 120;
    return getLatencyYAxisMax(Math.max(...chartData.map((d) => d.chartLatency)), 120);
  }, [chartData]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);

  const tcpingStats = useMemo(() => {
    const total = chartData.length;
    const timeout = chartData.filter((d) => d.isTimeout).length;
    const lossRate = total > 0 ? Math.round((timeout / total) * 100) : 0;
    const values = chartData
      .filter((d) => !d.isTimeout && d.latency > 0)
      .map((d) => d.latency);
    if (values.length === 0) {
      return { total, timeout, lossRate, valid: 0, max: null as number | null, min: null as number | null, avg: null as number | null };
    }
    const sum = values.reduce((acc: number, v: number) => acc + v, 0);
    return {
      total,
      timeout,
      lossRate,
      valid: values.length,
      max: Math.max(...values),
      min: Math.min(...values),
      avg: Math.round(sum / values.length),
    };
  }, [chartData]);
  const shouldAnimateChart = open && chartData.length > 0 && !tcpingAnimatedKeys.has(ruleId);

  useEffect(() => {
    if (shouldAnimateChart) {
      tcpingAnimatedKeys.add(ruleId);
    }
  }, [shouldAnimateChart, ruleId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">转发链路延迟 (TCPing) - {ruleName}</DialogTitle>
          <DialogDescription>最近 24 小时延迟和丢包。</DialogDescription>
        </DialogHeader>
        <div className="h-72 w-full">
          {showInitialLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              暂无 TCPing 数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="tcpingGradientRule" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9 }}
                  minTickGap={60}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  tickFormatter={(v) => `${v}ms`}
                  width={50}
                  domain={[0, yMax]}
                  allowDecimals={false}
                  ticks={yTicks}
                />
                <RTooltip
                  content={<TcpingTooltipContent />}
                  cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                  offset={12}
                  wrapperStyle={{ pointerEvents: "none" }}
                />
                <Area
                  type="monotone"
                  dataKey="chartLatency"
                  name="延迟"
                  stroke="var(--color-chart-2)"
                  strokeWidth={2}
                  fill="url(#tcpingGradientRule)"
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }}
                  isAnimationActive={shouldAnimateChart}
                  animationDuration={shouldAnimateChart ? 500 : 0}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-latency-stats="true">
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">统计次数</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">
              {tcpingStats.total}
            </p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最大延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.max === null ? "--" : `${tcpingStats.max} ms`}</p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">丢包率</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.total === 0 ? "--" : `${tcpingStats.lossRate}%`}</p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最小延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.min === null ? "--" : `${tcpingStats.min} ms`}</p>
          </div>
          <div className="latency-stat-card col-span-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 sm:col-span-1">
            <p className="text-[11px] text-muted-foreground">平均延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.avg === null ? "--" : `${tcpingStats.avg} ms`}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


export { TcpingDetailDialog };

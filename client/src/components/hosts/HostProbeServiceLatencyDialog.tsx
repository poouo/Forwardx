import { useEffect, useMemo, useState } from "react";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Loader2, X } from "lucide-react";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { applyLatencyPeakCut, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";

const colors = ["var(--color-primary)", "#16a34a", "#d97706", "#dc2626", "#0d9488", "#be123c", "#f97316", "#64748b"];
const hostServiceLatencyAnimatedKeys = new Set<number>();
const HOST_SERVICE_CHART_POINT_BUDGET = 3200;
const HOST_SERVICE_CHART_MIN_POINTS = 260;
const HOST_SERVICE_CHART_MAX_POINTS = 720;

function formatTime(value: string | Date) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFullTime(value: string | Date) {
  const d = new Date(value);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${formatTime(d)}`;
}

function serviceAppliesToHost(service: any, hostId: number) {
  if (!hostId || service?.isEnabled === false) return false;
  if (service.hostScope === "specific") return (service.hostIds || []).map(Number).includes(hostId);
  if (service.hostScope === "exclude") return !(service.excludeHostIds || []).map(Number).includes(hostId);
  return true;
}

function hostServiceChartPointLimit(visibleCount: number) {
  const safeCount = Math.max(1, visibleCount || 1);
  return Math.max(
    HOST_SERVICE_CHART_MIN_POINTS,
    Math.min(HOST_SERVICE_CHART_MAX_POINTS, Math.floor(HOST_SERVICE_CHART_POINT_BUDGET / safeCount)),
  );
}

function compactHostServiceChart(points: any[], serviceIds: number[]) {
  if (points.length === 0 || serviceIds.length === 0) return points;
  const maxPoints = hostServiceChartPointLimit(serviceIds.length);
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const compacted: any[] = [];

  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, start + bucketSize);
    const representative = bucket[Math.floor(bucket.length / 2)] || bucket[0];
    const point: any = {
      at: representative.at,
      label: representative.label,
      fullLabel: representative.fullLabel,
    };

    for (const id of serviceIds) {
      const key = `service_${id}`;
      let maxLatency: number | null = null;
      let sawTimeout = false;
      for (const item of bucket) {
        const raw = item[`${key}Raw`];
        if (!raw) continue;
        if (raw.isTimeout) {
          sawTimeout = true;
          continue;
        }
        const latency = Number(raw.latencyMs);
        if (Number.isFinite(latency) && latency > 0) {
          maxLatency = Math.max(maxLatency || 0, latency);
        }
      }
      const isTimeout = maxLatency === null && sawTimeout;
      point[key] = isTimeout ? 0 : maxLatency;
      point[`${key}Timeout`] = isTimeout;
      point[`${key}Raw`] = { latencyMs: maxLatency, isTimeout };
    }

    compacted.push(point);
  }

  return compacted;
}

function ChartTooltip({ active, payload, label, services, allServices }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  return (
    <div className="pointer-events-none rounded-md border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">{point.fullLabel || label}</p>
      <div className="space-y-1">
        {services.map((service: any, index: number) => {
          const key = `service_${service.id}`;
          const raw = point[`${key}Raw`];
          const colorIndex = (allServices || services).findIndex((item: any) => Number(item.id) === Number(service.id));
          return (
            <div key={key} className="flex min-w-[180px] items-center justify-between gap-4 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: colors[Math.max(colorIndex, index, 0) % colors.length] }} />
                <span className="truncate">{service.name}</span>
              </span>
              <span className={raw?.isTimeout ? "font-medium text-destructive" : "font-semibold tabular-nums"}>
                {raw?.isTimeout ? "超时" : typeof raw?.latencyMs === "number" ? `${raw.latencyMs}ms` : "--"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HostProbeServiceLatencyDialog({
  open,
  onOpenChange,
  host,
  services,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: any | null;
  services: any[];
}) {
  const hostId = Number(host?.id || 0);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<number>>(new Set());
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const hostServices = useMemo(
    () => (services || []).filter((service) => serviceAppliesToHost(service, hostId)),
    [services, hostId],
  );
  const serviceIds = useMemo(() => hostServices.map((service) => Number(service.id)).filter(Boolean), [hostServices]);
  const visibleServices = useMemo(() => {
    if (selectedServiceIds.size === 0) return hostServices;
    return hostServices.filter((service) => selectedServiceIds.has(Number(service.id)));
  }, [hostServices, selectedServiceIds]);
  const visibleServiceIds = useMemo(() => visibleServices.map((service) => Number(service.id)).filter(Boolean), [visibleServices]);
  const chartAnimationKey = useMemo(() => `${hostId || "host"}`, [hostId]);
  const { data = [], isLoading } = trpc.hosts.probeServiceSeries.useQuery(
    { serviceIds, hostId, hours: 24 },
    { enabled: open && hostId > 0 && serviceIds.length > 0, refetchInterval: pollingInterval("slow", open) },
  );

  useEffect(() => {
    if (!open) {
      setSelectedServiceIds(new Set());
      return;
    }
    setSelectedServiceIds((current) => {
      if (current.size === 0) return current;
      const availableIds = new Set(serviceIds);
      const next = new Set(Array.from(current).filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [open, serviceIds]);

  const toggleService = (serviceId: number) => {
    setSelectedServiceIds((current) => {
      const next = new Set(current);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  };

  const rawChart = useMemo(() => {
    const aggregates = new Map<string, { bucket: number; serviceId: number; sum: number; count: number; timeout: number }>();
    for (const row of data as any[]) {
      const at = new Date(row.recordedAt).getTime();
      if (!Number.isFinite(at)) continue;
      const serviceId = Number(row.serviceId);
      if (!serviceId) continue;
      const bucket = Math.floor(at / 60000) * 60000;
      const key = `${bucket}:${serviceId}`;
      const aggregate = aggregates.get(key) || { bucket, serviceId, sum: 0, count: 0, timeout: 0 };
      if (row.isTimeout) aggregate.timeout += 1;
      else if (row.latencyMs != null && Number.isFinite(Number(row.latencyMs))) {
        aggregate.sum += Number(row.latencyMs);
        aggregate.count += 1;
      }
      aggregates.set(key, aggregate);
    }
    const byBucket = new Map<number, any>();
    for (const aggregate of aggregates.values()) {
      const point = byBucket.get(aggregate.bucket) || { at: aggregate.bucket, label: formatTime(new Date(aggregate.bucket)), fullLabel: formatFullTime(new Date(aggregate.bucket)) };
      const key = `service_${aggregate.serviceId}`;
      const isTimeout = aggregate.count === 0 && aggregate.timeout > 0;
      const latencyMs = aggregate.count > 0 ? Math.round(aggregate.sum / aggregate.count) : null;
      point[key] = isTimeout ? 0 : latencyMs;
      point[`${key}Timeout`] = isTimeout;
      point[`${key}Raw`] = { latencyMs, isTimeout };
      byBucket.set(aggregate.bucket, point);
    }
    return Array.from(byBucket.values()).sort((a, b) => a.at - b.at);
  }, [data]);

  const processedChart = useMemo(() => {
    if (!peakCutEnabled || visibleServiceIds.length === 0) return rawChart;
    const smoothed = applyLatencyPeakCut(
      rawChart,
      visibleServiceIds.map((id) => ({
        dataKey: `service_${id}`,
        timeoutKey: `service_${id}Timeout`,
      })),
    );
    return smoothed.map((point) => {
      let next = point;
      for (const id of visibleServiceIds) {
        const key = `service_${id}`;
        const rawKey = `${key}Raw`;
        const raw = (next as any)[rawKey];
        const latency = Number((next as any)[key]);
        if (raw && !raw.isTimeout && Number.isFinite(latency) && latency > 0 && raw.latencyMs !== latency) {
          next = {
            ...next,
            [rawKey]: { ...raw, latencyMs: Math.round(latency) },
          };
        }
      }
      return next;
    });
  }, [peakCutEnabled, rawChart, visibleServiceIds]);
  const chart = useMemo(
    () => compactHostServiceChart(processedChart, visibleServiceIds),
    [processedChart, visibleServiceIds],
  );
  const yMax = useMemo(() => {
    const maxLatency = Math.max(0, ...chart.flatMap((point) => (
      visibleServiceIds.map((id) => {
        const raw = point[`service_${id}Raw`];
        const latency = raw?.isTimeout ? 0 : Number(raw?.latencyMs || 0);
        return Number.isFinite(latency) ? latency : 0;
      })
    )));
    return maxLatency > 0 ? Math.ceil(maxLatency * 1.2) : 120;
  }, [chart, visibleServiceIds]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const shouldAnimateChart = open && hostId > 0 && chart.length > 0 && !hostServiceLatencyAnimatedKeys.has(hostId);

  useEffect(() => {
    if (shouldAnimateChart) {
      hostServiceLatencyAnimatedKeys.add(hostId);
    }
  }, [hostId, shouldAnimateChart]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[96svh] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-3 sm:max-w-5xl sm:p-6">
        <DialogHeader>
          <div className="flex flex-col gap-2 pr-9 sm:flex-row sm:items-start sm:justify-between sm:pr-10">
            <div className="min-w-0">
              <DialogTitle>服务延迟图表</DialogTitle>
              <DialogDescription>{host?.name ? `${host.name} 最近 24 小时服务探测延迟` : "最近 24 小时服务探测延迟"}</DialogDescription>
            </div>
            <LatencyPeakCutToggle id={`host-service-peak-cut-${hostId || "current"}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0 self-start sm:pt-1" />
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        {hostServices.length > 0 && (
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap gap-2">
              {hostServices.map((service, index) => {
                const serviceId = Number(service.id);
                const active = selectedServiceIds.size === 0 || selectedServiceIds.has(serviceId);
                return (
                  <button
                    key={service.id}
                    type="button"
                    onClick={() => toggleService(serviceId)}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors",
                      active
                        ? "border-border/60 bg-background text-foreground shadow-sm"
                        : "border-border/40 bg-muted/30 text-muted-foreground opacity-55 hover:opacity-85",
                    )}
                    aria-pressed={active}
                    title={service.name}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: colors[index % colors.length] }} />
                    <span className="truncate">{service.name}</span>
                  </button>
                );
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2.5"
              onClick={() => setSelectedServiceIds(new Set())}
              disabled={selectedServiceIds.size === 0}
            >
              <X className="h-3.5 w-3.5" />
              清除
            </Button>
          </div>
        )}
        <div className="h-[44svh] min-h-[220px] w-full sm:h-80">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载图表</div>
          ) : chart.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无服务延迟数据</div>
          ) : (
            <ResponsiveContainer key={chartAnimationKey} width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={46} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}ms`} width={52} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                <RTooltip content={<ChartTooltip services={visibleServices} allServices={hostServices} />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
                {visibleServices.map((service) => {
                  const colorIndex = hostServices.findIndex((item) => Number(item.id) === Number(service.id));
                  return (
                    <Line
                      key={service.id}
                      type="monotone"
                      dataKey={`service_${service.id}`}
                      name={service.name}
                      stroke={colors[Math.max(colorIndex, 0) % colors.length]}
                      strokeWidth={1.05}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={shouldAnimateChart}
                      animationDuration={shouldAnimateChart ? 500 : 0}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

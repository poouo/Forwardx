import { useMemo } from "react";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { clipLatencyForChart, getLatencyYAxisMax, getLatencyYAxisTicks } from "@/lib/latencyChart";

const colors = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be123c", "#4f46e5"];

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

function ChartTooltip({ active, payload, label, services }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  return (
    <div className="pointer-events-none rounded-md border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">{point.fullLabel || label}</p>
      <div className="space-y-1">
        {services.map((service: any, index: number) => {
          const key = `service_${service.id}`;
          const raw = point[`${key}Raw`];
          return (
            <div key={key} className="flex min-w-[180px] items-center justify-between gap-4 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: colors[index % colors.length] }} />
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
  const hostServices = useMemo(
    () => (services || []).filter((service) => serviceAppliesToHost(service, hostId)),
    [services, hostId],
  );
  const serviceIds = useMemo(() => hostServices.map((service) => Number(service.id)).filter(Boolean), [hostServices]);
  const { data = [], isLoading } = trpc.hosts.probeServiceSeries.useQuery(
    { serviceIds, hostId, hours: 24 },
    { enabled: open && hostId > 0 && serviceIds.length > 0, refetchInterval: open ? 30000 : false },
  );

  const chart = useMemo(() => {
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
      point[key] = isTimeout ? 0 : latencyMs == null ? null : clipLatencyForChart(latencyMs);
      point[`${key}Raw`] = { latencyMs, isTimeout };
      byBucket.set(aggregate.bucket, point);
    }
    return Array.from(byBucket.values()).sort((a, b) => a.at - b.at);
  }, [data]);

  const yMax = useMemo(
    () => getLatencyYAxisMax(Math.max(0, ...chart.flatMap((point) => serviceIds.map((id) => Number(point[`service_${id}`] || 0)))), 120),
    [chart, serviceIds],
  );
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>服务延迟图表</DialogTitle>
          <DialogDescription>{host?.name ? `${host.name} 最近 24 小时服务探测延迟` : "最近 24 小时服务探测延迟"}</DialogDescription>
        </DialogHeader>
        {hostServices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {hostServices.map((service, index) => (
              <span key={service.id} className="inline-flex max-w-full items-center gap-1.5 rounded border border-border/50 px-2 py-1 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: colors[index % colors.length] }} />
                <span className="truncate">{service.name}</span>
              </span>
            ))}
          </div>
        )}
        <div className="h-80 w-full">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载图表</div>
          ) : chart.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无服务延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={46} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}ms`} width={52} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                <RTooltip content={<ChartTooltip services={hostServices} />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
                {hostServices.map((service, index) => (
                  <Line key={service.id} type="monotone" dataKey={`service_${service.id}`} name={service.name} stroke={colors[index % colors.length]} strokeWidth={2} dot={false} connectNulls={false} activeDot={{ r: 4 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
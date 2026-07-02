import DataSectionLoading from "@/components/DataSectionLoading";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ActivitySquare,
  ArrowLeftCircle,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  CalendarDays,
  CircleCheck,
  Clock,
  Cpu,
  HardDrive,
  LayoutGrid,
  LayoutDashboard,
  List,
  Loader2,
  MemoryStick,
  Monitor,
  MonitorCheck,
  Rows3,
  Server,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Link, useLocation } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatBytes,
  formatUptime,
  HostRegionBadge,
  metricUsageProgressClass,
} from "@/components/hosts/hostDisplay";
import { applyLatencyPeakCut, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/NotFound";

type HostMonitorViewMode = "card" | "compact-card" | "table";

const HOST_MONITOR_VIEW_MODE_STORAGE_KEY = "forwardx.publicHostMonitor.viewMode";
const serviceChartColors = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#be123c", "#4f46e5"];

function getStoredHostMonitorViewMode(): HostMonitorViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_MONITOR_VIEW_MODE_STORAGE_KEY);
    return value === "compact-card" || value === "table" ? value : "card";
  } catch {
    return "card";
  }
}

function storeHostMonitorViewMode(viewMode: HostMonitorViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOST_MONITOR_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // View preference is optional.
  }
}

function formatNetworkSpeed(value: number | null | undefined) {
  if (value == null) return "--/s";
  return `${formatBytes(Math.max(0, Number(value) || 0)).replace(" ", "\u00a0")}/s`;
}

function formatOptionalBytesPerSecond(value: unknown) {
  if (value === null || value === undefined) return "--";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  return formatNetworkSpeed(bytes);
}

function formatPercent(value: unknown) {
  const num = Math.round(Number(value) || 0);
  return `${Math.max(0, Math.min(999, num))}%`;
}

function clampPercent(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function formatUsagePercent(value: unknown) {
  const percent = clampPercent(value);
  return percent === null ? "--" : `${percent}%`;
}

function formatMetricSizeDetail(used: unknown, total: unknown) {
  const usedBytes = Number(used);
  const totalBytes = Number(total);
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return "";
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return formatBytes(usedBytes);
  return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

function formatFullDateTime(value: unknown) {
  if (!value) return "--";
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? (value > 0 && value < 10_000_000_000 ? value * 1000 : value)
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "--";
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatMonitorDate(value: unknown) {
  if (!value) return "永久有效";
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? (value > 0 && value < 10_000_000_000 ? value * 1000 : value)
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "--";
  const date = new Date(ms);
  const text = date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  return ms < Date.now() ? `${text} 已到期` : text;
}

function formatChartTime(value: string | Date | number) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function calculateMonitorSummary(hosts: any[], metricsByHostId: Map<number, any>, trafficByHostId: Map<number, any>) {
  let currentTrafficIn = 0;
  let currentTrafficOut = 0;
  let totalTrafficIn = 0;
  let totalTrafficOut = 0;
  for (const host of hosts) {
    const hostId = Number(host.id);
    const metric = metricsByHostId.get(hostId);
    const traffic = trafficByHostId.get(hostId);
    currentTrafficIn += Math.max(0, Number(metric?.networkSpeedIn) || 0);
    currentTrafficOut += Math.max(0, Number(metric?.networkSpeedOut) || 0);
    totalTrafficIn += Math.max(0, Number(traffic?.bytesIn) || 0);
    totalTrafficOut += Math.max(0, Number(traffic?.bytesOut) || 0);
  }
  return {
    totalHosts: hosts.length,
    onlineHosts: hosts.filter((host) => !!host.isOnline).length,
    currentTrafficIn,
    currentTrafficOut,
    totalTrafficIn,
    totalTrafficOut,
  };
}

function normalizeMonitorPathFromLocation(location: string) {
  return String(location || "/")
    .split("?")[0]
    .split("#")[0]
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase() || "dev";
}

function HostMonitorStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  leadingIcon: LeadingIcon,
  leadingTone = "bg-emerald-500",
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: LucideIcon;
  leadingIcon?: LucideIcon;
  leadingTone?: string;
}) {
  return (
    <Card className="group relative h-full overflow-hidden border-border/40 bg-card/70 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
      <CardContent className="relative flex h-full min-h-[108px] flex-col justify-center p-4">
        <div className="pointer-events-none absolute right-4 top-3.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-sm sm:flex">
          <Icon className="h-5 w-5" />
        </div>
        <p className="pr-12 text-xs font-medium text-muted-foreground">{title}</p>
        <div className="mt-1 flex min-w-0 items-center gap-2.5 pr-12">
          {LeadingIcon && (
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ${leadingTone}`}>
              <LeadingIcon className="h-4 w-4 text-white" />
            </div>
          )}
          <div className="min-w-0">
            <span className="block truncate text-2xl font-bold leading-none tabular-nums" title={value}>{value}</span>
            <p className="mt-2 truncate text-xs text-muted-foreground" title={subtitle}>{subtitle}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HostMonitorTrafficDirectionStat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2.5">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ${tone}`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-4 text-muted-foreground">{label}</p>
          <p className="mt-0.5 truncate text-lg font-semibold leading-tight tabular-nums" title={value}>{value}</p>
        </div>
      </div>
    </div>
  );
}

function HostMonitorTrafficStatCard({
  title,
  inValue,
  outValue,
  icon: Icon,
}: {
  title: string;
  inValue: string;
  outValue: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="group relative h-full overflow-hidden border-border/40 bg-card/70 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
      <CardContent className="relative flex h-full min-h-[108px] flex-col justify-center p-4">
        <div className="pointer-events-none absolute right-4 top-3.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-sm sm:flex">
          <Icon className="h-5 w-5" />
        </div>
        <p className="mb-2.5 pr-12 text-xs font-medium text-muted-foreground">{title}</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-3 pr-0 sm:pr-9">
          <HostMonitorTrafficDirectionStat
            label="入向"
            value={inValue}
            icon={ArrowDownToLine}
            tone="bg-emerald-500"
          />
          <HostMonitorTrafficDirectionStat
            label="出向"
            value={outValue}
            icon={ArrowUpFromLine}
            tone="bg-amber-500"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function PublicHostCard({
  host,
  metric,
  traffic,
  compact = false,
  onSelect,
}: {
  host: any;
  metric: any;
  traffic: any;
  compact?: boolean;
  onSelect?: (host: any) => void;
}) {
  const isOnline = !!host.isOnline;
  const cpuUsage = Number(metric?.cpuUsage ?? 0);
  const memoryUsage = Number(metric?.memoryUsage ?? 0);
  const diskUsage = Number(metric?.diskUsage ?? 0);
  const totalIn = traffic?.bytesIn == null ? 0 : Number(traffic.bytesIn) || 0;
  const totalOut = traffic?.bytesOut == null ? 0 : Number(traffic.bytesOut) || 0;
  const trafficLimit = Math.max(0, Number(host.trafficLimit || 0));
  const trafficMode = host.trafficMeasureMode === "outbound" || host.trafficMeasureMode === "max" ? host.trafficMeasureMode : "both";
  const usedTraffic = trafficMode === "outbound"
    ? totalOut
    : trafficMode === "max"
      ? Math.max(totalIn, totalOut)
      : totalIn + totalOut;
  const trafficPercent = trafficLimit > 0 ? Math.round((usedTraffic / trafficLimit) * 100) : 0;
  const metricItems = [
    { key: "cpu", label: "CPU", icon: Cpu, value: cpuUsage, progress: cpuUsage },
    { key: "memory", label: "内存", icon: MemoryStick, value: memoryUsage, progress: memoryUsage },
    { key: "disk", label: "磁盘", icon: HardDrive, value: diskUsage, progress: diskUsage },
    { key: "traffic", label: "流量", icon: Activity, value: trafficLimit > 0 ? trafficPercent : null, progress: trafficLimit > 0 ? trafficPercent : 0 },
  ];
  const cardMinHeightClass = compact ? "min-h-[220px]" : "min-h-[300px]";
  const cardPaddingClass = compact ? "p-3" : "p-4";
  const sectionPaddingClass = compact ? "p-2.5" : "p-3";

  return (
    <Card
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={() => onSelect?.(host)}
      onKeyDown={(event) => {
        if (!onSelect) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(host);
        }
      }}
      className={`${cardMinHeightClass} border-border/40 bg-card/70 backdrop-blur-md transition-[border-color,background-color,box-shadow,transform] ${onSelect ? "cursor-pointer hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-lg hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : ""} ${isOnline ? "hover:border-border/70" : "bg-muted/35 text-muted-foreground"}`}
    >
      <CardContent className={`${compact ? "space-y-2" : "space-y-3"} ${cardPaddingClass}`}>
        <div className={`rounded-md border border-border/40 bg-background/35 ${sectionPaddingClass}`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
            <span className="min-w-0 truncate text-sm font-semibold" title={host.name}>{host.name || "-"}</span>
            <span className="shrink-0 rounded border border-border/50 bg-background/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
              {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
            </span>
            <Badge variant="outline" className={`ml-auto shrink-0 text-[10px] ${isOnline ? "border-emerald-500/30 text-emerald-600" : "border-destructive/30 text-destructive"}`}>
              {isOnline ? "在线" : "离线"}
            </Badge>
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">国家/地区：</span>
            <HostRegionBadge host={host} compact />
          </div>
        </div>

        <div className={`rounded-md border border-border/40 bg-muted/20 ${sectionPaddingClass}`}>
          <div className={compact ? "space-y-1.5" : "space-y-2"}>
            {metricItems.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.key} className="grid grid-cols-[18px_minmax(0,1fr)_52px] items-center gap-2 text-xs">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <Progress value={item.progress} className={metricUsageProgressClass(item.progress, isOnline)} />
                  <span className="text-right font-medium tabular-nums">{item.value == null ? "∞" : formatPercent(item.value)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground"><ArrowDownToLine className="h-3 w-3" /> 入站</span>
              <span className="font-medium tabular-nums">{formatNetworkSpeed(metric?.networkSpeedIn)}</span>
            </div>
          </div>
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground"><ArrowUpFromLine className="h-3 w-3" /> 出站</span>
              <span className="font-medium tabular-nums">{formatNetworkSpeed(metric?.networkSpeedOut)}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
            <div className="space-y-1">
              <span className="flex items-center gap-1.5 text-muted-foreground"><ArrowRightLeft className="h-3 w-3" /> 累计</span>
              <div className="truncate font-medium tabular-nums" title={`入 ${formatBytes(totalIn)} / 出 ${formatBytes(totalOut)}`}>
                入 {formatBytes(totalIn)}
              </div>
              <div className="truncate font-medium tabular-nums">
                出 {formatBytes(totalOut)}
              </div>
            </div>
          </div>
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
            <div className="space-y-1">
              <span className="flex items-center gap-1.5 text-muted-foreground"><CalendarDays className="h-3 w-3" /> 到期</span>
              <div className="truncate font-medium tabular-nums" title={formatMonitorDate(host.stoppedAt)}>
                {formatMonitorDate(host.stoppedAt)}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">运行时间</span>
          <span className="ml-auto font-medium tabular-nums">{metric?.uptime == null ? "-" : formatUptime(metric.uptime)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PublicHostListResourceMetric({
  icon: Icon,
  label,
  value,
  detail,
  isOnline,
}: {
  icon: LucideIcon;
  label: string;
  value: unknown;
  detail?: string;
  isOnline: boolean;
}) {
  const percent = clampPercent(value);
  const progressValue = percent ?? 0;
  const progressClass = percent === null
    ? "h-1.5 bg-muted [&>div]:bg-muted-foreground/20"
    : metricUsageProgressClass(progressValue, isOnline);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{label}</span>
        <span className="ml-auto font-semibold tabular-nums text-foreground">{formatUsagePercent(value)}</span>
      </div>
      <Progress value={progressValue} className={progressClass} />
      {detail && (
        <div className="truncate text-[10px] leading-none text-muted-foreground/70" title={detail}>
          {detail}
        </div>
      )}
    </div>
  );
}

function PublicHostListFlowPair({
  inValue,
  outValue,
  inTitle,
  outTitle,
}: {
  inValue: string;
  outValue: string;
  inTitle?: string;
  outTitle?: string;
}) {
  return (
    <div className="min-w-0 space-y-1 text-xs tabular-nums">
      <div className="flex items-center gap-1.5 text-emerald-500" title={inTitle || inValue}>
        <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{inValue}</span>
      </div>
      <div className="flex items-center gap-1.5 text-sky-500" title={outTitle || outValue}>
        <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{outValue}</span>
      </div>
    </div>
  );
}

function PublicHostTable({
  hosts,
  metricsByHostId,
  trafficByHostId,
  onSelectHost,
}: {
  hosts: any[];
  metricsByHostId: Map<number, any>;
  trafficByHostId: Map<number, any>;
  onSelectHost?: (host: any) => void;
}) {
  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md">
      <CardContent className="p-0">
        <Table className="min-w-0 table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[76px] whitespace-nowrap px-3">状态</TableHead>
              <TableHead className="w-[230px] px-3">设备名称</TableHead>
              <TableHead className="w-[112px] whitespace-nowrap px-3">CPU</TableHead>
              <TableHead className="w-[116px] whitespace-nowrap px-3">RAM</TableHead>
              <TableHead className="w-[116px] whitespace-nowrap px-3">磁盘</TableHead>
              <TableHead className="w-[118px] whitespace-nowrap px-3">累计流量</TableHead>
              <TableHead className="w-[118px] whitespace-nowrap px-3">实时网络</TableHead>
              <TableHead className="w-[136px] whitespace-nowrap px-3">时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.map((host) => {
              const metric = metricsByHostId.get(Number(host.id));
              const traffic = trafficByHostId.get(Number(host.id));
              const isOnline = !!host.isOnline;
              const memoryDetail = formatMetricSizeDetail(metric?.memoryUsed, host.memoryTotal);
              const diskDetail = formatMetricSizeDetail(metric?.diskUsed, metric?.diskTotal);
              return (
                <TableRow
                  key={host.id}
                  className="h-[76px] cursor-pointer align-middle hover:bg-muted/25"
                  onClick={() => onSelectHost?.(host)}
                >
                  <TableCell className="w-[76px] whitespace-nowrap px-3 py-3">
                    <Badge variant="outline" className={`gap-1.5 text-xs ${isOnline ? "border-emerald-500/30 text-emerald-600" : "border-destructive/30 text-destructive"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-destructive"}`} />
                      {isOnline ? "在线" : "离线"}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-[230px] px-3 py-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-semibold" title={host.name}>{host.name || "-"}</span>
                        <span className="shrink-0 rounded border border-border/50 bg-muted/35 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                          {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                        </span>
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="shrink-0">国家/地区：</span>
                        <HostRegionBadge host={host} compact />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric icon={Cpu} label="CPU" value={metric?.cpuUsage} isOnline={isOnline} />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric icon={MemoryStick} label="RAM" value={metric?.memoryUsage} detail={memoryDetail} isOnline={isOnline} />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListResourceMetric icon={HardDrive} label="Disk" value={metric?.diskUsage} detail={diskDetail} isOnline={isOnline} />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListFlowPair
                      inValue={formatBytes(Number(traffic?.bytesIn || 0))}
                      outValue={formatBytes(Number(traffic?.bytesOut || 0))}
                      inTitle={`累计入向：${formatBytes(Number(traffic?.bytesIn || 0))}`}
                      outTitle={`累计出向：${formatBytes(Number(traffic?.bytesOut || 0))}`}
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <PublicHostListFlowPair
                      inValue={formatOptionalBytesPerSecond(metric?.networkSpeedIn)}
                      outValue={formatOptionalBytesPerSecond(metric?.networkSpeedOut)}
                      inTitle="实时入向"
                      outTitle="实时出向"
                    />
                  </TableCell>
                  <TableCell className="px-3 py-3">
                    <div className="space-y-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Clock className="h-3.5 w-3.5" />
                      {metric?.uptime == null ? "-" : formatUptime(metric.uptime)}
                    </div>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {formatMonitorDate(host.stoppedAt)}
                    </div>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ServiceChartTooltip({ active, payload, label, services }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  return (
    <div className="pointer-events-none rounded-md border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1 text-xs text-muted-foreground">{point.fullLabel || label}</p>
      <div className="space-y-1">
        {services.map((service: any, index: number) => {
          const raw = point[`service_${service.id}Raw`];
          return (
            <div key={service.id} className="flex min-w-[180px] items-center justify-between gap-4 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: serviceChartColors[index % serviceChartColors.length] }} />
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

function buildServiceLatencyChart(series: any[], services: any[]) {
  const serviceIds = new Set(services.map((service) => Number(service.id)));
  const buckets = new Map<number, any>();
  for (const row of series) {
    const serviceId = Number(row.serviceId);
    if (!serviceIds.has(serviceId)) continue;
    const at = new Date(row.recordedAt).getTime();
    if (!Number.isFinite(at)) continue;
    const bucket = Math.floor(at / 60000) * 60000;
    const key = `service_${serviceId}`;
    const point = buckets.get(bucket) || {
      at: bucket,
      label: formatChartTime(bucket),
      fullLabel: formatFullDateTime(bucket),
    };
    const isTimeout = !!row.isTimeout;
    const latency = isTimeout ? null : Number(row.latencyMs);
    point[key] = isTimeout ? 0 : Number.isFinite(latency) ? latency : null;
    point[`${key}Timeout`] = isTimeout;
    point[`${key}Raw`] = {
      latencyMs: Number.isFinite(latency) ? latency : null,
      isTimeout,
    };
    buckets.set(bucket, point);
  }
  return Array.from(buckets.values()).sort((a, b) => a.at - b.at);
}

function DetailInfoItem({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`min-w-0 rounded-lg border border-border/30 bg-card/35 px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0 ${className}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
    </div>
  );
}

function HostMonitorDetail({
  path,
  host,
  fallbackMetric,
  fallbackTraffic,
  onBack,
}: {
  path: string;
  host: any;
  fallbackMetric: any;
  fallbackTraffic: any;
  onBack: () => void;
}) {
  const hostId = Number(host?.id || 0);
  const detail = trpc.hosts.publicMonitorHostDetail.useQuery(
    { path, hostId, hours: 24 },
    {
      enabled: hostId > 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: pollingInterval("slow", hostId > 0),
    },
  );
  const detailHost = detail.data?.host || host;
  const metric = detail.data?.metric || fallbackMetric || {};
  const traffic = detail.data?.traffic || fallbackTraffic || {};
  const services = (detail.data?.services || []) as any[];
  const series = (detail.data?.serviceSeries || []) as any[];
  const isOnline = !!detailHost?.isOnline;
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<number>>(new Set());
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const visibleServices = useMemo(() => {
    if (selectedServiceIds.size === 0) return services;
    return services.filter((service) => selectedServiceIds.has(Number(service.id)));
  }, [selectedServiceIds, services]);
  const visibleServiceIds = useMemo(
    () => visibleServices.map((service) => Number(service.id)).filter(Boolean),
    [visibleServices],
  );
  const rawChart = useMemo(() => buildServiceLatencyChart(series, services), [series, services]);
  const chart = useMemo(() => {
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
  const yMax = useMemo(() => {
    const values = chart.flatMap((point) => visibleServices.map((service) => Number(point[`service_${service.id}`]) || 0));
    const max = Math.max(0, ...values);
    return max > 0 ? Math.ceil(max * 1.2) : 120;
  }, [chart, visibleServices]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const totalIn = Number(traffic?.bytesIn || 0);
  const totalOut = Number(traffic?.bytesOut || 0);
  const toggleService = (serviceId: number) => {
    setSelectedServiceIds((current) => {
      const next = new Set(current);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  };

  return (
    <div className="animate-in fade-in-0 slide-in-from-right-2 duration-200">
      <div className="mb-4 flex min-w-0 items-center gap-2 sm:mb-6">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full" onClick={onBack} title="返回">
          <ArrowLeftCircle className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 truncate text-lg font-bold tracking-tight sm:text-xl">{detailHost?.name || "主机详情"}</h2>
        <Badge variant="outline" className={`ml-auto shrink-0 gap-1.5 sm:ml-2 ${isOnline ? "border-emerald-500/30 text-emerald-600" : "border-destructive/30 text-destructive"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-emerald-500" : "bg-destructive"}`} />
          {isOnline ? "在线" : "离线"}
        </Badge>
      </div>

      <div className="grid max-w-6xl grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-x-8 sm:gap-y-4 lg:grid-cols-6">
        <DetailInfoItem label="状态" value={isOnline ? "在线" : "离线"} className={isOnline ? "text-emerald-600" : "text-destructive"} />
        <DetailInfoItem label="运行时间" value={metric?.uptime == null ? "-" : formatUptime(metric.uptime)} />
        <DetailInfoItem label="内存" value={formatMetricSizeDetail(metric?.memoryUsed, detailHost?.memoryTotal) || formatUsagePercent(metric?.memoryUsage)} />
        <DetailInfoItem label="磁盘" value={formatMetricSizeDetail(metric?.diskUsed, metric?.diskTotal) || formatUsagePercent(metric?.diskUsage)} />
        <div className="min-w-0 rounded-lg border border-border/30 bg-card/35 px-3 py-2 sm:border-0 sm:bg-transparent sm:p-0">
          <p className="text-xs text-muted-foreground">区域</p>
          <div className="mt-1"><HostRegionBadge host={detailHost} compact /></div>
        </div>
        <DetailInfoItem label="版本" value={detailHost?.agentVersion ? `v${detailHost.agentVersion}` : "未上报"} />
        <DetailInfoItem label="实时入站" value={formatOptionalBytesPerSecond(metric?.networkSpeedIn)} />
        <DetailInfoItem label="实时出站" value={formatOptionalBytesPerSecond(metric?.networkSpeedOut)} />
        <DetailInfoItem label="累计入站" value={formatBytes(totalIn)} />
        <DetailInfoItem label="累计出站" value={formatBytes(totalOut)} />
        <DetailInfoItem label="到期时间" value={formatMonitorDate(detailHost?.stoppedAt)} />
        <DetailInfoItem label="最后上报" value={formatFullDateTime(metric?.recordedAt || detailHost?.lastHeartbeat)} />
      </div>

      <div className="my-5 h-px bg-border sm:my-7" />

        <Card className="overflow-hidden border-border/40 bg-card/70 backdrop-blur-md">
          <CardContent className="p-0">
            {services.length > 0 && (
              <div className="grid border-b border-border/40 md:grid-cols-[120px_minmax(0,1fr)]">
                <div className="flex min-h-[72px] flex-row items-center justify-between gap-3 border-b border-border/40 p-3 md:min-h-[92px] md:flex-col md:items-start md:justify-center md:border-b-0 md:border-r md:p-4">
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold md:text-lg">{detailHost?.name || "主机"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{services.length} 个监控服务</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex w-fit shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 md:mt-2"
                    onClick={() => setSelectedServiceIds(new Set())}
                    disabled={selectedServiceIds.size === 0}
                  >
                    <X className="h-3.5 w-3.5" />
                    清除筛选
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-2 xl:grid-cols-4">
                  {services.map((service, index) => {
                    const serviceId = Number(service.id);
                    const active = selectedServiceIds.size === 0 || selectedServiceIds.has(serviceId);
                    const latest = service.latest;
                    const timeout = !!latest?.isTimeout;
                    const latency = latest?.latencyMs == null ? "--" : `${latest.latencyMs}ms`;
                    return (
                      <button
                        key={service.id}
                        type="button"
                        className={cn(
                          "min-h-[84px] border-b border-r border-border/40 p-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 odd:last:border-r-0 sm:min-h-[92px] sm:p-4 sm:last:border-r-0",
                          active ? "bg-background/20" : "bg-muted/20 opacity-50",
                        )}
                        onClick={() => toggleService(serviceId)}
                        aria-pressed={active}
                        title={active ? "点击取消筛选" : "点击筛选该服务"}
                      >
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="h-2 w-2 rounded-full" style={{ background: serviceChartColors[index % serviceChartColors.length] }} />
                          <span className="truncate">{service.name}</span>
                        </div>
                        <p className={`mt-2 text-xl font-bold tabular-nums sm:text-2xl ${timeout ? "text-destructive" : ""}`}>{timeout ? "超时" : latency}</p>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground sm:text-xs">{latest?.recordedAt ? formatFullDateTime(latest.recordedAt) : "暂无上报"}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 px-3 pt-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:pt-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">服务延迟趋势</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selectedServiceIds.size > 0 ? `已筛选 ${visibleServices.length} 个服务` : "点击上方服务可筛选图表"}
                </p>
              </div>
              <LatencyPeakCutToggle id={`public-host-service-peak-cut-${hostId || "current"}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0" />
            </div>

            <div className="h-[280px] p-3 sm:h-[360px] sm:p-4">
              {detail.isLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在加载服务监控
                </div>
              ) : services.length === 0 || chart.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无服务监控延迟数据</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={42} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}ms`} width={58} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                    <RTooltip content={<ServiceChartTooltip services={visibleServices} />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
                    {visibleServices.map((service, index) => (
                      <Line
                        key={service.id}
                        type="monotone"
                        dataKey={`service_${service.id}`}
                        name={service.name}
                        stroke={serviceChartColors[index % serviceChartColors.length]}
                        strokeWidth={1.25}
                        dot={false}
                        connectNulls={false}
                        activeDot={{ r: 3 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
    </div>
  );
}

export default function HostMonitor() {
  const [location] = useLocation();
  const path = normalizeMonitorPathFromLocation(location);
  const [viewMode, setViewMode] = useState<HostMonitorViewMode>(() => getStoredHostMonitorViewMode());
  const [selectedGroupId, setSelectedGroupId] = useState("all");
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const currentUser = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const publicInfo = trpc.system.publicInfo.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const monitor = trpc.hosts.publicMonitor.useQuery(
    { path },
    {
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: pollingInterval("active"),
    },
  );
  const metricsByHostId = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of (monitor.data?.metrics || []) as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [monitor.data?.metrics]);
  const trafficByHostId = useMemo(() => {
    const map = new Map<number, any>();
    for (const row of (monitor.data?.traffic || []) as any[]) map.set(Number(row.hostId), row);
    return map;
  }, [monitor.data?.traffic]);

  const hosts = (monitor.data?.hosts || []) as any[];
  const groups = (monitor.data?.groups || []) as any[];
  const activeGroup = groups.find((group) => String(group.id) === selectedGroupId);
  const activeGroupId = selectedGroupId === "all" || activeGroup ? selectedGroupId : "all";
  const visibleHosts = useMemo(() => {
    if (activeGroupId === "all") return hosts;
    const hostIds = new Set((activeGroup?.hostIds || []).map((id: unknown) => Number(id)));
    return hosts.filter((host) => hostIds.has(Number(host.id)));
  }, [activeGroup?.hostIds, activeGroupId, hosts]);
  const summary = useMemo(
    () => calculateMonitorSummary(visibleHosts, metricsByHostId, trafficByHostId),
    [metricsByHostId, trafficByHostId, visibleHosts],
  );
  const onlineCount = summary.onlineHosts;
  const totalCount = summary.totalHosts;
  const isLoggedIn = !!currentUser.data;
  const monitorTitle = publicInfo.data?.publicHostMonitor?.title?.trim()
    || `${publicInfo.data?.siteTitle || "ForwardX"} 主机监控`;
  const selectedHost = selectedHostId ? hosts.find((host) => Number(host.id) === selectedHostId) || null : null;
  const handleViewModeChange = (mode: HostMonitorViewMode) => {
    setViewMode(mode);
    storeHostMonitorViewMode(mode);
  };

  if (monitor.isError) return <NotFound />;

  return (
    <div className="min-h-screen bg-background/65">
      <header className="sticky top-0 z-20 border-b border-border/40 bg-background/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/50 bg-card/70 text-primary">
              <Monitor className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">{monitorTitle}</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!selectedHost && <div className="flex items-center overflow-hidden rounded-md border border-border/40">
              <Button
                variant={viewMode === "compact-card" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="精简卡片"
                onClick={() => handleViewModeChange("compact-card")}
              >
                <Rows3 className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "card" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="标准卡片"
                onClick={() => handleViewModeChange("card")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8 rounded-none"
                title="列表视图"
                onClick={() => handleViewModeChange("table")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>}
            <Button asChild size="sm" className="gap-2">
              <Link href={isLoggedIn ? "/hosts" : "/login"}>
                <LayoutDashboard className="h-4 w-4" />
                {isLoggedIn ? "进入后台" : "登录"}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6">
        {monitor.isLoading && !monitor.data ? (
          <DataSectionLoading label="正在加载主机监控" minHeight="min-h-[320px]" />
        ) : selectedHost ? (
          <HostMonitorDetail
            path={path}
            host={selectedHost}
            fallbackMetric={metricsByHostId.get(Number(selectedHost.id))}
            fallbackTraffic={trafficByHostId.get(Number(selectedHost.id))}
            onBack={() => setSelectedHostId(null)}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <HostMonitorStatCard
                title="在线状态"
                value={`${onlineCount} / ${totalCount}`}
                subtitle={totalCount - onlineCount > 0 ? `离线 ${Math.max(0, totalCount - onlineCount)} 台` : "全部在线"}
                icon={MonitorCheck}
                leadingIcon={CircleCheck}
              />
              <HostMonitorTrafficStatCard
                title="当前瞬时流量"
                inValue={formatNetworkSpeed(summary?.currentTrafficIn)}
                outValue={formatNetworkSpeed(summary?.currentTrafficOut)}
                icon={ActivitySquare}
              />
              <HostMonitorTrafficStatCard
                title="累计流量"
                inValue={formatBytes(summary?.totalTrafficIn || 0)}
                outValue={formatBytes(summary?.totalTrafficOut || 0)}
                icon={ArrowRightLeft}
              />
            </div>

            <div className="flex min-h-9 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 gap-2 overflow-x-auto pb-1 sm:pb-0">
                <Button
                  type="button"
                  variant={activeGroupId === "all" ? "secondary" : "outline"}
                  size="sm"
                  className="shrink-0"
                  onClick={() => setSelectedGroupId("all")}
                >
                  全部
                  <span className="ml-1 text-xs text-muted-foreground">{hosts.length}</span>
                </Button>
                {groups.map((group) => (
                  <Button
                    key={group.id}
                    type="button"
                    variant={activeGroupId === String(group.id) ? "secondary" : "outline"}
                    size="sm"
                    className="shrink-0"
                    onClick={() => setSelectedGroupId(String(group.id))}
                  >
                    {group.name}
                    <span className="ml-1 text-xs text-muted-foreground">{group.hostIds?.length || 0}</span>
                  </Button>
                ))}
              </div>
              <div
                className={`flex h-5 items-center justify-end gap-2 text-xs text-muted-foreground transition-opacity ${monitor.isFetching && monitor.data ? "opacity-100" : "opacity-0"}`}
                aria-hidden={!(monitor.isFetching && monitor.data)}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在刷新
              </div>
            </div>

            {visibleHosts.length > 0 ? (
              viewMode === "table" ? (
                <PublicHostTable
                  hosts={visibleHosts}
                  metricsByHostId={metricsByHostId}
                  trafficByHostId={trafficByHostId}
                  onSelectHost={(host) => setSelectedHostId(Number(host.id))}
                />
              ) : (
              <div
                className={
                  viewMode === "compact-card"
                    ? "standard-card-grid-compact host-card-grid-static host-card-grid-static-compact gap-3"
                    : "standard-card-grid host-card-grid-static host-card-grid-static-standard gap-4"
                }
              >
                {visibleHosts.map((host) => (
                  <PublicHostCard
                    key={host.id}
                    host={host}
                    metric={metricsByHostId.get(Number(host.id))}
                    traffic={trafficByHostId.get(Number(host.id))}
                    compact={viewMode === "compact-card"}
                    onSelect={(nextHost) => setSelectedHostId(Number(nextHost.id))}
                  />
                ))}
              </div>
              )
            ) : (
              <Card className="border-border/40 bg-card/70 backdrop-blur-md">
                <CardContent className="flex min-h-[240px] flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <Server className="mb-3 h-10 w-10 opacity-50" />
                  <p className="font-medium text-foreground">暂无主机</p>
                  <p className="mt-1 text-sm">后台添加主机后会在这里展示。</p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}

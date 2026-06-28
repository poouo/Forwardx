import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock,
  Cpu,
  Download,
  HardDrive,
  RotateCcw,
  Loader2,
  MemoryStick,
  Monitor,
  Pencil,
  Server,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  formatBytes,
  formatUptime,
  HostRegionBadge,
  hostPrimaryAddressText,
  isAgentUpgradeTimedOut,
  isAgentVersionBehind,
  metricUsageProgressClass,
  readCachedHostMetrics,
  writeCachedHostMetrics,
} from "./hostDisplay";

function formatNetworkSpeed(value: number | null) {
  if (value === null) return "--/s";
  const formatted = formatBytes(value);
  return `${formatted.replace(" ", "\u00a0")}/s`;
}

const dayMs = 24 * 60 * 60 * 1000;

function parseHostDateTime(value: unknown) {
  if (!value) return null;
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function formatRemainingTime(purchasedAt: unknown, stoppedAt: unknown) {
  const purchasedMs = parseHostDateTime(purchasedAt);
  const stoppedMs = parseHostDateTime(stoppedAt);
  if (purchasedMs === null || stoppedMs === null || stoppedMs <= purchasedMs) return null;
  const remainingMs = stoppedMs - Date.now();
  if (remainingMs <= 0) return "已到期";
  if (remainingMs < dayMs) return "不足1天";
  return `剩余${Math.ceil(remainingMs / dayMs)}天`;
}

function compactHostOsInfo(value: unknown) {
  return String(value || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "-";
}
type HostCardProps = {
  host: any;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  onResetTraffic?: (host: any) => void;
  onViewProbeLatency?: (host: any) => void;
  resetTrafficPending?: boolean;
  traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null;
  canUpgrade: boolean;
  latestAgentVersion?: string;
  refreshInterval: number | false;
  compact?: boolean;
};

export default function HostCard({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  onResetTraffic,
  onViewProbeLatency,
  resetTrafficPending = false,
  traffic = null,
  canUpgrade,
  latestAgentVersion,
  refreshInterval,
  compact = false,
}: HostCardProps) {
  const { data: metrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 2, live: !!refreshInterval },
    { refetchInterval: refreshInterval }
  );
  const cachedMetrics = useMemo(() => readCachedHostMetrics(host.id), [host.id]);
  const displayMetrics = metrics === undefined ? cachedMetrics : metrics;
  const latestMetric = displayMetrics?.[0];
  const previousMetric = displayMetrics?.[1];
  const totalNetworkIn = traffic?.bytesIn == null ? null : Number(traffic.bytesIn);
  const totalNetworkOut = traffic?.bytesOut == null ? null : Number(traffic.bytesOut);
  const trafficLimit = Math.max(0, Number(host.trafficLimit || 0));
  const trafficMeasureMode = host.trafficMeasureMode === "outbound" || host.trafficMeasureMode === "max" ? host.trafficMeasureMode : "both";
  const trafficMeasureModeLabel = trafficMeasureMode === "outbound"
    ? "仅出向"
    : trafficMeasureMode === "max"
      ? "取最大值"
      : "双向";
  const trafficUsedBytes = trafficMeasureMode === "outbound"
    ? Math.max(0, totalNetworkOut ?? 0)
    : trafficMeasureMode === "max"
      ? Math.max(0, totalNetworkIn ?? 0, totalNetworkOut ?? 0)
      : Math.max(0, (totalNetworkIn ?? 0) + (totalNetworkOut ?? 0));
  const trafficPercent = trafficLimit > 0 ? Math.round((trafficUsedBytes / trafficLimit) * 100) : null;
  const trafficProgress = trafficPercent === null ? 0 : Math.min(100, Math.max(0, trafficPercent));
  const trafficUsageLabel = trafficPercent === null
    ? `${formatBytes(trafficUsedBytes)} / ♾️`
    : `${formatBytes(trafficUsedBytes)} / ${formatBytes(trafficLimit)} (${trafficPercent}%)`;
  const trafficUsageTooltip = [
    `流量使用（${trafficMeasureModeLabel}）`,
    `入站 ${totalNetworkIn === null ? "--" : formatBytes(totalNetworkIn)} / 出站 ${totalNetworkOut === null ? "--" : formatBytes(totalNetworkOut)}`,
    trafficUsageLabel,
  ].join("\n");
  const memoryUsed = latestMetric?.memoryUsed == null ? null : Number(latestMetric.memoryUsed);
  const memoryTotal = host.memoryTotal == null ? null : Number(host.memoryTotal);
  const diskUsed = latestMetric?.diskUsed == null ? null : Number(latestMetric.diskUsed);
  const diskTotal = latestMetric?.diskTotal == null ? null : Number(latestMetric.diskTotal);
  const cpuUsage = Number(latestMetric?.cpuUsage ?? 0);
  const memoryUsage = Number(latestMetric?.memoryUsage ?? 0);
  const diskUsage = Number(latestMetric?.diskUsage ?? 0);
  const networkSpeed = useMemo(() => {
    if (!latestMetric || !previousMetric) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latestMetric.recordedAt).getTime();
    const previousAt = new Date(previousMetric.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latestMetric.networkIn || 0) - Number(previousMetric.networkIn || 0));
    const outDelta = Math.max(0, Number(latestMetric.networkOut || 0) - Number(previousMetric.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  }, [latestMetric, previousMetric]);
  const remainingTimeLabel = formatRemainingTime(host.purchasedAt, host.stoppedAt);
  const hostName = String(host.name || "-").trim() || "-";
  const osInfoText = compactHostOsInfo(host.osInfo);
  const remainingTimeClass = remainingTimeLabel === "已到期"
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : remainingTimeLabel === "不足1天"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
  const isOnline = !!host.isOnline;
  const trafficUsageProgressClass = trafficLimit > 0
    ? metricUsageProgressClass(trafficProgress, isOnline)
    : isOnline
      ? "h-1.5 bg-muted [&>div]:bg-muted-foreground/30"
      : "h-1.5 bg-muted [&>div]:bg-muted-foreground/20";
  const infoPanelClass = isOnline
    ? "border-border/40 bg-background/30"
    : "border-muted-foreground/20 bg-muted/25";
  const trafficPanelClass = isOnline
    ? "border-border/40 bg-muted/20"
    : "border-muted-foreground/20 bg-muted/25";
  const cardMinHeightClass = compact ? "min-h-[260px]" : "min-h-[420px]";
  const compactMetricPanelClass = `rounded-md border px-2.5 py-2 ${trafficPanelClass}`;
  const compactMetricItemClass = "grid min-w-0 grid-cols-[18px_minmax(0,1fr)_42px] items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-background/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const compactTrafficItemClass = `grid h-9 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 rounded-md border px-2 ${trafficPanelClass}`;
  const compactTrafficLabelClass = "flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground";
  const compactTrafficValueClass = "min-w-0 justify-self-end whitespace-nowrap text-right font-medium leading-none tabular-nums text-[clamp(10px,0.66vw,12px)]";
  const compactMetricItems = [
    {
      key: "cpu",
      label: "CPU",
      icon: Cpu,
      value: cpuUsage,
      valueLabel: `${cpuUsage}%`,
      progressClass: metricUsageProgressClass(cpuUsage, isOnline),
      tooltip: host.cpuInfo ? `CPU 使用率 ${cpuUsage}%\n${host.cpuInfo}` : `CPU 使用率 ${cpuUsage}%`,
    },
    {
      key: "memory",
      label: "内存",
      icon: MemoryStick,
      value: memoryUsage,
      valueLabel: `${memoryUsage}%`,
      progressClass: metricUsageProgressClass(memoryUsage, isOnline),
      tooltip: memoryUsed !== null && memoryTotal
        ? `内存使用率 ${memoryUsage}%\n${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`
        : `内存使用率 ${memoryUsage}%`,
    },
    {
      key: "disk",
      label: "磁盘",
      icon: HardDrive,
      value: diskUsage,
      valueLabel: `${diskUsage}%`,
      progressClass: metricUsageProgressClass(diskUsage, isOnline),
      tooltip: diskUsed !== null && diskTotal
        ? `磁盘使用率 ${diskUsage}%\n${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
        : `磁盘使用率 ${diskUsage}%`,
    },
    {
      key: "traffic",
      label: "流量",
      icon: Activity,
      value: trafficProgress,
      valueLabel: trafficPercent === null ? "∞" : `${trafficPercent}%`,
      progressClass: trafficUsageProgressClass,
      tooltip: trafficUsageTooltip,
    },
  ];

  useEffect(() => {
    if (!metrics?.length) return;
    writeCachedHostMetrics(host.id, metrics);
  }, [host.id, metrics]);

  return (
    <Card className={`${cardMinHeightClass} host-card-shell backdrop-blur-md transition-[min-height,border-color,background-color,box-shadow,opacity] duration-200 ease-out ${
      isOnline
        ? "border-border/40 bg-card/60 hover:border-border/60"
        : "border-muted-foreground/20 bg-muted/35 shadow-none hover:border-muted-foreground/30"
    }`}>
      <CardHeader className={compact ? "px-3.5 pb-2 pt-3.5" : "pb-2"}>
        {compact ? (
          <div className="flex items-center justify-between gap-2">
            <Monitor className={`h-4 w-4 shrink-0 ${isOnline ? "" : "text-muted-foreground"}`} />
            <div className="flex shrink-0 items-center justify-end gap-1">
              {onViewProbeLatency && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="查看服务延迟"
                  onClick={() => onViewProbeLatency(host)}
                >
                  <Activity className="h-3.5 w-3.5" />
                </Button>
              )}
              {onResetTraffic && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={resetTrafficPending}
                  title={resetTrafficPending ? "正在重置流量统计" : "重置流量统计"}
                  onClick={() => onResetTraffic(host)}
                >
                  {resetTrafficPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!canUpgrade}
                title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
                onClick={() => onUpgrade(host)}
              >
                {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onEdit(host)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm("确定要删除此主机吗？")) onDelete(host.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <CardTitle className={`min-w-0 text-base font-semibold ${isOnline ? "" : "text-muted-foreground"}`}>
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Monitor className="h-4 w-4 shrink-0" />
                <span className="min-w-0 max-w-full truncate">{hostName}</span>
              </span>
            </CardTitle>
            <div className="flex shrink-0 items-center justify-end gap-1">
              {onViewProbeLatency && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="查看服务延迟"
                  onClick={() => onViewProbeLatency(host)}
                >
                  <Activity className="h-3.5 w-3.5" />
                </Button>
              )}
              {onResetTraffic && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={resetTrafficPending}
                  title={resetTrafficPending ? "正在重置流量统计" : "重置流量统计"}
                  onClick={() => onResetTraffic(host)}
                >
                  {resetTrafficPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!canUpgrade}
                title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
                onClick={() => onUpgrade(host)}
              >
                {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onEdit(host)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => {
                  if (confirm("确定要删除此主机吗？")) onDelete(host.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className={`host-card-mode-content ${compact ? "host-card-mode-content-compact space-y-2 px-3.5 pb-3.5" : "host-card-mode-content-standard space-y-3"} ${isOnline ? "" : "text-muted-foreground"}`}>
        {compact ? (
          <div className="space-y-2">
            <div className={`min-w-0 rounded-md border px-2.5 py-1.5 ${infoPanelClass}`}>
              <p className="truncate font-mono text-xs leading-5" title={hostPrimaryAddressText(host)}>
                <span className="mr-1.5 text-muted-foreground">地址</span>
                {hostPrimaryAddressText(host)}
              </p>
              <div className={`mt-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
                <HostRegionBadge host={host} compact />
              </div>
            </div>
            <div className="w-full min-w-0 rounded-md border px-2.5 py-1.5">
              <div className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug" title={hostName}>
                  {hostName}
                </span>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground ${
                    isOnline ? "border-border/50" : "border-muted-foreground/20 bg-muted/20"
                  }`}
                >
                  {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                </span>
              </div>
              {(agentNeedsUpdate || host.agentUpgradeRequested) && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {agentNeedsUpdate && (
                    <Badge variant="outline" className="shrink-0 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500">
                      新版
                    </Badge>
                  )}
                  {host.agentUpgradeRequested && (
                    <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                      {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                    </Badge>
                  )}
                </div>
              )}
            </div>
            <div className={`flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap text-xs`}>
              <div className="flex shrink-0 items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
                <span className={isOnline ? "" : "font-medium text-destructive"}>{isOnline ? "在线" : "离线"}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className={compact ? "space-y-1.5" : "space-y-2"}>
            <div className={`min-w-0 rounded-md border px-2.5 ${compact ? "py-1.5" : "py-2"} ${infoPanelClass}`}>
              <p className="truncate font-mono text-xs leading-5" title={hostPrimaryAddressText(host)}>
                <span className="mr-1.5 text-muted-foreground">地址</span>
                {hostPrimaryAddressText(host)}
              </p>
              <div className={`mt-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
                <HostRegionBadge host={host} />
              </div>
            </div>
            <div className={`flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap ${compact ? "text-xs" : "text-sm"}`}>
              <div className="flex shrink-0 items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
                <span className={isOnline ? "" : "font-medium text-destructive"}>{isOnline ? "在线" : "离线"}</span>
              </div>
              {!compact && <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate" title={host.osInfo || ""}>{osInfoText}</span>
              </div>}
            </div>
          </div>
        )}

        {latestMetric ? (
          compact ? (
            <div className="space-y-2 border-t border-border/30 pt-2">
              <TooltipProvider delayDuration={120}>
                <div className={`${compactMetricPanelClass} space-y-1.5 text-xs`}>
                  {compactMetricItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Tooltip key={item.key}>
                        <TooltipTrigger asChild>
                          <div className={compactMetricItemClass} aria-label={item.tooltip} tabIndex={0}>
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <Progress value={item.value} className={item.progressClass} />
                            <span className="shrink-0 text-right font-semibold leading-none tabular-nums">{item.valueLabel}</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent collisionPadding={12} className="max-w-[240px] whitespace-pre-line text-xs">
                          {item.tooltip}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </TooltipProvider>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs">
                <div className={compactTrafficItemClass}>
                  <span className={compactTrafficLabelClass}><ArrowDownToLine className="h-3 w-3 shrink-0" /> 入</span>
                  <span className={compactTrafficValueClass}>{formatNetworkSpeed(networkSpeed.in)}</span>
                </div>
                <div className={compactTrafficItemClass}>
                  <span className={compactTrafficLabelClass}><ArrowUpFromLine className="h-3 w-3 shrink-0" /> 出</span>
                  <span className={compactTrafficValueClass}>{formatNetworkSpeed(networkSpeed.out)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">运行</span>
                {remainingTimeLabel && (
                  <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${remainingTimeClass}`}>
                    {remainingTimeLabel}
                  </span>
                )}
                <span className="ml-auto shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatUptime(latestMetric.uptime)}</span>
              </div>
            </div>
          ) : (
          <div className="space-y-3 border-t border-border/30 pt-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="font-medium tabular-nums">{latestMetric.cpuUsage ?? 0}%</span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground" title={host.cpuInfo || ""}>
                {host.cpuInfo || "未上报 CPU 型号"}
              </p>
              <Progress value={latestMetric.cpuUsage ?? 0} className={metricUsageProgressClass(latestMetric.cpuUsage, isOnline)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {memoryUsed && memoryTotal
                    ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${latestMetric.memoryUsage ?? 0}%)`
                    : `${latestMetric.memoryUsage ?? 0}%`}
                </span>
              </div>
              <Progress value={latestMetric.memoryUsage ?? 0} className={metricUsageProgressClass(latestMetric.memoryUsage, isOnline)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> 磁盘</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {diskUsed !== null && diskTotal
                    ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)} (${latestMetric.diskUsage ?? 0}%)`
                    : `-- / -- (${latestMetric.diskUsage ?? 0}%)`}
                </span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className={metricUsageProgressClass(latestMetric.diskUsage, isOnline)} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Activity className="h-3 w-3" /> 流量</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums" title={trafficUsageTooltip}>
                  {trafficUsageLabel}
                </span>
              </div>
              <Progress value={trafficProgress} className={trafficUsageProgressClass} />
            </div>
            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
              <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground"><ArrowDownToLine className="h-3 w-3" /> 入站</span>
                  <span className="whitespace-nowrap font-medium tabular-nums">{formatNetworkSpeed(networkSpeed.in)}</span>
                </div>
              </div>
              <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground"><ArrowUpFromLine className="h-3 w-3" /> 出站</span>
                  <span className="whitespace-nowrap font-medium tabular-nums">{formatNetworkSpeed(networkSpeed.out)}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">运行时间</span>
              {remainingTimeLabel && (
                <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${remainingTimeClass}`}>
                  {remainingTimeLabel}
                </span>
              )}
              <span className="ml-auto shrink-0 whitespace-nowrap text-right font-medium tabular-nums">{formatUptime(latestMetric.uptime)}</span>
            </div>
          </div>
          )
        ) : (
          <div className={`border-t border-border/30 text-center text-muted-foreground/60 ${compact ? "py-3" : "py-4"}`}>
            <p className="text-xs">暂无监控数据</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

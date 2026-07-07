import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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

function metricBytesOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) ? Math.max(0, bytes) : null;
}

function formatOptionalBytes(value: number | null) {
  return value === null ? "--" : formatBytes(value);
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
  metrics?: any[] | null;
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
  metrics: externalMetrics,
  canUpgrade,
  latestAgentVersion,
  refreshInterval,
  compact = false,
}: HostCardProps) {
  const confirmDialog = useConfirmDialog();
  const hasExternalMetrics = externalMetrics !== undefined;
  const { data: queriedMetrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 2, live: !!refreshInterval },
    { enabled: !hasExternalMetrics, refetchInterval: hasExternalMetrics ? false : refreshInterval }
  );
  const metrics = hasExternalMetrics ? externalMetrics : queriedMetrics;
  const cachedMetrics = useMemo(() => readCachedHostMetrics(host.id), [host.id]);
  const displayMetrics = metrics === undefined || metrics === null || metrics.length === 0 ? cachedMetrics : metrics;
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
  const swapUsed = latestMetric?.swapUsed == null ? null : Number(latestMetric.swapUsed);
  const swapTotal = latestMetric?.swapTotal == null ? null : Number(latestMetric.swapTotal);
  const diskUsed = latestMetric?.diskUsed == null ? null : Number(latestMetric.diskUsed);
  const diskTotal = latestMetric?.diskTotal == null ? null : Number(latestMetric.diskTotal);
  const cpuUsage = Number(latestMetric?.cpuUsage ?? 0);
  const memoryUsage = Number(latestMetric?.memoryUsage ?? 0);
  const swapUsage = latestMetric?.swapUsage == null
    ? swapUsed !== null && swapTotal
      ? Math.round((swapUsed / swapTotal) * 100)
      : 0
    : Number(latestMetric.swapUsage);
  const diskUsage = Number(latestMetric?.diskUsage ?? 0);
  const hasSwapReport = latestMetric?.swapUsed != null || latestMetric?.swapTotal != null || latestMetric?.swapUsage != null;
  const memoryTooltip = [
    "内存使用详情",
    memoryUsed !== null && memoryTotal
      ? `RAM ${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${memoryUsage}%)`
      : `RAM ${memoryUsage}%`,
    hasSwapReport
      ? `Swap ${formatBytes(swapUsed ?? 0)} / ${formatBytes(swapTotal ?? 0)} (${swapUsage}%)`
      : "Swap 未上报",
  ].join("\n");
  const networkSpeed = useMemo(() => {
    if (!latestMetric) return { in: null as number | null, out: null as number | null };
    if (latestMetric.networkSpeedIn != null || latestMetric.networkSpeedOut != null) {
      return {
        in: latestMetric.networkSpeedIn == null ? null : Number(latestMetric.networkSpeedIn),
        out: latestMetric.networkSpeedOut == null ? null : Number(latestMetric.networkSpeedOut),
      };
    }
    if (!previousMetric) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latestMetric.recordedAt).getTime();
    const previousAt = new Date(previousMetric.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latestMetric.networkIn || 0) - Number(previousMetric.networkIn || 0));
    const outDelta = Math.max(0, Number(latestMetric.networkOut || 0) - Number(previousMetric.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  }, [latestMetric, previousMetric]);
  const systemNetworkIn = metricBytesOrNull(latestMetric?.networkIn);
  const systemNetworkOut = metricBytesOrNull(latestMetric?.networkOut);
  const systemNetworkTotal = systemNetworkIn === null && systemNetworkOut === null ? null : (systemNetworkIn ?? 0) + (systemNetworkOut ?? 0);
  const currentTrafficInLabel = formatNetworkSpeed(networkSpeed.in);
  const currentTrafficOutLabel = formatNetworkSpeed(networkSpeed.out);
  const systemTrafficInLabel = formatOptionalBytes(systemNetworkIn);
  const systemTrafficOutLabel = formatOptionalBytes(systemNetworkOut);
  const currentTrafficTitle = [
    "当前瞬时流量",
    `下行 ${currentTrafficInLabel}`,
    `上行 ${currentTrafficOutLabel}`,
  ].join("\n");
  const systemTrafficTitle = [
    "系统累计流量（系统重启后重置）",
    `下行 ${systemTrafficInLabel}`,
    `上行 ${systemTrafficOutLabel}`,
    `合计 ${formatOptionalBytes(systemNetworkTotal)}`,
  ].join("\n");
  const renderTrafficRow = (Icon: typeof ArrowDownToLine, label: string, value: string) => (
    <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums" title={value}>{value}</span>
    </div>
  );
  const renderTrafficColumn = ({
    label,
    inValue,
    outValue,
    title,
    className = "",
  }: {
    label: string;
    inValue: string;
    outValue: string;
    title: string;
    className?: string;
  }) => (
    <div className={`min-w-0 ${className}`} title={title}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Activity className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className={compact ? "mt-1.5 space-y-1" : "mt-2 space-y-1.5"}>
        {renderTrafficRow(ArrowDownToLine, "下行", inValue)}
        {renderTrafficRow(ArrowUpFromLine, "上行", outValue)}
      </div>
    </div>
  );
  const renderTrafficSplitBox = () => (
    <div className={`${compact ? "rounded-md border px-2 py-1.5" : "rounded-md border px-2.5 py-2"} ${trafficPanelClass}`}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-border/40">
        {renderTrafficColumn({ label: "当前", inValue: currentTrafficInLabel, outValue: currentTrafficOutLabel, title: currentTrafficTitle, className: "pr-2" })}
        {renderTrafficColumn({ label: "累计", inValue: systemTrafficInLabel, outValue: systemTrafficOutLabel, title: systemTrafficTitle, className: "pl-2" })}
      </div>
    </div>
  );
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
      tooltip: memoryTooltip,
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

  const addressRegionBlock = (regionCompact = false) => (
    <div className={`mt-0.5 min-w-0 space-y-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
      <p className="min-w-0 truncate font-mono text-xs leading-5" title={hostPrimaryAddressText(host)}>
        <span className="mr-1.5 text-muted-foreground">地址</span>
        {hostPrimaryAddressText(host)}
      </p>
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-5">
        <span className="shrink-0 text-muted-foreground">国家/地区：</span>
        <HostRegionBadge host={host} compact={regionCompact} />
      </div>
    </div>
  );

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
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
            <div className="flex shrink-0 items-center gap-1">
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
                onClick={async () => {
                  if (await confirmDialog({
                    title: "删除主机",
                    description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
                    confirmText: "删除",
                    tone: "destructive",
                  })) onDelete(host.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
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
                onClick={async () => {
                  if (await confirmDialog({
                    title: "删除主机",
                    description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
                    confirmText: "删除",
                    tone: "destructive",
                  })) onDelete(host.id);
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
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`}
                  title={isOnline ? "在线" : "离线"}
                />
                <span className="min-w-0 truncate text-sm font-semibold leading-5" title={hostName}>{hostName}</span>
                <span
                  className={`shrink-0 rounded border bg-background/40 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground ${
                    isOnline ? "border-border/50" : "border-muted-foreground/20 bg-muted/20"
                  }`}
                >
                  {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                </span>
                {agentNeedsUpdate && (
                  <Badge variant="outline" className="shrink-0 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500">
                    新版
                  </Badge>
                )}
              </div>
              {host.agentUpgradeRequested && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary"}`}>
                    {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                  </Badge>
                </div>
              )}
              {addressRegionBlock(true)}
            </div>
          </div>
        ) : (
          <div className={compact ? "space-y-1.5" : "space-y-2"}>
            <div className={`min-w-0 rounded-md border px-2.5 ${compact ? "py-1.5" : "py-2"} ${infoPanelClass}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`}
                  title={isOnline ? "在线" : "离线"}
                />
                <span className="min-w-0 truncate text-sm font-semibold leading-5" title={hostName}>{hostName}</span>
                <span
                  className={`shrink-0 rounded border bg-background/40 px-1.5 py-0.5 font-mono text-[10px] font-normal leading-none text-muted-foreground ${
                    isOnline ? "border-border/50" : "border-muted-foreground/20 bg-muted/20"
                  }`}
                >
                  {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
                </span>
                {agentNeedsUpdate && (
                  <Badge variant="outline" className="shrink-0 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500">
                    新版
                  </Badge>
                )}
              </div>
              {host.agentUpgradeRequested && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary"}`}>
                    {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                  </Badge>
                </div>
              )}
              {addressRegionBlock(false)}
            </div>
            <div className={`flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap ${compact ? "text-xs" : "text-sm"}`}>
              <div className="flex shrink-0 items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
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
              {renderTrafficSplitBox()}
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
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="space-y-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={memoryTooltip} tabIndex={0}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                      <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                        {memoryUsed !== null && memoryTotal
                          ? `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${latestMetric.memoryUsage ?? 0}%)`
                          : `${latestMetric.memoryUsage ?? 0}%`}
                      </span>
                    </div>
                    <Progress value={latestMetric.memoryUsage ?? 0} className={metricUsageProgressClass(latestMetric.memoryUsage, isOnline)} />
                  </div>
                </TooltipTrigger>
                <TooltipContent collisionPadding={12} className="max-w-[260px] whitespace-pre-line text-xs">
                  {memoryTooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
            <div className="pt-1">
              {renderTrafficSplitBox()}
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

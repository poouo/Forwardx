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
  Eye,
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
  hostAddressText,
  isAgentUpgradeTimedOut,
  isAgentVersionBehind,
  metricUsageProgressClass,
  readCachedHostMetrics,
  writeCachedHostMetrics,
} from "./hostDisplay";

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
    { hostId: host.id, limit: 2 },
    { refetchInterval: refreshInterval }
  );
  const cachedMetrics = useMemo(() => readCachedHostMetrics(host.id), [host.id]);
  const displayMetrics = metrics === undefined ? cachedMetrics : metrics;
  const latestMetric = displayMetrics?.[0];
  const previousMetric = displayMetrics?.[1];
  const totalNetworkIn = traffic?.bytesIn == null ? null : Number(traffic.bytesIn);
  const totalNetworkOut = traffic?.bytesOut == null ? null : Number(traffic.bytesOut);
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
  const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
  const isOnline = !!host.isOnline;
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
      tooltip: host.cpuInfo ? `CPU 使用率 ${cpuUsage}%\n${host.cpuInfo}` : `CPU 使用率 ${cpuUsage}%`,
    },
    {
      key: "memory",
      label: "内存",
      icon: MemoryStick,
      value: memoryUsage,
      tooltip: memoryUsed !== null && memoryTotal
        ? `内存使用率 ${memoryUsage}%\n${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`
        : `内存使用率 ${memoryUsage}%`,
    },
    {
      key: "disk",
      label: "磁盘",
      icon: HardDrive,
      value: diskUsage,
      tooltip: diskUsed !== null && diskTotal
        ? `磁盘使用率 ${diskUsage}%\n${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
        : `磁盘使用率 ${diskUsage}%`,
    },
  ];

  useEffect(() => {
    if (!metrics?.length) return;
    writeCachedHostMetrics(host.id, metrics);
  }, [host.id, metrics]);

  return (
    <Card className={`${cardMinHeightClass} backdrop-blur-md transition-[border-color,background-color,box-shadow,opacity] duration-150 ease-out ${
      isOnline
        ? "border-border/40 bg-card/60 hover:border-border/60"
        : "border-muted-foreground/20 bg-muted/35 shadow-none hover:border-muted-foreground/30"
    }`}>
      <CardHeader className={compact ? "px-3.5 pb-2 pt-3.5" : "pb-2"}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className={`min-w-0 text-base font-semibold ${isOnline ? "" : "text-muted-foreground"}`}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0" />
              <span className="min-w-0 max-w-full truncate">{host.name}</span>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground ${
                isOnline ? "border-border/50" : "border-muted-foreground/20 bg-muted/20"
              }`}>
                {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
              </span>
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
                <Eye className="h-3.5 w-3.5" />
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
      </CardHeader>
      <CardContent className={`${compact ? "space-y-2 px-3.5 pb-3.5" : "space-y-3"} ${isOnline ? "" : "text-muted-foreground"}`}>
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          <div className={`min-w-0 rounded-md border px-2.5 ${compact ? "py-1.5" : "py-2"} ${infoPanelClass}`}>
            <p className="truncate font-mono text-xs leading-5" title={hostAddressText(host)}>
              <span className="mr-1.5 text-muted-foreground">地址</span>
              {hostAddressText(host)}
            </p>
            <div className={`mt-1 ${isOnline ? "" : "opacity-70 grayscale"}`}>
              <HostRegionBadge host={host} />
            </div>
          </div>
          <div className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 ${compact ? "text-xs" : "text-sm"}`}>
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={`h-2 w-2 rounded-full ${isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" : "bg-destructive shadow-sm shadow-destructive/50"}`} />
              <span className={isOnline ? "" : "font-medium text-destructive"}>{isOnline ? "在线" : "离线"}</span>
            </div>
            {!compact && <div className="flex min-w-0 items-center gap-1.5">
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={host.osInfo || ""}>{host.osInfo || "-"}</span>
            </div>}
          </div>
        </div>

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
                            <Progress value={item.value} className={metricUsageProgressClass(item.value, isOnline)} />
                            <span className="shrink-0 text-right font-semibold leading-none tabular-nums">{item.value}%</span>
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
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-muted-foreground"><ArrowDownToLine className="h-3 w-3" /> 入</span>
                    <span className="font-medium tabular-nums">{networkSpeed.in === null ? "--/s" : `${formatBytes(networkSpeed.in)}/s`}</span>
                  </div>
                </div>
                <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 text-muted-foreground"><ArrowUpFromLine className="h-3 w-3" /> 出</span>
                    <span className="font-medium tabular-nums">{networkSpeed.out === null ? "--/s" : `${formatBytes(networkSpeed.out)}/s`}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">运行</span>
                <span className="ml-auto font-medium">{formatUptime(latestMetric.uptime)}</span>
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
            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
              <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowDownToLine className="h-3 w-3" />
                  <span>入站</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">累计</span>
                  <span className="font-medium tabular-nums">{totalNetworkIn === null ? "--" : formatBytes(totalNetworkIn)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">当前</span>
                  <span className="font-medium tabular-nums">{networkSpeed.in === null ? "--/s" : `${formatBytes(networkSpeed.in)}/s`}</span>
                </div>
              </div>
              <div className={`rounded-md border px-2.5 py-2 ${trafficPanelClass}`}>
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowUpFromLine className="h-3 w-3" />
                  <span>出站</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">累计</span>
                  <span className="font-medium tabular-nums">{totalNetworkOut === null ? "--" : formatBytes(totalNetworkOut)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">当前</span>
                  <span className="font-medium tabular-nums">{networkSpeed.out === null ? "--/s" : `${formatBytes(networkSpeed.out)}/s`}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">运行时间</span>
              <span className="font-medium ml-auto">{formatUptime(latestMetric.uptime)}</span>
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

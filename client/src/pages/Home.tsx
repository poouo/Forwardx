import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  Server,
  ArrowRightLeft,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wifi,
  WifiOff,
  Shield,
  Zap,
  TrendingUp,
  Globe,
  Users,
  CalendarClock,
  BarChart3,
  Info,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
} from "recharts";
import { useMemo } from "react";

function formatBytes(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  gradient,
  loading,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  gradient: string;
  loading?: boolean;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md hover:border-border/60 transition-all duration-300 hover:shadow-lg hover:shadow-primary/5">
      <div className={`absolute inset-0 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity ${gradient}`} />
      <CardContent className="p-3 sm:p-5 relative">
        <div className="flex items-start justify-between">
          <div className="space-y-1 sm:space-y-1.5">
            <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
            {loading ? (
              <Skeleton className="h-6 sm:h-9 w-16 sm:w-24" />
            ) : (
              <p className="text-lg sm:text-3xl font-bold tracking-tight tabular-nums">{value}</p>
            )}
            {subtitle && (
              <p className="text-[10px] sm:text-xs text-muted-foreground/80">{subtitle}</p>
            )}
          </div>
          <div className={`h-8 w-8 sm:h-11 sm:w-11 rounded-lg sm:rounded-xl flex items-center justify-center ${gradient} shadow-sm`}>
            <Icon className="h-3.5 w-3.5 sm:h-5 sm:w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CircularProgress({ value, size = 80, strokeWidth = 6, color }: { value: number; size?: number; strokeWidth?: number; color: string }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(value, 100) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted/30" />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" className="transition-all duration-700 ease-out" />
      </svg>
      <span className="absolute text-sm font-bold tabular-nums">{Math.round(value)}%</span>
    </div>
  );
}

/** 格式化时间标签：MM/DD HH:mm */
function formatTrafficTime(dateStr: string | Date): string {
  const d = new Date(dateStr);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

/** 流量 Tooltip */
function TrafficTooltipContent({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground mb-1.5">{data.fullLabel || label}</p>
      <div className="space-y-1">
        <p className="text-xs tabular-nums flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--chart-2))" }} />
          <span className="text-muted-foreground">入站</span>
          <span className="font-semibold ml-auto">{formatBytes(data.bytesIn)}</span>
        </p>
        <p className="text-xs tabular-nums flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--chart-4))" }} />
          <span className="text-muted-foreground">出站</span>
          <span className="font-semibold ml-auto">{formatBytes(data.bytesOut)}</span>
        </p>
      </div>
    </div>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const { data: hosts } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const { data: rules } = trpc.rules.list.useQuery(undefined, {
    refetchInterval: 30000,
  });

  // 流量走势：固定查询最近 7 天，30 分钟分桶（每半小时累加为一个点位）
  const { data: trafficSeries, isLoading: trendLoading } = trpc.dashboard.trafficSeries.useQuery(
    { hours: 168, bucketMinutes: 30 },
    { refetchInterval: 30000 }
  );
  const chartData = useMemo(
    () =>
      (trafficSeries || []).map((d: any) => ({
        label: formatTrafficTime(d.bucket),
        fullLabel: formatTrafficTime(d.bucket),
        bytesIn: Number(d.bytesIn) || 0,
        bytesOut: Number(d.bytesOut) || 0,
      })),
    [trafficSeries]
  );

  // 用户流量汇总
  const { data: userTraffic, isLoading: userTrafficLoading } = trpc.dashboard.userTraffic.useQuery(undefined, {
    refetchInterval: 30000,
  });

  const onlineRate = useMemo(() => {
    if (!stats || stats.totalHosts === 0) return 0;
    return Math.round((stats.onlineHosts / stats.totalHosts) * 100);
  }, [stats]);

  const activeRate = useMemo(() => {
    if (!stats || stats.totalRules === 0) return 0;
    return Math.round((stats.activeRules / stats.totalRules) * 100);
  }, [stats]);

  const recentHosts = useMemo(() => {
    if (!hosts) return [];
    return hosts.slice(0, 5);
  }, [hosts]);

  const recentRules = useMemo(() => {
    if (!rules) return [];
    return rules.slice(0, 5);
  }, [rules]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">仪表盘</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
            欢迎回来，{user?.name || "用户"}
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs border-chart-2/30 text-chart-2">
          <span className="h-1.5 w-1.5 rounded-full bg-chart-2 animate-pulse" />
          系统在线
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <StatCard
          title="主机总数"
          value={stats?.totalHosts ?? 0}
          subtitle={`${stats?.onlineHosts ?? 0} 台在线`}
          icon={Server}
          gradient="bg-gradient-to-br from-blue-500 to-blue-600"
          loading={isLoading}
        />
        <StatCard
          title="转发规则"
          value={stats?.totalRules ?? 0}
          subtitle={`${stats?.activeRules ?? 0} 条活跃`}
          icon={ArrowRightLeft}
          gradient="bg-gradient-to-br from-emerald-500 to-emerald-600"
          loading={isLoading}
        />
        <StatCard
          title="入站流量"
          value={formatBytes(stats?.totalTrafficIn ?? 0)}
          subtitle="累计入站"
          icon={ArrowDownToLine}
          gradient="bg-gradient-to-br from-violet-500 to-violet-600"
          loading={isLoading}
        />
        <StatCard
          title="出站流量"
          value={formatBytes(stats?.totalTrafficOut ?? 0)}
          subtitle="累计出站"
          icon={ArrowUpFromLine}
          gradient="bg-gradient-to-br from-amber-500 to-amber-600"
          loading={isLoading}
        />
      </div>

      {/* Traffic Trend Chart - AreaChart style */}
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              流量走势
              <span className="text-[10px] text-muted-foreground/60 font-normal">最近 7 天</span>
            </CardTitle>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--chart-2))" }} />
                入站
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--chart-4))" }} />
                出站
              </span>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/50 flex items-center gap-1 mt-1">
            <Info className="h-3 w-3" />
            iptables 转发的流量统计最为准确，其他转发方式 (realm/socat) 的流量统计可能存在偏差
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-48 sm:h-64 w-full">
            {trendLoading ? (
              <Skeleton className="h-full w-full" />
            ) : chartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                暂无流量数据
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="trafficInGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="trafficOutGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-4))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--chart-4))" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.4)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9 }}
                    minTickGap={60}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => formatBytes(v)}
                    width={55}
                    domain={[0, (dataMax: number) => Math.max(1024, Math.ceil((dataMax || 0) * 1.2))]}
                    allowDecimals={false}
                  />
                  <RTooltip
                    content={<TrafficTooltipContent />}
                    cursor={{ stroke: "hsl(var(--muted-foreground) / 0.3)", strokeDasharray: "3 3" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="bytesIn"
                    name="入站"
                    stroke="hsl(var(--chart-2))"
                    strokeWidth={2}
                    fill="url(#trafficInGradient)"
                    dot={false}
                    activeDot={{ r: 4, fill: "hsl(var(--chart-2))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="bytesOut"
                    name="出站"
                    stroke="hsl(var(--chart-4))"
                    strokeWidth={2}
                    fill="url(#trafficOutGradient)"
                    dot={false}
                    activeDot={{ r: 4, fill: "hsl(var(--chart-4))", stroke: "hsl(var(--background))", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      {/* User Traffic Summary */}
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users className="h-4 w-4" />
            {user?.role === "admin" ? "用户流量概览" : "我的流量"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {userTrafficLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : userTraffic && userTraffic.length > 0 ? (
            <div className="space-y-3">
              {userTraffic.map((u: any) => {
                const limit = Number(u.trafficLimit) || 0;
                const used = Number(u.trafficUsed) || 0;
                const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
                const isOverLimit = limit > 0 && used >= limit;

                return (
                  <div key={u.id} className="flex items-center gap-4 py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{u.name || u.username}</span>
                        {u.role === "admin" && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                            <Shield className="h-2.5 w-2.5 mr-0.5" />管理员
                          </Badge>
                        )}
                        {isExpired && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">已到期</Badge>
                        )}
                        {isOverLimit && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4">流量超额</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5">
                        <div className="flex-1">
                          <Progress
                            value={limit > 0 ? pct : 0}
                            className={`h-1.5 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                          {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 text-[10px] text-muted-foreground shrink-0">
                      {u.expiresAt && (
                        <span className="flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          {new Date(u.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                      {u.trafficAutoReset && (
                        <span>每月{u.trafficResetDay || 1}日重置</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground/60">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">暂无用户流量数据</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Health Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Online Rate */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Wifi className="h-4 w-4" />
              主机在线率
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              {isLoading ? (
                <Skeleton className="h-20 w-20 rounded-full" />
              ) : (
                <CircularProgress value={onlineRate} color="oklch(0.7 0.17 165)" />
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-chart-2" />
                  <span className="text-sm">在线 {stats?.onlineHosts ?? 0}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                  <span className="text-sm text-muted-foreground">离线 {(stats?.totalHosts ?? 0) - (stats?.onlineHosts ?? 0)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Active Rules Rate */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Zap className="h-4 w-4" />
              规则活跃率
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              {isLoading ? (
                <Skeleton className="h-20 w-20 rounded-full" />
              ) : (
                <CircularProgress value={activeRate} color="oklch(0.65 0.18 250)" />
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  <span className="text-sm">活跃 {stats?.activeRules ?? 0}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                  <span className="text-sm text-muted-foreground">停用 {(stats?.totalRules ?? 0) - (stats?.activeRules ?? 0)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* System Status */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" />
              系统概览
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">主机负载</span>
                <div className="flex items-center gap-2 w-32">
                  <Progress value={onlineRate} className="h-1.5" />
                  <span className="text-xs font-medium tabular-nums w-8 text-right">{onlineRate}%</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">规则负载</span>
                <div className="flex items-center gap-2 w-32">
                  <Progress value={activeRate} className="h-1.5" />
                  <span className="text-xs font-medium tabular-nums w-8 text-right">{activeRate}%</span>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">用户角色</span>
                <Badge variant="secondary" className="text-[10px] px-2 py-0.5">
                  {user?.role === "admin" ? (
                    <><Shield className="h-3 w-3 mr-1" />管理员</>
                  ) : "普通用户"}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* Recent Hosts */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Globe className="h-4 w-4" />
              最近主机
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentHosts.length > 0 ? (
              <div className="space-y-2">
                {recentHosts.map((host) => (
                  <div key={host.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${host.isOnline ? "bg-chart-2 shadow-sm shadow-chart-2/50" : "bg-muted-foreground/30"}`} />
                      <div>
                        <p className="text-sm font-medium">{host.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{host.ip}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {host.isOnline ? (
                        <Wifi className="h-3.5 w-3.5 text-chart-2" />
                      ) : (
                        <WifiOff className="h-3.5 w-3.5 text-muted-foreground/40" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground/60">
                <Server className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">暂无主机</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Rules */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              最近规则
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentRules.length > 0 ? (
              <div className="space-y-2">
                {recentRules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${rule.isRunning ? "bg-chart-2 shadow-sm shadow-chart-2/50" : "bg-muted-foreground/30"}`} />
                      <div>
                        <p className="text-sm font-medium">{rule.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          :{rule.sourcePort} → {rule.targetIp}:{rule.targetPort}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1.5 py-0 h-5 ${
                          rule.forwardType === "iptables"
                            ? "border-primary/30 text-primary"
                            : "border-chart-3/30 text-chart-3"
                        }`}
                      >
                        {rule.forwardType}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 uppercase">
                        {rule.protocol}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground/60">
                <ArrowRightLeft className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">暂无转发规则</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}

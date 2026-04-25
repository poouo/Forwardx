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
} from "lucide-react";
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
      <CardContent className="p-5 relative">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
            {loading ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
            )}
            {subtitle && (
              <p className="text-xs text-muted-foreground/80">{subtitle}</p>
            )}
          </div>
          <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${gradient} shadow-sm`}>
            <Icon className="h-5 w-5 text-white" />
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
          <h1 className="text-2xl font-bold tracking-tight">仪表盘</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            欢迎回来，{user?.name || "用户"}。系统运行正常。
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs border-chart-2/30 text-chart-2">
          <span className="h-1.5 w-1.5 rounded-full bg-chart-2 animate-pulse" />
          系统在线
        </Badge>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          value="暂不可用"
          subtitle="Agent 流量统计待完善"
          icon={ArrowDownToLine}
          gradient="bg-gradient-to-br from-violet-500/50 to-violet-600/50"
          loading={false}
        />
        <StatCard
          title="出站流量"
          value="暂不可用"
          subtitle="Agent 流量统计待完善"
          icon={ArrowUpFromLine}
          gradient="bg-gradient-to-br from-amber-500/50 to-amber-600/50"
          loading={false}
        />
      </div>

      {/* Health Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                        {host.connectionType === "ssh" ? "SSH" : "Agent"}
                      </Badge>
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

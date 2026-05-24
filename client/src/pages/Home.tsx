import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { FORWARD_TYPE_LABELS } from "@shared/forwardTypes";
import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  BarChart3,
  CalendarClock,
  Coins,
  Globe,
  Info,
  Package,
  Server,
  Shield,
  TrendingUp,
  WalletCards,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { useMemo } from "react";
import PublicHome, { CustomPublicHome } from "./PublicHome";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

const gostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);

function formatBytes(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!num || Number.isNaN(num)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(num)) / Math.log(1024)));
  return `${parseFloat((num / 1024 ** index).toFixed(index === 0 ? 0 : 2))} ${units[index]}`;
}

function money(cents?: number | null, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((Number(cents) || 0) / 100);
}

function formatTrafficTime(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "永久有效";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "永久有效" : date.toLocaleDateString("zh-CN");
}

function getExpiryStatus(value: string | Date | null | undefined) {
  if (!value) return { label: "永久有效", tone: "normal" as const };
  const expiry = new Date(value).getTime();
  if (Number.isNaN(expiry)) return { label: "永久有效", tone: "normal" as const };
  const diffDays = Math.ceil((expiry - Date.now()) / 86_400_000);
  if (diffDays < 0) return { label: "已到期", tone: "danger" as const };
  if (diffDays <= 7) return { label: diffDays === 0 ? "今日到期" : `剩余 ${diffDays} 天`, tone: "warning" as const };
  return { label: `剩余 ${diffDays} 天`, tone: "normal" as const };
}

function protocolLabel(protocol: string | null | undefined) {
  const value = String(protocol || "both").toLowerCase();
  if (value === "tcp") return "TCP";
  if (value === "udp") return "UDP";
  return "TCP+UDP";
}

function getTunnelDisplay(tunnel: any | null | undefined) {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "forwardx") return "隧道 / ForwardX";
  if (gostTunnelModes.has(mode)) return "隧道 / gost";
  return mode ? `隧道 / ${mode.toUpperCase()}` : "隧道";
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  tone: string;
  loading?: boolean;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            {loading ? <Skeleton className="h-8 w-24" /> : <p className="truncate text-2xl font-bold tracking-tight tabular-nums">{value}</p>}
            {subtitle && <p className="text-xs text-muted-foreground/80">{subtitle}</p>}
          </div>
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone} shadow-sm`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CircularProgress({ value, color }: { value: number; color: string }) {
  const size = 78;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(value, 100) / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-muted/30" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <span className="absolute text-sm font-bold tabular-nums">{Math.round(value)}%</span>
    </div>
  );
}

function TrafficTooltipContent({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="mb-1.5 text-xs text-muted-foreground">{data.fullLabel || label}</p>
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-muted-foreground">入站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesIn)}</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-muted-foreground">出站</span>
          <span className="ml-auto font-semibold">{formatBytes(data.bytesOut)}</span>
        </p>
      </div>
    </div>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery(undefined, { refetchInterval: 15000 });
  const { data: hosts = [] } = trpc.hosts.list.useQuery(undefined, { refetchInterval: 30000 });
  const { data: rules = [] } = trpc.rules.list.useQuery(undefined, { refetchInterval: 30000 });
  const { data: tunnels = [] } = trpc.tunnels.list.useQuery(undefined, { refetchInterval: 30000 });
  const { data: wallet } = trpc.billing.me.useQuery(undefined, { enabled: !isAdmin });
  const { data: trafficBilling } = trpc.trafficBilling.status.useQuery();
  const { data: subscriptions = [] } = trpc.plans.mySubscriptions.useQuery(undefined, { enabled: !isAdmin });
  const { data: userTraffic = [], isLoading: userTrafficLoading } = trpc.dashboard.userTraffic.useQuery(undefined, { refetchInterval: 30000 });
  const { data: trafficSeries, isLoading: trendLoading } = trpc.dashboard.trafficSeries.useQuery(
    { hours: 168, bucketMinutes: 30 },
    { refetchInterval: 30000 },
  );

  const chartData = useMemo(
    () =>
      (trafficSeries || []).map((point: any) => ({
        label: formatTrafficTime(point.bucket),
        fullLabel: formatTrafficTime(point.bucket),
        bytesIn: Number(point.bytesIn) || 0,
        bytesOut: Number(point.bytesOut) || 0,
      })),
    [trafficSeries],
  );

  const currentUserTraffic = useMemo(() => {
    if (!userTraffic.length) return null;
    return userTraffic.find((item: any) => Number(item.id) === Number(user?.id)) || userTraffic[0];
  }, [userTraffic, user?.id]);

  const trafficLimit = Number(currentUserTraffic?.trafficLimit) || 0;
  const trafficUsed = Number(currentUserTraffic?.trafficUsed) || 0;
  const trafficRemaining = trafficLimit > 0 ? Math.max(0, trafficLimit - trafficUsed) : null;
  const trafficPercent = trafficLimit > 0 ? Math.min(100, Math.round((trafficUsed / trafficLimit) * 100)) : 0;
  const trafficBillingEnabled = !!trafficBilling?.enabled;
  const trafficBillingBytes = Number(trafficBilling?.totalBytes || 0);
  const trafficBillingAmount = Number(trafficBilling?.totalAmountCents || 0);
  const trafficBillingBilledGb = Number(trafficBilling?.totalBilledGb || 0);
  const expiry = getExpiryStatus(currentUserTraffic?.expiresAt);
  const canForward = isAdmin || !!currentUserTraffic?.canAddRules;

  const activeSubscription = useMemo(() => {
    const now = Date.now();
    return (subscriptions || []).find((subscription: any) => {
      const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      return subscription.status === "active" && expiresAt > now;
    });
  }, [subscriptions]);

  const onlineRate = stats?.totalHosts ? Math.round((stats.onlineHosts / stats.totalHosts) * 100) : 0;
  const activeRate = stats?.totalRules ? Math.round((stats.activeRules / stats.totalRules) * 100) : 0;
  const recentHosts = hosts.slice(0, 5);
  const recentRules = rules.slice(0, 5);

  const hostById = useMemo(() => {
    const map = new Map<number, any>();
    hosts.forEach((host: any) => map.set(Number(host.id), host));
    return map;
  }, [hosts]);

  const tunnelById = useMemo(() => {
    const map = new Map<number, any>();
    tunnels.forEach((tunnel: any) => map.set(Number(tunnel.id), tunnel));
    return map;
  }, [tunnels]);

  const getRuleEntryAddress = (rule: any) => {
    const host = hostById.get(Number(rule.hostId));
    const entry = String(host?.entryIp || host?.ip || "").trim();
    return `${entry || "入口未配置"}:${rule.sourcePort}`;
  };

  const getRuleLinkLabel = (rule: any) => {
    if (rule.tunnelId) return getTunnelDisplay(tunnelById.get(Number(rule.tunnelId)));
    return FORWARD_TYPE_LABELS[rule.forwardType as keyof typeof FORWARD_TYPE_LABELS] || rule.forwardType;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">仪表盘</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">欢迎回来，{user?.name || user?.username || "用户"}</p>
        </div>
        <Badge variant="outline" className="gap-1.5 border-emerald-500/30 px-3 py-1.5 text-emerald-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          系统在线
        </Badge>
      </div>

      <div className={`grid grid-cols-2 gap-3 sm:gap-4 ${isAdmin ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {isAdmin && (
          <StatCard
            title="主机总数"
            value={stats?.totalHosts ?? 0}
            subtitle={`${stats?.onlineHosts ?? 0} 台在线`}
            icon={Server}
            tone="bg-gradient-to-br from-blue-500 to-blue-600"
            loading={isLoading}
          />
        )}
        <StatCard
          title="转发规则"
          value={stats?.totalRules ?? 0}
          subtitle={`${stats?.activeRules ?? 0} 条活跃`}
          icon={ArrowRightLeft}
          tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
          loading={isLoading}
        />
        <StatCard
          title="入站流量"
          value={formatBytes(stats?.totalTrafficIn ?? 0)}
          subtitle="累计入站"
          icon={ArrowDownToLine}
          tone="bg-gradient-to-br from-violet-500 to-violet-600"
          loading={isLoading}
        />
        <StatCard
          title="出站流量"
          value={formatBytes(stats?.totalTrafficOut ?? 0)}
          subtitle="累计出站"
          icon={ArrowUpFromLine}
          tone="bg-gradient-to-br from-amber-500 to-amber-600"
          loading={isLoading}
        />
      </div>

      {isAdmin && trafficBillingEnabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            title="计费流量"
            value={formatBytes(trafficBillingBytes)}
            subtitle={`已计费 ${trafficBillingBilledGb}GB`}
            icon={Coins}
            tone="bg-gradient-to-br from-cyan-500 to-cyan-600"
            loading={isLoading}
          />
          <StatCard
            title="计费消费"
            value={money(trafficBillingAmount)}
            subtitle="全局流量计费扣费"
            icon={WalletCards}
            tone="bg-gradient-to-br from-rose-500 to-rose-600"
            loading={isLoading}
          />
        </div>
      )}

      {!isAdmin && (
        <Card className="relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Shield className="h-4 w-4" />
                我的账户状态
              </CardTitle>
              {userTrafficLoading ? (
                <Skeleton className="h-6 w-36 rounded-full" />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Badge variant={canForward ? "outline" : "destructive"} className={canForward ? "border-emerald-500/30 text-emerald-600" : ""}>
                    {canForward ? "转发已启用" : "转发已停用"}
                  </Badge>
                  <Badge variant={expiry.tone === "danger" ? "destructive" : "outline"} className={expiry.tone === "warning" ? "border-amber-500/40 text-amber-600" : ""}>
                    {expiry.label}
                  </Badge>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {userTrafficLoading ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-20 w-full" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="text-xs text-muted-foreground">套餐已用流量</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{formatBytes(trafficUsed)}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="text-xs text-muted-foreground">套餐剩余流量</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{trafficRemaining === null ? "不限" : formatBytes(trafficRemaining)}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="text-xs text-muted-foreground">到期时间</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{formatDate(currentUserTraffic?.expiresAt)}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <WalletCards className="h-3 w-3" />
                      账户余额
                    </p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{money(wallet?.balanceCents)}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <WalletCards className="h-3 w-3" />
                      计费流量
                    </p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{trafficBillingEnabled ? formatBytes(trafficBillingBytes) : "未开启"}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{trafficBillingEnabled ? `已计费 ${trafficBillingBilledGb}GB` : "管理员未开启"}</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <WalletCards className="h-3 w-3" />
                      计费消费
                    </p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{trafficBillingEnabled ? money(trafficBillingAmount) : "-"}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">仅统计流量计费资源</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Package className="h-3 w-3" />
                      当前套餐
                    </p>
                    <p className="mt-1 truncate text-xl font-semibold">{activeSubscription?.planName || "未订阅"}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>套餐流量使用进度</span>
                    <span className="tabular-nums">
                      {trafficLimit > 0 ? `${formatBytes(trafficUsed)} / ${formatBytes(trafficLimit)} (${trafficPercent}%)` : `${formatBytes(trafficUsed)} / 不限`}
                    </span>
                  </div>
                  <Progress value={trafficLimit > 0 ? trafficPercent : 0} className="h-2" />
                  <p className="text-[11px] text-muted-foreground/70">
                    普通套餐流量和流量计费资源分开统计，互不影响。管理员未设置限额时，仅展示套餐已用总量。
                    {currentUserTraffic?.trafficAutoReset ? ` 每月 ${currentUserTraffic.trafficResetDay || 1} 日自动重置。` : ""}
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BarChart3 className="h-4 w-4" />
              主页流量走势
              <span className="text-[10px] font-normal text-muted-foreground/60">最近 7 天 / 每 30 分钟</span>
            </CardTitle>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                入站
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                出站
              </span>
            </div>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/60">
            <Info className="h-3 w-3" />
            按 Agent 上报的规则增量流量汇总；每个节点代表 30 分钟内所有可见规则的入站和出站合计。
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-52 w-full sm:h-64">
            {trendLoading ? (
              <Skeleton className="h-full w-full" />
            ) : chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无流量数据</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="trafficInGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="trafficOutGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={60} interval="preserveStartEnd" />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(value) => formatBytes(value)}
                    width={56}
                    domain={[0, (dataMax: number) => Math.max(1024, Math.ceil((dataMax || 0) * 1.2))]}
                    allowDecimals={false}
                  />
                  <RTooltip content={<TrafficTooltipContent />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} />
                  <Area type="monotone" dataKey="bytesIn" name="入站" stroke="#10b981" strokeWidth={2} fill="url(#trafficInGradient)" dot={false} />
                  <Area type="monotone" dataKey="bytesOut" name="出站" stroke="#f59e0b" strokeWidth={2} fill="url(#trafficOutGradient)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <TrendingUp className="h-4 w-4" />
            最近规则
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentRules.length > 0 ? (
            <div className="space-y-2">
              {recentRules.map((rule: any) => (
                <div key={rule.id} className="flex flex-col gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`h-2 w-2 rounded-full ${rule.isRunning ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-muted-foreground/30"}`} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{rule.name}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {getRuleEntryAddress(rule)}
                        {" -> "}
                        {rule.targetIp}:{rule.targetPort}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Badge variant="outline" className="border-amber-500/30 text-amber-600">
                      {getRuleLinkLabel(rule)}
                    </Badge>
                    <Badge variant="secondary">{protocolLabel(rule.protocol)}</Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无转发规则</div>
          )}
        </CardContent>
      </Card>

      <div className={`grid grid-cols-1 gap-4 ${isAdmin ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {isAdmin && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Wifi className="h-4 w-4" />
                主机在线率
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-6">
                {isLoading ? <Skeleton className="h-20 w-20 rounded-full" /> : <CircularProgress value={onlineRate} color="#10b981" />}
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    在线 {stats?.onlineHosts ?? 0}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                    离线 {(stats?.totalHosts ?? 0) - (stats?.onlineHosts ?? 0)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Zap className="h-4 w-4" />
              规则活跃率
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              {isLoading ? <Skeleton className="h-20 w-20 rounded-full" /> : <CircularProgress value={activeRate} color="#3b82f6" />}
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  活跃 {stats?.activeRules ?? 0}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                  停用 {(stats?.totalRules ?? 0) - (stats?.activeRules ?? 0)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Activity className="h-4 w-4" />
              系统概览
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">规则负载</span>
              <div className="flex w-32 items-center gap-2">
                <Progress value={activeRate} className="h-1.5" />
                <span className="w-8 text-right text-xs font-medium tabular-nums">{activeRate}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">用户角色</span>
              <Badge variant="secondary" className="px-2 py-0.5 text-[10px]">
                {isAdmin ? (
                  <>
                    <Shield className="mr-1 h-3 w-3" />
                    管理员
                  </>
                ) : (
                  "普通用户"
                )}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {isAdmin && (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Globe className="h-4 w-4" />
              最近主机
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentHosts.length > 0 ? (
              <div className="space-y-2">
                {recentHosts.map((host: any) => (
                  <div key={host.id} className="flex items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-muted/30">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${host.isOnline ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-muted-foreground/30"}`} />
                      <div>
                        <p className="text-sm font-medium">{host.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{host.ip}</p>
                      </div>
                    </div>
                    {host.isOnline ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-muted-foreground/40" />}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">暂无主机</div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function Home() {
  const { user, loading } = useAuth();
  const { data: settings, isLoading: settingsLoading } = trpc.system.getSettings.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (loading || settingsLoading) return null;

  if (!user) {
    if (settings?.homepageEnabled !== false) {
      if (settings?.homepageCustomEnabled && settings?.homepageHtml?.trim()) {
        return <CustomPublicHome html={settings.homepageHtml} />;
      }
      return <PublicHome />;
    }
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }

  return (
    <DashboardLayout>
      <DashboardContent />
    </DashboardLayout>
  );
}

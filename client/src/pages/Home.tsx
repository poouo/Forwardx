import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import DashboardLayout from "@/components/DashboardLayout";
import MobileAppSettings from "@/components/MobileAppSettings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  BarChart3,
  Coins,
  Info,
  Package,
  Server,
  Shield,
  WalletCards,
  Wifi,
  Zap,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import PublicHome, { CustomPublicHome } from "./PublicHome";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";
const TRAFFIC_PIE_COLORS = ["#38bdf8", "#818cf8", "#f472b6", "#34d399", "#facc15", "#fb7185", "#22d3ee", "#a78bfa"];
const TRAFFIC_PIE_MAX_SEGMENTS = 5;
const RADIAN = Math.PI / 180;

type TrafficPieDatum = {
  id: number | string;
  name: string;
  value: number;
  color: string;
  percent: number;
};

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

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading,
  className,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
  className?: string;
}) {
  return (
    <Card className={`group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5 ${className || ""}`}>
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-3 sm:p-5">
        <div className="flex items-start justify-between gap-2 sm:gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <AnimatedStatValue
              as="p"
              value={value}
              loading={loading}
              cacheKey={cacheKey}
              fallbackValue={fallbackValue}
              className="break-words text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl"
            />
            {subtitle && (
              <AnimatedStatValue
                as="p"
                value={subtitle}
                loading={loading}
                cacheKey={`${cacheKey}.subtitle`}
                fallbackValue=""
                className="break-words text-xs text-muted-foreground/80"
              />
            )}
          </div>
          <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone} shadow-sm sm:flex`}>
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

function PieTooltipContent({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
        <p className="max-w-52 truncate text-xs font-medium">{item.name}</p>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{formatBytes(item.value)}</span>
        <span>{item.percent}%</span>
      </div>
    </div>
  );
}

function renderPieLabel(props: any) {
  const { cx, cy, midAngle, outerRadius, name, percent } = props;
  if (!percent || percent < 4) return null;
  const radius = outerRadius + 18;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const anchor = x > cx ? "start" : "end";
  const displayName = String(name || "");
  const label = displayName.length > 8 ? `${displayName.slice(0, 8)}...` : displayName;
  return (
    <text x={x} y={y} textAnchor={anchor} dominantBaseline="central" className="fill-foreground text-[10px]">
      <tspan x={x} dy="-0.45em">{label}</tspan>
      <tspan x={x} dy="1.15em" className="fill-muted-foreground tabular-nums">{percent}%</tspan>
    </text>
  );
}

function PieLoading() {
  return (
    <div className="flex h-56 items-center justify-center">
      <div className="relative h-32 w-32">
        <div className="absolute inset-0 rounded-full border-8 border-muted/50" />
        <div className="absolute inset-0 animate-spin rounded-full border-8 border-transparent border-t-primary border-r-emerald-500" />
        <div className="absolute inset-8 rounded-full bg-card shadow-inner" />
      </div>
    </div>
  );
}

function TrafficPieCard({
  title,
  data,
  loading,
}: {
  title: string;
  data: Array<{ id: number; name: string; value: number }>;
  loading: boolean;
}) {
  const chartData = useMemo<TrafficPieDatum[]>(() => {
    const normalized = data
      .map((item) => ({ ...item, value: Number(item.value) || 0 }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    const visible = normalized.slice(0, TRAFFIC_PIE_MAX_SEGMENTS);
    const rest = normalized.slice(TRAFFIC_PIE_MAX_SEGMENTS);
    const merged = rest.length > 0
      ? [...visible, { id: "other", name: "其他", value: rest.reduce((sum, item) => sum + item.value, 0) }]
      : visible;
    const sum = merged.reduce((acc, item) => acc + item.value, 0);
    return merged.map((item, index) => ({
      id: item.id,
      name: item.name,
      value: item.value,
      color: TRAFFIC_PIE_COLORS[index % TRAFFIC_PIE_COLORS.length],
      percent: sum > 0 ? Number(((item.value / sum) * 100).toFixed(1)) : 0,
    }));
  }, [data]);
  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <BarChart3 className="h-4 w-4" />
            {title}
          </CardTitle>
          <span className="text-[10px] text-muted-foreground/70">最近 7 天</span>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <PieLoading />
        ) : chartData.length === 0 || total <= 0 ? (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">暂无流量数据</div>
        ) : (
          <div className="space-y-3">
            <div className="h-72 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="46%"
                    innerRadius="46%"
                    outerRadius="68%"
                    paddingAngle={3}
                    minAngle={3}
                    cornerRadius={8}
                    label={renderPieLabel}
                    labelLine={{ stroke: "var(--color-muted-foreground)", strokeWidth: 1 }}
                    isAnimationActive
                    animationDuration={700}
                  >
                    {chartData.map((item) => (
                      <Cell key={item.id} fill={item.color} stroke="var(--color-card)" strokeWidth={4} />
                    ))}
                  </Pie>
                  <RTooltip content={<PieTooltipContent />} wrapperStyle={{ pointerEvents: "none" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-2">
              {chartData.map((item) => (
                <div key={item.id} className="flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-2.5 w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
                  <span className="max-w-28 truncate">{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery(undefined, { refetchInterval: 15000 });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, { enabled: !isAdmin });
  const { data: trafficBilling, isLoading: trafficBillingLoading } = trpc.trafficBilling.status.useQuery();
  const { data: subscriptions = [], isLoading: subscriptionsLoading } = trpc.plans.mySubscriptions.useQuery(undefined, { enabled: !isAdmin });
  const { data: userTraffic = [], isLoading: userTrafficLoading } = trpc.dashboard.userTraffic.useQuery(undefined, { refetchInterval: 30000 });
  const { data: trafficBreakdown, isLoading: breakdownLoading } = trpc.dashboard.trafficBreakdown.useQuery(
    { hours: 168, limit: 30 },
    { refetchInterval: 30000 },
  );
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

  const accountTrafficLimit = Number(currentUserTraffic?.trafficLimit) || 0;
  const trafficUsed = Number(currentUserTraffic?.trafficUsed) || 0;
  const trafficBillingEnabled = !!trafficBilling?.enabled;
  const trafficBillingBytes = Number(trafficBilling?.totalBytes || 0);
  const trafficBillingAmount = Number(trafficBilling?.totalAmountCents || 0);
  const trafficBillingBilledGb = Number(trafficBilling?.totalBilledGb || 0);

  const activeSubscriptions = useMemo(() => {
    const now = Date.now();
    return (subscriptions || []).filter((subscription: any) => {
      const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      return subscription.status === "active" && expiresAt > now;
    });
  }, [subscriptions]);
  const activeSubscription = activeSubscriptions[0];
  const hasActiveSubscription = !!activeSubscription;
  const hasUnlimitedPlanTraffic = activeSubscriptions.some((subscription: any) => Number(subscription.trafficLimit || 0) === 0);
  const activeAddonTrafficBytes = hasActiveSubscription && !hasUnlimitedPlanTraffic
    ? activeSubscriptions.reduce((total: number, subscription: any) => total + (Number(subscription.activeTrafficAddonBytes) || 0), 0)
    : 0;
  const basePlanTrafficLimit = hasActiveSubscription && !hasUnlimitedPlanTraffic
    ? Math.max(0, ...activeSubscriptions.map((subscription: any) => Number(subscription.trafficLimit || 0)))
    : 0;
  const planTrafficLimit = hasActiveSubscription
    ? hasUnlimitedPlanTraffic
      ? 0
      : Math.max(accountTrafficLimit, basePlanTrafficLimit + activeAddonTrafficBytes)
    : 0;
  const trafficPercent = planTrafficLimit > 0 ? Math.min(100, Math.round((trafficUsed / planTrafficLimit) * 100)) : 0;
  const accountStatusLoading = userTrafficLoading || subscriptionsLoading || trafficBillingLoading || (!isAdmin && walletLoading);
  const accountCacheScope = user?.id ? String(user.id) : "current";
  const planExpiresAt = currentUserTraffic ? currentUserTraffic.expiresAt ?? null : activeSubscription?.expiresAt ?? null;
  const expiry = hasActiveSubscription ? getExpiryStatus(planExpiresAt) : { label: "---", tone: "normal" as const };
  const canForward = isAdmin || !!currentUserTraffic?.canAddRules;
  const canForwardText = canForward ? "转发已启用" : "转发已停用";
  const planExpiryText = hasActiveSubscription ? formatDate(planExpiresAt) : "---";
  const planProgressText = hasActiveSubscription
    ? planTrafficLimit > 0
      ? `${formatBytes(trafficUsed)} / ${formatBytes(planTrafficLimit)} (${trafficPercent}%)`
      : `${formatBytes(trafficUsed)} / 不限`
    : "---";
  const planTrafficBreakdownText = hasActiveSubscription
    ? planTrafficLimit > 0
      ? activeAddonTrafficBytes > 0
        ? `基础 ${formatBytes(Math.max(0, planTrafficLimit - activeAddonTrafficBytes))} + 附加 ${formatBytes(activeAddonTrafficBytes)}`
        : `套餐总量 ${formatBytes(planTrafficLimit)}`
      : "不限流量"
    : "暂无生效套餐";
  const planProgressValue = hasActiveSubscription && planTrafficLimit > 0 ? trafficPercent : 0;
  const trafficBillingBytesText = trafficBillingEnabled ? formatBytes(trafficBillingBytes) : "未开启";
  const trafficBillingAmountText = trafficBillingEnabled ? money(trafficBillingAmount) : "-";
  const trafficBillingAdminSubtitle = trafficBillingEnabled ? `已计费 ${trafficBillingBilledGb}GB` : "流量计费功能未开启";
  const trafficBillingUserSubtitle = trafficBillingEnabled ? `已计费 ${trafficBillingBilledGb}GB` : "管理员未开启";

  const mobileReminderSnapshot = useMemo(
    () => ({
      trafficLimit: hasActiveSubscription ? planTrafficLimit : 0,
      trafficUsed: hasActiveSubscription ? trafficUsed : 0,
      expiresAt: hasActiveSubscription ? planExpiresAt : null,
    }),
    [hasActiveSubscription, planTrafficLimit, trafficUsed, planExpiresAt],
  );

  const onlineRate = stats?.totalHosts ? Math.round((stats.onlineHosts / stats.totalHosts) * 100) : 0;
  const activeRate = stats?.totalRules ? Math.round((stats.activeRules / stats.totalRules) * 100) : 0;
  const tunnelRuleTrafficData = useMemo(
    () => (trafficBreakdown?.tunnelRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [trafficBreakdown?.tunnelRules],
  );
  const portRuleTrafficData = useMemo(
    () => (trafficBreakdown?.portRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [trafficBreakdown?.portRules],
  );
  const forwardGroupRuleTrafficData = useMemo(
    () => (trafficBreakdown?.forwardGroupRules || []).map((item: any) => ({ id: Number(item.id), name: item.name, value: Number(item.totalBytes) || 0 })),
    [trafficBreakdown?.forwardGroupRules],
  );

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
            cacheKey="home.stats.totalHosts"
            fallbackValue={0}
          />
        )}
        <StatCard
          title="转发规则"
          value={stats?.totalRules ?? 0}
          subtitle={`${stats?.activeRules ?? 0} 条活跃`}
          icon={ArrowRightLeft}
          tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
          loading={isLoading}
          cacheKey="home.stats.totalRules"
          fallbackValue={0}
        />
        <StatCard
          title="入站流量"
          value={formatBytes(stats?.totalTrafficIn ?? 0)}
          subtitle="累计入站"
          icon={ArrowDownToLine}
          tone="bg-gradient-to-br from-violet-500 to-violet-600"
          loading={isLoading}
          cacheKey="home.stats.totalTrafficIn"
          fallbackValue="0 B"
          className="col-span-2 sm:col-span-1"
        />
        <StatCard
          title="出站流量"
          value={formatBytes(stats?.totalTrafficOut ?? 0)}
          subtitle="累计出站"
          icon={ArrowUpFromLine}
          tone="bg-gradient-to-br from-amber-500 to-amber-600"
          loading={isLoading}
          cacheKey="home.stats.totalTrafficOut"
          fallbackValue="0 B"
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <MobileAppSettings snapshot={mobileReminderSnapshot} />

      {isAdmin ? (
        <Card className="relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Shield className="h-4 w-4" />
                我的消耗
              </CardTitle>
              <Badge variant="outline" className="border-emerald-500/30 text-emerald-600">
                <AnimatedStatValue
                  value="管理员权限"
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.adminBadge`}
                  fallbackValue="管理员权限"
                />
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  我的已用流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={formatBytes(trafficUsed)}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.trafficUsed`}
                  fallbackValue="0 B"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">按当前登录账号统计</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Coins className="h-3 w-3" />
                  计费流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingBytesText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingTraffic`}
                  fallbackValue="未开启"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAdminSubtitle}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingTrafficSubtitle`}
                  fallbackValue="流量计费功能未开启"
                  className="mt-1 text-[11px] text-muted-foreground"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费消费
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAmountText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.billingAmount`}
                  fallbackValue="-"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">仅统计当前账号</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Shield className="h-3 w-3" />
                  权限状态
                </p>
                <AnimatedStatValue
                  as="p"
                  value="管理员"
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.permission`}
                  fallbackValue="管理员"
                  className="mt-1 text-xl font-semibold"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">不受套餐订阅限制</p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              首页流量、规则、趋势和计费消耗均按当前管理员账号独立统计，不展示套餐、到期时间等订阅信息。
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Shield className="h-4 w-4" />
                我的账户状态
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant={canForward ? "outline" : "destructive"} className={canForward ? "border-emerald-500/30 text-emerald-600" : ""}>
                  <AnimatedStatValue
                    value={canForwardText}
                    loading={accountStatusLoading}
                    cacheKey={`home.account.${accountCacheScope}.canForward`}
                    fallbackValue="转发已停用"
                  />
                </Badge>
                <Badge variant={expiry.tone === "danger" ? "destructive" : "outline"} className={expiry.tone === "warning" ? "border-amber-500/40 text-amber-600" : ""}>
                  <AnimatedStatValue
                    value={expiry.label}
                    loading={accountStatusLoading}
                    cacheKey={`home.account.${accountCacheScope}.expiry`}
                    fallbackValue="---"
                  />
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
              <div className="rounded-lg border border-border/50 bg-background/35 p-3 xl:col-span-2">
                <p className="text-xs text-muted-foreground">套餐用量</p>
                <AnimatedStatValue
                  as="p"
                  value={planProgressText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planProgress`}
                  fallbackValue="---"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <AnimatedStatValue
                  as="p"
                  value={planTrafficBreakdownText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planBreakdown`}
                  fallbackValue="暂无生效套餐"
                  className="mt-1 text-[11px] text-muted-foreground"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="text-xs text-muted-foreground">到期时间</p>
                <AnimatedStatValue
                  as="p"
                  value={planExpiryText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planExpiry`}
                  fallbackValue="---"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  账户余额
                </p>
                <AnimatedStatValue
                  as="p"
                  value={money(wallet?.balanceCents)}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.wallet`}
                  fallbackValue={money(0)}
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费流量
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingBytesText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingTraffic`}
                  fallbackValue="未开启"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingUserSubtitle}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingTrafficSubtitle`}
                  fallbackValue="管理员未开启"
                  className="mt-1 text-[11px] text-muted-foreground"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <WalletCards className="h-3 w-3" />
                  计费消费
                </p>
                <AnimatedStatValue
                  as="p"
                  value={trafficBillingAmountText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.userBillingAmount`}
                  fallbackValue="-"
                  className="mt-1 text-xl font-semibold tabular-nums"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">仅统计流量计费资源</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/35 p-3">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Package className="h-3 w-3" />
                  当前套餐
                </p>
                <AnimatedStatValue
                  as="p"
                  value={activeSubscription?.planName || "---"}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planName`}
                  fallbackValue="---"
                  className="mt-1 truncate text-xl font-semibold"
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>套餐流量使用进度</span>
                <AnimatedStatValue
                  value={planProgressText}
                  loading={accountStatusLoading}
                  cacheKey={`home.account.${accountCacheScope}.planProgress.inline`}
                  fallbackValue="---"
                  className="tabular-nums"
                />
              </div>
              <Progress value={planProgressValue} className="h-2" />
              <p className="text-[11px] text-muted-foreground/70">
                {hasActiveSubscription ? "套餐流量和计费流量分开统计。" : "暂无生效套餐，套餐流量信息暂不展示。"}
                {hasActiveSubscription && currentUserTraffic?.trafficAutoReset ? ` 每月 ${currentUserTraffic.trafficResetDay || 1} 日自动重置。` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BarChart3 className="h-4 w-4" />
              近期流量走势
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
            每 30 分钟汇总一次可见规则流量。
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

      <div className="grid gap-4 lg:grid-cols-3">
        <TrafficPieCard title="隧道流量" data={tunnelRuleTrafficData} loading={breakdownLoading} />
        <TrafficPieCard title="端口转发流量" data={portRuleTrafficData} loading={breakdownLoading} />
        <TrafficPieCard title="转发组流量" data={forwardGroupRuleTrafficData} loading={breakdownLoading} />
      </div>

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
    </div>
  );
}

export default function Home() {
  const { user, loading } = useAuth();
  const { data: settings, isLoading: settingsLoading } = trpc.system.getSettings.useQuery(undefined, {
    enabled: !mobileAuth.isNative || mobileAuth.hasPanelUrl(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!user || typeof window === "undefined") return;
    const welcomeName = window.sessionStorage.getItem(LOGIN_WELCOME_TOAST_KEY);
    if (!welcomeName) return;
    window.sessionStorage.removeItem(LOGIN_WELCOME_TOAST_KEY);
    toast.success(`欢迎回来！${welcomeName} 用户`, { position: "top-right" });
  }, [user?.id]);

  if (loading || settingsLoading) return null;

  if (!user) {
    if (mobileAuth.isNative) {
      if (typeof window !== "undefined") window.location.href = "/login";
      return null;
    }
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

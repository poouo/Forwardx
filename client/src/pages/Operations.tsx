import { useEffect, useMemo, useState } from "react";
import { t, getFormatLocale } from "@/i18n";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import OperationsChinaMap, { operationsBytes as bytes, sourceUsage } from "@/components/OperationsChinaMap";
import OperationsDateFilter from "@/components/OperationsDateFilter";
import OperationsSourceList from "@/components/OperationsSourceList";
import OperationsFinanceSummary from "@/components/OperationsFinanceSummary";
import OperationsRefreshSelect from "@/components/OperationsRefreshSelect";
import OperationsSettingsDialog from "@/components/OperationsSettingsDialog";
import OperationsMonitorPanel from "@/components/OperationsMonitorPanel";
import Ranking from "@/components/OperationsRanking";
import { SummaryMetricCard } from "@/components/SummaryMetricCard";
import { useOperationsRefresh } from "@/hooks/useOperationsRefresh";
import { operationsRefreshOptions } from "@/lib/operationsRefresh";
import UserSelect from "@/components/UserSelect";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Globe2, RefreshCw, Server } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { operationsDate, OPERATIONS_SOURCE_PAGE_SIZE, type OperationsSourceSort } from "@shared/operations";
import { toast } from "@/lib/localizedToast";

function time(value: unknown) { return new Date(Number(value) * 1000).toLocaleString(getFormatLocale(), { timeZone: "Asia/Shanghai" }); }
const statusLabels: Record<string, string> = { sampled: "采样正常", unavailable: "无法读取连接跟踪", limited: "已达到采样上限", disabled: "已关闭", no_rules: "无可采集的规则" };

export default function OperationsPage() {
  const { user } = useAuth();
  const autoRefresh = useOperationsRefresh(user?.id);
  const refreshInterval = autoRefresh.interval;
  const refreshOptions = operationsRefreshOptions(refreshInterval);
  const [userScope, setUserScope] = useState("self");
  const [sort, setSort] = useState<OperationsSourceSort>("traffic");
  const [activeProvince,setActiveProvince] = useState<string|null>(null), [province,setProvince] = useState<string|null>(null), [pinnedProvince,setPinnedProvince] = useState<string|null>(null);
  useEffect(()=> {const timer=setTimeout(()=>setProvince(activeProvince),150);return ()=>clearTimeout(timer);},[activeProvince]);
  const today = operationsDate(), minimum = operationsDate(Date.now() / 1000 - 29 * 86400);
  const [from, setFrom] = useState(today), [to, setTo] = useState(today);
  const [dates, setDates] = useState({ from: today, to: today });
  const [geoCursor, setGeoCursor] = useState("");
  useEffect(() => { setGeoCursor(""); }, [dates, userScope]);
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [page, setPage] = useState(0);
  const [confirm, setConfirm] = useState<"collect" | "geo" | null>(null), [selectedIp, setSelectedIp] = useState("");
  useEffect(() => { const id = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 350); return () => clearTimeout(id); }, [search]);
  const scopeUserId: "self" | "all" | number = userScope === "self" || userScope === "all" ? userScope : Number(userScope);
  const scopedDates = { ...dates, userId: scopeUserId };
  const provinceDetails = trpc.operations.provinceDetails.useQuery({...scopedDates,province:province || "",search:query},{...refreshOptions,enabled:!!province,staleTime:15000});
  const pinnedDetails = trpc.operations.provinceDetails.useQuery({...scopedDates,province:pinnedProvince || "",search:query},{...refreshOptions,enabled:!!pinnedProvince,staleTime:15000});
  useEffect(()=> {setActiveProvince(null);setProvince(null);setPinnedProvince(null);},[dates,userScope,query]);
  const overview = trpc.operations.overview.useQuery(scopedDates, refreshOptions);
  const sources = trpc.operations.sources.useQuery({ ...scopedDates, page, search: query, sort }, refreshOptions);
  const details = trpc.operations.sourceDetails.useQuery({ ...scopedDates, ip: selectedIp }, { ...refreshOptions, enabled: !!selectedIp });
  useEffect(() => { setSelectedIp(""); }, [dates]);
  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(Number(sources.data?.totals?.ips || 0) / OPERATIONS_SOURCE_PAGE_SIZE) - 1);
    if (sources.data && page > lastPage) setPage(lastPage);
  }, [sources.data, page]);
  const utils = trpc.useUtils();
  const refresh = () => { void utils.operations.invalidate(); };
  const collection = trpc.operations.setSourceCollection.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message) });
  const resolve = trpc.operations.resolveSources.useMutation({ onSuccess: data => { setGeoCursor(data.next); refresh(); toast.success(t("已定位 {0}/{1} 个 IP", [data.resolved, data.attempted])); }, onError: error => toast.error(error.message) });
  const trend = useMemo(() => (overview.data?.trend || []).map(row => ({ ...row, date: operationsDate(Number(row.dayStart)), bytesIn: Number(row.bytesIn), bytesOut: Number(row.bytesOut) })), [overview.data]);
  const totalIn = trend.reduce((sum, row) => sum + row.bytesIn, 0), totalOut = trend.reduce((sum, row) => sum + row.bytesOut, 0);
  const online = (overview.data?.current || []).filter(row => row.isOnline === true || Number(row.isOnline) === 1).reduce((sum, row) => sum + Number(row.count), 0);
  const hostCount = (overview.data?.current || []).reduce((sum, row) => sum + Number(row.count), 0);
  const enabled = sources.data?.enabled ?? false;
  const cards = [
    { title: t("入向流量"), value: bytes(totalIn), icon: ArrowDownToLine, tone: "sky" as const },
    { title: t("出向流量"), value: bytes(totalOut), icon: ArrowUpFromLine, tone: "emerald" as const },
    { title: t("来源 IP"), value: String(sources.data?.totals?.ips ?? "—"), icon: Globe2, tone: "violet" as const },
    { title: t("当前在线主机"), value: `${online}/${hostCount}`, icon: Server, tone: "amber" as const },
  ];
  return <DashboardLayout><div className="w-full min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">{t("运维看板")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("最近 30 天 · 北京时间 · 实际规则流量，不含计费倍率")}</p><p className="mt-1 text-xs text-muted-foreground">{t("流量与财务汇总约每分钟更新")}</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <OperationsRefreshSelect seconds={autoRefresh.seconds} onChange={autoRefresh.onChange} />
        <OperationsSettingsDialog />
        <Button variant="outline" onClick={refresh} disabled={overview.isFetching || sources.isFetching}><RefreshCw className="mr-2 size-4" />{t("刷新")}</Button>
      </div>
    </div>
    {(import.meta as any).env?.VITE_FORWARDX_DEV_PANEL === "1" && <p className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-2 text-sm text-muted-foreground">{t("本地演示数据，不代表真实流量或 IP 位置。")}</p>}
    <OperationsDateFilter from={from} to={to} minimum={minimum} today={today} onFromChange={setFrom} onToChange={setTo}
      onApply={() => { setDates({ from, to }); setPage(0); }}
      onToday={() => { const value = operationsDate(); setFrom(value); setTo(value); setDates({ from: value, to: value }); setPage(0); }}
      onMonth={() => { setFrom(minimum); setTo(today); setDates({ from: minimum, to: today }); setPage(0); }}>
      <div className="min-w-0 space-y-2 lg:w-56"><Label htmlFor="operations-user" className="block leading-5">{t("用户")}</Label>
        <UserSelect id="operations-user" className="h-8" value={userScope} excludeUserId={user?.id}
          specialOptions={[{ value: "all", label: t("所有用户") }, { value: "self", label: t("管理员") }]}
          onValueChange={value => { setUserScope(value); setPage(0); setSelectedIp(""); setConfirm(null); setGeoCursor(""); }} />
      </div>
    </OperationsDateFilter>
    {(overview.error || sources.error) && <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{overview.error?.message || sources.error?.message}</div>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(card => <SummaryMetricCard key={card.title} {...card} value={overview.isLoading ? "—" : card.value} />)}</div>
    <OperationsFinanceSummary {...scopedDates} refreshInterval={refreshInterval} />
    <Card><CardHeader><CardTitle className="text-base">{t("流量趋势")}</CardTitle><p className="text-xs text-muted-foreground">{overview.data?.since ? t("数据自 {0} 起积累，升级前的历史不会补算。", [operationsDate(Number(overview.data.since))]) : t("数据将在新版本接收流量上报后开始积累。")}</p></CardHeader><CardContent>
      <div className="h-64 min-w-0 overflow-hidden">{trend.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="date" tick={{ fontSize: 11 }} /><YAxis tickFormatter={bytes} width={80} tick={{ fontSize: 11 }} /><Tooltip formatter={value => bytes(value)} contentStyle={{ background: "var(--card)", borderColor: "var(--border)", borderRadius: 12 }} /><Area type="monotone" dataKey="bytesIn" name={t("入向流量")} stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.15} /><Area type="monotone" dataKey="bytesOut" name={t("出向流量")} stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.12} /></AreaChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("暂无数据")}</div>}</div>
    </CardContent></Card>
    <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4"><Ranking title={t("用户流量排行")} rows={overview.data?.users || []} /><Ranking title={t("主机流量排行")} rows={overview.data?.hosts || []} /><Ranking title={t("规则流量排行")} rows={overview.data?.rules || []} ruleLabels /><Ranking title={t("资源流量排行")} rows={overview.data?.resources || []} /></div>
    <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="text-base">{t("中国来源分布")}</CardTitle><div className="flex items-center gap-2"><Switch id="source-collection" checked={enabled} disabled={sources.isLoading || collection.isPending} onCheckedChange={checked => checked ? setConfirm("collect") : collection.mutate({ enabled: false })} /><Label htmlFor="source-collection">{t("采集来源 IP")}</Label></div></div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("仅管理员可见。入口连接定期采样，短连接可能遗漏；NAT/代理后记录实际可见 IP。采样流量不是计费用量。")}</p>
    </CardHeader><CardContent className="grid items-start gap-6 xl:grid-cols-[1.2fr_1fr]">
      <OperationsChinaMap provinces={sources.data?.provinces || []} unmappedIps={sources.data?.unmappedIps || 0} foreignIps={sources.data?.foreignIps || []} foreignCount={sources.data?.foreignCount || 0} unknownIps={sources.data?.unknownIps || 0}
        scopeKey={`${dates.from}:${dates.to}:${userScope}:${query}`} detailProvince={province} details={provinceDetails.data} detailsLoading={provinceDetails.isFetching} detailsError={!!provinceDetails.error}
        fixedDetails={pinnedDetails.data} fixedDetailsLoading={pinnedDetails.isFetching} fixedDetailsError={!!pinnedDetails.error} onProvinceChange={setActiveProvince} onProvinceSelect={setPinnedProvince} onSelectIp={setSelectedIp} />
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap gap-2"><Input className="min-w-36 flex-1" placeholder={t("搜索来源 IP")} value={search} onChange={event => setSearch(event.target.value)} /><Button variant="outline" disabled={resolve.isPending} onClick={() => setConfirm("geo")}>{resolve.isPending ? t("定位中") : t("补全本地定位")}</Button></div>
        {sources.data?.location.remaining && <p className="text-xs text-muted-foreground">{t("来源较多，已分批定位；刷新或补全可继续处理剩余 IP。")}</p>}
        {!enabled && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t("来源采集未开启；已有历史仍可查询。开启后需新版 Agent 上报。")}</p>}
        <OperationsSourceList rows={sources.data?.ips || []} total={Number(sources.data?.totals?.ips || 0)} page={page} sort={sort} loading={sources.isFetching} onPageChange={setPage} onSortChange={value => { setSort(value); setPage(0); }} onSelectIp={setSelectedIp} />
        <p className="text-xs text-muted-foreground">{t("* 表示部分流量缺失，非完整会话流量。来源定位使用内置 IPv4 / IPv6 库，不消耗接口额度。")}</p>
      </div>
    </CardContent></Card>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-base">{t("来源采集状态")}</CardTitle></CardHeader><CardContent className="space-y-3">{sources.data?.statuses.length ? sources.data.statuses.map(row => <div key={row.hostId} className="flex flex-wrap justify-between gap-2 text-sm"><span>{row.name || `#${row.hostId}`}</span><span className="text-muted-foreground">{!enabled ? t("已关闭") : Number(row.lastSeen) < Date.now() / 1000 - 300 ? t("采集状态已过期") : t(statusLabels[row.status] || "未知")} · {time(row.lastSeen)}</span></div>) : <p className="text-sm text-muted-foreground">{t("尚未收到采集状态，请确认 Agent 已升级且来源采集已开启。")}</p>}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">{t("主机离线记录")}</CardTitle></CardHeader><CardContent className="space-y-3">{overview.data?.availability.filter(row => Number(row.offlineSeconds) > 0).map(row => <div key={row.hostId} className="flex justify-between gap-3 text-sm"><span className="truncate">{row.name || `#${row.hostId}`}</span><span className="shrink-0 text-muted-foreground">{t("{0} 次 · {1} 分钟", [row.incidents, (Number(row.offlineSeconds) / 60).toFixed(1)])}</span></div>)}<p className="text-xs text-muted-foreground">{t("仅统计已观测到的离线时段，监控中断不视为主机离线。")}</p></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle className="text-base">{t("转发组事件")}</CardTitle></CardHeader><CardContent className="space-y-3">{overview.data?.events.map(row => <div key={row.id} className="flex flex-col gap-1 border-b pb-3 text-sm last:border-0 sm:flex-row sm:gap-4"><span className="shrink-0 text-xs text-muted-foreground">{time(row.createdAt)}</span><span className="min-w-0 break-words">{row.message || row.type}</span></div>)}{!overview.data?.events.length && <p className="text-sm text-muted-foreground">{t("暂无数据")}</p>}</CardContent></Card>
    <OperationsMonitorPanel interval={refreshInterval} />
    <Dialog open={confirm !== null} onOpenChange={open => !open && setConfirm(null)}><DialogContent><DialogHeader><DialogTitle>{confirm === "collect" ? t("开启来源采集") : t("补全本地定位")}</DialogTitle><DialogDescription>{confirm === "collect" ? t("将保存入口可见的来源 IP、关联规则和采样字节数，保留 30 天。最多采集每台主机每天 5000 个 IP/规则组合，关闭不影响转发。请确认符合你的隐私政策。") : t("使用内置 IP 库处理当前用户及日期范围内最多 512 个待定位来源，不发送外部请求。内网和库中未知地址不会推测位置。")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(null)}>{t("取消")}</Button><Button onClick={() => { if (confirm === "collect") collection.mutate({ enabled: true }); else resolve.mutate({ ...scopedDates, consent: true, after: geoCursor }); setConfirm(null); }}>{t("确认")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!selectedIp} onOpenChange={open => !open && setSelectedIp("")}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{selectedIp}</DialogTitle><DialogDescription>{t("关联规则与采样流量（最多展示 100 项）")}</DialogDescription></DialogHeader><div className="max-h-[60vh] space-y-3 overflow-y-auto">{details.error && <p className="text-sm text-destructive">{details.error.message}</p>}{details.isLoading && <p>{t("加载中")}</p>}{details.data?.map(row => <div key={`${row.hostId}:${row.ruleId}`} className="rounded-lg border p-3 text-sm"><div className="flex justify-between gap-3"><span>{row.ruleName || `#${row.ruleId}`}</span><span className="shrink-0">{sourceUsage(row)}</span></div><p className="mt-1 text-xs text-muted-foreground">{row.hostName || `#${row.hostId}`} · {row.username || "—"} · {time(row.lastSeen)}</p></div>)}</div></DialogContent></Dialog>
  </div></DashboardLayout>;
}

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { t, getFormatLocale } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList } from "@/components/ui/sliding-tabs";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Activity, ShieldCheck, RefreshCw } from "lucide-react";

const metricNames: Record<string, string> = { cpu: "CPU", memory: "内存", disk: "磁盘" };
const healthNames: Record<string, string> = { unknown: "待检测", healthy: "正常", suspect: "疑似异常", unhealthy: "检测异常", recovering: "恢复观察中" };
const actionNames: Record<string, string> = { pending: "换 IP 请求处理中", uncertain: "换 IP 结果不明确", accepted: "商家接口已接收请求", not_executed: "Agent 未执行请求", succeeded: "商家接口确认成功", sync_skipped: "商家成功，面板地址同步已跳过", sync_failed: "商家成功，面板同步失败" };
const time = (value: unknown) => new Date(Number(value) * 1000).toLocaleString(getFormatLocale(), { timeZone: "Asia/Shanghai" });

export default function OperationsMonitorPanel({ interval }: { interval: number | false }) {
  const [page, setPage] = useState(0), [ipPage, setIpPage] = useState(0);
  const [tab, setTab] = useState("resources");
  const confirm = useConfirmDialog();
  const report = trpc.operations.monitor.useQuery({ page, ipPage }, { refetchInterval: interval, refetchIntervalInBackground: false, refetchOnWindowFocus: false });
  const acknowledge = trpc.hosts.acknowledgeProbeHealthAction.useMutation({ onSuccess: () => { void report.refetch(); toast.success(t("已记录商家结果核对")); }, onError: error => toast.error(error.message) });
  const acknowledgeAction = async (serviceId: number) => {
    if (await confirm({ title: t("核对商家换 IP 结果"), description: t("请先在商家确认上次请求已结束。此操作只解除未知结果保护，不会重发上次请求；当前故障仍不会重复换 IP。"), confirmText: t("已核对，解除保护") })) acknowledge.mutate({ serviceId });
  };
  const pagination = (current: number, total: number, onChange: (page: number) => void) => <div className="flex items-center justify-end gap-2 text-xs"><span>{t("共 {0} 条", [total])}</span><Button size="sm" variant="outline" disabled={current === 0 || report.isFetching} onClick={() => onChange(current - 1)}>{t("上一页")}</Button><Button size="sm" variant="outline" disabled={(current + 1) * 20 >= total || report.isFetching} onClick={() => onChange(current + 1)}>{t("下一页")}</Button></div>;
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-emerald-500" />{t("状态与告警记录")}</CardTitle></CardHeader><CardContent className="space-y-4">
    {report.error && <p role="alert" className="text-sm text-destructive">{report.error.message}</p>}
    <Tabs value={tab} onValueChange={setTab}>
      <SlidingTabsList items={[{ value: "resources", label: t("资源告警"), icon: Activity }, { value: "health", label: t("国内健康检测"), icon: ShieldCheck }, { value: "ip", label: t("IP 更换记录"), icon: RefreshCw }]} activeValue={tab} onValueChange={setTab} />
      {report.data && <>
        <TabsContent value="resources" className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">{report.data.security.map(item => <div key={item.name} className="rounded-lg border p-3"><p className="flex items-center gap-2 text-sm"><ShieldCheck className={`size-4 ${item.status === "ok" ? "text-emerald-500" : "text-amber-500"}`} />{t(item.name)}</p><p className="mt-1 text-xs text-muted-foreground">{t(item.messageTemplate || item.message, item.messageArgs)}</p></div>)}</div>
          <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b text-muted-foreground"><th className="py-2">{t("主机")}</th><th>CPU</th><th>{t("内存")}</th><th>{t("磁盘")}</th><th>{t("采样状态")}</th></tr></thead><tbody>{report.data.resources.map(row => <tr key={row.hostId} className="border-b last:border-0"><td className="max-w-48 truncate py-2">{row.hostName}</td>{[row.cpu, row.memory, row.disk].map((value, index) => <td key={index} className={row.stale ? "text-muted-foreground" : ""}>{value == null ? "—" : `${Number(value).toFixed(1)}%`}</td>)}<td className={row.stale ? "text-amber-500" : "text-muted-foreground"}>{row.stale ? t("采样已过期") : t("最近采样")}</td></tr>)}</tbody></table></div>
          {report.data.active.map(row => <div key={row.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">{row.hostName} · {row.serviceName && <>{row.serviceName} · </>}{t(metricNames[row.metric] || row.metric)} · {row.stale ? t("采样中断，待确认") : row.phase === "recovering" ? t("恢复观察中") : t("持续超限")} · {t("峰值")} {row.peak}%</div>)}
          <div><p className="text-sm font-medium">{t("最近 30 天告警事件")}</p>{report.data.events.map(row => <div key={row.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-xs last:border-0"><span>{row.hostName} · {row.serviceName && <>{row.serviceName} · </>}{t(metricNames[row.metric] || row.metric)} · <span className={row.type === "triggered" ? "text-amber-500" : "text-emerald-500"}>{row.type === "triggered" ? t("持续超限") : t("已恢复")}</span> {row.value}%</span><span className="text-muted-foreground">{time(row.createdAt)}</span></div>)}{!report.data.events.length && <p className="py-3 text-xs text-muted-foreground">{t("暂无数据")}</p>}</div>
          {pagination(page, report.data.total, setPage)}
        </TabsContent>
        <TabsContent value="health" className="space-y-3">
          {report.data.health.map(row => <div key={row.serviceId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"><div className="min-w-0"><p className="truncate">{row.hostName} · {row.name}</p><p className="mt-1 text-xs text-muted-foreground">{row.state?.lastSeen ? time(row.state.lastSeen) : "—"}</p></div><span className={row.state?.phase === "unhealthy" ? "text-amber-500" : "text-muted-foreground"}>{!row.isEnabled ? t("已关闭") : row.state?.stale ? t("采样已过期") : t(healthNames[row.state?.phase || "unknown"] || "待检测")}</span>{row.blockedAction && <Button size="sm" variant="outline" disabled={acknowledge.isPending || Date.now() / 1000 - row.blockedAction.createdAt < 150} onClick={() => acknowledgeAction(row.serviceId)}>{t("已核对商家结果")}</Button>}</div>)}
          {!report.data.health.length && <p className="py-3 text-xs text-muted-foreground">{t("暂无数据")}</p>}
        </TabsContent>
        <TabsContent value="ip" className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("最近 30 天 IP 更换记录")}</p>
          {report.data.ipEvents.map(row => <div key={row.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-xs last:border-0"><div className="min-w-0"><p className="truncate">{row.hostName || "—"} · {row.serviceName || `#${row.serviceId}`}</p><p className="mt-1 text-muted-foreground">{t(actionNames[row.status] || "未知")}{row.newIp ? ` · ${row.newIp}` : ""}</p></div><span className="text-muted-foreground">{time(row.createdAt)}</span></div>)}
          {!report.data.ipEvents.length && <p className="py-3 text-xs text-muted-foreground">{t("暂无数据")}</p>}
          {pagination(ipPage, report.data.ipTotal, setIpPage)}
        </TabsContent>
      </>}
    </Tabs>
  </CardContent></Card>;
}

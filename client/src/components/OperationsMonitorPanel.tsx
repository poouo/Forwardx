import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Activity, Settings2, ShieldCheck } from "lucide-react";
import { defaultOperationsMonitor } from "@shared/operationsMonitor";

const metricNames: Record<string, string> = { cpu: "CPU", memory: "内存", disk: "磁盘" };
export default function OperationsMonitorPanel({ interval }: { interval: number | false }) {
  const [page, setPage] = useState(0), [open, setOpen] = useState(false), [draft, setDraft] = useState(defaultOperationsMonitor);
  const report = trpc.operations.monitor.useQuery({ page }, { refetchInterval: interval, refetchIntervalInBackground: false, refetchOnWindowFocus: false });
  const save = trpc.operations.saveMonitor.useMutation({ onSuccess: () => { setOpen(false); void report.refetch(); toast.success(t("已保存")); }, onError: error => toast.error(error.message) });
  return <Card><CardHeader className="flex-row flex-wrap items-center justify-between gap-2"><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4 text-emerald-500" />{t("资源、安全与告警")}</CardTitle><Button variant="outline" size="sm" disabled={!report.data} onClick={() => { setDraft(report.data?.settings || defaultOperationsMonitor); setOpen(true); }}><Settings2 className="mr-1 size-4" />{t("告警设置")}</Button></CardHeader><CardContent className="space-y-4">
    <p className="text-xs text-muted-foreground">{t("全局主机状态，不受用户与日期筛选影响。安全检查仅检查面板配置，不扫描进程或自动处置。")}</p>
    {report.error && <p role="alert" className="text-sm text-destructive">{report.error.message}</p>}
    {report.data && <><div className="grid gap-3 md:grid-cols-3">{report.data.security.map(item => <div key={item.name} className="rounded-lg border p-3"><p className="flex items-center gap-2 text-sm"><ShieldCheck className={`size-4 ${item.status === "ok" ? "text-emerald-500" : "text-amber-500"}`} />{t(item.name)}</p><p className="mt-1 text-xs text-muted-foreground">{t(item.messageTemplate || item.message, item.messageArgs)}</p></div>)}</div>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b text-muted-foreground"><th className="py-2">{t("主机")}</th><th>CPU</th><th>{t("内存")}</th><th>{t("磁盘")}</th><th>{t("采样状态")}</th></tr></thead><tbody>{report.data.resources.map(row => <tr key={row.hostId} className="border-b last:border-0"><td className="max-w-48 truncate py-2">{row.hostName}</td>{[row.cpu, row.memory, row.disk].map((value, index) => <td key={index} className={row.stale ? "text-muted-foreground" : Number(value) >= 90 ? "text-amber-500" : ""}>{value == null ? "—" : `${Number(value).toFixed(1)}%`}</td>)}<td className={row.stale ? "text-amber-500" : "text-muted-foreground"}>{row.stale ? t("采样已过期") : t("最近采样")}</td></tr>)}</tbody></table></div>
      {!report.data.settings.enabled && <p className="text-xs text-muted-foreground">{t("持续资源告警默认关闭；可在告警设置中开启，阈值设为 0 则不监控该项。")}</p>}
      {report.data.active.map(row => <div key={row.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">{row.hostName} · {t(metricNames[row.metric] || row.metric)} · {row.stale ? t("采样中断，待确认") : row.phase === "recovering" ? t("恢复观察中") : t("持续超限")} · {t("峰值")} {row.peak}%</div>)}
      <div className="space-y-2"><p className="text-sm font-medium">{t("最近 30 天告警事件")}</p>{report.data.events.map(row => <div key={row.id} className="flex flex-wrap justify-between gap-2 border-b py-2 text-xs last:border-0"><span>{row.hostName} · {t(metricNames[row.metric] || row.metric)} · <span className={row.type === "triggered" ? "text-amber-500" : "text-emerald-500"}>{row.type === "triggered" ? t("持续超限") : t("已恢复")}</span> {row.value}%</span><span className="text-muted-foreground">{new Date(Number(row.createdAt) * 1000).toLocaleString()}</span></div>)}{!report.data.events.length && <p className="text-xs text-muted-foreground">{t("暂无数据")}</p>}</div>
      <div className="flex items-center justify-end gap-2 text-xs"><span>{t("共 {0} 条", [report.data.total])}</span><Button size="sm" variant="outline" disabled={page === 0 || report.isFetching} onClick={() => setPage(value => value - 1)}>{t("上一页")}</Button><Button size="sm" variant="outline" disabled={(page + 1) * 20 >= report.data.total || report.isFetching} onClick={() => setPage(value => value + 1)}>{t("下一页")}</Button></div></>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t("资源告警设置")}</DialogTitle><DialogDescription>{t("连续超限后记录并通知；下降 5 个百分点并持续恢复观察时间后才恢复。采样中断不累计时长。更改设置会重新开始观察。")}</DialogDescription></DialogHeader><div className="space-y-4"><Label className="flex justify-between">{t("启用持续资源告警")}<Switch checked={draft.enabled} onCheckedChange={enabled => setDraft(value => ({ ...value, enabled }))} /></Label><Label className="flex justify-between">{t("发送到通知渠道")}<Switch checked={draft.notify} onCheckedChange={notify => setDraft(value => ({ ...value, notify }))} /></Label>
      {(["cpu", "memory", "disk", "durationSeconds", "recoverySeconds"] as const).map(key => <div key={key} className="space-y-1"><Label htmlFor={`monitor-${key}`}>{t(metricNames[key] ? `${metricNames[key]} 阈值 (%)` : key === "durationSeconds" ? "连续超限时长（秒）" : "恢复观察时长（秒）")}</Label><Input id={`monitor-${key}`} type="number" min={key === "durationSeconds" ? 60 : key === "recoverySeconds" ? 30 : 0} max={key === "durationSeconds" ? 3600 : key === "recoverySeconds" ? 600 : 100} value={draft[key]} onChange={event => setDraft(value => ({ ...value, [key]: Number(event.target.value) }))} /></div>)}</div><DialogFooter><Button disabled={save.isPending} onClick={() => save.mutate(draft)}>{t("保存")}</Button></DialogFooter></DialogContent></Dialog>
  </CardContent></Card>;
}

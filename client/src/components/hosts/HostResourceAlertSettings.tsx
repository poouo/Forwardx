import { useState } from "react";
import { BellRing } from "lucide-react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { type OperationsMonitorSettings } from "@shared/operationsMonitor";
import UserSelect from "@/components/UserSelect";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { HintSwitch } from "@/components/ui/hint-switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function ResourceAlertForm({ hostId }: { hostId: number }) {
  const utils = trpc.useUtils();
  const query = trpc.hosts.resourceAlertSettings.useQuery({ hostId }, { refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<OperationsMonitorSettings | null>(null);
  const settings = draft ?? query.data;
  const save = trpc.hosts.saveResourceAlertSettings.useMutation({
    onSuccess: async value => {
      utils.hosts.resourceAlertSettings.setData({ hostId }, value);
      setDraft(null);
      void utils.operations.monitor.invalidate();
      toast.success(t("已保存"));
    },
    onError: error => toast.error(error.message),
  });
  if (query.error) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>;
  if (!settings) return <p className="text-sm text-muted-foreground">{t("加载中")}</p>;
  const patch = (value: Partial<OperationsMonitorSettings>) => setDraft({ ...settings, ...value });
  return <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
    <div className="grid grid-cols-2 gap-3">
      <Label className="flex items-center justify-between gap-2 rounded-lg border p-3">{t("启用持续资源告警")}<HintSwitch checked={settings.enabled} onCheckedChange={enabled => patch({ enabled })} hint={t("仅监控当前主机，阈值为 0 时不监控该项。")} /></Label>
      <Label className="flex items-center justify-between gap-2 rounded-lg border p-3">{t("发送到通知渠道")}<HintSwitch checked={settings.notify} onCheckedChange={notify => patch({ notify })} hint={t("通知管理员及所选用户；关闭后仍记录告警。")} /></Label>
    </div>
    {settings.notify && <UserSelect value={settings.notifyUserId ? String(settings.notifyUserId) : "owner"} specialOptions={[{ value: "owner", label: t("主机所有者") }]} onValueChange={value => patch({ notifyUserId: value === "owner" ? null : Number(value) })} />}
    <div className="grid grid-cols-3 gap-3">{(["cpu", "memory", "disk"] as const).map(metric => <div key={metric} className="min-w-0 space-y-1.5"><Label htmlFor={`resource-${metric}`}>{t(metric === "cpu" ? "CPU 阈值 (%)" : metric === "memory" ? "内存 阈值 (%)" : "磁盘 阈值 (%)")}</Label><Input id={`resource-${metric}`} type="number" min={0} max={100} value={settings[metric]} onChange={event => patch({ [metric]: Number(event.target.value) })} /></div>)}</div>
    <div className="grid grid-cols-2 gap-3">{(["durationSeconds", "recoverySeconds"] as const).map(key => <div key={key} className="min-w-0 space-y-1.5"><Label htmlFor={`resource-${key}`}>{t(key === "durationSeconds" ? "连续超限时长（秒）" : "恢复观察时长（秒）")}</Label><Input id={`resource-${key}`} type="number" min={key === "durationSeconds" ? 60 : 30} max={key === "durationSeconds" ? 3600 : 600} value={settings[key]} onChange={event => patch({ [key]: Number(event.target.value) })} /></div>)}</div>
    <div className="flex justify-end"><Button disabled={save.isPending} onClick={() => save.mutate({ hostId, settings })}>{t("保存")}</Button></div>
  </fieldset>;
}

export default function HostResourceAlertSettings({ hosts }: { hosts: { id: number; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState("");
  return <><Button variant="outline" size="sm" onClick={() => { setHostId(String(hosts[0]?.id || "")); setOpen(true); }}><BellRing className="mr-1.5 size-4 text-amber-500" />{t("资源告警")}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{t("资源告警设置")}</DialogTitle><DialogDescription>{t("连续超限后记录告警，按通知开关发送；恢复后记录恢复事件。")}</DialogDescription></DialogHeader>
      <Select value={hostId} onValueChange={setHostId}><SelectTrigger aria-label={t("主机")}><SelectValue placeholder={t("选择主机")} /></SelectTrigger><SelectContent>{hosts.map(host => <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>)}</SelectContent></Select>
      {hostId ? <ResourceAlertForm key={hostId} hostId={Number(hostId)} /> : <p className="text-sm text-muted-foreground">{t("暂无主机")}</p>}
    </DialogContent></Dialog>
  </>;
}

import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { Button } from "@/components/ui/button";
import TimePicker from "@/components/TimePicker";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OPERATIONS_REPORT_TIME_PATTERN } from "@shared/operationsDailyReport";

export default function OperationsSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("00:00");
  const utils = trpc.useUtils();
  const settings = trpc.operations.reportSettings.useQuery(undefined, { enabled: open, staleTime: 0, refetchOnWindowFocus: false });
  useEffect(() => {
    if (open && settings.data) {
      setEnabled(settings.data.enabled);
      setTime(settings.data.time);
    }
  }, [open, settings.data]);
  const save = trpc.operations.saveReportSettings.useMutation({
    onSuccess: async () => {
      await utils.operations.reportSettings.invalidate();
      toast.success(t("已保存"));
      setOpen(false);
    },
    onError: error => toast.error(error.message),
  });
  const busy = settings.isFetching || save.isPending || !settings.data || !!settings.error;
  return <Dialog open={open} onOpenChange={value => { if (!save.isPending) setOpen(value); }}>
    <DialogTrigger asChild><Button variant="outline"><Settings className="mr-2 size-4" />{t("设置")}</Button></DialogTrigger>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t("运维设置")}</DialogTitle><DialogDescription>{t("通过当前通知渠道向已绑定的管理员发送前一天的全局日报。")}</DialogDescription></DialogHeader>
      <div className="space-y-4 py-2">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <Label htmlFor="operations-daily-report">{t("每日运维日报")}</Label>
          <Switch id="operations-daily-report" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="operations-report-time">{t("发送时间（北京时间）")}</Label>
          <TimePicker id="operations-report-time" value={time} onChange={setTime} disabled={busy || !enabled} />
        </div>
        {settings.data && enabled && (!settings.data.notificationReady || !settings.data.recipientCount) && <p className="text-sm text-amber-600 dark:text-amber-400">{!settings.data.notificationReady ? t("请先在系统设置中启用并配置通知渠道。") : t("尚无管理员绑定当前通知渠道，绑定后才能接收日报。")}</p>}
        {settings.error && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive"><span>{settings.error.message}</span><Button variant="outline" size="sm" onClick={() => void settings.refetch()}>{t("重试")}</Button></div>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>{t("取消")}</Button><Button disabled={busy || !OPERATIONS_REPORT_TIME_PATTERN.test(time)} onClick={() => save.mutate({ enabled, time })}>{save.isPending ? t("保存中...") : t("保存")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

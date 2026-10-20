import { useId, useState } from "react";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function HostTrafficShutdownSetting(props: {
  enabled: boolean;
  percent: number;
  triggered: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onPercentChange: (percent: number) => void;
}) {
  const id = useId();
  const [confirm, setConfirm] = useState(false);
  return <>
    <div className="@container min-h-12 min-w-0 rounded-md bg-muted/35 px-3 py-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @min-[16rem]:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Label htmlFor={id} className="min-w-0 break-words text-sm font-medium">{t("流量耗尽关机")}</Label>
        <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 @min-[16rem]:col-span-1 @min-[16rem]:col-start-2 @min-[16rem]:row-start-1">
          <Label htmlFor={`${id}-threshold`} className="text-xs text-muted-foreground">{t("已用 ≥")}</Label>
          <div className="flex h-8 w-16 shrink-0 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
            <Input id={`${id}-threshold`} aria-label={t("流量耗尽关机阈值")} className="h-8 min-w-0 rounded-none border-0 px-2 text-right focus-visible:ring-0" type="number" min={1} max={100} step={1} value={props.percent} disabled={!props.enabled} onChange={event => props.onPercentChange(Math.min(100, Math.max(1, Math.floor(Number(event.target.value) || 1))))} />
            <span className="flex shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">%</span>
          </div>
        </div>
        <Switch className="col-start-2 row-start-1 @min-[16rem]:col-start-3" id={id} checked={props.enabled} onCheckedChange={enabled => enabled ? setConfirm(true) : props.onEnabledChange(false)} aria-describedby={props.enabled && props.triggered ? `${id}-status` : undefined} />
      </div>
      {props.enabled && props.triggered && <p id={`${id}-status`} className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("本周期已触发，重置流量或关闭保存后重新开启可再次触发。")}</p>}
    </div>
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{t("开启流量耗尽关机？")}</DialogTitle><DialogDescription>{t("保存后，已用流量达到阈值将关闭整台主机，所有服务都会中断，需在服务商控制台手动开机。")}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>{t("取消")}</Button><Button variant="destructive" onClick={() => { props.onEnabledChange(true); setConfirm(false); }}>{t("确认开启")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}

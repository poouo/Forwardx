import { useId } from "react";
import { t } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HintSwitch } from "@/components/ui/hint-switch";

export default function HostReminderSettings(props: {
  channelReady: boolean;
  trafficEnabled: boolean;
  trafficPercent: number;
  renewalEnabled: boolean;
  renewalDays: number;
  onTrafficEnabledChange: (value: boolean) => void;
  onTrafficPercentChange: (value: number) => void;
  onRenewalEnabledChange: (value: boolean) => void;
  onRenewalDaysChange: (value: number) => void;
}) {
  const id = useId();
  const reminders = [
    { key: "traffic", label: t("流量耗尽提醒"), prefix: t("剩余 ≤"), unit: "%", max: 99, value: props.trafficPercent, enabled: props.trafficEnabled, onValue: props.onTrafficPercentChange, onEnabled: props.onTrafficEnabledChange },
    { key: "renewal", label: t("续费提醒"), prefix: t("到期前"), unit: t("天"), max: 365, value: props.renewalDays, enabled: props.renewalEnabled, onValue: props.onRenewalDaysChange, onEnabled: props.onRenewalEnabledChange },
  ];
  return <div className="mt-2.5 grid min-w-0 grid-cols-2 gap-2.5">
      {reminders.map(reminder => <div key={reminder.key} className="min-w-0 space-y-2 rounded-md bg-muted/35 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-${reminder.key}`} className="min-w-0 break-words text-sm font-medium">{reminder.label}</Label>
          <HintSwitch id={`${id}-${reminder.key}`} className="shrink-0" checked={props.channelReady && reminder.enabled} disabled={!props.channelReady} hint={props.channelReady ? reminder.label : t("请先配置通知渠道。")} onCheckedChange={reminder.onEnabled} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={`${id}-${reminder.key}-threshold`} className="shrink-0 text-xs text-muted-foreground">{reminder.prefix}</Label>
          <div className="flex h-8 w-20 shrink-0 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
            <Input id={`${id}-${reminder.key}-threshold`} aria-label={reminder.label} className="h-8 min-w-0 rounded-none border-0 px-2 text-right focus-visible:ring-0" type="number" min={1} max={reminder.max} step={1} value={reminder.value} onChange={event => reminder.onValue(Number(event.target.value))} />
            <span className="flex shrink-0 items-center border-l border-border/60 bg-muted/50 px-1.5 text-sm text-muted-foreground">{reminder.unit}</span>
          </div>
        </div>
      </div>)}
  </div>;
}

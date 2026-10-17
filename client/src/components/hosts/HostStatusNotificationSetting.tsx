import { useId } from "react";
import { t } from "@/i18n";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export default function HostStatusNotificationSetting({ checked, onChange }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="mt-2.5 flex min-h-9 items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">{t("上下线通知")}</Label>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {t("通过系统所选通知渠道发送本主机的上线、离线消息；关闭不影响状态监测和故障转移。")}
        </p>
      </div>
      <Switch id={id} aria-describedby={`${id}-description`} className="shrink-0" checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

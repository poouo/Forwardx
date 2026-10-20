import { useId } from "react";
import { t } from "@/i18n";
import { Label } from "@/components/ui/label";
import { HintSwitch } from "@/components/ui/hint-switch";

export default function HostStatusNotificationSetting({ checked, onChange }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-12 min-w-0 items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="break-words text-sm font-medium">{t("上下线通知")}</Label>
      </div>
      <HintSwitch id={id} hint={t("仅控制通知，不影响监测。")} className="shrink-0" checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

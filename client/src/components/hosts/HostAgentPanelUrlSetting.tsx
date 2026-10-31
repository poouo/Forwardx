import { useId } from "react";
import { t } from "@/i18n";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export default function HostAgentPanelUrlSetting({ enabled, value, onEnabledChange, onChange }: {
  enabled: boolean;
  value: string;
  onEnabledChange: (enabled: boolean) => void;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-2 rounded-md bg-muted/35 px-3 py-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <Label htmlFor={`${id}-enabled`} className="min-w-0 break-words text-sm font-medium">{t("Agent 面板连接地址")}</Label>
        <Switch id={`${id}-enabled`} className="shrink-0" checked={enabled} onCheckedChange={onEnabledChange} />
      </div>
      <Input id={id} type="url" aria-label={t("Agent 面板连接地址")} aria-describedby={`${id}-hint`}
        value={value} disabled={!enabled} maxLength={2048} autoComplete="off" spellCheck={false}
        placeholder="https://panel.example.com:8443"
        className="min-w-0 w-full" onChange={event => onChange(event.target.value)} />
      <p id={`${id}-hint`} className="break-words text-xs leading-relaxed text-muted-foreground">
        {t("关闭时使用全局地址；开启后仅此主机使用该入口，需自行反代至同一面板。")}
      </p>
    </div>
  );
}

import { useId } from "react";
import { t } from "@/i18n";
import { Label } from "@/components/ui/label";
import { OptimisticSwitch } from "@/components/ui/switch";

type Setting = {
  enabled: boolean;
  unavailable: boolean;
  onChange: (enabled: boolean) => Promise<unknown>;
};

export function SupportTicketManagementSettings({ feature, notifications }: { feature: Setting; notifications: Setting }) {
  const id = useId();
  const settings = [
    { key: "feature", title: t("启用工单功能"), description: t("关闭后停用工单提交和处理，保留历史数据。左侧菜单显示在系统设置中单独控制。"), ...feature },
    { key: "notifications", title: t("工单通知总开关"), description: t("通过当前 Telegram/Discord 渠道发送新工单和更新提醒。关闭后停止工单推送，不影响其他通知和个人偏好。"), ...notifications },
  ];
  return <div className="divide-y divide-border/50">
    {settings.map(setting => <div key={setting.key} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={`${id}-${setting.key}`}>{setting.title}</Label>
        <p id={`${id}-${setting.key}-help`} className="text-sm text-muted-foreground">{setting.description}</p>
      </div>
      <OptimisticSwitch id={`${id}-${setting.key}`} aria-describedby={`${id}-${setting.key}-help`} checked={setting.enabled} disabled={setting.unavailable} onCheckedChangeAsync={setting.onChange} />
    </div>)}
  </div>;
}

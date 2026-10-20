import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { OptimisticSwitch } from "@/components/ui/switch";
import { SwitchHint } from "@/components/ui/hint-switch";
import { useId } from "react";

export function NotificationPreferenceRow({ title, description, checked, disabled, onChange }: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => Promise<unknown>;
}) {
  const id = useId();
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/15 p-3">
    <div className="min-w-0">
      <Label htmlFor={id} className="text-sm font-medium leading-snug">{title}</Label>
    </div>
    <SwitchHint hint={description} disabled={disabled}>
      <OptimisticSwitch id={id} className="shrink-0" checked={checked} disabled={disabled} onCheckedChangeAsync={onChange} />
    </SwitchHint>
  </div>;
}

export default function NotificationPreferencesCard() {
  const utils = trpc.useUtils();
  const query = trpc.auth.notificationPreferences.useQuery(undefined, { refetchOnWindowFocus: true });
  const preferences = query.data;
  const update = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.auth.notificationPreferences.invalidate(), utils.auth.me.invalidate(),
        utils.telegram.status.invalidate(), utils.discord.status.invalidate(),
      ]);
      toast.success(t("通知偏好已保存"));
    },
    onError: (error) => toast.error(error.message),
  });
  return <Card className="border-border/50 bg-card/70">
    <CardHeader>
      <CardTitle className="text-base">{t("通知偏好")}</CardTitle>
      <CardDescription>{preferences ? t("当前渠道：{0}", [preferences.channel === "discord" ? "Discord" : "Telegram"]) : t("加载中...")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}</p>}
      <NotificationPreferenceRow title={t("公告通知")}
        description={preferences && (!preferences.active || !preferences.bound) ? t("通知渠道启用并绑定后才能接收推送。") : t("仅在管理员选择推送公告时发送。")}
        checked={!!preferences?.announcementSubscribed} disabled={!preferences?.bound || update.isPending}
        onChange={(enabled) => update.mutateAsync(preferences?.channel === "discord"
          ? { discordAnnouncementSubscribed: enabled } : { telegramAnnouncementSubscribed: enabled })} />
      <NotificationPreferenceRow title={t("工单通知")}
        description={preferences && (!preferences.active || !preferences.bound) ? t("通知渠道启用并绑定后才能接收推送。") : preferences?.supportTicketNotificationsEnabled === false
          ? t("管理员已关闭工单推送，个人偏好仍会保留。") : t("接收与我相关的工单更新。")}
        checked={preferences?.supportTicketNotificationSubscribed ?? true} disabled={!preferences || update.isPending}
        onChange={(enabled) => update.mutateAsync({ supportTicketNotificationSubscribed: enabled })} />
    </CardContent>
  </Card>;
}

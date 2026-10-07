import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export default function DiscordAccountCard() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const [pendingCode, setPendingCode] = useState<{ code: string; expiresAt: Date | string } | null>(null);
  const { data: status } = trpc.discord.status.useQuery(undefined, { refetchInterval: 5000, refetchOnWindowFocus: true });
  useEffect(() => {
    if (status?.bound || (pendingCode && status?.pendingBind?.code === pendingCode.code)) setPendingCode(null);
  }, [status?.bound, status?.pendingBind?.code, pendingCode]);
  const bind = trpc.discord.createBindCode.useMutation({ onSuccess: (value) => { setPendingCode(value); void utils.discord.status.invalidate(); }, onError: (error) => toast.error(error.message) });
  const unbind = trpc.discord.unbind.useMutation({ onSuccess: () => { setPendingCode(null); void utils.discord.status.invalidate(); }, onError: (error) => toast.error(error.message) });
  const subscribe = trpc.discord.subscribe.useMutation({ onSuccess: () => void utils.discord.status.invalidate(), onError: (error) => toast.error(error.message) });
  const code = status?.bound ? null : pendingCode || status?.pendingBind;
  const valid = code && new Date(code.expiresAt).getTime() > Date.now();
  return <Card>
    <CardHeader><CardTitle>{t("Discord 绑定")}</CardTitle><CardDescription>{t("绑定后可接收提醒、查询和管理规则，并使用一次性链接登录。")}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm">{status?.bound ? `${t("已绑定")}：${status.account?.username || status.account?.id}` : t("未绑定")}</p>
      {!status?.enabled && <p className="text-sm text-muted-foreground">{t("管理员尚未启用 Discord 通知渠道。")}</p>}
      {status?.bound ? <>
        <div className="flex items-center justify-between gap-3"><span>{t("公告通知")}</span><Switch checked={!!status.announcementSubscribed} disabled={subscribe.isPending} onCheckedChange={(enabled) => subscribe.mutate({ enabled })} /></div>
        <Button variant="destructive" disabled={unbind.isPending} onClick={async () => {
          if (await confirm({ title: t("解除 Discord 绑定"), description: t("解除后将停止接收 Discord 通知，并使未使用的登录链接失效。") })) unbind.mutate();
        }}>{t("解除绑定")}</Button>
      </> : <>
        {code && <div className="space-y-2 rounded-lg border p-3"><code className="block break-all">/bind {code.code}</code>
          <p className="text-xs text-muted-foreground">{valid ? t("绑定码 5 分钟内有效，请在机器人私聊中发送。") : t("绑定码已过期，请重新生成。")}</p>
          <Button variant="outline" size="sm" disabled={!valid} onClick={async () => { if (await copyTextToClipboard(`/bind ${code.code}`)) toast.success(t("已复制到剪贴板")); else toast.error(t("复制失败，请手动复制")); }}>{t("复制")}</Button>
        </div>}
        <Button disabled={!status?.enabled || bind.isPending} onClick={() => bind.mutate()}>{t("生成绑定码")}</Button>
      </>}
      {status?.botId && <Button variant="outline" asChild><a href={`https://discord.com/users/${status.botId}`} target="_blank" rel="noopener noreferrer">{t("打开机器人")}</a></Button>}
      <p className="text-xs text-muted-foreground">{t("请先加入机器人所在服务器并允许私信。指令和按钮仅在机器人私聊中处理。")}</p>
    </CardContent>
  </Card>;
}

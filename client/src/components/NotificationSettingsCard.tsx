import { useEffect, useState, type ReactNode } from "react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DiscordAccountCard from "./DiscordAccountCard";

export default function NotificationSettingsCard({ telegram }: { telegram: ReactNode }) {
  const utils = trpc.useUtils();
  const { data: settings } = trpc.system.getSettings.useQuery();
  const [channel, setChannel] = useState<"telegram" | "discord">("telegram");
  useEffect(() => { if (settings) setChannel(settings.notificationChannel); }, [settings?.notificationChannel]);
  const update = trpc.system.updateSettings.useMutation({ onSuccess: () => { void utils.system.getSettings.invalidate(); void utils.telegram.status.invalidate(); void utils.discord.status.invalidate(); toast.success(t("通知渠道已保存")); }, onError: (error) => toast.error(error.message) });
  return <div className="space-y-4">
    <Card><CardHeader><CardTitle>{t("通知渠道")}</CardTitle><CardDescription>{t("Telegram 与 Discord 二选一，默认 Telegram。切换保留原配置和绑定，仅所选渠道发送通知和处理交互。")}</CardDescription></CardHeader>
      <CardContent className="responsive-actions flex flex-wrap items-center gap-3"><Select value={channel} onValueChange={(value) => setChannel(value as "telegram" | "discord")}><SelectTrigger className="w-full sm:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="telegram">Telegram</SelectItem><SelectItem value="discord">Discord</SelectItem></SelectContent></Select>
        <Button className="w-full sm:w-auto" disabled={update.isPending || channel === settings?.notificationChannel} onClick={() => update.mutate({ notificationChannel: channel })}>{t("保存通知渠道")}</Button>
      </CardContent></Card>
    {channel === "telegram" ? telegram : <DiscordBotSettings />}
  </div>;
}

function DiscordBotSettings() {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const { data: settings } = trpc.system.getSettings.useQuery();
  const { data: connection } = trpc.discord.status.useQuery(undefined, { refetchInterval: 5000 });
  const discord = settings?.discord;
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [expiry, setExpiry] = useState(false);
  const [traffic, setTraffic] = useState(false);
  const [status, setStatus] = useState(false);
  const [threshold, setThreshold] = useState(20);
  useEffect(() => { if (discord) { setEnabled(discord.enabled); setExpiry(discord.expiryReminder); setTraffic(discord.trafficReminder); setStatus(discord.hostStatusNotify); setThreshold(discord.trafficReminderThreshold); } }, [discord]);
  const update = trpc.system.updateSettings.useMutation({ onSuccess: () => { setToken(""); void utils.system.getSettings.invalidate(); void utils.discord.status.invalidate(); toast.success(t("Discord 配置已保存")); }, onError: (error) => toast.error(error.message) });
  const test = trpc.discord.testSend.useMutation({ onSuccess: () => toast.success(t("测试消息已发送，请查看 Discord 私聊")), onError: (error) => toast.error(error.message) });
  const refresh = trpc.discord.refreshProfile.useMutation({ onSuccess: () => { void utils.system.getSettings.invalidate(); toast.success(t("机器人身份与指令已同步")); }, onError: (error) => toast.error(error.message) });
  return <>
    <Card><CardHeader><CardTitle>Discord Bot</CardTitle><CardDescription>{t("使用 Discord Developer Portal 创建机器人。无需 Webhook 或公开交互回调地址。")}</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="space-y-2"><Label>Bot Token</Label><Input type="password" value={token} disabled={discord?.tokenSource === "env"} placeholder={discord?.tokenMasked || t("输入 Discord Bot Token")} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" /><p className="text-xs text-muted-foreground">{discord?.tokenSource === "env" ? "DISCORD_BOT_TOKEN" : discord?.configured ? t("已配置；留空保留原 Token") : t("未配置")}</p></div>
      <div className="flex items-center justify-between gap-3"><Label className="min-w-0 leading-snug">{t("启用机器人")}</Label><Switch className="shrink-0" checked={enabled} onCheckedChange={setEnabled} /></div>
      <div className="flex items-center justify-between gap-3"><Label className="min-w-0 leading-snug">{t("到期提醒")}</Label><Switch className="shrink-0" checked={expiry} onCheckedChange={setExpiry} /></div>
      <div className="flex items-center justify-between gap-3"><Label className="min-w-0 leading-snug">{t("流量提醒")}</Label><Switch className="shrink-0" checked={traffic} onCheckedChange={setTraffic} /></div>
      <div className="flex items-center justify-between gap-3"><Label className="min-w-0 leading-snug">{t("主机上线/离线通知")}</Label><Switch className="shrink-0" checked={status} onCheckedChange={setStatus} /></div>
      <div className="flex flex-wrap items-center gap-3"><Label>{t("剩余流量阈值")}</Label><div className="flex shrink-0 items-center gap-2"><Input className="w-24" type="number" min={1} max={99} value={threshold} onChange={(event) => setThreshold(Math.min(99, Math.max(1, Number(event.target.value) || 20)))} /><span>%</span></div></div>
      <p className="text-sm text-muted-foreground">{connection?.connected ? t("机器人已连接") : t("机器人未连接；请确认已选择 Discord 并检查 Token")}</p>
      <div className="responsive-actions flex flex-wrap gap-2"><Button disabled={update.isPending} onClick={() => update.mutate({ discord: { enabled, botToken: token.trim() || undefined, expiryReminder: expiry, trafficReminder: traffic, hostStatusNotify: status, trafficReminderThreshold: threshold } })}>{t("保存 Discord 配置")}</Button>
        <Button variant="outline" disabled={!discord?.active || test.isPending} onClick={() => test.mutate()}>{t("测试发送")}</Button>
        <Button variant="outline" disabled={!discord?.configured || refresh.isPending} onClick={() => refresh.mutate()}>{t("校验 Token / 同步指令")}</Button>
        {discord?.tokenSource === "database" && <Button variant="destructive" disabled={update.isPending} onClick={async () => { if (await confirm({ title: t("删除 Discord 机器人"), description: t("删除 Bot Token 并关闭机器人，保留用户绑定。") })) update.mutate({ discord: { enabled: false, clearToken: true } }); }}>{t("删除机器人")}</Button>}
      </div>
      {discord?.botId && <a className="block text-sm text-primary underline" href={`https://discord.com/oauth2/authorize?client_id=${discord.botId}&scope=bot%20applications.commands&permissions=0`} target="_blank" rel="noopener noreferrer">{t("邀请机器人到服务器")}</a>}
      <p className="text-xs text-muted-foreground">{t("加入机器人所在服务器并允许私信；在个人资料生成绑定码，私聊发送 /bind 绑定码。Discord 不支持 Telegram 内嵌网页登录，使用 /login 获取一次性链接。")}</p>
    </CardContent></Card>
    <DiscordAccountCard />
  </>;
}

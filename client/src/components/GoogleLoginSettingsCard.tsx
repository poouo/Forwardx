import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { GOOGLE_CALLBACK_PATH } from "@shared/googleAuth";
import { GoogleMark } from "./GoogleLoginButton";

export default function GoogleLoginSettingsCard() {
  const utils = trpc.useUtils();
  const { data, isPending, error } = trpc.google.settings.useQuery();
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled); setClientId(data.clientId); setSecret("");
    setRedirectUri(data.redirectUri || `${window.location.origin}${GOOGLE_CALLBACK_PATH}`);
  }, [data]);
  const save = trpc.google.saveSettings.useMutation({
    onSuccess: async () => { setSecret(""); toast.success(t("Google 登录配置已保存")); await utils.google.invalidate(); },
    onError: error => toast.error(error.message),
  });
  return <Card>
    <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <CardTitle className="flex items-center gap-2 text-base"><GoogleMark />{t("Google 账户登录")}</CardTitle>
        <CardDescription>{t("配置 Google OAuth Web 客户端，允许用户使用 Google 注册和登录。密码登录保持可用。")}</CardDescription>
      </div>
      <Badge variant={data?.enabled && data.configured ? "default" : "outline"} className="w-fit shrink-0">{data?.enabled && data.configured ? t("已启用") : t("未启用")}</Badge>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{t(error.message)}</p>}
      <div className="flex items-center justify-between gap-4"><Label htmlFor="google-enabled">{t("启用 Google 登录")}</Label><Switch id="google-enabled" checked={enabled} disabled={isPending || save.isPending} onCheckedChange={setEnabled} /></div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-2"><Label htmlFor="google-client-id">Client ID</Label><Input id="google-client-id" autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="123456-example.apps.googleusercontent.com" disabled={isPending || save.isPending} /></div>
        <div className="min-w-0 space-y-2"><Label htmlFor="google-client-secret">Client Secret</Label><Input id="google-client-secret" type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} placeholder={data?.secretConfigured ? t("密钥已保存，留空保持不变") : t("请输入 Google 客户端密钥")} disabled={isPending || save.isPending} /></div>
      </div>
      <div className="space-y-2"><Label htmlFor="google-redirect-uri">{t("授权回调地址")}</Label><Input id="google-redirect-uri" type="url" value={redirectUri} onChange={event => setRedirectUri(event.target.value)} disabled={isPending || save.isPending} />
        <p className="break-words text-xs text-muted-foreground">{t("将此完整地址填写到 Google Cloud 的“已获授权的重定向 URI”。正式部署使用 HTTPS，本机开发可使用 HTTP。请从同一面板域名发起登录。")}</p>
      </div>
      <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
        <p>{t("关闭注册时，仅已绑定 Google 的账户可以登录。新账户仍为普通用户，不自动开通转发权限，并遵守邮箱注册白名单。")}</p>
        <p>{t("已有账户请先使用原方式登录，再到个人中心绑定 Google；不会根据相同邮箱自动合并账户。已有双重验证继续生效。")}</p>
        <p>{t("用户浏览器和面板服务器都需要能访问 Google。本入口用于网页版，移动 App 仍可使用原有登录方式。")}</p>
        <a className="inline-block text-primary underline underline-offset-4" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">{t("打开 Google Cloud 配置客户端")}</a>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={isPending || !!error || save.isPending} onClick={() => save.mutate({ enabled, clientId, clientSecret: secret || undefined, redirectUri })}>{save.isPending ? t("保存中...") : t("保存 Google 登录配置")}</Button>
        {data?.secretConfigured && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => {
          if (window.confirm(t("确定清除 Google 客户端密钥并关闭 Google 登录？密码登录不受影响。"))) save.mutate({ enabled: false, clientId, redirectUri, clearSecret: true });
        }}>{t("清除密钥并关闭")}</Button>}
      </div>
    </CardContent>
  </Card>;
}

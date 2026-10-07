import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toast } from "@/lib/localizedToast";
import { mobileAuth } from "@/lib/mobileAuth";
import { googleAuthMessage } from "@shared/googleAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GoogleMark } from "./GoogleLoginButton";

export default function GoogleAccountCard() {
  const search = useSearch();
  const utils = trpc.useUtils();
  const { data } = trpc.google.status.useQuery();
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const start = trpc.google.start.useMutation({ onSuccess: data => window.location.assign(data.url), onError: error => toast.error(error.message) });
  const unbind = trpc.google.unbind.useMutation({ onSuccess: () => { setPassword(""); toast.success(t("Google 账户已解绑")); void utils.google.status.invalidate(); }, onError: error => toast.error(error.message) });
  const setLoginPassword = trpc.google.setPassword.useMutation({ onSuccess: () => { setNewPassword(""); setConfirmPassword(""); toast.success(t("登录密码已设置")); void utils.google.status.invalidate(); void utils.auth.me.invalidate(); }, onError: error => toast.error(error.message) });
  useEffect(() => {
    const result = new URLSearchParams(search).get("google");
    if (!result) return;
    if (result === "bound") { toast.success(t("Google 账户已绑定")); void utils.google.status.invalidate(); }
    else toast.error(t(googleAuthMessage(result)));
    const url = new URL(window.location.href); url.searchParams.delete("google"); window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [search, utils]);
  if (!data || (!data.enabled && !data.bound)) return null;
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GoogleMark />{t("Google 账户绑定")}</CardTitle><CardDescription>{t("绑定后可使用 Google 登录；仅绑定当前登录账户，不会合并其他账户。")}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {data.bound ? <>
        <p className="break-all text-sm">{data.email}</p>
        {!data.passwordSet ? <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("当前账户通过 Google 注册，尚未设置登录密码。使用 Google 登录后五分钟内可设置密码，设置后才可解绑，避免无法登录。")}</p>
          <div className="space-y-2"><Label htmlFor="google-new-password">{t("新密码")}</Label><Input id="google-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="google-confirm-password">{t("确认新密码")}</Label><Input id="google-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></div>
          <Button type="button" disabled={setLoginPassword.isPending || newPassword.length < 6 || mobileAuth.isNative} onClick={() => {
            if (newPassword !== confirmPassword) { toast.error(t("两次输入的密码不一致")); return; }
            setLoginPassword.mutate({ password: newPassword });
          }}>{t("设置登录密码")}</Button>
        </div> : <div className="space-y-3">
          <div className="space-y-2"><Label htmlFor="google-unbind-password">{t("输入当前密码以解绑 Google")}</Label><Input id="google-unbind-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></div>
          <Button type="button" variant="outline" disabled={!password || unbind.isPending} onClick={() => unbind.mutate({ password })}>{t("解除 Google 绑定")}</Button>
        </div>}
      </> : <Button type="button" variant="outline" className="gap-2" disabled={!data.enabled || start.isPending || mobileAuth.isNative} onClick={() => start.mutate({ bind: true })}><GoogleMark />{t("绑定 Google 账户")}</Button>}
      {mobileAuth.isNative && <p className="text-xs text-muted-foreground">{t("请使用浏览器打开面板进行 Google 登录或绑定。")}</p>}
    </CardContent>
  </Card>;
}

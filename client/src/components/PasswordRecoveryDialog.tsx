import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { trpc } from "@/lib/trpc";
import { takePasswordRecoveryToken } from "@/lib/passwordRecovery";
import { PASSWORD_RECOVERY_REQUEST_MESSAGE, type PasswordRecoveryChannel } from "@shared/passwordRecovery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, Mail, Send } from "lucide-react";

export default function PasswordRecoveryDialog({ open, onOpenChange, defaultIdentifier, onPasswordReset }: {
  open: boolean; onOpenChange: (open: boolean) => void; defaultIdentifier: string; onPasswordReset: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [channel, setChannel] = useState<PasswordRecoveryChannel>("email");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [requested, setRequested] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const options = trpc.auth.passwordRecoveryOptions.useQuery(undefined, { enabled: open && token === null && !done, retry: false });
  const request = trpc.auth.requestPasswordRecovery.useMutation({
    onSuccess: () => { setRequested(true); setError(""); },
    onError: (failure) => setError(failure.message),
  });
  const reset = trpc.auth.resetPasswordWithToken.useMutation({
    onSuccess: () => {
      setDone(true); setNewPassword(""); setConfirmation(""); setToken(null); setError("");
      onPasswordReset();
    },
    onError: (failure) => setError(failure.message),
  });
  useEffect(() => {
    const receive = () => {
      const value = takePasswordRecoveryToken(window.location, window.history);
      if (value === null) return;
      setToken(value); setDone(false); setError(""); onOpenChange(true);
    };
    receive();
    window.addEventListener("hashchange", receive);
    return () => window.removeEventListener("hashchange", receive);
  }, [onOpenChange]);
  useEffect(() => {
    if (open) setIdentifier(defaultIdentifier);
    else { setNewPassword(""); setConfirmation(""); setRequested(false); setDone(false); setError(""); }
  }, [open, defaultIdentifier]);
  useEffect(() => {
    if (options.data && !options.data[channel]) {
      if (options.data.email) setChannel("email");
      else if (options.data.telegram) setChannel("telegram");
    }
  }, [channel, options.data]);
  const pending = request.isPending || reset.isPending;
  const configured = !!options.data?.email || !!options.data?.telegram;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(done ? "密码已重置" : token !== null ? "设置新密码" : "找回密码")}</DialogTitle>
          <DialogDescription>{t(done ? "所有旧登录会话已失效，请使用新密码登录。双重验证设置保持不变。" : token !== null ? "链接在 15 分钟内有效，只能成功使用一次。请设置新的登录密码。" : "通过已验证邮箱或已绑定 Telegram 接收一次性重置链接。未配置找回方式，请联系管理员。")}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-5">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" aria-hidden="true" />
            <Button className="w-full" onClick={() => onOpenChange(false)}>{t("返回登录")}</Button>
          </div>
        ) : token !== null ? (
          <form className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            if (newPassword !== confirmation) { setError(t("两次输入的密码不一致")); return; }
            setError(""); reset.mutate({ token, newPassword });
          }}>
            <div className="space-y-2">
              <Label htmlFor="recovery-password">{t("新密码")}</Label>
              <Input id="recovery-password" type="password" autoComplete="new-password" minLength={6} maxLength={128} required disabled={pending} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t("密码至少6个字符")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recovery-confirmation">{t("确认新密码")}</Label>
              <Input id="recovery-confirmation" type="password" autoComplete="new-password" minLength={6} maxLength={128} required disabled={pending} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
            <Button className="w-full" type="submit" disabled={pending}>{t(pending ? "正在重置..." : "确认重置密码")}</Button>
            <Button className="w-full" type="button" variant="ghost" disabled={pending} onClick={() => { setToken(null); setNewPassword(""); setConfirmation(""); setError(""); }}>{t("重新申请链接")}</Button>
          </form>
        ) : requested ? (
          <div className="space-y-4">
            <p role="status" className="text-sm leading-6">{t(PASSWORD_RECOVERY_REQUEST_MESSAGE)}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("请检查邮箱垃圾邮件或机器人私聊。不要向他人转发重置链接。")}</p>
            <Button className="w-full" variant="outline" onClick={() => onOpenChange(false)}>{t("返回登录")}</Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            if (pending || !options.data?.[channel]) return;
            setError(""); request.mutate({ identifier, channel });
          }}>
            <div className="space-y-2">
              <Label htmlFor="recovery-identifier">{t("用户名或邮箱")}</Label>
              <Input id="recovery-identifier" autoComplete="username" maxLength={254} required disabled={pending} value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
            </div>
            {configured && (
              <fieldset className="space-y-2" disabled={pending}>
                <legend className="mb-2 text-sm font-medium">{t("找回方式")}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([{ key: "email", label: "邮箱", Icon: Mail }, { key: "telegram", label: "Telegram", Icon: Send }] as const).filter((item) => options.data?.[item.key]).map(({ key, label, Icon }) => (
                    <Button type="button" key={key} variant={channel === key ? "secondary" : "outline"} className="gap-2" aria-pressed={channel === key} onClick={() => setChannel(key)}><Icon className="h-4 w-4" />{t(label)}</Button>
                  ))}
                </div>
              </fieldset>
            )}
            {!options.isPending && !configured && !options.error && <p role="status" className="text-sm leading-6 text-muted-foreground">{t("面板未配置可用的找回通道或公开访问地址，请联系管理员。")}</p>}
            {(error || options.error) && <p role="alert" className="text-sm text-destructive">{t(error || "暂时无法获取找回方式，请稍后重试或联系管理员。")}</p>}
            <Button className="w-full" type="submit" disabled={pending || !configured}>{t(pending ? "提交中..." : "发送重置链接")}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, BellRing, KeyRound, Loader2, Mail, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Redirect } from "wouter";

export default function EmailSettings() {
  return <Redirect to="/settings?tab=email" />;
}

export function EmailSettingsContent() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const email = settings?.email;
  const [form, setForm] = useState({
    enabled: false,
    host: "",
    port: 587,
    secure: false,
    user: "",
    password: "",
    from: "",
    verifyRegistration: false,
    whitelistEnabled: false,
    whitelist: "",
    expiryReminder: false,
    trafficReminder: false,
    trafficReminderThreshold: 20,
  });
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    if (!email) return;
    setForm({
      enabled: !!email.enabled,
      host: email.host || "",
      port: Number(email.port || 587),
      secure: !!email.secure,
      user: email.user || "",
      password: "",
      from: email.from || "",
      verifyRegistration: !!email.verifyRegistration,
      whitelistEnabled: !!email.whitelistEnabled,
      whitelist: email.whitelist || "",
      expiryReminder: !!email.expiryReminder,
      trafficReminder: !!email.trafficReminder,
      trafficReminderThreshold: Number(email.trafficReminderThreshold || 20),
    });
  }, [email]);

  const updateSettings = trpc.system.updateSettings.useMutation({
    onSuccess: async () => {
      await utils.system.getSettings.invalidate();
      setForm((prev) => ({ ...prev, password: "" }));
      toast.success("邮箱设置已保存");
    },
    onError: (error) => toast.error(error.message || "保存邮箱设置失败"),
  });

  const sendTestEmail = trpc.system.sendTestEmail.useMutation({
    onSuccess: () => toast.success("测试邮件已发送"),
    onError: (error) => toast.error(error.message || "测试邮件发送失败"),
  });

  const saveEmailSettings = () => {
    if (form.enabled && !form.host.trim()) {
      toast.error("请输入 SMTP 服务器地址");
      return;
    }
    if (form.enabled && !form.from.trim() && !form.user.trim()) {
      toast.error("请输入发件邮箱或 SMTP 用户名");
      return;
    }
    updateSettings.mutate({
      email: {
        enabled: form.enabled,
        host: form.host,
        port: Number(form.port || 587),
        secure: form.secure,
        user: form.user,
        password: form.password,
        from: form.from,
        verifyRegistration: form.verifyRegistration,
        whitelistEnabled: form.whitelistEnabled,
        whitelist: form.whitelist,
        expiryReminder: form.expiryReminder,
        trafficReminder: form.trafficReminder,
        trafficReminderThreshold: Number(form.trafficReminderThreshold || 20),
      },
    });
  };

  const handleTestEmail = () => {
    if (!testTo.trim()) {
      toast.error("请输入测试收件邮箱");
      return;
    }
    sendTestEmail.mutate({ to: testTo.trim() });
  };

  if (isLoading) {
    return (
      <DataSectionLoading label="正在加载邮箱设置" minHeight="min-h-[260px]" />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">邮箱设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">配置验证码和提醒邮件。</p>
        </div>
        <Badge variant={form.enabled ? "outline" : "secondary"} className="w-fit gap-1.5 px-3 py-1.5 text-xs">
          <Mail className="h-3.5 w-3.5" />
          {form.enabled ? "已启用" : "未启用"}
        </Badge>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>按需开启</AlertTitle>
        <AlertDescription>SMTP 总开关关闭时，注册邮箱验证码和提醒邮件都会停止发送；已保存的 SMTP 密码不会回显。</AlertDescription>
      </Alert>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-primary" />
            SMTP 对接
          </CardTitle>
          <CardDescription>配置 SMTP 发信。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 p-3">
            <div>
              <p className="text-sm font-medium">启用邮箱服务</p>
              <p className="text-xs text-muted-foreground">控制邮件发送总开关。</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_120px]">
            <div className="space-y-2">
              <Label>SMTP 服务器</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" />
            </div>
            <div className="space-y-2">
              <Label>端口</Label>
              <Input type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value || 587) })} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>SMTP 用户名</Label>
              <Input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="user@example.com" />
            </div>
            <div className="space-y-2">
              <Label>SMTP 密码 / 授权码</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="留空表示不修改已保存密码" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_180px]">
            <div className="space-y-2">
              <Label>发件邮箱</Label>
              <Input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="ForwardX <noreply@example.com>" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">SSL / SMTPS</p>
                <p className="text-xs text-muted-foreground">常见 465 端口开启。</p>
              </div>
              <Switch checked={form.secure} onCheckedChange={(secure) => setForm({ ...form, secure })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-primary" />
            功能开关
          </CardTitle>
          <CardDescription>按需开启邮件能力。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 p-3">
            <div>
              <p className="text-sm font-medium">强制邮箱验证码注册</p>
              <p className="text-xs text-muted-foreground">注册时验证邮箱。</p>
            </div>
            <Switch checked={form.verifyRegistration} onCheckedChange={(verifyRegistration) => setForm({ ...form, verifyRegistration })} />
          </div>
          <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 md:grid-cols-[1fr_240px]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">邮箱后缀白名单</p>
                <p className="text-xs text-muted-foreground">限制可注册邮箱后缀。</p>
              </div>
              <Switch checked={form.whitelistEnabled} onCheckedChange={(whitelistEnabled) => setForm({ ...form, whitelistEnabled })} />
            </div>
            <div className="space-y-2">
              <Label>允许的邮箱后缀</Label>
              <Input
                value={form.whitelist}
                onChange={(e) => setForm({ ...form, whitelist: e.target.value })}
                placeholder="example.com，gmail.com"
                disabled={!form.whitelistEnabled}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 p-3">
            <div>
              <p className="text-sm font-medium">账户临期提醒</p>
              <p className="text-xs text-muted-foreground">到期前 3 天提醒。</p>
            </div>
            <Switch checked={form.expiryReminder} onCheckedChange={(expiryReminder) => setForm({ ...form, expiryReminder })} />
          </div>
          <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 md:grid-cols-[1fr_180px]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">流量不足提醒</p>
                <p className="text-xs text-muted-foreground">低于阈值时提醒。</p>
              </div>
              <Switch checked={form.trafficReminder} onCheckedChange={(trafficReminder) => setForm({ ...form, trafficReminder })} />
            </div>
            <div className="space-y-2">
              <Label>剩余阈值（%）</Label>
              <Input
                type="number"
                min={1}
                max={99}
                value={form.trafficReminderThreshold}
                onChange={(e) => setForm({ ...form, trafficReminderThreshold: Number(e.target.value || 20) })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            保存与测试
          </CardTitle>
          <CardDescription>保存后可发送测试邮件。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {form.enabled && (!form.host.trim() || (!form.from.trim() && !form.user.trim())) && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>邮箱配置尚未完整</AlertTitle>
              <AlertDescription>启用邮箱服务时至少需要 SMTP 服务器和发件邮箱或用户名。</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={saveEmailSettings} disabled={updateSettings.isPending}>
              {updateSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存邮箱设置
            </Button>
            <div className="flex flex-1 flex-col gap-2 sm:flex-row">
              <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="测试收件邮箱" />
              <Button variant="outline" onClick={handleTestEmail} disabled={sendTestEmail.isPending || !form.enabled}>
                {sendTestEmail.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                发送测试
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

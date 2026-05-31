import { useAuth } from "@/_core/hooks/useAuth";
import { AvatarPicker } from "@/components/AvatarPicker";
import DashboardLayout from "@/components/DashboardLayout";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { migrateLegacyAvatarValue } from "@/lib/avatar";
import { mobileAuth } from "@/lib/mobileAuth";
import { checkMobileAppUpdate, openMobileReleasePage, type MobileAppUpdateResult } from "@/lib/mobileNotifications";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Link2Off,
  Loader2,
  LogOut,
  RefreshCw,
  Send,
  Shield,
  UserRound,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const DISPLAY_NAME_MAX_LENGTH = 24;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("已复制到剪贴板");
  } catch {
    toast.error("复制失败，请手动复制");
  }
}

function ProfileContent() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();
  const [avatarDraft, setAvatarDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [telegramBind, setTelegramBind] = useState<any | null>(null);
  const [telegramBindTick, setTelegramBindTick] = useState(Date.now());
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ setupId: string; secret: string; otpauthUrl: string; expiresAt: Date; expiresInSeconds: number } | null>(null);
  const [twoFactorQrCode, setTwoFactorQrCode] = useState("");
  const [twoFactorSetupTick, setTwoFactorSetupTick] = useState(Date.now());
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [checkingMobileUpdate, setCheckingMobileUpdate] = useState(false);
  const [mobileUpdateInfo, setMobileUpdateInfo] = useState<MobileAppUpdateResult | null>(null);

  const isAdmin = user?.role === "admin";

  const { data: avatarQuota } = trpc.users.avatarQuota.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: telegramStatus } = trpc.telegram.status.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: twoFactorStatus } = trpc.auth.twoFactorStatus.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useEffect(() => {
    if (user) setAvatarDraft(migrateLegacyAvatarValue((user as any).avatar, `user-${user.id}`));
  }, [user?.id, (user as any)?.avatar]);

  useEffect(() => {
    if (user) setDisplayNameDraft(String(user.name || user.username || ""));
  }, [user?.id, user?.name, user?.username]);

  const updateProfileMutation = trpc.auth.updateProfile.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      utils.users.list.invalidate();
      toast.success("显示名称已更新");
    },
    onError: (error) => toast.error(error.message || "显示名称更新失败"),
  });

  const updateAvatarMutation = trpc.users.updateAvatar.useMutation({
    onSuccess: (data) => {
      utils.auth.me.invalidate();
      utils.users.list.invalidate();
      utils.users.avatarQuota.invalidate();
      toast.success(data.quota?.unlimited ? "头像已更新" : `头像已更新，今日剩余 ${data.quota?.remaining ?? 0} 次`);
    },
    onError: (error) => toast.error(error.message || "头像更新失败"),
  });

  const randomAvatarMutation = trpc.users.randomAvatar.useMutation({
    onSuccess: (data) => {
      setAvatarDraft(data.avatar);
      utils.auth.me.invalidate();
      utils.users.list.invalidate();
      utils.users.avatarQuota.invalidate();
      toast.success(data.quota?.unlimited ? "头像已随机更新" : `头像已随机更新，今日剩余 ${data.quota?.remaining ?? 0} 次`);
    },
    onError: (error) => toast.error(error.message || "随机头像失败"),
  });

  const changePasswordMutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      toast.success("密码修改成功");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error) => toast.error(error.message || "密码修改失败"),
  });

  const createTelegramBindMutation = trpc.telegram.createBindCode.useMutation({
    onSuccess: (data) => {
      setTelegramBind(data);
      setTelegramBindTick(Date.now());
      utils.telegram.status.invalidate();
      toast.success("Telegram 绑定码已生成");
    },
    onError: (error) => toast.error(error.message || "生成 Telegram 绑定码失败"),
  });

  const unbindTelegramMutation = trpc.telegram.unbind.useMutation({
    onSuccess: () => {
      setTelegramBind(null);
      utils.telegram.status.invalidate();
      toast.success("Telegram 已解绑");
    },
    onError: (error) => toast.error(error.message || "解绑 Telegram 失败"),
  });

  const beginTwoFactorSetupMutation = trpc.auth.beginTwoFactorSetup.useMutation({
    onSuccess: (data) => {
      setTwoFactorSetup(data);
      setTwoFactorQrCode("");
      setTwoFactorSetupTick(Date.now());
      setTwoFactorPassword("");
      setTwoFactorCode("");
      toast.success("双重验证二维码已生成");
    },
    onError: (error) => toast.error(error.message || "生成双重验证二维码失败"),
  });

  const enableTwoFactorMutation = trpc.auth.enableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已启用");
      setTwoFactorSetup(null);
      setTwoFactorQrCode("");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(error.message || "启用双重验证失败"),
  });

  const disableTwoFactorMutation = trpc.auth.disableTwoFactor.useMutation({
    onSuccess: () => {
      toast.success("双重验证已关闭");
      setTwoFactorPassword("");
      setTwoFactorCode("");
      utils.auth.twoFactorStatus.invalidate();
      utils.auth.me.invalidate();
    },
    onError: (error) => toast.error(error.message || "关闭双重验证失败"),
  });

  useEffect(() => {
    if (!twoFactorSetup?.otpauthUrl) {
      setTwoFactorQrCode("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(twoFactorSetup.otpauthUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
      color: { dark: "#0f172aff", light: "#ffffffff" },
    })
      .then((url) => {
        if (!cancelled) setTwoFactorQrCode(url);
      })
      .catch(() => {
        if (!cancelled) toast.error("二维码生成失败，请使用备用密钥添加");
      });
    return () => {
      cancelled = true;
    };
  }, [twoFactorSetup?.otpauthUrl]);

  useEffect(() => {
    if (twoFactorStatus?.enabled || !twoFactorSetup) return;
    const timer = window.setInterval(() => setTwoFactorSetupTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [twoFactorSetup, twoFactorStatus?.enabled]);

  useEffect(() => {
    if (!telegramBind?.expiresAt) return;
    const timer = window.setInterval(() => setTelegramBindTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [telegramBind?.expiresAt]);

  const avatarQuotaRemaining = avatarQuota?.remaining ?? 3;
  const avatarQuotaUnlimited = !!avatarQuota?.unlimited || user?.role === "admin";
  const avatarQuotaExhausted = !avatarQuotaUnlimited && avatarQuotaRemaining <= 0;
  const avatarBusy = updateAvatarMutation.isPending || randomAvatarMutation.isPending;
  const twoFactorSetupExpiresAt = twoFactorSetup?.expiresAt ? new Date(twoFactorSetup.expiresAt).getTime() : 0;
  const twoFactorSetupRemaining = twoFactorSetupExpiresAt ? Math.max(0, Math.ceil((twoFactorSetupExpiresAt - twoFactorSetupTick) / 1000)) : 0;
  const twoFactorSetupExpired = !!twoFactorSetup && twoFactorSetupRemaining <= 0;
  const twoFactorSetupRemainingLabel = `${Math.floor(twoFactorSetupRemaining / 60)}:${String(twoFactorSetupRemaining % 60).padStart(2, "0")}`;
  const telegramBindExpiresAt = telegramBind?.expiresAt ? new Date(telegramBind.expiresAt).getTime() : 0;
  const telegramBindRemaining = telegramBindExpiresAt ? Math.max(0, Math.ceil((telegramBindExpiresAt - telegramBindTick) / 1000)) : 0;
  const telegramBindExpired = !!telegramBind && telegramBindRemaining <= 0;
  const telegramBindRemainingLabel = `${Math.floor(telegramBindRemaining / 60)}:${String(telegramBindRemaining % 60).padStart(2, "0")}`;
  const telegramBindUrl = telegramBind?.botUsername && telegramBind?.code
    ? `https://t.me/${telegramBind.botUsername}?start=${encodeURIComponent(telegramBind.code)}`
    : "";
  const telegramBotUrl = (telegramBind?.botUsername || telegramStatus?.botUsername)
    ? `https://t.me/${telegramBind?.botUsername || telegramStatus?.botUsername}`
    : "";

  useEffect(() => {
    if (telegramStatus?.bound) {
      if (telegramBind) setTelegramBind(null);
      return;
    }
    if (!telegramBind && telegramStatus?.pendingBind?.code) {
      setTelegramBind(telegramStatus.pendingBind);
      setTelegramBindTick(Date.now());
    }
  }, [telegramBind, telegramStatus?.bound, telegramStatus?.pendingBind]);

  const handleSaveAvatar = () => {
    if (!avatarDraft) {
      toast.error("请选择头像");
      return;
    }
    if (avatarQuotaExhausted) {
      toast.error("今日头像修改次数已用完");
      return;
    }
    updateAvatarMutation.mutate({ avatar: avatarDraft });
  };

  const handleSaveDisplayName = () => {
    const nextName = displayNameDraft.trim();
    if (!nextName) {
      toast.error("显示名称不能为空");
      return;
    }
    if (nextName.length > DISPLAY_NAME_MAX_LENGTH) {
      toast.error(`显示名称最多 ${DISPLAY_NAME_MAX_LENGTH} 个字符`);
      return;
    }
    if (nextName === String(user?.name || user?.username || "")) {
      toast.info("显示名称没有变化");
      return;
    }
    updateProfileMutation.mutate({ name: nextName });
  };

  const handleChangePassword = () => {
    if (!oldPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("新密码至少6个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    changePasswordMutation.mutate({ oldPassword, newPassword });
  };

  const handleEnableTwoFactor = () => {
    if (!twoFactorSetup) {
      beginTwoFactorSetupMutation.mutate();
      return;
    }
    if (twoFactorSetupExpired) {
      toast.error("二维码已过期，请重新生成");
      return;
    }
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    enableTwoFactorMutation.mutate({
      setupId: twoFactorSetup.setupId,
      password: twoFactorPassword,
      code: twoFactorCode,
    });
  };

  const handleDisableTwoFactor = () => {
    if (!twoFactorPassword) {
      toast.error("请输入当前密码");
      return;
    }
    if (twoFactorCode.length < 6) {
      toast.error("请输入 6 位动态验证码");
      return;
    }
    disableTwoFactorMutation.mutate({ password: twoFactorPassword, code: twoFactorCode });
  };

  const handleTelegramBind = () => {
    if (telegramStatus?.configured === false) {
      toast.error("Telegram 机器人尚未配置");
      return;
    }
    createTelegramBindMutation.mutate();
  };

  const handleMobileUpdateCheck = async () => {
    if (!mobileAuth.isNative || checkingMobileUpdate) return;
    try {
      setCheckingMobileUpdate(true);
      const result = await checkMobileAppUpdate({ silent: false });
      setMobileUpdateInfo(result);
      if (result?.hasUpdate) toast.success(`发现 APP 新版本 v${result.latestVersion.replace(/^v/i, "")}`);
      else if (result) toast.success(result.hasApk ? "当前 APP 已是最新版本" : "当前版本暂无 APK 更新");
    } catch (error: any) {
      toast.error(error?.message || "APP 更新检查失败");
    } finally {
      setCheckingMobileUpdate(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">个人资料</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理账号安全、头像和 Telegram。</p>
        </div>
        <Badge variant="outline" className="w-fit gap-1.5 px-3 py-1.5">
          <UserRound className="h-3.5 w-3.5" />
          {isAdmin ? "管理员" : "用户"}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Card className="border-border/50 bg-card/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="h-4 w-4 text-primary" />
                头像与账号
              </CardTitle>
              <CardDescription>低于 50K 的头像会直接上传，较大的图片会自动压缩。</CardDescription>
            </div>
            <UserAvatar user={user as any} className="h-14 w-14" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className={`grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm ${avatarQuotaUnlimited ? "lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]" : "lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(120px,0.5fr)]"}`}>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">账号</p>
                <p className="mt-2 truncate font-medium">{user?.username || "-"}</p>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="profile-display-name" className="text-xs text-muted-foreground">显示名称</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="profile-display-name"
                    value={displayNameDraft}
                    onChange={(e) => setDisplayNameDraft(e.target.value)}
                    maxLength={DISPLAY_NAME_MAX_LENGTH}
                    placeholder={user?.username || "请输入显示名称"}
                    className="h-9 min-w-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0"
                    onClick={handleSaveDisplayName}
                    disabled={updateProfileMutation.isPending}
                  >
                    {updateProfileMutation.isPending ? "保存中..." : "保存"}
                  </Button>
                </div>
              </div>
              {!avatarQuotaUnlimited && (
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">今日剩余</p>
                  <p className="mt-2 truncate font-medium">{avatarQuotaRemaining} / {avatarQuota?.limit ?? 3} 次</p>
                </div>
              )}
            </div>
            <AvatarPicker
              value={avatarDraft}
              onChange={setAvatarDraft}
              fallback={user?.id || user?.username}
              disabled={avatarBusy || avatarQuotaExhausted}
              randomDisabled={avatarQuotaExhausted}
              randomLoading={randomAvatarMutation.isPending}
              onRandom={() => randomAvatarMutation.mutate()}
              onError={(message) => toast.error(message)}
              actions={(
                <Button
                  type="button"
                  size="sm"
                  className="gap-2"
                  onClick={handleSaveAvatar}
                  disabled={avatarBusy || avatarQuotaExhausted}
                >
                  {updateAvatarMutation.isPending ? "保存中..." : "保存头像"}
                </Button>
              )}
            />
            {avatarQuotaExhausted && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                今日头像修改次数已用完，明天可继续修改。
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" />
              登录密码
            </CardTitle>
            <CardDescription>修改当前账号的登录密码。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-old-password">当前密码</Label>
              <Input id="profile-old-password" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} placeholder="请输入当前密码" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-new-password">新密码</Label>
              <Input id="profile-new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="至少 6 个字符" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-confirm-password">确认新密码</Label>
              <Input id="profile-confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再次输入新密码" />
            </div>
            <Button className="w-full" onClick={handleChangePassword} disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending ? "修改中..." : "修改密码"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/50 bg-card/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="h-4 w-4 text-primary" />
                Telegram 绑定
              </CardTitle>
              <CardDescription>绑定后可接收提醒，并支持 Telegram 登录。</CardDescription>
            </div>
            <Badge variant={telegramStatus?.bound ? "default" : "outline"} className="w-fit">
              {telegramStatus?.bound ? "已绑定" : "未绑定"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {telegramStatus?.bound ? (
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_180px]">
                <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Telegram</p>
                    <p className="mt-1 truncate font-medium">
                      {telegramStatus.account?.username ? `@${telegramStatus.account.username}` : telegramStatus.account?.id || "-"}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">绑定时间</p>
                    <p className="mt-1 truncate font-medium">
                      {telegramStatus.account?.linkedAt ? new Date(telegramStatus.account.linkedAt).toLocaleString() : "-"}
                    </p>
                  </div>
                </div>
                <Button variant="outline" className="w-full gap-2 self-end" onClick={() => unbindTelegramMutation.mutate()} disabled={unbindTelegramMutation.isPending}>
                  <Link2Off className="h-4 w-4" />
                  {unbindTelegramMutation.isPending ? "解绑中..." : "解绑 Telegram"}
                </Button>
              </div>
            ) : telegramStatus?.configured === false ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>管理员尚未配置 Telegram 机器人。</span>
              </div>
            ) : telegramBind ? (
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_180px]">
                <div className="space-y-3">
                  {telegramBotUrl && (
                    <Button variant="outline" asChild className="w-full justify-center gap-2 sm:w-auto">
                      <a href={telegramBotUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        打开 Telegram 机器人
                      </a>
                    </Button>
                  )}
                  <div className="flex flex-col gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className={`min-w-0 break-all font-mono text-base font-semibold tracking-widest ${telegramBindExpired ? "text-muted-foreground line-through" : ""}`}>
                          {telegramBind.code}
                        </code>
                        <Badge variant={telegramBindExpired ? "destructive" : "outline"} className="shrink-0">
                          {telegramBindExpired ? "已过期" : `${telegramBindRemainingLabel} 后过期`}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {telegramBindExpired ? "绑定码已过期，请重新生成。" : "5 分钟内有效，可复制备用，也可以直接打开 Telegram 完成绑定。"}
                      </p>
                    </div>
                    <Button variant="outline" size="icon" onClick={() => copyText(telegramBind.code)} title="复制绑定码" disabled={telegramBindExpired}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  {telegramBindUrl && !telegramBindExpired && (
                    <Button asChild className="w-full gap-2 sm:w-auto">
                      <a href={telegramBindUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        打开 Telegram 完成绑定
                      </a>
                    </Button>
                  )}
                </div>
                <Button variant="outline" className="w-full self-end" onClick={handleTelegramBind} disabled={createTelegramBindMutation.isPending}>
                  {createTelegramBindMutation.isPending ? "生成中..." : telegramBindExpired ? "重新生成绑定码" : "重新生成"}
                </Button>
              </div>
            ) : (
              <Button className="w-full gap-2 sm:w-auto" onClick={handleTelegramBind} disabled={createTelegramBindMutation.isPending}>
                <Send className="h-4 w-4" />
                {createTelegramBindMutation.isPending ? "生成中..." : "生成绑定码"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield className="h-4 w-4 text-primary" />
                双因素认证 (2FA)
              </CardTitle>
              <CardDescription>使用 2FA 软件生成动态验证码。</CardDescription>
            </div>
            <Badge variant={twoFactorStatus?.enabled ? "default" : "outline"} className="w-fit">
              {twoFactorStatus?.enabled ? "已启用" : "未启用"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {!twoFactorStatus?.globalEnabled ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>管理员尚未启用双重验证功能。</span>
              </div>
            ) : twoFactorStatus?.enabled ? (
              <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>当前账号已启用双因素认证。</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-disable-password">当前密码</Label>
                      <Input id="profile-2fa-disable-password" type="password" value={twoFactorPassword} onChange={(e) => setTwoFactorPassword(e.target.value)} placeholder="请输入当前密码" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-disable-code">动态验证码</Label>
                      <Input id="profile-2fa-disable-code" inputMode="numeric" maxLength={6} value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" />
                    </div>
                  </div>
                </div>
                <div className="flex items-end">
                  <Button variant="destructive" className="w-full" onClick={handleDisableTwoFactor} disabled={disableTwoFactorMutation.isPending}>
                    {disableTwoFactorMutation.isPending ? "关闭中..." : "关闭双重验证"}
                  </Button>
                </div>
              </div>
            ) : !twoFactorSetup ? (
              <Button className="w-full sm:w-auto" onClick={() => beginTwoFactorSetupMutation.mutate()} disabled={beginTwoFactorSetupMutation.isPending}>
                {beginTwoFactorSetupMutation.isPending ? "生成中..." : "生成绑定二维码"}
              </Button>
            ) : (
              <div className="grid gap-4 2xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex flex-col items-center gap-3">
                  <div className={`flex h-48 w-48 items-center justify-center rounded-lg border bg-white p-3 ${twoFactorSetupExpired ? "opacity-45" : ""}`}>
                    {twoFactorQrCode ? (
                      <img src={twoFactorQrCode} alt="2FA 绑定二维码" className="h-full w-full" />
                    ) : (
                      <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
                    )}
                  </div>
                  <div className={`text-xs ${twoFactorSetupExpired ? "text-destructive" : "text-muted-foreground"}`}>
                    {twoFactorSetupExpired ? "二维码已过期" : `剩余 ${twoFactorSetupRemainingLabel}`}
                  </div>
                </div>
                <div className="space-y-3">
                  {twoFactorSetup.otpauthUrl && (
                    <Button variant="outline" asChild className="w-full gap-2">
                      <a href={twoFactorSetup.otpauthUrl}>
                        <ExternalLink className="h-4 w-4" />
                        打开 2FA 软件添加
                      </a>
                    </Button>
                  )}
                  <div className="space-y-2">
                    <Label>备用密钥</Label>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-md border bg-background px-3 py-2 font-mono text-sm">
                        {twoFactorSetup.secret}
                      </code>
                      <Button variant="outline" size="icon" onClick={() => copyText(twoFactorSetup.secret)} disabled={twoFactorSetupExpired} title="复制备用密钥">
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-enable-password">当前密码</Label>
                      <Input id="profile-2fa-enable-password" type="password" value={twoFactorPassword} onChange={(e) => setTwoFactorPassword(e.target.value)} placeholder="请输入当前密码" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="profile-2fa-enable-code">动态验证码</Label>
                      <Input id="profile-2fa-enable-code" inputMode="numeric" maxLength={6} value={twoFactorCode} onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                    {twoFactorSetupExpired && (
                      <Button variant="outline" onClick={() => beginTwoFactorSetupMutation.mutate()} disabled={beginTwoFactorSetupMutation.isPending}>
                        {beginTwoFactorSetupMutation.isPending ? "生成中..." : "重新生成二维码"}
                      </Button>
                    )}
                    <Button onClick={handleEnableTwoFactor} disabled={enableTwoFactorMutation.isPending || twoFactorSetupExpired}>
                      {enableTwoFactorMutation.isPending ? "启用中..." : "启用双重验证"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {mobileAuth.isNative && (
        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-primary" />
              软件更新
            </CardTitle>
            <CardDescription>检查 Android APP 是否有新版本。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {mobileUpdateInfo && (
              <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">当前版本</p>
                  <p className="mt-1 font-mono">{mobileUpdateInfo.currentVersion ? `v${mobileUpdateInfo.currentVersion.replace(/^v/i, "")}` : "-"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">最新版本</p>
                  <p className="mt-1 font-mono text-primary">{mobileUpdateInfo.latestVersion ? `v${mobileUpdateInfo.latestVersion.replace(/^v/i, "")}` : "-"}</p>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {mobileUpdateInfo?.hasUpdate && (
                <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={() => openMobileReleasePage(mobileUpdateInfo.releaseUrl)}>
                  <ExternalLink className="h-4 w-4" />
                  前往下载
                </Button>
              )}
              <Button className="w-full gap-2 sm:w-auto" onClick={handleMobileUpdateCheck} disabled={checkingMobileUpdate}>
                {checkingMobileUpdate ? <RefreshCw className="forwardx-icon-spin h-4 w-4" /> : <Download className="h-4 w-4" />}
                {checkingMobileUpdate ? "检查中..." : "检查 APP 更新"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/50 bg-card/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LogOut className="h-4 w-4 text-primary" />
              退出登录
            </CardTitle>
            <CardDescription>结束当前浏览器或 APP 的登录会话。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" className="w-full gap-2 sm:w-auto" onClick={logout}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function Profile() {
  return (
    <DashboardLayout>
      <ProfileContent />
    </DashboardLayout>
  );
}

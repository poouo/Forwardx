import { useAuth } from "@/_core/hooks/useAuth";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
  SidebarGroup,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { useTheme } from "@/contexts/ThemeContext";
import {
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Server,
  ArrowRightLeft,
  Users,
  Settings,
  Shield,
  Network,
  KeyRound,
  UserRound,
  Sun,
  Moon,
  Rocket,
  Route,
  Zap,
  CreditCard,
  WalletCards,
  ReceiptText,
  Package,
  ShoppingBag,
  Megaphone,
  Mail,
  Send,
  Copy,
  Link2Off,
  Coins,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Download,
  RefreshCw,
  ExternalLink,
  Image,
  type LucideIcon,
} from "lucide-react";
import { App as CapacitorApp } from "@capacitor/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { renderMixedHtml } from "@/lib/htmlContent";
import { mobileAuth } from "@/lib/mobileAuth";
import { checkMobileAppUpdate, openMobileReleasePage, type MobileAppUpdateResult } from "@/lib/mobileNotifications";
import { cn } from "@/lib/utils";
import { PANEL_UPGRADE_REFRESH_DELAY_MS, PANEL_UPGRADE_REFRESH_DELAY_SECONDS } from "@/lib/panelUpgrade";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AvatarPicker } from "@/components/AvatarPicker";
import { UserAvatar } from "@/components/UserAvatar";

const announcementsMenuItem = { icon: Megaphone, label: "公告", path: "/announcements" };
const TWO_FACTOR_SETUP_SECONDS = 5 * 60;
type SidebarNavItem = { icon: LucideIcon; label: string; path: string };

const mainMenuItems: SidebarNavItem[] = [
  { icon: LayoutDashboard, label: "仪表盘", path: "/" },
  { icon: Server, label: "主机管理", path: "/hosts" },
  { icon: Route, label: "隧道管理", path: "/tunnels" },
  { icon: ArrowRightLeft, label: "转发规则", path: "/rules" },
  { icon: Network, label: "转发组", path: "/forward-groups" },
];
const profileMenuItem: SidebarNavItem = { icon: UserRound, label: "个人资料", path: "/profile" };

const adminMenuItems: SidebarNavItem[] = [
  { icon: CreditCard, label: "支付对接", path: "/payments" },
  { icon: WalletCards, label: "账单与兑换", path: "/billing" },
  { icon: Coins, label: "流量计费管理", path: "/traffic-billing" },
  { icon: Package, label: "套餐管理", path: "/plans" },
  { icon: Users, label: "用户管理", path: "/users" },
  { icon: Mail, label: "邮箱设置", path: "/email-settings" },
  { icon: Settings, label: "系统设置", path: "/settings" },
];

const PANEL_UPGRADE_SESSION_KEY = "forwardx.panel.upgrade";
const MOBILE_APP_UPDATE_SESSION_KEY = "forwardx.mobile.updateNotice";

function getLayoutUpgradeProgress(job: any) {
  const status = job?.status || "idle";
  const logs = Array.isArray(job?.logs) ? job.logs.join("\n") : "";
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const steps = [
    { label: "准备升级", done: status !== "idle" && matched([/开始升级/i, /start/i]) },
    {
      label: "拉取与准备依赖",
      done: matched([
        /Cloning into/i,
        /git (fetch|pull|checkout)/i,
        /load metadata/i,
        /load build context/i,
        /pnpm install/i,
        /npm install/i,
        /downloaded/i,
        /Lockfile is up to date/i,
      ]),
    },
    { label: "构建新版本", done: matched([/pnpm build/i, /vite .*building/i, /modules transformed/i, /Server build complete/i, /exporting layers/i]) },
    { label: "重启服务", done: matched([/Container .* (Creating|Created|Starting|Started)/i, /docker compose up/i, /systemctl restart/i, /已启动/i, /recreate/i]) },
  ];

  if (status === "success") {
    return { percent: 100, label: "升级完成，正在等待面板恢复", steps: steps.map((step) => ({ ...step, done: true, active: false })) };
  }
  if (status === "error") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    return { percent: Math.max(10, doneCount * 22), label: "升级异常", steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  if (status === "running") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    return { percent: Math.min(92, Math.max(12, doneCount * 22 + 8)), label: steps[activeIndex]?.label || "正在升级", steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  return { percent: 0, label: "等待确认升级", steps: steps.map((step) => ({ ...step, active: false })) };
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading, user } = useAuth();

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    return <DashboardLayoutSkeleton />;
  }

  return (
    <SidebarProvider>
      <DashboardLayoutContent>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

function DashboardLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar, isMobile, openMobile, setOpenMobile } = useSidebar();
  const openMobileRef = useRef(openMobile);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuOpenRef = useRef(accountMenuOpen);
  const isCollapsed = state === "collapsed";
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { resolvedTheme, setTheme } = useTheme();
  const { data: updateInfo } = trpc.system.checkUpdate.useQuery(undefined, {
    enabled: isAdmin,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60 * 1000,
  });
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery(undefined, {
    enabled: !!user && !isAdmin,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: popupAnnouncement } = trpc.announcements.popup.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: telegramStatus } = trpc.telegram.status.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (!status || status.bound) return false;
      const expiresAt = status.pendingBind?.expiresAt ? new Date(status.pendingBind.expiresAt).getTime() : 0;
      return expiresAt > Date.now() ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const siteTitle = (publicInfo?.siteTitle || "ForwardX").trim() || "ForwardX";
  const logoSrc = publicInfo?.siteLogoDataUrl || (resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png");
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoMark = logoLoadFailed ? (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <Zap className="h-4 w-4" />
    </div>
  ) : (
    <img
      src={logoSrc}
      alt={siteTitle}
      className="h-7 w-7 shrink-0 object-contain"
      onError={() => setLogoLoadFailed(true)}
    />
  );
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showTelegramDialog, setShowTelegramDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [checkingMobileUpdate, setCheckingMobileUpdate] = useState(false);
  const [mobileUpdateInfo, setMobileUpdateInfo] = useState<MobileAppUpdateResult | null>(null);
  const [showMobileUpdateDialog, setShowMobileUpdateDialog] = useState(false);
  const upgradeRefreshTimerRef = useRef<number | null>(null);
  const upgradeRefreshIntervalRef = useRef<number | null>(null);
  const [upgradeRefreshScheduled, setUpgradeRefreshScheduled] = useState(false);
  const [upgradeRefreshCountdown, setUpgradeRefreshCountdown] = useState<number | null>(null);
  const [backgroundUpgrade, setBackgroundUpgrade] = useState<{ targetVersion: string; startedAt: number } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(PANEL_UPGRADE_SESSION_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value?.targetVersion || !value?.startedAt) return null;
      return value;
    } catch {
      return null;
    }
  });
  const [telegramBind, setTelegramBind] = useState<any | null>(null);
  const [telegramBindTick, setTelegramBindTick] = useState(Date.now());
  const [showTwoFactorDialog, setShowTwoFactorDialog] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ setupId: string; secret: string; otpauthUrl: string; expiresAt: Date; expiresInSeconds: number } | null>(null);
  const [twoFactorQrCode, setTwoFactorQrCode] = useState("");
  const [twoFactorSetupTick, setTwoFactorSetupTick] = useState(Date.now());
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const { data: upgradeStatus, refetch: refetchUpgradeStatus } = trpc.system.upgradeStatus.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.job?.status;
      return status === "running" || backgroundUpgrade ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: (data) => {
      const targetVersion = data?.targetVersion || upgradeTargetVersion || "";
      if (targetVersion) {
        const next = { targetVersion, startedAt: Date.now() };
        setBackgroundUpgrade(next);
        try {
          window.sessionStorage.setItem(PANEL_UPGRADE_SESSION_KEY, JSON.stringify(next));
        } catch {
          // Session persistence is only used to keep the upgrade notice visible after a temporary reconnect.
        }
      }
      setShowUpgradeDialog(false);
      toast.success("升级任务已在后台执行");
      refetchUpgradeStatus();
    },
    onError: (error) => toast.error(error.message || "启动升级失败"),
  });

  const scheduleUpgradeRefresh = useCallback(() => {
    if (upgradeRefreshTimerRef.current !== null) return;
    try {
      window.sessionStorage.removeItem(PANEL_UPGRADE_SESSION_KEY);
    } catch {
      // Ignore storage failures.
    }
    setUpgradeRefreshScheduled(true);
    setUpgradeRefreshCountdown(PANEL_UPGRADE_REFRESH_DELAY_SECONDS);
    upgradeRefreshIntervalRef.current = window.setInterval(() => {
      setUpgradeRefreshCountdown((value) => (value === null ? null : Math.max(0, value - 1)));
    }, 1000);
    upgradeRefreshTimerRef.current = window.setTimeout(() => {
      if (upgradeRefreshIntervalRef.current !== null) {
        window.clearInterval(upgradeRefreshIntervalRef.current);
        upgradeRefreshIntervalRef.current = null;
      }
      window.location.reload();
    }, PANEL_UPGRADE_REFRESH_DELAY_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (upgradeRefreshTimerRef.current !== null) {
        window.clearTimeout(upgradeRefreshTimerRef.current);
      }
      if (upgradeRefreshIntervalRef.current !== null) {
        window.clearInterval(upgradeRefreshIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (popupAnnouncement?.id) setShowAnnouncement(true);
  }, [popupAnnouncement?.id]);

  useEffect(() => {
    setLogoLoadFailed(false);
  }, [logoSrc]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = siteTitle;
    }
  }, [siteTitle]);

  useEffect(() => {
    if (upgradeStatus?.job?.status !== "running" || backgroundUpgrade) return;
    const targetVersion = upgradeStatus.job.targetVersion;
    if (!targetVersion) return;
    const next = {
      targetVersion,
      startedAt: upgradeStatus.job.startedAt ? new Date(upgradeStatus.job.startedAt).getTime() : Date.now(),
    };
    setBackgroundUpgrade(next);
    try {
      window.sessionStorage.setItem(PANEL_UPGRADE_SESSION_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  }, [backgroundUpgrade, upgradeStatus?.job?.startedAt, upgradeStatus?.job?.status, upgradeStatus?.job?.targetVersion]);

  useEffect(() => {
    if (upgradeStatus?.job?.status !== "success") return;
    scheduleUpgradeRefresh();
  }, [scheduleUpgradeRefresh, upgradeStatus?.job?.status]);

  useEffect(() => {
    if (!backgroundUpgrade?.targetVersion || !upgradeStatus?.currentVersion) return;
    if (upgradeStatus.job?.status === "running" || upgradeStatus.job?.status === "error") return;
    const currentVersion = String(upgradeStatus.currentVersion).replace(/^v/i, "");
    const targetVersion = String(backgroundUpgrade.targetVersion).replace(/^v/i, "");
    if (currentVersion !== targetVersion) return;
    scheduleUpgradeRefresh();
  }, [backgroundUpgrade?.targetVersion, scheduleUpgradeRefresh, upgradeStatus?.currentVersion, upgradeStatus?.job?.status]);

  const dismissAnnouncement = trpc.announcements.dismiss.useMutation({
    onSuccess: () => {
      setShowAnnouncement(false);
      utils.announcements.popup.invalidate();
    },
  });

  // Change password dialog state
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showAvatarDialog, setShowAvatarDialog] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const changePasswordMutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      toast.success("密码修改成功");
      setShowChangePassword(false);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (error) => {
      toast.error(error.message || "密码修改失败");
    },
  });

  const updateAvatarMutation = trpc.users.updateAvatar.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      utils.users.list.invalidate();
      toast.success("头像已更新");
      setShowAvatarDialog(false);
    },
    onError: (error) => toast.error(error.message || "头像更新失败"),
  });

  const openAvatarDialog = () => {
    setAvatarDraft(String((user as any)?.avatar || ""));
    setShowAvatarDialog(true);
    setAccountMenuOpen(false);
  };

  const handleSaveAvatar = () => {
    if (!avatarDraft) {
      toast.error("请选择头像");
      return;
    }
    updateAvatarMutation.mutate({ avatar: avatarDraft });
  };

  const createTelegramBindMutation = trpc.telegram.createBindCode.useMutation({
    onSuccess: (data) => {
      setTelegramBind(data);
      setTelegramBindTick(Date.now());
      setShowTelegramDialog(true);
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
      setShowTelegramDialog(false);
    },
    onError: (error) => toast.error(error.message || "解绑 Telegram 失败"),
  });

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

  const copyText = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    if (copied) toast.success("已复制到剪贴板");
    else toast.error("复制失败，请长按或手动选中复制");
  };

  const openTelegramDialog = () => {
    if (telegramStatus?.bound) {
      setShowTelegramDialog(true);
      return;
    }
    if (telegramStatus?.configured === false) {
      setTelegramBind(null);
      setShowTelegramDialog(true);
      return;
    }
    createTelegramBindMutation.mutate();
  };

  const { data: twoFactorStatus } = trpc.auth.twoFactorStatus.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const beginTwoFactorSetupMutation = trpc.auth.beginTwoFactorSetup.useMutation({
    onSuccess: (data) => {
      setTwoFactorSetup(data);
      setTwoFactorQrCode("");
      setTwoFactorSetupTick(Date.now());
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
      color: {
        dark: "#0f172aff",
        light: "#ffffffff",
      },
    })
      .then((url) => {
        if (!cancelled) setTwoFactorQrCode(url);
      })
      .catch(() => {
        if (!cancelled) {
          setTwoFactorQrCode("");
          toast.error("二维码生成失败，请使用手动密钥添加");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [twoFactorSetup?.otpauthUrl]);

  useEffect(() => {
    if (!showTwoFactorDialog || twoFactorStatus?.enabled || !twoFactorSetup) return;
    const timer = window.setInterval(() => setTwoFactorSetupTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showTwoFactorDialog, twoFactorSetup, twoFactorStatus?.enabled]);

  useEffect(() => {
    if (!telegramBind?.expiresAt) return;
    const timer = window.setInterval(() => setTelegramBindTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [telegramBind?.expiresAt]);

  const twoFactorSetupExpiresAt = twoFactorSetup?.expiresAt ? new Date(twoFactorSetup.expiresAt).getTime() : 0;
  const twoFactorSetupRemaining = twoFactorSetupExpiresAt ? Math.max(0, Math.ceil((twoFactorSetupExpiresAt - twoFactorSetupTick) / 1000)) : 0;
  const twoFactorSetupExpired = !!twoFactorSetup && twoFactorSetupRemaining <= 0;
  const twoFactorSetupRemainingLabel = `${Math.floor(twoFactorSetupRemaining / 60)}:${String(twoFactorSetupRemaining % 60).padStart(2, "0")}`;
  const telegramBindExpiresAt = telegramBind?.expiresAt ? new Date(telegramBind.expiresAt).getTime() : 0;
  const telegramBindRemaining = telegramBindExpiresAt ? Math.max(0, Math.ceil((telegramBindExpiresAt - telegramBindTick) / 1000)) : 0;
  const telegramBindExpired = !!telegramBind && telegramBindRemaining <= 0;
  const telegramBindRemainingLabel = `${Math.floor(telegramBindRemaining / 60)}:${String(telegramBindRemaining % 60).padStart(2, "0")}`;

  const openTwoFactorDialog = () => {
    setShowTwoFactorDialog(true);
    setTwoFactorPassword("");
    setTwoFactorCode("");
    setTwoFactorQrCode("");
    if (!twoFactorStatus?.enabled && twoFactorStatus?.globalEnabled) {
      beginTwoFactorSetupMutation.mutate();
    }
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
    disableTwoFactorMutation.mutate({
      password: twoFactorPassword,
      code: twoFactorCode,
    });
  };

  const handleMobileUpdateCheck = async () => {
    if (!mobileAuth.isNative || checkingMobileUpdate) return;
    try {
      setCheckingMobileUpdate(true);
      const result = await checkMobileAppUpdate({ silent: false });
      setMobileUpdateInfo(result);
      if (result?.hasUpdate) {
        try {
          window.sessionStorage.setItem(MOBILE_APP_UPDATE_SESSION_KEY, result.latestVersion);
        } catch {
          // Ignore storage failures.
        }
        setShowMobileUpdateDialog(true);
      } else if (result) {
        toast.success(result.hasApk ? "当前 APP 已是最新版本" : "当前版本暂无 APK 更新");
      }
    } catch (error: any) {
      toast.error(error?.message || "APP 更新检查失败");
    } finally {
      setCheckingMobileUpdate(false);
    }
  };

  const openDetectedMobileRelease = () => {
    void openMobileReleasePage(mobileUpdateInfo?.releaseUrl);
    setShowMobileUpdateDialog(false);
  };

  const telegramBindUrl = telegramBind?.botUsername && telegramBind?.code
    ? `https://t.me/${telegramBind.botUsername}?start=${encodeURIComponent(telegramBind.code)}`
    : "";
  const telegramBotUrl = (telegramBind?.botUsername || telegramStatus?.botUsername)
    ? `https://t.me/${telegramBind?.botUsername || telegramStatus?.botUsername}`
    : "";
  const accountDisplayName = String(user?.name || "").trim() || String(user?.username || "").trim() || "账号";
  const accountUsername = String(user?.username || "").trim() || accountDisplayName;

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

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const visibleMainMenuItems = isAdmin
    ? mainMenuItems
    : mainMenuItems.filter((item) => !["/hosts", "/tunnels", "/forward-groups"].includes(item.path));
  const userStoreMenuItems = !isAdmin
    ? [
        { icon: Package, label: "我的订阅", path: "/subscriptions" },
        { icon: ReceiptText, label: "账单中心", path: "/wallet" },
        ...(storeStatus?.enabled ? [{ icon: ShoppingBag, label: "商店", path: "/store" }] : []),
      ]
    : [];

  const allMenuItems = isAdmin
    ? [...visibleMainMenuItems, announcementsMenuItem, profileMenuItem, ...adminMenuItems]
    : [...visibleMainMenuItems, ...userStoreMenuItems, announcementsMenuItem, profileMenuItem];

  const activeMenuItem = allMenuItems.find((item) => item.path === location);
  const upgradeJob = upgradeStatus?.job;
  const displayUpgradeJob = useMemo(() => {
    if (upgradeRefreshScheduled) {
      return {
        status: "success",
        startedAt: upgradeJob?.startedAt || (backgroundUpgrade?.startedAt ? new Date(backgroundUpgrade.startedAt).toISOString() : null),
        finishedAt: upgradeJob?.finishedAt || new Date().toISOString(),
        targetVersion: upgradeJob?.targetVersion || backgroundUpgrade?.targetVersion || upgradeStatus?.currentVersion || "",
        logs: upgradeJob?.logs || ["[ForwardX] Upgrade completed; browser refresh scheduled"],
        error: null,
      };
    }
    if (upgradeJob?.status && upgradeJob.status !== "idle") return upgradeJob;
    if (!backgroundUpgrade) return upgradeJob;
    return {
      status: "running",
      startedAt: new Date(backgroundUpgrade.startedAt).toISOString(),
      finishedAt: null,
      targetVersion: backgroundUpgrade.targetVersion,
      logs: ["[ForwardX] Starting upgrade in background"],
      error: null,
    };
  }, [backgroundUpgrade, upgradeJob, upgradeRefreshScheduled, upgradeStatus?.currentVersion]);
  const upgradeProgress = getLayoutUpgradeProgress(displayUpgradeJob);
  const upgradeTargetVersion = updateInfo?.latestVersion || upgradeStatus?.update?.latestVersion || displayUpgradeJob?.targetVersion || "";
  const upgradeRefreshText = upgradeRefreshCountdown !== null
    ? (upgradeRefreshCountdown > 0 ? `${upgradeRefreshCountdown} 秒后自动刷新` : "正在刷新页面")
    : "系统恢复后将自动刷新";
  const hasPanelUpdate = isAdmin && !!updateInfo?.hasUpdate && !!upgradeTargetVersion;
  const showUpgradeNotice = isAdmin && (
    hasPanelUpdate ||
    displayUpgradeJob?.status === "running" ||
    displayUpgradeJob?.status === "success" ||
    displayUpgradeJob?.status === "error"
  );
  const managementMenuItems: SidebarNavItem[] = isAdmin ? [profileMenuItem, ...adminMenuItems] : [profileMenuItem];
  const navigateFromSidebar = (path: string) => {
    setLocation(path);
    if (isMobile) {
      setAccountMenuOpen(false);
      setOpenMobile(false);
    }
  };
  const navigateFromAccountMenu = (path: string) => {
    setAccountMenuOpen(false);
    window.requestAnimationFrame(() => navigateFromSidebar(path));
  };
  const openPanelUpdateFromAccountMenu = async () => {
    if (!isAdmin) return;
    setAccountMenuOpen(false);
    if (
      hasPanelUpdate ||
      displayUpgradeJob?.status === "running" ||
      displayUpgradeJob?.status === "success" ||
      displayUpgradeJob?.status === "error"
    ) {
      setShowUpgradeDialog(true);
      refetchUpgradeStatus();
      return;
    }
    try {
      const latestInfo = await utils.system.checkUpdate.fetch({ force: true });
      await refetchUpgradeStatus();
      if (latestInfo?.hasUpdate) {
        setShowUpgradeDialog(true);
      } else {
        toast.success("当前已是最新版本");
      }
    } catch (error: any) {
      toast.error(error?.message || "检查更新失败");
    }
  };
  const renderSidebarItems = (items: SidebarNavItem[]) => items.map((item) => {
    const isActive = location === item.path;
    return (
      <SidebarMenuItem key={item.path}>
        <SidebarMenuButton
          isActive={isActive}
          onClick={() => navigateFromSidebar(item.path)}
          tooltip={item.label}
          className={cn("h-10 transition-all font-normal mobile-sidebar-menu-button", mobileAuth.isNative && "text-[13px]")}
        >
          <item.icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />
          <span>{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  });

  useEffect(() => {
    openMobileRef.current = openMobile;
  }, [openMobile]);

  useEffect(() => {
    accountMenuOpenRef.current = accountMenuOpen;
  }, [accountMenuOpen]);

  useEffect(() => {
    if (isMobile && !openMobile) setAccountMenuOpen(false);
  }, [isMobile, openMobile]);

  useEffect(() => {
    if (!mobileAuth.isNative || !isMobile) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;
    CapacitorApp.addListener("backButton", (event) => {
      if (accountMenuOpenRef.current || openMobileRef.current) {
        setAccountMenuOpen(false);
        setOpenMobile(false);
        return;
      }
      if (event.canGoBack) {
        window.history.back();
        return;
      }
      void CapacitorApp.minimizeApp();
    })
      .then((handle) => {
        if (disposed) {
          handle.remove();
          return;
        }
        removeListener = () => handle.remove();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [isMobile, setOpenMobile]);

  return (
    <>
      <Sidebar collapsible="icon" className="border-r border-sidebar-border/60 bg-sidebar/75 backdrop-blur-2xl">
        <SidebarHeader className="h-16 justify-center mobile-sidebar-header">
          <div className="flex items-center gap-3 px-2 transition-all w-full">
            {!isCollapsed ? (
              <div className="flex items-center justify-between flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {logoMark}
                  <span className="font-bold tracking-tight truncate text-base">
                    {siteTitle}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={toggleTheme}
                    className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                    aria-label="Toggle theme"
                    title={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
                  >
                    {resolvedTheme === "dark" ? (
                      <Sun className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Moon className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  <button
                    onClick={toggleSidebar}
                    className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                    aria-label="Toggle navigation"
                  >
                    <PanelLeft className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={toggleSidebar}
                className="h-9 w-9 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Toggle navigation"
                title={siteTitle}
              >
                {logoMark}
              </button>
            )}
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-1 mobile-sidebar-content">
          <SidebarGroup className={cn("pb-2 mobile-sidebar-group", mobileAuth.isNative && "pb-1.5")}>
            <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider">
              主菜单
            </SidebarGroupLabel>
            <SidebarMenu className="px-2 py-1 mobile-sidebar-menu">
              {renderSidebarItems([...visibleMainMenuItems, ...userStoreMenuItems, announcementsMenuItem])}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup className={cn("mt-1 pt-2 mobile-sidebar-group mobile-sidebar-admin-group", !mobileAuth.isNative && "border-t border-sidebar-border/50", mobileAuth.isNative && "mt-0 pt-2 border-t border-sidebar-border/50")}>
            <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider">
              管理
            </SidebarGroupLabel>
            <SidebarMenu className="px-2 py-1 mobile-sidebar-menu">
              {renderSidebarItems(managementMenuItems)}
            </SidebarMenu>
          </SidebarGroup>

          {/* Theme toggle for collapsed sidebar */}
          {isCollapsed && (
            <SidebarGroup>
              <SidebarMenu className="px-2">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={toggleTheme}
                    tooltip={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
                    className="h-10"
                  >
                    {resolvedTheme === "dark" ? (
                      <Sun className="h-4 w-4" />
                    ) : (
                      <Moon className="h-4 w-4" />
                    )}
                    <span>{resolvedTheme === "dark" ? "白天模式" : "黑夜模式"}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter className="p-3 mobile-sidebar-footer">
          {showUpgradeNotice && (
            <button
              type="button"
              onClick={() => {
                setShowUpgradeDialog(true);
                refetchUpgradeStatus();
              }}
              className="w-full rounded-lg border border-primary/20 bg-primary/10 px-3 py-2.5 text-left text-primary shadow-sm transition-colors hover:bg-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
              title={
                displayUpgradeJob?.status === "running"
                  ? upgradeProgress.label
                  : displayUpgradeJob?.status === "success"
                    ? upgradeRefreshText
                    : displayUpgradeJob?.status === "error"
                      ? "升级失败"
                      : `发现新版本 ${upgradeTargetVersion}`
              }
            >
              <div className="flex items-center gap-2">
                {displayUpgradeJob?.status === "running" ? (
                  <Loader2 className="forwardx-icon-spin h-4 w-4 shrink-0" />
                ) : displayUpgradeJob?.status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : displayUpgradeJob?.status === "error" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <Rocket className="h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-xs font-semibold">
                    {displayUpgradeJob?.status === "running"
                      ? "正在升级"
                      : displayUpgradeJob?.status === "success"
                        ? "升级完成，正在重启"
                        : displayUpgradeJob?.status === "error"
                          ? "升级失败"
                          : "发现新版本"}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-primary/75">
                    {displayUpgradeJob?.status === "running"
                      ? upgradeProgress.label
                      : displayUpgradeJob?.status === "success"
                        ? upgradeRefreshText
                        : displayUpgradeJob?.status === "error"
                          ? (displayUpgradeJob.error || "点击查看详情")
                          : `可升级到 ${upgradeTargetVersion}`}
                  </p>
                  {displayUpgradeJob?.status === "running" && (
                    <div className="mt-2 space-y-2">
                      <Progress value={upgradeProgress.percent} className="h-1" />
                      <div className="space-y-1">
                        {upgradeProgress.steps.map((step) => (
                          <div key={step.label} className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-primary/75">
                            {step.done ? (
                              <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                            ) : step.active ? (
                              <Loader2 className="forwardx-icon-spin h-3 w-3 shrink-0" />
                            ) : (
                              <span className="h-3 w-3 shrink-0 rounded-full border border-primary/25" />
                            )}
                            <span className="truncate">{step.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </button>
          )}
          <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen} modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/35 px-2 py-2.5 text-left transition-colors hover:bg-accent/50 w-full group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={accountDisplayName}
              >
                <UserAvatar user={user as any} className="h-9 w-9 shrink-0" />
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium leading-5">{accountDisplayName}</p>
                  <p className="mt-1 truncate text-xs leading-4 text-muted-foreground">
                    {isAdmin ? "管理员" : "用户"} · {telegramStatus?.bound ? "TG 已绑定" : "TG 未绑定"}
                  </p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 py-1.5">
                <div className="flex items-start gap-2">
                  <UserAvatar user={user as any} className="h-8 w-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{accountDisplayName}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{isAdmin ? "管理员" : "普通用户"} · {accountUsername}</p>
                  </div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigateFromAccountMenu("/profile")}
                className="cursor-pointer"
              >
                <UserRound className="mr-2 h-4 w-4" />
                <span>个人资料</span>
              </DropdownMenuItem>
              {!mobileAuth.isNative && isAdmin && (
                <DropdownMenuItem
                  onClick={openPanelUpdateFromAccountMenu}
                  className="cursor-pointer"
                >
                  <Download className="mr-2 h-4 w-4" />
                  <span>软件更新</span>
                </DropdownMenuItem>
              )}
              {mobileAuth.isNative && (
                <DropdownMenuItem
                  onClick={handleMobileUpdateCheck}
                  disabled={checkingMobileUpdate}
                  className="cursor-pointer"
                >
                  {checkingMobileUpdate ? (
                    <RefreshCw className="forwardx-icon-spin mr-2 h-4 w-4" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  <span>{checkingMobileUpdate ? "检查中..." : "软件更新"}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={logout}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                <span>退出登录</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        {isMobile && (
          <div data-mobile-header="true" className="glass-surface flex border-b h-14 items-center justify-between px-2 sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? siteTitle}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={toggleTheme}
              className="h-9 w-9 flex items-center justify-center hover:bg-accent rounded-lg transition-colors"
              aria-label="Toggle theme"
            >
              {resolvedTheme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
          </div>
        )}
        <main data-mobile-main="true" className="flex-1 p-3 sm:p-6">
          <div key={location} className="route-content-enter">
            {children}
          </div>
        </main>
        <footer className="pb-4 text-center text-xs text-muted-foreground">
          <div className="inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <a
              href={publicInfo?.repoUrl || "https://github.com/poouo/Forwardx"}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              项目地址
            </a>
            <span className="text-muted-foreground/45">|</span>
            <a
              href={publicInfo?.telegramBotUrl || "https://t.me/miyin_private_bot"}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              联系TG
            </a>
            <span className="text-muted-foreground/45">|</span>
            <a
              href="https://t.me/ForwardX_panel"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              TG群组
            </a>
          </div>
        </footer>
      </SidebarInset>

      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] overflow-x-hidden sm:max-w-xl">
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            发现新版本
          </DialogTitle>
          <DialogDescription>
            后台升级，完成后自动重启。
          </DialogDescription>
          {(() => {
            const job = displayUpgradeJob;
            const progress = upgradeProgress;
            const isRunning = job?.status === "running";
            const isSuccess = job?.status === "success";
            const isError = job?.status === "error";
            const targetVersion = upgradeTargetVersion || "-";
            const currentVersion = upgradeStatus?.currentVersion || updateInfo?.currentVersion || "-";
            return (
              <div className="min-w-0 space-y-4 overflow-x-hidden py-2">
                <div className="grid gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">当前版本</p>
                    <p className="mt-1 break-all font-mono">v{currentVersion}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">目标版本</p>
                    <p className="mt-1 break-all font-mono">{String(targetVersion).startsWith("v") ? targetVersion : `v${targetVersion}`}</p>
                  </div>
                </div>

                {upgradeStatus?.upgradeEnabled === false && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    当前环境未配置自动升级命令，无法在面板内一键升级。
                  </div>
                )}

                {(isRunning || isSuccess || isError) && (
                  <div className="space-y-3 rounded-lg border border-border/40 bg-background/60 p-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium">{progress.label}</span>
                      <span className="text-xs text-muted-foreground">{progress.percent}%</span>
                    </div>
                    <Progress value={progress.percent} className="h-2" />
                    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                      {progress.steps.map((step) => (
                        <div key={step.label} className="flex min-w-0 items-center gap-2 text-xs">
                          {step.done ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          ) : step.active ? (
                            <Loader2 className="forwardx-icon-spin h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                          )}
                          <span className={step.done || step.active ? "truncate text-foreground" : "truncate text-muted-foreground"}>{step.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      升级失败
                    </div>
                    <p className="mt-1 text-xs">{job?.error || "升级命令执行失败，请到系统设置查看日志。"}</p>
                  </div>
                )}

                {isSuccess && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    升级任务已完成，面板正在重启。{upgradeRefreshText}。
                  </div>
                )}

              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => setShowUpgradeDialog(false)}>
              {displayUpgradeJob?.status === "running" ? "后台执行" : "取消"}
            </Button>
            <Button
              className="w-full gap-2 sm:w-auto"
              disabled={
                !upgradeTargetVersion ||
                upgradeStatus?.upgradeEnabled === false ||
                displayUpgradeJob?.status === "running" ||
                displayUpgradeJob?.status === "success" ||
                startUpgradeMutation.isPending
              }
              onClick={() => upgradeTargetVersion && startUpgradeMutation.mutate({ targetVersion: upgradeTargetVersion })}
            >
              {startUpgradeMutation.isPending || displayUpgradeJob?.status === "running" ? (
                <Loader2 className="forwardx-icon-spin h-4 w-4" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {displayUpgradeJob?.status === "running" ? "升级中..." : "确认升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMobileUpdateDialog} onOpenChange={setShowMobileUpdateDialog}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[420px] overflow-hidden rounded-xl border-border/60 bg-background p-0 shadow-2xl">
          <div className="border-b border-border/40 bg-primary/10 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Download className="h-5 w-5 text-primary" />
              发现 APP 新版本
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs">
              前往下载新版 APK。
            </DialogDescription>
          </div>
          <div className="space-y-3 px-5 py-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-border/40 bg-muted/25 p-3">
                <p className="text-xs text-muted-foreground">当前版本</p>
                <p className="mt-1 font-mono">{mobileUpdateInfo?.currentVersion ? `v${mobileUpdateInfo.currentVersion.replace(/^v/i, "")}` : "-"}</p>
              </div>
              <div className="rounded-lg border border-primary/25 bg-primary/10 p-3">
                <p className="text-xs text-muted-foreground">最新版本</p>
                <p className="mt-1 font-mono text-primary">{mobileUpdateInfo?.latestVersion ? `v${mobileUpdateInfo.latestVersion.replace(/^v/i, "")}` : "-"}</p>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 border-t border-border/40 px-5 py-4">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setShowMobileUpdateDialog(false)}>
              稍后再说
            </Button>
            <Button className="w-full gap-2 sm:w-auto" onClick={openDetectedMobileRelease}>
              <ExternalLink className="h-4 w-4" />
              前往下载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Password Dialog */}
      <Dialog open={showChangePassword} onOpenChange={setShowChangePassword}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>请输入当前密码和新密码</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="old-password">当前密码</Label>
              <Input
                id="old-password"
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="请输入当前密码"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="请输入新密码（至少6个字符）"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">确认新密码</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="请再次输入新密码"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowChangePassword(false)}>
              取消
            </Button>
            <Button
              onClick={handleChangePassword}
              disabled={changePasswordMutation.isPending}
            >
              {changePasswordMutation.isPending ? "修改中..." : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAvatarDialog} onOpenChange={setShowAvatarDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>头像设置</DialogTitle>
          <DialogDescription>选择预设头像或上传自定义头像。</DialogDescription>
          <AvatarPicker
            value={avatarDraft}
            onChange={setAvatarDraft}
            fallback={user?.id || user?.username}
            disabled={updateAvatarMutation.isPending}
            onError={(message) => toast.error(message)}
            className="py-2"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAvatarDialog(false)} disabled={updateAvatarMutation.isPending}>
              取消
            </Button>
            <Button onClick={handleSaveAvatar} disabled={updateAvatarMutation.isPending}>
              {updateAvatarMutation.isPending ? "保存中..." : "保存头像"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showTwoFactorDialog} onOpenChange={setShowTwoFactorDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            双重验证
          </DialogTitle>
          <DialogDescription>使用 2FA 软件生成动态验证码。</DialogDescription>
          {!twoFactorStatus?.globalEnabled ? (
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
              管理员尚未启用双重验证功能。
            </div>
          ) : twoFactorStatus?.enabled ? (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                当前账户已启用双重验证。
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-disable-password">当前密码</Label>
                <Input
                  id="two-factor-disable-password"
                  type="password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  placeholder="请输入当前密码"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-disable-code">动态验证码</Label>
                <Input
                  id="two-factor-disable-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="请输入 6 位验证码"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                扫码添加，{Math.round((twoFactorSetup?.expiresInSeconds || TWO_FACTOR_SETUP_SECONDS) / 60)} 分钟内有效。
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className={`flex h-48 w-48 items-center justify-center rounded-lg border bg-white p-3 ${twoFactorSetupExpired ? "opacity-45" : ""}`}>
                  {beginTwoFactorSetupMutation.isPending ? (
                    <Loader2 className="forwardx-icon-spin h-6 w-6 text-slate-500" />
                  ) : twoFactorQrCode ? (
                    <img src={twoFactorQrCode} alt="2FA 绑定二维码" className="h-full w-full" />
                  ) : (
                    <span className="text-xs text-slate-500">二维码生成中</span>
                  )}
                </div>
                <div className={`text-xs ${twoFactorSetupExpired ? "text-destructive" : "text-muted-foreground"}`}>
                  {twoFactorSetup
                    ? twoFactorSetupExpired
                      ? "二维码已过期，请重新生成"
                      : `剩余 ${twoFactorSetupRemainingLabel}`
                    : "正在生成二维码"}
                </div>
              </div>
              {twoFactorSetup?.otpauthUrl && (
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
                    {twoFactorSetup?.secret || "正在生成..."}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => twoFactorSetup?.secret && copyText(twoFactorSetup.secret)}
                    disabled={!twoFactorSetup?.secret || twoFactorSetupExpired}
                    title="复制备用密钥"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-enable-password">当前密码</Label>
                <Input
                  id="two-factor-enable-password"
                  type="password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  placeholder="请输入当前密码"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-enable-code">动态验证码</Label>
                <Input
                  id="two-factor-enable-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="请输入 6 位验证码"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowTwoFactorDialog(false)}>
              关闭
            </Button>
            {twoFactorStatus?.globalEnabled && twoFactorStatus?.enabled ? (
              <Button
                variant="destructive"
                onClick={handleDisableTwoFactor}
                disabled={disableTwoFactorMutation.isPending}
              >
                {disableTwoFactorMutation.isPending ? "关闭中..." : "关闭双重验证"}
              </Button>
            ) : twoFactorStatus?.globalEnabled ? (
              <>
                {twoFactorSetupExpired && (
                  <Button
                    variant="outline"
                    onClick={() => beginTwoFactorSetupMutation.mutate()}
                    disabled={beginTwoFactorSetupMutation.isPending}
                  >
                    {beginTwoFactorSetupMutation.isPending ? "生成中..." : "重新生成二维码"}
                  </Button>
                )}
                <Button
                  onClick={handleEnableTwoFactor}
                  disabled={beginTwoFactorSetupMutation.isPending || enableTwoFactorMutation.isPending || twoFactorSetupExpired}
                >
                  {enableTwoFactorMutation.isPending ? "启用中..." : "启用双重验证"}
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showTelegramDialog} onOpenChange={setShowTelegramDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-sky-500" />
            Telegram 绑定
          </DialogTitle>
          <DialogDescription>绑定后可用 Telegram 登录和查询。</DialogDescription>
          <div className="space-y-4 py-2">
            {telegramStatus?.bound ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  {telegramStatus.account?.username ? `@${telegramStatus.account.username}` : telegramStatus.account?.id}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  绑定时间：{telegramStatus.account?.linkedAt ? new Date(telegramStatus.account.linkedAt).toLocaleString() : "-"}
                </p>
              </div>
            ) : telegramBind ? (
              <div className="space-y-3">
                {telegramBotUrl && (
                  <a
                    href={telegramBotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-lg border border-sky-500/25 bg-sky-500/10 p-3 text-sm text-sky-700 transition-colors hover:bg-sky-500/15 dark:text-sky-300"
                  >
                    <span>
                      当前机器人：<b>@{telegramBind.botUsername || telegramStatus?.botUsername}</b>
                    </span>
                    <Send className="h-4 w-4" />
                  </a>
                )}
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <p className="text-xs text-muted-foreground">绑定码</p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className={`break-all font-mono text-lg font-semibold tracking-widest ${telegramBindExpired ? "text-muted-foreground line-through" : ""}`}>
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
                    <Button variant="outline" size="icon" onClick={() => copyText(telegramBind.code)} disabled={telegramBindExpired}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  打开 Telegram 点 Start，或发送 <code>/bind {telegramBind.code}</code>。
                </p>
                {telegramBindUrl && !telegramBindExpired && (
                  <Button variant="outline" asChild className="w-full gap-2">
                    <a href={telegramBindUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4" />
                      打开 Telegram 完成绑定
                    </a>
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {telegramBotUrl && (
                  <a
                    href={telegramBotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-lg border border-sky-500/25 bg-sky-500/10 p-3 text-sm text-sky-700 transition-colors hover:bg-sky-500/15 dark:text-sky-300"
                  >
                    <span>
                      当前机器人：<b>@{telegramStatus?.botUsername}</b>
                    </span>
                    <Send className="h-4 w-4" />
                  </a>
                )}
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                  {telegramStatus?.configured ? "先生成绑定码。" : "Telegram 尚未配置。"}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            {telegramStatus?.bound ? (
              <>
                {telegramBotUrl && (
                  <Button variant="outline" asChild className="gap-2">
                    <a href={telegramBotUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4" />
                      打开机器人
                    </a>
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="gap-2"
                  onClick={() => unbindTelegramMutation.mutate()}
                  disabled={unbindTelegramMutation.isPending}
                >
                  <Link2Off className="h-4 w-4" />
                  解除绑定
                </Button>
              </>
            ) : (
              <Button
                onClick={() => createTelegramBindMutation.mutate()}
                disabled={createTelegramBindMutation.isPending || telegramStatus?.configured === false}
              >
                {createTelegramBindMutation.isPending ? "生成中..." : telegramBindExpired ? "重新生成绑定码" : "生成绑定码"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAnnouncement} onOpenChange={(open) => {
        if (!open && popupAnnouncement?.id) dismissAnnouncement.mutate({ id: popupAnnouncement.id });
        setShowAnnouncement(open);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            {popupAnnouncement?.title || "公告"}
          </DialogTitle>
          <DialogDescription>关闭后可在公告中查看。</DialogDescription>
          <div
            className="max-h-[50svh] overflow-y-auto rounded-lg border bg-background/45 p-4 text-sm leading-6"
            dangerouslySetInnerHTML={{ __html: renderMixedHtml(popupAnnouncement?.content || "") }}
          />
          <DialogFooter>
            <Button onClick={() => popupAnnouncement?.id && dismissAnnouncement.mutate({ id: popupAnnouncement.id })}>我知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

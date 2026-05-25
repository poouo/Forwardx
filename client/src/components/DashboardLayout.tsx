import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { useIsMobile } from "@/hooks/useMobile";
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
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { renderMixedHtml } from "@/lib/htmlContent";

const announcementsMenuItem = { icon: Megaphone, label: "公告", path: "/announcements" };

const mainMenuItems = [
  { icon: LayoutDashboard, label: "仪表盘", path: "/" },
  { icon: Server, label: "主机管理", path: "/hosts" },
  { icon: Route, label: "隧道管理", path: "/tunnels" },
  { icon: ArrowRightLeft, label: "转发规则", path: "/rules" },
  { icon: Network, label: "转发组", path: "/forward-groups" },
];

const adminMenuItems = [
  { icon: CreditCard, label: "支付对接", path: "/payments" },
  { icon: WalletCards, label: "账单与兑换", path: "/billing" },
  { icon: Coins, label: "流量计费管理", path: "/traffic-billing" },
  { icon: Package, label: "套餐管理", path: "/plans" },
  { icon: Users, label: "用户管理", path: "/users" },
  { icon: Mail, label: "邮箱设置", path: "/email-settings" },
  { icon: Settings, label: "系统设置", path: "/settings" },
];

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
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const isMobile = useIsMobile();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const { resolvedTheme, setTheme } = useTheme();
  const logoSrc = resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png";
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const logoMark = logoLoadFailed ? (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <Zap className="h-4 w-4" />
    </div>
  ) : (
    <img
      src={logoSrc}
      alt="ForwardX"
      className="h-7 w-7 shrink-0 object-contain"
      onError={() => setLogoLoadFailed(true)}
    />
  );
  const { data: updateInfo } = trpc.system.checkUpdate.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
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
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    enabled: !!user,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showTelegramDialog, setShowTelegramDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [upgradeRefreshScheduled, setUpgradeRefreshScheduled] = useState(false);
  const [telegramBind, setTelegramBind] = useState<any | null>(null);
  const { data: upgradeStatus, refetch: refetchUpgradeStatus } = trpc.system.upgradeStatus.useQuery(undefined, {
    enabled: isAdmin && showUpgradeDialog,
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.job?.status;
      return status === "running" ? 2000 : false;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: () => {
      toast.success("升级任务已启动");
      refetchUpgradeStatus();
    },
    onError: (error) => toast.error(error.message || "启动升级失败"),
  });

  useEffect(() => {
    if (popupAnnouncement?.id) setShowAnnouncement(true);
  }, [popupAnnouncement?.id]);

  useEffect(() => {
    if (!showUpgradeDialog) return;
    if (upgradeStatus?.job?.status !== "success") return;
    if (upgradeRefreshScheduled) return;
    setUpgradeRefreshScheduled(true);
    const timer = window.setTimeout(() => {
      window.location.reload();
    }, 3500);
    return () => window.clearTimeout(timer);
  }, [showUpgradeDialog, upgradeRefreshScheduled, upgradeStatus?.job?.status]);

  const dismissAnnouncement = trpc.announcements.dismiss.useMutation({
    onSuccess: () => {
      setShowAnnouncement(false);
      utils.announcements.popup.invalidate();
    },
  });

  // Change password dialog state
  const [showChangePassword, setShowChangePassword] = useState(false);
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

  const createTelegramBindMutation = trpc.telegram.createBindCode.useMutation({
    onSuccess: (data) => {
      setTelegramBind(data);
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
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("已复制到剪贴板");
        return;
      } catch (error) {
        console.warn("[Clipboard] navigator.clipboard failed, fallback to execCommand:", error);
      }
    }

    const host =
      (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) ||
      document.body;
    const textarea = document.createElement("textarea");
    let copied = false;
    try {
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      textarea.style.left = "0";
      textarea.style.top = "0";
      textarea.style.width = "1px";
      textarea.style.height = "1px";
      host.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = document.execCommand("copy");
    } catch (error) {
      console.warn("[Clipboard] execCommand fallback failed:", error);
      copied = false;
    } finally {
      if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    }

    if (copied) {
      toast.success("已复制到剪贴板");
      return;
    }

    try {
      window.prompt("复制失败，请手动选中并复制：", text);
      toast.warning("未能自动写入剪贴板，已弹出手动复制窗口");
    } catch {
      toast.error("复制失败，请手动复制");
    }
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

  const telegramBindUrl = telegramBind?.botUsername && telegramBind?.code
    ? `https://t.me/${telegramBind.botUsername}?start=${encodeURIComponent(telegramBind.code)}`
    : "";
  const telegramBotUrl = (telegramBind?.botUsername || telegramStatus?.botUsername)
    ? `https://t.me/${telegramBind?.botUsername || telegramStatus?.botUsername}`
    : "";

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const visibleMainMenuItems = isAdmin
    ? mainMenuItems
    : mainMenuItems.filter((item) => item.path !== "/hosts" && item.path !== "/tunnels");
  const userStoreMenuItems = !isAdmin
    ? [
        { icon: ReceiptText, label: "账单中心", path: "/wallet" },
        ...(storeStatus?.enabled ? [{ icon: ShoppingBag, label: "商店", path: "/store" }] : []),
      ]
    : [];

  const allMenuItems = isAdmin
    ? [...visibleMainMenuItems, announcementsMenuItem, ...adminMenuItems]
    : [...visibleMainMenuItems, ...userStoreMenuItems, announcementsMenuItem];

  const activeMenuItem = allMenuItems.find((item) => item.path === location);

  return (
    <>
      <Sidebar collapsible="icon" className="border-r border-sidebar-border/60 bg-sidebar/75 backdrop-blur-2xl">
        <SidebarHeader className="h-16 justify-center">
          <div className="flex items-center gap-3 px-2 transition-all w-full">
            {!isCollapsed ? (
              <div className="flex items-center justify-between flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {logoMark}
                  <span className="font-bold tracking-tight truncate text-base">
                    ForwardX
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
                title="ForwardX"
              >
                {logoMark}
              </button>
            )}
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-0">
          <SidebarGroup>
            <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider">
              主菜单
            </SidebarGroupLabel>
            <SidebarMenu className="px-2 py-1">
              {[...visibleMainMenuItems, ...userStoreMenuItems, announcementsMenuItem].map((item) => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="h-10 transition-all font-normal"
                    >
                      <item.icon
                        className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                      />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>

          {isAdmin && (
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                管理
              </SidebarGroupLabel>
              <SidebarMenu className="px-2 py-1">
                {adminMenuItems.map((item) => {
                  const isActive = location === item.path;
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        isActive={isActive}
                        onClick={() => setLocation(item.path)}
                        tooltip={item.label}
                        className="h-10 transition-all font-normal"
                      >
                        <item.icon
                          className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                        />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          )}

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

        <SidebarFooter className="p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 rounded-lg border border-border/40 bg-background/35 px-2 py-2 text-left transition-colors hover:bg-accent/50 w-full group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={user?.name || user?.username || "账号菜单"}
              >
                <Avatar className="h-9 w-9 border shrink-0">
                  <AvatarFallback className="text-xs font-medium bg-primary/10 text-primary">
                    {user?.username?.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium leading-none">账号菜单</p>
                  <p className="mt-1.5 truncate text-xs text-muted-foreground">
                    {isAdmin ? "管理员" : "用户"} · {telegramStatus?.bound ? "TG 已绑定" : "TG 未绑定"}
                  </p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="px-2 py-1.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{user?.username}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{isAdmin ? "管理员" : "普通用户"}</p>
                  </div>
                </div>
              </div>
              <DropdownMenuSeparator />
              {isAdmin && updateInfo?.hasUpdate && (
                <DropdownMenuItem
                  onClick={() => {
                    setShowUpgradeDialog(true);
                    refetchUpgradeStatus();
                  }}
                  className="cursor-pointer text-primary focus:text-primary"
                >
                  <Rocket className="mr-2 h-4 w-4" />
                  <span>发现新版本 {updateInfo.latestVersion}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setShowChangePassword(true)}
                className="cursor-pointer"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                <span>修改密码</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={openTelegramDialog}
                className="cursor-pointer"
              >
                <Send className="mr-2 h-4 w-4" />
                <span>{telegramStatus?.bound ? "Telegram 已绑定" : "绑定 Telegram"}</span>
              </DropdownMenuItem>
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
          <div className="glass-surface flex border-b h-14 items-center justify-between px-2 sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "ForwardX"}
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
        <main className="flex-1 p-3 sm:p-6">{children}</main>
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
          </div>
        </footer>
      </SidebarInset>

      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            发现新版本
          </DialogTitle>
          <DialogDescription>
            升级会在后台执行，过程中面板可能短暂不可用，完成后会自动重启并刷新页面。
          </DialogDescription>
          {(() => {
            const job = upgradeStatus?.job;
            const progress = getLayoutUpgradeProgress(job);
            const isRunning = job?.status === "running";
            const isSuccess = job?.status === "success";
            const isError = job?.status === "error";
            const targetVersion = updateInfo?.latestVersion || upgradeStatus?.update?.latestVersion || job?.targetVersion || "-";
            const currentVersion = upgradeStatus?.currentVersion || updateInfo?.currentVersion || "-";
            const logs = (job?.logs || []).slice(-24).join("\n");
            return (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">当前版本</p>
                    <p className="mt-1 font-mono">v{currentVersion}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">目标版本</p>
                    <p className="mt-1 font-mono">{String(targetVersion).startsWith("v") ? targetVersion : `v${targetVersion}`}</p>
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
                    <div className="grid gap-2 sm:grid-cols-2">
                      {progress.steps.map((step) => (
                        <div key={step.label} className="flex items-center gap-2 text-xs">
                          {step.done ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          ) : step.active ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          ) : (
                            <span className="h-3.5 w-3.5 rounded-full border border-border" />
                          )}
                          <span className={step.done || step.active ? "text-foreground" : "text-muted-foreground"}>{step.label}</span>
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
                    升级任务已完成，面板正在重启。页面将自动刷新。
                  </div>
                )}

                {logs && (
                  <pre className="max-h-40 overflow-auto rounded-lg border border-border/40 bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
                    {logs}
                  </pre>
                )}
              </div>
            );
          })()}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpgradeDialog(false)}>
              {upgradeStatus?.job?.status === "running" ? "后台执行" : "取消"}
            </Button>
            <Button
              className="gap-2"
              disabled={
                !updateInfo?.latestVersion ||
                upgradeStatus?.upgradeEnabled === false ||
                upgradeStatus?.job?.status === "running" ||
                startUpgradeMutation.isPending
              }
              onClick={() => updateInfo?.latestVersion && startUpgradeMutation.mutate({ targetVersion: updateInfo.latestVersion })}
            >
              {startUpgradeMutation.isPending || upgradeStatus?.job?.status === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              {upgradeStatus?.job?.status === "running" ? "升级中..." : "确认升级"}
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

      <Dialog open={showTelegramDialog} onOpenChange={setShowTelegramDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-sky-500" />
            Telegram 绑定
          </DialogTitle>
          <DialogDescription>
            绑定后可在 Telegram 查询用量，并管理自己的转发规则。
          </DialogDescription>
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
                    <code className="flex-1 break-all font-mono text-lg font-semibold tracking-widest">{telegramBind.code}</code>
                    <Button variant="outline" size="icon" onClick={() => copyText(telegramBind.code)}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  点击下方按钮打开 Telegram 后点 Start 即可绑定。也可以手动发送 <code>/bind {telegramBind.code}</code>。
                </p>
                {telegramBindUrl && (
                  <Button variant="outline" asChild className="w-full gap-2">
                    <a href={telegramBindUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4" />
                      使用 Telegram 绑定
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
                  {telegramStatus?.configured ? "点击下方按钮生成绑定码，也可以先打开上方机器人。" : "管理员尚未配置 Telegram Bot Token。"}
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
                {createTelegramBindMutation.isPending ? "生成中..." : "生成绑定码"}
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
          <DialogDescription>管理员发布的登录提醒，关闭后可在左侧“公告”中查看。</DialogDescription>
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

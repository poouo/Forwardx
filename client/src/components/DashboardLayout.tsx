import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
  Package,
  ShoppingBag,
  Megaphone,
  Mail,
  Send,
  Copy,
  Link2Off,
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

const announcementsMenuItem = { icon: Megaphone, label: "公告", path: "/announcements" };

const mainMenuItems = [
  { icon: LayoutDashboard, label: "仪表盘", path: "/" },
  { icon: Server, label: "主机管理", path: "/hosts" },
  { icon: Route, label: "隧道管理", path: "/tunnels" },
  { icon: ArrowRightLeft, label: "转发规则", path: "/rules" },
];

const adminMenuItems = [
  { icon: CreditCard, label: "支付对接", path: "/payments" },
  { icon: WalletCards, label: "余额与兑换", path: "/billing" },
  { icon: Package, label: "套餐管理", path: "/plans" },
  { icon: Users, label: "用户管理", path: "/users" },
  { icon: Mail, label: "邮箱设置", path: "/email-settings" },
  { icon: Settings, label: "系统设置", path: "/settings" },
];

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
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [showTelegramDialog, setShowTelegramDialog] = useState(false);
  const [telegramBind, setTelegramBind] = useState<any | null>(null);

  useEffect(() => {
    if (popupAnnouncement?.id) setShowAnnouncement(true);
  }, [popupAnnouncement?.id]);

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
        { icon: WalletCards, label: "我的余额", path: "/wallet" },
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
          {isAdmin && updateInfo?.hasUpdate && (
            <button
              type="button"
              onClick={() => setLocation("/settings?tab=system")}
              className="mb-2 flex w-full items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-2 text-left text-primary transition-colors hover:bg-primary/15 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2"
              title={`发现新版本 ${updateInfo.latestVersion}`}
            >
              <Rocket className="h-4 w-4 shrink-0" />
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <p className="text-xs font-medium leading-none">发现新版本</p>
                <p className="mt-1 truncate font-mono text-[11px]">{updateInfo.latestVersion}</p>
              </div>
            </button>
          )}
          <button
            type="button"
            onClick={openTelegramDialog}
            className="mb-2 flex w-full items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-2 text-left text-sky-700 transition-colors hover:bg-sky-500/15 dark:text-sky-300 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2"
            title={telegramStatus?.bound ? "Telegram 已绑定" : "绑定 Telegram"}
          >
            <Send className="h-4 w-4 shrink-0" />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="text-xs font-medium leading-none">
                {telegramStatus?.bound ? "Telegram 已绑定" : "绑定 Telegram"}
              </p>
              <p className="mt-1 truncate text-[11px] text-sky-700/75 dark:text-sky-300/75">
                {telegramStatus?.bound
                  ? (telegramStatus.account?.username ? `@${telegramStatus.account.username}` : "已连接机器人")
                  : "点击生成绑定码"}
              </p>
            </div>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar className="h-9 w-9 border shrink-0">
                  <AvatarFallback className="text-xs font-medium bg-primary/10 text-primary">
                    {user?.name?.charAt(0).toUpperCase() || user?.username?.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium leading-none">
                      {user?.name || user?.username || "-"}
                    </p>
                    {isAdmin && (
                      <Badge
                        variant="secondary"
                        className="h-4 shrink-0 whitespace-nowrap border-0 bg-primary/10 px-1.5 py-0 text-[10px] leading-none text-primary"
                      >
                        管理员
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-1.5">
                    {user?.username || "-"}
                  </p>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{user?.name || user?.username}</p>
                <p className="text-xs text-muted-foreground">{user?.username}</p>
              </div>
              <DropdownMenuSeparator />
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
      </SidebarInset>

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
            绑定后可在 Telegram 查询用量、管理自己的转发规则，并生成网页登录链接。
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
              <Button
                variant="destructive"
                className="gap-2"
                onClick={() => unbindTelegramMutation.mutate()}
                disabled={unbindTelegramMutation.isPending}
              >
                <Link2Off className="h-4 w-4" />
                解除绑定
              </Button>
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
            className="max-h-[50svh] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-background/45 p-4 text-sm leading-6"
            dangerouslySetInnerHTML={{ __html: popupAnnouncement?.content || "" }}
          />
          <DialogFooter>
            <Button onClick={() => popupAnnouncement?.id && dismissAnnouncement.mutate({ id: popupAnnouncement.id })}>我知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

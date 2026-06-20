import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { AvatarPicker } from "@/components/AvatarPicker";
import { UserAvatar } from "@/components/UserAvatar";
import { migrateLegacyAvatarValue } from "@/lib/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ShieldOff,
  Package,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  User,
  Users as UsersIcon,
  Settings,
  RotateCcw,
  CalendarClock,
  Database,
  Server,
  Gauge,
  WalletCards,
  Send,
  Mail,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { useState, useEffect, useMemo, type ElementType } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { FORWARD_TYPES } from "@shared/forwardTypes";

function formatBytes(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function parseTrafficInputGB(value: string): number {
  // 纯数字输入，单位 GB，0 表示不限制
  const num = parseFloat(String(value).trim());
  if (isNaN(num) || num <= 0) return 0;
  return Math.floor(num * 1024 * 1024 * 1024);
}

function parseSpeedInputMB(value: string): number {
  const num = parseFloat(String(value).trim());
  if (isNaN(num) || num <= 0) return 0;
  return Math.floor(num * 1024 * 1024);
}

function formatSpeed(bytesPerSecond: number | string | null | undefined): string {
  const num = Number(bytesPerSecond);
  if (!num || isNaN(num) || num <= 0) return "0 MB/s";
  return `${parseFloat((num / 1024 / 1024).toFixed(2))} MB/s`;
}

function userLabel(user: any) {
  return user?.name || user?.username || `#${user?.id}`;
}

function formatCurrencyCny(cents: number | string | null | undefined): string {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((Number(cents) || 0) / 100);
}

function readStoredUserManageType(): "accounts" | "subscriptions" {
  if (typeof window === "undefined") return "accounts";
  try {
    const value = window.localStorage.getItem("forwardx.users.type");
    return value === "subscriptions" ? "subscriptions" : "accounts";
  } catch {
    return "accounts";
  }
}

function writeStoredUserManageType(value: "accounts" | "subscriptions") {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("forwardx.users.type", value);
  } catch {
    // Page still works when localStorage is unavailable.
  }
}

function dateText(value?: string | Date | null) {
  if (!value) return "永久";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("zh-CN");
}

function dateTimeText(value?: string | Date | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN");
}

function subscriptionStatusLabel(status?: string) {
  if (status === "active") return "生效中";
  if (status === "expired") return "已过期";
  if (status === "cancelled") return "已取消";
  return status || "-";
}

function subscriptionSourceLabel(source?: string) {
  if (source === "admin") return "管理员分配";
  if (source === "balance") return "余额购买";
  if (source === "payment") return "在线支付";
  if (source === "redeem") return "兑换套餐";
  return source || "套餐记录";
}

function isSubscriptionActive(sub: any) {
  return sub?.status === "active" && (!sub.expiresAt || new Date(sub.expiresAt).getTime() > Date.now());
}

function UserStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading,
  cacheKey,
  fallbackValue,
  className,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ElementType;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
  className?: string;
}) {
  return (
    <Card className={`group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70 ${className || ""}`}>
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2 sm:gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <AnimatedStatValue
              as="p"
              value={value}
              loading={loading}
              cacheKey={cacheKey}
              fallbackValue={fallbackValue}
              className="break-words text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl"
            />
            {subtitle && (
              <AnimatedStatValue
                as="p"
                value={subtitle}
                loading={loading}
                cacheKey={`${cacheKey}.subtitle`}
                fallbackValue=""
                className="break-words text-xs text-muted-foreground/80"
              />
            )}
          </div>
          <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone} shadow-sm sm:flex`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsersContent() {
  const { user: currentUser } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  // Create user dialog
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserName, setNewUserName] = useState("");
  // 出于安全考虑，后台创建的用户一律为普通用户
  const [newCanAddRules, setNewCanAddRules] = useState(true);

  // Reset password dialog
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState<number | null>(null);
  const [resetUserName, setResetUserName] = useState("");
  const [resetUsernameInput, setResetUsernameInput] = useState("");
  const [resetDisplayNameInput, setResetDisplayNameInput] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetAvatarInput, setResetAvatarInput] = useState("");
  const [showResetTraffic, setShowResetTraffic] = useState(false);
  const [resetTrafficUserId, setResetTrafficUserId] = useState<number | null>(null);
  const [resetTrafficUserName, setResetTrafficUserName] = useState("");
  const [showRecharge, setShowRecharge] = useState(false);
  const [rechargeUserId, setRechargeUserId] = useState<number | null>(null);
  const [rechargeUserName, setRechargeUserName] = useState("");
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [showSetBalance, setShowSetBalance] = useState(false);
  const [setBalanceUserId, setSetBalanceUserId] = useState<number | null>(null);
  const [setBalanceUserName, setSetBalanceUserName] = useState("");
  const [setBalanceAmount, setSetBalanceAmount] = useState("");
  const [showSendEmail, setShowSendEmail] = useState(false);
  const [emailUserId, setEmailUserId] = useState<number | null>(null);
  const [emailUserName, setEmailUserName] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailContent, setEmailContent] = useState("");
  const [deleteUserId, setDeleteUserId] = useState<number | null>(null);
  const [deleteUserName, setDeleteUserName] = useState("");
  const [showDeleteUser, setShowDeleteUser] = useState(false);
  const [removeTwoFactorUserId, setRemoveTwoFactorUserId] = useState<number | null>(null);
  const [removeTwoFactorUserName, setRemoveTwoFactorUserName] = useState("");
  const [showRemoveTwoFactor, setShowRemoveTwoFactor] = useState(false);

  // Traffic settings dialog
  const [showTrafficSettings, setShowTrafficSettings] = useState(false);
  const [trafficUserId, setTrafficUserId] = useState<number | null>(null);
  const [trafficUserName, setTrafficUserName] = useState("");
  const [trafficDisplayRemark, setTrafficDisplayRemark] = useState("");
  const [trafficLimitInput, setTrafficLimitInput] = useState("");
  const [gostRateLimitInInput, setGostRateLimitInInput] = useState("");
  const [gostRateLimitOutInput, setGostRateLimitOutInput] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [trafficAutoReset, setTrafficAutoReset] = useState(false);
  const [trafficResetDay, setTrafficResetDay] = useState(1);

  // Subscription management dialogs
  const [manageType, setManageType] = useState<"accounts" | "subscriptions">(() => readStoredUserManageType());
  const [showAddonDialog, setShowAddonDialog] = useState(false);
  const [addonUserId, setAddonUserId] = useState<number | null>(null);
  const [addonUserName, setAddonUserName] = useState("");
  const [addonSubscriptionId, setAddonSubscriptionId] = useState("");
  const [addonSubscriptionLabel, setAddonSubscriptionLabel] = useState("");
  const [addonTrafficGB, setAddonTrafficGB] = useState("");
  const [showExtendDialog, setShowExtendDialog] = useState(false);
  const [extendSubscriptionId, setExtendSubscriptionId] = useState<number | null>(null);
  const [extendSubscriptionLabel, setExtendSubscriptionLabel] = useState("");
  const [extendDays, setExtendDays] = useState("30");
  const [maxRules, setMaxRules] = useState(0);
  const [maxPorts, setMaxPorts] = useState(0);
  const [maxConnections, setMaxConnections] = useState(0);
  const [maxIPs, setMaxIPs] = useState(0);
  // 允许使用的转发方式：默认三种全部允许
  const [allowIptables, setAllowIptables] = useState(true);
  const [allowNftables, setAllowNftables] = useState(true);
  const [allowRealm, setAllowRealm] = useState(true);
  const [allowSocat, setAllowSocat] = useState(true);
  const [allowGost, setAllowGost] = useState(true);

  // Agent 权限
  const [allowedHostIds, setAllowedHostIds] = useState<number[]>([]);
  const [allowedTunnelIds, setAllowedTunnelIds] = useState<number[]>([]);
  const [trafficBillingHostIds, setTrafficBillingHostIds] = useState<number[]>([]);
  const [trafficBillingTunnelIds, setTrafficBillingTunnelIds] = useState<number[]>([]);
  const [addAllowedHostId, setAddAllowedHostId] = useState("");
  const [addAllowedTunnelId, setAddAllowedTunnelId] = useState("");
  const [addBillingHostId, setAddBillingHostId] = useState("");
  const [addBillingTunnelId, setAddBillingTunnelId] = useState("");
  const { data: allHosts } = trpc.hosts.listAll.useQuery();
  const { data: allTunnels } = trpc.tunnels.listAll.useQuery();
  const { data: trafficBillingConfigs } = trpc.trafficBilling.configs.useQuery();
  const { data: userHostPerms } = trpc.users.getHostPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
  );
  const { data: userTunnelPerms } = trpc.users.getTunnelPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
  );
  const { data: userTrafficBillingPerms } = trpc.users.getTrafficBillingPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
  );
  const { data: userSummary, isLoading: summaryLoading } = trpc.users.summary.useQuery(undefined, {
    enabled: currentUser?.role === "admin",
    refetchInterval: 30000,
  });
  const { data: allSubscriptions = [], isLoading: subscriptionsLoading } = trpc.plans.subscriptions.useQuery(
    {},
    { enabled: currentUser?.role === "admin" }
  );
  const updateHostPermsMutation = trpc.users.setHostPermissions.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新主机权限失败"),
  });
  const updateTunnelPermsMutation = trpc.users.setTunnelPermissions.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新隧道权限失败"),
  });
  const updateTrafficBillingPermsMutation = trpc.users.setTrafficBillingPermissions.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新流量计费授权失败"),
  });


  // 当权限数据加载完成后同步到状态
  useEffect(() => {
    if (userHostPerms) {
      setAllowedHostIds([...userHostPerms]);
    }
  }, [userHostPerms]);

  useEffect(() => {
    if (userTunnelPerms) {
      setAllowedTunnelIds([...userTunnelPerms]);
    }
  }, [userTunnelPerms]);

  useEffect(() => {
    if (userTrafficBillingPerms) {
      setTrafficBillingHostIds([...(userTrafficBillingPerms.hostIds || [])]);
      setTrafficBillingTunnelIds([...(userTrafficBillingPerms.tunnelIds || [])]);
    }
  }, [userTrafficBillingPerms]);

  useEffect(() => {
    if (currentUser && currentUser.role !== "admin") {
      setLocation("/");
    }
  }, [currentUser, setLocation]);

  const { data: users, isLoading } = trpc.users.list.useQuery(undefined, {
    enabled: currentUser?.role === "admin",
  });

  const createUserMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("用户创建成功");
      setShowCreateUser(false);
      setNewUsername("");
      setNewUserPassword("");
      setNewUserName("");
      setNewCanAddRules(true);
    },
    onError: (err) => toast.error(err.message || "创建用户失败"),
  });

  const resetPasswordMutation = trpc.users.resetPassword.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("账户信息已更新");
      setShowResetPassword(false);
      setResetUsernameInput("");
      setResetNewPassword("");
      setResetAvatarInput("");
    },
    onError: (err) => toast.error(err.message || "更新账户信息失败"),
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("用户已删除");
      setShowDeleteUser(false);
      setDeleteUserId(null);
      setDeleteUserName("");
    },
    onError: (err) => toast.error(err.message || "删除用户失败"),
  });

  const removeTwoFactorMutation = trpc.users.removeTwoFactor.useMutation({
    onSuccess: (data) => {
      utils.users.list.invalidate();
      toast.success(data.removed ? "双因素认证已移除" : "该用户未绑定双因素认证");
      setShowRemoveTwoFactor(false);
      setRemoveTwoFactorUserId(null);
      setRemoveTwoFactorUserName("");
    },
    onError: (err) => toast.error(err.message || "移除双因素认证失败"),
  });

  const sendEmailMutation = trpc.users.sendEmail.useMutation({
    onSuccess: () => {
      toast.success("邮件已发送");
      setShowSendEmail(false);
      setEmailSubject("");
      setEmailContent("");
    },
    onError: (err) => toast.error(err.message || "邮件发送失败"),
  });

  const updateTrafficMutation = trpc.users.updateTrafficSettings.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("流量设置已更新");
      setShowTrafficSettings(false);
    },
    onError: (err) => toast.error(err.message || "更新流量设置失败"),
  });

  const resetTrafficMutation = trpc.users.resetTraffic.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("流量已重置");
      setShowResetTraffic(false);
      setResetTrafficUserId(null);
      setResetTrafficUserName("");
    },
    onError: (err) => toast.error(err.message || "重置流量失败"),
  });

  const updateForwardAccessMutation = trpc.users.setForwardAccess.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.rules.list.invalidate();
      toast.success("用户转发权限已更新");
    },
    onError: (err) => toast.error(err.message || "更新转发权限失败"),
  });

  const updateAccountEnabledMutation = trpc.users.setAccountEnabled.useMutation({
    onSuccess: (_, variables) => {
      utils.users.list.invalidate();
      utils.rules.list.invalidate();
      toast.success(variables.enabled ? "账户已启用" : "账户已禁用，已有规则已失效");
    },
    onError: (err) => toast.error(err.message || "更新账户状态失败"),
  });

  const adminRechargeMutation = trpc.billing.adminRecharge.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.billing.listTransactions.invalidate();
      toast.success("余额已充值");
      setShowRecharge(false);
      setRechargeAmount("");
    },
    onError: (err) => toast.error(err.message || "充值失败"),
  });

  const adminSetBalanceMutation = trpc.billing.adminSetBalance.useMutation({
    onSuccess: (data) => {
      utils.users.list.invalidate();
      utils.billing.me.invalidate();
      utils.billing.ledger.invalidate();
      utils.billing.listTransactions.invalidate();
      toast.success(data.changed ? "余额已修改" : "余额未变化");
      setShowSetBalance(false);
      setSetBalanceAmount("");
    },
    onError: (err) => toast.error(err.message || "修改余额失败"),
  });
  const adminAddTrafficAddonMutation = trpc.billing.adminAddTrafficAddon.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      toast.success("本周期附加流量已生效");
      setShowAddonDialog(false);
      setAddonUserId(null);
      setAddonSubscriptionId("");
      setAddonSubscriptionLabel("");
      setAddonTrafficGB("");
    },
    onError: (err) => toast.error(err.message || "附加流量失败"),
  });

  const extendSubscriptionMutation = trpc.plans.extendSubscription.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      toast.success("订阅时间已延长");
      setShowExtendDialog(false);
      setExtendSubscriptionId(null);
      setExtendSubscriptionLabel("");
      setExtendDays("30");
    },
    onError: (err) => toast.error(err.message || "延长订阅失败"),
  });

  const cancelSubscriptionMutation = trpc.plans.cancelSubscription.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      utils.users.summary.invalidate();
      utils.plans.subscriptions.invalidate();
      toast.success("订阅已取消");
    },
    onError: (err) => toast.error(err.message || "取消订阅失败"),
  });

  const adminCount = useMemo(() => users?.filter((u: any) => u.role === "admin").length ?? 0, [users]);
  const activeSubscriptionCount = useMemo(() => (allSubscriptions as any[]).filter(isSubscriptionActive).length, [allSubscriptions]);
  const userPagination = usePersistentPagination(users || [], {
    storageKey: "forwardx.users.page",
    pageSize: 12,
    isReady: !isLoading && !!users,
  });
  const pagedUsers = userPagination.items;
  const subscriptionPagination = usePersistentPagination(allSubscriptions || [], {
    storageKey: "forwardx.users.subscriptions.page",
    pageSize: 12,
    isReady: !subscriptionsLoading,
  });
  const pagedSubscriptions = subscriptionPagination.items;

  if (currentUser?.role !== "admin") return null;

  const handleCreateUser = () => {
    if (!newUsername.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (newUserName.trim().length > 24) {
      toast.error("显示名称最多 24 个字符");
      return;
    }
    if (newUserPassword.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    createUserMutation.mutate({
      username: newUsername.trim(),
      password: newUserPassword,
      name: newUserName.trim() || undefined,
      canAddRules: newCanAddRules,
    });
  };

  const handleResetPassword = () => {
    if (!resetUserId) return;
    const username = resetUsernameInput.trim();
    const password = resetNewPassword.trim();
    if (!username) {
      toast.error("请输入账号");
      return;
    }
    if (resetDisplayNameInput.trim().length > 24) {
      toast.error("显示名称最多 24 个字符");
      return;
    }
    if (password && password.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    resetPasswordMutation.mutate({
      userId: resetUserId,
      username,
      name: resetDisplayNameInput.trim() || null,
      avatar: resetAvatarInput || migrateLegacyAvatarValue("", `user-${resetUserId}`),
      newPassword: password || undefined,
    });
  };

  const handleResetTraffic = () => {
    if (!resetTrafficUserId) return;
    resetTrafficMutation.mutate({ userId: resetTrafficUserId });
  };

  const openRechargeDialog = (u: any) => {
    setRechargeUserId(u.id);
    setRechargeUserName(userLabel(u));
    setRechargeAmount("");
    setShowRecharge(true);
  };

  const openSetBalanceDialog = (u: any) => {
    setSetBalanceUserId(u.id);
    setSetBalanceUserName(userLabel(u));
    setSetBalanceAmount((Number(u.balanceCents || 0) / 100).toFixed(2));
    setShowSetBalance(true);
  };

  const openResetTrafficDialog = (u: any) => {
    setResetTrafficUserId(u.id);
    setResetTrafficUserName(userLabel(u));
    setShowResetTraffic(true);
  };

  const openAccountDialog = (u: any) => {
    setResetUserId(u.id);
    setResetUserName(userLabel(u));
    setResetUsernameInput(u.username || "");
    setResetDisplayNameInput(u.name || u.username || "");
    setResetNewPassword("");
    setResetAvatarInput(migrateLegacyAvatarValue(u.avatar, `user-${u.id}`));
    setShowResetPassword(true);
  };

  const confirmDeleteUser = (u: any) => {
    if (u.id === currentUser?.id) return;
    setDeleteUserId(u.id);
    setDeleteUserName(userLabel(u));
    setShowDeleteUser(true);
  };

  const openRemoveTwoFactorDialog = (u: any) => {
    setRemoveTwoFactorUserId(u.id);
    setRemoveTwoFactorUserName(userLabel(u));
    setShowRemoveTwoFactor(true);
  };

  const handleDeleteUser = () => {
    if (!deleteUserId) return;
    deleteMutation.mutate({ userId: deleteUserId });
  };

  const handleRemoveTwoFactor = () => {
    if (!removeTwoFactorUserId) return;
    removeTwoFactorMutation.mutate({ userId: removeTwoFactorUserId });
  };

  const openSendEmail = (u: any) => {
    if (!u.email || !u.emailVerified) {
      toast.error("该用户邮箱尚未验证，不能发送邮件");
      return;
    }
    setEmailUserId(u.id);
    setEmailUserName(userLabel(u));
    setEmailTo(u.email);
    setEmailSubject("");
    setEmailContent("");
    setShowSendEmail(true);
  };

  const handleSendEmail = () => {
    if (!emailUserId) return;
    if (!emailSubject.trim() || !emailContent.trim()) {
      toast.error("请填写邮件标题和内容");
      return;
    }
    sendEmailMutation.mutate({
      userId: emailUserId,
      subject: emailSubject.trim(),
      content: emailContent.trim(),
    });
  };

  const openTrafficSettings = (u: any) => {
    if (u.role === "admin") {
      toast.info("管理员默认拥有全部权限，且不受流量/资源限制");
      return;
    }
    setTrafficUserId(u.id);
    setTrafficUserName(userLabel(u));
    setTrafficDisplayRemark(String(u.displayRemark || ""));
    const limitBytes = Number(u.trafficLimit) || 0;
    if (limitBytes > 0) {
      const gb = limitBytes / (1024 * 1024 * 1024);
      // 以 GB 为单位、保留最多 2 位小数（去尾零）
      setTrafficLimitInput(parseFloat(gb.toFixed(2)).toString());
    } else {
      setTrafficLimitInput("0");
    }
    setExpiresAtInput(u.expiresAt ? new Date(u.expiresAt).toISOString().slice(0, 10) : "");
    setTrafficAutoReset(!!u.trafficAutoReset);
    setTrafficResetDay(u.trafficResetDay || 1);
    const gostIn = Number(u.gostRateLimitIn) || 0;
    const gostOut = Number(u.gostRateLimitOut) || 0;
    const unifiedRateLimit = Math.max(gostIn, gostOut);
    setGostRateLimitInInput(unifiedRateLimit > 0 ? parseFloat((unifiedRateLimit / 1024 / 1024).toFixed(2)).toString() : "0");
    setGostRateLimitOutInput(unifiedRateLimit > 0 ? parseFloat((unifiedRateLimit / 1024 / 1024).toFixed(2)).toString() : "0");
    setMaxRules(u.maxRules || 0);
    setMaxPorts(u.maxPorts || 0);
    setMaxConnections(u.maxConnections || 0);
    setMaxIPs(u.maxIPs || 0);
    // 转发方式权限：allowedForwardTypes 为 null 表示全部允许，空串表示全部禁用
    const allowedRaw = (u.allowedForwardTypes as string | null) || "";
    if (u.allowedForwardTypes === null || u.allowedForwardTypes === undefined) {
      setAllowIptables(true); setAllowNftables(true); setAllowRealm(true); setAllowSocat(true); setAllowGost(true);
    } else {
      const set = new Set(allowedRaw.split(",").map((s: string) => s.trim()));
      setAllowIptables(set.has("iptables"));
      setAllowNftables(set.has("nftables"));
      setAllowRealm(set.has("realm"));
      setAllowSocat(set.has("socat"));
      setAllowGost(set.has("gost"));
    }
    setAllowedHostIds([]);
    setAllowedTunnelIds([]);
    setTrafficBillingHostIds([]);
    setTrafficBillingTunnelIds([]);
    setAddAllowedHostId("");
    setAddAllowedTunnelId("");
    setAddBillingHostId("");
    setAddBillingTunnelId("");
    setShowTrafficSettings(true);
  };

  const handleSaveTrafficSettings = () => {
    if (!trafficUserId) return;
    const limitBytes = parseTrafficInputGB(trafficLimitInput);
    // 拼接转发方式权限：三种都允许时传 null（后端为 null 表示全部）
    const allowed: string[] = [];
    if (allowIptables) allowed.push("iptables");
    if (allowNftables) allowed.push("nftables");
    if (allowRealm) allowed.push("realm");
    if (allowSocat) allowed.push("socat");
    if (allowGost) allowed.push("gost");
    const allowedForwardTypes = allowed.length === FORWARD_TYPES.length ? null : allowed.join(",");
    const unifiedRateLimit = parseSpeedInputMB(gostRateLimitInInput);
    const displayRemark = trafficDisplayRemark.trim().slice(0, 24);
    updateTrafficMutation.mutate({
      userId: trafficUserId,
      displayRemark: displayRemark || null,
      trafficLimit: limitBytes,
      gostRateLimitIn: unifiedRateLimit,
      gostRateLimitOut: unifiedRateLimit,
      expiresAt: expiresAtInput || null,
      trafficAutoReset,
      trafficResetDay,
      maxRules,
      maxPorts,
      maxConnections,
      maxIPs,
      allowedForwardTypes,
    });
    // 同时保存主机权限（改为 tRPC 上的 setHostPermissions）
    updateHostPermsMutation.mutate({
      userId: trafficUserId,
      hostIds: allowedHostIds,
    });
    updateTunnelPermsMutation.mutate({
      userId: trafficUserId,
      tunnelIds: allowedTunnelIds,
    });
    updateTrafficBillingPermsMutation.mutate({
      userId: trafficUserId,
      hostIds: trafficBillingHostIds,
      tunnelIds: trafficBillingTunnelIds,
    });
  };

  const addHostPermission = (value: string) => {
    const hostId = Number(value);
    if (!Number.isFinite(hostId)) return;
    setAllowedHostIds(prev => (prev.includes(hostId) ? prev : [...prev, hostId]));
    setAddAllowedHostId("");
  };

  const addTunnelPermission = (value: string) => {
    const tunnelId = Number(value);
    if (!Number.isFinite(tunnelId)) return;
    setAllowedTunnelIds(prev => (prev.includes(tunnelId) ? prev : [...prev, tunnelId]));
    setAddAllowedTunnelId("");
  };

  const addTrafficBillingHost = (value: string) => {
    const hostId = Number(value);
    if (!Number.isFinite(hostId)) return;
    setTrafficBillingHostIds(prev => (prev.includes(hostId) ? prev : [...prev, hostId]));
    setAddBillingHostId("");
  };

  const addTrafficBillingTunnel = (value: string) => {
    const tunnelId = Number(value);
    if (!Number.isFinite(tunnelId)) return;
    setTrafficBillingTunnelIds(prev => (prev.includes(tunnelId) ? prev : [...prev, tunnelId]));
    setAddBillingTunnelId("");
  };

  const handleRecharge = () => {
    if (!rechargeUserId) return;
    const amountCents = Math.round(Number(rechargeAmount || 0) * 100);
    if (amountCents <= 0) return toast.error("请输入有效充值金额");
    adminRechargeMutation.mutate({ userId: rechargeUserId, amountCents, description: "用户管理手动充值" });
  };

  const handleSetBalance = () => {
    if (!setBalanceUserId) return;
    const balanceCents = Math.round(Number(setBalanceAmount || 0) * 100);
    if (!Number.isFinite(balanceCents) || balanceCents < 0) return toast.error("请输入有效余额");
    adminSetBalanceMutation.mutate({ userId: setBalanceUserId, balanceCents, description: "用户管理手动修改余额" });
  };

  const handleManageTypeChange = (value: string) => {
    const next = value === "subscriptions" ? "subscriptions" : "accounts";
    setManageType(next);
    writeStoredUserManageType(next);
  };

  const openAddonDialog = (sub: any) => {
    if (!isSubscriptionActive(sub) || Number(sub.trafficLimit || 0) <= 0) {
      toast.error("只有生效中的流量套餐可以附加流量");
      return;
    }
    setAddonUserId(Number(sub.userId));
    setAddonUserName(userLabel({ username: sub.username, name: sub.name, id: sub.userId }));
    setAddonSubscriptionId(String(sub.id));
    setAddonSubscriptionLabel(`${sub.planName || `套餐 #${sub.planId}`} · ${formatBytes(sub.trafficLimit)}`);
    setAddonTrafficGB("");
    setShowAddonDialog(true);
  };

  const openExtendDialog = (sub: any) => {
    if (sub.status === "cancelled") {
      toast.error("已取消的订阅不能延长时间");
      return;
    }
    if (!sub.expiresAt) {
      toast.info("永久订阅无需延长");
      return;
    }
    setExtendSubscriptionId(Number(sub.id));
    setExtendSubscriptionLabel(`${userLabel({ username: sub.username, name: sub.name, id: sub.userId })} · ${sub.planName || `套餐 #${sub.planId}`}`);
    setExtendDays("30");
    setShowExtendDialog(true);
  };

  const handleAdminAddTrafficAddon = () => {
    if (!addonUserId) return;
    const trafficBytes = parseTrafficInputGB(addonTrafficGB);
    if (trafficBytes <= 0) return toast.error("请输入大于 0 的附加流量");
    adminAddTrafficAddonMutation.mutate({
      userId: addonUserId,
      trafficBytes,
      subscriptionId: addonSubscriptionId ? Number(addonSubscriptionId) : undefined,
      description: "管理员手动附加本周期流量",
    });
  };

  const handleExtendSubscription = () => {
    if (!extendSubscriptionId) return;
    const days = Math.floor(Number(extendDays || 0));
    if (!Number.isFinite(days) || days <= 0) return toast.error("请输入有效延长天数");
    extendSubscriptionMutation.mutate({ id: extendSubscriptionId, days });
  };

  const hostNameById = (hostId: number) => allHosts?.find((h: any) => h.id === hostId)?.name || `#${hostId}`;
  const tunnelRouteText = (tunnel: any) => getTunnelRouteText(tunnel, allHosts);
  const billableHostIds = new Set((trafficBillingConfigs?.configs || []).filter((item: any) => item.resourceType === "host" && item.enabled && item.requiresPermission).map((item: any) => Number(item.resourceId)));
  const billableTunnelIds = new Set((trafficBillingConfigs?.configs || []).filter((item: any) => item.resourceType === "tunnel" && item.enabled && item.requiresPermission).map((item: any) => Number(item.resourceId)));
  const selectedAllowedHosts = (allHosts || []).filter((h: any) => allowedHostIds.includes(Number(h.id)));
  const availableAllowedHosts = (allHosts || []).filter((h: any) => !allowedHostIds.includes(Number(h.id)));
  const selectedAllowedTunnels = (allTunnels || []).filter((t: any) => allowedTunnelIds.includes(Number(t.id)));
  const availableAllowedTunnels = (allTunnels || []).filter((t: any) => !allowedTunnelIds.includes(Number(t.id)));
  const billableHosts = (allHosts || []).filter((h: any) => billableHostIds.has(Number(h.id)));
  const availableBillingHosts = billableHosts.filter((h: any) => !trafficBillingHostIds.includes(Number(h.id)));
  const selectedBillingHosts = billableHosts.filter((h: any) => trafficBillingHostIds.includes(Number(h.id)));
  const billableTunnels = (allTunnels || []).filter((t: any) => billableTunnelIds.has(Number(t.id)));
  const availableBillingTunnels = billableTunnels.filter((t: any) => !trafficBillingTunnelIds.includes(Number(t.id)));
  const selectedBillingTunnels = billableTunnels.filter((t: any) => trafficBillingTunnelIds.includes(Number(t.id)));

  const renderAccountEnabledControl = (u: any, compact = false) => {
    const enabled = u.accountEnabled !== false;
    const isSelf = u.id === currentUser?.id;
    return (
      <div
        className={
          compact
            ? "flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/50 px-2 py-1.5"
            : "flex min-w-[132px] items-center justify-end gap-2"
        }
      >
        {compact && <span className="min-w-0 truncate text-xs text-muted-foreground">账户</span>}
        <Switch
          checked={enabled}
          disabled={isSelf || updateAccountEnabledMutation.isPending}
          onCheckedChange={(checked) => updateAccountEnabledMutation.mutate({ userId: u.id, enabled: checked })}
          className="shrink-0"
        />
        <Badge
          variant="outline"
          className={
            enabled
              ? "h-5 w-fit shrink-0 whitespace-nowrap border-chart-2/30 px-2 py-0 text-[10px] text-chart-2"
              : "h-5 w-fit shrink-0 whitespace-nowrap border-destructive/30 px-2 py-0 text-[10px] text-destructive"
          }
        >
          {enabled ? (compact ? "启用" : "账户启用") : compact ? "禁用" : "账户禁用"}
        </Badge>
      </div>
    );
  };

  const renderUserMoreMenu = (u: any, triggerClassName = "h-8 px-2") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={triggerClassName} title="更多操作">
          <MoreHorizontal className="h-4 w-4" />
          <span className="text-xs">更多</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => openRechargeDialog(u)}>
          <WalletCards className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>余额充值</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSetBalanceDialog(u)}>
          <Pencil className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>修改余额</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openAccountDialog(u)}>
          <User className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>账户信息</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!u.emailVerified || !u.email} onSelect={() => openSendEmail(u)}>
          <Mail className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>发送邮件</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openResetTrafficDialog(u)}>
          <RotateCcw className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>重置流量</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!u.twoFactorEnabled} onSelect={() => openRemoveTwoFactorDialog(u)}>
          <ShieldOff className="mr-2 h-4 w-4 text-muted-foreground" />
          <span>移除 2FA</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={u.id === currentUser?.id}
          onSelect={() => confirmDeleteUser(u)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          <span>删除用户</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">用户管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理系统用户、权限和流量配额
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-3">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <ShieldCheck className="h-3 w-3 text-amber-400" />
            <AnimatedStatValue
              value={`${adminCount} 管理员`}
              loading={isLoading || !users}
              cacheKey="users.header.adminCount"
              fallbackValue="0 管理员"
            />
          </Badge>
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <UsersIcon className="h-3 w-3 text-primary" />
            <AnimatedStatValue
              value={`${users?.length ?? 0} 用户`}
              loading={isLoading || !users}
              cacheKey="users.header.totalUsers"
              fallbackValue="0 用户"
            />
          </Badge>
          <Button size="sm" className="col-span-2 sm:col-span-1" onClick={() => setShowCreateUser(true)}>
            <Plus className="h-4 w-4 mr-1" />
            添加用户
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <UserStatCard
          title="用户总数"
          value={userSummary?.totalUsers ?? users?.length ?? 0}
          subtitle={`${adminCount} 个管理员`}
          icon={UsersIcon}
          tone="bg-gradient-to-br from-blue-500 to-blue-600"
          loading={summaryLoading || isLoading}
          cacheKey="users.summary.totalUsers"
          fallbackValue={0}
        />
        <UserStatCard
          title="转发规则"
          value={userSummary?.totalRules ?? 0}
          subtitle={`${userSummary?.activeRules ?? 0} 条活跃`}
          icon={ArrowRightLeft}
          tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
          loading={summaryLoading}
          cacheKey="users.summary.totalRules"
          fallbackValue={0}
        />
        <UserStatCard
          title="入站流量"
          value={formatBytes(userSummary?.totalTrafficIn ?? 0)}
          subtitle="所有用户累计入站"
          icon={ArrowDownToLine}
          tone="bg-gradient-to-br from-violet-500 to-violet-600"
          loading={summaryLoading}
          cacheKey="users.summary.totalTrafficIn"
          fallbackValue="0 B"
          className="col-span-2 sm:col-span-1"
        />
        <UserStatCard
          title="出站流量"
          value={formatBytes(userSummary?.totalTrafficOut ?? 0)}
          subtitle="所有用户累计出站"
          icon={ArrowUpFromLine}
          tone="bg-gradient-to-br from-amber-500 to-amber-600"
          loading={summaryLoading}
          cacheKey="users.summary.totalTrafficOut"
          fallbackValue="0 B"
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <Tabs value={manageType} onValueChange={handleManageTypeChange} className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 border border-border/30 bg-muted/30 sm:w-auto sm:min-w-[360px]">
          <TabsTrigger value="accounts" className="min-w-0 justify-center gap-1.5 text-xs sm:text-sm">
            <UsersIcon className="h-3.5 w-3.5" />
            账户管理
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="min-w-0 justify-center gap-1.5 text-xs sm:text-sm">
            <Package className="h-3.5 w-3.5" />
            用户订阅管理
            {(subscriptionsLoading || activeSubscriptionCount > 0) && (
              <AnimatedStatValue
                value={activeSubscriptionCount}
                loading={subscriptionsLoading}
                cacheKey="users.tabs.activeSubscriptionCount"
                fallbackValue={0}
                className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
              />
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="space-y-4 data-[state=inactive]:hidden">

      {isLoading && (
        <DataSectionLoading className="sm:hidden" label="正在加载用户数据" minHeight="min-h-[220px]" />
      )}

      {!isLoading && users && users.length > 0 && (
        <AutoAnimateContainer className="space-y-3 sm:hidden">
          {pagedUsers.map((u: any) => {
            const limit = Number(u.trafficLimit) || 0;
            const used = Number(u.trafficUsed) || 0;
            const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
            const isOverLimit = limit > 0 && used >= limit;
            const speedLimit = Math.max(Number(u.gostRateLimitIn) || 0, Number(u.gostRateLimitOut) || 0);

            return (
              <div key={u.id} className="rounded-lg border border-border/50 bg-card/70 p-3 shadow-sm">
                <div className="flex items-start gap-3">
                  <UserAvatar user={u} className="h-10 w-10 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="min-w-0 max-w-full truncate text-sm font-semibold">{u.username || "未命名"}</p>
                      <Badge variant={u.role === "admin" ? "default" : "outline"} className="h-5 px-1.5 text-[10px]">
                        {u.role === "admin" ? "管理员" : "普通用户"}
                      </Badge>
                      {u.id === currentUser?.id && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-primary">当前</Badge>
                      )}
                      {u.accountEnabled === false && (
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">账户禁用</Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      #{u.id}{u.displayRemark ? ` · ${u.displayRemark}` : ""}
                    </p>
                  </div>
                </div>

                <div className="mt-3 grid gap-2">
                  <div className="rounded-md bg-muted/25 p-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">流量</span>
                      <span className="min-w-0 truncate text-right tabular-nums">
                        {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
                      </span>
                    </div>
                    {limit > 0 && (
                      <Progress value={pct} className={`mt-2 h-1.5 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`} />
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {isOverLimit && <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">超额</Badge>}
                      {isExpired && <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">已到期</Badge>}
                      {u.trafficAutoReset && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">每月{u.trafficResetDay || 1}日重置</Badge>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md bg-muted/25 p-2">
                      <p className="text-muted-foreground">余额</p>
                      <p className="mt-1 truncate font-medium">{formatCurrencyCny(u.balanceCents)}</p>
                    </div>
                    <div className="min-w-0 rounded-md bg-muted/25 p-2">
                      <p className="text-muted-foreground">到期</p>
                      <p className={`mt-1 truncate font-medium ${isExpired ? "text-destructive" : ""}`}>
                        {u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : "不限"}
                      </p>
                    </div>
                    <div className="min-w-0 rounded-md bg-muted/25 p-2">
                      <p className="text-muted-foreground">Telegram</p>
                      <p className="mt-1 truncate font-medium">
                        {u.telegramId ? (u.telegramUsername ? `@${u.telegramUsername}` : u.telegramFirstName || u.telegramId) : "未绑定"}
                      </p>
                    </div>
                    <div className="min-w-0 rounded-md bg-muted/25 p-2">
                      <p className="text-muted-foreground">邮箱</p>
                      <p className="mt-1 truncate font-medium">{u.emailVerified ? "已验证" : u.email ? "未验证" : "未填写"}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <span>规则: {u.maxRules ? `${u.maxRules} 条` : "不限"}</span>
                    <span>端口: {u.maxPorts ? `${u.maxPorts} 个` : "不限"}</span>
                    <span>连接: {u.maxConnections ? `${u.maxConnections}` : "不限"}</span>
                    <span>单 IP: {u.maxIPs ? `${u.maxIPs}` : "不限"}</span>
                    {speedLimit > 0 && <span className="col-span-2">限速: {formatSpeed(speedLimit)}</span>}
                  </div>

                  <div className="grid gap-2">
                    <div className="flex h-9 items-center justify-between rounded-md border border-border/50 px-2">
                      <span className="text-xs text-muted-foreground">转发</span>
                      <Switch
                        checked={u.role === "admin" || !!u.canAddRules}
                        disabled={u.role === "admin" || updateForwardAccessMutation.isPending}
                        onCheckedChange={(checked) => updateForwardAccessMutation.mutate({ userId: u.id, enabled: checked })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 pt-1">
                    {renderAccountEnabledControl(u, true)}
                    <Button variant="outline" size="sm" className="h-9 px-2 text-xs" onClick={() => openTrafficSettings(u)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      编辑
                    </Button>
                    {renderUserMoreMenu(u, "h-9 justify-center gap-1 rounded-md border border-border/50 px-2 text-xs")}
                  </div>
                </div>
              </div>
            );
          })}
        </AutoAnimateContainer>
      )}

      {!isLoading && (!users || users.length === 0) && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border/50 bg-card/60 py-16 text-muted-foreground sm:hidden">
          <div className="h-14 w-14 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
            <UsersIcon className="h-7 w-7 opacity-40" />
          </div>
          <p className="text-base font-medium">暂无其他用户</p>
          <p className="mt-1 text-sm text-muted-foreground/60">点击添加用户创建账号</p>
        </div>
      )}

      <Card className="glass-panel hidden overflow-hidden sm:block">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label="正在加载用户数据" />
            </div>
          ) : users && users.length > 0 ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px] sm:min-w-[860px] md:min-w-[1120px] lg:min-w-[1380px] xl:min-w-[1520px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[60px] whitespace-nowrap">ID</TableHead>
                    <TableHead className="w-[260px] whitespace-nowrap">用户</TableHead>
                    <TableHead className="w-[170px] whitespace-nowrap">流量使用</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap xl:table-cell">Telegram</TableHead>
                    <TableHead className="hidden w-[120px] whitespace-nowrap md:table-cell">余额</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap md:table-cell">到期时间</TableHead>
                    <TableHead className="hidden w-[160px] whitespace-nowrap lg:table-cell">转发总开关</TableHead>
                    <TableHead className="hidden w-[150px] whitespace-nowrap lg:table-cell">规则限制</TableHead>
                    <TableHead className="w-[150px] whitespace-nowrap text-center">账户状态</TableHead>
                    <TableHead className="w-[190px] whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <AutoAnimateContainer as={TableBody}>
                  {pagedUsers.map((u: any) => {
                    const limit = Number(u.trafficLimit) || 0;
                    const used = Number(u.trafficUsed) || 0;
                    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                    const isExpired = u.expiresAt && new Date(u.expiresAt) <= new Date();
                    const isOverLimit = limit > 0 && used >= limit;

                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <span className="text-xs text-muted-foreground font-mono">#{u.id}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <UserAvatar user={u} className="h-8 w-8 shrink-0" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium leading-none">{u.username || "未命名"}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                <Badge variant={u.role === "admin" ? "default" : "outline"} className="h-5 w-fit px-1.5 text-[10px]">
                                  {u.role === "admin" ? "管理员" : "普通用户"}
                                </Badge>
                                {u.id === currentUser?.id && (
                                  <span className="text-[10px] font-medium text-primary">当前登录</span>
                                )}
                              </div>
                              {u.displayRemark && (
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">{u.displayRemark}</p>
                              )}
                              {u.accountEnabled === false && (
                                <Badge variant="destructive" className="mt-1 h-5 w-fit px-1.5 text-[10px]">账户禁用</Badge>
                              )}
                              {u.role !== "admin" && (
                                <div className="mt-2 flex w-fit items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1 lg:hidden">
                                  <Switch
                                    checked={!!u.canAddRules}
                                    disabled={updateForwardAccessMutation.isPending}
                                    onCheckedChange={(checked) => updateForwardAccessMutation.mutate({ userId: u.id, enabled: checked })}
                                    className="shrink-0"
                                  />
                                  <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                                    {u.canAddRules ? "转发启用" : "转发停用"}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1 min-w-[140px]">
                            <div className="flex items-center gap-1">
                              {isOverLimit && (
                                <Badge variant="destructive" className="text-[9px] px-1 py-0 h-3.5">超额</Badge>
                              )}
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {formatBytes(used)} / {limit > 0 ? formatBytes(limit) : "不限"}
                              </span>
                            </div>
                            {limit > 0 && (
                              <Progress
                                value={pct}
                                className={`h-1 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`}
                              />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell">
                          {u.telegramId ? (
                            <div className="flex items-center gap-2">
                              <Send className="h-3.5 w-3.5 text-sky-500" />
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium">
                                  {u.telegramUsername ? `@${u.telegramUsername}` : u.telegramFirstName || u.telegramId}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  {u.telegramLinkedAt ? new Date(u.telegramLinkedAt).toLocaleDateString() : "已绑定"}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">未绑定</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm font-medium">
                            {formatCurrencyCny(u.balanceCents)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <div className="flex items-center gap-1">
                            {u.expiresAt ? (
                              <>
                                <CalendarClock className="h-3 w-3 text-muted-foreground" />
                                <span className={`text-xs ${isExpired ? "text-destructive" : "text-muted-foreground"}`}>
                                  {new Date(u.expiresAt).toLocaleDateString()}
                                </span>
                                {isExpired && (
                                  <Badge variant="destructive" className="text-[9px] px-1 py-0 h-3.5 ml-1">已到期</Badge>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">不限</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden min-w-[160px] lg:table-cell">
                          <div className="flex min-w-[140px] flex-col gap-1">
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              <Switch
                                checked={u.role === "admin" || !!u.canAddRules}
                                disabled={u.role === "admin" || updateForwardAccessMutation.isPending}
                                onCheckedChange={(checked) => updateForwardAccessMutation.mutate({ userId: u.id, enabled: checked })}
                                className="shrink-0"
                              />
                              {u.canAddRules || u.role === "admin" ? (
                                <Badge variant="outline" className="h-5 w-fit shrink-0 whitespace-nowrap border-chart-2/30 px-2 py-0 text-[10px] text-chart-2">
                                  转发启用
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="h-5 w-fit shrink-0 whitespace-nowrap border-muted-foreground/30 px-2 py-0 text-[10px] text-muted-foreground">
                                  转发停用
                                </Badge>
                              )}
                            </div>
                            {u.trafficAutoReset && (
                              <span className="whitespace-nowrap pl-[52px] text-[10px] text-muted-foreground">
                                每月{u.trafficResetDay || 1}日重置
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden min-w-[150px] lg:table-cell">
                          <div className="flex min-w-[130px] flex-col gap-0.5 whitespace-nowrap text-xs leading-5 text-muted-foreground">
                            <span>规则: {u.maxRules ? `最多 ${u.maxRules} 条` : "不限"}</span>
                            <span>端口: {u.maxPorts ? `最多 ${u.maxPorts} 个` : "不限"}</span>
                            <span>连接: {u.maxConnections ? `最多 ${u.maxConnections}` : "不限"}</span>
                            <span>单 IP: {u.maxIPs ? `最多 ${u.maxIPs}` : "不限"}</span>
                            {(Number(u.gostRateLimitIn) > 0 || Number(u.gostRateLimitOut) > 0) && (
                              <span>隧道限速: {formatSpeed(Math.max(Number(u.gostRateLimitIn) || 0, Number(u.gostRateLimitOut) || 0))}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex justify-center">
                            {renderAccountEnabledControl(u)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1 px-2 text-xs"
                              title="流量与权限"
                              onClick={() => openTrafficSettings(u)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              编辑
                            </Button>
                            {renderUserMoreMenu(u, "h-8 gap-1 rounded-md border border-border/50 px-2 text-xs")}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </AutoAnimateContainer>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <UsersIcon className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无其他用户</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                点击"添加用户"按钮创建新用户
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      {!isLoading && users && users.length > 0 && (
        <PersistentPagination pagination={userPagination} itemName="个用户" />
      )}
        </TabsContent>

        <TabsContent value="subscriptions" className="space-y-4 data-[state=inactive]:hidden">
          {subscriptionsLoading ? (
            <DataSectionLoading label="正在加载订阅数据" minHeight="min-h-[240px]" />
          ) : allSubscriptions.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-border/50 bg-card/60 py-16 text-muted-foreground">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/30">
                <Package className="h-7 w-7 opacity-40" />
              </div>
              <p className="text-base font-medium">暂无用户订阅</p>
              <p className="mt-1 text-sm text-muted-foreground/60">分配或购买套餐后会显示在这里。</p>
            </div>
          ) : (
            <>
              <AutoAnimateContainer className="standard-card-grid gap-3">
                {pagedSubscriptions.map((sub: any) => {
                  const active = isSubscriptionActive(sub);
                  const trafficLimit = Number(sub.trafficLimit || 0);
                  const activeAddonBytes = Number(sub.activeTrafficAddonBytes || 0);
                  const canAddAddon = active && trafficLimit > 0;
                  const canExtend = sub.status !== "cancelled" && !!sub.expiresAt;
                  return (
                    <Card key={sub.id} className="border-border/40 bg-card/60">
                      <CardContent className="space-y-3 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{userLabel({ username: sub.username, name: sub.name, id: sub.userId })}</p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{sub.planName || `套餐 #${sub.planId}`}</p>
                          </div>
                          <Badge variant={active ? "default" : "secondary"} className="shrink-0 text-[10px]">
                            {subscriptionStatusLabel(sub.status)}
                          </Badge>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">来源</p>
                            <p className="mt-1 truncate font-medium">{subscriptionSourceLabel(sub.source)}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">端口段</p>
                            <p className="mt-1 truncate font-medium tabular-nums">
                              {sub.portRangeStart && sub.portRangeEnd ? `${sub.portRangeStart}-${sub.portRangeEnd}` : "-"}
                            </p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">套餐流量</p>
                            <p className="mt-1 break-words font-medium">{trafficLimit > 0 ? formatBytes(trafficLimit) : "不限"}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">附加流量</p>
                            <p className="mt-1 break-words font-medium">{activeAddonBytes > 0 ? formatBytes(activeAddonBytes) : "-"}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">到期</p>
                            <p className={`mt-1 truncate font-medium ${sub.expiresAt && !active ? "text-destructive" : ""}`}>{dateText(sub.expiresAt)}</p>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/25 p-2">
                            <p className="text-muted-foreground">流量周期</p>
                            <p className="mt-1 truncate font-medium">{dateTimeText(sub.nextTrafficResetAt)}</p>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 flex-1 px-2 text-xs sm:flex-none"
                            onClick={() => openAddonDialog(sub)}
                            disabled={!canAddAddon || adminAddTrafficAddonMutation.isPending}
                          >
                            加赠流量
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 flex-1 px-2 text-xs sm:flex-none"
                            onClick={() => openExtendDialog(sub)}
                            disabled={!canExtend || extendSubscriptionMutation.isPending}
                          >
                            延长
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 flex-1 px-2 text-xs text-destructive hover:text-destructive sm:flex-none"
                            disabled={!active || cancelSubscriptionMutation.isPending}
                            onClick={() => {
                              if (confirm(`确定取消 ${userLabel({ username: sub.username, name: sub.name, id: sub.userId })} 的订阅吗？`)) {
                                cancelSubscriptionMutation.mutate({ id: Number(sub.id) });
                              }
                            }}
                          >
                            取消
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </AutoAnimateContainer>
              <PersistentPagination pagination={subscriptionPagination} itemName="条订阅" />
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Create User Dialog */}
      <Dialog open={showCreateUser} onOpenChange={setShowCreateUser}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>添加用户</DialogTitle>
          <DialogDescription>创建系统用户。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="create-username">用户名</Label>
              <Input
                id="create-username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="请输入用户名"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">密码</Label>
              <Input
                id="create-password"
                type="password"
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                placeholder="请输入密码（至少6个字符）"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-name">显示名称（可选）</Label>
              <Input
                id="create-name"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="请输入显示名称"
                maxLength={24}
              />
            </div>
            <div className="space-y-2">
              <Label>转发总开关</Label>
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                <div className="min-w-0 pr-3">
                  <p className="text-xs text-muted-foreground">关闭后不能创建或启用规则。</p>
                </div>
                <Switch
                  checked={newCanAddRules}
                  onCheckedChange={setNewCanAddRules}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateUser(false)}>
              取消
            </Button>
            <Button onClick={handleCreateUser} disabled={createUserMutation.isPending}>
              {createUserMutation.isPending ? "创建中..." : "创建用户"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Account Dialog */}
      <Dialog open={showResetPassword} onOpenChange={setShowResetPassword}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>账户信息</DialogTitle>
          <DialogDescription>修改 "{resetUserName}" 的账号信息。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reset-username">账号</Label>
              <Input
                id="reset-username"
                value={resetUsernameInput}
                onChange={(e) => setResetUsernameInput(e.target.value)}
                placeholder="请输入账号"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-display-name">显示名称</Label>
              <Input
                id="reset-display-name"
                value={resetDisplayNameInput}
                onChange={(e) => setResetDisplayNameInput(e.target.value)}
                placeholder="请输入显示名称"
                maxLength={24}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-password">新密码</Label>
              <Input
                id="reset-password"
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                placeholder="留空不修改密码"
              />
            </div>
            <div className="space-y-2">
              <Label>用户头像</Label>
              <AvatarPicker
                value={resetAvatarInput}
                onChange={setResetAvatarInput}
                fallback={resetUserId || resetUsernameInput}
                disabled={resetPasswordMutation.isPending}
                onError={(message) => toast.error(message)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetPassword(false)}>
              取消
            </Button>
            <Button onClick={handleResetPassword} disabled={resetPasswordMutation.isPending}>
              {resetPasswordMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Traffic Dialog */}
      <Dialog open={showResetTraffic} onOpenChange={setShowResetTraffic}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>重置流量</DialogTitle>
          <DialogDescription>
            确认重置 "{resetTrafficUserName}" 的已用流量？
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowResetTraffic(false)}
              disabled={resetTrafficMutation.isPending}
            >
              取消
            </Button>
            <Button onClick={handleResetTraffic} disabled={resetTrafficMutation.isPending}>
              {resetTrafficMutation.isPending ? "重置中..." : "确认重置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRemoveTwoFactor} onOpenChange={setShowRemoveTwoFactor}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>移除双因素认证</DialogTitle>
          <DialogDescription>
            确认移除 "{removeTwoFactorUserName}" 已绑定的 2FA？移除后该用户下次登录不再需要双因素验证码。
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRemoveTwoFactor(false)}
              disabled={removeTwoFactorMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemoveTwoFactor}
              disabled={removeTwoFactorMutation.isPending}
            >
              {removeTwoFactorMutation.isPending ? "移除中..." : "确认移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteUser} onOpenChange={setShowDeleteUser}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>删除用户</DialogTitle>
          <DialogDescription>
            确认删除用户 "{deleteUserName}"？该操作会移除该用户的权限配置，且不可撤销。
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteUser(false)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={handleDeleteUser} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRecharge} onOpenChange={setShowRecharge}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>余额充值</DialogTitle>
          <DialogDescription>给 "{rechargeUserName}" 增加余额。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>充值金额</Label>
              <Input
                type="number"
                min={0.01}
                step="0.01"
                value={rechargeAmount}
                onChange={(e) => setRechargeAmount(e.target.value)}
                placeholder="例如：50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRecharge(false)}>
              取消
            </Button>
            <Button onClick={handleRecharge} disabled={adminRechargeMutation.isPending}>
              {adminRechargeMutation.isPending ? "充值中..." : "确认充值"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSetBalance} onOpenChange={setShowSetBalance}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>修改余额</DialogTitle>
          <DialogDescription>直接设置 "{setBalanceUserName}" 的当前余额。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>当前余额</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={setBalanceAmount}
                onChange={(e) => setSetBalanceAmount(e.target.value)}
                placeholder="例如：50"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSetBalance(false)} disabled={adminSetBalanceMutation.isPending}>
              取消
            </Button>
            <Button onClick={handleSetBalance} disabled={adminSetBalanceMutation.isPending}>
              {adminSetBalanceMutation.isPending ? "修改中..." : "确认修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSendEmail} onOpenChange={setShowSendEmail}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>发送邮件</DialogTitle>
          <DialogDescription>发送给用户 "{emailUserName}" 的已验证邮箱：{emailTo}</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>邮件标题</Label>
              <Input
                value={emailSubject}
                maxLength={120}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="请输入邮件标题"
              />
            </div>
            <div className="space-y-2">
              <Label>邮件内容</Label>
              <textarea
                value={emailContent}
                maxLength={4000}
                onChange={(e) => setEmailContent(e.target.value)}
                placeholder="请输入邮件内容"
                className="flex min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
              <p className="text-right text-xs text-muted-foreground">{emailContent.length}/4000</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendEmail(false)}>
              取消
            </Button>
            <Button onClick={handleSendEmail} disabled={sendEmailMutation.isPending}>
              {sendEmailMutation.isPending ? "发送中..." : "发送邮件"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddonDialog} onOpenChange={setShowAddonDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>加赠本周期流量</DialogTitle>
          <DialogDescription>
            给 "{addonUserName}" 的 {addonSubscriptionLabel || "当前套餐"} 增加仅本周期有效的流量。
          </DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>加赠流量</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={addonTrafficGB}
                  onChange={(e) => setAddonTrafficGB(e.target.value)}
                  placeholder="例如：50"
                />
                <span className="shrink-0 text-sm text-muted-foreground">GB</span>
              </div>
              <p className="text-xs text-muted-foreground">附加流量会在当前套餐流量周期结束或订阅到期时自动失效。</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddonDialog(false)}>
              取消
            </Button>
            <Button onClick={handleAdminAddTrafficAddon} disabled={adminAddTrafficAddonMutation.isPending}>
              {adminAddTrafficAddonMutation.isPending ? "加赠中..." : "确认加赠"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showExtendDialog} onOpenChange={setShowExtendDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>延长订阅时间</DialogTitle>
          <DialogDescription>给 "{extendSubscriptionLabel}" 延长订阅有效期。</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>延长天数</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                step={1}
                value={extendDays}
                onChange={(e) => setExtendDays(e.target.value)}
                placeholder="例如：30"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExtendDialog(false)}>
              取消
            </Button>
            <Button onClick={handleExtendSubscription} disabled={extendSubscriptionMutation.isPending}>
              {extendSubscriptionMutation.isPending ? "延长中..." : "确认延长"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Traffic & Permission Settings Dialog */}
      <Dialog open={showTrafficSettings} onOpenChange={setShowTrafficSettings}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
          <DialogTitle>流量与权限设置</DialogTitle>
          <DialogDescription>设置 "{trafficUserName}" 的配额和权限。</DialogDescription>
          <Tabs defaultValue="permission" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="grid grid-cols-3 w-full">
              <TabsTrigger value="permission" className="gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                <span>权限</span>
              </TabsTrigger>
              <TabsTrigger value="traffic" className="gap-1.5">
                <Database className="h-3.5 w-3.5" />
                <span>流量</span>
              </TabsTrigger>
              <TabsTrigger value="hosts" className="gap-1.5">
                <Server className="h-3.5 w-3.5" />
                <span>授权</span>
              </TabsTrigger>
            </TabsList>

            {/* 权限标签页 */}
            <TabsContent value="permission" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-3 data-[state=inactive]:hidden">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>用户备注</Label>
                    <span className="text-xs text-muted-foreground">{trafficDisplayRemark.trim().length}/24</span>
                  </div>
                  <Input
                    value={trafficDisplayRemark}
                    maxLength={24}
                    onChange={(e) => setTrafficDisplayRemark(e.target.value.slice(0, 24))}
                    placeholder="可选，留空则不显示"
                  />
                </div>
                <div className="space-y-2">
                  <Label>最大规则数</Label>
                  <Input
                    type="number"
                    value={maxRules || ""}
                    onChange={(e) => setMaxRules(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p className="text-xs text-muted-foreground">0 或留空表示不限制</p>
                </div>
                <div className="space-y-2">
                  <Label>最大端口数</Label>
                  <Input
                    type="number"
                    value={maxPorts || ""}
                    onChange={(e) => setMaxPorts(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p className="text-xs text-muted-foreground">0 或留空表示不限制</p>
                </div>
                <div className="space-y-2">
                  <Label>最大连接数</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxConnections || ""}
                    onChange={(e) => setMaxConnections(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p className="text-xs text-muted-foreground">按主机或隧道聚合。</p>
                </div>
                <div className="space-y-2">
                  <Label>单 IP 接入限制</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxIPs || ""}
                    onChange={(e) => setMaxIPs(parseInt(e.target.value) || 0)}
                    placeholder="0=不限制"
                  />
                  <p className="text-xs text-muted-foreground">同一主机或同一隧道下，多条规则共享这个单 IP 接入上限。</p>
                </div>
              </div>
              <Separator />
              <div className="space-y-2">
                <Label className="text-sm font-medium">允许使用的转发方式</Label>
                <p className="text-xs text-muted-foreground">全部关闭则禁止转发。</p>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">iptables</span>
                    <Switch className="shrink-0" checked={allowIptables} onCheckedChange={setAllowIptables} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">nftables</span>
                    <Switch className="shrink-0" checked={allowNftables} onCheckedChange={setAllowNftables} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">realm</span>
                    <Switch className="shrink-0" checked={allowRealm} onCheckedChange={setAllowRealm} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">socat</span>
                    <Switch className="shrink-0" checked={allowSocat} onCheckedChange={setAllowSocat} />
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 px-3 py-2.5">
                    <span className="min-w-0 truncate text-xs font-medium">gost</span>
                    <Switch className="shrink-0" checked={allowGost} onCheckedChange={setAllowGost} />
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* 流量标签页 */}
            <TabsContent value="traffic" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-4 data-[state=inactive]:hidden">
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <Database className="h-3.5 w-3.5" />
                  流量限额
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={trafficLimitInput}
                    onChange={(e) => setTrafficLimitInput(e.target.value)}
                    placeholder="0"
                    className="flex-1"
                  />
                  <span className="text-sm text-muted-foreground select-none">GB</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  单位 GB，0 表示不限。
                </p>
              </div>

              <Separator />

              <div className="space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1.5 text-sm">
                    <Gauge className="h-3.5 w-3.5" />
                    隧道限速
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    对隧道转发生效。
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">最大速度</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.1"
                      value={gostRateLimitInInput}
                      onChange={(e) => {
                        setGostRateLimitInInput(e.target.value);
                        setGostRateLimitOutInput(e.target.value);
                      }}
                      placeholder="0"
                    />
                    <span className="text-xs text-muted-foreground select-none whitespace-nowrap">MB/s</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">填 0 表示不限速。保存后 Agent 刷新隧道配置时生效。</p>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-sm">
                  <CalendarClock className="h-3.5 w-3.5" />
                  到期日期
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={expiresAtInput}
                    onChange={(e) => setExpiresAtInput(e.target.value)}
                    className="flex-1"
                  />
                  {expiresAtInput && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setExpiresAtInput("")}
                    >
                      清空
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  留空表示永久有效。
                </p>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                  <div className="min-w-0 pr-3">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      <RotateCcw className="h-3.5 w-3.5" />
                      启用月度自动重置
                    </p>
                    <p className="text-xs text-muted-foreground">每月自动清零已用流量。</p>
                  </div>
                  <Switch
                    checked={trafficAutoReset}
                    onCheckedChange={(checked) => {
                      setTrafficAutoReset(checked);
                      // 启用时默认以当前日期作为重置日（最大 28）
                      if (checked) {
                        const today = Math.min(new Date().getDate(), 28);
                        setTrafficResetDay(today);
                      }
                    }}
                  />
                </div>
                {trafficAutoReset && (
                  <div className="space-y-2 pt-1">
                    <Label>重置日期（每月第几天）</Label>
                    <Select
                      value={String(trafficResetDay)}
                      onValueChange={(v) => setTrafficResetDay(parseInt(v))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            每月 {d} 日
                            {d === Math.min(new Date().getDate(), 28) ? "（今日）" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      默认以启用当天作为重置日，可修改为每月 1–28 号中任意一天
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* 授权标签页 */}
            <TabsContent value="hosts" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-4 data-[state=inactive]:hidden">
              <p className="text-xs text-muted-foreground">
                默认不展开全部资源，按需选择要授权给该用户的主机、隧道和计费资源。
              </p>

              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">端口转发主机</Label>
                  <Badge variant="outline" className="text-[10px]">{allowedHostIds.length} 台</Badge>
                </div>
                <Select value={addAllowedHostId} onValueChange={addHostPermission} disabled={!availableAllowedHosts.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedHosts.length ? "选择要授权的主机" : "暂无可添加主机"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedHosts.map((h: any) => (
                      <SelectItem key={h.id} value={String(h.id)}>
                        {h.name} {h.ip ? `· ${h.ip}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedHosts.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedHosts.map((h: any) => (
                      <div key={h.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">{h.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono truncate">{h.ip}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          onClick={() => setAllowedHostIds(prev => prev.filter(id => id !== Number(h.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权主机，可从上方选择添加。
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">隧道转发</Label>
                  <Badge variant="outline" className="text-[10px]">{allowedTunnelIds.length} 条</Badge>
                </div>
                <Select value={addAllowedTunnelId} onValueChange={addTunnelPermission} disabled={!availableAllowedTunnels.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableAllowedTunnels.length ? "选择要授权的隧道" : "暂无可添加隧道"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAllowedTunnels.map((t: any) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name} · {tunnelRouteText(t)} :{t.listenPort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAllowedTunnels.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedAllowedTunnels.map((t: any) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{t.name}</span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{String(t.mode || "tls")}</Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {tunnelRouteText(t)} :{t.listenPort}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          onClick={() => setAllowedTunnelIds(prev => prev.filter(id => id !== Number(t.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权隧道，可从上方选择添加。
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">流量计费主机</Label>
                  <Badge variant="outline" className="text-[10px]">{trafficBillingHostIds.length} 台</Badge>
                </div>
                <Select value={addBillingHostId} onValueChange={addTrafficBillingHost} disabled={!availableBillingHosts.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableBillingHosts.length ? "选择要授权计费的主机" : "暂无可添加计费主机"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBillingHosts.map((h: any) => (
                      <SelectItem key={h.id} value={String(h.id)}>
                        {h.name} {h.ip ? `· ${h.ip}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedBillingHosts.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedBillingHosts.map((h: any) => (
                      <div key={h.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{h.name}</span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">{h.ip}</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          onClick={() => setTrafficBillingHostIds(prev => prev.filter(id => id !== Number(h.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权计费主机，可从上方选择添加。
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="text-sm font-medium">流量计费隧道</Label>
                  <Badge variant="outline" className="text-[10px]">{trafficBillingTunnelIds.length} 条</Badge>
                </div>
                <Select value={addBillingTunnelId} onValueChange={addTrafficBillingTunnel} disabled={!availableBillingTunnels.length}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder={availableBillingTunnels.length ? "选择要授权计费的隧道" : "暂无可添加计费隧道"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBillingTunnels.map((t: any) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name} · {tunnelRouteText(t)} :{t.listenPort}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedBillingTunnels.length > 0 ? (
                  <AutoAnimateContainer className="space-y-2">
                    {selectedBillingTunnels.map((t: any) => (
                      <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/50 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{t.name}</span>
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{String(t.mode || "tls")}</Badge>
                          </div>
                          <p className="truncate text-[10px] text-muted-foreground">
                            {tunnelRouteText(t)} :{t.listenPort}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          title="移除授权"
                          onClick={() => setTrafficBillingTunnelIds(prev => prev.filter(id => id !== Number(t.id)))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </AutoAnimateContainer>
                ) : (
                  <p className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    暂未授权计费隧道，可从上方选择添加。
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setShowTrafficSettings(false)}>
              取消
            </Button>
            <Button onClick={handleSaveTrafficSettings} disabled={updateTrafficMutation.isPending}>
              {updateTrafficMutation.isPending ? "保存中..." : "保存设置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

}

export default function Users() {
  return (
    <DashboardLayout>
      <UsersContent />
    </DashboardLayout>
  );
}

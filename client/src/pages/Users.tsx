import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  KeyRound,
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
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";
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
  return user?.displayRemark || user?.username || user?.name || `#${user?.id}`;
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
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [showResetTraffic, setShowResetTraffic] = useState(false);
  const [resetTrafficUserId, setResetTrafficUserId] = useState<number | null>(null);
  const [resetTrafficUserName, setResetTrafficUserName] = useState("");
  const [showRecharge, setShowRecharge] = useState(false);
  const [rechargeUserId, setRechargeUserId] = useState<number | null>(null);
  const [rechargeUserName, setRechargeUserName] = useState("");
  const [rechargeAmount, setRechargeAmount] = useState("");
  const [showSendEmail, setShowSendEmail] = useState(false);
  const [emailUserId, setEmailUserId] = useState<number | null>(null);
  const [emailUserName, setEmailUserName] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailContent, setEmailContent] = useState("");

  // Traffic settings dialog
  const [showTrafficSettings, setShowTrafficSettings] = useState(false);
  const [trafficUserId, setTrafficUserId] = useState<number | null>(null);
  const [trafficUserName, setTrafficUserName] = useState("");
  const [trafficLimitInput, setTrafficLimitInput] = useState("");
  const [gostRateLimitInInput, setGostRateLimitInInput] = useState("");
  const [gostRateLimitOutInput, setGostRateLimitOutInput] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [trafficAutoReset, setTrafficAutoReset] = useState(false);
  const [trafficResetDay, setTrafficResetDay] = useState(1);
  const [maxRules, setMaxRules] = useState(0);
  const [maxPorts, setMaxPorts] = useState(0);
  const [maxConnections, setMaxConnections] = useState(0);
  const [maxIPs, setMaxIPs] = useState(0);
  // 允许使用的转发方式：默认三种全部允许
  const [allowIptables, setAllowIptables] = useState(true);
  const [allowRealm, setAllowRealm] = useState(true);
  const [allowSocat, setAllowSocat] = useState(true);
  const [allowGost, setAllowGost] = useState(true);

  // Agent 权限
  const [allowedHostIds, setAllowedHostIds] = useState<number[]>([]);
  const [allowedTunnelIds, setAllowedTunnelIds] = useState<number[]>([]);
  const { data: allHosts } = trpc.hosts.list.useQuery();
  const { data: allTunnels } = trpc.tunnels.list.useQuery();
  const { data: userHostPerms } = trpc.users.getHostPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
  );
  const { data: userTunnelPerms } = trpc.users.getTunnelPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
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

  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("用户角色已更新");
    },
    onError: (err) => toast.error(err.message || "更新角色失败"),
  });

  const resetPasswordMutation = trpc.users.resetPassword.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("密码已重置");
      setShowResetPassword(false);
      setResetNewPassword("");
    },
    onError: (err) => toast.error(err.message || "重置密码失败"),
  });

  const deleteMutation = trpc.users.delete.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("用户已删除");
    },
    onError: (err) => toast.error(err.message || "删除用户失败"),
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

  const adminRechargeMutation = trpc.billing.adminRecharge.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
      toast.success("余额已充值");
      setShowRecharge(false);
      setRechargeAmount("");
    },
    onError: (err) => toast.error(err.message || "充值失败"),
  });

  const adminCount = useMemo(() => users?.filter((u) => u.role === "admin").length ?? 0, [users]);

  if (currentUser?.role !== "admin") return null;

  const handleCreateUser = () => {
    if (!newUsername.trim()) {
      toast.error("请输入用户名");
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
    if (resetNewPassword.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    resetPasswordMutation.mutate({ userId: resetUserId, newPassword: resetNewPassword });
  };

  const handleResetTraffic = () => {
    if (!resetTrafficUserId) return;
    resetTrafficMutation.mutate({ userId: resetTrafficUserId });
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
      setAllowIptables(true); setAllowRealm(true); setAllowSocat(true); setAllowGost(true);
    } else {
      const set = new Set(allowedRaw.split(",").map((s: string) => s.trim()));
      setAllowIptables(set.has("iptables"));
      setAllowRealm(set.has("realm"));
      setAllowSocat(set.has("socat"));
      setAllowGost(set.has("gost"));
    }
    setAllowedHostIds([]);
    setAllowedTunnelIds([]);
    setShowTrafficSettings(true);
  };

  const handleSaveTrafficSettings = () => {
    if (!trafficUserId) return;
    const limitBytes = parseTrafficInputGB(trafficLimitInput);
    // 拼接转发方式权限：三种都允许时传 null（后端为 null 表示全部）
    const allowed: string[] = [];
    if (allowIptables) allowed.push("iptables");
    if (allowRealm) allowed.push("realm");
    if (allowSocat) allowed.push("socat");
    if (allowGost) allowed.push("gost");
    const allowedForwardTypes = allowed.length === FORWARD_TYPES.length ? null : allowed.join(",");
    const unifiedRateLimit = parseSpeedInputMB(gostRateLimitInInput);
    updateTrafficMutation.mutate({
      userId: trafficUserId,
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
  };

  const toggleHostPermission = (hostId: number) => {
    setAllowedHostIds(prev =>
      prev.includes(hostId) ? prev.filter(id => id !== hostId) : [...prev, hostId]
    );
  };

  const handleRecharge = () => {
    if (!rechargeUserId) return;
    const amountCents = Math.round(Number(rechargeAmount || 0) * 100);
    if (amountCents <= 0) return toast.error("请输入有效充值金额");
    adminRechargeMutation.mutate({ userId: rechargeUserId, amountCents, description: "用户管理手动充值" });
  };

  const toggleTunnelPermission = (tunnelId: number) => {
    setAllowedTunnelIds(prev =>
      prev.includes(tunnelId) ? prev.filter(id => id !== tunnelId) : [...prev, tunnelId]
    );
  };

  const hostNameById = (hostId: number) => allHosts?.find((h: any) => h.id === hostId)?.name || `#${hostId}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">用户管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理系统用户、权限和流量配额
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <ShieldCheck className="h-3 w-3 text-amber-400" />
            {adminCount} 管理员
          </Badge>
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <UsersIcon className="h-3 w-3 text-primary" />
            {users?.length ?? 0} 用户
          </Badge>
          <Button size="sm" onClick={() => setShowCreateUser(true)}>
            <Plus className="h-4 w-4 mr-1" />
            添加用户
          </Button>
        </div>
      </div>

      <Card className="glass-panel overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : users && users.length > 0 ? (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px] sm:min-w-[860px] md:min-w-[1120px] lg:min-w-[1380px] xl:min-w-[1520px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[60px] whitespace-nowrap">ID</TableHead>
                    <TableHead className="w-[240px] whitespace-nowrap">用户</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap sm:table-cell">角色</TableHead>
                    <TableHead className="w-[170px] whitespace-nowrap">流量使用</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap xl:table-cell">Telegram</TableHead>
                    <TableHead className="hidden w-[120px] whitespace-nowrap md:table-cell">余额</TableHead>
                    <TableHead className="hidden w-[140px] whitespace-nowrap md:table-cell">到期时间</TableHead>
                    <TableHead className="hidden w-[160px] whitespace-nowrap lg:table-cell">权限</TableHead>
                    <TableHead className="hidden w-[150px] whitespace-nowrap lg:table-cell">规则限制</TableHead>
                    <TableHead className="w-[190px] whitespace-nowrap text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u: any) => {
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
                            <div className="h-8 w-8 rounded-full bg-muted/50 flex items-center justify-center">
                              {u.role === "admin" ? (
                                <Shield className="h-3.5 w-3.5 text-amber-400" />
                              ) : (
                                <User className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium leading-none">{u.username || "未命名"}</p>
                              {u.displayRemark && (
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">{u.displayRemark}</p>
                              )}
                              {u.id === currentUser?.id && (
                                <p className="text-[10px] text-primary">当前登录</p>
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
                        <TableCell className="hidden sm:table-cell">
                          <Select
                            value={u.role}
                            onValueChange={(v: "user" | "admin") => {
                              if (u.id === currentUser?.id) {
                                toast.error("不能修改自己的角色");
                                return;
                              }
                              updateRoleMutation.mutate({ userId: u.id, role: v });
                            }}
                            disabled={u.id === currentUser?.id}
                          >
                            <SelectTrigger className="w-28 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">
                                <div className="flex items-center gap-1.5">
                                  <Shield className="h-3 w-3 text-amber-400" />
                                  管理员
                                </div>
                              </SelectItem>
                              <SelectItem value="user">
                                <div className="flex items-center gap-1.5">
                                  <User className="h-3 w-3" />
                                  普通用户
                                </div>
                              </SelectItem>
                            </SelectContent>
                          </Select>
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
                            {new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((Number(u.balanceCents) || 0) / 100)}
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
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="余额充值"
                              onClick={() => {
                                setRechargeUserId(u.id);
                                setRechargeUserName(userLabel(u));
                                setRechargeAmount("");
                                setShowRecharge(true);
                              }}
                            >
                              <WalletCards className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="流量与权限设置"
                              onClick={() => openTrafficSettings(u)}
                            >
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title={u.emailVerified ? "发送邮件" : "邮箱未验证"}
                              disabled={!u.emailVerified || !u.email}
                              onClick={() => openSendEmail(u)}
                            >
                              <Mail className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="重置流量"
                              onClick={() => {
                                setResetTrafficUserId(u.id);
                                setResetTrafficUserName(userLabel(u));
                                setShowResetTraffic(true);
                              }}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="重置密码"
                              onClick={() => {
                                setResetUserId(u.id);
                                setResetUserName(userLabel(u));
                                setResetNewPassword("");
                                setShowResetPassword(true);
                              }}
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              disabled={u.id === currentUser?.id}
                              onClick={() => {
                                if (u.id === currentUser?.id) return;
                                if (confirm(`确定要删除用户 "${userLabel(u)}" 吗？`))
                                  deleteMutation.mutate({ userId: u.id });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
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

      {/* Create User Dialog */}
      <Dialog open={showCreateUser} onOpenChange={setShowCreateUser}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>添加用户</DialogTitle>
          <DialogDescription>创建一个新的系统用户</DialogDescription>
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
              />
            </div>
            <div className="space-y-2">
              <Label>转发总开关</Label>
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                <div className="min-w-0 pr-3">
                  <p className="text-xs text-muted-foreground">关闭后用户无法创建转发规则，且已有规则会保持停用</p>
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

      {/* Reset Password Dialog */}
      <Dialog open={showResetPassword} onOpenChange={setShowResetPassword}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>为用户 "{resetUserName}" 设置新密码</DialogDescription>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="reset-password">新密码</Label>
              <Input
                id="reset-password"
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                placeholder="请输入新密码（至少6个字符）"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetPassword(false)}>
              取消
            </Button>
            <Button onClick={handleResetPassword} disabled={resetPasswordMutation.isPending}>
              {resetPasswordMutation.isPending ? "重置中..." : "重置密码"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Traffic Dialog */}
      <Dialog open={showResetTraffic} onOpenChange={setShowResetTraffic}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>重置流量</DialogTitle>
          <DialogDescription>
            确定要重置用户 "{resetTrafficUserName}" 的已用流量吗？此操作不会修改套餐、余额或权限配置。
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

      <Dialog open={showRecharge} onOpenChange={setShowRecharge}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>余额充值</DialogTitle>
          <DialogDescription>为用户 "{rechargeUserName}" 手动增加余额</DialogDescription>
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
                className="flex min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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

      {/* Traffic & Permission Settings Dialog */}
      <Dialog open={showTrafficSettings} onOpenChange={setShowTrafficSettings}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col">
          <DialogTitle>流量与权限设置</DialogTitle>
          <DialogDescription>管理用户 "{trafficUserName}" 的流量配额和权限</DialogDescription>
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
                  <p className="text-xs text-muted-foreground">按用户 + 主机/隧道聚合统计；端口转发按主机，隧道转发按隧道。</p>
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
                <p className="text-xs text-muted-foreground">全部关闭将禁止创建任何转发方式；留空权限时才表示默认全部允许。</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="flex items-center justify-between rounded-lg border border-border/40 p-2">
                    <span className="text-xs font-medium">iptables</span>
                    <Switch checked={allowIptables} onCheckedChange={setAllowIptables} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/40 p-2">
                    <span className="text-xs font-medium">realm</span>
                    <Switch checked={allowRealm} onCheckedChange={setAllowRealm} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/40 p-2">
                    <span className="text-xs font-medium">socat</span>
                    <Switch checked={allowSocat} onCheckedChange={setAllowSocat} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/40 p-2">
                    <span className="text-xs font-medium">gost</span>
                    <Switch checked={allowGost} onCheckedChange={setAllowGost} />
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
                  请输入数字，默认单位为 GB。填 0 表示不限制
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
                    对 GOST 和自定义加密隧道生效；iptables、realm、socat 不受该限速影响。
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
                  不填写到期日期表示永久有效；到期后将自动禁用该用户的所有转发规则
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
                    <p className="text-xs text-muted-foreground">每月指定日期自动将已用流量归零</p>
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

            {/* 主机标签页 */}
            {/* 授权标签页 */}
            <TabsContent value="hosts" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-4 data-[state=inactive]:hidden">
              <p className="text-xs text-muted-foreground">
                分别分配端口转发可用主机，以及隧道转发可用链路。未授权的主机或隧道不会出现在普通用户的创建选项中。
              </p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">端口转发主机</Label>
                  <Badge variant="outline" className="text-[10px]">{allowedHostIds.length} 台</Badge>
                </div>
                {allHosts && allHosts.length > 0 ? (
                  <div className="space-y-2">
                    {allHosts.map((h: any) => (
                      <div key={h.id} className="flex items-center justify-between rounded-lg border border-border/40 p-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">{h.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono truncate">{h.ip}</span>
                        </div>
                        <Switch
                          checked={allowedHostIds.includes(h.id)}
                          onCheckedChange={() => toggleHostPermission(h.id)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">暂无可用主机</p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">隧道转发</Label>
                  <Badge variant="outline" className="text-[10px]">{allowedTunnelIds.length} 条</Badge>
                </div>
                {allTunnels && allTunnels.length > 0 ? (
                  <div className="space-y-2">
                    {allTunnels.map((t: any) => (
                      <div key={t.id} className="flex items-center justify-between rounded-lg border border-border/40 p-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{t.name}</span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{String(t.mode || "tls")}</Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {hostNameById(t.entryHostId)} -&gt; {hostNameById(t.exitHostId)} :{t.listenPort}
                          </p>
                        </div>
                        <Switch
                          checked={allowedTunnelIds.includes(t.id)}
                          onCheckedChange={() => toggleTunnelPermission(t.id)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">暂无可用隧道</p>
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

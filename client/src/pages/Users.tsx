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
} from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

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
  const [newCanAddRules, setNewCanAddRules] = useState(false);

  // Reset password dialog
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetUserId, setResetUserId] = useState<number | null>(null);
  const [resetUserName, setResetUserName] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");

  // Traffic settings dialog
  const [showTrafficSettings, setShowTrafficSettings] = useState(false);
  const [trafficUserId, setTrafficUserId] = useState<number | null>(null);
  const [trafficUserName, setTrafficUserName] = useState("");
  const [trafficLimitInput, setTrafficLimitInput] = useState("");
  const [expiresAtInput, setExpiresAtInput] = useState("");
  const [trafficAutoReset, setTrafficAutoReset] = useState(false);
  const [trafficResetDay, setTrafficResetDay] = useState(1);
  const [canAddRules, setCanAddRules] = useState(false);
  const [maxRules, setMaxRules] = useState(0);
  const [maxPorts, setMaxPorts] = useState(0);
  // 允许使用的转发方式：默认三种全部允许
  const [allowIptables, setAllowIptables] = useState(true);
  const [allowRealm, setAllowRealm] = useState(true);
  const [allowSocat, setAllowSocat] = useState(true);

  // Agent 权限
  const [allowedHostIds, setAllowedHostIds] = useState<number[]>([]);
  const { data: allHosts } = trpc.hosts.list.useQuery();
  const { data: userHostPerms } = trpc.users.getHostPermissions.useQuery(
    { userId: trafficUserId! },
    { enabled: showTrafficSettings && !!trafficUserId }
  );
  const updateHostPermsMutation = trpc.users.setHostPermissions.useMutation({
    onSuccess: () => {
      utils.users.list.invalidate();
    },
    onError: (err) => toast.error(err.message || "更新主机权限失败"),
  });

  // 当权限数据加载完成后同步到状态
  useEffect(() => {
    if (userHostPerms) {
      setAllowedHostIds([...userHostPerms]);
    }
  }, [userHostPerms]);

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
      setNewCanAddRules(false);
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
    },
    onError: (err) => toast.error(err.message || "重置流量失败"),
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

  const openTrafficSettings = (u: any) => {
    if (u.role === "admin") {
      toast.info("管理员默认拥有全部权限，且不受流量/资源限制");
      return;
    }
    setTrafficUserId(u.id);
    setTrafficUserName(u.name || u.username);
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
    setCanAddRules(!!u.canAddRules);
    setMaxRules(u.maxRules || 0);
    setMaxPorts(u.maxPorts || 0);
    // 转发方式权限：allowedForwardTypes 为 null/空串 表示全部允许
    const allowedRaw = (u.allowedForwardTypes as string | null) || "";
    if (!allowedRaw.trim()) {
      setAllowIptables(true); setAllowRealm(true); setAllowSocat(true);
    } else {
      const set = new Set(allowedRaw.split(",").map((s: string) => s.trim()));
      setAllowIptables(set.has("iptables"));
      setAllowRealm(set.has("realm"));
      setAllowSocat(set.has("socat"));
    }
    setAllowedHostIds([]);
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
    const allowedForwardTypes = allowed.length === 3 ? null : allowed.join(",");
    updateTrafficMutation.mutate({
      userId: trafficUserId,
      trafficLimit: limitBytes,
      expiresAt: expiresAtInput || null,
      trafficAutoReset,
      trafficResetDay,
      canAddRules,
      maxRules,
      maxPorts,
      allowedForwardTypes,
    });
    // 同时保存主机权限（改为 tRPC 上的 setHostPermissions）
    updateHostPermsMutation.mutate({
      userId: trafficUserId,
      hostIds: allowedHostIds,
    });
  };

  const toggleHostPermission = (hostId: number) => {
    setAllowedHostIds(prev =>
      prev.includes(hostId) ? prev.filter(id => id !== hostId) : [...prev, hostId]
    );
  };

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

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : users && users.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[60px]">ID</TableHead>
                    <TableHead>用户</TableHead>
                    <TableHead className="hidden sm:table-cell">角色</TableHead>
                    <TableHead>流量使用</TableHead>
                    <TableHead className="hidden md:table-cell">到期时间</TableHead>
                    <TableHead className="hidden lg:table-cell">权限</TableHead>
                    <TableHead className="hidden lg:table-cell">规则限制</TableHead>
                    <TableHead className="text-right">操作</TableHead>
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
                            <div>
                              <p className="font-medium text-sm leading-none">{u.name || "未命名"}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{u.username}</p>
                              {u.id === currentUser?.id && (
                                <p className="text-[10px] text-primary">当前登录</p>
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
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex flex-col gap-0.5">
                            {u.canAddRules || u.role === "admin" ? (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-chart-2/30 text-chart-2 w-fit">
                                可添加规则
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-muted-foreground/30 text-muted-foreground w-fit">
                                仅查看
                              </Badge>
                            )}
                            {u.trafficAutoReset && (
                              <span className="text-[9px] text-muted-foreground">
                                每月{u.trafficResetDay || 1}日重置
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                            <span>规则: {u.maxRules ? `最多 ${u.maxRules} 条` : "不限"}</span>
                            <span>端口: {u.maxPorts ? `最多 ${u.maxPorts} 个` : "不限"}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
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
                              title="重置流量"
                              onClick={() => {
                                if (confirm(`确定要重置用户 "${u.name || u.username}" 的已用流量吗？`))
                                  resetTrafficMutation.mutate({ userId: u.id });
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
                                setResetUserName(u.name || u.username);
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
                                if (confirm(`确定要删除用户 "${u.name || u.username}" 吗？`))
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
              <Label>允许添加规则</Label>
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                <div className="min-w-0 pr-3">
                  <p className="text-xs text-muted-foreground">新用户默认为普通用户，可控制其是否可创建转发规则</p>
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
                <span>主机</span>
              </TabsTrigger>
            </TabsList>

            {/* 权限标签页 */}
            <TabsContent value="permission" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-3 data-[state=inactive]:hidden">
              <div className="flex items-center justify-between rounded-lg border border-border/40 p-3">
                <div className="min-w-0 pr-3">
                  <p className="text-sm font-medium">允许添加转发规则</p>
                  <p className="text-xs text-muted-foreground">关闭后用户将无法创建新的转发规则</p>
                </div>
                <Switch checked={canAddRules} onCheckedChange={setCanAddRules} />
              </div>
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
              </div>
              <Separator />
              <div className="space-y-2">
                <Label className="text-sm font-medium">允许使用的转发方式</Label>
                <p className="text-xs text-muted-foreground">全部关闭会被视为「默认全部允许」。建议至少保留一种。</p>
                <div className="grid grid-cols-3 gap-2">
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
            <TabsContent value="hosts" className="flex-1 min-h-0 overflow-y-auto pr-1 mt-3 space-y-3 data-[state=inactive]:hidden">
              <p className="text-xs text-muted-foreground">
                指定用户可以使用哪些主机进行转发，未勾选的主机将无法添加规则。
              </p>
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

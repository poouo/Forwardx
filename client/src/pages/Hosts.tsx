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
  DialogHeader,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Pencil,
  Server,
  Monitor,
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  LayoutGrid,
  List,
  Download,
  AlertTriangle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function hostAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (host.ipv6) rows.push({ label: "IPv6", value: host.ipv6 });
  if (rows.length === 0 && host.ip) rows.push({ label: "IP", value: host.ip });
  return rows;
}

type HostFormData = {
  name: string;
  ip: string;
  hostType: "master" | "slave";
  networkInterface: string;
  entryIp: string;
  portRangeStart: number | null;
  portRangeEnd: number | null;
};

const defaultFormData: HostFormData = {
  name: "",
  ip: "",
  hostType: "slave",
  networkInterface: "",
  entryIp: "",
  portRangeStart: null,
  portRangeEnd: null,
};

/** 单个主机卡片组件 */
function HostCard({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  canUpgrade,
  latestAgentVersion,
}: {
  host: any;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  canUpgrade: boolean;
  latestAgentVersion?: string;
}) {
  const { data: metrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 1 },
    { refetchInterval: 15000 }
  );
  const latestMetric = metrics?.[0];
  const agentNeedsUpdate = !!host.agentVersion && !!latestAgentVersion && compareVersions(host.agentVersion, latestAgentVersion) < 0;
  const agentUpgrading = !!host.agentUpgradeRequested;

  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md hover:border-border/60 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            {host.name}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!canUpgrade}
              title="升级 Agent"
              onClick={() => onUpgrade(host)}
            >
              {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit(host)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm("确定要删除此主机吗？")) onDelete(host.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 基本信息 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">地址</p>
            <div className="space-y-0.5">
              {hostAddressLines(host).map((item) => (
                <p key={item.label} className="text-sm font-mono">
                  <span className="mr-1 text-[10px] text-muted-foreground">{item.label}</span>
                  {item.value}
                </p>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">状态</p>
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${host.isOnline ? "bg-chart-2 animate-pulse" : "bg-muted-foreground/30"}`} />
              <span className="text-sm">{host.isOnline ? "在线" : "离线"}</span>
            </div>
          </div>
          <div className="space-y-1 col-span-2">
            <p className="text-xs text-muted-foreground">系统</p>
            <p className="text-sm truncate">{host.osInfo || "-"}</p>
          </div>
          <div className="space-y-1 col-span-2">
            <p className="text-xs text-muted-foreground">Agent 版本</p>
            <div className="flex items-center gap-2">
              <p className="text-sm font-mono">{host.agentVersion ? `v${host.agentVersion}` : "-"}</p>
              {agentNeedsUpdate && (
                <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500">
                  发现新版本
                </Badge>
              )}
              {agentUpgrading && (
                <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-500">
                  升级中
                </Badge>
              )}
              {!host.agentVersion && (
                <Badge variant="secondary" className="text-[10px]">
                  未上报
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* 监控数据 */}
        {latestMetric ? (
          <div className="space-y-3 pt-2 border-t border-border/30">
            {/* CPU */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="font-medium tabular-nums">{latestMetric.cpuUsage ?? 0}%</span>
              </div>
              <Progress value={latestMetric.cpuUsage ?? 0} className="h-1.5" />
            </div>
            {/* 内存 - 显示具体数据和百分比 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                <span className="font-medium tabular-nums">
                  {latestMetric.memoryUsed && host.memoryTotal
                    ? `${formatBytes(latestMetric.memoryUsed)} / ${formatBytes(host.memoryTotal)} (${latestMetric.memoryUsage ?? 0}%)`
                    : `${latestMetric.memoryUsage ?? 0}%`}
                </span>
              </div>
              <Progress value={latestMetric.memoryUsage ?? 0} className="h-1.5" />
            </div>
            {/* 磁盘 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> 磁盘</span>
                <span className="font-medium tabular-nums">{latestMetric.diskUsage ?? 0}%</span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className="h-1.5" />
            </div>
            {/* 流量 */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="flex items-center gap-2 text-xs">
                <ArrowDownToLine className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">入站</span>
                <span className="font-medium ml-auto">{formatBytes(latestMetric.networkIn)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <ArrowUpFromLine className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">出站</span>
                <span className="font-medium ml-auto">{formatBytes(latestMetric.networkOut)}</span>
              </div>
            </div>
            {/* 运行时间 */}
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">运行时间</span>
              <span className="font-medium ml-auto">{formatUptime(latestMetric.uptime)}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground/60 border-t border-border/30">
            <p className="text-xs">暂无监控数据</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HostsContent() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: hosts, isLoading } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const latestAgentVersion = systemSettings?.agentVersion || systemSettings?.version;
  const upgradingHosts = useRef<Map<number, string | null>>(new Map());

  const [showDialog, setShowDialog] = useState(false);
  const [upgradeHost, setUpgradeHost] = useState<any>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"card" | "table">("card");
  const [checkingAgentUpdate, setCheckingAgentUpdate] = useState(false);
  const lastAgentUpdateCheck = useRef(0);
  const [form, setForm] = useState<HostFormData>(defaultFormData);

  const createMutation = trpc.hosts.create.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机添加成功");
    },
    onError: (err) => toast.error(err.message || "添加失败"),
  });

  const updateMutation = trpc.hosts.update.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机更新成功");
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      toast.success("主机已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  const upgradeAgentMutation = trpc.hosts.requestAgentUpgrade.useMutation({
    onSuccess: (data) => {
      utils.hosts.list.invalidate();
      setUpgradeHost(null);
      toast.success(data?.pushed ? "Agent 升级任务已推送，正在升级" : "Agent 升级任务已记录，等待 Agent 回连后执行");
    },
    onError: (err) => toast.error(err.message || "下发升级任务失败"),
  });

  useEffect(() => {
    if (!hosts) return;
    const tracked = upgradingHosts.current;
    const currentIds = new Set<number>();
    for (const host of hosts as any[]) {
      currentIds.add(host.id);
      if (host.agentUpgradeRequested) {
        tracked.set(host.id, host.agentUpgradeTargetVersion || latestAgentVersion || null);
        continue;
      }
      if (tracked.has(host.id)) {
        tracked.delete(host.id);
        toast.success(`${host.name} Agent 升级成功，当前版本 ${host.agentVersion ? `v${host.agentVersion}` : "已上报"}`);
      }
    }
    for (const hostId of Array.from(tracked.keys())) {
      if (!currentIds.has(hostId)) tracked.delete(hostId);
    }
  }, [hosts, latestAgentVersion]);

  const resetForm = () => {
    setForm(defaultFormData);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEdit = (host: any) => {
    setForm({
      name: host.name,
      ip: host.ip,
      hostType: host.hostType,
      networkInterface: host.networkInterface || "",
      entryIp: host.entryIp || host.ip || "",
      portRangeStart: host.portRangeStart ?? null,
      portRangeEnd: host.portRangeEnd ?? null,
    });
    setEditingId(host.id);
    setShowDialog(true);
  };

  const handleSubmit = () => {
    const name = (form.name || "").trim();
    const entry = (form.entryIp || "").trim();
    if (!name) { toast.error("请输入主机名称"); return; }
    if (!entry) { toast.error("请输入入口 IP / 域名"); return; }
    if (name.length > 128) { toast.error("主机名称不能超过 128 个字符"); return; }
    if (entry.length > 128) { toast.error("入口 IP / 域名不能超过 128 个字符"); return; }

    const ps = form.portRangeStart;
    const pe = form.portRangeEnd;
    if ((ps != null && pe == null) || (ps == null && pe != null)) {
      toast.error("请同时填写端口区间的起始和结束值，或同时留空"); return;
    }
    if (ps != null && pe != null) {
      if (ps < 1 || ps > 65535 || pe < 1 || pe > 65535) { toast.error("端口区间必须在 1-65535 之间"); return; }
      if (ps > pe) { toast.error("端口区间起始值不能大于结束值"); return; }
    }

    const ni = (form.networkInterface || "").trim();
    const ip = (form.ip || entry || "unknown").trim();

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name,
        ip,
        hostType: form.hostType,
        networkInterface: ni || null,
        entryIp: entry,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
      });
    } else {
      createMutation.mutate({
        name,
        ip,
        hostType: form.hostType,
        networkInterface: ni || undefined,
        entryIp: entry,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
      });
    }
  };
  const isPending = createMutation.isPending || updateMutation.isPending;
  const onlineCount = useMemo(() => hosts?.filter((h) => h.isOnline).length ?? 0, [hosts]);
  const updateCount = useMemo(
    () => hosts?.filter((h) => h.agentVersion && latestAgentVersion && compareVersions(h.agentVersion, latestAgentVersion) < 0).length ?? 0,
    [hosts, latestAgentVersion]
  );
  const requestAgentUpgrade = (host: any) => {
    setUpgradeHost(host);
  };

  const handleCheckAgentUpdate = async () => {
    const now = Date.now();
    const cooldownMs = 30 * 1000;
    const waitMs = cooldownMs - (now - lastAgentUpdateCheck.current);
    if (waitMs > 0) {
      toast.info(`请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
      return;
    }
    try {
      setCheckingAgentUpdate(true);
      lastAgentUpdateCheck.current = now;
      await utils.system.getSettings.invalidate();
      const latestHosts = await utils.hosts.list.fetch();
      const latestSettings = await utils.system.getSettings.fetch();
      const agentVersion = latestSettings?.agentVersion || latestSettings?.version;
      const count = latestHosts.filter((host: any) => host.agentVersion && agentVersion && compareVersions(host.agentVersion, agentVersion) < 0).length;
      toast.success(count > 0 ? `发现 ${count} 台 Agent 有新版本` : "Agent 版本检查完成，暂无新版本");
    } catch (err: any) {
      toast.error(err?.message || "检查 Agent 更新失败");
    } finally {
      setCheckingAgentUpdate(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">主机管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理主控机和被控机，监控运行状态
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <Server className="h-3 w-3 text-chart-2" />
            {onlineCount} / {hosts?.length ?? 0} 在线
          </Badge>
          {/* 布局切换按钮 */}
          {updateCount > 0 && (
            <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs border-amber-500/30 text-amber-500">
              <AlertTriangle className="h-3 w-3" />
              {updateCount} 台发现新版本
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={checkingAgentUpdate}
            onClick={handleCheckAgentUpdate}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingAgentUpdate ? "animate-spin" : ""}`} />
            检查 Agent 更新
          </Button>
          <div className="flex items-center border border-border/40 rounded-md overflow-hidden">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => setViewMode("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => setViewMode("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={() => setLocation("/settings")} className="gap-2">
            <Plus className="h-4 w-4" />
            添加主机
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 w-full rounded-xl" />
          ))}
        </div>
      ) : hosts && hosts.length > 0 ? (
        viewMode === "card" ? (
          /* ========== 卡片式布局 ========== */
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {hosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onEdit={openEdit}
                onDelete={(id) => deleteMutation.mutate({ id })}
                onUpgrade={requestAgentUpgrade}
                canUpgrade={user?.role === "admin"}
                latestAgentVersion={latestAgentVersion}
              />
            ))}
          </div>
        ) : (
          /* ========== 表格式布局 ========== */
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[50px]">状态</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead>地址</TableHead>
                      <TableHead className="hidden md:table-cell">类型</TableHead>
                      <TableHead className="hidden lg:table-cell">端口区间</TableHead>
                      <TableHead className="hidden md:table-cell">系统</TableHead>
                      <TableHead className="hidden lg:table-cell">Agent</TableHead>
                      <TableHead className="hidden sm:table-cell">最后心跳</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hosts.map((host) => (
                      <TableRow key={host.id}>
                        <TableCell>
                          <div className="flex items-center justify-center">
                            {host.isOnline ? (
                              <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                            ) : (
                              <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Server className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{host.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {hostAddressLines(host).map((item) => (
                              <div key={item.label} className="font-mono text-xs">
                                <span className="mr-1 text-[10px] text-muted-foreground">{item.label}</span>
                                {item.value}
                              </div>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${
                              host.hostType === "master"
                                ? "border-amber-500/30 text-amber-400"
                                : "border-blue-500/30 text-blue-400"
                            }`}
                          >
                            {host.hostType === "master" ? "主控" : "被控"}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground font-mono">
                            {(host as any).portRangeStart != null && (host as any).portRangeEnd != null
                              ? `${(host as any).portRangeStart}-${(host as any).portRangeEnd}`
                              : "不限制"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground truncate max-w-[120px] block">
                            {host.osInfo || "-"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-muted-foreground">
                              {host.agentVersion ? `v${host.agentVersion}` : "-"}
                            </span>
                            {host.agentVersion && latestAgentVersion && compareVersions(host.agentVersion, latestAgentVersion) < 0 && (
                              <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500">
                                发现新版本
                              </Badge>
                            )}
                            {host.agentUpgradeRequested && (
                              <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-500">
                                升级中
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {host.lastHeartbeat
                              ? new Date(host.lastHeartbeat).toLocaleString()
                              : "-"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={user?.role !== "admin"}
                              title="升级 Agent"
                              onClick={() => requestAgentUpgrade(host)}
                            >
                              {host.agentUpgradeRequested ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEdit(host)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => {
                                if (confirm("确定要删除此主机吗？"))
                                  deleteMutation.mutate({ id: host.id });
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
            <Server className="h-8 w-8 opacity-40" />
          </div>
          <p className="text-lg font-medium">暂无主机</p>
          <p className="text-sm mt-1 text-muted-foreground/60">
            请联系管理员添加主机
          </p>
        </div>
      )}

      {/* Agent Upgrade Dialog */}
      <Dialog open={!!upgradeHost} onOpenChange={(open) => !open && setUpgradeHost(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              升级 Agent
            </DialogTitle>
            <DialogDescription>
              面板会通过 Agent 长连接立即推送升级任务；如果 Agent 暂时离线，会在回连后继续执行。
            </DialogDescription>
          </DialogHeader>
          {upgradeHost && (
            <div className="space-y-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">主机</span>
                <span className="font-medium">{upgradeHost.name}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">当前 Agent</span>
                <span className="font-mono">{upgradeHost.agentVersion ? `v${upgradeHost.agentVersion}` : "未上报"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">目标版本</span>
                <span className="font-mono">v{latestAgentVersion || "-"}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUpgradeHost(null)}>
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={!upgradeHost || upgradeAgentMutation.isPending}
              onClick={() => upgradeHost && upgradeAgentMutation.mutate({ hostId: upgradeHost.id })}
            >
              {upgradeAgentMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {upgradeAgentMutation.isPending ? "下发中..." : "确认升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加/编辑对话框 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑主机" : "添加主机"}</DialogTitle>
            <DialogDescription>
              {editingId ? "修改主机配置信息" : "添加一台新的主控机或被控机"}
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="basic" className="space-y-4">
            <TabsList className="w-full bg-muted/50">
              <TabsTrigger value="basic" className="flex-1">基本信息</TabsTrigger>
              <TabsTrigger value="port" className="flex-1">端口限制</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label>主机名称</Label>
                  <Input
                    placeholder="例如: 香港节点-01"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>主机类型</Label>
                <Select value={form.hostType} onValueChange={(v) => setForm({ ...form, hostType: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="master">主控机</SelectItem>
                    <SelectItem value="slave">被控机</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>入口 IP / 域名</Label>
                <Input
                  placeholder="例如: example.com 或 1.2.3.4"
                  value={form.entryIp}
                  onChange={(e) => setForm({ ...form, entryIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  用于展示和复制转发入口地址，可以是公网 IPv4、IPv6 或域名。
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                  网卡名称
                  <span className="ml-1 text-xs text-muted-foreground">(可选，留空自动检测)</span>
                </Label>
                <Input
                  placeholder="例如: eth0, ens33, bond0"
                  value={form.networkInterface}
                  onChange={(e) => setForm({ ...form, networkInterface: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  用于 realm 绑定网卡，留空则自动检测默认出口网卡
                </p>
              </div>
            </TabsContent>
            <TabsContent value="port" className="space-y-4">
              <div className="space-y-3">
                <div>
                  <Label className="text-sm font-medium">转发端口区间</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    限制该主机上转发规则的源端口范围，留空则不限制
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">起始端口</Label>
                    <Input
                      type="number"
                      placeholder="例如: 10000"
                      value={form.portRangeStart ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) : null;
                        setForm({ ...form, portRangeStart: v });
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">结束端口</Label>
                    <Input
                      type="number"
                      placeholder="例如: 20000"
                      value={form.portRangeEnd ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) : null;
                        setForm({ ...form, portRangeEnd: v });
                      }}
                    />
                  </div>
                </div>
                {form.portRangeStart != null && form.portRangeEnd != null && (
                  <p className="text-xs text-muted-foreground">
                    可用端口数量: <span className="font-medium">{Math.max(0, form.portRangeEnd - form.portRangeStart + 1)}</span> 个
                  </p>
                )}
                {form.portRangeStart != null && form.portRangeEnd != null && form.portRangeStart > form.portRangeEnd && (
                  <p className="text-xs text-destructive">
                    起始端口不能大于结束端口
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.name || !form.entryIp}>
              {isPending ? "处理中..." : editingId ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Hosts() {
  return (
    <DashboardLayout>
      <HostsContent />
    </DashboardLayout>
  );
}


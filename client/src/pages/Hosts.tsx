import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
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
  Activity,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  LEGACY_PANEL_VERSIONED_AGENT_MAX,
  LEGACY_PANEL_VERSIONED_AGENT_MIN,
} from "@shared/versions";

const AGENT_UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
}

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

function pickLatestVersion(...versions: Array<string | null | undefined>) {
  return versions
    .map(normalizeVersion)
    .filter(Boolean)
    .reduce((latest, version) => (compareVersions(version, latest) > 0 ? version : latest), "");
}

function isLegacyPanelVersionedAgent(version: string | null | undefined) {
  const normalized = normalizeVersion(version);
  return !!normalized
    && compareVersions(normalized, LEGACY_PANEL_VERSIONED_AGENT_MIN) >= 0
    && compareVersions(normalized, LEGACY_PANEL_VERSIONED_AGENT_MAX) <= 0;
}

function isAgentVersionBehind(version: string | null | undefined, target: string | null | undefined) {
  if (!version || !target) return false;
  if (isLegacyPanelVersionedAgent(version)) return true;
  return compareVersions(version, target) < 0;
}

function isAgentUpgradeTimedOut(host: any) {
  if (!host?.agentUpgradeRequested || !host.agentUpgradeRequestedAt) return false;
  const requestedAt = new Date(host.agentUpgradeRequestedAt).getTime();
  return Number.isFinite(requestedAt) && Date.now() - requestedAt > AGENT_UPGRADE_TIMEOUT_MS;
}

function hostAddressLines(host: any) {
  const rows: Array<{ label: string; value: string }> = [];
  if (host.ipv4) rows.push({ label: "IPv4", value: host.ipv4 });
  if (host.ipv6) rows.push({ label: "IPv6", value: host.ipv6 });
  if (rows.length === 0 && host.ip) rows.push({ label: "IP", value: host.ip });
  return rows;
}

function hostAddressText(host: any) {
  const parts: string[] = [];
  if (host.ipv4) parts.push(`IPv4 ${host.ipv4}`);
  if (host.ipv6) parts.push(`IPv6 ${host.ipv6}`);
  if (parts.length === 0 && host.ip) parts.push(`IP ${host.ip}`);
  return parts.join("  /  ") || "-";
}

type HostFormData = {
  name: string;
  ip: string;
  hostType: "master" | "slave";
  networkInterface: string;
  entryIp: string;
  tunnelEntryIp: string;
  portRangeStart: number | null;
  portRangeEnd: number | null;
};

const defaultFormData: HostFormData = {
  name: "",
  ip: "",
  hostType: "slave",
  networkInterface: "",
  entryIp: "",
  tunnelEntryIp: "",
  portRangeStart: null,
  portRangeEnd: null,
};

type HostViewMode = "card" | "table";

const HOST_VIEW_MODE_STORAGE_KEY = "forwardx.hosts.viewMode";

function getStoredHostViewMode(): HostViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(HOST_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeHostViewMode(viewMode: HostViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HOST_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

/** 单个主机卡片组件 */
function HostCard({
  host,
  onEdit,
  onDelete,
  onUpgrade,
  canUpgrade,
  latestAgentVersion,
  refreshInterval,
}: {
  host: any;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  canUpgrade: boolean;
  latestAgentVersion?: string;
  refreshInterval: number | false;
}) {
  const { data: metrics } = trpc.hosts.metrics.useQuery(
    { hostId: host.id, limit: 2 },
    { refetchInterval: refreshInterval }
  );
  const latestMetric = metrics?.[0];
  const previousMetric = metrics?.[1];
  const totalNetworkIn = latestMetric?.networkIn == null ? null : Number(latestMetric.networkIn);
  const totalNetworkOut = latestMetric?.networkOut == null ? null : Number(latestMetric.networkOut);
  const diskUsed = latestMetric?.diskUsed == null ? null : Number(latestMetric.diskUsed);
  const diskTotal = latestMetric?.diskTotal == null ? null : Number(latestMetric.diskTotal);
  const networkSpeed = useMemo(() => {
    if (!latestMetric || !previousMetric) return { in: null as number | null, out: null as number | null };
    const latestAt = new Date(latestMetric.recordedAt).getTime();
    const previousAt = new Date(previousMetric.recordedAt).getTime();
    const seconds = Math.max(1, (latestAt - previousAt) / 1000);
    const inDelta = Math.max(0, Number(latestMetric.networkIn || 0) - Number(previousMetric.networkIn || 0));
    const outDelta = Math.max(0, Number(latestMetric.networkOut || 0) - Number(previousMetric.networkOut || 0));
    return { in: inDelta / seconds, out: outDelta / seconds };
  }, [latestMetric, previousMetric]);
  const agentNeedsUpdate = isAgentVersionBehind(host.agentVersion, latestAgentVersion);
  const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
  const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;

  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md hover:border-border/60 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className="min-w-0 text-base font-semibold">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Monitor className="h-4 w-4 shrink-0" />
              <span className="min-w-0 max-w-full truncate">{host.name}</span>
              <span className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                {host.agentVersion ? `v${host.agentVersion}` : "未上报"}
              </span>
              {agentNeedsUpdate && (
                <Badge variant="outline" className="shrink-0 border-amber-500/30 px-1.5 py-0 text-[10px] text-amber-500">
                  新版
                </Badge>
              )}
              {host.agentUpgradeRequested && (
                <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                  {agentUpgradeTimedOut ? "升级失败" : "升级中"}
                </Badge>
              )}
            </span>
          </CardTitle>
          <div className="flex shrink-0 items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!canUpgrade}
              title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
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
      <CardContent className="space-y-3">
        {/* 基本信息 */}
        <div className="space-y-2">
          <div className="min-w-0 rounded-md border border-border/40 bg-background/30 px-2.5 py-2">
            <p className="truncate font-mono text-xs leading-5" title={hostAddressText(host)}>
              <span className="mr-1.5 text-muted-foreground">地址</span>
              {hostAddressText(host)}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={`h-2 w-2 rounded-full ${host.isOnline ? "bg-chart-2 animate-pulse" : "bg-muted-foreground/30"}`} />
              <span>{host.isOnline ? "在线" : "离线"}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate" title={host.osInfo || ""}>{host.osInfo || "-"}</span>
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
              <p className="truncate text-[11px] text-muted-foreground" title={host.cpuInfo || ""}>
                {host.cpuInfo || "未上报 CPU 型号"}
              </p>
              <Progress value={latestMetric.cpuUsage ?? 0} className="h-1.5" />
            </div>
            {/* 内存 - 显示具体数据和百分比 */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
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
                <span className="max-w-[70%] truncate text-right font-medium tabular-nums">
                  {diskUsed !== null && diskTotal
                    ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)} (${latestMetric.diskUsage ?? 0}%)`
                    : `-- / -- (${latestMetric.diskUsage ?? 0}%)`}
                </span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className="h-1.5" />
            </div>
            {/* 流量 */}
            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
              <div className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowDownToLine className="h-3 w-3" />
                  <span>入站</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">累计</span>
                  <span className="font-medium tabular-nums">{totalNetworkIn === null ? "--" : formatBytes(totalNetworkIn)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">当前</span>
                  <span className="font-medium tabular-nums">{networkSpeed.in === null ? "--/s" : `${formatBytes(networkSpeed.in)}/s`}</span>
                </div>
              </div>
              <div className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ArrowUpFromLine className="h-3 w-3" />
                  <span>出站</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">累计</span>
                  <span className="font-medium tabular-nums">{totalNetworkOut === null ? "--" : formatBytes(totalNetworkOut)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">当前</span>
                  <span className="font-medium tabular-nums">{networkSpeed.out === null ? "--/s" : `${formatBytes(networkSpeed.out)}/s`}</span>
                </div>
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
  const pageVisible = usePageVisible();
  const hostRefreshInterval = pageVisible ? 2000 : false;
  const { data: hosts, isLoading, isError, error, refetch } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: hostRefreshInterval,
    refetchOnWindowFocus: true,
  });
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const latestAgentVersion = useMemo(
    () => systemSettings?.agentVersion || "",
    [systemSettings?.agentVersion]
  );
  const upgradingHosts = useRef<Map<number, string | null>>(new Map());

  const [showDialog, setShowDialog] = useState(false);
  const [upgradeHost, setUpgradeHost] = useState<any>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<HostViewMode>(() => getStoredHostViewMode());
  const [checkingAgentUpdate, setCheckingAgentUpdate] = useState(false);
  const lastAgentUpdateCheck = useRef(0);
  const [form, setForm] = useState<HostFormData>(defaultFormData);
  const watchMetricsMutation = trpc.hosts.watchMetrics.useMutation();

  const handleViewModeChange = (mode: HostViewMode) => {
    setViewMode(mode);
    storeHostViewMode(mode);
  };

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

  useEffect(() => {
    if (!pageVisible || !hosts?.length) return;
    const hostIds = hosts.map((host: any) => Number(host.id)).filter(Boolean);
    if (hostIds.length === 0) return;
    watchMetricsMutation.mutate({ hostIds });
    const timer = window.setInterval(() => {
      watchMetricsMutation.mutate({ hostIds });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pageVisible, hosts]); // eslint-disable-line react-hooks/exhaustive-deps

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
      tunnelEntryIp: host.tunnelEntryIp || "",
      portRangeStart: host.portRangeStart ?? null,
      portRangeEnd: host.portRangeEnd ?? null,
    });
    setEditingId(host.id);
    setShowDialog(true);
  };

  const handleSubmit = () => {
    const name = (form.name || "").trim();
    const entry = (form.entryIp || "").trim();
    const tunnelEntry = (form.tunnelEntryIp || "").trim();
    if (!name) { toast.error("请输入主机名称"); return; }
    if (!entry) { toast.error("请输入入口 IP / 域名"); return; }
    if (name.length > 128) { toast.error("主机名称不能超过 128 个字符"); return; }
    if (entry.length > 128) { toast.error("入口 IP / 域名不能超过 128 个字符"); return; }
    if (tunnelEntry.length > 128) { toast.error("内网地址不能超过 128 个字符"); return; }

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
        tunnelEntryIp: tunnelEntry || null,
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
        tunnelEntryIp: tunnelEntry || undefined,
        portRangeStart: ps ?? null,
        portRangeEnd: pe ?? null,
      });
    }
  };
  const isPending = createMutation.isPending || updateMutation.isPending;
  const onlineCount = useMemo(() => hosts?.filter((h) => h.isOnline).length ?? 0, [hosts]);
  const updateCount = useMemo(
    () => hosts?.filter((h) => isAgentVersionBehind(h.agentVersion, latestAgentVersion)).length ?? 0,
    [hosts, latestAgentVersion]
  );
  const hostPagination = usePersistentPagination(hosts || [], {
    storageKey: "forwardx.hosts.page",
    pageSize: 12,
    isReady: !isLoading && !!hosts,
  });
  const pagedHosts = hostPagination.items;
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
      const agentVersion = latestSettings?.agentVersion || "";
      const count = latestHosts.filter((host: any) => isAgentVersionBehind(host.agentVersion, agentVersion)).length;
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">主机管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理 Agent 主机和运行状态
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Server className="h-3 w-3 text-chart-2" />
            {onlineCount} / {hosts?.length ?? 0} 在线
          </Badge>
          {/* 布局切换按钮 */}
          {updateCount > 0 && (
            <Badge variant="outline" className="justify-center gap-1.5 border-amber-500/30 px-3 py-1.5 text-xs text-amber-500">
              <AlertTriangle className="h-3 w-3" />
              {updateCount} 台发现新版本
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto"
            disabled={checkingAgentUpdate}
            onClick={handleCheckAgentUpdate}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingAgentUpdate ? "animate-spin" : ""}`} />
            检查 Agent 更新
          </Button>
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={() => setLocation("/settings")} className="col-span-2 w-full gap-2 sm:col-span-1 sm:w-auto">
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
      ) : isError ? (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center px-4 py-20 text-center text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertTriangle className="h-8 w-8" />
              </div>
              <p className="text-lg font-medium text-foreground">主机加载失败</p>
              <p className="mt-2 max-w-xl break-words text-sm text-muted-foreground">
                {error?.message || "无法获取主机列表，请稍后重试"}
              </p>
              <Button variant="outline" className="mt-5 gap-2" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4" />
                重新加载
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : hosts && hosts.length > 0 ? (
        <>
        {viewMode === "card" ? (
          /* ========== 卡片式布局 ========== */
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedHosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onEdit={openEdit}
                onDelete={(id) => deleteMutation.mutate({ id })}
                onUpgrade={requestAgentUpgrade}
                canUpgrade={user?.role === "admin"}
                latestAgentVersion={latestAgentVersion}
                refreshInterval={hostRefreshInterval}
              />
            ))}
          </div>
        ) : (
          /* ========== 表格式布局 ========== */
          <>
            <div className="grid grid-cols-1 gap-4 sm:hidden">
              {pagedHosts.map((host) => (
                <HostCard
                  key={host.id}
                  host={host}
                  onEdit={openEdit}
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onUpgrade={requestAgentUpgrade}
                  canUpgrade={user?.role === "admin"}
                  latestAgentVersion={latestAgentVersion}
                  refreshInterval={hostRefreshInterval}
                />
              ))}
            </div>
            <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[50px]">状态</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead className="min-w-[220px]">地址</TableHead>
                      <TableHead className="hidden md:table-cell">类型</TableHead>
                      <TableHead className="hidden lg:table-cell">端口区间</TableHead>
                      <TableHead className="hidden md:table-cell">系统</TableHead>
                      <TableHead className="hidden lg:table-cell">Agent</TableHead>
                      <TableHead className="hidden sm:table-cell">最后心跳</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedHosts.map((host) => {
                      const agentUpgradeTimedOut = isAgentUpgradeTimedOut(host);
                      const agentUpgrading = !!host.agentUpgradeRequested && !agentUpgradeTimedOut;
                      return (
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
                              <div key={item.label} className="flex min-w-0 items-start gap-1 font-mono text-xs leading-5">
                                <span className="shrink-0 text-[10px] text-muted-foreground">{item.label}</span>
                                <span className="min-w-0 max-w-[260px] break-all">{item.value}</span>
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
                            {isAgentVersionBehind(host.agentVersion, latestAgentVersion) && (
                              <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-500">
                                发现新版本
                              </Badge>
                            )}
                            {host.agentUpgradeRequested && (
                              <Badge variant="outline" className={`text-[10px] ${agentUpgradeTimedOut ? "border-destructive/30 text-destructive" : "border-blue-500/30 text-blue-500"}`}>
                                {agentUpgradeTimedOut ? "升级失败" : "升级中"}
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
                              title={agentUpgradeTimedOut ? "升级超时，可重新下发" : "升级 Agent"}
                              onClick={() => requestAgentUpgrade(host)}
                            >
                              {agentUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
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
                    );
                    })}
                  </TableBody>
                </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
        <PersistentPagination pagination={hostPagination} itemName="台主机" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <Server className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无主机</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                请联系管理员添加主机
              </p>
            </div>
          </CardContent>
        </Card>
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
              通过 Agent 下发升级任务。
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
              onClick={() => upgradeHost && upgradeAgentMutation.mutate({ hostId: upgradeHost.id, targetVersion: latestAgentVersion || null })}
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
              {editingId ? "修改主机信息" : "添加 Agent 主机"}
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
                <Label>入口 IP / 域名</Label>
                <Input
                  placeholder="例如: example.com 或 1.2.3.4"
                  value={form.entryIp}
                  onChange={(e) => setForm({ ...form, entryIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  用于转发入口展示和复制。
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                  内网地址
                  <span className="ml-1 text-xs text-muted-foreground">(可选，供隧道链路优先使用)</span>
                </Label>
                <Input
                  placeholder="例如: 10.0.0.8 或 node-a.internal"
                  value={form.tunnelEntryIp}
                  onChange={(e) => setForm({ ...form, tunnelEntryIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  留空则默认使用上方“入口 IP / 域名”。
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
                  留空自动检测默认出口网卡。
                </p>
              </div>
            </TabsContent>
            <TabsContent value="port" className="space-y-4">
              <div className="space-y-3">
                <div>
                  <Label className="text-sm font-medium">转发端口区间</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    留空表示不限制。
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">起始端口</Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
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
                      min={1}
                      max={65535}
                      step={1}
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


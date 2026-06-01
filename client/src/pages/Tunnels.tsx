import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { clipLatencyForChart, getLatencyYAxisMax, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  LayoutGrid,
  List,
  Loader2,
  Network,
  Pencil,
  Plus,
  ShieldCheck,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  FORWARD_PROTOCOL_LABELS,
  normalizeForwardProtocolSettings,
  type ForwardProtocolKey,
} from "@shared/forwardTypes";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import MultiHopEditor from "@/components/MultiHopEditor";

type TunnelForm = {
  name: string;
  entryHostId: number | null;
  exitHostId: number | null;
  hopHostIds: number[];
  hopConnectHosts: Array<string | null>;
  mode: "forwardx" | "tls" | "wss" | "tcp" | "mtls" | "mwss" | "mtcp";
  listenPort: number;
  networkType: "public" | "private";
  connectHost: string;
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
};

type TunnelLatencyPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
};

const defaultForm: TunnelForm = {
  name: "",
  entryHostId: null,
  exitHostId: null,
  hopHostIds: [],
  hopConnectHosts: [],
  mode: "forwardx",
  listenPort: 0,
  networkType: "public",
  connectHost: "",
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
};

function isValidPort(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

function isValidConnectHost(value: string) {
  // 接受 IP 地址或域名。简单验证：非空，不含危险字符。
  const v = value.trim();
  if (!v) return false;
  // Quick sanity: reject strings with obviously invalid characters
  if (/[\s'"<>]/.test(v)) return false;
  if (v.length > 253) return false;
  return true;
}

function sameNumberArray(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNullableStringArray(a: Array<string | null>, b: Array<string | null>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] || null) !== (b[i] || null)) return false;
  }
  return true;
}

function normalizeHopConnectHosts(
  raw: Array<string | null>,
  hostCount: number,
): Array<string | null> {
  const next = [...raw].slice(0, Math.max(0, hostCount));
  while (next.length < hostCount) next.push(null);
  if (hostCount > 0) next[0] = null;
  return next;
}

function tunnelEndpointName(tunnel: any | null | undefined, role: "entry" | "exit", hosts: any[] | undefined) {
  const hostId = Number(role === "entry" ? tunnel?.entryHostId : tunnel?.exitHostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === hostId);
  const fromTunnel = role === "entry" ? tunnel?.entryHost : tunnel?.exitHost;
  return fromList?.name || fromTunnel?.name || `主机 #${hostId}`;
}

const tunnelModeLabels: Record<TunnelForm["mode"], string> = {
  forwardx: "ForwardX",
  tls: "TLS",
  wss: "WSS",
  tcp: "TCP",
  mtls: "MTLS",
  mwss: "MWSS",
  mtcp: "MTCP",
};

const gostTunnelModes: TunnelForm["mode"][] = ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"];
const unsupportedProtocolTitle = "当前不支持，请联系管理员";

type TunnelViewMode = "card" | "table";

const TUNNEL_VIEW_MODE_STORAGE_KEY = "forwardx.tunnels.viewMode";
const MAX_TUNNEL_HOPS = 5;

function getStoredTunnelViewMode(): TunnelViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(TUNNEL_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeTunnelViewMode(viewMode: TunnelViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TUNNEL_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function formatTunnelLatencyTime(value: string | Date) {
  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function TunnelLatencyDialog({
  tunnelId,
  tunnelName,
  open,
  onOpenChange,
}: {
  tunnelId: number;
  tunnelName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading } = trpc.tunnels.latencySeries.useQuery(
    { tunnelId, hours: 24 },
    { enabled: open, refetchInterval: open ? 30000 : false }
  );
  const chartData = useMemo<TunnelLatencyPoint[]>(() => {
    if (!data || data.length === 0) return [];
    return data.map((d: any): TunnelLatencyPoint => ({
      label: formatTunnelLatencyTime(d.recordedAt),
      fullLabel: formatTunnelLatencyTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      chartLatency: d.isTimeout ? 0 : clipLatencyForChart(Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [data]);
  const stats = useMemo(() => {
    const total = chartData.length;
    const timeout = chartData.filter((d) => d.isTimeout).length;
    const lossRate = total > 0 ? Math.round((timeout / total) * 100) : 0;
    const values = chartData
      .filter((d) => !d.isTimeout && d.latency > 0)
      .map((d) => d.latency);
    if (values.length === 0) return { total, timeout, lossRate, max: null as number | null, min: null as number | null, avg: null as number | null };
    const sum = values.reduce((acc: number, v: number) => acc + v, 0);
    return { total, timeout, lossRate, max: Math.max(...values), min: Math.min(...values), avg: Math.round(sum / values.length) };
  }, [chartData]);
  const yMax = useMemo(() => {
    if (chartData.length === 0) return 120;
    const maxVal = Math.max(...chartData.filter((d) => !d.isTimeout).map((d) => d.chartLatency), 0);
    return getLatencyYAxisMax(maxVal, 120);
  }, [chartData]);
  const yTicks = useMemo(() => {
    return getLatencyYAxisTicks(yMax);
  }, [yMax]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">隧道链路延迟 - {tunnelName}</DialogTitle>
          <DialogDescription>最近 24 小时延迟和丢包。</DialogDescription>
        </DialogHeader>
        <div className="h-72 w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无隧道链路延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="tunnelLatencyGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={60} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}ms`} width={50} domain={[0, yMax]} ticks={yTicks} allowDecimals={false} />
                <RTooltip
                  cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                  offset={12}
                  wrapperStyle={{ pointerEvents: "none" }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
                        <p className="mb-1 text-xs text-muted-foreground">{item.fullLabel}</p>
                        {item.isTimeout ? (
                          <p className="text-sm font-semibold text-destructive">超时</p>
                        ) : (
                          <p className="text-sm font-semibold tabular-nums">
                            {item.latency}ms
                          </p>
                        )}
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={2} fill="url(#tunnelLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-latency-stats="true">
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">统计次数</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.total}</p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最大延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.max === null ? "--" : `${stats.max} ms`}</p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">丢包率</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.total === 0 ? "--" : `${stats.lossRate}%`}</p>
          </div>
          <div className="latency-stat-card rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最小延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.min === null ? "--" : `${stats.min} ms`}</p>
          </div>
          <div className="latency-stat-card col-span-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 sm:col-span-1">
            <p className="text-[11px] text-muted-foreground">平均延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.avg === null ? "--" : `${stats.avg} ms`}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TunnelSelfTestDialog({
  tunnelId,
  tunnelName,
  open,
  onOpenChange,
}: {
  tunnelId: number;
  tunnelName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: tunnels } = trpc.tunnels.list.useQuery(undefined, {
    enabled: open,
    refetchInterval: open ? 1500 : false,
    refetchOnWindowFocus: false,
  });
  const tunnel = useMemo(() => tunnels?.find((item: any) => item.id === tunnelId), [tunnels, tunnelId]);
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [startedLastTestAt, setStartedLastTestAt] = useState<string | null>(null);
  const [sawServerTesting, setSawServerTesting] = useState(false);
  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: async () => {
      await utils.tunnels.list.invalidate();
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
      toast.error(e.message || "测试失败");
    },
  });

  const status = tunnel?.lastTestStatus as string | undefined;
  const lastTestAt = tunnel?.lastTestAt ? String(tunnel.lastTestAt) : "";
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const latencyMs = tunnel?.lastLatencyMs;
  const lastFailureToastKey = useRef("");

  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
    }
  }, [open]);

  useEffect(() => {
    if (isServerTesting) setSawServerTesting(true);
  }, [isServerTesting]);

  useEffect(() => {
    if (!optimisticTesting || isServerTesting) return;
    const hasNewTestTimestamp = startedLastTestAt === "__none__"
      ? !!lastTestAt
      : !!lastTestAt && lastTestAt !== startedLastTestAt;
    if (sawServerTesting || hasNewTestTimestamp) {
      setOptimisticTesting(false);
      setStartedLastTestAt(null);
      setSawServerTesting(false);
    }
  }, [isServerTesting, lastTestAt, optimisticTesting, sawServerTesting, startedLastTestAt]);

  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = typeof tunnel?.lastTestMessage === "string" ? tunnel.lastTestMessage.trim() : "";
    if (!isTesting && isFailed && message) {
      const key = `${tunnelId}:${status}:${tunnel?.lastTestAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        toast.error("隧道链路自测失败", {
          description: message,
          duration: 12000,
        });
      }
    }
  }, [open, isTesting, isFailed, status, tunnel?.lastTestAt, tunnel?.lastTestMessage, tunnelId]);

  const statusView = (() => {
    if (isTesting) {
      return (
        <span className="flex items-center gap-2 text-amber-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在测试中
        </span>
      );
    }
    if (isSuccess) {
      return (
        <span className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          正常
        </span>
      );
    }
    if (isFailed) {
      return (
        <span className="flex items-center gap-2 text-destructive">
          <XCircle className="h-4 w-4" />
          异常
        </span>
      );
    }
    return <span className="text-muted-foreground">尚未运行</span>;
  })();

  const reachableView = (() => {
    if (isTesting) return <Loader2 className="h-4 w-4 animate-spin text-amber-600" />;
    if (isSuccess) return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (isFailed) return <XCircle className="h-4 w-4 text-destructive" />;
    return <span className="text-muted-foreground">--</span>;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>隧道链路自测 - {tunnelName}</DialogTitle>
          <DialogDescription>检测隧道链路可达性。多级隧道显示逐跳 TCPing 估算值。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">状态</span>
            <span className="text-sm font-medium">{statusView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">链路可达</span>
            <span className="text-sm font-medium">{reachableView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">链路估算延迟</span>
            <span className="text-sm font-semibold tabular-nums">
              {isTesting ? "正在测试中" : isSuccess && latencyMs !== null && latencyMs !== undefined ? `${latencyMs} ms` : "--"}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            onClick={() => {
              setStartedLastTestAt(lastTestAt || "__none__");
              setSawServerTesting(false);
              setOptimisticTesting(true);
              testMutation.mutate({ id: tunnelId });
            }}
            disabled={isTesting}
            className="gap-2"
          >
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            {isTesting ? "测试中..." : "运行测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TunnelsContent() {
  const utils = trpc.useUtils();
  const { data: tunnels, isLoading } = trpc.tunnels.list.useQuery(undefined, { refetchInterval: 10000 });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TunnelForm>(defaultForm);
  const [latencyTunnel, setLatencyTunnel] = useState<{ id: number; name: string } | null>(null);
  const [testTunnel, setTestTunnel] = useState<{ id: number; name: string } | null>(null);
  const [viewMode, setViewMode] = useState<TunnelViewMode>(() => getStoredTunnelViewMode());

  const forwardProtocolSettings = useMemo(
    () => normalizeForwardProtocolSettings(systemSettings?.forwardProtocols),
    [systemSettings?.forwardProtocols]
  );
  const getTunnelProtocolKey = (tunnel: any | null | undefined): ForwardProtocolKey | null => {
    const mode = String(tunnel?.mode || "").toLowerCase();
    return (["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"] as const).includes(mode as any)
      ? mode as ForwardProtocolKey
      : null;
  };
  const isTunnelSupported = (tunnel: any | null | undefined) => {
    const key = getTunnelProtocolKey(tunnel);
    return !key || forwardProtocolSettings[key] !== false;
  };
  const enabledGostTunnelModes = useMemo(
    () => gostTunnelModes.filter((mode) => forwardProtocolSettings[mode] !== false),
    [forwardProtocolSettings]
  );
  const preferredTunnelRuntime = systemSettings?.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx";
  const resolveDefaultTunnelMode = () => {
    if (preferredTunnelRuntime === "gost") {
      return enabledGostTunnelModes[0] || (forwardProtocolSettings.forwardx !== false ? "forwardx" : "forwardx");
    }
    return forwardProtocolSettings.forwardx !== false
      ? "forwardx"
      : (enabledGostTunnelModes[0] || "forwardx");
  };
  const activeCount = useMemo(() => tunnels?.filter((t: any) => t.isRunning && isTunnelSupported(t)).length ?? 0, [forwardProtocolSettings, tunnels]);
  const tunnelPagination = usePersistentPagination(tunnels || [], {
    storageKey: "forwardx.tunnels.page",
    pageSize: 12,
    isReady: !isLoading && !!tunnels,
  });
  const pagedTunnels = tunnelPagination.items;
  const editingTunnel = useMemo(
    () => editingId ? (tunnels || []).find((tunnel: any) => Number(tunnel.id) === Number(editingId)) || null : null,
    [editingId, tunnels]
  );
  const selectedExitHost = useMemo(
    () => hosts?.find((h: any) => h.id === form.exitHostId),
    [hosts, form.exitHostId]
  );
  const getHostName = (id: number, tunnel?: any, role?: "entry" | "exit") => {
    if (tunnel && role) return tunnelEndpointName(tunnel, role, hosts);
    return hosts?.find((h: any) => h.id === id)?.name || `主机 #${id}`;
  };

  const resetForm = () => {
    const fallbackMode = resolveDefaultTunnelMode();
    setForm({ ...defaultForm, mode: fallbackMode });
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    const fallbackMode = resolveDefaultTunnelMode();
    setForm({
      ...defaultForm,
      mode: fallbackMode,
      entryHostId: null,
      exitHostId: null,
      hopHostIds: [],
      hopConnectHosts: [],
    });
    setShowDialog(true);
  };

  const openEdit = (tunnel: any) => {
    if (!isTunnelSupported(tunnel)) return;
    setForm({
      name: tunnel.name,
      entryHostId: tunnel.entryHostId,
      exitHostId: tunnel.exitHostId,
      hopHostIds: Array.isArray(tunnel.hopHostIds) && tunnel.hopHostIds.length >= 2
        ? tunnel.hopHostIds
        : [tunnel.entryHostId, tunnel.exitHostId],
      hopConnectHosts: Array.isArray(tunnel.hopConnectHosts) && tunnel.hopConnectHosts.length >= 2
        ? tunnel.hopConnectHosts
        : [null, null],
      mode: tunnel.mode || "tls",
      listenPort: tunnel.listenPort,
      networkType: tunnel.networkType === "private" ? "private" : "public",
      connectHost: tunnel.connectHost || "",
      blockHttp: !!tunnel.blockHttp,
      blockSocks: !!tunnel.blockSocks,
      blockTls: !!tunnel.blockTls,
    });
    setEditingId(tunnel.id);
    setShowDialog(true);
  };

  const createMutation = trpc.tunnels.create.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("隧道已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.tunnels.update.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("隧道已更新");
    },
    onError: (e) => toast.error(e.message || "更新失败"),
  });

  const deleteMutation = trpc.tunnels.delete.useMutation({
    onSuccess: () => {
      utils.tunnels.list.invalidate();
      utils.rules.list.invalidate();
      toast.success("隧道已删除");
    },
    onError: (e) => toast.error(e.message || "删除失败"),
  });

  const handleSubmit = () => {
    if (!form.name || form.hopHostIds.length < 2) {
      toast.error("请填写隧道名称并至少选择两台主机");
      return;
    }
    if (form.hopHostIds.length > MAX_TUNNEL_HOPS) {
      toast.error(`多级隧道最多支持 ${MAX_TUNNEL_HOPS} 级`);
      return;
    }
    const orderedHopHostIds = [...form.hopHostIds];
    const orderedHopConnectHosts = [...form.hopConnectHosts].slice(0, orderedHopHostIds.length);
    while (orderedHopConnectHosts.length < orderedHopHostIds.length) orderedHopConnectHosts.push(null);
    if (orderedHopConnectHosts.length > 0) orderedHopConnectHosts[0] = null;
    const entryHostId = orderedHopHostIds[0] || 0;
    const exitHostId = orderedHopHostIds[orderedHopHostIds.length - 1] || 0;
    if (!entryHostId || !exitHostId || entryHostId === exitHostId) {
      toast.error("请确保入口与出口主机有效且不同");
      return;
    }
    if (!isValidPort(form.listenPort, true)) {
      toast.error("出口监听端口必须为 0 或 1-65535，0 表示自动分配");
      return;
    }
    if (!isTunnelSupported(form)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    let hasPrivateHop = false;
    for (let i = 1; i < orderedHopConnectHosts.length; i++) {
      const value = String(orderedHopConnectHosts[i] || "").trim();
      if (value && !isValidConnectHost(value)) {
        toast.error(`第 ${i + 1} 跳指定地址格式无效`);
        return;
      }
      if (!value) continue;
      const hopHostId = Number(orderedHopHostIds[i] || 0);
      const hopHost = hosts?.find((h: any) => Number(h.id) === hopHostId);
      const privateAddr = String((hopHost as any)?.tunnelEntryIp || "").trim();
      if (privateAddr && value === privateAddr) hasPrivateHop = true;
    }
    const payload: any = {
      name: form.name,
      mode: form.mode,
      listenPort: form.listenPort,
      networkType: hasPrivateHop ? "private" : "public",
      connectHost: null,
      blockHttp: form.blockHttp,
      blockSocks: form.blockSocks,
      blockTls: form.blockTls,
      entryHostId,
      exitHostId,
      hopHostIds: orderedHopHostIds,
      hopConnectHosts: orderedHopConnectHosts.map((value) => {
        const text = String(value || "").trim();
        return text ? text : null;
      }),
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;
  const gostRuntimeDisabled = enabledGostTunnelModes.length === 0;
  const forwardxRuntimeDisabled = forwardProtocolSettings.forwardx === false;
  const handleViewModeChange = (nextViewMode: TunnelViewMode) => {
    setViewMode(nextViewMode);
    storeTunnelViewMode(nextViewMode);
  };
  const renderUnsupportedHint = (children: ReactNode) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{unsupportedProtocolTitle}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">隧道管理</h1>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
            管理 Agent 之间的转发链路
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Activity className="h-3 w-3 text-chart-2" />
            {activeCount} / {tunnels?.length ?? 0} 活跃
          </Badge>
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
          <Button
            onClick={openCreate}
            className="gap-2"
            disabled={!hosts || hosts.length < 2 || (forwardProtocolSettings.forwardx === false && enabledGostTunnelModes.length === 0)}
            title={forwardProtocolSettings.forwardx === false && enabledGostTunnelModes.length === 0 ? unsupportedProtocolTitle : undefined}
          >
            <Plus className="h-4 w-4" />
            添加隧道
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="space-y-3 p-6">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          </CardContent>
        </Card>
      ) : tunnels && tunnels.length > 0 ? (
        <>
        {viewMode === "card" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedTunnels.map((tunnel: any) => {
              const supported = isTunnelSupported(tunnel);
              const protocolKey = getTunnelProtocolKey(tunnel);
              return (
                <Card key={tunnel.id} className={`border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`} title={!supported ? unsupportedProtocolTitle : undefined}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                          {!supported ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                          ) : tunnel.isRunning ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                          ) : tunnel.isEnabled ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                          ) : (
                            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{tunnel.name}</p>
                          {!supported && (
                            <p className="mt-1 text-[11px] text-destructive">
                              {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "该协议"} 当前不支持
                            </p>
                          )}
                        </div>
                      </div>
                      {supported ? (
                        <Switch
                          checked={tunnel.isEnabled}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                          className="scale-75"
                        />
                      ) : (
                        renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                      )}
                    </div>

                    <div className="space-y-2 rounded-md bg-muted/25 p-2.5 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">{getHostName(tunnel.entryHostId, tunnel, "entry")}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{getHostName(tunnel.exitHostId, tunnel, "exit")}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {tunnelModeLabels[tunnel.mode as TunnelForm["mode"]] || String(tunnel.mode).toUpperCase()}
                        </Badge>
                        <code className="rounded bg-muted/50 px-1.5 py-0.5">:{tunnel.listenPort}</code>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">延迟</span>
                      {tunnel.lastTestStatus === "success" ? (
                        <span className="flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" />
                          {tunnel.lastLatencyMs}ms
                        </span>
                      ) : tunnel.lastTestStatus === "failed" ? (
                        <span className="flex items-center gap-1 text-destructive">
                          <XCircle className="h-3 w-3" />
                          不可达
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未测试</span>
                      )}
                    </div>

                    <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                      {supported && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="查看延迟" onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="测试延迟" onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Stethoscope className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={!supported ? unsupportedProtocolTitle : undefined}
                        onClick={() => {
                          if (confirm("确定要删除此隧道吗？关联转发规则会解除隧道绑定。")) {
                            deleteMutation.mutate({ id: tunnel.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <>
          <div className="grid gap-3 sm:hidden">
            {pagedTunnels.map((tunnel: any) => {
              const supported = isTunnelSupported(tunnel);
              const protocolKey = getTunnelProtocolKey(tunnel);
              return (
                <Card key={tunnel.id} className={`border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`} title={!supported ? unsupportedProtocolTitle : undefined}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                          {!supported ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                          ) : tunnel.isRunning ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                          ) : tunnel.isEnabled ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                          ) : (
                            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{tunnel.name}</p>
                          {!supported && (
                            <p className="mt-1 text-[11px] text-destructive">
                              {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "该协议"} 当前不支持
                            </p>
                          )}
                        </div>
                      </div>
                      {supported ? (
                        <Switch
                          checked={tunnel.isEnabled}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                          className="scale-75"
                        />
                      ) : (
                        renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                      )}
                    </div>

                    <div className="space-y-2 rounded-md bg-muted/25 p-2.5 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">{getHostName(tunnel.entryHostId, tunnel, "entry")}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{getHostName(tunnel.exitHostId, tunnel, "exit")}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="text-[10px]">
                          {tunnelModeLabels[tunnel.mode as TunnelForm["mode"]] || String(tunnel.mode).toUpperCase()}
                        </Badge>
                        <code className="rounded bg-muted/50 px-1.5 py-0.5">:{tunnel.listenPort}</code>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">延迟</span>
                      {tunnel.lastTestStatus === "success" ? (
                        <span className="flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" />
                          {tunnel.lastLatencyMs}ms
                        </span>
                      ) : tunnel.lastTestStatus === "failed" ? (
                        <span className="flex items-center gap-1 text-destructive">
                          <XCircle className="h-3 w-3" />
                          不可达
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未测试</span>
                      )}
                    </div>

                    <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                      {supported && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="查看延迟" onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="测试延迟" onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}>
                            <Stethoscope className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={!supported ? unsupportedProtocolTitle : undefined}
                        onClick={() => {
                          if (confirm("确定要删除此隧道吗？关联转发规则会解除隧道绑定。")) {
                            deleteMutation.mutate({ id: tunnel.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[60px]">状态</TableHead>
                    <TableHead>隧道名称</TableHead>
                    <TableHead>链路</TableHead>
                    <TableHead className="hidden md:table-cell">模式</TableHead>
                    <TableHead className="hidden md:table-cell">延迟</TableHead>
                    <TableHead>开关</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedTunnels.map((tunnel: any) => {
                    const supported = isTunnelSupported(tunnel);
                    const protocolKey = getTunnelProtocolKey(tunnel);
                    return (
                    <TableRow key={tunnel.id} className={!supported ? "opacity-70" : ""} title={!supported ? unsupportedProtocolTitle : undefined}>
                      <TableCell>
                        <div className="flex items-center justify-center">
                          {!supported ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                          ) : tunnel.isRunning ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                          ) : tunnel.isEnabled ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                          ) : (
                            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{tunnel.name}</span>
                        {!supported && (
                          <span className="mt-1 block text-[11px] text-destructive">
                            {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "该协议"} 当前不支持
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs">
                          <span>{getHostName(tunnel.entryHostId, tunnel, "entry")}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span>{getHostName(tunnel.exitHostId, tunnel, "exit")}</span>
                          <code className="rounded bg-muted/40 px-1.5 py-0.5">:{tunnel.listenPort}</code>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {tunnelModeLabels[tunnel.mode as TunnelForm["mode"]] || String(tunnel.mode).toUpperCase()}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {tunnel.lastTestStatus === "success" ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" />
                            {tunnel.lastLatencyMs}ms
                          </span>
                        ) : tunnel.lastTestStatus === "failed" ? (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <XCircle className="h-3 w-3" />
                            不可达
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">未测试</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {supported ? (
                          <Switch
                            checked={tunnel.isEnabled}
                            onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                            className="scale-75"
                          />
                        ) : (
                          renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {supported && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="查看入口到出口延迟"
                                onClick={() => setLatencyTunnel({ id: tunnel.id, name: tunnel.name })}
                              >
                                <Activity className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="测试入口到出口延迟"
                                onClick={() => setTestTunnel({ id: tunnel.id, name: tunnel.name })}
                              >
                                <Stethoscope className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tunnel)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            title={!supported ? unsupportedProtocolTitle : undefined}
                            onClick={() => {
                              if (confirm("确定要删除此隧道吗？关联转发规则会解除隧道绑定。")) {
                                deleteMutation.mutate({ id: tunnel.id });
                              }
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
          <PersistentPagination pagination={tunnelPagination} itemName="条隧道" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30">
                <Network className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无隧道</p>
              <p className="mt-1 text-sm text-muted-foreground/60">选择两台 Agent 创建第一条隧道</p>
            </div>
          </CardContent>
        </Card>
      )}

      {latencyTunnel && (
        <TunnelLatencyDialog
          tunnelId={latencyTunnel.id}
          tunnelName={latencyTunnel.name}
          open={!!latencyTunnel}
          onOpenChange={(open) => !open && setLatencyTunnel(null)}
        />
      )}
      {testTunnel && (
        <TunnelSelfTestDialog
          tunnelId={testTunnel.id}
          tunnelName={testTunnel.name}
          open={!!testTunnel}
          onOpenChange={(open) => !open && setTestTunnel(null)}
        />
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-4 sm:max-w-2xl sm:p-6">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑隧道" : "添加隧道"}</DialogTitle>
            <DialogDescription>配置入口、出口和监听端口。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 sm:pr-2">
            <div className="space-y-2">
              <Label>隧道名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 华东-香港隧道" />
            </div>
            <div className="space-y-2">
              <Label>主机链路</Label>
              <MultiHopEditor
                hosts={hosts || []}
                initialHopIds={form.hopHostIds}
                initialHopConnectHosts={form.hopConnectHosts}
                maxHops={MAX_TUNNEL_HOPS}
                onChange={(ids) => {
                  setForm((prev) => {
                    const normalizedConnectHosts = normalizeHopConnectHosts(prev.hopConnectHosts, ids.length);
                    const nextEntry = ids[0] ?? null;
                    const nextExit = ids.length > 1 ? ids[ids.length - 1] : null;
                    if (
                      sameNumberArray(prev.hopHostIds, ids)
                      && prev.entryHostId === nextEntry
                      && prev.exitHostId === nextExit
                      && sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)
                    ) {
                      return prev;
                    }
                    return {
                      ...prev,
                      hopHostIds: ids,
                      entryHostId: nextEntry,
                      exitHostId: nextExit,
                      hopConnectHosts: normalizedConnectHosts,
                    };
                  });
                }}
                onConnectHostsChange={(hopConnectHosts) => {
                  setForm((prev) => {
                    const normalizedConnectHosts = normalizeHopConnectHosts(hopConnectHosts, prev.hopHostIds.length);
                    if (sameNullableStringArray(prev.hopConnectHosts, normalizedConnectHosts)) return prev;
                    return { ...prev, hopConnectHosts: normalizedConnectHosts };
                  });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>隧道类型</Label>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextMode = enabledGostTunnelModes.includes(form.mode) ? form.mode : enabledGostTunnelModes[0];
                    if (nextMode) setForm({ ...form, mode: nextMode });
                  }}
                  disabled={gostRuntimeDisabled}
                  title={enabledGostTunnelModes.length === 0 ? unsupportedProtocolTitle : undefined}
                  className={`flex min-h-[92px] items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                    gostTunnelModes.includes(form.mode)
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-background hover:border-primary/40"
                  } ${gostRuntimeDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <Network className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold">GOST 隧道</span>
                    <span className="block text-xs leading-5 text-muted-foreground">使用 GOST 协议。</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      mode: "forwardx",
                    }))
                  }
                  disabled={forwardxRuntimeDisabled}
                  title={forwardProtocolSettings.forwardx === false ? unsupportedProtocolTitle : undefined}
                  className={`flex min-h-[92px] items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                    form.mode === "forwardx"
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-background hover:border-primary/40"
                  } ${forwardxRuntimeDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold">ForwardX 自定义加密</span>
                    <span className="block text-xs leading-5 text-muted-foreground">加密传输，支持统计和限速。</span>
                  </span>
                </button>
              </div>
            </div>
            {form.mode !== "forwardx" && enabledGostTunnelModes.length === 0 && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600">
                {unsupportedProtocolTitle}
              </p>
            )}
            <div className={`grid grid-cols-1 gap-4 ${form.mode === "forwardx" ? "" : "sm:grid-cols-2"}`}>
              {form.mode !== "forwardx" && (
              <div className="space-y-2">
                <Label>GOST 协议</Label>
                    <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as any })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                    {enabledGostTunnelModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>{tunnelModeLabels[mode]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              )}
              <div className="space-y-2">
                <Label>出口监听端口</Label>
                <Input type="number" min={0} max={65535} step={1} value={form.listenPort || ""} onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) || 0 })} placeholder="自动分配" />
                <p className="text-xs text-muted-foreground">留空自动分配。</p>
              </div>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <div>
                <Label className="text-sm">协议屏蔽</Label>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  多级隧道只统计入口或出口，中间节点不重复统计。
                </p>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                  <span className="text-sm font-medium">HTTP</span>
                  <Switch checked={form.blockHttp} onCheckedChange={(checked) => setForm({ ...form, blockHttp: checked })} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                  <span className="text-sm font-medium">SOCKS</span>
                  <Switch checked={form.blockSocks} onCheckedChange={(checked) => setForm({ ...form, blockSocks: checked })} />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/60 px-3 py-2">
                  <span className="text-sm font-medium">TLS</span>
                  <Switch checked={form.blockTls} onCheckedChange={(checked) => setForm({ ...form, blockTls: checked })} />
                </label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending || !isTunnelSupported(form)}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function TunnelsPage() {
  return (
    <DashboardLayout>
      <TunnelsContent />
    </DashboardLayout>
  );
}



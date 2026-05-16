import DashboardLayout from "@/components/DashboardLayout";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Network,
  Pencil,
  Plus,
  ShieldCheck,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

type TunnelForm = {
  name: string;
  entryHostId: number | null;
  exitHostId: number | null;
  mode: "forwardx" | "tls" | "wss" | "tcp" | "mtls" | "mwss" | "mtcp";
  listenPort: number;
};

const defaultForm: TunnelForm = {
  name: "",
  entryHostId: null,
  exitHostId: null,
  mode: "forwardx",
  listenPort: 0,
};

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
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.map((d: any) => ({
      label: formatTunnelLatencyTime(d.recordedAt),
      fullLabel: formatTunnelLatencyTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [data]);
  const stats = useMemo(() => {
    const total = chartData.length;
    const timeout = chartData.filter((d) => d.isTimeout).length;
    const lossRate = total > 0 ? Math.round((timeout / total) * 100) : 0;
    const values = chartData.filter((d) => !d.isTimeout && d.latency > 0).map((d) => d.latency);
    if (values.length === 0) return { total, timeout, lossRate, max: null as number | null, min: null as number | null, avg: null as number | null };
    const sum = values.reduce((acc, v) => acc + v, 0);
    return { total, timeout, lossRate, max: Math.max(...values), min: Math.min(...values), avg: Math.round(sum / values.length) };
  }, [chartData]);
  const yMax = useMemo(() => {
    if (chartData.length === 0) return 120;
    const maxVal = Math.max(...chartData.map((d) => d.latency));
    if (maxVal <= 0) return 120;
    return Math.min(500, Math.max(120, Math.ceil(maxVal * 2)));
  }, [chartData]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">隧道链路延迟 - {tunnelName}</DialogTitle>
          <DialogDescription>展示最近 24 小时入口 Agent 到出口 Agent 的 TCP 连通延迟，不包含转发规则目标端口。</DialogDescription>
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
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}ms`} width={50} domain={[0, yMax]} allowDecimals={false} />
                <RTooltip
                  cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
                        <p className="mb-1 text-xs text-muted-foreground">{item.fullLabel}</p>
                        {item.isTimeout ? (
                          <p className="text-sm font-semibold text-destructive">超时</p>
                        ) : (
                          <p className="text-sm font-semibold tabular-nums">{item.latency}ms</p>
                        )}
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="latency" stroke="var(--color-chart-2)" strokeWidth={2} fill="url(#tunnelLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-5">
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">统计次数</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.total}{stats.timeout > 0 && <span className="ml-1 text-xs font-normal text-amber-600">超时 {stats.timeout}</span>}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最大延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.max === null ? "--" : `${stats.max} ms`}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">丢包率</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.total === 0 ? "--" : `${stats.lossRate}%`}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最小延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{stats.min === null ? "--" : `${stats.min} ms`}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
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
  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: async () => {
      await utils.tunnels.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "测试失败"),
  });

  const status = tunnel?.lastTestStatus as string | undefined;
  const isTesting = testMutation.isPending || status === "pending";
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const latencyMs = tunnel?.lastLatencyMs;

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
          <DialogDescription>检测入口 Agent 到出口 Agent 监听端口的 TCP 可达性和延迟。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">状态</span>
            <span className="text-sm font-medium">{statusView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">入口到出口可达</span>
            <span className="text-sm font-medium">{reachableView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">TCP 延迟</span>
            <span className="text-sm font-semibold tabular-nums">
              {isTesting ? "正在测试中" : isSuccess && latencyMs !== null && latencyMs !== undefined ? `${latencyMs} ms` : "--"}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            onClick={() => testMutation.mutate({ id: tunnelId })}
            disabled={testMutation.isPending}
            className="gap-2"
          >
            {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            运行测试
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
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TunnelForm>(defaultForm);
  const [latencyTunnel, setLatencyTunnel] = useState<{ id: number; name: string } | null>(null);
  const [testTunnel, setTestTunnel] = useState<{ id: number; name: string } | null>(null);

  const activeCount = useMemo(() => tunnels?.filter((t: any) => t.isRunning).length ?? 0, [tunnels]);
  const getHostName = (id: number) => hosts?.find((h: any) => h.id === id)?.name || `主机 #${id}`;

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    if (hosts && hosts.length >= 2) {
      setForm({ ...defaultForm, entryHostId: hosts[0].id, exitHostId: hosts[1].id });
    }
    setShowDialog(true);
  };

  const openEdit = (tunnel: any) => {
    setForm({
      name: tunnel.name,
      entryHostId: tunnel.entryHostId,
      exitHostId: tunnel.exitHostId,
      mode: tunnel.mode || "tls",
      listenPort: tunnel.listenPort,
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
    if (!form.name || !form.entryHostId || !form.exitHostId) {
      toast.error("请填写隧道名称和两台 Agent");
      return;
    }
    if (form.entryHostId === form.exitHostId) {
      toast.error("入口 Agent 和出口 Agent 不能相同");
      return;
    }
    const payload = {
      name: form.name,
      entryHostId: form.entryHostId,
      exitHostId: form.exitHostId,
      mode: form.mode,
      listenPort: form.listenPort,
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">隧道管理</h1>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
            使用两台公网 Agent 组建加密隧道，供转发规则复用
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <Activity className="h-3 w-3 text-chart-2" />
            {activeCount} / {tunnels?.length ?? 0} 活跃
          </Badge>
          <Button onClick={openCreate} className="gap-2" disabled={!hosts || hosts.length < 2}>
            <Plus className="h-4 w-4" />
            添加隧道
          </Button>
        </div>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : tunnels && tunnels.length > 0 ? (
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
                  {tunnels.map((tunnel: any) => (
                    <TableRow key={tunnel.id}>
                      <TableCell>
                        <div className="flex items-center justify-center">
                          {tunnel.isRunning ? (
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
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-xs">
                          <span>{getHostName(tunnel.entryHostId)}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span>{getHostName(tunnel.exitHostId)}</span>
                          <code className="rounded bg-muted/40 px-1.5 py-0.5">:{tunnel.listenPort}</code>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="text-[10px]">
                          {tunnelModeLabels[tunnel.mode as TunnelForm["mode"]] || String(tunnel.mode).toUpperCase()}
                        </Badge>
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
                        <Switch
                          checked={tunnel.isEnabled}
                          onCheckedChange={(checked) => updateMutation.mutate({ id: tunnel.id, isEnabled: checked })}
                          className="scale-75"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
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
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30">
                <Network className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无隧道</p>
              <p className="mt-1 text-sm text-muted-foreground/60">选择两台 Agent 创建第一条隧道</p>
            </div>
          )}
        </CardContent>
      </Card>

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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑隧道" : "添加隧道"}</DialogTitle>
            <DialogDescription>入口 Agent 负责接入和加密，出口 Agent 解密后连接最终目标。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>隧道名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 华东-香港隧道" />
            </div>
            <div className="space-y-2">
              <Label>隧道类型</Label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, mode: gostTunnelModes.includes(form.mode) ? form.mode : "tls" })}
                  className={`flex min-h-[92px] items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                    gostTunnelModes.includes(form.mode)
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-background hover:border-primary/40"
                  }`}
                >
                  <Network className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold">GOST 隧道</span>
                    <span className="block text-xs leading-5 text-muted-foreground">使用 TLS、WSS、TCP、MTLS、MWSS、MTCP 等 GOST 协议。</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, mode: "forwardx" })}
                  className={`flex min-h-[92px] items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                    form.mode === "forwardx"
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-background hover:border-primary/40"
                  }`}
                >
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold">ForwardX 自定义加密</span>
                    <span className="block text-xs leading-5 text-muted-foreground">入口加密，出口解密，支持按规则统计流量和限速。</span>
                  </span>
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>入口 Agent</Label>
                <Select value={form.entryHostId ? String(form.entryHostId) : ""} onValueChange={(v) => setForm({ ...form, entryHostId: Number(v) })}>
                  <SelectTrigger><SelectValue placeholder="选择入口" /></SelectTrigger>
                  <SelectContent>
                    {hosts?.map((h: any) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>出口 Agent</Label>
                <Select value={form.exitHostId ? String(form.exitHostId) : ""} onValueChange={(v) => setForm({ ...form, exitHostId: Number(v) })}>
                  <SelectTrigger><SelectValue placeholder="选择出口" /></SelectTrigger>
                  <SelectContent>
                    {hosts?.map((h: any) => <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className={`grid grid-cols-1 gap-4 ${form.mode === "forwardx" ? "" : "sm:grid-cols-2"}`}>
              {form.mode !== "forwardx" && (
              <div className="space-y-2">
                <Label>GOST 协议</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tls">TLS</SelectItem>
                    <SelectItem value="wss">WSS</SelectItem>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="mtls">MTLS</SelectItem>
                    <SelectItem value="mwss">MWSS</SelectItem>
                    <SelectItem value="mtcp">MTCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              )}
              <div className="space-y-2">
                <Label>出口监听端口</Label>
                <Input type="number" value={form.listenPort || ""} onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) || 0 })} placeholder="自动分配" />
                <p className="text-xs text-muted-foreground">可留空，面板会按出口 Agent 的端口范围自动选择高位可用端口。</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
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


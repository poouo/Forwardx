import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copyTextToClipboard } from "@/lib/clipboard";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Gauge,
  Globe2,
  Loader2,
  RadioTower,
  Route,
  ShieldCheck,
  Terminal,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { toast } from "sonner";

type Method = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp" | "iperf3";
type NetworkMethod = Exclude<Method, "iperf3">;
type RunState = "idle" | "queued" | "running" | "success" | "warning" | "error";
type Iperf3State = "idle" | "queued" | "starting" | "running" | "stopping" | "stopped" | "error";

type LookingGlassResult = {
  taskId: string;
  status?: "queued" | "running" | "success" | "error" | "timeout";
  method: NetworkMethod;
  target: string;
  port?: number;
  sourceHostId?: number;
  sourceHostName?: string;
  resolvedAddress: string;
  resolvedAddresses: string[];
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string | Date;
  finishedAt: string | Date;
  clientIp?: string;
  error?: string;
};

type Iperf3Status = {
  taskId?: string;
  state: Iperf3State;
  port: number;
  output: string;
  pid?: number | null;
  startedAt?: string;
  updatedAt: string;
  error?: string;
  hostId: number;
  hostName: string;
  hostAddress: string;
  commands: {
    upload: string;
    download: string;
  };
};

const methods: Array<{
  value: Method;
  label: string;
  description: string;
  icon: ElementType;
}> = [
  { value: "ping", label: "Ping IPv4", description: "测试 IPv4 ICMP 连通性和往返延迟", icon: Wifi },
  { value: "ping6", label: "Ping IPv6", description: "测试 IPv6 ICMP 连通性和往返延迟", icon: Wifi },
  { value: "traceroute", label: "Traceroute IPv4", description: "查看 IPv4 公网路由路径", icon: Route },
  { value: "traceroute6", label: "Traceroute IPv6", description: "查看 IPv6 公网路由路径", icon: Route },
  { value: "mtr", label: "MTR IPv4", description: "连续检测 IPv4 路由质量和丢包情况", icon: Activity },
  { value: "mtr6", label: "MTR IPv6", description: "连续检测 IPv6 路由质量和丢包情况", icon: Activity },
  { value: "tcp", label: "TCPing", description: "测试目标 TCP 端口连接延迟", icon: RadioTower },
  { value: "iperf3", label: "iperf3 服务端", description: "在选中 Agent 上启动 iperf3 服务端并展示客户端命令", icon: Gauge },
];

const examples = ["1.1.1.1", "8.8.8.8", "github.com", "cloudflare.com"];

function methodMeta(method: Method) {
  return methods.find((item) => item.value === method) || methods[0];
}

function formatDateTime(value: string | Date | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function resultOk(result?: LookingGlassResult | null) {
  return !!result && !result.timedOut && result.exitCode === 0;
}

function buildPendingOutput(method: NetworkMethod, hostName: string, target: string, port?: string) {
  const lines = [
    `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 已创建网络测试任务`,
    `测试主机: ${hostName || "-"}`,
    `测试类型: ${methodMeta(method).label}`,
    `目标地址: ${target || "-"}`,
  ];
  if (method === "tcp") lines.push(`目标端口: ${port || "443"}`);
  lines.push("等待 Agent 拉取任务并执行...");
  return lines.join("\n");
}

function iperf3StateLabel(state?: Iperf3State) {
  if (state === "queued") return "排队中";
  if (state === "starting") return "启动中";
  if (state === "running") return "运行中";
  if (state === "stopping") return "停止中";
  if (state === "stopped") return "已停止";
  if (state === "error") return "异常";
  return "等待";
}

function ResultOutput({
  result,
  liveOutput,
  state,
}: {
  result: LookingGlassResult | null;
  liveOutput: string;
  state: RunState;
}) {
  const isRunning = state === "queued" || state === "running";
  const ok = resultOk(result);
  const title = result ? methodMeta(result.method).label : "网络测试结果";
  const output = result?.output || liveOutput || "选择主机、测试类型和目标后开始执行。";
  const statusLabel = isRunning ? "执行中" : result ? (ok ? "完成" : result.timedOut ? "超时" : "异常") : "等待";

  return (
    <Card className="flex h-[480px] min-w-0 flex-col overflow-hidden border-border/40 bg-card/60 backdrop-blur-md sm:h-[520px] xl:h-[560px]">
      <CardHeader className="shrink-0 border-b border-border/40 bg-muted/20 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
            {isRunning ? (
              <Loader2 className="forwardx-icon-spin h-4 w-4 text-primary" />
            ) : result ? (
              ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <Terminal className="h-4 w-4 text-primary" />
            )}
            <span className="truncate">{title}</span>
            <Badge
              variant={ok && !isRunning ? "secondary" : "outline"}
              className={cn(ok && !isRunning && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}
            >
              {statusLabel}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {result && (
              <>
                <span className="flex items-center gap-1">
                  <Clock3 className="h-3.5 w-3.5" />
                  {result.durationMs} ms
                </span>
                <span className="max-w-32 truncate">{result.sourceHostName || "Agent 主机"}</span>
                <span className="max-w-40 truncate font-mono">{result.resolvedAddress}</span>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={!output.trim()}
              onClick={async () => {
                const copied = await copyTextToClipboard(output);
                if (copied) toast.success("输出已复制");
                else toast.error("复制失败");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
              复制
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <pre className="terminal-scrollbar h-full min-h-0 overflow-auto bg-slate-950 px-4 py-4 font-mono text-xs leading-6 text-slate-100">
          {output}
        </pre>
      </CardContent>
    </Card>
  );
}

function Iperf3Output({
  status,
  loading,
  onCopy,
}: {
  status?: Iperf3Status;
  loading: boolean;
  onCopy: (text: string) => void;
}) {
  const state = status?.state || "idle";
  const isBusy = state === "queued" || state === "starting" || state === "stopping";
  const isRunning = state === "running";
  const output = status?.output || "选择测试主机后点击开始测试，Agent 会启动 iperf3 服务端。";
  const commands = status?.commands;

  return (
    <Card className="flex h-[560px] min-w-0 flex-col overflow-hidden border-border/40 bg-card/60 backdrop-blur-md sm:h-[600px] xl:h-[640px]">
      <CardHeader className="shrink-0 border-b border-border/40 bg-muted/20 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
            {loading || isBusy ? (
              <Loader2 className="forwardx-icon-spin h-4 w-4 text-primary" />
            ) : isRunning ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : state === "error" ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <Gauge className="h-4 w-4 text-primary" />
            )}
            <span className="truncate">iperf3 服务端</span>
            <Badge
              variant={isRunning ? "secondary" : "outline"}
              className={cn(isRunning && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}
            >
              {iperf3StateLabel(state)}
            </Badge>
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={!output.trim()}
            onClick={() => onCopy(output)}
          >
            <Copy className="h-3.5 w-3.5" />
            复制状态
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
        <div className="grid shrink-0 gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">测试主机</p>
            <p className="mt-1 truncate text-sm font-medium">{status?.hostName || "-"}</p>
          </div>
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">监听地址</p>
            <p className="mt-1 break-all font-mono text-sm">{status?.hostAddress || "-"}</p>
          </div>
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">监听端口</p>
            <p className="mt-1 font-mono text-sm">{status?.port ? status.port : "启动后自动分配"}</p>
          </div>
        </div>

        <div className="shrink-0 rounded-lg border border-border/40 bg-muted/20 p-3">
          <p className="text-sm font-medium">客户端运行指令</p>
          <p className="mt-1 text-xs text-muted-foreground">服务端无人使用 3 分钟后会自动停止；客户端测试产生输出时会刷新空闲计时。</p>
          <div className="mt-3 space-y-2">
            <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-background/60 p-2 sm:flex-row sm:items-center sm:justify-between">
              <code className="break-all font-mono text-xs">{commands?.upload || "启动后显示上传测试命令"}</code>
              <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5" disabled={!commands?.upload} onClick={() => commands?.upload && onCopy(commands.upload)}>
                <Copy className="h-3.5 w-3.5" />
                复制
              </Button>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-background/60 p-2 sm:flex-row sm:items-center sm:justify-between">
              <code className="break-all font-mono text-xs">{commands?.download || "启动后显示下载测试命令"}</code>
              <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5" disabled={!commands?.download} onClick={() => commands?.download && onCopy(commands.download)}>
                <Copy className="h-3.5 w-3.5" />
                复制
              </Button>
            </div>
          </div>
        </div>

        {status?.error && <p className="shrink-0 text-xs text-destructive">{status.error}</p>}
        <pre className="terminal-scrollbar min-h-0 flex-1 overflow-auto rounded-lg bg-slate-950 px-4 py-3 font-mono text-xs leading-6 text-slate-100">
          {output}
        </pre>
      </CardContent>
    </Card>
  );
}

export default function LookingGlass() {
  const utils = trpc.useUtils();
  const [method, setMethod] = useState<Method>("ping");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("443");
  const [hostId, setHostId] = useState("");
  const [activeTaskId, setActiveTaskId] = useState("");
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runTick, setRunTick] = useState(0);
  const [latestResult, setLatestResult] = useState<LookingGlassResult | null>(null);
  const [history, setHistory] = useState<LookingGlassResult[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [liveOutput, setLiveOutput] = useState("");
  const completedTaskIdsRef = useRef<Set<string>>(new Set());

  const { data: hosts } = trpc.hosts.list.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const availableHosts = useMemo(() => hosts || [], [hosts]);
  const selectedHost = availableHosts.find((host: any) => String(host.id) === hostId) as any;
  const clientInfo = trpc.lookingGlass.clientInfo.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const iperf3Status = trpc.lookingGlass.iperf3Status.useQuery(
    { hostId: Number(hostId) },
    {
      enabled: Number(hostId) > 0,
      refetchInterval: (query) => {
        const state = (query.state.data as Iperf3Status | undefined)?.state;
        return state === "queued" || state === "starting" || state === "stopping" ? 1000 : state === "running" ? 5000 : false;
      },
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const taskStatus = trpc.lookingGlass.status.useQuery(
    { hostId: Number(hostId), taskId: activeTaskId },
    {
      enabled: Number(hostId) > 0 && !!activeTaskId,
      refetchInterval: (query) => {
        const status = (query.state.data as any)?.status;
        return status === "queued" || status === "running" ? 1000 : false;
      },
      refetchOnWindowFocus: false,
      retry: false,
    },
  );

  const selected = methodMeta(method);
  const Icon = selected.icon;
  const currentIperf3 = iperf3Status.data as Iperf3Status | undefined;
  const iperf3State = currentIperf3?.state || "idle";
  const networkBusy = runState === "queued" || runState === "running" || taskStatus.isFetching && !!activeTaskId;
  const iperf3Busy = iperf3State === "queued" || iperf3State === "starting" || iperf3State === "stopping";
  const iperf3Running = iperf3State === "running";
  const isIperf3Method = method === "iperf3";
  const canSubmit = Number(hostId) > 0 && (isIperf3Method || target.trim().length > 0);
  const resolvedAddresses = useMemo(() => latestResult?.resolvedAddresses || [], [latestResult?.resolvedAddresses]);
  const runningOutput = useMemo(() => {
    if ((runState !== "queued" && runState !== "running") || !runStartedAt) return liveOutput;
    const seconds = Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
    return `${liveOutput}\n运行时间: ${seconds}s`;
  }, [liveOutput, runStartedAt, runState, runTick]);

  const mutation = trpc.lookingGlass.start.useMutation({
    onMutate: () => {
      setRunState("queued");
      setLatestResult(null);
      setActiveTaskId("");
    },
    onSuccess: (result) => {
      const next = result as LookingGlassResult;
      setActiveTaskId(next.taskId);
      setLiveOutput(next.output || "任务已创建，等待 Agent 拉取执行...");
      setRunState(next.status === "running" ? "running" : "queued");
    },
    onError: (error) => {
      setRunState("error");
      setRunStartedAt(null);
      setLiveOutput((value) => `${value}\n执行失败: ${error.message || "测试失败"}`);
      toast.error(error.message || "测试失败");
    },
  });

  const iperf3Start = trpc.lookingGlass.iperf3Start.useMutation({
    onSuccess: (result) => {
      utils.lookingGlass.iperf3Status.setData({ hostId: Number(hostId) }, result as Iperf3Status);
      utils.lookingGlass.iperf3Status.invalidate({ hostId: Number(hostId) });
      toast.success("iperf3 服务端启动任务已下发");
    },
    onError: (error) => {
      toast.error(error.message || "iperf3 服务端启动失败");
    },
  });

  const iperf3Stop = trpc.lookingGlass.iperf3Stop.useMutation({
    onSuccess: (result) => {
      utils.lookingGlass.iperf3Status.setData({ hostId: Number(hostId) }, result as Iperf3Status);
      utils.lookingGlass.iperf3Status.invalidate({ hostId: Number(hostId) });
      toast.success("iperf3 服务端停止任务已下发");
    },
    onError: (error) => {
      toast.error(error.message || "iperf3 服务端停止失败");
    },
  });

  useEffect(() => {
    const status = taskStatus.data as LookingGlassResult | undefined;
    if (!status) return;
    setLiveOutput(status.output || "");
    if (status.status === "queued" || status.status === "running") {
      setRunState(status.status);
      return;
    }
    const completed = { ...status, clientIp: clientInfo.data?.ip || status.clientIp };
    setLatestResult(completed);
    const alreadyCompleted = completedTaskIdsRef.current.has(status.taskId);
    if (!alreadyCompleted) {
      completedTaskIdsRef.current.add(status.taskId);
      setHistory((items) => [completed, ...items].slice(0, 4));
    }
    setRunState(resultOk(status) ? "success" : "warning");
    setRunStartedAt(null);
    if (!alreadyCompleted) {
      if (status.status === "success") toast.success("网络测试完成");
      else if (status.status === "timeout") toast.warning("网络测试超时");
      else toast.warning(status.error || "测试返回异常状态");
    }
    setActiveTaskId("");
  }, [clientInfo.data?.ip, taskStatus.data]);

  useEffect(() => {
    if (!taskStatus.error || !activeTaskId) return;
    setRunState("error");
    setRunStartedAt(null);
    setLiveOutput((value) => `${value}\n状态查询失败: ${taskStatus.error.message}`);
    toast.error(taskStatus.error.message || "状态查询失败");
    setActiveTaskId("");
  }, [activeTaskId, taskStatus.error]);

  useEffect(() => {
    if (hostId || availableHosts.length === 0) return;
    setHostId(String((availableHosts[0] as any).id));
  }, [availableHosts, hostId]);

  useEffect(() => {
    if (runState !== "queued" && runState !== "running") return;
    const timer = window.setInterval(() => setRunTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [runState]);

  const copyText = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    if (copied) toast.success("已复制");
    else toast.error("复制失败");
  };

  const runNetworkTest = () => {
    if (!Number(hostId)) {
      toast.error("请选择测试主机");
      return;
    }
    if (networkBusy) {
      toast.warning("当前已有网络测试正在执行");
      return;
    }
    if (iperf3Running || iperf3Busy) {
      toast.warning("请先等待或停止当前 iperf3 服务端测试");
      return;
    }
    if (!target.trim()) {
      toast.error("请输入目标地址");
      return;
    }
    const numericPort = Number(port);
    if (method === "tcp" && (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)) {
      toast.error("请输入 1-65535 的端口");
      return;
    }
    const networkMethod = method as NetworkMethod;
    setRunState("queued");
    setRunStartedAt(Date.now());
    setLatestResult(null);
    setActiveTaskId("");
    setLiveOutput(buildPendingOutput(networkMethod, selectedHost?.name || "", target.trim(), port));
    mutation.mutate({
      method: networkMethod,
      target: target.trim(),
      hostId: Number(hostId),
      ...(networkMethod === "tcp" ? { port: numericPort } : {}),
    });
  };

  const runIperf3Action = () => {
    if (!Number(hostId)) {
      toast.error("请选择测试主机");
      return;
    }
    if (networkBusy) {
      toast.warning("当前已有网络测试正在执行");
      return;
    }
    if (iperf3Busy || iperf3Start.isPending || iperf3Stop.isPending) {
      toast.warning("iperf3 服务端任务正在处理中");
      return;
    }
    if (iperf3Running) {
      iperf3Stop.mutate({ hostId: Number(hostId) });
      return;
    }
    iperf3Start.mutate({ hostId: Number(hostId) });
  };

  const runTest = () => {
    if (isIperf3Method) runIperf3Action();
    else runNetworkTest();
  };

  const submitDisabled =
    !canSubmit ||
    mutation.isPending ||
    iperf3Start.isPending ||
    iperf3Stop.isPending ||
    networkBusy ||
    iperf3Busy ||
    (!isIperf3Method && iperf3Running);
  const submitLabel = isIperf3Method
    ? iperf3Running
      ? "停止 iperf3 服务端"
      : iperf3Busy || iperf3Start.isPending
        ? "iperf3 处理中..."
        : "启动 iperf3 服务端"
    : mutation.isPending || networkBusy
      ? "测试中..."
      : "开始测试";

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 border-chart-1/30 bg-chart-1/10 text-chart-1">
                <Globe2 className="h-3.5 w-3.5" />
                网络测试
              </Badge>
              <Badge variant="outline" className="gap-1.5 border-chart-4/30 bg-chart-4/10 text-chart-4">
                <ShieldCheck className="h-3.5 w-3.5" />
                公网目标限定
              </Badge>
            </div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">网络测试</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              从已添加的 Agent 主机发起 Ping、Traceroute、MTR、TCPing，或临时启动 iperf3 服务端进行直连测试。
            </p>
          </div>
        </div>

        <Alert className="border-chart-1/25 bg-chart-1/10 text-foreground [&>svg]:text-chart-1">
          <Globe2 className="h-4 w-4" />
          <AlertTitle className="text-chart-1">网络测试</AlertTitle>
          <AlertDescription>
            同一时间只允许执行一个测试。普通网络测试会拒绝内网、环回、链路本地或保留地址；iperf3 服务端空闲 3 分钟后会自动停止。
          </AlertDescription>
        </Alert>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,420px)_1fr]">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="h-5 w-5 text-primary" />
                测试配置
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>测试主机</Label>
                <Select value={hostId} onValueChange={setHostId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 Agent 主机" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableHosts.map((host: any) => (
                      <SelectItem key={host.id} value={String(host.id)}>
                        {host.name}
                        {host.isOnline === false ? " / 离线" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availableHosts.length === 0 && (
                  <p className="text-xs text-muted-foreground">暂无可用主机，请先添加并连接 Agent。</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>测试类型</Label>
                <Select value={method} onValueChange={(value) => setMethod(value as Method)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {methods.map((item) => {
                      const ItemIcon = item.icon;
                      return (
                        <SelectItem key={item.value} value={item.value}>
                          <span className="flex items-center gap-2">
                            <ItemIcon className="h-4 w-4 text-primary" />
                            {item.label}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{selected.description}</p>
              </div>

              {!isIperf3Method && (
                <div className="space-y-2">
                  <Label htmlFor="looking-glass-target">目标地址</Label>
                  <Input
                    id="looking-glass-target"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") runTest();
                    }}
                    placeholder="example.com 或 1.1.1.1"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <div className="flex flex-wrap gap-2">
                    {examples.map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setTarget(example)}
                        className="rounded-full border border-border/50 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {method === "tcp" && (
                <div className="space-y-2">
                  <Label htmlFor="looking-glass-port">目标端口</Label>
                  <Select value={port} onValueChange={setPort}>
                    <SelectTrigger id="looking-glass-port">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="443">443 HTTPS</SelectItem>
                      <SelectItem value="80">80 HTTP</SelectItem>
                      <SelectItem value="22">22 SSH</SelectItem>
                      <SelectItem value="53">53 DNS</SelectItem>
                      <SelectItem value="8443">8443</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={port}
                    onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                    inputMode="numeric"
                    placeholder="自定义端口"
                    className="font-mono"
                  />
                </div>
              )}

              {isIperf3Method && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  Agent 会自动选择一个可用端口启动 iperf3 服务端，启动后右侧会显示正确的客户端命令。请确保服务器安全组和系统防火墙允许客户端访问该端口。
                </div>
              )}

              <Button className="w-full gap-2" onClick={runTest} disabled={submitDisabled}>
                {mutation.isPending || networkBusy || iperf3Start.isPending || iperf3Stop.isPending || iperf3Busy ? (
                  <Loader2 className="forwardx-icon-spin h-4 w-4" />
                ) : isIperf3Method ? (
                  <Gauge className="h-4 w-4" />
                ) : (
                  <Terminal className="h-4 w-4" />
                )}
                {submitLabel}
              </Button>

              {!isIperf3Method && iperf3Running && (
                <p className="text-xs text-amber-600 dark:text-amber-300">当前 iperf3 服务端正在运行，请先切换到 iperf3 服务端并停止后再执行其他测试。</p>
              )}

              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">当前访问 IP</p>
                <p className="mt-1 break-all font-mono text-sm">{clientInfo.data?.ip || "正在获取..."}</p>
              </div>

              {latestResult && !isIperf3Method && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">最近解析</p>
                  <p className="mt-1 font-mono text-sm">{latestResult.resolvedAddress}</p>
                  {resolvedAddresses.length > 1 && (
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{resolvedAddresses.join(", ")}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {isIperf3Method ? (
            <Iperf3Output
              status={currentIperf3}
              loading={iperf3Status.isFetching || iperf3Start.isPending || iperf3Stop.isPending}
              onCopy={copyText}
            />
          ) : (
            <ResultOutput result={latestResult} liveOutput={runningOutput} state={runState} />
          )}
        </div>

        {history.length > 0 && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">最近测试</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {history.map((item, index) => {
                const meta = methodMeta(item.method);
                const ItemIcon = meta.icon;
                return (
                  <button
                    key={`${item.startedAt}-${index}`}
                    type="button"
                    onClick={() => {
                      setLatestResult(item);
                      setMethod(item.method);
                      setRunState(resultOk(item) ? "success" : "warning");
                    }}
                    className="rounded-lg border border-border/40 bg-background/45 p-3 text-left transition-colors hover:border-primary/35 hover:bg-primary/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <ItemIcon className="h-4 w-4 shrink-0 text-primary" />
                        <span className="truncate">{item.target}{item.port ? `:${item.port}` : ""}</span>
                      </span>
                      <Badge variant={resultOk(item) ? "secondary" : "outline"} className="shrink-0">
                        {item.durationMs} ms
                      </Badge>
                    </div>
                    <p className="mt-2 truncate font-mono text-xs text-muted-foreground">{item.resolvedAddress}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{item.sourceHostName || "Agent 主机"} / {formatDateTime(item.startedAt)}</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">访问 IP: {item.clientIp || clientInfo.data?.ip || "-"}</p>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

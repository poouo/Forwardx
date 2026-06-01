import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Globe2,
  Loader2,
  RadioTower,
  Route,
  ShieldCheck,
  Terminal,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

type Method = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp";
type RunState = "idle" | "queued" | "running" | "success" | "warning" | "error";

type LookingGlassResult = {
  taskId: string;
  status?: "queued" | "running" | "success" | "error" | "timeout";
  method: Method;
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
};

const methods: Array<{
  value: Method;
  label: string;
  description: string;
  icon: React.ElementType;
}> = [
  { value: "ping", label: "Ping IPv4", description: "ICMP 连通性与往返延迟", icon: Wifi },
  { value: "ping6", label: "Ping IPv6", description: "IPv6 ICMP 连通性", icon: Wifi },
  { value: "traceroute", label: "Traceroute IPv4", description: "查看公网路由路径", icon: Route },
  { value: "traceroute6", label: "Traceroute IPv6", description: "查看 IPv6 路由路径", icon: Route },
  { value: "mtr", label: "MTR IPv4", description: "连续路由质量报告", icon: Activity },
  { value: "mtr6", label: "MTR IPv6", description: "IPv6 连续路由质量报告", icon: Activity },
  { value: "tcp", label: "TCPing", description: "测试目标端口连接延迟", icon: RadioTower },
];

const examples = ["1.1.1.1", "8.8.8.8", "github.com", "cloudflare.com"];

function formatDateTime(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function methodMeta(method: Method) {
  return methods.find((item) => item.value === method) || methods[0];
}

function resultOk(result?: LookingGlassResult | null) {
  return !!result && !result.timedOut && result.exitCode === 0;
}

function buildPendingOutput(method: Method, hostName: string, target: string, port?: string) {
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
    <Card className="overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
      <CardHeader className="border-b border-border/40 bg-muted/20 px-4 py-3">
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
                <span>{result.sourceHostName || "Agent 主机"}</span>
                <span className="font-mono">{result.resolvedAddress}</span>
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
      <CardContent className="p-0">
        <pre className="min-h-[320px] max-h-[560px] overflow-auto bg-slate-950 px-4 py-4 font-mono text-xs leading-6 text-slate-100 scrollbar-gutter-stable">
          {output}
        </pre>
      </CardContent>
    </Card>
  );
}

export default function LookingGlass() {
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
  const downloadLinks = trpc.lookingGlass.downloadLinks.useQuery(
    { hostId: Number(hostId) },
    {
      enabled: Number(hostId) > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const clientInfo = trpc.lookingGlass.clientInfo.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
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
      setLiveOutput((value) => `${value}\n执行失败: ${error.message || "测试失败"}`);
      toast.error(error.message || "测试失败");
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
    setLatestResult(status);
    const alreadyCompleted = completedTaskIdsRef.current.has(status.taskId);
    if (!alreadyCompleted) {
      completedTaskIdsRef.current.add(status.taskId);
      setHistory((items) => [status, ...items].slice(0, 4));
    }
    setRunState(resultOk(status) ? "success" : "warning");
    if (!alreadyCompleted) {
      if (status.status === "success") toast.success("网络测试完成");
      else if (status.status === "timeout") toast.warning("网络测试超时");
      else toast.warning(status.error || "测试返回异常状态");
    }
    setActiveTaskId("");
  }, [taskStatus.data]);

  useEffect(() => {
    if (!taskStatus.error || !activeTaskId) return;
    setRunState("error");
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

  const selected = methodMeta(method);
  const Icon = selected.icon;
  const canSubmit = Number(hostId) > 0 && target.trim().length > 0;
  const resolvedAddresses = useMemo(() => latestResult?.resolvedAddresses || [], [latestResult?.resolvedAddresses]);
  const runningOutput = useMemo(() => {
    if ((runState !== "queued" && runState !== "running") || !runStartedAt) return liveOutput;
    const seconds = Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
    return `${liveOutput}\n运行时间: ${seconds}s`;
  }, [liveOutput, runStartedAt, runState, runTick]);

  const runTest = () => {
    if (!Number(hostId)) {
      toast.error("请选择测试主机");
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
    setRunState("queued");
    setRunStartedAt(Date.now());
    setLatestResult(null);
    setActiveTaskId("");
    setLiveOutput(buildPendingOutput(method, selectedHost?.name || "", target.trim(), port));
    mutation.mutate({
      method,
      target: target.trim(),
      hostId: Number(hostId),
      ...(method === "tcp" ? { port: numericPort } : {}),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 border-primary/30 bg-primary/10 text-primary">
                <Globe2 className="h-3.5 w-3.5" />
                网络测试
              </Badge>
              <Badge variant="outline" className="gap-1.5 text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                公网目标限定
              </Badge>
            </div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">网络测试</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              从已添加的 Agent 主机发起 Ping、Traceroute、MTR、TCPing，并提供固定大小文件下载测试。
            </p>
          </div>
          <Button variant="outline" className="w-full gap-2 sm:w-auto" asChild>
            <a href="https://github.com/hybula/lookingglass" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              hybula/lookingglass
            </a>
          </Button>
        </div>

        <Alert className="border-sky-500/25 bg-sky-500/10 text-sky-900 dark:text-sky-200">
          <Globe2 className="h-4 w-4" />
          <AlertTitle>网络测试</AlertTitle>
          <AlertDescription>
            固定文件下载测试参考 hybula/lookingglass 的测试文件列表方式实现，ForwardX 会为选中的 Agent 主机生成临时下载链接；网络测试会拒绝内网、环回、链路本地或保留地址。
          </AlertDescription>
        </Alert>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,420px)_1fr]">
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

              {method === "tcp" && (
                <div className="space-y-2">
                  <Label htmlFor="looking-glass-port">端口</Label>
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

              <Button className="w-full gap-2" onClick={runTest} disabled={!canSubmit || mutation.isPending || runState === "queued" || runState === "running"}>
                {mutation.isPending || runState === "queued" || runState === "running" ? <Loader2 className="forwardx-icon-spin h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                {mutation.isPending || runState === "queued" || runState === "running" ? "测试中..." : "开始测试"}
              </Button>

              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">当前访问 IP</p>
                <p className="mt-1 break-all font-mono text-sm">{clientInfo.data?.ip || "正在获取..."}</p>
              </div>

              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">文件下载测试</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      链接由选中的 Agent 主机提供，默认端口 3091。
                    </p>
                  </div>
                  {downloadLinks.isFetching && <Loader2 className="forwardx-icon-spin h-4 w-4 text-muted-foreground" />}
                </div>
                {downloadLinks.error ? (
                  <p className="mt-3 text-xs text-destructive">{downloadLinks.error.message}</p>
                ) : downloadLinks.data ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {downloadLinks.data.files.map((file: any) => (
                      <Button key={file.value} variant="outline" size="sm" asChild className="gap-2">
                        <a href={file.url} target="_blank" rel="noopener noreferrer" download={file.filename}>
                          <Download className="h-4 w-4" />
                          {file.label}
                        </a>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">选择主机后生成下载链接。</p>
                )}
              </div>

              {latestResult && (
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

          <ResultOutput result={latestResult} liveOutput={runningOutput} state={runState} />
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

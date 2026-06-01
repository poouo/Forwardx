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
  ExternalLink,
  Gauge,
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

type SpeedPhase = "idle" | "download" | "upload" | "complete" | "error";
type SpeedPoint = { phase: "download" | "upload"; second: number; rate: number };
type SpeedMetrics = {
  current: number;
  downloadAvg: number;
  uploadAvg: number;
  downloadPeak: number;
  uploadPeak: number;
  downloadBytes: number;
  uploadBytes: number;
  downloadSeconds: number;
  uploadSeconds: number;
};

const initialSpeedMetrics: SpeedMetrics = {
  current: 0,
  downloadAvg: 0,
  uploadAvg: 0,
  downloadPeak: 0,
  uploadPeak: 0,
  downloadBytes: 0,
  uploadBytes: 0,
  downloadSeconds: 0,
  uploadSeconds: 0,
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

function bytesToMbps(bytes: number, seconds: number) {
  return seconds > 0 ? (bytes * 8) / seconds / 1_000_000 : 0;
}

function formatSpeed(value: number) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function formatMegabytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "0.00";
  return (bytes / 1024 / 1024).toFixed(2);
}

function speedErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "速度测试失败");
  if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
    return "浏览器无法直连 Agent 测速端口。请确认选中主机的 3091 端口可公网访问；如果面板使用 HTTPS，测速端口也需要通过 HTTPS 暴露，否则浏览器会拦截跨协议请求。";
  }
  return message;
}

function drawSpeedChart(canvas: HTMLCanvasElement | null, points: SpeedPoint[], previousPoints: SpeedPoint[] = points, progress = 1) {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor((rect.width || 640) * ratio));
  const height = Math.max(220, Math.floor((rect.height || 260) * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(15, 23, 42, 0.96)";
  context.fillRect(0, 0, width, height);

  const padding = { left: 44 * ratio, right: 16 * ratio, top: 22 * ratio, bottom: 30 * ratio };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxRate = Math.max(10, ...points.map((point) => point.rate), ...previousPoints.map((point) => point.rate));
  const pointAt = (items: SpeedPoint[], index: number) => items[Math.min(index, Math.max(0, items.length - 1))] || items[0];
  const smoothPoints = points.map((point, index) => {
    const previous = pointAt(previousPoints, index);
    if (!previous || previous.phase !== point.phase) return point;
    const eased = 1 - Math.pow(1 - progress, 3);
    return {
      ...point,
      second: previous.second + (point.second - previous.second) * eased,
      rate: previous.rate + (point.rate - previous.rate) * eased,
    };
  });
  const toX = (point: SpeedPoint) => {
    const second = point.phase === "download" ? point.second : 10 + point.second;
    return padding.left + (Math.min(20, Math.max(0, second)) / 20) * plotWidth;
  };
  const toY = (rate: number) => padding.top + plotHeight - (Math.min(maxRate, rate) / maxRate) * plotHeight;

  context.strokeStyle = "rgba(148, 163, 184, 0.18)";
  context.lineWidth = ratio;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotHeight * i) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  const splitX = padding.left + plotWidth / 2;
  context.strokeStyle = "rgba(148, 163, 184, 0.28)";
  context.beginPath();
  context.moveTo(splitX, padding.top);
  context.lineTo(splitX, padding.top + plotHeight);
  context.stroke();

  context.fillStyle = "rgba(203, 213, 225, 0.82)";
  context.font = `${12 * ratio}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  context.fillText(`${maxRate.toFixed(1)} Mbps`, 8 * ratio, padding.top + 4 * ratio);
  context.fillText("下载 10s", padding.left, height - 9 * ratio);
  context.fillText("上传 10s", splitX + 10 * ratio, height - 9 * ratio);

  const drawLine = (phase: "download" | "upload", color: string) => {
    const phasePoints = smoothPoints.filter((point) => point.phase === phase);
    if (phasePoints.length < 2) return;
    context.beginPath();
    phasePoints.forEach((point, index) => {
      const x = toX(point);
      const y = toY(point.rate);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = 2.4 * ratio;
    context.stroke();
  };

  drawLine("download", "#38bdf8");
  drawLine("upload", "#22c55e");
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
  speedPhase,
  speedMetrics,
  speedPoints,
  speedCanvasRef,
  speedMessage,
}: {
  result: LookingGlassResult | null;
  liveOutput: string;
  state: RunState;
  speedPhase: SpeedPhase;
  speedMetrics: SpeedMetrics;
  speedPoints: SpeedPoint[];
  speedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  speedMessage: string;
}) {
  const isRunning = state === "queued" || state === "running";
  const ok = resultOk(result);
  const title = result ? methodMeta(result.method).label : "网络测试结果";
  const output = result?.output || liveOutput || "选择主机、测试类型和目标后开始执行。";
  const statusLabel = isRunning ? "执行中" : result ? (ok ? "完成" : result.timedOut ? "超时" : "异常") : "等待";
  const hasSpeedResult = speedPhase !== "idle" || speedPoints.length > 0;
  const speedRunning = speedPhase === "download" || speedPhase === "upload";

  return (
    <div className="space-y-5">
      {hasSpeedResult && (
        <Card className="overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="border-b border-border/40 bg-muted/20 px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                {speedRunning ? <Loader2 className="forwardx-icon-spin h-4 w-4 text-primary" /> : <Gauge className="h-4 w-4 text-primary" />}
                <span>速度测试</span>
                <Badge variant={speedPhase === "complete" ? "secondary" : "outline"}>
                  {speedPhase === "download" ? "下载中" : speedPhase === "upload" ? "上传中" : speedPhase === "complete" ? "完成" : speedPhase === "error" ? "异常" : "等待"}
                </Badge>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>当前 {formatSpeed(speedMetrics.current)} Mbps</span>
                <span>下载峰值 {formatSpeed(speedMetrics.downloadPeak)} Mbps</span>
                <span>上传峰值 {formatSpeed(speedMetrics.uploadPeak)} Mbps</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">当前速率</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatSpeed(speedMetrics.current)}</p>
                <p className="text-[11px] text-muted-foreground">Mbps</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">下载平均</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatSpeed(speedMetrics.downloadAvg)}</p>
                <p className="text-[11px] text-muted-foreground">{formatMegabytes(speedMetrics.downloadBytes)} MB</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">上传平均</p>
                <p className="mt-1 font-mono text-lg font-semibold">{formatSpeed(speedMetrics.uploadAvg)}</p>
                <p className="text-[11px] text-muted-foreground">{formatMegabytes(speedMetrics.uploadBytes)} MB</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">进度</p>
                <p className="mt-1 font-mono text-lg font-semibold">{Math.min(20, speedMetrics.downloadSeconds + speedMetrics.uploadSeconds).toFixed(1)}s</p>
                <p className="text-[11px] text-muted-foreground">下载 10s / 上传 10s</p>
              </div>
            </div>
            <canvas ref={speedCanvasRef} className="h-[260px] w-full rounded-lg border border-border/40 bg-slate-950" />
            <p className={cn("text-xs", speedPhase === "error" ? "text-destructive" : "text-muted-foreground")}>{speedMessage}</p>
          </CardContent>
        </Card>
      )}
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
    </div>
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
  const [speedPhase, setSpeedPhase] = useState<SpeedPhase>("idle");
  const [speedPoints, setSpeedPoints] = useState<SpeedPoint[]>([]);
  const [speedMetrics, setSpeedMetrics] = useState<SpeedMetrics>(initialSpeedMetrics);
  const [speedMessage, setSpeedMessage] = useState("选择主机后可在当前页面开始测速。");
  const speedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const speedAbortRef = useRef<AbortController | null>(null);
  const speedPreviousPointsRef = useRef<SpeedPoint[]>([]);
  const speedAnimationRef = useRef<number | null>(null);
  const completedTaskIdsRef = useRef<Set<string>>(new Set());
  const { data: hosts } = trpc.hosts.list.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const availableHosts = useMemo(() => hosts || [], [hosts]);
  const selectedHost = availableHosts.find((host: any) => String(host.id) === hostId) as any;
  const speedTestSession = trpc.lookingGlass.speedTestSession.useQuery(
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

  useEffect(() => {
    const previous = speedPreviousPointsRef.current;
    if (speedAnimationRef.current) window.cancelAnimationFrame(speedAnimationRef.current);
    const startedAt = performance.now();
    const duration = 420;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      drawSpeedChart(speedCanvasRef.current, speedPoints, previous, progress);
      if (progress < 1) {
        speedAnimationRef.current = window.requestAnimationFrame(animate);
      } else {
        speedPreviousPointsRef.current = speedPoints;
        speedAnimationRef.current = null;
      }
    };
    speedAnimationRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (speedAnimationRef.current) window.cancelAnimationFrame(speedAnimationRef.current);
    };
  }, [speedPoints]);

  useEffect(() => {
    const onResize = () => drawSpeedChart(speedCanvasRef.current, speedPoints, speedPoints, 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [speedPoints]);

  useEffect(() => {
    setSpeedPhase("idle");
    setSpeedPoints([]);
    speedPreviousPointsRef.current = [];
    setSpeedMetrics(initialSpeedMetrics);
    setSpeedMessage(Number(hostId) > 0 ? "点击开始测速，将依次执行下载 10 秒和上传 10 秒。" : "选择主机后可在当前页面开始测速。");
    speedAbortRef.current?.abort();
    speedAbortRef.current = null;
  }, [hostId]);

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

  const runDownloadSpeedTest = async (url: string, controller: AbortController) => {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`下载测速连接失败：${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const startedAt = performance.now();
    let lastTick = startedAt;
    let intervalBytes = 0;
    let totalBytes = 0;
    let peak = 0;
    try {
      while (performance.now() - startedAt < 10_000) {
        const next = await reader.read();
        if (next.done) break;
        const now = performance.now();
        totalBytes += next.value.byteLength;
        intervalBytes += next.value.byteLength;
        if (now - lastTick >= 500) {
          const seconds = (now - lastTick) / 1000;
          const current = bytesToMbps(intervalBytes, seconds);
          peak = Math.max(peak, current);
          const elapsed = Math.min(10, (now - startedAt) / 1000);
          const avg = bytesToMbps(totalBytes, elapsed);
          setSpeedMetrics((value) => ({
            ...value,
            current,
            downloadAvg: avg,
            downloadPeak: peak,
            downloadBytes: totalBytes,
            downloadSeconds: elapsed,
          }));
          setSpeedPoints((items) => [...items, { phase: "download", second: elapsed, rate: current }].slice(-80));
          intervalBytes = 0;
          lastTick = now;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const elapsed = Math.min(10, Math.max(0.001, (performance.now() - startedAt) / 1000));
    const avg = bytesToMbps(totalBytes, elapsed);
    setSpeedMetrics((value) => ({
      ...value,
      current: 0,
      downloadAvg: avg,
      downloadPeak: Math.max(peak, avg),
      downloadBytes: totalBytes,
      downloadSeconds: elapsed,
    }));
  };

  const makeUploadStream = (onBytes: (bytes: number) => void, controller: AbortController) => {
    return new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (controller.signal.aborted) {
          streamController.close();
          return;
        }
        const chunk = new Uint8Array(64 * 1024);
        streamController.enqueue(chunk);
        onBytes(chunk.byteLength);
      },
      cancel() {
        controller.abort();
      },
    });
  };

  const runUploadSpeedTest = async (url: string, controller: AbortController) => {
    const startedAt = performance.now();
    let lastTick = startedAt;
    let intervalBytes = 0;
    let totalBytes = 0;
    let peak = 0;
    const stream = makeUploadStream((bytes) => {
      const now = performance.now();
      totalBytes += bytes;
      intervalBytes += bytes;
      if (now - lastTick >= 500) {
        const seconds = (now - lastTick) / 1000;
        const current = bytesToMbps(intervalBytes, seconds);
        peak = Math.max(peak, current);
        const elapsed = Math.min(10, (now - startedAt) / 1000);
        const avg = bytesToMbps(totalBytes, elapsed);
        setSpeedMetrics((value) => ({
          ...value,
          current,
          uploadAvg: avg,
          uploadPeak: peak,
          uploadBytes: totalBytes,
          uploadSeconds: elapsed,
        }));
        setSpeedPoints((items) => [...items, { phase: "upload", second: elapsed, rate: current }].slice(-80));
        intervalBytes = 0;
        lastTick = now;
      }
      if (now - startedAt >= 10_000) controller.abort();
    }, controller);

    try {
      await fetch(url, {
        method: "POST",
        body: stream,
        cache: "no-store",
        signal: controller.signal,
        // @ts-expect-error Chromium requires this option for streaming request bodies.
        duplex: "half",
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    const elapsed = Math.min(10, Math.max(0.001, (performance.now() - startedAt) / 1000));
    const avg = bytesToMbps(totalBytes, elapsed);
    setSpeedMetrics((value) => ({
      ...value,
      current: 0,
      uploadAvg: avg,
      uploadPeak: Math.max(peak, avg),
      uploadBytes: totalBytes,
      uploadSeconds: elapsed,
    }));
  };

  const runSpeedTest = async () => {
    if (!speedTestSession.data) {
      toast.error("请选择可用的测试主机");
      return;
    }
    speedAbortRef.current?.abort();
    const downloadController = new AbortController();
    speedAbortRef.current = downloadController;
    setSpeedPhase("download");
    setSpeedPoints([]);
    setSpeedMetrics(initialSpeedMetrics);
    setSpeedMessage("下载测速中，浏览器正在直连 Agent 读取数据流。");
    try {
      await runDownloadSpeedTest(speedTestSession.data.downloadUrl, downloadController);
      const uploadController = new AbortController();
      speedAbortRef.current = uploadController;
      setSpeedPhase("upload");
      setSpeedMessage("上传测速中，浏览器正在直连 Agent 发送数据流。");
      await runUploadSpeedTest(speedTestSession.data.uploadUrl, uploadController);
      setSpeedPhase("complete");
      setSpeedMessage("速度测试完成。");
      toast.success("速度测试完成");
    } catch (error) {
      const message = speedErrorMessage(error);
      setSpeedPhase("error");
      setSpeedMessage(message);
      toast.error(message);
    } finally {
      speedAbortRef.current = null;
    }
  };

  const speedRunning = speedPhase === "download" || speedPhase === "upload";

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
              从已添加的 Agent 主机发起 Ping、Traceroute、MTR、TCPing，并在当前页面执行浏览器直连 Agent 的速度测试。
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
            速度测试固定执行下载 10 秒和上传 10 秒，测速数据流由浏览器直连选中的 Agent 主机，不经过面板中转。网络测试会拒绝内网、环回、链路本地或保留地址。
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
                    <p className="text-sm font-medium">速度测试</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      固定下载 10 秒、上传 10 秒，默认端口 3091，浏览器直连该主机。
                    </p>
                  </div>
                  {speedTestSession.isFetching && <Loader2 className="forwardx-icon-spin h-4 w-4 text-muted-foreground" />}
                </div>
                {speedTestSession.error && (
                  <p className="mt-3 text-xs text-destructive">{speedTestSession.error.message}</p>
                )}
                <Button
                  className="mt-3 w-full gap-2"
                  variant="outline"
                  onClick={runSpeedTest}
                  disabled={!speedTestSession.data || speedRunning || speedTestSession.isFetching}
                >
                  {speedRunning ? <Loader2 className="forwardx-icon-spin h-4 w-4" /> : <Gauge className="h-4 w-4" />}
                  {speedPhase === "download" ? "下载测速中..." : speedPhase === "upload" ? "上传测速中..." : "开始速度测试"}
                </Button>
                <p className={cn("mt-2 text-xs", speedPhase === "error" ? "text-destructive" : "text-muted-foreground")}>{speedMessage}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border/40 bg-background/45 p-2">
                    <p className="text-[11px] text-muted-foreground">下载平均</p>
                    <p className="mt-1 font-mono text-sm">{formatSpeed(speedMetrics.downloadAvg)} Mbps</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-background/45 p-2">
                    <p className="text-[11px] text-muted-foreground">上传平均</p>
                    <p className="mt-1 font-mono text-sm">{formatSpeed(speedMetrics.uploadAvg)} Mbps</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-background/45 p-2">
                    <p className="text-[11px] text-muted-foreground">下载数据</p>
                    <p className="mt-1 font-mono text-sm">{formatMegabytes(speedMetrics.downloadBytes)} MB</p>
                  </div>
                  <div className="rounded-md border border-border/40 bg-background/45 p-2">
                    <p className="text-[11px] text-muted-foreground">上传数据</p>
                    <p className="mt-1 font-mono text-sm">{formatMegabytes(speedMetrics.uploadBytes)} MB</p>
                  </div>
                </div>
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

          <ResultOutput
            result={latestResult}
            liveOutput={runningOutput}
            state={runState}
            speedPhase={speedPhase}
            speedMetrics={speedMetrics}
            speedPoints={speedPoints}
            speedCanvasRef={speedCanvasRef}
            speedMessage={speedMessage}
          />
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

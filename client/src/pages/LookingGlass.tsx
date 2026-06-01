import DashboardLayout from "@/components/DashboardLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  Loader2,
  Network,
  RadioTower,
  Route,
  ShieldCheck,
  Terminal,
  Wifi,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

type Method = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp";

type LookingGlassResult = {
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

function ResultOutput({
  result,
  loading,
}: {
  result: LookingGlassResult | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="space-y-3 p-4">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card className="border-dashed border-border/60 bg-card/45 backdrop-blur-md">
        <CardContent className="flex min-h-[280px] flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Terminal className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold">等待测试</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              选择测试类型并输入公网目标后，从当前 ForwardX 面板服务器发起网络探测。
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const ok = resultOk(result);
  return (
    <Card className="overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
      <CardHeader className="border-b border-border/40 bg-muted/20 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
            {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
            <span className="truncate">{methodMeta(result.method).label}</span>
            <Badge variant={ok ? "secondary" : "outline"} className={cn(ok && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}>
              {ok ? "完成" : result.timedOut ? "超时" : "异常"}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock3 className="h-3.5 w-3.5" />
              {result.durationMs} ms
            </span>
            <span>{result.sourceHostName || "当前面板服务器"}</span>
            <span className="font-mono">{result.resolvedAddress}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={async () => {
                const copied = await copyTextToClipboard(result.output);
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
        <pre className="max-h-[520px] overflow-auto bg-slate-950 px-4 py-4 font-mono text-xs leading-6 text-slate-100 scrollbar-gutter-stable">
          {result.output}
        </pre>
      </CardContent>
    </Card>
  );
}

export default function LookingGlass() {
  const [method, setMethod] = useState<Method>("ping");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("443");
  const [hostId, setHostId] = useState("panel");
  const [latestResult, setLatestResult] = useState<LookingGlassResult | null>(null);
  const [history, setHistory] = useState<LookingGlassResult[]>([]);
  const { data: hosts } = trpc.hosts.list.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const mutation = trpc.lookingGlass.run.useMutation({
    onSuccess: (result) => {
      const next = result as LookingGlassResult;
      setLatestResult(next);
      setHistory((items) => [next, ...items].slice(0, 8));
      if (resultOk(next)) toast.success("Looking Glass 测试完成");
      else toast.warning(next.timedOut ? "测试超时" : "测试返回异常状态");
    },
    onError: (error) => toast.error(error.message || "测试失败"),
  });

  const selected = methodMeta(method);
  const Icon = selected.icon;
  const canSubmit = target.trim().length > 0 && (!method.includes("6") || target.trim().length > 0);
  const resolvedAddresses = useMemo(() => latestResult?.resolvedAddresses || [], [latestResult?.resolvedAddresses]);

  const runTest = () => {
    if (!target.trim()) {
      toast.error("请输入目标地址");
      return;
    }
    const numericPort = Number(port);
    if (method === "tcp" && (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)) {
      toast.error("请输入 1-65535 的端口");
      return;
    }
    mutation.mutate({
      method,
      target: target.trim(),
      hostId: hostId === "panel" ? null : Number(hostId),
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
                Looking Glass
              </Badge>
              <Badge variant="outline" className="gap-1.5 text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                公网目标限定
              </Badge>
            </div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Looking Glass</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              从面板服务器或已添加的主机发起 Ping、Traceroute、MTR 和 TCP 端口探测。
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
          <Network className="h-4 w-4" />
          <AlertTitle>功能说明</AlertTitle>
          <AlertDescription>
            该页面参考 hybula/lookingglass 的网络诊断思路，已按 ForwardX 的设计语言和 tRPC 后端重新实现。为避免探测内网资源，目标解析到私网、环回、链路本地或保留地址时会被拒绝。
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
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="panel">当前面板服务器</SelectItem>
                    {(hosts || []).map((host: any) => (
                      <SelectItem key={host.id} value={String(host.id)}>
                        {host.name}
                        {host.isOnline === false ? " / 离线" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>测试类型</Label>
                <Tabs value={method} onValueChange={(value) => setMethod(value as Method)}>
                  <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:grid-cols-3">
                    {methods.map((item) => (
                      <TabsTrigger key={item.value} value={item.value} className="min-h-10 px-2 text-xs">
                        {item.label.replace(" IPv4", "").replace(" IPv6", "6")}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <p className="text-xs text-muted-foreground">{selected.description}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="looking-glass-target">目标地址</Label>
                <div className="flex gap-2">
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
                </div>
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

              <Button className="w-full gap-2" onClick={runTest} disabled={!canSubmit || mutation.isPending}>
                {mutation.isPending ? <Loader2 className="forwardx-icon-spin h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                {mutation.isPending ? "测试中..." : "开始测试"}
              </Button>

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

          <ResultOutput result={latestResult} loading={mutation.isPending} />
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
                    onClick={() => setLatestResult(item)}
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
                    <p className="mt-1 text-xs text-muted-foreground">{item.sourceHostName || "当前面板服务器"} / {formatDateTime(item.startedAt)}</p>
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

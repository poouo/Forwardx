import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Key,
  Copy,
  Terminal,
  CheckCircle2,
  Settings2,
  FileCode,
  Download,
  Github,
  Send,
  Globe,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
  Rocket,
  AlertTriangle,
  Pencil,
  FileText,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useRef, useState, useEffect } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

function getUpgradeProgress(job: any) {
  const status = job?.status || "idle";
  const logs = Array.isArray(job?.logs) ? job.logs.join("\n") : "";
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const steps = [
    {
      label: "准备升级",
      done: status !== "idle" && matched([/开始升级/i, /start/i]),
    },
    {
      label: "拉取与准备依赖",
      done: matched([
        /Cloning into/i,
        /git (fetch|pull|checkout)/i,
        /load metadata/i,
        /load build context/i,
        /transferring context/i,
        /pnpm install/i,
        /npm install/i,
        /Packages:/i,
        /node_modules/i,
        /downloaded/i,
        /Lockfile is up to date/i,
      ]),
    },
    {
      label: "构建新版本",
      done: matched([/pnpm build/i, /vite .*building/i, /modules transformed/i, /Server build complete/i, /exporting layers/i]),
    },
    {
      label: "重启服务",
      done: matched([/Container .* (Creating|Created|Starting|Started)/i, /docker compose up/i, /systemctl restart/i, /已启动/i, /recreate/i]),
    },
  ];

  if (status === "success") {
    return { percent: 100, label: "升级完成", steps: steps.map((step) => ({ ...step, done: true, active: false })) };
  }
  if (status === "error") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    return { percent: Math.max(10, doneCount * 22), label: "升级异常", steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  if (status === "running") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    const activeStep = steps[activeIndex]?.label || "等待服务重启";
    return { percent: Math.min(92, Math.max(12, doneCount * 22 + 8)), label: activeStep, steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  return { percent: 0, label: "等待升级", steps: steps.map((step) => ({ ...step, active: false })) };
}

const manualPanelUpgradeCommands = [
  {
    label: "本地部署",
    command:
      "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade",
  },
  {
    label: "Docker 部署",
    command:
      "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade",
  },
];

function formatCountdown(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainSeconds = safeSeconds % 60;
  return `${minutes}:${remainSeconds.toString().padStart(2, "0")}`;
}

function getMigrationCodeCountdown(code: { expiresAt: number } | null, now: number) {
  if (!code) return 0;
  return Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
}

function SettingsContent() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const initialTab = (() => {
    const query = location.split("?")[1] || "";
    const tab = new URLSearchParams(query).get("tab");
    return tab === "system" || tab === "telegram" || tab === "logs" || tab === "install" || tab === "tokens" ? tab : "tokens";
  })();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [tokenToDelete, setTokenToDelete] = useState<any | null>(null);

  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/");
    }
  }, [user, setLocation]);

  useEffect(() => {
    const query = location.split("?")[1] || "";
    const tab = new URLSearchParams(query).get("tab");
    if (tab === "system" || tab === "telegram" || tab === "logs" || tab === "install" || tab === "tokens") {
      setActiveTab(tab);
    }
  }, [location]);

  const { data: tokens, isLoading } = trpc.agentTokens.list.useQuery(
    undefined,
    { enabled: user?.role === "admin" }
  );

  const createTokenMutation = trpc.agentTokens.create.useMutation({
    onSuccess: (data) => {
      utils.agentTokens.list.invalidate();
      toast.success("Token 已创建");
      setNewToken(data.token);
      setShowNewToken(true);
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.message || "创建 Token 失败"),
  });

  const deleteTokenMutation = trpc.agentTokens.delete.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      utils.hosts.list.invalidate();
      toast.success("Token 已删除，关联主机已解除绑定");
    },
    onError: (err) => toast.error(err.message || "删除 Token 失败"),
  });

  const updateTokenMutation = trpc.agentTokens.update.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      toast.success("Token 备注已更新");
      setEditingToken(null);
      setEditDescription("");
    },
    onError: (err) => toast.error(err.message || "更新 Token 备注失败"),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptTokenId, setScriptTokenId] = useState<number | null>(null);
  const [newToken, setNewToken] = useState("");
  const [description, setDescription] = useState("");
  const [editingToken, setEditingToken] = useState<any>(null);
  const [editDescription, setEditDescription] = useState("");
  // 面板地址统一使用「系统信息」Tab 中配置的 panelPublicUrl；未配置时回退 window.location.origin
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const panelUrl = (systemSettings?.panelPublicUrl && systemSettings.panelPublicUrl.trim())
    || (typeof window !== "undefined" ? window.location.origin : "");
  const repoUrl = systemSettings?.repoUrl || "https://github.com/poouo/Forwardx";
  // GitHub 官方 install-agent.sh 的 raw 地址
  const githubScriptUrl = `${repoUrl.replace(/\/+$/, "").replace("github.com", "raw.githubusercontent.com")}/main/scripts/install-agent.sh`;

  const { data: scriptData } = trpc.agentTokens.getInstallScript.useQuery(
    { id: scriptTokenId ?? undefined, panelUrl },
    { enabled: !!scriptTokenId && showScript }
  );

  const copyToClipboard = async (text: string) => {
    // 优先使用 Clipboard API（仅在 https 或 localhost 下可用）
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("已复制到剪贴板");
        return;
      } catch (err) {
        console.warn("[Clipboard] navigator.clipboard 失败，回退 execCommand:", err);
      }
    }

    // Fallback：HTTP / 非安全上下文 / 不支持 Clipboard API
    // 关键修复：Radix Dialog 会抢焦点，必须将 textarea 挂到当前活跃 dialog 内部才能 select 成功。
    let success = false;
    const host =
      (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) ||
      document.body;
    const textarea = document.createElement("textarea");
    try {
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      // 不能 display:none / left:-9999px，iOS 与部分浏览器会跳过选中
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      textarea.style.left = "0";
      textarea.style.top = "0";
      textarea.style.width = "1px";
      textarea.style.height = "1px";
      host.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      success = document.execCommand("copy");
    } catch (err) {
      console.error("[Clipboard] execCommand fallback 异常:", err);
      success = false;
    } finally {
      if (textarea.parentNode) {
        textarea.parentNode.removeChild(textarea);
      }
    }

    if (success) {
      toast.success("已复制到剪贴板");
      return;
    }

    // 最后兑底：弹 prompt 让用户手动 Ctrl+C，避免静默失败
    try {
      window.prompt("复制失败，请手动选中并复制 (Ctrl+C / Cmd+C)：", text);
      toast.warning("未能自动写入剪贴板，已弹出手动复制窗口");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  /**
   * 生成一条「GitHub 优先 + 面板回退」的安装命令。
   * 该命令在 shell 内联决定从哪里拉取脚本，GitHub 不可达时自动转发面板。
   */
  const getInstallCommand = (token: string) => {
    return `bash -c 'S=$(curl -fsSL --max-time 10 ${githubScriptUrl} 2>/dev/null) || S=$(curl -fsSL --max-time 30 "${panelUrl}/api/agent/install.sh"); PANEL_URL="${panelUrl}" bash -c "$S" _ install ${token}'`;
  };

  /** 卸载命令也采用同样的「GitHub 优先 + 面板回退」策略 */
  const getUninstallCommand = () => {
    return `bash -c 'S=$(curl -fsSL --max-time 10 ${githubScriptUrl} 2>/dev/null) || S=$(curl -fsSL --max-time 30 "${panelUrl}/api/agent/install.sh"); bash -c "$S" _ uninstall'`;
  };

  /** 升级命令复用已安装 Agent 中的面板地址和 Token，必要时可由 PANEL_URL 覆盖 */
  const getUpgradeCommand = () => {
    return `bash -c 'S=$(curl -fsSL --max-time 10 ${githubScriptUrl} 2>/dev/null) || S=$(curl -fsSL --max-time 30 "${panelUrl}/api/agent/install.sh"); PANEL_URL="${panelUrl}" bash -c "$S" _ upgrade'`;
  };

  if (user?.role !== "admin") return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">系统设置</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理 Agent Token 和一键安装脚本
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
          <Key className="h-3 w-3 text-primary" />
          {tokens?.length ?? 0} 个 Token
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-muted/30 border border-border/30">
          <TabsTrigger value="tokens" className="gap-1.5">
            <Key className="h-3.5 w-3.5" />
            Agent Token
          </TabsTrigger>
          <TabsTrigger value="install" className="gap-1.5">
            <Terminal className="h-3.5 w-3.5" />
            一键安装
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            系统信息
          </TabsTrigger>
          <TabsTrigger value="telegram" className="gap-1.5">
            <Send className="h-3.5 w-3.5" />
            Telegram 机器人
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            面板日志
          </TabsTrigger>
        </TabsList>

        {/* Token Management Tab */}
        <TabsContent value="tokens" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Agent Token 用于被控机注册和通信认证
            </p>
            <Button onClick={() => { setDescription(""); setShowCreate(true); }} className="gap-2">
              <Plus className="h-4 w-4" />
              创建 Token
            </Button>
          </div>

          <Alert className="border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>通讯已加密</AlertTitle>
          </Alert>

          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-6 space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : tokens && tokens.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Token</TableHead>
                        <TableHead className="hidden sm:table-cell">描述</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="hidden md:table-cell">创建时间</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <code className="text-xs bg-muted/40 px-2 py-1 rounded font-mono">
                                {t.token}
                              </code>
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <span className="text-sm text-muted-foreground">{t.description || "-"}</span>
                          </TableCell>
                          <TableCell>
                            {t.isUsed ? (
                              <Badge className="bg-chart-2/10 text-chart-2 border-chart-2/20 text-[10px]">
                                <CheckCircle2 className="h-3 w-3 mr-1" />
                                已使用
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                未使用
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="text-xs text-muted-foreground">
                              {new Date(t.createdAt).toLocaleString()}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="查看安装脚本"
                                onClick={() => {
                                  setScriptTokenId(t.id);
                                  setShowScript(true);
                                }}
                              >
                                <Terminal className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="编辑备注"
                                onClick={() => {
                                  setEditingToken(t);
                                  setEditDescription(t.description || "");
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => {
                                  setTokenToDelete(t);
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
                  <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                    <Key className="h-8 w-8 opacity-40" />
                  </div>
                  <p className="text-lg font-medium">暂无 Token</p>
                  <p className="text-sm mt-1 text-muted-foreground/60">
                    创建 Token 以添加被控机
                  </p>
                  <Button
                    onClick={() => { setDescription(""); setShowCreate(true); }}
                    variant="outline"
                    className="mt-4 gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    创建第一个 Token
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Install Guide Tab */}
        <TabsContent value="install" className="space-y-4">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCode className="h-4 w-4" />
                一键安装说明
              </CardTitle>
              <CardDescription>
                在被控机上执行一键安装脚本，即可自动注册到面板并开始通信
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 border border-border/40">
                <Settings2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <p>
                    <span className="font-medium">当前面板地址：</span>
                    <code className="ml-1 font-mono text-foreground">{panelUrl}</code>
                  </p>
                  <p className="text-muted-foreground">
                    该地址从「系统信息」Tab 读取。未配置时默认使用当前浏览器访问的 origin，请确认 Agent 能访问该地址。
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium">安装步骤</p>
                <div className="space-y-3">
                  {[
                    "在 \"Agent Token\" 标签页中创建一个新 Token",
                    "点击 Token 行的终端图标查看安装脚本",
                    "在被控机上以 root 权限执行安装命令",
                    "Agent 将自动注册并开始上报状态",
                    "如需升级，执行升级命令即可覆盖安装并重启 Agent",
                    "如需卸载，执行卸载命令即可完全清理",
                  ].map((step, i) => (
                    <div key={i} className="flex gap-3 items-start">
                      <span className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <span className="text-sm text-muted-foreground">{step}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-lg bg-muted/20 border border-border/30 space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium flex items-center gap-1.5">
                    <Download className="h-3 w-3" />
                    安装命令（替换 YOUR_TOKEN，GitHub 优先，不可达时自动回退面板）：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/50 p-3 rounded border overflow-x-auto break-all">
                      {getInstallCommand("YOUR_TOKEN")}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => copyToClipboard(getInstallCommand("YOUR_TOKEN"))}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium flex items-center gap-1.5">
                    <RefreshCw className="h-3 w-3" />
                    升级命令（复用已安装 Agent 的 Token 与面板地址）：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/50 p-3 rounded border overflow-x-auto break-all">
                      {getUpgradeCommand()}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => copyToClipboard(getUpgradeCommand())}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium flex items-center gap-1.5">
                    <Trash2 className="h-3 w-3" />
                    卸载命令（同样 GitHub 优先，不可达时回退面板）：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/50 p-3 rounded border overflow-x-auto break-all">
                      {getUninstallCommand()}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() => copyToClipboard(getUninstallCommand())}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <p className="text-xs text-amber-400 font-medium mb-1">注意事项</p>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>- Agent 需要 root 权限运行以管理 iptables 和 realm</li>
                  <li>- 安装脚本会自动配置 systemd 服务实现开机自启</li>
                  <li>- 每个 Token 只能被一台主机使用</li>
                  <li>- 卸载命令会停止服务、删除文件并清理所有转发规则</li>
                  <li>- 不带参数执行脚本将进入交互模式，可选择安装或卸载</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Info Tab */}
        <TabsContent value="system" className="space-y-4">
          <SystemInfoSection />
        </TabsContent>

        {/* Telegram Bot Tab */}
        <TabsContent value="telegram" className="space-y-4">
          <TelegramBotSettingsCard />
        </TabsContent>

        {/* Panel Logs Tab */}
        <TabsContent value="logs" className="space-y-4">
          <PanelLogsSection />
        </TabsContent>
      </Tabs>

      {/* Create Token Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建 Agent Token</DialogTitle>
            <DialogDescription>
              创建一个新的 Token 用于被控机注册
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>描述（可选）</Label>
              <Input
                placeholder="例如: 香港节点 Agent"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button
              onClick={() =>
                createTokenMutation.mutate({ description: description || undefined })
              }
              disabled={createTokenMutation.isPending}
            >
              {createTokenMutation.isPending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Token Display Dialog */}
      <Dialog open={showNewToken} onOpenChange={setShowNewToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-chart-2" />
              Token 已创建
            </DialogTitle>
            <DialogDescription>
              下面只展示安装命令，Token 不再单独显示。复制命令到被控机执行即可完成安装。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">快速安装命令：</p>
              <div className="p-3 rounded-lg bg-background/50 border">
                <code className="text-xs font-mono break-all">
                  {getInstallCommand(newToken)}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={() => copyToClipboard(getInstallCommand(newToken))}
              >
                <Copy className="h-3 w-3" />
                复制安装命令
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowNewToken(false)}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Token Description Dialog */}
      <Dialog open={!!editingToken} onOpenChange={(open) => {
        if (!open) {
          setEditingToken(null);
          setEditDescription("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 Token 备注</DialogTitle>
            <DialogDescription>
              修改备注只影响后台展示，不会改变 Token 或已安装 Agent。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              value={editDescription}
              maxLength={200}
              placeholder="例如：香港节点 Agent"
              onChange={(e) => setEditDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingToken(null)}>
              取消
            </Button>
            <Button
              disabled={updateTokenMutation.isPending || !editingToken}
              onClick={() => updateTokenMutation.mutate({
                id: editingToken.id,
                description: editDescription.trim() || null,
              })}
            >
              {updateTokenMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Token Confirm Dialog */}
      <Dialog open={!!tokenToDelete} onOpenChange={(open) => !open && setTokenToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              删除 Agent Token
            </DialogTitle>
            <DialogDescription>
              删除后，使用该 Token 注册的主机会解除绑定并显示为离线，但主机记录不会被删除。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-sm">
            <div className="font-mono break-all">{tokenToDelete?.token}</div>
            {tokenToDelete?.description && (
              <div className="mt-2 text-xs text-muted-foreground">{tokenToDelete.description}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenToDelete(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={deleteTokenMutation.isPending || !tokenToDelete}
              onClick={() => {
                if (!tokenToDelete) return;
                const id = tokenToDelete.id;
                setTokenToDelete(null);
                deleteTokenMutation.mutate({ id });
              }}
            >
              {deleteTokenMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Install Script Dialog */}
      <Dialog open={showScript} onOpenChange={setShowScript}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              一键安装脚本
            </DialogTitle>
            <DialogDescription>
              在被控机上以 root 权限执行以下命令
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">安装命令</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted/30 p-3 rounded border overflow-x-auto">
                  {scriptData?.token ? getInstallCommand(scriptData.token) : "加载中..."}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => scriptData?.token && copyToClipboard(getInstallCommand(scriptData.token))}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">卸载命令</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted/30 p-3 rounded border overflow-x-auto">
                  {getUninstallCommand()}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(getUninstallCommand())}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">升级命令</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-muted/30 p-3 rounded border overflow-x-auto">
                  {getUpgradeCommand()}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(getUpgradeCommand())}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>

          </div>
          <DialogFooter>
            <Button onClick={() => setShowScript(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PanelLogsSection() {
  const [logLevel, setLogLevel] = useState<"all" | "info" | "warn" | "error" | "log">("all");
  const { data: panelLogs, refetch: refetchPanelLogs } = trpc.system.panelLogs.useQuery({ level: logLevel }, {
    refetchInterval: 10000,
  });
  const clearLogsMutation = trpc.system.clearPanelLogs.useMutation({
    onSuccess: async () => {
      toast.success("日志已清空");
      await refetchPanelLogs();
    },
    onError: (err) => toast.error(err.message || "清空日志失败"),
  });
  const logLevelClass = (level: string) => {
    if (level === "error") return "text-destructive";
    if (level === "warn") return "text-amber-600 dark:text-amber-400";
    if (level === "info") return "text-sky-600 dark:text-sky-400";
    return "text-muted-foreground";
  };
  const summary = panelLogs?.summary || {};
  const levelTabs = [
    { value: "all", label: "全部", count: summary.all || 0 },
    { value: "info", label: "Info", count: summary.info || 0 },
    { value: "warn", label: "Warn", count: summary.warn || 0 },
    { value: "error", label: "Error", count: summary.error || 0 },
    { value: "log", label: "Log", count: summary.log || 0 },
  ] as const;
  return (
    <div className="space-y-4">
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                面板日志
              </CardTitle>
              <CardDescription>展示最近 24 小时的面板运行日志，隧道延迟测试也会记录排查信息。</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetchPanelLogs()}>刷新</Button>
              <Button variant="destructive" size="sm" onClick={() => clearLogsMutation.mutate()} disabled={clearLogsMutation.isPending}>清空日志</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={logLevel} onValueChange={(v) => setLogLevel(v as typeof logLevel)} className="space-y-3">
            <TabsList className="grid h-auto w-full grid-cols-5 bg-muted/50">
              {levelTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5 text-xs">
                  {tab.label}
                  <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">{tab.count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="max-h-80 overflow-auto rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-xs leading-relaxed">
            {(panelLogs?.logs || []).length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">暂无日志</div>
            ) : (
              <div className="space-y-1">
                {(panelLogs?.logs || []).slice().reverse().map((entry: any) => (
                  <div key={entry.id} className="grid gap-2 sm:grid-cols-[150px_56px_1fr]">
                    <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                    <span className={logLevelClass(entry.level)}>{String(entry.level).toUpperCase()}</span>
                    <span className="whitespace-pre-wrap break-words text-foreground/90">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TelegramBotSettingsCard() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");

  useEffect(() => {
    if (settings) {
      setTelegramEnabled(!!settings.telegram?.enabled);
    }
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      toast.success("Telegram 机器人配置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });
  const testTelegramMutation = trpc.telegram.testSend.useMutation({
    onSuccess: () => toast.success("测试消息已发送，请查看已绑定的 Telegram"),
    onError: (err) => toast.error(err.message || "测试发送失败"),
  });

  const handleSaveTelegram = () => {
    updateSettingsMutation.mutate({
      telegram: {
        enabled: telegramEnabled,
        botToken: telegramBotTokenInput.trim() || undefined,
      },
    });
    setTelegramBotTokenInput("");
  };

  const handleClearTelegramToken = () => {
    updateSettingsMutation.mutate({
      telegram: {
        enabled: false,
        clearToken: true,
      },
    });
    setTelegramEnabled(false);
    setTelegramBotTokenInput("");
  };

  const tokenSourceLabel =
    settings?.telegram?.tokenSource === "env"
      ? "环境变量 TELEGRAM_BOT_TOKEN"
      : settings?.telegram?.tokenSource === "database"
        ? "数据库配置"
        : "未配置";

  return (
    <Card className="border-sky-500/25 bg-sky-500/5 backdrop-blur-md">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-sky-500" />
              Telegram 机器人
            </CardTitle>
            <CardDescription className="mt-1">
              配置 Bot Token 后，用户可绑定 Telegram、查询用量、管理规则并生成网页登录链接。后台同一时间只使用当前这一只机器人，保存新 Token 会切换绑定机器人。
            </CardDescription>
          </div>
          <Badge variant={settings?.telegram?.configured ? "default" : "outline"} className="w-fit">
            {settings?.telegram?.configured ? "已配置" : "未配置"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="space-y-2">
                <Label>Bot Token</Label>
                <Input
                  type="password"
                  placeholder={settings?.telegram?.tokenMasked || "从 @BotFather 获取，例如 123456:ABC..."}
                  value={telegramBotTokenInput}
                  onChange={(e) => setTelegramBotTokenInput(e.target.value)}
                  disabled={settings?.telegram?.tokenSource === "env"}
                />
                <p className="text-xs text-muted-foreground">
                  来源：{tokenSourceLabel}。环境变量优先级最高，数据库 Token 可随时替换为其他机器人；机器人使用长轮询，无需配置 webhook。
                </p>
              </div>
              <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">启用机器人</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {settings?.telegram?.botUsername ? `@${settings.telegram.botUsername}` : "保存 Token 后自动识别机器人"}
                    </p>
                  </div>
                  <Switch checked={telegramEnabled} onCheckedChange={setTelegramEnabled} />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSaveTelegram} disabled={updateSettingsMutation.isPending}>
                {updateSettingsMutation.isPending ? "保存中..." : "保存 Telegram 配置"}
              </Button>
              <Button
                variant="outline"
                onClick={() => testTelegramMutation.mutate()}
                disabled={
                  testTelegramMutation.isPending ||
                  !settings?.telegram?.configured ||
                  !settings?.telegram?.enabled
                }
              >
                {testTelegramMutation.isPending ? "发送中..." : "测试发送"}
              </Button>
              {settings?.telegram?.tokenSource === "database" && (
                <Button variant="outline" onClick={handleClearTelegramToken} disabled={updateSettingsMutation.isPending}>
                  清空 Token
                </Button>
              )}
              {settings?.telegram?.botUsername && (
                <Button variant="ghost" asChild className="gap-2">
                  <a href={`https://t.me/${settings.telegram.botUsername}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    打开机器人
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SystemInfoSection() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const { data: upgradeStatus, refetch: refetchUpgradeStatus } = trpc.system.upgradeStatus.useQuery(
    undefined,
    { refetchInterval: 5000 }
  );
  const { data: currentMigrationCode } = trpc.system.getMigrationCode.useQuery(undefined, {
    refetchInterval: 1000,
  });
  const [panelUrlInput, setPanelUrlInput] = useState("");
  const [homepageEnabled, setHomepageEnabled] = useState(true);
  const [migrationCode, setMigrationCode] = useState<{
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pendingRequest?: {
      id: string;
      targetPanelUrl: string;
      status: "pending" | "approved" | "rejected" | "used";
      createdAt: number;
      expiresAt: number;
      approvedAt?: number;
      rejectedAt?: number;
    } | null;
  } | null>(null);
  const [migrationCodeTick, setMigrationCodeTick] = useState(Date.now());
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const previousUpgradeStatus = useRef<string | null>(null);
  const lastPanelUpdateCheck = useRef(0);

  useEffect(() => {
    if (settings) {
      setPanelUrlInput(settings.panelPublicUrl || "");
      setHomepageEnabled(settings.homepageEnabled ?? true);
    }
  }, [settings]);

  useEffect(() => {
    setMigrationCode(currentMigrationCode || null);
  }, [currentMigrationCode]);

  useEffect(() => {
    if (!migrationCode) return;
    const timer = window.setInterval(() => setMigrationCodeTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [migrationCode?.code]);

  useEffect(() => {
    const status = upgradeStatus?.job?.status;
    if (!status || status === "idle") return;
    const previous = previousUpgradeStatus.current;
    if (previous === "running" && status === "success") {
      toast.success("面板升级成功");
    }
    if (previous === "running" && status === "error") {
      toast.error(upgradeStatus?.job?.error || "面板升级失败");
    }
    previousUpgradeStatus.current = status;
  }, [upgradeStatus?.job?.status, upgradeStatus?.job?.error]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      toast.success("面板设置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });

  const handleSavePanelUrl = () => {
    const v = panelUrlInput.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      toast.error("面板公开地址必须以 http:// 或 https:// 开头");
      return;
    }
    updateSettingsMutation.mutate({ panelPublicUrl: v });
  };

  const handleSaveHomepage = () => {
    updateSettingsMutation.mutate({ homepageEnabled });
  };

  const createMigrationCodeMutation = trpc.system.createMigrationCode.useMutation({
    onSuccess: (data) => {
      setMigrationCode(data);
      utils.system.getMigrationCode.invalidate();
      toast.success("迁移码已生成，5 分钟内有效");
    },
    onError: (err) => toast.error(err.message || "生成迁移码失败"),
  });

  const approveMigrationRequestMutation = trpc.system.approveMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已同意迁移请求，新面板将开始导入数据");
    },
    onError: (err) => toast.error(err.message || "同意迁移请求失败"),
  });

  const rejectMigrationRequestMutation = trpc.system.rejectMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已拒绝迁移请求");
    },
    onError: (err) => toast.error(err.message || "拒绝迁移请求失败"),
  });

  const copyMigrationCode = async (code: string) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textarea);
    }

    if (copied) {
      toast.success("迁移码已复制");
    } else {
      toast.error("复制失败，请手动选中迁移码复制");
    }
  };

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: async () => {
      toast.success("升级任务已启动");
      await refetchUpgradeStatus();
    },
    onError: (err) => toast.error(err.message || "启动升级失败"),
  });

  const handleCheckUpdate = async () => {
    const now = Date.now();
    const cooldownMs = 60 * 1000;
    const waitMs = cooldownMs - (now - lastPanelUpdateCheck.current);
    if (waitMs > 0) {
      toast.info(`请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
      return;
    }
    try {
      setCheckingUpdate(true);
      lastPanelUpdateCheck.current = now;
      await utils.system.checkUpdate.fetch();
      await refetchUpgradeStatus();
      toast.success("版本检查完成");
    } catch (err: any) {
      toast.error(err?.message || "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateInfo = upgradeStatus?.update;
  const upgradeEnabled = !!upgradeStatus?.upgradeEnabled;
  const isUpgradeRunning = upgradeStatus?.job.status === "running";
  const upgradeProgress = getUpgradeProgress(upgradeStatus?.job);
  const upgradeErrorLogs = (upgradeStatus?.job?.logs || []).slice(-80).join("\n");
  const migrationCountdown = getMigrationCodeCountdown(migrationCode, migrationCodeTick);
  const migrationRequest = migrationCode?.pendingRequest;
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 面板公开访问地址 */}
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" />
            面板公开访问地址
          </CardTitle>
          <CardDescription>
            设置后，Agent 安装脚本、一键安装命令、心跳回调都会使用此地址。可以是反代域名、域名加端口或货真价实的 IP。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="例如: https://forwardx.example.com 或 http://1.2.3.4:3000"
              value={panelUrlInput}
              onChange={(e) => setPanelUrlInput(e.target.value)}
              className="flex-1"
            />
            <Button
              onClick={handleSavePanelUrl}
              disabled={updateSettingsMutation.isPending}
            >
              {updateSettingsMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            留空使用面板访问请求中的 host 作为默认值。必须以 http:// 或 https:// 开头。
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              公开首页
            </CardTitle>
            <CardDescription>
              开启后未登录访问根路径会展示面板功能介绍和登录/注册入口；关闭后直接进入登录页。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">启用公开首页</p>
                <p className="text-xs text-muted-foreground">适合需要开放注册或展示服务能力的面板。</p>
              </div>
              <Switch checked={homepageEnabled} onCheckedChange={setHomepageEnabled} />
            </div>
            <Button variant="outline" onClick={handleSaveHomepage} disabled={updateSettingsMutation.isPending}>
              {updateSettingsMutation.isPending ? "保存中..." : "保存首页开关"}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4 text-primary" />
              旧面板迁移码
            </CardTitle>
            <CardDescription>
              在旧面板生成迁移码后，到新面板首次安装向导中填入旧面板地址和迁移码即可导入。新面板确认导入成功后会接管 Agent，旧面板会清空业务数据并仅保留管理员账户。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {migrationCode ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">迁移码</p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <code className="break-all font-mono text-lg font-semibold tracking-widest">{migrationCode.code}</code>
                  <Button variant="outline" size="sm" onClick={() => copyMigrationCode(migrationCode.code)}>
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    复制
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>有效至 {new Date(migrationCode.expiresAt).toLocaleTimeString()}</span>
                  <Badge variant={migrationCountdown > 0 ? "outline" : "secondary"}>
                    剩余 {formatCountdown(migrationCountdown)}
                  </Badge>
                </div>
                {migrationRequest?.status === "pending" && (
                  <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-300">收到新面板迁移请求</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      目标面板：{migrationRequest.targetPanelUrl}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => approveMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        同意迁移
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rejectMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        拒绝
                      </Button>
                    </div>
                  </div>
                )}
                {migrationRequest?.status === "approved" && (
                  <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    已同意迁移请求，正在等待新面板拉取数据。
                  </div>
                )}
                {migrationRequest?.status === "rejected" && (
                  <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    已拒绝本次迁移请求。
                  </div>
                )}
              </div>
            ) : (
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertTitle>一次性迁移码</AlertTitle>
                <AlertDescription>生成后请尽快在新面板使用，不要公开分享。迁移码 5 分钟有效，使用后失效。</AlertDescription>
              </Alert>
            )}
            <Button onClick={() => createMigrationCodeMutation.mutate()} disabled={createMigrationCodeMutation.isPending}>
              {createMigrationCodeMutation.isPending ? "生成中..." : "生成迁移码"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* 版本升级 */}
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4 text-primary" />
            版本升级
          </CardTitle>
          <CardDescription>
            从 GitHub 检查 ForwardX 新版本。Docker 环境需要配置升级命令后才能在后台一键升级并重建容器。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">当前版本</p>
              <p className="mt-1 font-mono text-sm">v{upgradeStatus?.currentVersion || settings?.version}</p>
            </div>
          </div>

          {updateInfo?.error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>检查更新失败</AlertTitle>
              <AlertDescription>{updateInfo.error}</AlertDescription>
            </Alert>
          )}

          {!upgradeEnabled && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>当前环境尚未启用一键升级</AlertTitle>
              <AlertDescription>
                请在 Docker 部署中配置 <code>FORWARDX_UPGRADE_COMMAND</code>，并按需挂载 Docker socket 与部署目录。
                未配置时后台只会检查 GitHub 新版本，不会执行宿主机升级操作。
              </AlertDescription>
            </Alert>
          )}

          {updateInfo?.hasUpdate && (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Rocket className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-primary">发现新版本 {updateInfo.latestVersion}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      来源：{updateInfo.source === "release" ? "GitHub Release" : "GitHub Tag"}
                      {updateInfo.publishedAt ? `，发布时间：${new Date(updateInfo.publishedAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                </div>
                <Badge className="w-fit">可升级</Badge>
              </div>
            </div>
          )}

          {updateInfo && !updateInfo.error && !updateInfo.hasUpdate && (
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
              当前已是最新版本，上次检查时间：{new Date(updateInfo.checkedAt).toLocaleString()}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleCheckUpdate}
              disabled={checkingUpdate || isUpgradeRunning}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${checkingUpdate ? "animate-spin" : ""}`} />
              {checkingUpdate ? "检查中..." : "检查更新"}
            </Button>
            <Button
              onClick={() => {
                if (!updateInfo?.latestVersion) {
                  toast.error("请先检查更新");
                  return;
                }
                if (!upgradeEnabled) {
                  toast.error("未配置升级命令，无法自动升级");
                  return;
                }
                setShowUpgradeConfirm(true);
              }}
              disabled={!updateInfo?.hasUpdate || !upgradeEnabled || isUpgradeRunning || startUpgradeMutation.isPending}
              className="gap-2"
            >
              <Rocket className="h-4 w-4" />
              {isUpgradeRunning ? "升级中..." : "升级并重启"}
            </Button>
            {updateInfo?.releaseUrl && (
              <Button variant="ghost" asChild className="gap-2">
                <a href={updateInfo.releaseUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  查看 GitHub
                </a>
              </Button>
            )}
          </div>

          {upgradeStatus?.job && upgradeStatus.job.status !== "idle" && (
            <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    upgradeStatus.job.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : upgradeStatus.job.status === "success"
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-primary/10 text-primary"
                  }`}>
                    {upgradeStatus.job.status === "error" ? (
                      <AlertTriangle className="h-5 w-5" />
                    ) : upgradeStatus.job.status === "success" ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Rocket className="h-5 w-5 animate-pulse" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">
                      {upgradeStatus.job.status === "success"
                        ? "升级成功"
                        : upgradeStatus.job.status === "error"
                          ? "升级出现异常"
                          : "正在升级"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {upgradeStatus.job.status === "success"
                        ? `已完成 ${upgradeStatus.job.targetVersion || ""} 升级`
                        : upgradeStatus.job.status === "error"
                          ? "升级未完成，请查看下方异常信息"
                          : upgradeProgress.label}
                    </p>
                  </div>
                </div>
                <Badge variant={upgradeStatus.job.status === "error" ? "destructive" : "outline"} className="w-fit">
                  {upgradeStatus.job.targetVersion}
                </Badge>
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{upgradeProgress.label}</span>
                  <span>{upgradeProgress.percent}%</span>
                </div>
                <Progress value={upgradeProgress.percent} className="h-2" />
                <div className="grid gap-2 sm:grid-cols-4">
                  {upgradeProgress.steps.map((step) => (
                    <div
                      key={step.label}
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        step.done
                          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500"
                          : step.active
                            ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/40 bg-background/40 text-muted-foreground"
                      }`}
                    >
                      {step.label}
                    </div>
                  ))}
                </div>
              </div>

              {upgradeStatus.job.status === "error" && (
                <div className="mt-4 space-y-2">
                  {upgradeStatus.job.error && (
                    <p className="text-xs font-medium text-destructive">{upgradeStatus.job.error}</p>
                  )}
                  <pre className="max-h-64 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
                    {upgradeErrorLogs || "暂无异常日志"}
                  </pre>
                  <div className="rounded-lg border border-destructive/25 bg-background/80 p-3 text-xs">
                    <p className="font-medium text-destructive">自动升级失败时，可以在服务器执行对应的一键脚本手动升级：</p>
                    <div className="mt-2 space-y-2">
                      {manualPanelUpgradeCommands.map((item) => (
                        <div key={item.label} className="space-y-1">
                          <span className="text-muted-foreground">{item.label}</span>
                          <code className="block overflow-x-auto rounded border bg-muted/30 p-2 font-mono text-[11px] text-foreground">
                            {item.command}
                          </code>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 开源与社区 */}
      <Dialog open={showUpgradeConfirm} onOpenChange={setShowUpgradeConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              确认升级并重启
            </DialogTitle>
            <DialogDescription>
              即将升级到 {updateInfo?.latestVersion}。升级过程中服务会重新构建并重启，面板可能短暂不可用。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前版本</span>
              <code>v{upgradeStatus?.currentVersion || settings?.version}</code>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-muted-foreground">目标版本</span>
              <code>{updateInfo?.latestVersion}</code>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpgradeConfirm(false)}>
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={startUpgradeMutation.isPending || isUpgradeRunning}
              onClick={() => {
                if (!updateInfo?.latestVersion) return;
                setShowUpgradeConfirm(false);
                startUpgradeMutation.mutate({ targetVersion: updateInfo.latestVersion });
              }}
            >
              <Rocket className="h-4 w-4" />
              确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-primary" />
            开源与联系
          </CardTitle>
          <CardDescription>
            ForwardX 是开源项目，欢迎提交 Issue 与 PR，也可通过以下渠道联系作者。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* GitHub 开源地址 */}
          <a
            href={settings?.repoUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-border/40 p-3 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
                <Github className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">GitHub 仓库</p>
                <p className="text-xs text-muted-foreground truncate font-mono">{settings?.repoUrl}</p>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
          </a>

          {/* Telegram 双向消息机器人 */}
          <a
            href={settings?.telegramBotUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between rounded-lg border border-border/40 p-3 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
                <Send className="h-4 w-4 text-sky-500" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">Telegram 双向消息机器人</p>
                <p className="text-xs text-muted-foreground truncate font-mono">{settings?.telegramBotUrl}</p>
              </div>
            </div>
            <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
          </a>

          <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
            <span>当前版本</span>
            <code className="font-mono">v{settings?.version}</code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Settings() {
  return (
    <DashboardLayout>
      <SettingsContent />
    </DashboardLayout>
  );
}

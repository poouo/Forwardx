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
  Upload,
  DatabaseBackup,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

function SettingsContent() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/");
    }
  }, [user, setLocation]);

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
      toast.success("Token 已删除");
    },
    onError: (err) => toast.error(err.message || "删除 Token 失败"),
  });

  const [showCreate, setShowCreate] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptToken, setScriptToken] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const importMutation = trpc.config.importAll.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
    },
  });
  const [newToken, setNewToken] = useState("");
  const [description, setDescription] = useState("");
  const [panelUrl, setPanelUrl] = useState(window.location.origin);

  const { data: scriptData } = trpc.agentTokens.getInstallScript.useQuery(
    { token: scriptToken },
    { enabled: !!scriptToken && showScript }
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

  const getInstallCommand = (token: string) => {
    return `curl -sL ${panelUrl}/api/agent/install.sh | PANEL_URL="${panelUrl}" bash -s -- install ${token}`;
  };

  const getUninstallCommand = () => {
    return `curl -sL ${panelUrl}/api/agent/install.sh | bash -s -- uninstall`;
  };

  if (user?.role !== "admin") return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">系统设置</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理 Agent Token 和一键安装脚本
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
          <Key className="h-3 w-3 text-primary" />
          {tokens?.length ?? 0} 个 Token
        </Badge>
      </div>

      <Tabs defaultValue="tokens" className="space-y-4">
        <TabsList className="bg-muted/30 border border-border/30">
          <TabsTrigger value="tokens" className="gap-1.5">
            <Key className="h-3.5 w-3.5" />
            Agent Token
          </TabsTrigger>
          <TabsTrigger value="install" className="gap-1.5">
            <Terminal className="h-3.5 w-3.5" />
            一键安装
          </TabsTrigger>
          <TabsTrigger value="backup" className="gap-1.5">
            <DatabaseBackup className="h-3.5 w-3.5" />
            备份与恢复
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
                        <TableHead>描述</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>创建时间</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <code className="text-xs bg-muted/40 px-2 py-1 rounded font-mono">
                                {t.token.substring(0, 16)}...
                              </code>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() => copyToClipboard(t.token)}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell>
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
                          <TableCell>
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
                                  setScriptToken(t.token);
                                  setShowScript(true);
                                }}
                              >
                                <Terminal className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => {
                                  if (confirm("确定要删除此 Token 吗？"))
                                    deleteTokenMutation.mutate({ id: t.id });
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
              <div className="space-y-2">
                <Label className="text-sm">面板地址</Label>
                <Input
                  value={panelUrl}
                  onChange={(e) => setPanelUrl(e.target.value)}
                  placeholder="https://your-panel.com"
                  className="font-mono text-sm"
                />
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium">安装步骤</p>
                <div className="space-y-3">
                  {[
                    "在 \"Agent Token\" 标签页中创建一个新 Token",
                    "点击 Token 行的终端图标查看安装脚本",
                    "在被控机上以 root 权限执行安装命令",
                    "Agent 将自动注册并开始上报状态",
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
                    安装命令（替换 YOUR_TOKEN）：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/50 p-3 rounded border overflow-x-auto">
                      curl -sL {panelUrl}/api/agent/install.sh | PANEL_URL="{panelUrl}" bash -s -- install YOUR_TOKEN
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() =>
                        copyToClipboard(
                          `curl -sL ${panelUrl}/api/agent/install.sh | PANEL_URL="${panelUrl}" bash -s -- install YOUR_TOKEN`
                        )
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-2 font-medium flex items-center gap-1.5">
                    <Trash2 className="h-3 w-3" />
                    卸载命令：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/50 p-3 rounded border overflow-x-auto">
                      curl -sL {panelUrl}/api/agent/install.sh | bash -s -- uninstall
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

        {/* Backup & Restore Tab */}
        <TabsContent value="backup" className="space-y-4">
          <Alert variant="destructive">
            <DatabaseBackup className="h-4 w-4" />
            <AlertTitle>跨版本升级请使用 导出 / 导入 迁移数据</AlertTitle>
            <AlertDescription>
              面板 不保证 跨版本在原数据库中自动保留历史数据。请在升级前点击下方 <b>导出配置</b>，
              保存 JSON 文件后再部署新版本；新面板启动完成后使用 <b>导入配置</b> 即可恢复主机、规则与 Token。
            </AlertDescription>
          </Alert>
          <Alert>
            <DatabaseBackup className="h-4 w-4" />
            <AlertTitle>面板配置备份</AlertTitle>
            <AlertDescription>
              导出内容涵盖 <b>Agent Token</b>、<b>被控主机（包含 agent token / IP / OS / CPU / 内存 / 心跳状态）</b>、
              <b>转发规则</b>。导出文件为 JSON，包含明文凭证与 Token，请妥善保管。
              导入默认 <code>merge</code>同名跳过；选择 <code>replace</code> 会先清空当前用户的主机/规则/Token 后全量导入。
            </AlertDescription>
          </Alert>

          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="h-4 w-4" /> 导出配置
              </CardTitle>
              <CardDescription className="text-xs">
                一键下载当前面板配置 JSON，可用于跨实例迁移或升级后恢复。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={async () => {
                  try {
                    const data = await utils.config.exportAll.fetch();
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `forwardx-config-${new Date().toISOString().slice(0, 10)}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    toast.success(`已导出：主机 ${data.hosts.length} 条、规则 ${data.rules.length} 条、Token ${data.agentTokens.length} 条`);
                  } catch (e: any) {
                    toast.error(e?.message || "导出配置失败，请稍后重试");
                  }
                }}
                className="gap-2"
              >
                <Download className="h-4 w-4" /> 导出为 JSON
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="h-4 w-4" /> 导入配置
              </CardTitle>
              <CardDescription className="text-xs">
                选择之前导出的 JSON 文件，选择合并或覆盖模式后导入。导入后所有规则默认以未运行状态重新下发到 Agent。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <Label className="text-xs text-muted-foreground">模式</Label>
                <Select value={importMode} onValueChange={(v: any) => setImportMode(v)}>
                  <SelectTrigger className="w-[180px] h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="merge">merge（同名跳过）</SelectItem>
                    <SelectItem value="replace">replace（先清空再全量导入）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input
                type="file"
                accept="application/json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const text = await f.text();
                    const json = JSON.parse(text);
                    if (importMode === "replace" && !confirm("覆盖模式将删除当前用户的主机 / 规则 / Agent Token。确定继续吗？")) {
                      e.currentTarget.value = "";
                      return;
                    }
                    setImporting(true);
                    const result = await importMutation.mutateAsync({ mode: importMode, payload: json });
                    setImportResult(result);
                    toast.success(
                      `导入完成：主机 +${result.summary.hosts.created}/-${result.summary.hosts.skipped}、` +
                      `规则 +${result.summary.rules.created}/-${result.summary.rules.skipped}、` +
                      `Token +${result.summary.agentTokens.created}/-${result.summary.agentTokens.skipped}`
                    );
                  } catch (err: any) {
                    toast.error(err?.message || "导入配置失败，请检查文件格式");
                  } finally {
                    setImporting(false);
                    e.currentTarget.value = "";
                  }
                }}
                disabled={importing}
                className="max-w-md"
              />
              {importResult && (
                <div className="rounded-md border border-border/40 bg-muted/30 p-3 text-xs space-y-1">
                  <div>主机: 新增 {importResult.summary.hosts.created}，跳过 {importResult.summary.hosts.skipped}</div>
                  <div>Agent Token: 新增 {importResult.summary.agentTokens.created}，跳过 {importResult.summary.agentTokens.skipped}</div>
                  <div>转发规则: 新增 {importResult.summary.rules.created}，跳过 {importResult.summary.rules.skipped}</div>
                </div>
              )}
            </CardContent>
          </Card>
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
              请妥善保存此 Token，它不会再次显示
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 rounded-lg bg-muted/20 border border-border/30">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono break-all">{newToken}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(newToken)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
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
                  {getInstallCommand(scriptToken)}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(getInstallCommand(scriptToken))}
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

          </div>
          <DialogFooter>
            <Button onClick={() => setShowScript(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

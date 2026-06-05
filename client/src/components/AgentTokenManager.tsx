import { useAuth } from "@/_core/hooks/useAuth";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Alert, AlertTitle } from "@/components/ui/alert";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Key,
  Loader2,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type AgentTokenManagerProps = {
  createSignal?: number;
  className?: string;
  showCreateButton?: boolean;
  onCreateSignalHandled?: () => void;
};

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function tokenHostAddress(host: any) {
  if (!host) return "";
  return host.entryIp || host.ipv4 || host.ipv6 || host.ip || "";
}

function CommandRow({
  label,
  command,
  onCopy,
  copyDisabled,
}: {
  label: string;
  command: string;
  onCopy: () => void;
  copyDisabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0 overflow-hidden rounded border bg-muted/30">
          <div className="h-12 overflow-x-scroll overflow-y-hidden">
            <code className="flex h-full w-max min-w-full items-center whitespace-nowrap px-3 pb-3 pt-2 font-mono text-xs leading-5">
              {command}
            </code>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          aria-disabled={copyDisabled}
          onClick={() => {
            if (copyDisabled) return;
            onCopy();
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default function AgentTokenManager({
  createSignal,
  className,
  showCreateButton = true,
  onCreateSignalHandled,
}: AgentTokenManagerProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [showCreate, setShowCreate] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptToken, setScriptToken] = useState("");
  const [loadingScriptTokenId, setLoadingScriptTokenId] = useState<number | null>(null);
  const [newToken, setNewToken] = useState("");
  const [description, setDescription] = useState("");
  const [editingToken, setEditingToken] = useState<any>(null);
  const [editDescription, setEditDescription] = useState("");
  const [tokenToDelete, setTokenToDelete] = useState<any | null>(null);
  const lastCreateSignalRef = useRef(0);

  const openCreateDialog = () => {
    setDescription("");
    setShowCreate(true);
  };

  useEffect(() => {
    if (!createSignal) {
      lastCreateSignalRef.current = 0;
      return;
    }
    if (createSignal === lastCreateSignalRef.current) return;
    lastCreateSignalRef.current = createSignal;
    openCreateDialog();
    onCreateSignalHandled?.();
  }, [createSignal]);

  const { data: tokens, isLoading } = trpc.agentTokens.list.useQuery(
    undefined,
    { enabled: user?.role === "admin" }
  );

  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const panelUrl = (systemSettings?.panelPublicUrl && systemSettings.panelPublicUrl.trim())
    || (typeof window !== "undefined" ? window.location.origin : "");
  const githubAcceleratorUrl = normalizeConfigUrl(systemSettings?.githubAccelerator?.url || "");
  const githubAcceleratorActive = !!systemSettings?.githubAccelerator?.enabled && !!githubAcceleratorUrl;
  const agentPreferPanelInstall = !!systemSettings?.agentPreferPanelInstall;

  const createTokenMutation = trpc.agentTokens.create.useMutation({
    onSuccess: (data) => {
      utils.agentTokens.list.invalidate();
      toast.success("安装 Token 已生成");
      setNewToken(data.token);
      setShowNewToken(true);
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.message || "生成 Token 失败"),
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

  const openScriptDialog = async (tokenId: number) => {
    try {
      setLoadingScriptTokenId(tokenId);
      const data = await utils.agentTokens.getInstallToken.fetch({ id: tokenId });
      setScriptToken(data.token);
      setShowScript(true);
    } catch (err: any) {
      toast.error(err?.message || "获取安装命令失败");
    } finally {
      setLoadingScriptTokenId(null);
    }
  };

  const copyToClipboard = async (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("已复制到剪贴板");
        return;
      } catch (err) {
        console.warn("[Clipboard] navigator.clipboard 失败，回退 execCommand:", err);
      }
    }

    let success = false;
    const host =
      (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) ||
      document.body;
    const textarea = document.createElement("textarea");
    try {
      textarea.value = text;
      textarea.setAttribute("readonly", "");
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

    try {
      window.prompt("复制失败，请手动选中并复制 (Ctrl+C / Cmd+C)：", text);
      toast.warning("未能自动写入剪贴板，已弹出手动复制窗口");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const getAgentScriptCommand = (args: string) => {
    const env = [
      githubAcceleratorActive ? "GITHUB_ACCELERATOR_ENABLED=true" : "",
      githubAcceleratorActive ? `GITHUB_ACCELERATOR_URL=${shellQuote(githubAcceleratorUrl)}` : "",
      agentPreferPanelInstall ? "FORWARDX_AGENT_PANEL_FIRST=true" : "",
    ].filter(Boolean).join(" ");
    const bashPrefix = env ? `${env} bash` : "bash";
    const withPipefail = (pipeline: string) => `bash -c ${shellQuote(`set -o pipefail; ${pipeline}`)}`;
    const panelCommand = withPipefail(`curl -fsSL --max-time 20 "${panelUrl}/api/agent/install.sh" | ${bashPrefix} -s -- ${args}`);
    const githubScriptUrl = githubAcceleratorActive
      ? `${githubAcceleratorUrl}/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh`
      : "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh";
    const githubCommand = withPipefail(`curl -fsSL --max-time 20 "${githubScriptUrl}" | PANEL_URL=${shellQuote(panelUrl)} ${bashPrefix} -s -- ${args}`);
    if (agentPreferPanelInstall) {
      return `${panelCommand} || ${githubCommand}`;
    }
    return `${githubCommand} || ${panelCommand}`;
  };

  const getInstallCommand = (token: string) => getAgentScriptCommand(`install ${token}`);
  const getUninstallCommand = () => getAgentScriptCommand("uninstall");
  const getUpgradeCommand = () => getAgentScriptCommand("upgrade");

  if (user?.role !== "admin") return null;

  return (
    <div className={`space-y-4 ${className || ""}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          通过 Agent Token 生成安装命令，主机上线后会自动绑定到面板。
        </p>
        {showCreateButton && (
          <Button onClick={openCreateDialog} className="w-full gap-2 sm:w-auto">
            <Plus className="h-4 w-4" />
            添加主机
          </Button>
        )}
      </div>

      <Alert className="border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>通讯已加密</AlertTitle>
      </Alert>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label="正在加载 Agent Token" />
            </div>
          ) : tokens && tokens.length > 0 ? (
            <>
              <div className="space-y-3 p-3 sm:hidden">
                {tokens.map((tokenItem) => (
                  <div key={tokenItem.id} className="rounded-lg border border-border/40 bg-muted/20 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Token</p>
                        <code className="mt-1 block break-all rounded bg-background/60 px-2 py-1 font-mono text-xs">
                          {tokenItem.token}
                        </code>
                        {tokenItem.description && (
                          <p className="mt-2 break-words text-xs text-muted-foreground">{tokenItem.description}</p>
                        )}
                      </div>
                      {tokenItem.isUsed ? (
                        <Badge className="shrink-0 bg-chart-2/10 text-chart-2 border-chart-2/20 text-[10px]">
                          已使用
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          未使用
                        </Badge>
                      )}
                    </div>
                    <div className="mt-3 rounded-md bg-background/45 p-2 text-xs">
                      <p className="text-muted-foreground">对应主机</p>
                      {tokenItem.host ? (
                        <div className="mt-1 min-w-0">
                          <p className="break-words font-medium">{tokenItem.host.name}</p>
                          {tokenHostAddress(tokenItem.host) && (
                            <p className="break-all font-mono text-muted-foreground">{tokenHostAddress(tokenItem.host)}</p>
                          )}
                        </div>
                      ) : (
                        <p className="mt-1 text-muted-foreground">{tokenItem.isUsed ? "关联主机不存在" : "-"}</p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(tokenItem.createdAt).toLocaleString()}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="查看安装命令"
                          disabled={loadingScriptTokenId === tokenItem.id}
                          onClick={() => openScriptDialog(tokenItem.id)}
                        >
                          {loadingScriptTokenId === tokenItem.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Terminal className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="编辑备注"
                          onClick={() => {
                            setEditingToken(tokenItem);
                            setEditDescription(tokenItem.description || "");
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setTokenToDelete(tokenItem)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Token</TableHead>
                      <TableHead className="hidden sm:table-cell">描述</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>对应主机</TableHead>
                      <TableHead className="hidden md:table-cell">创建时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tokens.map((tokenItem) => (
                      <TableRow key={tokenItem.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <code className="text-xs bg-muted/40 px-2 py-1 rounded font-mono">
                              {tokenItem.token}
                            </code>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-sm text-muted-foreground">{tokenItem.description || "-"}</span>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            {tokenItem.isUsed ? (
                              <Badge className="bg-chart-2/10 text-chart-2 border-chart-2/20 text-[10px]">
                                <CheckCircle2 className="h-3 w-3 mr-1" />
                                已使用
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                未使用
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {tokenItem.host ? (
                            <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
                              <span className="flex h-9 w-4 shrink-0 items-center justify-center">
                                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                              </span>
                              <div className="min-w-0">
                                <span className="block max-w-[220px] truncate font-medium" title={tokenItem.host.name}>
                                  {tokenItem.host.name}
                                </span>
                                {tokenHostAddress(tokenItem.host) && (
                                  <span className="block max-w-[220px] truncate font-mono text-muted-foreground" title={tokenHostAddress(tokenItem.host)}>
                                    {tokenHostAddress(tokenItem.host)}
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{tokenItem.isUsed ? "关联主机不存在" : "-"}</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(tokenItem.createdAt).toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="查看安装命令"
                              disabled={loadingScriptTokenId === tokenItem.id}
                              onClick={() => openScriptDialog(tokenItem.id)}
                            >
                              {loadingScriptTokenId === tokenItem.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Terminal className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="编辑备注"
                              onClick={() => {
                                setEditingToken(tokenItem);
                                setEditDescription(tokenItem.description || "");
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => setTokenToDelete(tokenItem)}
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
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <Key className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无 Token</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                添加主机后会生成 Agent 安装命令
              </p>
              {showCreateButton && (
                <Button
                  onClick={openCreateDialog}
                  variant="outline"
                  className="mt-4 gap-2"
                >
                  <Plus className="h-4 w-4" />
                  添加主机
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加主机</DialogTitle>
            <DialogDescription>
              先生成 Agent 安装 Token，再复制命令到目标主机执行。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>描述（可选）</Label>
              <Input
                placeholder="例如: 香港节点 Agent"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button
              onClick={() => createTokenMutation.mutate({ description: description || undefined })}
              disabled={createTokenMutation.isPending}
            >
              生成安装命令
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewToken} onOpenChange={setShowNewToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-chart-2" />
              安装命令已生成
            </DialogTitle>
            <DialogDescription>
              复制命令到目标主机执行，Agent 上线后会自动出现在主机列表。
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
              备注会作为新主机默认名称。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>备注</Label>
            <Input
              value={editDescription}
              maxLength={200}
              placeholder="例如：香港节点 Agent"
              onChange={(event) => setEditDescription(event.target.value)}
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
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokenToDelete} onOpenChange={(open) => !open && setTokenToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              删除 Agent Token
            </DialogTitle>
            <DialogDescription>
              删除后关联主机会离线。
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
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showScript} onOpenChange={(open) => {
        setShowScript(open);
        if (!open) setScriptToken("");
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[42rem] sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              安装命令
            </DialogTitle>
            <DialogDescription>
              使用 root 执行命令。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <CommandRow
              label="安装命令"
              command={scriptToken ? getInstallCommand(scriptToken) : ""}
              copyDisabled={!scriptToken}
              onCopy={() => scriptToken && copyToClipboard(getInstallCommand(scriptToken))}
            />
            <CommandRow
              label="卸载命令"
              command={getUninstallCommand()}
              onCopy={() => copyToClipboard(getUninstallCommand())}
            />
            <CommandRow
              label="升级命令"
              command={getUpgradeCommand()}
              onCopy={() => copyToClipboard(getUpgradeCommand())}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowScript(false);
              setScriptToken("");
            }}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

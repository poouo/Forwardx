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
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type TunnelForm = {
  name: string;
  entryHostId: number | null;
  exitHostId: number | null;
  mode: "socks5" | "http" | "relay";
  listenPort: number;
};

const defaultForm: TunnelForm = {
  name: "",
  entryHostId: null,
  exitHostId: null,
  mode: "socks5",
  listenPort: 0,
};

function TunnelsContent() {
  const utils = trpc.useUtils();
  const { data: tunnels, isLoading } = trpc.tunnels.list.useQuery(undefined, { refetchInterval: 10000 });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<TunnelForm>(defaultForm);

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
      mode: tunnel.mode || "socks5",
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

  const testMutation = trpc.tunnels.test.useMutation({
    onSuccess: (data) => {
      utils.tunnels.list.invalidate();
      toast.success(data.success ? `隧道出口可达，延迟 ${data.latencyMs}ms` : "隧道出口不可达");
    },
    onError: (e) => toast.error(e.message || "测试失败"),
  });

  const handleSubmit = () => {
    if (!form.name || !form.entryHostId || !form.exitHostId || !form.listenPort) {
      toast.error("请填写隧道名称、两台 Agent 和监听端口");
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
            使用两台公网 Agent 组建 gost 隧道，供转发规则复用
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
                          {tunnel.mode}
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
                            title="测试隧道延迟"
                            onClick={() => testMutation.mutate({ id: tunnel.id })}
                          >
                            {testMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
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

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑隧道" : "添加隧道"}</DialogTitle>
            <DialogDescription>入口 Agent 负责使用隧道，出口 Agent 提供 gost 出口服务。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>隧道名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 华东-香港隧道" />
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>隧道方式</Label>
                <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="relay">Relay</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>出口监听端口</Label>
                <Input type="number" value={form.listenPort || ""} onChange={(e) => setForm({ ...form, listenPort: Number(e.target.value) || 0 })} placeholder="例如: 18080" />
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

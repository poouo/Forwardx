import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Pencil,
  Server,
  Monitor,
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  X,
} from "lucide-react";
import { useState, useMemo } from "react";
import { toast } from "sonner";

function formatBytes(bytes: number | null | undefined): string {
  const num = Number(bytes);
  if (!num || isNaN(num) || num === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(Math.abs(num)) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

type HostFormData = {
  name: string;
  ip: string;
  port: number;
  hostType: "master" | "slave";
  connectionType: "ssh" | "agent";
  sshUser: string;
  sshPassword: string;
  sshKeyContent: string;
  networkInterface: string;
  portRangeStart: number | null;
  portRangeEnd: number | null;
};

const defaultFormData: HostFormData = {
  name: "",
  ip: "",
  port: 22,
  hostType: "slave",
  connectionType: "agent",
  sshUser: "root",
  sshPassword: "",
  sshKeyContent: "",
  networkInterface: "",
  portRangeStart: null,
  portRangeEnd: null,
};

function HostDetailPanel({ hostId, onClose }: { hostId: number; onClose: () => void }) {
  const { data: host } = trpc.hosts.getById.useQuery({ id: hostId });
  const { data: metrics } = trpc.hosts.metrics.useQuery(
    { hostId, limit: 1 },
    { refetchInterval: 15000 }
  );

  const latestMetric = metrics?.[0];

  if (!host) return null;

  return (
    <Card className="border-border/40 bg-card/60 backdrop-blur-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            {host.name}
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">IP 地址</p>
            <p className="text-sm font-mono">{host.ip}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">状态</p>
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${host.isOnline ? "bg-chart-2 animate-pulse" : "bg-muted-foreground/30"}`} />
              <span className="text-sm">{host.isOnline ? "在线" : "离线"}</span>
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">系统</p>
            <p className="text-sm truncate">{host.osInfo || "-"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">连接方式</p>
            <Badge variant="outline" className="text-[10px]">
              {host.connectionType === "ssh" ? "SSH" : "Agent"}
            </Badge>
          </div>
          {((host as any).portRangeStart != null && (host as any).portRangeEnd != null) && (
            <div className="space-y-1 col-span-2">
              <p className="text-xs text-muted-foreground">端口区间</p>
              <p className="text-sm font-mono">{(host as any).portRangeStart} - {(host as any).portRangeEnd}</p>
            </div>
          )}
        </div>

        {latestMetric ? (
          <div className="space-y-3 pt-2 border-t border-border/30">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><Cpu className="h-3 w-3" /> CPU</span>
                <span className="font-medium tabular-nums">{latestMetric.cpuUsage ?? 0}%</span>
              </div>
              <Progress value={latestMetric.cpuUsage ?? 0} className="h-1.5" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><MemoryStick className="h-3 w-3" /> 内存</span>
                <span className="font-medium tabular-nums">{latestMetric.memoryUsage ?? 0}%</span>
              </div>
              <Progress value={latestMetric.memoryUsage ?? 0} className="h-1.5" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="h-3 w-3" /> 磁盘</span>
                <span className="font-medium tabular-nums">{latestMetric.diskUsage ?? 0}%</span>
              </div>
              <Progress value={latestMetric.diskUsage ?? 0} className="h-1.5" />
            </div>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="flex items-center gap-2 text-xs">
                <ArrowDownToLine className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">入站</span>
                <span className="font-medium ml-auto">{formatBytes(latestMetric.networkIn)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <ArrowUpFromLine className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">出站</span>
                <span className="font-medium ml-auto">{formatBytes(latestMetric.networkOut)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs pt-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">运行时间</span>
              <span className="font-medium ml-auto">{formatUptime(latestMetric.uptime)}</span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-muted-foreground/60 border-t border-border/30">
            <p className="text-xs">暂无监控数据</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HostsContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: hosts, isLoading } = trpc.hosts.list.useQuery(undefined, {
    refetchInterval: 15000,
  });

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<number | null>(null);
  const [form, setForm] = useState<HostFormData>(defaultFormData);

  const createMutation = trpc.hosts.create.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机添加成功");
    },
    onError: (err) => toast.error(err.message || "添加失败"),
  });

  const updateMutation = trpc.hosts.update.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("主机更新成功");
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.hosts.delete.useMutation({
    onSuccess: () => {
      utils.hosts.list.invalidate();
      setSelectedHostId(null);
      toast.success("主机已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  const resetForm = () => {
    setForm(defaultFormData);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEdit = (host: any) => {
    setForm({
      name: host.name,
      ip: host.ip,
      port: host.port ?? 22,
      hostType: host.hostType,
      connectionType: host.connectionType,
      sshUser: host.sshUser || "root",
      sshPassword: "",
      sshKeyContent: host.sshKeyContent || "",
      networkInterface: host.networkInterface || "",
      portRangeStart: host.portRangeStart ?? null,
      portRangeEnd: host.portRangeEnd ?? null,
    });
    setEditingId(host.id);
    setShowDialog(true);
  };

  const handleSubmit = () => {
    // 验证端口区间
    if (form.portRangeStart != null && form.portRangeEnd != null) {
      if (form.portRangeStart > form.portRangeEnd) {
        toast.error("端口区间起始值不能大于结束值");
        return;
      }
    }
    if ((form.portRangeStart != null && form.portRangeEnd == null) ||
        (form.portRangeStart == null && form.portRangeEnd != null)) {
      toast.error("请同时填写端口区间的起始和结束值，或同时留空");
      return;
    }

    const payload: any = { ...form };
    if (!payload.networkInterface) payload.networkInterface = undefined;
    if (payload.connectionType !== "ssh") {
      payload.port = undefined;
      payload.sshUser = undefined;
      payload.sshPassword = undefined;
      payload.sshKeyContent = undefined;
    }
    // 端口区间
    payload.portRangeStart = form.portRangeStart || null;
    payload.portRangeEnd = form.portRangeEnd || null;

    if (editingId) {
      updateMutation.mutate({ id: editingId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onlineCount = useMemo(() => hosts?.filter((h) => h.isOnline).length ?? 0, [hosts]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">主机管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理主控机和被控机，监控运行状态
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <Server className="h-3 w-3 text-chart-2" />
            {onlineCount} / {hosts?.length ?? 0} 在线
          </Badge>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            添加主机
          </Button>
        </div>
      </div>

      <div className={`grid gap-4 ${selectedHostId ? "grid-cols-1 lg:grid-cols-3" : "grid-cols-1"}`}>
        <div className={selectedHostId ? "lg:col-span-2" : ""}>
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-6 space-y-3">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : hosts && hosts.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[50px]">状态</TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead>IP 地址</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>连接方式</TableHead>
                        <TableHead>端口区间</TableHead>
                        <TableHead>系统</TableHead>
                        <TableHead>最后心跳</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hosts.map((host) => (
                        <TableRow
                          key={host.id}
                          className={`cursor-pointer transition-colors ${selectedHostId === host.id ? "bg-muted/30" : ""}`}
                          onClick={() => setSelectedHostId(selectedHostId === host.id ? null : host.id)}
                        >
                          <TableCell>
                            <div className="flex items-center justify-center">
                              {host.isOnline ? (
                                <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                              ) : (
                                <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Server className="h-4 w-4 text-muted-foreground" />
                              <span className="font-medium">{host.name}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <code className="text-xs font-mono bg-muted/40 px-2 py-0.5 rounded">
                              {host.ip}
                            </code>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                host.hostType === "master"
                                  ? "border-amber-500/30 text-amber-400"
                                  : "border-blue-500/30 text-blue-400"
                              }`}
                            >
                              {host.hostType === "master" ? "主控" : "被控"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-[10px]">
                              {host.connectionType === "ssh" ? "SSH" : "Agent"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground font-mono">
                              {(host as any).portRangeStart != null && (host as any).portRangeEnd != null
                                ? `${(host as any).portRangeStart}-${(host as any).portRangeEnd}`
                                : "不限制"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground truncate max-w-[120px] block">
                              {host.osInfo || "-"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">
                              {host.lastHeartbeat
                                ? new Date(host.lastHeartbeat).toLocaleString()
                                : "-"}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => openEdit(host)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => {
                                  if (confirm("确定要删除此主机吗？"))
                                    deleteMutation.mutate({ id: host.id });
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
                    <Server className="h-8 w-8 opacity-40" />
                  </div>
                  <p className="text-lg font-medium">暂无主机</p>
                  <p className="text-sm mt-1 text-muted-foreground/60">
                    添加主控机或被控机开始管理
                  </p>
                  <Button onClick={openCreate} variant="outline" className="mt-4 gap-2">
                    <Plus className="h-4 w-4" />
                    添加第一台主机
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {selectedHostId && (
          <HostDetailPanel
            hostId={selectedHostId}
            onClose={() => setSelectedHostId(null)}
          />
        )}
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑主机" : "添加主机"}</DialogTitle>
            <DialogDescription>
              {editingId ? "修改主机配置信息" : "添加一台新的主控机或被控机"}
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="basic" className="space-y-4">
            <TabsList className="w-full bg-muted/50">
              <TabsTrigger value="basic" className="flex-1">基本信息</TabsTrigger>
              <TabsTrigger value="port" className="flex-1">端口限制</TabsTrigger>
              {form.connectionType === "ssh" && (
                <TabsTrigger value="ssh" className="flex-1">SSH 配置</TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="basic" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>主机名称</Label>
                  <Input
                    placeholder="例如: 香港节点-01"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>IP 地址</Label>
                  <Input
                    placeholder="例如: 192.168.1.100"
                    value={form.ip}
                    onChange={(e) => setForm({ ...form, ip: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>
                    端口
                    {form.connectionType !== "ssh" && (
                      <span className="ml-1 text-xs text-muted-foreground">(仅 SSH 可改)</span>
                    )}
                  </Label>
                  <Input
                    type="number"
                    value={form.connectionType === "ssh" ? form.port : 22}
                    disabled={form.connectionType !== "ssh"}
                    onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>主机类型</Label>
                  <Select value={form.hostType} onValueChange={(v) => setForm({ ...form, hostType: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="master">主控机</SelectItem>
                      <SelectItem value="slave">被控机</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>连接方式</Label>
                  <Select
                    value={form.connectionType}
                    onValueChange={(v) => {
                      const next = v as "ssh" | "agent";
                      setForm({
                        ...form,
                        connectionType: next,
                        port: next === "ssh" ? (form.port || 22) : 22,
                      });
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="ssh">SSH</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>
                  网卡名称
                  <span className="ml-1 text-xs text-muted-foreground">(可选，留空自动检测)</span>
                </Label>
                <Input
                  placeholder="例如: eth0, ens33, bond0"
                  value={form.networkInterface}
                  onChange={(e) => setForm({ ...form, networkInterface: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  用于 realm 绑定网卡，留空则自动检测默认出口网卡
                </p>
              </div>
            </TabsContent>
            <TabsContent value="port" className="space-y-4">
              <div className="space-y-3">
                <div>
                  <Label className="text-sm font-medium">转发端口区间</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    限制该主机上转发规则的源端口范围，留空则不限制
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">起始端口</Label>
                    <Input
                      type="number"
                      placeholder="例如: 10000"
                      value={form.portRangeStart ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) : null;
                        setForm({ ...form, portRangeStart: v });
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">结束端口</Label>
                    <Input
                      type="number"
                      placeholder="例如: 20000"
                      value={form.portRangeEnd ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) : null;
                        setForm({ ...form, portRangeEnd: v });
                      }}
                    />
                  </div>
                </div>
                {form.portRangeStart != null && form.portRangeEnd != null && (
                  <p className="text-xs text-muted-foreground">
                    可用端口数量: <span className="font-medium">{Math.max(0, form.portRangeEnd - form.portRangeStart + 1)}</span> 个
                  </p>
                )}
                {form.portRangeStart != null && form.portRangeEnd != null && form.portRangeStart > form.portRangeEnd && (
                  <p className="text-xs text-destructive">
                    起始端口不能大于结束端口
                  </p>
                )}
              </div>
            </TabsContent>
            {form.connectionType === "ssh" && (
              <TabsContent value="ssh" className="space-y-4">
                <div className="space-y-2">
                  <Label>SSH 用户名</Label>
                  <Input
                    placeholder="root"
                    value={form.sshUser}
                    onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>SSH 密码</Label>
                  <Input
                    type="password"
                    placeholder="留空则使用密钥认证"
                    value={form.sshPassword}
                    onChange={(e) => setForm({ ...form, sshPassword: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>SSH 私钥（可选）</Label>
                  <Textarea
                    placeholder="粘贴 SSH 私钥内容..."
                    rows={4}
                    value={form.sshKeyContent}
                    onChange={(e) => setForm({ ...form, sshKeyContent: e.target.value })}
                    className="font-mono text-xs"
                  />
                </div>
              </TabsContent>
            )}
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={isPending || !form.name || !form.ip}>
              {isPending ? "处理中..." : editingId ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Hosts() {
  return (
    <DashboardLayout>
      <HostsContent />
    </DashboardLayout>
  );
}

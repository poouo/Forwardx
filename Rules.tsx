import { useAuth } from "@/_core/hooks/useAuth";
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
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Pencil,
  ArrowRightLeft,
  ArrowRight,
  Gauge,
  Zap,
  Shield,
  Filter,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Stethoscope,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useState, useMemo } from "react";
import { toast } from "sonner";

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

type RuleFormData = {
  hostId: number | null;
  name: string;
  forwardType: "iptables" | "realm" | "socat";
  protocol: "tcp" | "udp" | "both";
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  uploadLimit: number;
  downloadLimit: number;
};

const defaultForm: RuleFormData = {
  hostId: null,
  name: "",
  forwardType: "iptables",
  protocol: "tcp",
  sourcePort: 0,
  targetIp: "",
  targetPort: 0,
  uploadLimit: 0,
  downloadLimit: 0,
};

function formatSpeed(kbps: number): string {
  if (kbps === 0) return "不限速";
  if (kbps < 1024) return `${kbps} Kbps`;
  if (kbps < 1024 * 1024) return `${(kbps / 1024).toFixed(1)} Mbps`;
  return `${(kbps / 1024 / 1024).toFixed(1)} Gbps`;
}

function RulesContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: rules, isLoading } = trpc.rules.list.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const { data: hosts } = trpc.hosts.list.useQuery();

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const [filterHost, setFilterHost] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");

  const createMutation = trpc.rules.create.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("规则创建成功");
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.rules.update.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("规则更新成功");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.rules.delete.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      toast.success("规则已删除");
    },
    onError: (err) => toast.error(err.message),
  });

  // 近 24h 按规则汇总的流量（用于列表与顶部汇总卡片）
  const { data: trafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24 },
    { refetchInterval: 30000 }
  );
  const trafficByRule = useMemo(() => {
    const m = new Map<number, { bytesIn: number; bytesOut: number; connections: number }>();
    (trafficSummary || []).forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
        prev.connections += Number(t.connections) || 0;
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
          connections: Number(t.connections) || 0,
        });
      }
    });
    return m;
  }, [trafficSummary]);
  const trafficTotals = useMemo(() => {
    let bytesIn = 0;
    let bytesOut = 0;
    let connections = 0;
    (trafficSummary || []).forEach((t: any) => {
      bytesIn += Number(t.bytesIn) || 0;
      bytesOut += Number(t.bytesOut) || 0;
      connections += Number(t.connections) || 0;
    });
    return { bytesIn, bytesOut, connections };
  }, [trafficSummary]);

  const [trafficDetailRule, setTrafficDetailRule] = useState<{ id: number; name: string } | null>(null);
  const [selfTestRule, setSelfTestRule] = useState<{ id: number; name: string } | null>(null);

  const toggleMutation = trpc.rules.toggle.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
  };

  const openCreate = () => {
    resetForm();
    if (hosts && hosts.length > 0) {
      setForm({ ...defaultForm, hostId: hosts[0].id });
    }
    setShowDialog(true);
  };

  const openEdit = (rule: any) => {
    setForm({
      hostId: rule.hostId,
      name: rule.name,
      forwardType: rule.forwardType,
      protocol: rule.protocol,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      uploadLimit: rule.uploadLimit,
      downloadLimit: rule.downloadLimit,
    });
    setEditingId(rule.id);
    setShowDialog(true);
  };

  const handleSubmit = () => {
    if (!form.hostId || !form.name || !form.sourcePort || !form.targetIp || !form.targetPort) {
      toast.error("请填写所有必填字段");
      return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: form.name,
        forwardType: form.forwardType,
        protocol: form.protocol,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        uploadLimit: form.uploadLimit,
        downloadLimit: form.downloadLimit,
      });
    } else {
      createMutation.mutate({
        hostId: form.hostId!,
        name: form.name,
        forwardType: form.forwardType,
        protocol: form.protocol,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        uploadLimit: form.uploadLimit,
        downloadLimit: form.downloadLimit,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const filteredRules = useMemo(() => {
    if (!rules) return [];
    return rules.filter((r) => {
      if (filterHost !== "all" && r.hostId !== parseInt(filterHost)) return false;
      if (filterType !== "all" && r.forwardType !== filterType) return false;
      return true;
    });
  }, [rules, filterHost, filterType]);

  const activeCount = useMemo(() => rules?.filter((r) => r.isEnabled).length ?? 0, [rules]);

  const getHostName = (hostId: number) => {
    return hosts?.find((h) => h.id === hostId)?.name || `主机 #${hostId}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">转发规则</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            管理端口转发规则，支持 iptables、realm 和 socat
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <Zap className="h-3 w-3 text-chart-2" />
            {activeCount} / {rules?.length ?? 0} 活跃
          </Badge>
          <Button onClick={openCreate} className="gap-2" disabled={!hosts || hosts.length === 0}>
            <Plus className="h-4 w-4" />
            添加规则
          </Button>
        </div>
      </div>

      {rules && rules.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">筛选:</span>
          </div>
          <Select value={filterHost} onValueChange={setFilterHost}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue placeholder="所有主机" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有主机</SelectItem>
              {hosts?.map((h) => (
                <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="所有类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有类型</SelectItem>
              <SelectItem value="iptables">iptables</SelectItem>
              <SelectItem value="realm">realm</SelectItem>
              <SelectItem value="socat">socat</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* 近 24 小时转发流量汇总 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">近 24h 入向流量</p>
              <p className="text-xl font-semibold mt-1">{formatBytes(trafficTotals.bytesIn)}</p>
            </div>
            <ArrowDownToLine className="h-6 w-6 text-chart-2" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">近 24h 出向流量</p>
              <p className="text-xl font-semibold mt-1">{formatBytes(trafficTotals.bytesOut)}</p>
            </div>
            <ArrowUpFromLine className="h-6 w-6 text-chart-4" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">近 24h 连接数</p>
              <p className="text-xl font-semibold mt-1">{trafficTotals.connections.toLocaleString()}</p>
            </div>
            <Activity className="h-6 w-6 text-chart-3" />
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : filteredRules.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[60px]">状态</TableHead>
                    <TableHead>规则名称</TableHead>
                    <TableHead>所属主机</TableHead>
                    <TableHead>转发配置</TableHead>
                    <TableHead>工具</TableHead>
                    <TableHead>协议</TableHead>
                    <TableHead>限速</TableHead>
                    <TableHead>近 24h 流量</TableHead>
                    <TableHead>开关</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRules.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell>
                        <div className="flex items-center justify-center">
                          {rule.isRunning ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />
                          ) : rule.isEnabled ? (
                            <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                          ) : (
                            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{rule.name}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">{getHostName(rule.hostId)}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-mono text-xs">
                          <code className="bg-muted/40 px-1.5 py-0.5 rounded">:{rule.sourcePort}</code>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <code className="bg-muted/40 px-1.5 py-0.5 rounded">{rule.targetIp}:{rule.targetPort}</code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            rule.forwardType === "iptables"
                              ? "border-primary/30 text-primary"
                              : rule.forwardType === "socat"
                              ? "border-chart-5/30 text-chart-5"
                              : "border-chart-3/30 text-chart-3"
                          }`}
                        >
                          {rule.forwardType === "iptables" ? (
                            <><Shield className="h-3 w-3 mr-1" />iptables</>
                          ) : rule.forwardType === "socat" ? (
                            <><ArrowRightLeft className="h-3 w-3 mr-1" />socat</>
                          ) : (
                            <><Zap className="h-3 w-3 mr-1" />realm</>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-[10px] uppercase">
                          {rule.protocol}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {rule.uploadLimit > 0 || rule.downloadLimit > 0 ? (
                          <div className="flex items-center gap-1">
                            <Gauge className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                              {rule.uploadLimit > 0 ? `↑${formatSpeed(rule.uploadLimit)}` : ""}
                              {rule.uploadLimit > 0 && rule.downloadLimit > 0 ? " " : ""}
                              {rule.downloadLimit > 0 ? `↓${formatSpeed(rule.downloadLimit)}` : ""}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/50">不限速</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const t = trafficByRule.get(rule.id);
                          if (!t || (t.bytesIn === 0 && t.bytesOut === 0)) {
                            return <span className="text-xs text-muted-foreground">—</span>;
                          }
                          return (
                            <div className="flex flex-col gap-0.5 text-xs">
                              <span className="flex items-center gap-1 text-chart-2">
                                <ArrowDownToLine className="h-3 w-3" /> {formatBytes(t.bytesIn)}
                              </span>
                              <span className="flex items-center gap-1 text-chart-4">
                                <ArrowUpFromLine className="h-3 w-3" /> {formatBytes(t.bytesOut)}
                              </span>
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={rule.isEnabled}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: rule.id, isEnabled: checked })
                          }
                          className="scale-75"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setTrafficDetailRule({ id: rule.id, name: rule.name })}
                            title="查看流量趋势"
                          >
                            <Activity className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setSelfTestRule({ id: rule.id, name: rule.name })}
                            title="转发链路自测"
                          >
                            <Stethoscope className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openEdit(rule)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm("确定要删除此转发规则吗？"))
                                deleteMutation.mutate({ id: rule.id });
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
          ) : rules && rules.length > 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Filter className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-base font-medium">没有匹配的规则</p>
              <p className="text-sm mt-1 text-muted-foreground/60">尝试调整筛选条件</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <ArrowRightLeft className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">暂无转发规则</p>
              <p className="text-sm mt-1 text-muted-foreground/60">
                {hosts && hosts.length > 0
                  ? "创建转发规则开始端口转发"
                  : "请先添加主机，然后创建转发规则"}
              </p>
              {hosts && hosts.length > 0 && (
                <Button onClick={openCreate} variant="outline" className="mt-4 gap-2">
                  <Plus className="h-4 w-4" />
                  创建第一条规则
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {trafficDetailRule && (
        <TrafficDetailDialog
          ruleId={trafficDetailRule.id}
          ruleName={trafficDetailRule.name}
          open={!!trafficDetailRule}
          onOpenChange={(v) => {
            if (!v) setTrafficDetailRule(null);
          }}
        />
      )}

      {selfTestRule && (
        <SelfTestDialog
          ruleId={selfTestRule.id}
          ruleName={selfTestRule.name}
          open={!!selfTestRule}
          onOpenChange={(v) => { if (!v) setSelfTestRule(null); }}
        />
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑规则" : "添加转发规则"}</DialogTitle>
            <DialogDescription>
              {editingId ? "修改转发规则配置" : "创建新的端口转发规则"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>规则名称</Label>
                <Input
                  placeholder="例如: Web 服务转发"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>所属主机</Label>
                <Select
                  value={form.hostId ? String(form.hostId) : ""}
                  onValueChange={(v) => setForm({ ...form, hostId: parseInt(v) })}
                  disabled={!!editingId}
                >
                  <SelectTrigger><SelectValue placeholder="选择主机" /></SelectTrigger>
                  <SelectContent>
                    {hosts?.map((h) => (
                      <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>转发工具</Label>
                <Select value={form.forwardType} onValueChange={(v) => setForm({ ...form, forwardType: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iptables">iptables</SelectItem>
                    <SelectItem value="realm">realm</SelectItem>
                    <SelectItem value="socat">socat</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>协议</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                    <SelectItem value="both">TCP+UDP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>源端口</Label>
                <Input
                  type="number"
                  placeholder="8080"
                  value={form.sourcePort || ""}
                  onChange={(e) => setForm({ ...form, sourcePort: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>目标 IP</Label>
                <Input
                  placeholder="例如: 10.0.0.1"
                  value={form.targetIp}
                  onChange={(e) => setForm({ ...form, targetIp: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>目标端口</Label>
                <Input
                  type="number"
                  placeholder="80"
                  value={form.targetPort || ""}
                  onChange={(e) => setForm({ ...form, targetPort: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>

            <Separator className="my-2" />

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                <Label className="text-sm font-medium">限速设置</Label>
                <span className="text-xs text-muted-foreground">（0 = 不限速，单位: Kbps）</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">上行限速 (Kbps)</Label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={form.uploadLimit || ""}
                    onChange={(e) => setForm({ ...form, uploadLimit: parseInt(e.target.value) || 0 })}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    {form.uploadLimit > 0 ? formatSpeed(form.uploadLimit) : "不限速"}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">下行限速 (Kbps)</Label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={form.downloadLimit || ""}
                    onChange={(e) => setForm({ ...form, downloadLimit: parseInt(e.target.value) || 0 })}
                  />
                  <p className="text-[10px] text-muted-foreground/60">
                    {form.downloadLimit > 0 ? formatSpeed(form.downloadLimit) : "不限速"}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !form.name || !form.hostId || !form.sourcePort || !form.targetIp || !form.targetPort}
            >
              {isPending ? "处理中..." : editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TrafficDetailDialog({
  ruleId,
  ruleName,
  open,
  onOpenChange,
}: {
  ruleId: number;
  ruleName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [hours, setHours] = useState<number>(1);
  const bucketMinutes = hours <= 1 ? 1 : hours <= 6 ? 5 : 15;
  const { data, isLoading } = trpc.rules.trafficSeries.useQuery(
    { ruleId, hours, bucketMinutes },
    { enabled: open, refetchInterval: open ? 30000 : false }
  );
  const chartData = useMemo(
    () =>
      (data || []).map((d: any) => ({
        ts: new Date(d.bucket).getTime(),
        label: new Date(d.bucket).toLocaleTimeString(),
        bytesIn: Number(d.bytesIn) || 0,
        bytesOut: Number(d.bytesOut) || 0,
      })),
    [data]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>流量趋势 - {ruleName}</DialogTitle>
          <DialogDescription>基于 Agent 上报的 iptables 计数链采样绘制</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">时间范围:</span>
          {[
            { label: "近 1 小时", v: 1 },
            { label: "近 6 小时", v: 6 },
            { label: "近 24 小时", v: 24 },
          ].map((opt) => (
            <Button
              key={opt.v}
              size="sm"
              variant={hours === opt.v ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() => setHours(opt.v)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <div className="h-72 w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              暂无流量数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.4)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={32} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => formatBytes(v)} width={70} />
                <RTooltip
                  formatter={(value: any) => formatBytes(Number(value) || 0)}
                  labelFormatter={(l) => l}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="bytesIn" name="入向" stroke="hsl(var(--chart-2))" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="bytesOut" name="出向" stroke="hsl(var(--chart-4))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SelfTestDialog({
  ruleId,
  ruleName,
  open,
  onOpenChange,
}: {
  ruleId: number;
  ruleName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: latest, refetch } = trpc.rules.latestTest.useQuery(
    { ruleId },
    {
      enabled: open,
      // 轻量轮询：agent 端独立任务轮询 3s，面板以 1.5s 轮询以快速反馈
      refetchInterval: open ? 1500 : false,
      refetchOnWindowFocus: false,
    }
  );
  const startMutation = trpc.rules.startSelfTest.useMutation({
    onSuccess: () => {
      toast.success("自测任务已下发，心跳周期内会完成");
      utils.rules.latestTest.invalidate({ ruleId });
      refetch();
    },
    onError: (e) => toast.error(e?.message || "下发失败"),
  });

  const status = latest?.status as string | undefined;
  const renderStatus = () => {
    if (!latest) return <span className="text-muted-foreground">尚未运行过自测</span>;
    if (status === "pending") return <span className="flex items-center gap-1 text-amber-600"><Loader2 className="h-4 w-4 animate-spin" />等待 Agent 拉取</span>;
    if (status === "running") return <span className="flex items-center gap-1 text-amber-600"><Loader2 className="h-4 w-4 animate-spin" />Agent 执行中</span>;
    if (status === "success") return <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-4 w-4" />联通</span>;
    return <span className="flex items-center gap-1 text-destructive"><XCircle className="h-4 w-4" />联通失败</span>;
  };
  const renderItem = (label: string, ok: boolean | undefined) => (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted-foreground">{label}</span>
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-destructive" />}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>转发链路自测·{ruleName}</DialogTitle>
          <DialogDescription>Agent 会检测本地端口监听和目标TCP连通性来判定转发链路状态。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">状态</span>
            {renderStatus()}
          </div>
          {renderItem("本地端口监听", !!latest?.listenOk)}
          {renderItem("目标TCP可达", !!latest?.targetReachable)}
          {typeof latest?.latencyMs === "number" && latest.latencyMs > 0 && (
            <div className="flex items-center justify-between py-1">
              <span className="text-muted-foreground">TCP延迟</span>
              <span className={`font-mono ${
                latest.latencyMs < 50 ? "text-emerald-600" :
                latest.latencyMs < 100 ? "text-chart-3" :
                latest.latencyMs < 200 ? "text-amber-600" :
                "text-destructive"
              }`}>{latest.latencyMs} ms</span>
            </div>
          )}
          {latest?.message && (
            <div className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-line">
              {latest.message}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            disabled={startMutation.isPending}
            onClick={() => startMutation.mutate({ ruleId })}
          >
            {startMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4 mr-1" />}
            运行自测
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function RulesPage() {
  return (
    <DashboardLayout>
      <RulesContent />
    </DashboardLayout>
  );
}

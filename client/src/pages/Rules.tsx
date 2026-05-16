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
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Trash2,
  Pencil,
  ArrowRightLeft,
  ArrowRight,
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
  Shuffle,
  AlertCircle,
  Copy,
  Network,
} from "lucide-react";
import { FORWARD_TYPES, FORWARD_TYPE_LABELS, type ForwardType } from "@shared/forwardTypes";
import {
  ComposedChart,
  Line,
  Bar,
  Area,
  AreaChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useState, useMemo, useEffect, useCallback } from "react";
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
  routeMode: "local" | "tunnel";
  forwardType: ForwardType;
  protocol: "tcp" | "udp" | "both";
  gostMode: "direct" | "reverse";
  gostRelayHost: string;
  gostRelayPort: number;
  tunnelId: number | null;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
};

const defaultForm: RuleFormData = {
  hostId: null,
  name: "",
  routeMode: "local",
  forwardType: "iptables",
  protocol: "tcp",
  gostMode: "direct",
  gostRelayHost: "",
  gostRelayPort: 0,
  tunnelId: null,
  sourcePort: 0,
  targetIp: "",
  targetPort: 0,
};

function RulesContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const { data: rules, isLoading } = trpc.rules.list.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const { data: tunnels } = trpc.tunnels.list.useQuery();

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const [filterHost, setFilterHost] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [portStatus, setPortStatus] = useState<"idle" | "checking" | "available" | "used">("idle");

  // 权限检查：管理员或有 canAddRules 权限
  const canAdd = user?.role === "admin" || user?.canAddRules === true;

  const createMutation = trpc.rules.create.useMutation({
    onSuccess: (data) => {
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      const msg = data.sourcePort ? `规则创建成功，源端口: ${data.sourcePort}` : "规则创建成功";
      toast.success(msg);
    },
    onError: (err) => toast.error(err.message || "创建失败"),
  });

  const updateMutation = trpc.rules.update.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("规则更新成功");
    },
    onError: (err) => toast.error(err.message || "更新失败"),
  });

  const deleteMutation = trpc.rules.delete.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      toast.success("规则已删除");
    },
    onError: (err) => toast.error(err.message || "删除失败"),
  });

  // 近 24h 按规则汇总的流量
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
    onError: (err) => toast.error(err.message || "操作失败"),
  });

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
    setPortStatus("idle");
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
      routeMode: rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local",
      forwardType: rule.forwardType,
      protocol: rule.protocol,
      gostMode: rule.gostMode || "direct",
      gostRelayHost: rule.gostRelayHost || "",
      gostRelayPort: rule.gostRelayPort || 0,
      tunnelId: rule.tunnelId || null,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
    });
    setEditingId(rule.id);
    setPortStatus("idle");
    setShowDialog(true);
  };

  // 端口占用检测
  const checkPortMutation = trpc.rules.checkPort.useQuery(
    {
      hostId: form.hostId || 0,
      sourcePort: form.sourcePort,
      excludeRuleId: editingId || undefined,
    },
    {
      enabled: false,
    }
  );

  // 获取当前选中主机的端口区间
  const selectedHost = useMemo(() => {
    if (!form.hostId || !hosts) return null;
    return hosts.find(h => h.id === form.hostId) || null;
  }, [form.hostId, hosts]);
  const availableTunnels = useMemo(() => {
    if (!form.hostId || !tunnels) return [];
    return tunnels.filter((t: any) => t.entryHostId === form.hostId);
  }, [form.hostId, tunnels]);
  const selectedTunnel = useMemo(() => {
    if (!form.tunnelId || !tunnels) return null;
    return tunnels.find((t: any) => t.id === form.tunnelId) || null;
  }, [form.tunnelId, tunnels]);

  const [portRangeError, setPortRangeError] = useState<string | null>(null);

  const checkPort = useCallback(async () => {
    if (!form.hostId || !form.sourcePort || form.sourcePort < 1) return;
    // 先检查端口范围
    if (selectedHost) {
      const pStart = (selectedHost as any).portRangeStart;
      const pEnd = (selectedHost as any).portRangeEnd;
      if (pStart != null && pEnd != null && (form.sourcePort < pStart || form.sourcePort > pEnd)) {
        setPortRangeError(`端口必须在 ${pStart}-${pEnd} 区间内`);
        setPortStatus("used");
        return;
      }
    }
    setPortRangeError(null);
    setPortStatus("checking");
    try {
      const result = await utils.rules.checkPort.fetch({
        hostId: form.hostId,
        sourcePort: form.sourcePort,
        excludeRuleId: editingId || undefined,
      });
      setPortStatus(result.used ? "used" : "available");
    } catch {
      setPortStatus("idle");
    }
  }, [form.hostId, form.sourcePort, editingId, utils, selectedHost]);

  // 源端口变化时自动检测
  useEffect(() => {
    if (form.sourcePort > 0 && form.hostId) {
      const timer = setTimeout(checkPort, 500);
      return () => clearTimeout(timer);
    } else {
      setPortStatus("idle");
    }
  }, [form.sourcePort, form.hostId, checkPort]);

  // 随机分配端口
  const handleRandomPort = async () => {
    if (!form.hostId) {
      toast.error("请先选择主机");
      return;
    }
    try {
      const result = await utils.rules.randomPort.fetch({ hostId: form.hostId });
      setForm({ ...form, sourcePort: result.port });
      setPortStatus("available");
      toast.success(`已分配随机端口: ${result.port}`);
    } catch (err: any) {
      toast.error(err.message || "无法获取随机端口");
    }
  };

  const handleSubmit = () => {
    if (!form.hostId || !form.name || !form.targetIp || !form.targetPort) {
      toast.error("请填写所有必填字段（目标端口必须填写）");
      return;
    }
    if (form.routeMode === "tunnel" && !canUseGost) {
      toast.error("您没有使用隧道转发的权限，请联系管理员");
      return;
    }
    if (form.routeMode === "tunnel" && !form.tunnelId) {
      toast.error("请选择要使用的隧道");
      return;
    }
    if (form.routeMode === "local" && form.forwardType === "gost" && form.gostMode === "reverse" && (!form.gostRelayHost || !form.gostRelayPort)) {
      toast.error("请填写 gost 反向隧道的中继地址和端口");
      return;
    }
    if (portStatus === "used") {
      toast.error("源端口已被占用，请更换端口或使用随机分配");
      return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: form.name,
        forwardType: form.routeMode === "tunnel" ? "gost" : form.forwardType,
        protocol: form.protocol,
        gostMode: form.routeMode === "tunnel" ? "direct" : form.forwardType === "gost" ? form.gostMode : "direct",
        gostRelayHost: form.routeMode === "local" && form.forwardType === "gost" && form.gostMode === "reverse" ? form.gostRelayHost : null,
        gostRelayPort: form.routeMode === "local" && form.forwardType === "gost" && form.gostMode === "reverse" ? form.gostRelayPort : null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
      });
    } else {
      createMutation.mutate({
        hostId: form.hostId!,
        name: form.name,
        forwardType: form.routeMode === "tunnel" ? "gost" : form.forwardType,
        protocol: form.protocol,
        gostMode: form.routeMode === "tunnel" ? "direct" : form.forwardType === "gost" ? form.gostMode : "direct",
        gostRelayHost: form.routeMode === "local" && form.forwardType === "gost" && form.gostMode === "reverse" ? form.gostRelayHost : null,
        gostRelayPort: form.routeMode === "local" && form.forwardType === "gost" && form.gostMode === "reverse" ? form.gostRelayPort : null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
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

  /**
   * 当前用户被允许使用的转发方式。
   * - 管理员：不受限制（返回全部）
   * - 普通用户：读 (user as any).allowedForwardTypes，空表示全部
   */
  const allowedForwardTypes: ForwardType[] = useMemo(() => {
    const all = [...FORWARD_TYPES];
    if (!user || user.role === "admin") return all;
    const raw = (user as any).allowedForwardTypes as string | null | undefined;
    if (!raw || !raw.trim()) return all;
    const set = new Set(raw.split(",").map((s: string) => s.trim()));
    const filtered = all.filter(t => set.has(t));
    return filtered.length > 0 ? filtered : all;
  }, [user]);
  const canUseGost = allowedForwardTypes.includes("gost");

  /** 获取主机的入口地址：优先用用户自定义的 entryIp，未填则回退 ip */
  const getHostEntry = (hostId: number): string => {
    const h: any = hosts?.find((x) => x.id === hostId);
    if (!h) return "";
    return (h.entryIp && String(h.entryIp).trim()) || h.ip || "";
  };

  /** 复制入口 IP:端口 到剪贴板 */
  const copyEntryAddress = async (rule: any) => {
    const entry = getHostEntry(rule.hostId);
    if (!entry) {
      toast.error("未获取到主机入口地址");
      return;
    }
    const text = `${entry}:${rule.sourcePort}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 回退方案：临时 textarea
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success(`已复制入口地址: ${text}`);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">转发规则</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
            管理端口转发规则，支持 iptables、realm、socat 和 gost
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5 text-xs">
            <Zap className="h-3 w-3 text-chart-2" />
            {activeCount} / {rules?.length ?? 0} 活跃
          </Badge>
          {canAdd ? (
            <Button onClick={openCreate} className="gap-2" disabled={!hosts || hosts.length === 0}>
              <Plus className="h-4 w-4" />
              添加规则
            </Button>
          ) : (
            <Button disabled className="gap-2" title="需要管理员授权后才能添加规则">
              <Plus className="h-4 w-4" />
              添加规则
            </Button>
          )}
        </div>
      </div>

      {!canAdd && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>您暂无添加转发规则的权限，请联系管理员开通</span>
        </div>
      )}

      {rules && rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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
              <SelectItem value="gost">gost</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* 近 24 小时转发流量汇总 */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="border-border/40">
          <CardContent className="p-3 sm:p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 入向</p>
              <p className="text-sm sm:text-xl font-semibold mt-0.5 sm:mt-1">{formatBytes(trafficTotals.bytesIn)}</p>
            </div>
            <ArrowDownToLine className="h-4 w-4 sm:h-6 sm:w-6 text-chart-2" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-3 sm:p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 出向</p>
              <p className="text-sm sm:text-xl font-semibold mt-0.5 sm:mt-1">{formatBytes(trafficTotals.bytesOut)}</p>
            </div>
            <ArrowUpFromLine className="h-4 w-4 sm:h-6 sm:w-6 text-chart-4" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="p-3 sm:p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 连接</p>
              <p className="text-sm sm:text-xl font-semibold mt-0.5 sm:mt-1">{trafficTotals.connections.toLocaleString()}</p>
            </div>
            <Activity className="h-4 w-4 sm:h-6 sm:w-6 text-chart-3" />
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
                    <TableHead className="hidden md:table-cell">所属主机</TableHead>
                    <TableHead>转发配置</TableHead>
                    <TableHead className="hidden lg:table-cell">链路</TableHead>
                    <TableHead className="hidden lg:table-cell">协议</TableHead>
                    <TableHead className="hidden sm:table-cell">近 24h 流量</TableHead>
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
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm text-muted-foreground">{getHostName(rule.hostId)}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-mono text-xs">
                          <button
                            type="button"
                            onClick={() => copyEntryAddress(rule)}
                            className="group inline-flex max-w-[180px] items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 transition-colors hover:bg-muted/70 sm:max-w-[240px]"
                            title={`复制入口地址: ${getHostEntry(rule.hostId)}:${rule.sourcePort}`}
                          >
                            <code className="truncate">{getHostEntry(rule.hostId) || getHostName(rule.hostId)}:{rule.sourcePort}</code>
                            <Copy className="h-3 w-3 text-muted-foreground opacity-60 group-hover:opacity-100" />
                          </button>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <code className="bg-muted/40 px-1.5 py-0.5 rounded">{rule.targetIp}:{rule.targetPort}</code>
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            rule.forwardType === "iptables"
                              ? "border-primary/30 text-primary"
                              : rule.forwardType === "socat"
                              ? "border-chart-5/30 text-chart-5"
                              : rule.forwardType === "gost"
                              ? "border-chart-4/30 text-chart-4"
                              : "border-chart-3/30 text-chart-3"
                          }`}
                        >
                          {rule.forwardType === "gost" && rule.tunnelId ? (
                            <><Network className="h-3 w-3 mr-1" />隧道 / gost</>
                          ) : rule.forwardType === "iptables" ? (
                            <><Shield className="h-3 w-3 mr-1" />iptables</>
                          ) : rule.forwardType === "socat" ? (
                            <><ArrowRightLeft className="h-3 w-3 mr-1" />socat</>
                          ) : rule.forwardType === "gost" ? (
                            <><Network className="h-3 w-3 mr-1" />gost</>
                          ) : (
                            <><Zap className="h-3 w-3 mr-1" />realm</>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Badge variant="secondary" className="text-[10px] uppercase">
                          {rule.protocol}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
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
                            title="查看 TCPing 延迟"
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
              {hosts && hosts.length > 0 && canAdd && (
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
        <TcpingDetailDialog
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  onValueChange={(v) => setForm({ ...form, hostId: parseInt(v), tunnelId: null })}
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

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>链路类型</Label>
                <Select
                  value={form.routeMode}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      routeMode: v as "local" | "tunnel",
                      forwardType: v === "tunnel" ? "gost" : form.forwardType,
                      gostMode: "direct",
                      gostRelayHost: v === "tunnel" ? "" : form.gostRelayHost,
                      gostRelayPort: v === "tunnel" ? 0 : form.gostRelayPort,
                      tunnelId: v === "tunnel" ? form.tunnelId : null,
                    })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">本机转发</SelectItem>
                    <SelectItem value="tunnel" disabled={!canUseGost}>隧道转发</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>转发工具</Label>
                {form.routeMode === "tunnel" ? (
                  <div className="flex h-10 items-center rounded-md border border-border/60 bg-muted/30 px-3 text-sm text-muted-foreground">
                    gost
                  </div>
                ) : (
                  <Select
                    value={form.forwardType}
                    onValueChange={(v) => setForm({ ...form, forwardType: v as any, gostMode: v === "gost" ? form.gostMode : "direct", tunnelId: null })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {allowedForwardTypes.map((t) => (
                        <SelectItem key={t} value={t}>{FORWARD_TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
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
                <Label>{form.routeMode === "tunnel" ? "入口端口" : "源端口"}</Label>
                <div className="flex items-center gap-1">
                  <div className="relative flex-1">
                    <Input
                      type="number"
                      placeholder="0=随机"
                      value={form.sourcePort || ""}
                      onChange={(e) => setForm({ ...form, sourcePort: parseInt(e.target.value) || 0 })}
                      className={`pr-8 ${
                        portStatus === "used" ? "border-destructive" :
                        portStatus === "available" ? "border-emerald-500" : ""
                      }`}
                    />
                    {portStatus === "used" && (
                      <XCircle className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-destructive" />
                    )}
                    {portStatus === "available" && (
                      <CheckCircle2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-emerald-500" />
                    )}
                    {portStatus === "checking" && (
                      <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 flex-shrink-0"
                    onClick={handleRandomPort}
                    title="随机分配端口"
                  >
                    <Shuffle className="h-4 w-4" />
                  </Button>
                </div>
                {(portStatus !== "idle" || (selectedHost && (selectedHost as any).portRangeStart && (selectedHost as any).portRangeEnd)) && (
                  <p className={`text-[10px] leading-4 ${
                    portStatus === "used" ? "text-destructive" :
                    portStatus === "available" ? "text-emerald-600" :
                    "text-muted-foreground"
                  }`}>
                    {portStatus === "used"
                      ? (portRangeError || "端口已被占用")
                      : portStatus === "available"
                        ? "端口可用"
                        : portStatus === "checking"
                          ? "检测中..."
                          : null}
                    {selectedHost && (selectedHost as any).portRangeStart && (selectedHost as any).portRangeEnd && (
                      <span className={portStatus === "idle" ? "text-amber-600" : "ml-1 text-amber-600"}>
                        允许端口范围: {(selectedHost as any).portRangeStart}-{(selectedHost as any).portRangeEnd}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>

            {form.routeMode === "tunnel" ? (
              <div className="space-y-3 rounded-lg border border-chart-4/20 bg-chart-4/5 p-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label>使用隧道</Label>
                    <Select
                      value={form.tunnelId ? String(form.tunnelId) : "none"}
                      disabled={availableTunnels.length === 0}
                      onValueChange={(v) => setForm({ ...form, tunnelId: v === "none" ? null : Number(v) })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择隧道</SelectItem>
                        {availableTunnels.map((t: any) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name} / {String(t.mode).toUpperCase()} / :{t.listenPort}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="outline" className="h-9 justify-center gap-1.5 border-chart-4/30 px-3 text-chart-4">
                    <Network className="h-3.5 w-3.5" />
                    gost
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  隧道转发会把入口机收到的流量经所选隧道送到出口机，再由出口机连接下面填写的目标 IP 和目标端口。
                </p>
                {availableTunnels.length === 0 && (
                  <p className="text-xs text-amber-600">当前所属主机没有可用隧道，请先在隧道管理中创建入口为该主机的隧道。</p>
                )}
                {selectedTunnel && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{getHostName(selectedTunnel.entryHostId)}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span>{getHostName(selectedTunnel.exitHostId)}</span>
                    <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedTunnel.listenPort}</code>
                  </div>
                )}
              </div>
            ) : (
              <div className={`rounded-lg border border-border/40 bg-muted/20 p-3 space-y-3 ${form.forwardType !== "gost" ? "opacity-60" : ""}`}>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>gost 模式</Label>
                    <Select
                      value={form.gostMode}
                      disabled={form.forwardType !== "gost"}
                      onValueChange={(v) => setForm({ ...form, gostMode: v as any, tunnelId: v === "direct" ? form.tunnelId : null })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">端口转发</SelectItem>
                        <SelectItem value="reverse">反向隧道</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {form.gostMode === "reverse" && (
                    <>
                      <div className="space-y-2">
                        <Label>中继地址</Label>
                        <Input
                          placeholder="例如: relay.example.com"
                          disabled={form.forwardType !== "gost" || form.gostMode !== "reverse"}
                          value={form.gostRelayHost}
                          onChange={(e) => setForm({ ...form, gostRelayHost: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>中继端口</Label>
                        <Input
                          type="number"
                          placeholder="例如: 8443"
                          disabled={form.forwardType !== "gost" || form.gostMode !== "reverse"}
                          value={form.gostRelayPort || ""}
                          onChange={(e) => setForm({ ...form, gostRelayPort: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                    </>
                  )}
                </div>
                {form.gostMode === "direct" && (
                  <div className="space-y-2">
                    <Label>使用隧道</Label>
                    <Select
                      value={form.tunnelId ? String(form.tunnelId) : "none"}
                      disabled={form.forwardType !== "gost" || availableTunnels.length === 0}
                      onValueChange={(v) => setForm({ ...form, tunnelId: v === "none" ? null : Number(v) })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">不使用隧道</SelectItem>
                        {availableTunnels.map((t: any) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name} / {String(t.mode).toUpperCase()} / :{t.listenPort}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {form.gostMode === "reverse" && (
                  <p className="text-xs text-muted-foreground">
                    反向隧道会保存中继参数并下发到 Agent，适合内网主机主动连出到公网中继。
                  </p>
                )}
                {form.forwardType !== "gost" && (
                  <p className="text-xs text-muted-foreground">
                    选择 gost 转发工具后可配置 gost 模式。
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{form.routeMode === "tunnel" ? "最终目标 IP" : "目标 IP"}</Label>
                <Input
                  placeholder="例如: 10.0.0.1"
                  value={form.targetIp}
                  onChange={(e) => setForm({ ...form, targetIp: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{form.routeMode === "tunnel" ? "最终目标端口" : "目标端口"} <span className="text-destructive">*</span></Label>
                <Input
                  type="number"
                  placeholder="必填，例如: 80"
                  value={form.targetPort || ""}
                  onChange={(e) => setForm({ ...form, targetPort: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !form.name || !form.hostId || !form.targetIp || !form.targetPort || portStatus === "used" || (form.routeMode === "tunnel" && !form.tunnelId)}
            >
              {isPending ? "处理中..." : editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 格式化时间标签：显示 MM/DD HH:mm */
function formatTcpingTime(dateStr: string | Date): string {
  const d = new Date(dateStr);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

/** TCPing Tooltip */
function TcpingTooltipContent({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0]?.payload;
  if (!data) return null;
  const latency = data.latency;
  const isTimeout = data.isTimeout;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground mb-1">{data.fullLabel || label}</p>
      {isTimeout ? (
        <p className="text-sm font-semibold text-destructive">超时</p>
      ) : latency > 0 ? (
        <p className="text-sm font-semibold tabular-nums">
          <span className={latency < 50 ? "text-emerald-500" : latency < 100 ? "text-chart-3" : latency < 200 ? "text-amber-500" : "text-destructive"}>
            {latency}ms
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">无数据</p>
      )}
    </div>
  );
}

function TcpingDetailDialog({
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
  const { data, isLoading } = trpc.rules.tcpingSeries.useQuery(
    { ruleId, hours: 24 },
    { enabled: open, refetchInterval: open ? 30000 : false }
  );

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.map((d: any) => ({
      label: formatTcpingTime(d.recordedAt),
      fullLabel: formatTcpingTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [data]);

  // 动态计算 Y轴最大值：取数据最大值的 2 倍，最小 120ms，最大 500ms
  const yMax = useMemo(() => {
    if (!chartData || chartData.length === 0) return 120;
    const maxVal = Math.max(...chartData.map((d) => d.latency));
    if (maxVal <= 0) return 120;
    const dynamicMax = Math.ceil(maxVal * 2);
    return Math.min(500, Math.max(120, dynamicMax));
  }, [chartData]);

  const tcpingStats = useMemo(() => {
    const total = chartData.length;
    const timeout = chartData.filter((d) => d.isTimeout).length;
    const values = chartData
      .filter((d) => !d.isTimeout && d.latency > 0)
      .map((d) => d.latency);
    if (values.length === 0) {
      return { total, timeout, valid: 0, max: null as number | null, min: null as number | null, avg: null as number | null };
    }
    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
      total,
      timeout,
      valid: values.length,
      max: Math.max(...values),
      min: Math.min(...values),
      avg: Math.round(sum / values.length),
    };
  }, [chartData]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg">转发链路延迟 (TCPing) - {ruleName}</DialogTitle>
          <DialogDescription>Agent 每次心跳时对目标地址执行 TCP 连接延迟检测，展示最近 24 小时数据</DialogDescription>
        </DialogHeader>
        <div className="h-72 w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              暂无 TCPing 数据
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="tcpingGradientRule" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9 }}
                  minTickGap={60}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  tickFormatter={(v) => `${v}ms`}
                  width={50}
                  domain={[0, yMax]}
                  allowDecimals={false}
                  ticks={(() => {
                    const step = yMax <= 120 ? 20 : yMax <= 200 ? 40 : yMax <= 300 ? 50 : 100;
                    const ticks: number[] = [];
                    for (let i = 0; i <= yMax; i += step) {
                      ticks.push(i);
                    }
                    if (ticks[ticks.length - 1] !== yMax) ticks.push(yMax);
                    return ticks;
                  })()}
                />
                <RTooltip
                  content={<TcpingTooltipContent />}
                  cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                />
                <Area
                  type="monotone"
                  dataKey="latency"
                  name="延迟"
                  stroke="var(--color-chart-2)"
                  strokeWidth={2}
                  fill="url(#tcpingGradientRule)"
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">统计次数</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">
              {tcpingStats.total}
              {tcpingStats.timeout > 0 && <span className="ml-1 text-xs font-normal text-amber-600">超时 {tcpingStats.timeout}</span>}
            </p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最大延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.max === null ? "--" : `${tcpingStats.max} ms`}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">最小延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.min === null ? "--" : `${tcpingStats.min} ms`}</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">平均延迟</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">{tcpingStats.avg === null ? "--" : `${tcpingStats.avg} ms`}</p>
          </div>
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
      refetchInterval: open ? 1500 : false,
      refetchOnWindowFocus: false,
    }
  );
  const startMutation = trpc.rules.startSelfTest.useMutation({
    onSuccess: () => {
      toast.info("正在测试中");
      utils.rules.latestTest.invalidate({ ruleId });
      refetch();
    },
    onError: (e) => toast.error(e?.message || "下发失败"),
  });

  const status = latest?.status as string | undefined;
  const isTesting = startMutation.isPending || status === "pending" || status === "running";
  const renderStatus = () => {
    if (startMutation.isPending) return <span className="flex items-center gap-1 text-amber-600"><Loader2 className="h-4 w-4 animate-spin" />正在测试中</span>;
    if (!latest) return <span className="text-muted-foreground">尚未运行</span>;
    if (status === "pending" || status === "running") return <span className="flex items-center gap-1 text-amber-600"><Loader2 className="h-4 w-4 animate-spin" />正在测试中</span>;
    if (status === "success") return <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-4 w-4" />正常</span>;
    if (status === "timeout") return <span className="flex items-center gap-1 text-amber-600"><AlertCircle className="h-4 w-4" />超时</span>;
    return <span className="flex items-center gap-1 text-destructive"><XCircle className="h-4 w-4" />异常</span>;
  };
  const renderItem = (label: string, ok: boolean | undefined) => (
    <div className="flex items-center justify-between py-1">
      <span className="text-muted-foreground">{label}</span>
      {isTesting ? (
        <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
      ) : ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : (
        <XCircle className="h-4 w-4 text-destructive" />
      )}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>转发链路自测 - {ruleName}</DialogTitle>
          <DialogDescription>Agent 会检测目标端口 TCP 可达性和延迟来判定转发链路状态</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">状态</span>
            {renderStatus()}
          </div>
          {renderItem("端口可达", !!latest?.targetReachable)}
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">TCP 延迟</span>
            {typeof latest?.latencyMs === "number" && latest.latencyMs > 0 ? (
              <span className={`font-mono ${
                latest.latencyMs < 50 ? "text-emerald-600" :
                latest.latencyMs < 100 ? "text-chart-3" :
                latest.latencyMs < 200 ? "text-amber-600" :
                "text-destructive"
              }`}>{latest.latencyMs} ms</span>
            ) : isTesting ? (
              <span className="flex items-center gap-1 text-amber-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在测试中
              </span>
            ) : (
              <span className="text-muted-foreground">--</span>
            )}
          </div>
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

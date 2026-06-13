import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { LatencyRating } from "@/components/LatencyRating";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { clipLatencyForChart, getLatencyStabilityStats, getLatencyYAxisMax, getLatencyYAxisTicks, isLatencySeriesCacheFresh } from "@/lib/latencyChart";
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
import DataSectionLoading from "@/components/DataSectionLoading";
import HostStatusLabel from "@/components/HostStatusLabel";
import MultiHopEditor from "@/components/MultiHopEditor";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  GripVertical,
  Layers3,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Stethoscope,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LinkTestLatencySummary, parseLinkTestMessage } from "@/components/LinkTestLatencySummary";

type GroupType = "host" | "tunnel";
type GroupMode = "failover" | "chain";

type MemberForm = {
  key: string;
  memberType: GroupType;
  hostId: number | null;
  tunnelId: number | null;
  connectHost?: string | null;
  isEnabled: boolean;
};

type GroupForm = {
  name: string;
  groupMode: GroupMode;
  groupType: GroupType;
  domain: string;
  recordType: "A" | "AAAA" | "CNAME";
  failoverSeconds: string;
  recoverSeconds: string;
  autoFailback: boolean;
  isEnabled: boolean;
  members: MemberForm[];
};

const makeDefaultForm = (): GroupForm => ({
  name: "",
  groupMode: "failover",
  groupType: "host",
  domain: "",
  recordType: "A",
  failoverSeconds: "60",
  recoverSeconds: "120",
  autoFailback: true,
  isEnabled: true,
  members: [],
});

function memberKey(memberType: GroupType, id: number) {
  return `${memberType}-${id}`;
}

type ForwardGroupViewMode = "card" | "table";
type ForwardGroupsContentProps = {
  mode?: GroupMode;
  embedded?: boolean;
  viewMode?: ForwardGroupViewMode;
  onViewModeChange?: (viewMode: ForwardGroupViewMode) => void;
  hideHeaderActions?: boolean;
  createRequestKey?: number;
  editRequest?: { id: number; requestKey: number } | null;
  onEditRequestConsumed?: () => void;
};

const FORWARD_GROUP_VIEW_MODE_STORAGE_KEY = "forwardx.forwardGroups.viewMode";

function ForwardGroupViewTransition({
  transitionKey,
  children,
}: {
  transitionKey: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995, filter: "blur(3px)" }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.995, filter: "blur(3px)" }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

function getStoredForwardGroupViewMode(): ForwardGroupViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeForwardGroupViewMode(viewMode: ForwardGroupViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORWARD_GROUP_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function sameNumberArray(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameNullableStringArray(a: Array<string | null>, b: Array<string | null>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i] || null) !== (b[i] || null)) return false;
  }
  return true;
}

function hostPrivateAddress(host: any) {
  return String(host?.tunnelEntryIp || "").trim();
}

function normalizeChainConnectHostsForHosts(
  raw: Array<string | null>,
  hostIds: number[],
  hosts: any[] | undefined,
): Array<string | null> {
  const base = [...raw].slice(0, hostIds.length);
  while (base.length < hostIds.length) base.push(null);
  if (hostIds.length > 0) base[0] = null;
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  return base.map((value, index) => {
    if (index === 0) return null;
    const host = hostById.get(Number(hostIds[index] || 0));
    const privateAddr = hostPrivateAddress(host);
    const text = String(value || "").trim();
    return privateAddr && text === privateAddr ? privateAddr : null;
  });
}

function chainRoleLabel(index: number, total: number) {
  if (index === 0) return "入口";
  if (index === total - 1) return "出口";
  return "中转";
}

type GroupLatencyPoint = {
  label: string;
  fullLabel: string;
  latency: number;
  chartLatency: number;
  isTimeout: boolean;
};

type GroupLatencySeriesDatum = {
  recordedAt: string | Date;
  latencyMs?: number | null;
  isTimeout?: boolean | null;
};

const groupLatencySeriesCache = new Map<number, GroupLatencySeriesDatum[]>();
const groupLatencyAnimatedKeys = new Set<number>();

function formatGroupLatencyTime(value: string | Date) {
  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function ForwardGroupLatencyDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading, isFetching } = trpc.forwardGroups.latencySeries.useQuery(
    { groupId, hours: 24 },
    { enabled: open, refetchInterval: open ? 30000 : false, refetchOnMount: "always" }
  );
  const cachedData = groupLatencySeriesCache.get(groupId);
  const rawSeriesData = (data ?? cachedData) as GroupLatencySeriesDatum[] | undefined;
  const waitForFreshSeries = open && isFetching && !isLatencySeriesCacheFresh(rawSeriesData);
  const seriesData = waitForFreshSeries ? undefined : rawSeriesData;

  useEffect(() => {
    if (data) groupLatencySeriesCache.set(groupId, data as GroupLatencySeriesDatum[]);
  }, [data, groupId]);

  const chartData = useMemo<GroupLatencyPoint[]>(() => {
    if (!seriesData) return [];
    return seriesData.map((d: GroupLatencySeriesDatum): GroupLatencyPoint => ({
      label: formatGroupLatencyTime(d.recordedAt),
      fullLabel: formatGroupLatencyTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      chartLatency: d.isTimeout ? 0 : clipLatencyForChart(Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [seriesData]);

  const stats = useMemo(() => {
    return getLatencyStabilityStats(chartData);
  }, [chartData]);
  const yMax = useMemo(() => getLatencyYAxisMax(Math.max(...chartData.filter((d) => !d.isTimeout).map((d) => d.chartLatency), 0), 120), [chartData]);
  const yTicks = useMemo(() => getLatencyYAxisTicks(yMax), [yMax]);
  const shouldAnimateChart = open && chartData.length > 0 && !groupLatencyAnimatedKeys.has(groupId);
  useEffect(() => {
    if (shouldAnimateChart) groupLatencyAnimatedKeys.add(groupId);
  }, [groupId, shouldAnimateChart]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>转发链延迟 - {groupName}</DialogTitle>
          <DialogDescription>近 24 小时链路逐跳探测汇总，成员之间使用 Ping，出口到目标使用 TCPing。</DialogDescription>
        </DialogHeader>
        <div className="h-[260px] rounded-lg border border-border/60 bg-muted/20 p-3">
          {(isLoading || waitForFreshSeries) && !seriesData ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载延迟数据
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="forwardGroupLatencyGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.38} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.35} />
                <XAxis dataKey="label" stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} width={42} domain={[0, yMax]} ticks={yTicks} tickFormatter={(value) => `${value}ms`} />
                <RTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const item = payload[0].payload as GroupLatencyPoint;
                    return (
                      <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                        <p className="font-medium">{item.fullLabel}</p>
                        <p className={item.isTimeout ? "text-destructive" : "text-foreground"}>
                          {item.isTimeout ? "超时/不可达" : `${item.latency}ms`}
                        </p>
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={2} fill="url(#forwardGroupLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} isAnimationActive={shouldAnimateChart} animationDuration={shouldAnimateChart ? 500 : 0} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <LatencyStabilityStats stats={stats} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForwardGroupSelfTestDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: latest } = trpc.forwardGroups.latestTest.useQuery(
    { groupId },
    { enabled: open, refetchInterval: open ? 1500 : false, refetchOnWindowFocus: false }
  );
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState("");
  const manualTestRef = useRef(false);
  const lastFailureToastKey = useRef("");
  const testMutation = trpc.forwardGroups.test.useMutation({
    onSuccess: async () => {
      await utils.forwardGroups.latestTest.invalidate({ groupId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      manualTestRef.current = false;
      toast.error(e.message || "测试失败");
    },
  });
  const status = latest?.status as string | undefined;
  const isServerTesting = status === "pending" || status === "running";
  const isTesting = testMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isFailed = !!latest && !isTesting && !isSuccess;
  const parsedMessage = useMemo(() => parseLinkTestMessage(latest?.message), [latest?.message]);
  const hasFreshResult = !baselineUpdatedAt || (latest?.updatedAt && String(latest.updatedAt) !== baselineUpdatedAt);

  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setBaselineUpdatedAt("");
      manualTestRef.current = false;
      lastFailureToastKey.current = "";
    }
  }, [open]);

  useEffect(() => {
    if (optimisticTesting && hasFreshResult && !isServerTesting && latest) {
      setOptimisticTesting(false);
    }
  }, [hasFreshResult, isServerTesting, latest, optimisticTesting]);

  useEffect(() => {
    const message = parsedMessage.message.trim();
    if (!open || isTesting || !isFailed || !message || !manualTestRef.current || !hasFreshResult) return;
    const key = `${groupId}:${status}:${latest?.updatedAt || ""}:${message}`;
    if (lastFailureToastKey.current !== key) {
      lastFailureToastKey.current = key;
      manualTestRef.current = false;
      toast.error("转发链链路自测失败", { description: message, duration: 12000 });
    }
  }, [groupId, hasFreshResult, isFailed, isTesting, latest?.updatedAt, open, parsedMessage.message, status]);

  useEffect(() => {
    if (!isTesting && isSuccess) manualTestRef.current = false;
  }, [isSuccess, isTesting]);

  const statusView = (() => {
    if (isTesting) return <span className="flex items-center gap-2 text-amber-600"><Loader2 className="h-4 w-4 animate-spin" />正在测试中</span>;
    if (!latest) return <span className="text-muted-foreground">尚未运行</span>;
    if (isSuccess) return <span className="flex items-center gap-2 text-emerald-600"><CheckCircle2 className="h-4 w-4" />正常</span>;
    if (status === "timeout") return <span className="flex items-center gap-2 text-amber-600"><AlertCircle className="h-4 w-4" />超时</span>;
    return <span className="flex items-center gap-2 text-destructive"><XCircle className="h-4 w-4" />异常</span>;
  })();
  const reachableView = (() => {
    if (isTesting) return <Loader2 className="h-4 w-4 animate-spin text-amber-600" />;
    if (isSuccess) return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (latest) return <XCircle className="h-4 w-4 text-destructive" />;
    return <span className="text-muted-foreground">--</span>;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>转发链链路自测 - {groupName}</DialogTitle>
          <DialogDescription>多级链路按每一跳分别测试，并汇总总延迟。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">状态</span>
            <span className="text-sm font-medium">{statusView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">链路可达</span>
            <span className="text-sm font-medium">{reachableView}</span>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">链路估算延迟</span>
            <LinkTestLatencySummary
              parsed={parsedMessage}
              fallbackLatencyMs={latest?.latencyMs}
              isSuccess={isSuccess}
              isTesting={isTesting}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            onClick={() => {
              manualTestRef.current = true;
              setBaselineUpdatedAt(latest?.updatedAt ? String(latest.updatedAt) : "");
              setOptimisticTesting(true);
              testMutation.mutate({ groupId });
            }}
            disabled={isTesting}
            className="gap-2"
          >
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            {isTesting ? "测试中..." : "运行测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ForwardGroupsContent({
  mode = "failover",
  embedded = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  hideHeaderActions = false,
  createRequestKey,
  editRequest,
  onEditRequestConsumed,
}: ForwardGroupsContentProps) {
  const utils = trpc.useUtils();
  const { data: groups, isLoading } = trpc.forwardGroups.list.useQuery(undefined, { refetchInterval: 15000 });
  const { data: hosts } = trpc.hosts.list.useQuery();
  const { data: tunnels } = trpc.tunnels.list.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<GroupForm>(makeDefaultForm());
  const savedMembersRef = useRef<Record<string, MemberForm[]>>({ host: [], tunnel: [] });
  const [dragMemberKey, setDragMemberKey] = useState<string | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<ForwardGroupViewMode>(() => getStoredForwardGroupViewMode());
  const [latencyGroup, setLatencyGroup] = useState<{ id: number; name: string } | null>(null);
  const [testGroup, setTestGroup] = useState<{ id: number; name: string } | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<any | null>(null);
  const lastCreateRequestKeyRef = useRef(createRequestKey ?? 0);
  const lastEditRequestKeyRef = useRef(0);
  const activeGroupMode = mode;
  const viewMode = controlledViewMode ?? internalViewMode;
  const deleteImpactQuery = trpc.forwardGroups.deleteImpact.useQuery(
    { id: Number(deleteGroup?.id || 0) },
    { enabled: !!deleteGroup },
  );

  const hostById = useMemo(() => new Map<number, any>((hosts || []).map((h: any) => [Number(h.id), h])), [hosts]);
  const tunnelById = useMemo(() => new Map<number, any>((tunnels || []).map((t: any) => [Number(t.id), t])), [tunnels]);
  const failoverGroups = useMemo(() => (groups || []).filter((group: any) => group.groupMode !== "chain"), [groups]);
  const chainGroups = useMemo(() => (groups || []).filter((group: any) => group.groupMode === "chain"), [groups]);
  const visibleGroups = activeGroupMode === "chain" ? chainGroups : failoverGroups;
  const activeCount = failoverGroups.filter((g: any) => g.isEnabled && g.lastStatus === "healthy").length;
  const chainCount = chainGroups.filter((g: any) => g.isEnabled).length;
  const groupPagination = usePersistentPagination(visibleGroups, {
    storageKey: `forwardx.forwardGroups.${activeGroupMode}.page`,
    pageSize: 12,
    isReady: !isLoading && !!groups,
  });
  const pagedGroups = groupPagination.items;

  const resetForm = () => {
    setForm(makeDefaultForm());
    setEditingId(null);
    setDragMemberKey(null);
    savedMembersRef.current = { host: [], tunnel: [] };
  };

  const openCreate = () => {
    const initial = makeDefaultForm();
    setForm({
      ...initial,
      groupMode: activeGroupMode,
      groupType: "host",
      domain: activeGroupMode === "chain" ? "" : initial.domain,
      recordType: activeGroupMode === "chain" ? "A" : initial.recordType,
    });
    setEditingId(null);
    setDragMemberKey(null);
    savedMembersRef.current = { host: [], tunnel: [] };
    setShowDialog(true);
  };

  useEffect(() => {
    if (createRequestKey === undefined || createRequestKey === lastCreateRequestKeyRef.current) return;
    lastCreateRequestKeyRef.current = createRequestKey;
    if (createRequestKey > 0) openCreate();
  }, [createRequestKey]);

  const openEdit = (group: any) => {
    setForm({
      name: group.name || "",
      groupMode: group.groupMode === "chain" ? "chain" : "failover",
      groupType: group.groupType === "tunnel" ? "tunnel" : "host",
      domain: group.domain || "",
      recordType: group.recordType || "A",
      failoverSeconds: String(Number(group.failoverSeconds || 60)),
      recoverSeconds: String(Number(group.recoverSeconds || 120)),
      autoFailback: !!group.autoFailback,
      isEnabled: !!group.isEnabled,
      members: (group.members || []).map((member: any) => ({
        key: memberKey(member.memberType, Number(member.memberType === "host" ? member.hostId : member.tunnelId)),
        memberType: member.memberType,
        hostId: member.hostId ? Number(member.hostId) : null,
        tunnelId: member.tunnelId ? Number(member.tunnelId) : null,
        connectHost: member.connectHost || null,
        isEnabled: !!member.isEnabled,
      })),
    });
    setEditingId(Number(group.id));
    setShowDialog(true);
  };

  useEffect(() => {
    if (!editRequest || editRequest.requestKey === lastEditRequestKeyRef.current) return;
    const group = visibleGroups.find((item: any) => Number(item.id) === Number(editRequest.id));
    if (group) {
      lastEditRequestKeyRef.current = editRequest.requestKey;
      openEdit(group);
      onEditRequestConsumed?.();
    }
  }, [editRequest?.id, editRequest?.requestKey, onEditRequestConsumed, visibleGroups]);

  const createMutation = trpc.forwardGroups.create.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("转发组已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.forwardGroups.update.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success("转发组已更新");
    },
    onError: (e) => toast.error(e.message || "更新失败"),
  });

  const deleteMutation = trpc.forwardGroups.delete.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      setDeleteGroup(null);
      toast.success("转发组已删除，引用规则将同步清理");
    },
    onError: (e) => toast.error(e.message || "删除失败"),
  });

  const syncMutation = trpc.forwardGroups.sync.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      toast.success("已同步转发组成员规则");
    },
    onError: (e) => toast.error(e.message || "同步失败"),
  });

  const runFailoverMutation = trpc.forwardGroups.runFailover.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      toast.success("已执行一次故障转移检查");
    },
    onError: (e) => toast.error(e.message || "执行失败"),
  });

  const effectiveGroupType = form.groupMode === "chain" ? "host" : form.groupType;
  const availableMemberOptions = effectiveGroupType === "host"
    ? (hosts || []).map((h: any) => ({ id: Number(h.id), label: h.name, meta: h.entryIp || h.ip || "", host: h }))
    : (tunnels || []).map((t: any) => ({
      id: Number(t.id),
      label: t.name,
      meta: getTunnelRouteText(t, hosts),
    }));

  const addMember = (id: number) => {
    if (!id) return;
    if (form.groupMode === "chain" && form.members.length >= 5) {
      toast.error("端口转发链最多支持 5 台主机");
      return;
    }
    const effectiveType = effectiveGroupType;
    const key = memberKey(effectiveType, id);
    if (form.members.some((m) => m.key === key)) {
      toast.error("成员已存在");
      return;
    }
    setForm({
      ...form,
      members: [
        ...form.members,
        {
          key,
          memberType: effectiveType,
          hostId: effectiveType === "host" ? id : null,
          tunnelId: effectiveType === "tunnel" ? id : null,
          isEnabled: true,
        },
      ],
    });
  };

  const removeMember = (key: string) => {
    setForm({ ...form, members: form.members.filter((m) => m.key !== key) });
  };

  const updateChainMemberIds = (ids: number[]) => {
    setForm((prev) => {
      const rawConnectHosts = ids.map((id) => {
        const existing = prev.members.find((member) => member.key === memberKey("host", id));
        return existing?.connectHost || null;
      });
      const normalizedConnectHosts = normalizeChainConnectHostsForHosts(
        rawConnectHosts,
        ids,
        hosts,
      );
      const nextMembers = ids.map((id, index) => {
        const key = memberKey("host", id);
        const existing = prev.members.find((member) => member.key === key);
        return {
          ...(existing || {
            key,
            memberType: "host" as GroupType,
            hostId: id,
            tunnelId: null,
            isEnabled: true,
          }),
          key,
          memberType: "host" as GroupType,
          hostId: id,
          tunnelId: null,
          connectHost: normalizedConnectHosts[index] || null,
          isEnabled: true,
        };
      });
      if (
        sameNumberArray(prev.members.map((member) => Number(member.hostId || 0)), ids)
        && sameNullableStringArray(prev.members.map((member) => member.connectHost || null), normalizedConnectHosts)
      ) {
        return prev;
      }
      return { ...prev, members: nextMembers };
    });
  };

  const updateChainConnectHosts = (connectHosts: Array<string | null>) => {
    setForm((prev) => {
      const hostIds = prev.members.map((member) => Number(member.hostId || 0)).filter(Boolean);
      const normalizedConnectHosts = normalizeChainConnectHostsForHosts(connectHosts, hostIds, hosts);
      if (sameNullableStringArray(prev.members.map((member) => member.connectHost || null), normalizedConnectHosts)) {
        return prev;
      }
      return {
        ...prev,
        members: prev.members.map((member, index) => ({
          ...member,
          connectHost: normalizedConnectHosts[index] || null,
        })),
      };
    });
  };

  const moveMember = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const items = [...form.members];
    const from = items.findIndex((m) => m.key === fromKey);
    const to = items.findIndex((m) => m.key === toKey);
    if (from < 0 || to < 0) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setForm({ ...form, members: items });
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return toast.error("请填写组名称");
    if (form.groupMode === "chain") {
      if (form.members.length < 2 || form.members.length > 5) return toast.error("端口转发链需要配置 2-5 台主机");
    } else if (form.members.length === 0) {
      return toast.error("请至少添加一个成员");
    }
    const failoverSeconds = Number(form.failoverSeconds);
    const recoverSeconds = Number(form.recoverSeconds);
    if (!Number.isInteger(failoverSeconds) || failoverSeconds < 10 || failoverSeconds > 3600) {
      return toast.error("故障转移时间需为 10-3600 秒的整数");
    }
    if (!Number.isInteger(recoverSeconds) || recoverSeconds < 10 || recoverSeconds > 3600) {
      return toast.error("恢复观察时间需为 10-3600 秒的整数");
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      groupType: form.groupMode === "chain" ? "host" : form.groupType,
      domain: form.groupMode === "chain" ? null : form.domain.trim() || null,
      failoverSeconds,
      recoverSeconds,
      members: form.members.map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        connectHost: form.groupMode === "chain" ? member.connectHost || null : null,
        isEnabled: member.isEnabled,
        priority: index,
      })),
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const groupStatusBadge = (group: any) => {
    if (group.groupMode === "chain") {
      if (!group.isEnabled) return <Badge variant="outline">停用</Badge>;
      return <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 hover:text-sky-900 dark:text-sky-300 dark:hover:bg-sky-500/20 dark:hover:text-sky-100">链路</Badge>;
    }
    if (!group.isEnabled) return <Badge variant="outline">停用</Badge>;
    if (group.lastStatus === "healthy") return <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-100">健康</Badge>;
    if (group.lastStatus === "down") return <Badge variant="destructive">不可用</Badge>;
    if (group.lastStatus === "error") return <Badge variant="destructive">DDNS 异常</Badge>;
    return <Badge variant="secondary">等待检测</Badge>;
  };

  const memberLabel = (member: any) => {
    if (member.memberType === "host") return hostById.get(Number(member.hostId))?.name || `主机 #${member.hostId}`;
    const tunnel = tunnelById.get(Number(member.tunnelId));
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : `隧道 #${member.tunnelId}`;
  };

  const groupKindBadge = (group: any) => {
    if (group.groupMode === "chain") return <Badge variant="outline">端口转发链</Badge>;
    return <Badge variant="outline">{group.groupType === "tunnel" ? "隧道高可用" : "主机高可用"}</Badge>;
  };

  const groupMemberTitle = (group: any) => group.groupMode === "chain" ? "链路顺序" : "成员优先级";

  const groupDdnsText = (group: any) => group.groupMode === "chain" ? "不使用" : group.domain || "未配置";

  const renderChainLatencySummary = (group: any) => {
    if (group.groupMode !== "chain") return <span className="text-muted-foreground">--</span>;
    const latency = typeof group.latestLatencyMs === "number" && Number.isFinite(group.latestLatencyMs)
      ? Number(group.latestLatencyMs)
      : null;
    return <LatencyRating latencyMs={latency} isTimeout={!!group.latestLatencyIsTimeout} />;
  };

  const chainLatencyActions = (group: any) => group.groupMode === "chain" ? (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title="查看延迟"
        onClick={() => setLatencyGroup({ id: Number(group.id), name: group.name })}
      >
        <Activity className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title="链路自测"
        onClick={() => setTestGroup({ id: Number(group.id), name: group.name })}
      >
        <Stethoscope className="h-3.5 w-3.5" />
      </Button>
    </>
  ) : null;

  const isPending = createMutation.isPending || updateMutation.isPending;
  const handleViewModeChange = (nextViewMode: ForwardGroupViewMode) => {
    if (onViewModeChange) {
      onViewModeChange(nextViewMode);
    } else {
      setInternalViewMode(nextViewMode);
    }
    storeForwardGroupViewMode(nextViewMode);
  };
  const isChainMode = activeGroupMode === "chain";
  const pageTitle = isChainMode ? "端口转发链" : "转发组";
  const pageDescription = isChainMode ? "管理按主机顺序串联的端口转发链路。" : "管理可故障转移的入口组。";
  const addButtonText = isChainMode ? "添加转发链" : "添加转发组";
  const loadingLabel = isChainMode ? "正在加载端口转发链" : "正在加载转发组";
  const emptyTitle = isChainMode ? "暂无端口转发链" : "暂无转发组";
  const emptyDescription = isChainMode ? "创建后可在端口转发规则中作为链路使用" : "创建后可在转发规则中作为高可用入口使用";
  const paginationItemName = isChainMode ? "条转发链" : "个转发组";
  const dialogTitle = editingId ? (isChainMode ? "编辑端口转发链" : "编辑转发组") : (isChainMode ? "添加端口转发链" : "添加转发组");
  const dialogDescription = isChainMode ? "配置端口转发链路。" : "配置高可用入口。";
  const contentTransitionKey = `${activeGroupMode}-${isLoading ? "loading" : visibleGroups.length > 0 ? `list-${viewMode}` : "empty"}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {embedded ? (
            <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{pageTitle}</h2>
          ) : (
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{pageTitle}</h1>
          )}
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            {pageDescription}
          </p>
        </div>
        {!hideHeaderActions && <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Activity className={`h-3 w-3 ${isChainMode ? "text-sky-500" : "text-emerald-500"}`} />
            <AnimatedStatValue
              value={isChainMode ? `${chainCount} / ${chainGroups.length} 启用` : `${activeCount} / ${failoverGroups.length} 健康`}
              loading={isLoading || !groups}
              cacheKey={isChainMode ? "forwardGroups.header.chainEnabled" : "forwardGroups.header.healthy"}
              fallbackValue={isChainMode ? "0 / 0 启用" : "0 / 0 健康"}
            />
          </Badge>
          {!isChainMode && <Button variant="outline" className="gap-2" onClick={() => runFailoverMutation.mutate()} disabled={runFailoverMutation.isPending}>
            {runFailoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            检查
          </Button>}
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={openCreate} className="col-span-2 gap-2 sm:col-span-1">
            <Plus className="h-4 w-4" />
            {addButtonText}
          </Button>
        </div>}
      </div>

      <ForwardGroupViewTransition transitionKey={contentTransitionKey}>
        {isLoading ? (
        <DataSectionLoading label={loadingLabel} />
      ) : visibleGroups.length > 0 ? (
        <>
        {viewMode === "card" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pagedGroups.map((group: any) => (
              <Card key={group.id} className="border-border/40 bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        {groupKindBadge(group)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.lastMessage || "等待检查"}</p>
                    </div>
                    <div className="shrink-0">{groupStatusBadge(group)}</div>
                  </div>

                  <div className="space-y-2 rounded-md bg-muted/25 p-2.5">
                    <div className="text-xs text-muted-foreground">{groupMemberTitle(group)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(group.members || []).length > 0 ? (group.members || []).map((member: any, index: number) => (
                        <span
                          key={member.id}
                          className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                            Number(group.activeMemberId) === Number(member.id)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">
                            {index + 1}. {group.groupMode === "chain" ? `${chainRoleLabel(index, group.members?.length || 0)} · ` : ""}{memberLabel(member)}
                          </span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{group.groupMode === "chain" ? "入口" : "DDNS"}</p>
                      <p className="mt-1 truncate">{group.groupMode === "chain" ? (group.members?.[0]?.entryAddress || "第一台主机") : groupDdnsText(group)}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{group.groupMode === "chain" ? "链路延迟" : "引用规则"}</p>
                      <div className="mt-1">{group.groupMode === "chain" ? renderChainLatencySummary(group) : Number(group.templateRuleCount || 0)}</div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                    {chainLatencyActions(group)}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteGroup(group)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <>
          <div className="grid gap-3 sm:hidden">
            {pagedGroups.map((group: any) => (
              <Card key={group.id} className="border-border/40 bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        {groupKindBadge(group)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.lastMessage || "等待检查"}</p>
                    </div>
                    <div className="shrink-0">{groupStatusBadge(group)}</div>
                  </div>

                  <div className="space-y-2 rounded-md bg-muted/25 p-2.5">
                    <div className="text-xs text-muted-foreground">{groupMemberTitle(group)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(group.members || []).length > 0 ? (group.members || []).map((member: any, index: number) => (
                        <span
                          key={member.id}
                          className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                            Number(group.activeMemberId) === Number(member.id)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">
                            {index + 1}. {group.groupMode === "chain" ? `${chainRoleLabel(index, group.members?.length || 0)} · ` : ""}{memberLabel(member)}
                          </span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{group.groupMode === "chain" ? "入口" : "DDNS"}</p>
                      <p className="mt-1 truncate">{group.groupMode === "chain" ? (group.members?.[0]?.entryAddress || "第一台主机") : groupDdnsText(group)}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{group.groupMode === "chain" ? "链路延迟" : "引用规则"}</p>
                      <div className="mt-1">{group.groupMode === "chain" ? renderChainLatencySummary(group) : Number(group.templateRuleCount || 0)}</div>
                    </div>
                  </div>

                  <div className="flex justify-end gap-1 border-t border-border/40 pt-2">
                    {chainLatencyActions(group)}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteGroup(group)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="hidden border-border/40 bg-card/60 sm:block">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>状态</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>成员/链路</TableHead>
                    <TableHead className="hidden md:table-cell">入口</TableHead>
                    <TableHead className="hidden md:table-cell">{isChainMode ? "链路延迟" : "引用规则"}</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedGroups.map((group: any) => (
                    <TableRow key={group.id}>
                      <TableCell>{groupStatusBadge(group)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{group.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{group.lastMessage || (group.groupMode === "chain" ? "等待规则引用" : "等待故障转移检查")}</div>
                      </TableCell>
                      <TableCell>
                        {groupKindBadge(group)}
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-xs flex-wrap gap-1.5">
                          {(group.members || []).map((member: any, index: number) => (
                            <span
                              key={member.id}
                              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                                Number(group.activeMemberId) === Number(member.id)
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                  : "border-border bg-muted/20 text-muted-foreground"
                              }`}
                              title={`${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`}
                            >
                              {member.healthStatus === "healthy" ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : member.healthStatus === "unhealthy" ? (
                                <XCircle className="h-3 w-3" />
                              ) : null}
                              {index + 1}. {group.groupMode === "chain" ? `${chainRoleLabel(index, group.members?.length || 0)} · ` : ""}{memberLabel(member)}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="text-sm">{group.groupMode === "chain" ? (group.members?.[0]?.entryAddress || "第一台主机") : group.domain || "未配置域名"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{group.groupMode === "chain" ? "规则使用时监听入口端口" : group.lastDdnsValue || "未切换"}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{group.groupMode === "chain" ? renderChainLatencySummary(group) : Number(group.templateRuleCount || 0)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {chainLatencyActions(group)}
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => syncMutation.mutate({ id: group.id })}>
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => setDeleteGroup(group)}
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
          </CardContent>
        </Card>
          </>
        )}
          <PersistentPagination pagination={groupPagination} itemName={paginationItemName} />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60">
          <CardContent className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30">
              <Layers3 className="h-8 w-8 opacity-40" />
            </div>
            <p className="text-lg font-medium">{emptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground/60">
              {emptyDescription}
            </p>
          </CardContent>
        </Card>
        )}
      </ForwardGroupViewTransition>

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) resetForm();
          setShowDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {dialogDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className={`grid gap-4 ${isChainMode ? "" : "sm:grid-cols-2"}`}>
              <div className="space-y-2">
                <Label>{isChainMode ? "链名称" : "组名称"}</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={isChainMode ? "例如: 华东-香港转发链" : "例如: Web 高可用入口"} />
              </div>
              {!isChainMode && (
              <div className="space-y-2">
                <Label>组类型</Label>
                <Select
                  value={form.groupType}
                  disabled={form.groupMode === "chain"}
                  onValueChange={(v) => {
                    const newType = v as GroupType;
                    // Save current members before switching
                    savedMembersRef.current[form.groupType] = form.members;
                    // Restore saved members for the target type (or empty if never added)
                    const restored = savedMembersRef.current[newType] || [];
                    setForm({ ...form, groupType: newType, members: restored });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="host">主机端口转发组</SelectItem>
                    <SelectItem value="tunnel">隧道转发组</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              )}
            </div>

            {form.groupMode === "failover" && (
            <>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <div className="space-y-2">
                <Label>DDNS 域名</Label>
                <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="例如 app.example.com" />
              </div>
              <div className="space-y-2">
                <Label>记录类型</Label>
                <Select value={form.recordType} onValueChange={(v) => setForm({ ...form, recordType: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="AAAA">AAAA</SelectItem>
                    <SelectItem value="CNAME">CNAME</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">单位：秒，范围 10-3600。</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>故障转移时间</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={form.failoverSeconds}
                    onChange={(e) => setForm({ ...form, failoverSeconds: e.target.value })}
                    placeholder="60"
                  />
                </div>
                <div className="space-y-2">
                  <Label>恢复观察时间</Label>
                  <Input
                    type="number"
                    min={10}
                    max={3600}
                    value={form.recoverSeconds}
                    onChange={(e) => setForm({ ...form, recoverSeconds: e.target.value })}
                    placeholder="120"
                  />
                </div>
                <div className="flex items-end gap-4">
                  <label className="flex h-10 flex-1 items-center justify-between rounded-md border border-border/60 px-3">
                    <span className="text-sm">恢复后切回</span>
                    <Switch checked={form.autoFailback} onCheckedChange={(autoFailback) => setForm({ ...form, autoFailback })} />
                  </label>
                  <label className="flex h-10 flex-1 items-center justify-between rounded-md border border-border/60 px-3">
                    <span className="text-sm">启用</span>
                    <Switch checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                  </label>
                </div>
              </div>
            </div>
            </>
            )}

            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div>
                <Label>{form.groupMode === "chain" ? "链路主机顺序" : "成员优先级"}</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {form.groupMode === "chain" ? "按入口到出口顺序保存链路流程。" : "越靠上优先级越高。"}
                </p>
              </div>
              {form.groupMode === "chain" ? (
                <MultiHopEditor
                  hosts={hosts || []}
                  initialHopIds={form.members.map((member) => Number(member.hostId || 0)).filter(Boolean)}
                  initialHopConnectHosts={form.members.map((member) => member.connectHost || null)}
                  maxHops={5}
                  onChange={updateChainMemberIds}
                  onConnectHostsChange={updateChainConnectHosts}
                />
              ) : (
                <>
                  <div className="flex justify-end">
                    <Select onValueChange={(v) => addMember(Number(v))}>
                      <SelectTrigger className="w-full sm:w-64">
                        <SelectValue placeholder={form.groupType === "host" ? "添加主机成员" : "添加隧道成员"} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableMemberOptions.map((item: any) => (
                          <SelectItem key={item.id} value={String(item.id)} textValue={item.label}>
                            {form.groupType === "host" ? (
                              <HostStatusLabel
                                host={item.host}
                                label={(
                                  <span className="inline-flex min-w-0 items-center gap-1.5">
                                    <span className="truncate">{item.label}</span>
                                    {item.meta ? <span className="shrink-0 text-muted-foreground">/ {item.meta}</span> : null}
                                  </span>
                                )}
                              />
                            ) : (
                              <span>{item.label} {item.meta ? `/ ${item.meta}` : ""}</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    {form.members.map((member, index) => (
                      <div
                        key={member.key}
                        draggable
                        onDragStart={() => setDragMemberKey(member.key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragMemberKey) moveMember(dragMemberKey, member.key);
                          setDragMemberKey(null);
                        }}
                        className="flex items-center gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2"
                      >
                        <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-muted text-xs">{index + 1}</span>
                        {member.memberType === "host" ? (
                          <HostStatusLabel
                            host={hostById.get(Number(member.hostId))}
                            label={memberLabel(member)}
                            className="min-w-0 flex-1 text-sm font-medium"
                            labelClassName="truncate"
                          />
                        ) : (
                          <>
                            <Route className="h-4 w-4 text-primary" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{memberLabel(member)}</p>
                            </div>
                          </>
                        )}
                        <Switch checked={member.isEnabled} onCheckedChange={(checked) => {
                          setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                        }} />
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => removeMember(member.key)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    {form.members.length === 0 && (
                      <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">还没有成员</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={isPending}>{isPending ? "保存中..." : editingId ? "保存" : "创建"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {latencyGroup && (
        <ForwardGroupLatencyDialog
          groupId={latencyGroup.id}
          groupName={latencyGroup.name}
          open={!!latencyGroup}
          onOpenChange={(open) => !open && setLatencyGroup(null)}
        />
      )}
      {testGroup && (
        <ForwardGroupSelfTestDialog
          groupId={testGroup.id}
          groupName={testGroup.name}
          open={!!testGroup}
          onOpenChange={(open) => !open && setTestGroup(null)}
        />
      )}
      <Dialog open={!!deleteGroup} onOpenChange={(open) => !open && setDeleteGroup(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{deleteGroup?.groupMode === "chain" ? "删除端口转发链" : "删除转发组"}</DialogTitle>
            <DialogDescription>
              确认删除 "{deleteGroup?.name}"？引用它的转发规则会被同步清理，已下发到 Agent 的运行状态也会刷新。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {deleteImpactQuery.isLoading ? (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                正在检查关联转发规则...
              </div>
            ) : deleteImpactQuery.data?.forwardRuleCount ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <p className="font-medium text-destructive">
                  当前{deleteGroup?.groupMode === "chain" ? "端口转发链" : "转发组"}仍关联 {deleteImpactQuery.data.forwardRuleCount} 条转发规则
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  包含 {deleteImpactQuery.data.templateRuleCount || 0} 条用户规则和 {deleteImpactQuery.data.childRuleCount || 0} 条成员运行规则。
                </p>
                <div className="mt-2 max-h-44 space-y-1 overflow-auto text-xs text-muted-foreground">
                  {(deleteImpactQuery.data.forwardRules || []).map((rule: any) => (
                    <div key={rule.id} className="rounded border border-border/40 bg-background/60 px-2 py-1">
                      <span className="font-medium text-foreground">{rule.name}</span>
                      <span className="ml-2">:{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort}</span>
                    </div>
                  ))}
                  {deleteImpactQuery.data.forwardRuleCount > (deleteImpactQuery.data.forwardRules || []).length && (
                    <p>还有 {deleteImpactQuery.data.forwardRuleCount - (deleteImpactQuery.data.forwardRules || []).length} 条未显示。</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
                未发现关联转发规则。
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteGroup(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={!deleteGroup || deleteMutation.isPending || deleteImpactQuery.isLoading}
              onClick={() => deleteGroup && deleteMutation.mutate({ id: deleteGroup.id, confirmRules: true })}
            >
              {deleteMutation.isPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ForwardGroupsPage() {
  return (
    <DashboardLayout>
      <ForwardGroupsContent />
    </DashboardLayout>
  );
}

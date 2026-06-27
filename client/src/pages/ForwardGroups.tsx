import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { LatencyRating } from "@/components/LatencyRating";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
import { applyLatencyPeakCut, clipLatencyForChart, getLatencyStabilityStats, getLatencyYAxisMax, getLatencyYAxisTicks, isLatencySeriesCacheFresh } from "@/lib/latencyChart";
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
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { addHostNodeMeta, addNodeMetaAliases, hostDisplayName } from "@/lib/linkTestNodeMeta";

type GroupType = "host" | "tunnel";
type GroupMode = "failover" | "chain" | "entry" | "exit";

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
  entryGroupId: number | null;
  groupType: GroupType;
  domain: string;
  recordType: "A" | "AAAA" | "CNAME";
  failoverSeconds: string;
  recoverSeconds: string;
  chinaHealthCheckEnabled: boolean;
  chinaHealthCheckTarget: string;
  ddnsAutoResolveEnabled: boolean;
  autoFailback: boolean;
  isEnabled: boolean;
  members: MemberForm[];
};

const makeDefaultForm = (): GroupForm => ({
  name: "",
  groupMode: "failover",
  entryGroupId: null,
  groupType: "host",
  domain: "",
  recordType: "A",
  failoverSeconds: "60",
  recoverSeconds: "120",
  chinaHealthCheckEnabled: false,
  chinaHealthCheckTarget: "",
  ddnsAutoResolveEnabled: true,
  autoFailback: true,
  isEnabled: true,
  members: [],
});

function memberKey(memberType: GroupType, id: number) {
  return `${memberType}-${id}`;
}

function normalizeGroupMode(mode: unknown): GroupMode {
  const value = String(mode || "failover");
  return value === "chain" || value === "entry" || value === "exit" ? value : "failover";
}

function isCollectionMode(mode: GroupMode) {
  return mode === "entry" || mode === "exit";
}

function isChinaHealthTargetValid(value: string) {
  const target = value.trim().replace(/^tcp:\/\//i, "").replace(/：/g, ":");
  if (!target) return true;
  if (target.length > 253 || /[\s'"<>/]/.test(target)) return false;
  const bracketMatch = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    const port = bracketMatch[2] ? Number(bracketMatch[2]) : 80;
    return !!bracketMatch[1]?.trim() && Number.isInteger(port) && port >= 1 && port <= 65535;
  }
  const lastColon = target.lastIndexOf(":");
  if (lastColon > 0 && target.indexOf(":") === lastColon) {
    const port = Number(target.slice(lastColon + 1));
    return !!target.slice(0, lastColon).trim() && Number.isInteger(port) && port >= 1 && port <= 65535;
  }
  return true;
}

function unwrapBracketedHost(value: unknown) {
  const text = String(value || "").trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
}

function looksLikeIpv4(value: unknown) {
  const text = unwrapBracketedHost(value);
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function looksLikeIpv6(value: unknown) {
  const text = unwrapBracketedHost(value);
  return text.includes(":") && /^[0-9a-fA-F:.]+$/.test(text);
}

function looksLikeIp(value: unknown) {
  return looksLikeIpv4(value) || looksLikeIpv6(value);
}

function forwardGroupRecordValueForHost(host: any, recordType: GroupForm["recordType"]) {
  const manual = String(host?.entryIp || "").trim();
  if (recordType === "AAAA") {
    if (looksLikeIpv6(manual)) return unwrapBracketedHost(manual);
    return unwrapBracketedHost(host?.ipv6 || (looksLikeIpv6(host?.ip) ? host?.ip : ""));
  }
  if (recordType === "CNAME") {
    if (manual && !looksLikeIp(manual)) return manual;
    return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
  }
  if (looksLikeIpv4(manual)) return manual;
  return String(host?.ipv4 || (looksLikeIpv4(host?.ip) ? host?.ip : "") || "").trim();
}

function forwardGroupRecordRequirement(recordType: GroupForm["recordType"]) {
  if (recordType === "AAAA") return "IPv6";
  if (recordType === "CNAME") return "入口域名或 DDNS 域名";
  return "IPv4";
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
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.995 }}
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

function hostIpv6Address(host: any) {
  return String(host?.ipv6 || "").trim();
}

function normalizeConnectHostForHost(value: unknown, host: any, fallback: string | null = null) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const privateAddr = hostPrivateAddress(host);
  const ipv6Addr = hostIpv6Address(host);
  if (privateAddr && text === privateAddr) return privateAddr;
  if (ipv6Addr && text === ipv6Addr) return ipv6Addr;
  return fallback;
}

function normalizeChainConnectHostsForHosts(
  raw: Array<string | null>,
  hostIds: number[],
  hosts: any[] | undefined,
  externalEntry = false,
): Array<string | null> {
  const base = [...raw].slice(0, hostIds.length);
  while (base.length < hostIds.length) base.push(null);
  if (hostIds.length > 0 && !externalEntry) base[0] = null;
  const hostById = new Map((hosts || []).map((host: any) => [Number(host.id), host]));
  return base.map((value, index) => {
    if (index === 0 && !externalEntry) return null;
    const host = hostById.get(Number(hostIds[index] || 0));
    return normalizeConnectHostForHost(value, host, null);
  });
}

function chainRoleLabel(index: number, total: number, hasExternalEntry = false) {
  if (hasExternalEntry) return index === total - 1 ? "出口" : "中转";
  if (index === 0) return "入口";
  if (index === total - 1) return "出口";
  return "中转";
}

function entryGroupDisplayText(group: any, groupsByMode: Record<GroupMode, any[]>) {
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (!entryGroupId) return "";
  const entryGroup = groupsByMode.entry.find((item: any) => Number(item.id) === entryGroupId);
  if (!entryGroup) return `入口组 #${entryGroupId}`;
  return String(entryGroup.domain || entryGroup.name || `入口组 #${entryGroupId}`).trim();
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
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
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

  const rawChartData = useMemo<GroupLatencyPoint[]>(() => {
    if (!seriesData) return [];
    return seriesData.map((d: GroupLatencySeriesDatum): GroupLatencyPoint => ({
      label: formatGroupLatencyTime(d.recordedAt),
      fullLabel: formatGroupLatencyTime(d.recordedAt),
      latency: d.isTimeout ? 0 : (Number(d.latencyMs) || 0),
      chartLatency: d.isTimeout ? 0 : clipLatencyForChart(Number(d.latencyMs) || 0),
      isTimeout: !!d.isTimeout,
    }));
  }, [seriesData]);
  const chartData = useMemo<GroupLatencyPoint[]>(() => {
    if (!peakCutEnabled) return rawChartData;
    return applyLatencyPeakCut(rawChartData, [
      { dataKey: "latency", timeoutKey: "isTimeout" },
      { dataKey: "chartLatency", timeoutKey: "isTimeout" },
    ]) as GroupLatencyPoint[];
  }, [peakCutEnabled, rawChartData]);
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
      <DialogContent className="flex max-h-[96svh] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-3 sm:max-w-3xl sm:p-6">
        <DialogHeader>
          <div className="flex flex-col gap-2 pr-9 sm:flex-row sm:items-start sm:justify-between sm:pr-10">
            <div className="min-w-0">
              <DialogTitle>转发链延迟 - {groupName}</DialogTitle>
              <DialogDescription>近 24 小时链路逐跳探测汇总，成员之间使用 Ping，出口到目标使用 TCPing。</DialogDescription>
            </div>
            <LatencyPeakCutToggle id={`forward-group-peak-cut-${groupId}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} className="shrink-0 self-start sm:pt-1" />
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        <div className="h-[42svh] min-h-[220px] rounded-lg border border-border/60 bg-muted/20 p-2 sm:h-[260px] sm:p-3">
          {(isLoading || waitForFreshSeries) && !seriesData ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载延迟数据
            </div>
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无延迟数据</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}>
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
                <Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="url(#forwardGroupLatencyGradient)" dot={false} activeDot={{ r: 4, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} isAnimationActive={shouldAnimateChart} animationDuration={shouldAnimateChart ? 500 : 0} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <LatencyStabilityStats stats={stats} />
        </div>
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
  group,
  entryGroup,
  hostById,
  open,
  onOpenChange,
}: {
  groupId: number;
  groupName: string;
  group?: any | null;
  entryGroup?: any | null;
  hostById?: Map<number, any>;
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
  const linkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const members = [...(group?.members || [])]
      .filter((member: any) => member.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
    const entryMembers = entryGroup
      ? [...(entryGroup.members || [])]
        .filter((member: any) => member.memberType === "host" && member.isEnabled !== false)
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      : [];
    [...entryMembers, ...members].forEach((member: any) => {
      const hostId = Number(member.hostId || 0);
      const host = hostById?.get(hostId);
      addHostNodeMeta(meta, host, [
        member.entryAddress,
        hostId ? `主机${hostId}` : "",
        hostId ? `主机 #${hostId}` : "",
      ]);
    });
    const firstEntryHost = hostById?.get(Number(entryMembers[0]?.hostId || 0));
    const firstHost = hostById?.get(Number(members[0]?.hostId || 0));
    const lastHost = hostById?.get(Number(members[members.length - 1]?.hostId || 0));
    const targetRemark = String(group?.remark || "").trim();
    const targetLabel = targetRemark || hostDisplayName(lastHost) || groupName;
    const targetMeta = targetLabel ? { label: targetLabel } : undefined;
    if (targetMeta) {
      addNodeMetaAliases(meta, [targetLabel, "目标", "目的节点"], targetMeta);
    }
    const plannedSegments: LinkTestPlannedSegment[] = [];
    if (entryMembers.length > 0 && members[0]) {
      const firstChainHost = hostById?.get(Number(members[0].hostId || 0));
      entryMembers.forEach((entryMember: any) => {
        const entryHost = hostById?.get(Number(entryMember.hostId || 0));
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost) || `主机 #${members[0].hostId || "-"}`,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)] || meta[String(members[0].hostId || "")],
        });
      });
    }
    members.slice(0, -1).forEach((member: any, index: number) => {
      const fromHost = hostById?.get(Number(member.hostId || 0));
      const toHost = hostById?.get(Number(members[index + 1]?.hostId || 0));
      plannedSegments.push({
        from: hostDisplayName(fromHost) || `主机 #${member.hostId || "-"}`,
        to: hostDisplayName(toHost) || `主机 #${members[index + 1]?.hostId || "-"}`,
        fromMeta: meta[hostDisplayName(fromHost)] || meta[String(member.hostId || "")],
        toMeta: meta[hostDisplayName(toHost)] || meta[String(members[index + 1]?.hostId || "")],
      });
    });
    if (members.length > 0) {
      plannedSegments.push({
        from: hostDisplayName(lastHost) || `主机 #${members[members.length - 1]?.hostId || "-"}`,
        to: targetLabel,
        fromMeta: meta[hostDisplayName(lastHost)] || meta[String(members[members.length - 1]?.hostId || "")],
        toMeta: meta[targetLabel] || targetMeta,
      });
    }
    return {
      nodeMeta: meta,
      sourceLabel: hostDisplayName(firstEntryHost) || hostDisplayName(firstHost) || groupName,
      targetLabel,
      plannedSegments: plannedSegments.filter((segment) => segment.from && segment.to && segment.from.trim().toLowerCase() !== segment.to.trim().toLowerCase()),
    };
  }, [entryGroup?.members, group?.members, group?.remark, groupName, hostById]);

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

  const plannedSegmentCount = linkTestNodeData.plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${probeDialogSizeClass} min-w-0`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            延迟探测
          </DialogTitle>
          <DialogDescription>{groupName}</DialogDescription>
        </DialogHeader>

        <LinkTestProbeView
          parsed={parsedMessage}
          fallbackLatencyMs={latest?.latencyMs}
          isSuccess={isSuccess}
          isTesting={isTesting}
          sourceLabel={linkTestNodeData.sourceLabel}
          targetLabel={linkTestNodeData.targetLabel}
          nodeMeta={linkTestNodeData.nodeMeta}
          plannedSegments={linkTestNodeData.plannedSegments}
        />

        <DialogFooter className="gap-2">
          <Button
            onClick={() => {
              manualTestRef.current = true;
              setBaselineUpdatedAt(latest?.updatedAt ? String(latest.updatedAt) : "");
              setOptimisticTesting(true);
              testMutation.mutate({ groupId });
            }}
            disabled={isTesting}
            className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]"
          >
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            {isTesting ? "探测中..." : "链路测试"}
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
  const closeResetTimerRef = useRef<number | null>(null);
  const activeGroupMode = mode;
  const viewMode = controlledViewMode ?? internalViewMode;
  const deleteImpactQuery = trpc.forwardGroups.deleteImpact.useQuery(
    { id: Number(deleteGroup?.id || 0) },
    { enabled: !!deleteGroup },
  );

  const hostById = useMemo(() => new Map<number, any>((hosts || []).map((h: any) => [Number(h.id), h])), [hosts]);
  const tunnelById = useMemo(() => new Map<number, any>((tunnels || []).map((t: any) => [Number(t.id), t])), [tunnels]);
  const groupsByMode = useMemo(() => {
    const next: Record<GroupMode, any[]> = { failover: [], chain: [], entry: [], exit: [] };
    for (const group of groups || []) next[normalizeGroupMode(group.groupMode)].push(group);
    return next;
  }, [groups]);
  const usableEntryGroups = useMemo(() => groupsByMode.entry.filter((group: any) => group.isEnabled && String(group.domain || "").trim()), [groupsByMode.entry]);
  const entryGroupHostIds = (entryGroupId: number | null | undefined) => {
    const id = Number(entryGroupId || 0);
    if (!id) return [] as number[];
    const group = groupsByMode.entry.find((item: any) => Number(item.id) === id);
    return (group?.members || [])
      .filter((member: any) => member.memberType === "host" && member.isEnabled !== false)
      .map((member: any) => Number(member.hostId || 0))
      .filter((hostId: number) => hostId > 0);
  };
  const applyEntryGroupToChainForm = (prev: GroupForm, entryGroupId: number | null): GroupForm => {
    const excludedIds = new Set(entryGroupHostIds(entryGroupId));
    const members = excludedIds.size > 0
      ? prev.members.filter((member) => !excludedIds.has(Number(member.hostId || 0)))
      : prev.members;
    const hostIds = members.map((member) => Number(member.hostId || 0)).filter(Boolean);
    const normalizedConnectHosts = normalizeChainConnectHostsForHosts(
      members.map((item) => item.connectHost || null),
      hostIds,
      hosts,
      !!entryGroupId,
    );
    return {
      ...prev,
      entryGroupId,
      members: members.map((member, index) => ({
        ...member,
        connectHost: normalizedConnectHosts[index] || null,
      })),
    };
  };
  const visibleGroups = groupsByMode[activeGroupMode] || [];
  const modeTotal = visibleGroups.length;
  const activeCount = visibleGroups.filter((g: any) => {
    if (!g.isEnabled) return false;
    if (activeGroupMode === "failover" || activeGroupMode === "entry") return g.lastStatus === "healthy";
    return true;
  }).length;
  const groupPagination = usePersistentPagination(visibleGroups, {
    storageKey: `forwardx.forwardGroups.${activeGroupMode}.page`,
    pageSize: 12,
    isReady: !isLoading && !!groups,
  });
  const pagedGroups = groupPagination.items;
  const testGroupDetail = useMemo(
    () => testGroup ? (groups || []).find((group: any) => Number(group.id) === Number(testGroup.id)) || null : null,
    [groups, testGroup?.id]
  );
  const testGroupEntryGroup = useMemo(
    () => testGroupDetail?.entryGroupId
      ? (groups || []).find((group: any) => Number(group.id) === Number(testGroupDetail.entryGroupId)) || null
      : null,
    [groups, testGroupDetail?.entryGroupId]
  );

  const resetForm = () => {
    setForm(makeDefaultForm());
    setEditingId(null);
    setDragMemberKey(null);
    savedMembersRef.current = { host: [], tunnel: [] };
  };

  const clearCloseResetTimer = () => {
    if (closeResetTimerRef.current !== null) {
      window.clearTimeout(closeResetTimerRef.current);
      closeResetTimerRef.current = null;
    }
  };

  const closeDialog = () => {
    setShowDialog(false);
    clearCloseResetTimer();
    closeResetTimerRef.current = window.setTimeout(() => {
      resetForm();
      closeResetTimerRef.current = null;
    }, 220);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (open) {
      clearCloseResetTimer();
      setShowDialog(true);
      return;
    }
    closeDialog();
  };

  useEffect(() => () => clearCloseResetTimer(), []);

  const openCreate = () => {
    clearCloseResetTimer();
    const initial = makeDefaultForm();
    setForm({
      ...initial,
      groupMode: activeGroupMode,
      groupType: "host",
      domain: activeGroupMode === "failover" || activeGroupMode === "entry" ? initial.domain : "",
      recordType: activeGroupMode === "chain" || activeGroupMode === "exit" ? "A" : initial.recordType,
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
    clearCloseResetTimer();
    const groupMode = normalizeGroupMode(group.groupMode);
    setForm({
      name: group.name || "",
      groupMode,
      entryGroupId: group.entryGroupId ? Number(group.entryGroupId) : null,
      groupType: group.groupType === "tunnel" && groupMode === "failover" ? "tunnel" : "host",
      domain: group.domain || "",
      recordType: group.recordType || "A",
      failoverSeconds: String(Number(group.failoverSeconds || 60)),
      recoverSeconds: String(Number(group.recoverSeconds || 120)),
      chinaHealthCheckEnabled: !!group.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: group.chinaHealthCheckTarget || "",
      ddnsAutoResolveEnabled: group.ddnsAutoResolveEnabled !== false,
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
      closeDialog();
      toast.success("转发组已创建");
    },
    onError: (e) => toast.error(e.message || "创建失败"),
  });

  const updateMutation = trpc.forwardGroups.update.useMutation({
    onSuccess: () => {
      utils.forwardGroups.list.invalidate();
      utils.rules.list.invalidate();
      closeDialog();
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

  const effectiveGroupType = form.groupMode === "chain" || isCollectionMode(form.groupMode) ? "host" : form.groupType;
  const availableMemberOptions = effectiveGroupType === "host"
    ? (hosts || []).map((h: any) => ({ id: Number(h.id), label: h.name, meta: h.entryIp || h.ip || "", host: h }))
    : (tunnels || []).map((t: any) => ({
      id: Number(t.id),
      label: t.name,
      meta: getTunnelRouteText(t, hosts),
    }));

  const addMember = (id: number) => {
    if (!id) return;
    if ((form.groupMode === "chain" || isCollectionMode(form.groupMode)) && form.members.length >= 5) {
      toast.error(form.groupMode === "chain" ? "端口转发链最多支持 5 台主机" : "入口组/出口组最多支持 5 台主机");
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
          connectHost: null,
          isEnabled: true,
        },
      ],
    });
  };

  const removeMember = (key: string) => {
    setForm({ ...form, members: form.members.filter((m) => m.key !== key) });
  };

  const updateExitMemberUsePrivate = (key: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => {
        if (member.key !== key) return member;
        const host = hostById.get(Number(member.hostId || 0));
        const privateAddr = hostPrivateAddress(host);
        if (checked && !privateAddr) {
          toast.error("该主机未配置隧道内网 IP");
          return member;
        }
        return { ...member, connectHost: checked ? privateAddr : null };
      }),
    }));
  };

  const updateExitMemberUseIpv6 = (key: string, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.map((member) => {
        if (member.key !== key) return member;
        const host = hostById.get(Number(member.hostId || 0));
        const ipv6Addr = hostIpv6Address(host);
        if (checked && !ipv6Addr) {
          toast.error("该主机暂无IPv6");
          return member;
        }
        return { ...member, connectHost: checked ? ipv6Addr : null };
      }),
    }));
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
        !!prev.entryGroupId,
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
      const normalizedConnectHosts = normalizeChainConnectHostsForHosts(connectHosts, hostIds, hosts, !!prev.entryGroupId);
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
    const isFailoverMode = form.groupMode === "failover";
    const isChainGroup = form.groupMode === "chain";
    const isEntryGroup = form.groupMode === "entry";
    const isExitGroup = form.groupMode === "exit";
    const supportsChinaHealth = isFailoverMode || isEntryGroup;
    if (!form.name.trim()) return toast.error(isChainGroup ? "请填写链名称" : "请填写组名称");
    if (isChainGroup) {
      const minChainMembers = form.entryGroupId ? 1 : 2;
      if (form.members.length < minChainMembers || form.members.length > 5) {
        return toast.error(form.entryGroupId ? "端口转发链需要配置 1-5 台主机" : "端口转发链需要配置 2-5 台主机");
      }
    } else if (isEntryGroup || isExitGroup) {
      if (form.members.length < 1 || form.members.length > 5) return toast.error(isEntryGroup ? "入口组需要配置 1-5 台主机" : "出口组需要配置 1-5 台主机");
    } else if (form.members.length === 0) {
      return toast.error("请至少添加一个成员");
    }
    if ((isFailoverMode || isEntryGroup) && !form.domain.trim()) {
      return toast.error(isEntryGroup ? "入口组需要指定入口域名" : "请填写 DDNS 域名");
    }
    if (isFailoverMode || isEntryGroup) {
      const missingRecordMembers = form.members
        .filter((member) => member.isEnabled !== false)
        .filter((member) => {
          if (member.memberType === "host") {
            const host = hostById.get(Number(member.hostId || 0));
            return !forwardGroupRecordValueForHost(host, form.recordType);
          }
          const tunnel = tunnelById.get(Number(member.tunnelId || 0));
          const host = hostById.get(Number(tunnel?.entryHostId || 0));
          return !forwardGroupRecordValueForHost(host, form.recordType);
        })
        .map((member) => memberLabel(member));
      if (missingRecordMembers.length > 0) {
        return toast.error(`${form.recordType} 记录需要成员配置${forwardGroupRecordRequirement(form.recordType)}：${missingRecordMembers.slice(0, 5).join("、")}`);
      }
    }
    const failoverSeconds = Number(form.failoverSeconds);
    const recoverSeconds = Number(form.recoverSeconds);
    if (!Number.isInteger(failoverSeconds) || failoverSeconds < 10 || failoverSeconds > 3600) {
      return toast.error("故障转移时间需为 10-3600 秒的整数");
    }
    if (!Number.isInteger(recoverSeconds) || recoverSeconds < 10 || recoverSeconds > 3600) {
      return toast.error("恢复观察时间需为 10-3600 秒的整数");
    }
    const chinaHealthTarget = form.chinaHealthCheckTarget.trim();
    if (supportsChinaHealth && form.chinaHealthCheckEnabled && !isChinaHealthTargetValid(chinaHealthTarget)) {
      return toast.error("入口健康度检测目标格式不正确");
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      remark: null,
      entryGroupId: isChainGroup ? form.entryGroupId || null : null,
      groupType: isChainGroup || isEntryGroup || isExitGroup ? "host" : form.groupType,
      domain: isFailoverMode || isEntryGroup ? form.domain.trim() || null : null,
      recordType: isChainGroup || isExitGroup ? "A" : form.recordType,
      failoverSeconds,
      recoverSeconds,
      chinaHealthCheckEnabled: supportsChinaHealth && form.chinaHealthCheckEnabled,
      chinaHealthCheckTarget: supportsChinaHealth && form.chinaHealthCheckEnabled ? chinaHealthTarget || null : null,
      ddnsAutoResolveEnabled: isEntryGroup ? form.ddnsAutoResolveEnabled : true,
      members: form.members.map((member, index) => ({
        memberType: member.memberType,
        hostId: member.hostId,
        tunnelId: member.tunnelId,
        connectHost: isChainGroup || isExitGroup ? member.connectHost || null : null,
        isEnabled: isChainGroup ? true : member.isEnabled,
        priority: index,
      })),
    };
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload);
  };

  const groupStatusBadge = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (!group.isEnabled) return <Badge variant="outline">停用</Badge>;
    if (mode === "chain") return <Badge className="border-sky-500/20 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 hover:text-sky-900 dark:text-sky-300 dark:hover:bg-sky-500/20 dark:hover:text-sky-100">链路</Badge>;
    if (mode === "entry") {
      if (group.lastStatus === "error") return <Badge variant="destructive">DDNS 异常</Badge>;
      if (group.lastStatus === "healthy") return <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-100">已同步</Badge>;
      return <Badge variant="secondary">等待同步</Badge>;
    }
    if (mode === "exit") return <Badge className="border-indigo-500/20 bg-indigo-500/10 text-indigo-700 hover:bg-indigo-500/20 hover:text-indigo-900 dark:text-indigo-300 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-100">可选出口</Badge>;
    if (group.lastStatus === "healthy") return <Badge className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-500/20 dark:hover:text-emerald-100">健康</Badge>;
    if (group.lastStatus === "down") return <Badge variant="destructive">不可用</Badge>;
    if (group.lastStatus === "error") return <Badge variant="destructive">DDNS 异常</Badge>;
    return <Badge variant="secondary">等待故障转移检查</Badge>;
  };

  const memberLabel = (member: any) => {
    if (member.memberType === "host") return hostById.get(Number(member.hostId))?.name || `主机 #${member.hostId}`;
    const tunnel = tunnelById.get(Number(member.tunnelId));
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : `隧道 #${member.tunnelId}`;
  };

  const memberHealthTitle = (member: any) => {
    const parts = [`链路 ${member.healthStatus || "unknown"}${member.lastLatencyMs ? ` / ${member.lastLatencyMs}ms` : ""}`];
    if (member.chinaHealthStatus && member.chinaHealthStatus !== "unknown") {
      parts.push(`国内 ${member.chinaHealthStatus}${member.chinaHealthLatencyMs ? ` / ${member.chinaHealthLatencyMs}ms` : ""}`);
    }
    return parts.join(" / ");
  };

  const groupKindBadge = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "chain") return <Badge variant="outline">端口转发链</Badge>;
    if (mode === "entry") return <Badge variant="outline">入口组</Badge>;
    if (mode === "exit") return <Badge variant="outline">出口组</Badge>;
    return <Badge variant="outline">{group.groupType === "tunnel" ? "隧道高可用" : "主机高可用"}</Badge>;
  };

  const groupMemberTitle = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "chain") return "链路顺序";
    if (mode === "entry") return "入口主机";
    if (mode === "exit") return "出口主机";
    return "成员优先级";
  };

  const groupStatusMessage = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    const templateRuleCount = Number(group.templateRuleCount || 0);
    if (mode === "chain" && templateRuleCount > 0) return `已被 ${templateRuleCount} 条转发规则引用`;
    if (group.lastMessage) return group.lastMessage;
    if (mode === "chain") return "等待转发规则引用";
    if (mode === "entry") return "等待 DDNS 同步";
    if (mode === "exit") return "出口组已保存，可作为隧道出口使用";
    return "等待故障转移检查";
  };

  const isGroupMemberActive = (group: any, member: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (member.isEnabled === false) return false;
    if (mode === "entry" || mode === "exit" || mode === "chain") {
      const status = String(member.healthStatus || group.lastStatus || "").toLowerCase();
      return status !== "unhealthy" && status !== "failed" && status !== "down" && status !== "error";
    }
    return Number(group.activeMemberId) === Number(member.id);
  };

  const groupDdnsText = (group: any) => {
    const mode = normalizeGroupMode(group.groupMode);
    if (mode === "chain" || mode === "exit") return "不使用";
    return group.domain || "未配置";
  };

  const chainEntryText = (group: any) => {
    const entryGroupText = entryGroupDisplayText(group, groupsByMode);
    if (entryGroupText) return entryGroupText;
    return group.members?.[0]?.entryAddress || "第一台主机";
  };

  const memberConnectLabel = (member: any) => {
    const connectHost = String(member.connectHost || "").trim();
    if (!connectHost || member.memberType !== "host") return "";
    const host = hostById.get(Number(member.hostId || 0));
    if (hostPrivateAddress(host) && connectHost === hostPrivateAddress(host)) return "内网";
    if (hostIpv6Address(host) && connectHost === hostIpv6Address(host)) return "IPv6";
    return "指定地址";
  };

  const memberDecoratedLabel = (group: any, member: any, index: number) => {
    const prefix = normalizeGroupMode(group.groupMode) === "chain"
      ? `${chainRoleLabel(index, group.members?.length || 0, !!Number(group.entryGroupId || 0))} · `
      : "";
    const connectLabel = normalizeGroupMode(group.groupMode) === "exit" ? memberConnectLabel(member) : "";
    const suffix = connectLabel ? ` · ${connectLabel}` : "";
    return `${index + 1}. ${prefix}${memberLabel(member)}${suffix}`;
  };

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
  const canManualCheck = activeGroupMode === "failover" || activeGroupMode === "entry";
  const modeMeta: Record<GroupMode, {
    title: string;
    description: string;
    addButtonText: string;
    loadingLabel: string;
    emptyTitle: string;
    emptyDescription: string;
    paginationItemName: string;
  }> = {
    failover: {
      title: "转发组",
      description: "管理 DDNS 故障转移规则。",
      addButtonText: "添加转发组",
      loadingLabel: "正在加载转发组",
      emptyTitle: "暂无转发组",
      emptyDescription: "创建后可在转发规则中作为高可用入口使用",
      paginationItemName: "个转发组",
    },
    chain: {
      title: "端口转发链",
      description: "管理按主机顺序串联的端口转发链路。",
      addButtonText: "添加转发链",
      loadingLabel: "正在加载端口转发链",
      emptyTitle: "暂无端口转发链",
      emptyDescription: "创建后可在端口转发规则中作为链路使用",
      paginationItemName: "条转发链",
    },
    entry: {
      title: "入口组",
      description: "组合最多 5 台入口主机，并把它们同步到同一个 DDNS 域名。",
      addButtonText: "添加入口组",
      loadingLabel: "正在加载入口组",
      emptyTitle: "暂无入口组",
      emptyDescription: "创建后会把多台入口主机同步到同一个 DDNS 域名",
      paginationItemName: "个入口组",
    },
    exit: {
      title: "出口组",
      description: "组合最多 5 台出口主机，供隧道作为固定出口选择。",
      addButtonText: "添加出口组",
      loadingLabel: "正在加载出口组",
      emptyTitle: "暂无出口组",
      emptyDescription: "创建后可在隧道出口下拉中选择使用",
      paginationItemName: "个出口组",
    },
  };
  const currentModeMeta = modeMeta[activeGroupMode];
  const pageTitle = currentModeMeta.title;
  const pageDescription = currentModeMeta.description;
  const addButtonText = currentModeMeta.addButtonText;
  const loadingLabel = currentModeMeta.loadingLabel;
  const emptyTitle = currentModeMeta.emptyTitle;
  const emptyDescription = currentModeMeta.emptyDescription;
  const paginationItemName = currentModeMeta.paginationItemName;
  const dialogTitle = editingId ? `编辑${currentModeMeta.title}` : `添加${currentModeMeta.title}`;
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
              value={`${activeCount} / ${modeTotal} ${activeGroupMode === "failover" || activeGroupMode === "entry" ? "健康" : "启用"}`}
              loading={isLoading || !groups}
              cacheKey={`forwardGroups.header.${activeGroupMode}.active`}
              fallbackValue={`0 / 0 ${activeGroupMode === "failover" || activeGroupMode === "entry" ? "健康" : "启用"}`}
            />
          </Badge>
          {canManualCheck && <Button variant="outline" className="gap-2" onClick={() => runFailoverMutation.mutate()} disabled={runFailoverMutation.isPending}>
            {runFailoverMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {activeGroupMode === "entry" ? "同步" : "检查"}
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
          <AutoAnimateContainer className="standard-card-grid gap-4">
            {pagedGroups.map((group: any) => (
              <Card key={group.id} className="border-border/40 bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="min-w-0 truncate font-medium">{group.name}</p>
                        {groupKindBadge(group)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{groupStatusMessage(group)}</p>
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
                            isGroupMemberActive(group, member)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={memberHealthTitle(member)}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">
                            {memberDecoratedLabel(group, member, index)}
                          </span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{normalizeGroupMode(group.groupMode) === "chain" ? "入口" : normalizeGroupMode(group.groupMode) === "exit" ? "出口" : "DDNS"}</p>
                      <p className="mt-1 truncate">{normalizeGroupMode(group.groupMode) === "chain" ? chainEntryText(group) : normalizeGroupMode(group.groupMode) === "exit" ? `${(group.members || []).length} 台主机` : groupDdnsText(group)}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{normalizeGroupMode(group.groupMode) === "chain" ? "链路延迟" : isCollectionMode(normalizeGroupMode(group.groupMode)) ? "用途" : "引用规则"}</p>
                      <div className="mt-1">{normalizeGroupMode(group.groupMode) === "chain" ? renderChainLatencySummary(group) : isCollectionMode(normalizeGroupMode(group.groupMode)) ? (normalizeGroupMode(group.groupMode) === "entry" ? "固定入口" : "固定出口") : Number(group.templateRuleCount || 0)}</div>
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
          </AutoAnimateContainer>
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
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{groupStatusMessage(group)}</p>
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
                            isGroupMemberActive(group, member)
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                          title={memberHealthTitle(member)}
                        >
                          {member.healthStatus === "healthy" ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                          ) : member.healthStatus === "unhealthy" ? (
                            <XCircle className="h-3 w-3 shrink-0" />
                          ) : null}
                          <span className="truncate">
                            {memberDecoratedLabel(group, member, index)}
                          </span>
                        </span>
                      )) : (
                        <span className="text-xs text-muted-foreground">暂无成员</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{normalizeGroupMode(group.groupMode) === "chain" ? "入口" : normalizeGroupMode(group.groupMode) === "exit" ? "出口" : "DDNS"}</p>
                      <p className="mt-1 truncate">{normalizeGroupMode(group.groupMode) === "chain" ? chainEntryText(group) : normalizeGroupMode(group.groupMode) === "exit" ? `${(group.members || []).length} 台主机` : groupDdnsText(group)}</p>
                    </div>
                    <div className="min-w-0 rounded-md border border-border/40 bg-background/35 p-2">
                      <p className="text-muted-foreground">{normalizeGroupMode(group.groupMode) === "chain" ? "链路延迟" : isCollectionMode(normalizeGroupMode(group.groupMode)) ? "用途" : "引用规则"}</p>
                      <div className="mt-1">{normalizeGroupMode(group.groupMode) === "chain" ? renderChainLatencySummary(group) : isCollectionMode(normalizeGroupMode(group.groupMode)) ? (normalizeGroupMode(group.groupMode) === "entry" ? "固定入口" : "固定出口") : Number(group.templateRuleCount || 0)}</div>
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
                    <TableHead className="hidden md:table-cell">{activeGroupMode === "exit" ? "出口" : activeGroupMode === "entry" ? "DDNS" : "入口"}</TableHead>
                    <TableHead className="hidden md:table-cell">{isChainMode ? "链路延迟" : isCollectionMode(activeGroupMode) ? "用途" : "引用规则"}</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedGroups.map((group: any) => (
                    <TableRow key={group.id}>
                      <TableCell>{groupStatusBadge(group)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{group.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{groupStatusMessage(group)}</div>
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
                                isGroupMemberActive(group, member)
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                  : "border-border bg-muted/20 text-muted-foreground"
                              }`}
                              title={memberHealthTitle(member)}
                            >
                              {member.healthStatus === "healthy" ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : member.healthStatus === "unhealthy" ? (
                                <XCircle className="h-3 w-3" />
                              ) : null}
                              {memberDecoratedLabel(group, member, index)}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="text-sm">{normalizeGroupMode(group.groupMode) === "chain" ? chainEntryText(group) : normalizeGroupMode(group.groupMode) === "exit" ? `${(group.members || []).length} 台出口主机` : group.domain || "未配置域名"}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{normalizeGroupMode(group.groupMode) === "chain" ? "规则使用时监听入口端口" : normalizeGroupMode(group.groupMode) === "exit" ? "隧道出口组" : group.lastDdnsValue || "未切换"}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{normalizeGroupMode(group.groupMode) === "chain" ? renderChainLatencySummary(group) : isCollectionMode(normalizeGroupMode(group.groupMode)) ? (normalizeGroupMode(group.groupMode) === "entry" ? "固定入口" : "固定出口") : Number(group.templateRuleCount || 0)}</TableCell>
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
        onOpenChange={handleDialogOpenChange}
      >
        <DialogContent className={`flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-3 overflow-hidden ${isChainMode ? "sm:max-w-xl" : "sm:max-w-3xl"}`}>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className={`grid gap-3 ${isChainMode ? "" : "sm:grid-cols-2"}`}>
              <div className="space-y-2">
                <Label>{isChainMode ? "链名称" : "组名称"}</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={isChainMode ? "例如: 华东-香港转发链" : "例如: Web 高可用入口"} />
              </div>
              {form.groupMode === "failover" && (
              <div className="space-y-2">
                <Label>组类型</Label>
                <Select
                  value={form.groupType}
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
              {isCollectionMode(form.groupMode) && (
                <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
                  <span className="text-sm">启用</span>
                  <Switch checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                </label>
              )}
            </div>

            {(form.groupMode === "failover" || form.groupMode === "entry") && (
            <>
            <div className={`grid gap-4 ${form.groupMode === "entry" ? "sm:grid-cols-[minmax(0,1fr)_120px_160px]" : "sm:grid-cols-[minmax(0,1fr)_160px]"}`}>
              <div className="space-y-2">
                <Label>{form.groupMode === "entry" ? "入口域名" : "DDNS 域名"}</Label>
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
              {form.groupMode === "entry" && (
                <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3 sm:self-end">
                  <span className="text-sm">自动解析</span>
                  <Switch checked={form.ddnsAutoResolveEnabled} onCheckedChange={(ddnsAutoResolveEnabled) => setForm({ ...form, ddnsAutoResolveEnabled })} />
                </label>
              )}
            </div>

            {form.groupMode === "failover" && <div className="space-y-2">
              <p className="text-xs text-muted-foreground">单位：秒，范围 10-3600。</p>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,150px)_minmax(0,150px)_minmax(0,1fr)]">
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
                <div className="flex items-end gap-3">
                  <label className="flex h-10 min-w-[142px] flex-1 items-center justify-between gap-3 rounded-md border border-border/60 px-3">
                    <span className="whitespace-nowrap text-sm">恢复后切回</span>
                    <Switch checked={form.autoFailback} onCheckedChange={(autoFailback) => setForm({ ...form, autoFailback })} />
                  </label>
                  <label className="flex h-10 min-w-[104px] flex-1 items-center justify-between gap-3 rounded-md border border-border/60 px-3">
                    <span className="whitespace-nowrap text-sm">启用</span>
                    <Switch checked={form.isEnabled} onCheckedChange={(isEnabled) => setForm({ ...form, isEnabled })} />
                  </label>
                </div>
              </div>
            </div>}

            {(form.groupMode === "failover" || form.groupMode === "entry") && <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
              <div className="space-y-1.5">
                <Input
                  aria-label="入口健康度检测目标，留空默认 www.189.cn:80"
                  disabled={!form.chinaHealthCheckEnabled}
                  value={form.chinaHealthCheckTarget}
                  onChange={(e) => setForm({ ...form, chinaHealthCheckTarget: e.target.value })}
                  placeholder="留空默认 www.189.cn:80"
                />
                <p className="text-xs text-muted-foreground">
                  用于剔除不健康入口；至少一个成员可达时整体仍视为可用。
                </p>
              </div>
              <label className="flex h-10 items-center justify-between rounded-md border border-border/60 px-3">
                <span className="text-sm">入口健康度检测</span>
                <Switch
                  checked={form.chinaHealthCheckEnabled}
                  onCheckedChange={(chinaHealthCheckEnabled) => setForm({ ...form, chinaHealthCheckEnabled })}
                />
              </label>
            </div>}
            </>
            )}

            {form.groupMode === "chain" && (
              <div className="space-y-2">
                <Label>入口组</Label>
                <Select
                  value={form.entryGroupId ? String(form.entryGroupId) : "none"}
                  onValueChange={(value) => setForm((prev) => applyEntryGroupToChainForm(prev, value === "none" ? null : Number(value)))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择已保存入口组" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不使用入口组</SelectItem>
                    {usableEntryGroups.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-muted-foreground">暂无可用入口组</div>
                    ) : usableEntryGroups.map((group: any) => (
                      <SelectItem key={group.id} value={String(group.id)} textValue={group.name}>
                        <span className="inline-flex min-w-0 flex-col">
                          <span className="truncate">{group.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{String(group.domain || "-")}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className={form.groupMode === "chain" ? "space-y-2" : "space-y-3 rounded-lg border border-border/60 p-3"}>
              <Label>{form.groupMode === "chain" ? "链路主机顺序" : form.groupMode === "entry" ? "入口主机" : form.groupMode === "exit" ? "出口主机" : "成员优先级"}</Label>
              {form.groupMode === "chain" ? (
                <MultiHopEditor
                  hosts={hosts || []}
                  initialHopIds={form.members.map((member) => Number(member.hostId || 0)).filter(Boolean)}
                  initialHopConnectHosts={form.members.map((member) => member.connectHost || null)}
                  maxHops={5}
                  externalEntry={!!form.entryGroupId}
                  excludedHostIds={entryGroupHostIds(form.entryGroupId)}
                  onChange={updateChainMemberIds}
                  onConnectHostsChange={updateChainConnectHosts}
                />
              ) : (
                <>
                  <div className="flex justify-end">
                    <Select onValueChange={(v) => addMember(Number(v))}>
                      <SelectTrigger className="w-full sm:w-64">
                        <SelectValue placeholder={effectiveGroupType === "host" ? "添加主机成员" : "添加隧道成员"} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableMemberOptions.map((item: any) => (
                          <SelectItem key={item.id} value={String(item.id)} textValue={item.label}>
                            {effectiveGroupType === "host" ? (
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
                        {form.groupMode === "exit" && member.memberType === "host" && (
                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            <label className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground">
                              <span>内网</span>
                              <Switch
                                checked={!!hostPrivateAddress(hostById.get(Number(member.hostId || 0))) && member.connectHost === hostPrivateAddress(hostById.get(Number(member.hostId || 0)))}
                                disabled={!hostPrivateAddress(hostById.get(Number(member.hostId || 0)))}
                                onCheckedChange={(checked) => updateExitMemberUsePrivate(member.key, checked)}
                              />
                            </label>
                            <label className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground">
                              <span>IPv6</span>
                              <Switch
                                checked={!!hostIpv6Address(hostById.get(Number(member.hostId || 0))) && member.connectHost === hostIpv6Address(hostById.get(Number(member.hostId || 0)))}
                                disabled={!hostIpv6Address(hostById.get(Number(member.hostId || 0)))}
                                onCheckedChange={(checked) => updateExitMemberUseIpv6(member.key, checked)}
                              />
                            </label>
                          </div>
                        )}
                        <Switch checked={member.isEnabled} onCheckedChange={(checked) => {
                          setForm({ ...form, members: form.members.map((m) => m.key === member.key ? { ...m, isEnabled: checked } : m) });
                        }} title={member.isEnabled ? "关闭后该成员不参与转发组切换" : "开启后该成员可参与转发组切换"} />
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
            <Button variant="outline" onClick={closeDialog}>取消</Button>
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
          group={testGroupDetail}
          entryGroup={testGroupEntryGroup}
          hostById={hostById}
          open={!!testGroup}
          onOpenChange={(open) => !open && setTestGroup(null)}
        />
      )}
      <Dialog open={!!deleteGroup} onOpenChange={(open) => !open && setDeleteGroup(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{normalizeGroupMode(deleteGroup?.groupMode) === "chain" ? "删除端口转发链" : normalizeGroupMode(deleteGroup?.groupMode) === "entry" ? "删除入口组" : normalizeGroupMode(deleteGroup?.groupMode) === "exit" ? "删除出口组" : "删除转发组"}</DialogTitle>
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
                  当前{normalizeGroupMode(deleteGroup?.groupMode) === "chain" ? "端口转发链" : normalizeGroupMode(deleteGroup?.groupMode) === "entry" ? "入口组" : normalizeGroupMode(deleteGroup?.groupMode) === "exit" ? "出口组" : "转发组"}仍关联 {deleteImpactQuery.data.forwardRuleCount} 条转发规则
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

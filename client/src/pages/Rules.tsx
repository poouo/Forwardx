import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { PersistentPagination, usePersistentPagination } from "@/components/PersistentPagination";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
  ClipboardCopy,
  Layers3,
  LayoutGrid,
  List,
} from "lucide-react";
import {
  FORWARD_TYPES,
  FORWARD_TYPE_LABELS,
  FORWARD_PROTOCOL_LABELS,
  normalizeForwardProtocolSettings,
  type ForwardType,
  type ForwardProtocolKey,
} from "@shared/forwardTypes";
import { Fragment, useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { TcpingDetailDialog } from "@/components/rules/TcpingDetailDialog";

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
  routeMode: "local" | "tunnel" | "group";
  forwardType: ForwardType;
  protocol: "tcp" | "udp" | "both";
  gostMode: "direct" | "reverse";
  gostRelayHost: string;
  gostRelayPort: number;
  tunnelId: number | null;
  forwardGroupId: number | null;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
};

const defaultForm: RuleFormData = {
  hostId: null,
  name: "",
  routeMode: "local",
  forwardType: "iptables",
  protocol: "both",
  gostMode: "direct",
  gostRelayHost: "",
  gostRelayPort: 0,
  tunnelId: null,
  forwardGroupId: null,
  sourcePort: 0,
  targetIp: "",
  targetPort: 0,
};

const gostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);
const unsupportedProtocolTitle = "当前不支持，请联系管理员";
const desktopRuleTypeLabels = {
  local: "端口转发",
  tunnel: "隧道转发",
  group: "转发组",
} as const;

type RuleViewMode = "card" | "table";

const RULE_VIEW_MODE_STORAGE_KEY = "forwardx.rules.viewMode";

function getStoredRuleViewMode(): RuleViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(RULE_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeRuleViewMode(viewMode: RuleViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getRuleDisplayType(rule: any): keyof typeof desktopRuleTypeLabels {
  if (rule.forwardGroupId) return "group";
  if (rule.forwardType === "gost" && rule.tunnelId) return "tunnel";
  return "local";
}

function getTunnelDisplay(tunnel: any | null | undefined) {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "forwardx") {
    return {
      shortLabel: "ForwardX",
      badgeLabel: "隧道 / ForwardX",
      toolLabel: "ForwardX 加密隧道",
    };
  }
  if (gostTunnelModes.has(mode)) {
    return {
      shortLabel: "gost",
      badgeLabel: "隧道 / gost",
      toolLabel: "GOST 隧道",
    };
  }
  return {
    shortLabel: mode ? mode.toUpperCase() : "隧道",
    badgeLabel: mode ? `隧道 / ${mode.toUpperCase()}` : "隧道",
    toolLabel: "隧道转发",
  };
}

function getHostEntryAddress(host: any | null | undefined): string {
  return String(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip || "").trim();
}

function routeModeOptionClass(active: boolean, disabled = false) {
  return [
    "flex min-h-11 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    active ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
    disabled ? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground" : "cursor-pointer",
  ].join(" ");
}

function isValidPort(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

function RulesContent() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [secondaryQueriesReady, setSecondaryQueriesReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSecondaryQueriesReady(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  const { data: rules, isLoading } = trpc.rules.list.useQuery(undefined, {
    refetchInterval: 15000,
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });
  const { data: hosts } = trpc.hosts.list.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: tunnels } = trpc.tunnels.list.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: users } = trpc.users.list.useQuery(undefined, {
    enabled: user?.role === "admin" && secondaryQueriesReady,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: forwardGroups } = trpc.forwardGroups.list.useQuery(undefined, {
    enabled: secondaryQueriesReady,
    refetchInterval: 15000,
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });
  const { data: systemSettings } = trpc.system.getSettings.useQuery(undefined, {
    enabled: secondaryQueriesReady,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: wallet } = trpc.billing.me.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const { data: trafficBilling } = trpc.trafficBilling.status.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteRule, setDeleteRule] = useState<any | null>(null);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const [filterHost, setFilterHost] = useState<string>("all");
  const [filterUser, setFilterUser] = useState<string>("self");
  const [filterTunnel, setFilterTunnel] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [viewMode, setViewMode] = useState<RuleViewMode>(() => getStoredRuleViewMode());
  const selectedRulesQuery = useMemo(() => {
    if (user?.role !== "admin") return undefined;
    const input: { userId?: number; scope?: "self" | "all"; hostId?: number; tunnelId?: number | null } = {};
    if (filterUser === "all") {
      input.scope = "all";
    } else if (filterUser === "self") {
      input.userId = Number(user.id);
    } else {
      input.userId = Number(filterUser);
    }
    if (filterHost !== "all" && !String(filterHost).startsWith("group:")) input.hostId = Number(filterHost);
    if (filterTunnel !== "all") input.tunnelId = filterTunnel === "none" ? null : Number(filterTunnel);
    return Object.keys(input).length ? input : undefined;
  }, [filterHost, filterTunnel, filterUser, user?.id, user?.role]);
  const effectiveRulesQuery = selectedRulesQuery || undefined;
  const [portStatus, setPortStatus] = useState<"idle" | "checking" | "available" | "used">("idle");
  const [portRangeError, setPortRangeError] = useState<string | null>(null);
  const latestPortCheckRef = useRef(0);
  const [copySourceHostId, setCopySourceHostId] = useState<string>("");
  const [copyTargetHostIds, setCopyTargetHostIds] = useState<number[]>([]);
  const [copyRuleIds, setCopyRuleIds] = useState<number[]>([]);
  const [copyConflictStrategy, setCopyConflictStrategy] = useState<"skip" | "auto" | "error">("skip");
  const { data: selectedScopeRules } = trpc.rules.list.useQuery(effectiveRulesQuery as any, {
    enabled: user?.role === "admin" && !!effectiveRulesQuery,
    refetchInterval: 15000,
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });

  const walletBalanceKnown = wallet?.balanceCents !== undefined && wallet?.balanceCents !== null;
  const manuallyPaused = (user as any)?.forwardAccessPauseReason === "manual";
  const hasTrafficBillingBalance = !manuallyPaused && !!trafficBilling?.enabled && !!trafficBilling?.hasUsableResources && walletBalanceKnown && Number(wallet?.balanceCents || 0) > 0;
  // 权限检查：管理员、有 canAddRules 权限，或本地已确认流量计费余额可用
  const canAdd = user?.role === "admin" || user?.canAddRules === true || hasTrafficBillingBalance;

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

  const copyMutation = trpc.rules.copyToHosts.useMutation({
    onSuccess: (data) => {
      utils.rules.list.invalidate();
      const copied = data.copied.length;
      const skipped = data.skipped.length;
      toast.success(`已复制 ${copied} 条规则${skipped ? `，跳过 ${skipped} 条` : ""}`);
      setShowCopyDialog(false);
      setCopyRuleIds([]);
      setCopyTargetHostIds([]);
    },
    onError: (err) => toast.error(err.message || "复制失败"),
  });

  // 近 24h 按规则汇总的流量
  const { data: trafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24 },
    {
      enabled: secondaryQueriesReady && !!rules && rules.length > 0,
      refetchInterval: 30000,
      staleTime: 15000,
      refetchOnWindowFocus: false,
    }
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

  const setRouteMode = (mode: "local" | "tunnel" | "group") => {
    if (mode === form.routeMode) return;
    if (editingId && mode !== form.routeMode) return;
    if (mode === "local" && !canUseLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    const nextTunnel = mode === "tunnel"
      ? (selectedTunnel || availableTunnels[0] || supportedTunnels[0])
      : null;
    if (mode === "tunnel" && !nextTunnel) return;
    if (mode === "group" && availableForwardGroups.length === 0) return;
    const nextGroup = mode === "group"
      ? (selectedForwardGroup || availableForwardGroups[0])
      : null;
    const nextForwardType = mode === "tunnel"
      ? "gost"
      : mode === "group" && nextGroup?.groupType === "tunnel"
      ? "gost"
      : (usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0]);
    if (!nextForwardType) return;
    latestPortCheckRef.current += 1;
    setPortStatus("idle");
    setPortRangeError(null);
    setForm((prev) => ({
      ...prev,
      routeMode: mode,
      forwardType: nextForwardType,
      tunnelId: mode === "tunnel" && nextTunnel ? Number(nextTunnel.id) : null,
      forwardGroupId: mode === "group" && nextGroup ? Number(nextGroup.id) : null,
      hostId: mode === "tunnel" && nextTunnel ? nextTunnel.entryHostId : mode === "group" ? null : prev.hostId,
    }));
  };

  const toggleMutation = trpc.rules.toggle.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      utils.auth.me.invalidate();
      utils.billing.me.invalidate();
    },
    onError: (err) => toast.error(err.message || "操作失败"),
  });

  const isTrafficBillingRule = (rule: any) => {
    if (!trafficBilling?.enabled) return false;
    const resourceIds = trafficBilling.usableResourceIds || { hostIds: [], tunnelIds: [] };
    if (rule.tunnelId) {
      return (resourceIds.tunnelIds || []).map(Number).includes(Number(rule.tunnelId));
    }
    return (resourceIds.hostIds || []).map(Number).includes(Number(rule.hostId));
  };

  const handleToggleRule = (rule: any, checked: boolean) => {
    if (
      checked &&
      user?.role !== "admin" &&
      trafficBilling?.enabled &&
      isTrafficBillingRule(rule) &&
      walletBalanceKnown &&
      Number(wallet?.balanceCents || 0) <= 0
    ) {
      toast.error("流量计费余额不足，请充值后再启用规则");
      return;
    }
    toggleMutation.mutate({ id: rule.id, isEnabled: checked });
  };

  const resetForm = () => {
    setForm(defaultForm);
    setEditingId(null);
    setPortStatus("idle");
  };

  const openCreate = () => {
    resetForm();
    const firstForwardType = canUseLocalForward ? usableForwardTypes[0] : undefined;
    const firstTunnel = canUseGost
      ? supportedTunnels[0]
      : null;
    const firstGroup = canUseForwardGroup ? availableForwardGroups[0] : null;
    if (firstForwardType || firstTunnel || firstGroup) {
      setForm({
        ...defaultForm,
        routeMode: firstForwardType ? "local" : firstTunnel ? "tunnel" : firstGroup ? "group" : "local",
        hostId: firstForwardType ? hosts?.[0]?.id ?? null : firstTunnel ? firstTunnel.entryHostId : null,
        forwardType: firstTunnel && !firstForwardType ? "gost" : firstGroup?.groupType === "tunnel" ? "gost" : firstForwardType ?? "iptables",
        tunnelId: firstTunnel && !firstForwardType ? firstTunnel.id : null,
        forwardGroupId: !firstForwardType && !firstTunnel && firstGroup ? Number(firstGroup.id) : null,
      });
    }
    setShowDialog(true);
  };

  const openCopyDialog = () => {
    if (!canAdd) {
      toast.error("您暂无添加转发规则的权限，请联系管理员开通");
      return;
    }
    const initialHostId = filterHost !== "all"
      ? filterHost
      : hosts?.[0]?.id ? String(hosts[0].id) : "";
    setCopySourceHostId(initialHostId);
    setCopyTargetHostIds([]);
    setCopyRuleIds([]);
    setCopyConflictStrategy("skip");
    setShowCopyDialog(true);
  };

  const openEdit = (rule: any) => {
    if (!isRuleSupported(rule)) return;
    setForm({
      hostId: rule.hostId,
      name: rule.name,
      routeMode: rule.forwardGroupId ? "group" : rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local",
      forwardType: rule.forwardType,
      protocol: rule.protocol,
      gostMode: "direct",
      gostRelayHost: "",
      gostRelayPort: 0,
      tunnelId: rule.tunnelId || null,
      forwardGroupId: rule.forwardGroupId || null,
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
    if (form.routeMode === "group") return null;
    if (!form.hostId || !hosts) return null;
    return hosts.find((h: any) => h.id === form.hostId) || null;
  }, [form.hostId, form.routeMode, hosts]);
  const selectedHostPortRangeText = useMemo(() => {
    if (!selectedHost) return null;
    const start = (selectedHost as any).portRangeStart;
    const end = (selectedHost as any).portRangeEnd;
    return start != null && end != null ? `${start}-${end}` : null;
  }, [selectedHost]);
  const portStatusHint = useMemo(() => {
    if (portStatus === "used") {
      return {
        type: "used" as const,
        text: portRangeError ? "超范围" : "不可用",
        title: portRangeError || "端口已被占用",
      };
    }
    if (portStatus === "available") {
      return {
        type: "available" as const,
        text: "可用",
        title: selectedHostPortRangeText ? `允许端口范围: ${selectedHostPortRangeText}` : "端口可用",
      };
    }
    return null;
  }, [portRangeError, portStatus, selectedHostPortRangeText]);
  const forwardProtocolSettings = useMemo(
    () => normalizeForwardProtocolSettings(systemSettings?.forwardProtocols),
    [systemSettings?.forwardProtocols]
  );
  const isProtocolEnabled = useCallback((key: ForwardProtocolKey | null | undefined) => {
    if (!key) return true;
    return forwardProtocolSettings[key] !== false;
  }, [forwardProtocolSettings]);
  const getTunnelProtocolKey = useCallback((tunnel: any | null | undefined): ForwardProtocolKey | null => {
    const mode = String(tunnel?.mode || "").toLowerCase();
    return (["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"] as const).includes(mode as any)
      ? mode as ForwardProtocolKey
      : null;
  }, []);
  const getRuleProtocolKey = useCallback((rule: any): ForwardProtocolKey | null => {
    if (rule.forwardType === "gost" && rule.tunnelId) {
      const tunnel = tunnels?.find((t: any) => Number(t.id) === Number(rule.tunnelId));
      return getTunnelProtocolKey(tunnel);
    }
    return rule.forwardType as ForwardProtocolKey;
  }, [getTunnelProtocolKey, tunnels]);
  const isRuleSupported = useCallback((rule: any) => isProtocolEnabled(getRuleProtocolKey(rule)), [getRuleProtocolKey, isProtocolEnabled]);
  const supportedTunnels = useMemo(
    () => (tunnels || []).filter((t: any) => isProtocolEnabled(getTunnelProtocolKey(t))),
    [getTunnelProtocolKey, isProtocolEnabled, tunnels]
  );
  const availableTunnels = useMemo(() => {
    if (form.routeMode === "tunnel") return supportedTunnels;
    if (!form.hostId) return [];
    return supportedTunnels.filter((t: any) => t.entryHostId === form.hostId);
  }, [form.hostId, form.routeMode, supportedTunnels]);
  const selectedTunnel = useMemo(() => {
    if (!form.tunnelId || !tunnels) return null;
    return tunnels.find((t: any) => t.id === form.tunnelId) || null;
  }, [form.tunnelId, tunnels]);
  const tunnelById = useMemo(() => {
    const map = new Map<number, any>();
    (tunnels || []).forEach((tunnel: any) => map.set(Number(tunnel.id), tunnel));
    return map;
  }, [tunnels]);
  const selectedTunnelDisplay = useMemo(() => getTunnelDisplay(selectedTunnel), [selectedTunnel]);
  const tunnelDisplayById = useMemo(() => {
    const map = new Map<number, ReturnType<typeof getTunnelDisplay>>();
    (tunnels || []).forEach((t: any) => map.set(Number(t.id), getTunnelDisplay(t)));
    return map;
  }, [tunnels]);
  const userById = useMemo(() => {
    const map = new Map<number, any>();
    (users || []).forEach((item: any) => map.set(Number(item.id), item));
    return map;
  }, [users]);
  const forwardGroupById = useMemo(() => {
    const map = new Map<number, any>();
    (forwardGroups || []).forEach((group: any) => map.set(Number(group.id), group));
    return map;
  }, [forwardGroups]);
  const availableForwardGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => group.isEnabled && (group.members || []).length > 0),
    [forwardGroups]
  );
  const selectedForwardGroup = useMemo(() => {
    if (!form.forwardGroupId) return null;
    return forwardGroupById.get(Number(form.forwardGroupId)) || null;
  }, [form.forwardGroupId, forwardGroupById]);
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
  const usableForwardTypes = useMemo(
    () => allowedForwardTypes.filter((t) => isProtocolEnabled(t)),
    [allowedForwardTypes, isProtocolEnabled]
  );
  const hasHostChoices = (hosts?.length || 0) > 0;
  const canUseLocalForward = hasHostChoices && usableForwardTypes.length > 0;
  const canUseGost = allowedForwardTypes.includes("gost") && supportedTunnels.length > 0;
  const canUseForwardGroup = availableForwardGroups.length > 0;
  const canCreateRule = canUseLocalForward || canUseGost || canUseForwardGroup;
  const copyableSourceRules = useMemo(() => {
    if (!rules || !copySourceHostId) return [];
    return rules.filter((rule: any) => Number(rule.hostId) === Number(copySourceHostId) && !(rule.forwardType === "gost" && rule.tunnelId));
  }, [copySourceHostId, rules]);
  const copyTargetHosts = useMemo(() => {
    if (!hosts) return [];
    return hosts.filter((host: any) => String(host.id) !== copySourceHostId);
  }, [copySourceHostId, hosts]);

  const checkPort = useCallback(async () => {
    const checkId = latestPortCheckRef.current + 1;
    latestPortCheckRef.current = checkId;
    const routeMode = form.routeMode;
    const hostId = form.hostId;
    const tunnelId = form.tunnelId;
    const sourcePort = form.sourcePort;
    if (form.routeMode === "group") {
      setPortStatus("idle");
      setPortRangeError(null);
      return;
    }
    if (!hostId || !sourcePort || sourcePort < 1) return;
    if (!isValidPort(sourcePort)) {
      setPortRangeError("端口必须在 1-65535 之间");
      setPortStatus("used");
      return;
    }
    // 先检查端口范围
    if (selectedHost) {
      const pStart = (selectedHost as any).portRangeStart;
      const pEnd = (selectedHost as any).portRangeEnd;
      if (pStart != null && pEnd != null && (sourcePort < pStart || sourcePort > pEnd)) {
        setPortRangeError(`端口必须在 ${pStart}-${pEnd} 区间内`);
        setPortStatus("used");
        return;
      }
    }
    setPortRangeError(null);
    setPortStatus("checking");
    try {
      const result = await utils.rules.checkPort.fetch({
        hostId,
        tunnelId: routeMode === "tunnel" ? tunnelId : null,
        sourcePort,
        excludeRuleId: editingId || undefined,
      });
      if (latestPortCheckRef.current !== checkId) return;
      setPortStatus(result.used ? "used" : "available");
    } catch {
      if (latestPortCheckRef.current !== checkId) return;
      setPortStatus("idle");
    }
  }, [form.hostId, form.routeMode, form.sourcePort, form.tunnelId, editingId, utils, selectedHost]);

  // 源端口变化时自动检测
  useEffect(() => {
    if (form.routeMode === "group") {
      setPortStatus("idle");
      return;
    }
    if (form.sourcePort > 0 && form.hostId) {
      const timer = setTimeout(checkPort, 500);
      return () => clearTimeout(timer);
    } else {
      setPortStatus("idle");
    }
  }, [form.sourcePort, form.hostId, form.routeMode, checkPort]);

  useEffect(() => {
    if (form.routeMode !== "local") return;
    if (usableForwardTypes.length === 0) return;
    if (!usableForwardTypes.includes(form.forwardType)) {
      setForm((prev) => ({ ...prev, forwardType: usableForwardTypes[0], tunnelId: null }));
    }
  }, [form.forwardType, form.routeMode, usableForwardTypes]);

  useEffect(() => {
    if (form.routeMode !== "group") return;
    if (!selectedForwardGroup && availableForwardGroups.length > 0) {
      setForm((prev) => ({ ...prev, forwardGroupId: Number(availableForwardGroups[0].id) }));
      return;
    }
    if (selectedForwardGroup?.groupType === "tunnel" && form.forwardType !== "gost") {
      setForm((prev) => ({ ...prev, forwardType: "gost" }));
    }
  }, [availableForwardGroups, form.forwardType, form.routeMode, selectedForwardGroup]);

  // 随机分配端口
  const handleRandomPort = async () => {
    if (form.routeMode === "group") {
      if (!form.forwardGroupId) {
        toast.error("请先选择转发组");
        return;
      }
    } else if (!form.hostId) {
      toast.error("请先选择主机");
      return;
    }
    try {
      const result = await utils.rules.randomPort.fetch(
        form.routeMode === "group"
          ? { forwardGroupId: form.forwardGroupId, excludeRuleId: editingId || undefined }
          : { hostId: form.hostId, tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null, excludeRuleId: editingId || undefined }
      );
      setForm({ ...form, sourcePort: result.port });
      setPortStatus("available");
      toast.success(`已分配随机端口: ${result.port}`);
    } catch (err: any) {
      toast.error(err.message || "无法获取随机端口");
    }
  };

  const toggleCopyRule = (ruleId: number, checked: boolean) => {
    setCopyRuleIds((prev) => checked ? Array.from(new Set([...prev, ruleId])) : prev.filter((id) => id !== ruleId));
  };

  const toggleCopyTargetHost = (hostId: number, checked: boolean) => {
    setCopyTargetHostIds((prev) => checked ? Array.from(new Set([...prev, hostId])) : prev.filter((id) => id !== hostId));
  };

  const handleCopyRules = () => {
    if (copyRuleIds.length === 0) {
      toast.error("请选择要复制的规则");
      return;
    }
    if (copyTargetHostIds.length === 0) {
      toast.error("请选择目标主机");
      return;
    }
    copyMutation.mutate({
      ruleIds: copyRuleIds,
      targetHostIds: copyTargetHostIds,
      conflictStrategy: copyConflictStrategy,
    });
  };

  const handleSubmit = () => {
    if (!form.name || !form.targetIp || !form.targetPort || (form.routeMode !== "group" && !form.hostId)) {
      toast.error("请填写所有必填字段（目标端口必须填写）");
      return;
    }
    if (form.routeMode === "group" && !form.forwardGroupId) {
      toast.error("请选择转发组");
      return;
    }
    if (form.routeMode === "group" && !canUseForwardGroup) {
      toast.error("暂无可用转发组");
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
    if (form.routeMode === "local" && !isProtocolEnabled(form.forwardType)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.routeMode === "tunnel" && !isProtocolEnabled(getTunnelProtocolKey(selectedTunnel))) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.routeMode === "group" && selectedForwardGroup?.groupType === "tunnel" && !isProtocolEnabled("gost")) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (!isValidPort(form.sourcePort, form.routeMode !== "group" && !editingId)) {
      toast.error(form.routeMode === "group" || editingId ? "入口端口必须在 1-65535 之间" : "入口端口必须为 0 或 1-65535，0 表示随机分配");
      return;
    }
    if (!isValidPort(form.targetPort)) {
      toast.error("目标端口必须在 1-65535 之间");
      return;
    }
    if (form.routeMode !== "group" && portStatus === "used") {
      toast.error("源端口已被占用，请更换端口或使用随机分配");
      return;
    }
    if (!editingId && form.routeMode !== "group" && form.sourcePort > 0 && portStatus !== "available") {
      toast.error("请等待端口可用后再保存");
      return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        hostId: form.routeMode === "group" ? undefined : form.hostId!,
        name: form.name,
        forwardType: form.routeMode === "tunnel" || selectedForwardGroup?.groupType === "tunnel" ? "gost" : form.forwardType,
        protocol: form.protocol,
        gostMode: "direct",
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: form.routeMode === "group" ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        isEnabled: portStatus === "available" ? true : undefined,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
      });
    } else {
      createMutation.mutate({
        hostId: form.routeMode === "group" ? undefined : form.hostId!,
        name: form.name,
        forwardType: form.routeMode === "tunnel" || selectedForwardGroup?.groupType === "tunnel" ? "gost" : form.forwardType,
        protocol: form.protocol,
        gostMode: "direct",
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: form.routeMode === "group" ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const filteredRules = useMemo(() => {
    const sourceRules = selectedScopeRules || rules;
    if (!sourceRules) return [];
    return sourceRules.filter((r: any) => {
      if (user?.role === "admin" && filterUser === "self" && Number(r.userId) !== Number(user.id)) {
        return false;
      }
      if (filterUser !== "all" && filterUser !== "self" && Number(r.userId) !== Number(filterUser)) {
        return false;
      }
      if (filterHost !== "all") {
        if (String(filterHost).startsWith("group:")) {
          if (Number(r.forwardGroupId || 0) !== Number(String(filterHost).slice(6))) return false;
        } else if (r.forwardGroupId || r.hostId !== parseInt(filterHost)) {
          return false;
        }
      }
      if (filterTunnel !== "all") {
        if (filterTunnel === "none") {
          if (r.tunnelId) return false;
        } else if (Number(r.tunnelId || 0) !== Number(filterTunnel)) {
          return false;
        }
      }
      if (filterType !== "all") {
        if (filterType === "forward-group") {
          if (!r.forwardGroupId) return false;
        } else if (r.forwardType !== filterType) return false;
      }
      return true;
    });
  }, [rules, selectedScopeRules, filterUser, filterHost, filterTunnel, filterType, user?.id, user?.role]);
  const hasActiveUserFilter = user?.role === "admin" && filterUser !== "self";
  const hasActiveRuleFilter = hasActiveUserFilter || filterHost !== "all" || filterTunnel !== "all" || filterType !== "all";
  const activeCount = useMemo(
    () => filteredRules.filter((r: any) => r.isEnabled && isRuleSupported(r)).length,
    [filteredRules, isRuleSupported]
  );
  const rulePagination = usePersistentPagination(filteredRules, {
    storageKey: "forwardx.rules.page",
    pageSize: 12,
    isReady: !isLoading && !!rules,
  });
  const pagedRules = rulePagination.items;
  const desktopRuleGroups = useMemo(() => {
    const groups = [
      { type: "local" as const, label: desktopRuleTypeLabels.local, rules: [] as any[] },
      { type: "tunnel" as const, label: desktopRuleTypeLabels.tunnel, rules: [] as any[] },
      { type: "group" as const, label: desktopRuleTypeLabels.group, rules: [] as any[] },
    ];
    const groupByType = new Map(groups.map((group) => [group.type, group]));
    pagedRules.forEach((rule: any) => {
      groupByType.get(getRuleDisplayType(rule))?.rules.push(rule);
    });
    return groups.filter((group) => group.rules.length > 0);
  }, [pagedRules]);

  const getHostName = (hostId: number) => {
    return hosts?.find((h: any) => h.id === hostId)?.name || `主机 #${hostId}`;
  };

  const getRuleEntryHost = (rule: any) => {
    const directHost = hosts?.find((h: any) => Number(h.id) === Number(rule.hostId));
    if (directHost) return directHost;
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    if (tunnel && Number(tunnel.entryHostId) === Number(rule.hostId)) {
      return tunnel.entryHost || null;
    }
    return null;
  };

  const getRuleEntryHostName = (rule: any) => {
    const entryHost = getRuleEntryHost(rule);
    return entryHost?.name || getHostName(Number(rule.hostId));
  };

  const getRuleOwnerName = (rule: any) => {
    const owner = userById.get(Number(rule.userId));
    return owner?.name || owner?.username || `用户 #${rule.userId}`;
  };

  /** 获取主机的入口地址：优先用用户自定义的 entryIp，未填则回退 ip */
  const getForwardGroupName = (groupId: number) => {
    return forwardGroupById.get(Number(groupId))?.name || `转发组 #${groupId}`;
  };

  const getHostEntry = (hostId: number): string => {
    const h: any = hosts?.find((x: any) => x.id === hostId);
    return getHostEntryAddress(h);
  };

  const getRuleEntry = (rule: any): string => {
    return getHostEntryAddress(getRuleEntryHost(rule));
  };

  /** 复制入口 IP:端口 到剪贴板 */
  const copyEntryAddress = async (rule: any) => {
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      const domain = String(group?.domain || "").trim();
      if (!domain) {
        toast.error("该转发组未配置 DDNS 域名");
        return;
      }
      const text = `${domain}:${rule.sourcePort}`;
      try {
        await navigator.clipboard.writeText(text);
        toast.success(`已复制入口地址: ${text}`);
      } catch {
        toast.error("复制失败，请手动复制");
      }
      return;
    }
    const entry = getRuleEntry(rule);
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

  const renderStatusDot = (rule: any) => {
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      if (group?.lastStatus === "healthy") {
        return <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
      }
      if (group?.lastStatus === "down" || group?.lastStatus === "error") {
        return <span className="h-2.5 w-2.5 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" />;
      }
    }
    if (rule.isEnabled && rule.isRunning) {
      return <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
    }
    if (rule.isEnabled) {
      return <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />;
    }
    return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />;
  };

  const renderTransfer = (rule: any, compact = false) => (
    <div className={`flex min-w-0 items-center gap-1.5 font-mono text-xs ${compact ? "flex-wrap" : ""}`}>
      <button
        type="button"
        onClick={() => copyEntryAddress(rule)}
        className={`group inline-flex min-w-0 items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 transition-colors hover:bg-muted/70 ${
          compact ? "max-w-full" : "max-w-[240px]"
        }`}
        title={rule.forwardGroupId ? `复制转发组入口: ${(forwardGroupById.get(Number(rule.forwardGroupId))?.domain || getForwardGroupName(rule.forwardGroupId))}:${rule.sourcePort}` : `复制入口地址: ${getRuleEntry(rule)}:${rule.sourcePort}`}
      >
        <code className="truncate">
          {rule.forwardGroupId
            ? (forwardGroupById.get(Number(rule.forwardGroupId))?.domain || getForwardGroupName(rule.forwardGroupId))
            : (getRuleEntry(rule) || getRuleEntryHostName(rule))}:{rule.sourcePort}
        </code>
        <Copy className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
      </button>
      <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      <code className={`truncate rounded bg-muted/40 px-1.5 py-0.5 ${compact ? "max-w-full" : "max-w-[180px]"}`}>
        {rule.targetIp}:{rule.targetPort}
      </code>
    </div>
  );

  const renderRouteBadge = (rule: any) => (
    <Badge
      variant="outline"
      className={`whitespace-nowrap text-[10px] ${
        rule.forwardGroupId
          ? "border-emerald-500/30 text-emerald-600"
          : rule.forwardType === "iptables" || rule.forwardType === "nftables"
          ? "border-primary/30 text-primary"
          : rule.forwardType === "socat"
          ? "border-chart-5/30 text-chart-5"
          : rule.forwardType === "gost"
          ? "border-chart-4/30 text-chart-4"
          : "border-chart-3/30 text-chart-3"
      }`}
    >
      {rule.forwardGroupId ? (
        <><Layers3 className="h-3 w-3 mr-1" />转发组</>
      ) : rule.forwardType === "gost" && rule.tunnelId ? (
        <><Network className="h-3 w-3 mr-1" />{tunnelDisplayById.get(Number(rule.tunnelId))?.badgeLabel || "隧道"}</>
      ) : rule.forwardType === "iptables" ? (
        <><Shield className="h-3 w-3 mr-1" />iptables</>
      ) : rule.forwardType === "nftables" ? (
        <><Shield className="h-3 w-3 mr-1" />nftables</>
      ) : rule.forwardType === "socat" ? (
        <><ArrowRightLeft className="h-3 w-3 mr-1" />socat</>
      ) : rule.forwardType === "gost" ? (
        <><Network className="h-3 w-3 mr-1" />gost</>
      ) : (
        <><Zap className="h-3 w-3 mr-1" />realm</>
      )}
    </Badge>
  );

  const renderUnsupportedHint = (children: ReactNode) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{unsupportedProtocolTitle}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  const renderRuleTraffic = (rule: any) => {
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
  };

  const renderRuleActions = (rule: any) => {
    const supported = isRuleSupported(rule);
    if (!supported) {
      return (
        <div className="flex items-center justify-end gap-1">
          {renderUnsupportedHint(
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => setDeleteRule(rule)}
                title={unsupportedProtocolTitle}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          )}
        </div>
      );
    }
    return (
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
          onClick={() => setDeleteRule(rule)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  };

  const handleViewModeChange = (nextViewMode: RuleViewMode) => {
    setViewMode(nextViewMode);
    storeRuleViewMode(nextViewMode);
  };

  const renderRuleCard = (rule: any) => {
    const supported = isRuleSupported(rule);
    const protocolKey = getRuleProtocolKey(rule);
    return (
      <Card
        key={rule.id}
        className={`border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`}
        title={!supported ? unsupportedProtocolTitle : undefined}
      >
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <div className="mt-2 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{rule.name}</div>
                {user?.role === "admin" && (
                  <div className="mt-1 text-xs text-muted-foreground">用户: {getRuleOwnerName(rule)}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}
                </div>
                {!supported && (
                  <div className="mt-1 text-[11px] text-destructive">
                    {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "该协议"} 当前不支持
                  </div>
                )}
                {rule.protocolBlockReason && (
                  <div className="mt-1 text-[11px] leading-4 text-destructive">
                    {rule.protocolBlockReason}
                  </div>
                )}
              </div>
            </div>
            {supported ? (
              <Switch
                checked={rule.isEnabled}
                onCheckedChange={(checked) => handleToggleRule(rule, checked)}
                className="scale-75"
              />
            ) : (
              renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
            )}
          </div>

          <div className="rounded-md bg-muted/25 p-2">
            {renderTransfer(rule, true)}
          </div>
          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div>
              <div className="mb-1 text-muted-foreground">链路</div>
              {renderRouteBadge(rule)}
            </div>
            <div>
              <div className="mb-1 text-muted-foreground">协议</div>
              <Badge variant="secondary" className="text-[10px] uppercase">{rule.protocol}</Badge>
            </div>
            <div className="sm:col-span-2">
              <div className="mb-1 text-muted-foreground">近 24h 流量</div>
              {renderRuleTraffic(rule)}
            </div>
          </div>
          <div className="flex justify-end border-t border-border/40 pt-2">
            {renderRuleActions(rule)}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">转发规则</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
            {user?.role === "admin" ? "管理端口、隧道和转发组规则" : "管理端口和隧道转发规则"}
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Zap className="h-3 w-3 text-chart-2" />
            {activeCount} / {filteredRules.length || rules?.length || 0} 活跃
          </Badge>
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
          <Button
            variant="outline"
            onClick={openCopyDialog}
            className="gap-2"
            disabled={!canAdd || !hosts || hosts.length < 2 || !rules || rules.length === 0}
            title={!canAdd ? "需要管理员授权后才能复制规则" : undefined}
          >
            <ClipboardCopy className="h-4 w-4" />
            复制规则
          </Button>
          {canAdd ? (
            <Button
              onClick={openCreate}
              className="col-span-2 gap-2 sm:col-span-1"
              disabled={!canCreateRule}
              title={!canCreateRule ? "暂无可用主机或隧道" : undefined}
            >
              <Plus className="h-4 w-4" />
              添加规则
            </Button>
          ) : (
            <Button disabled className="col-span-2 gap-2 sm:col-span-1" title="需要管理员授权后才能添加规则">
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

      {(user?.role === "admin" || (rules && rules.length > 0)) && (
        <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">筛选:</span>
          </div>
          {user?.role === "admin" && (
            <Select value={filterUser} onValueChange={setFilterUser}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[160px]">
                <SelectValue placeholder="我的规则" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">我的规则</SelectItem>
                <SelectItem value="all">所有用户</SelectItem>
                {(users || []).map((item: any) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.name || item.username}
                    {item.displayRemark ? ` · ${item.displayRemark}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={filterHost} onValueChange={setFilterHost}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-[160px]">
              <SelectValue placeholder="所有主机" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有主机</SelectItem>
              {hosts?.map((h: any) => (
                <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>
              ))}
              {canUseForwardGroup && forwardGroups && forwardGroups.length > 0 && (
                <>
                  {(forwardGroups || []).map((group: any) => (
                    <SelectItem key={`group-${group.id}`} value={`group:${group.id}`}>
                      转发组 / {group.name}
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-[140px]">
              <SelectValue placeholder="所有类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有类型</SelectItem>
              <SelectItem value="iptables">iptables</SelectItem>
              <SelectItem value="nftables">nftables</SelectItem>
              <SelectItem value="realm">realm</SelectItem>
              <SelectItem value="socat">socat</SelectItem>
              <SelectItem value="gost">gost</SelectItem>
              {canUseForwardGroup && <SelectItem value="forward-group">转发组</SelectItem>}
            </SelectContent>
          </Select>
          <Select value={filterTunnel} onValueChange={setFilterTunnel}>
            <SelectTrigger className="h-8 w-full text-xs sm:w-[160px]">
              <SelectValue placeholder="所有隧道" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有隧道</SelectItem>
              <SelectItem value="none">不使用隧道</SelectItem>
              {(tunnels || []).map((t: any) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {getTunnelDisplay(t).shortLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* 近 24 小时转发流量汇总 */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 入向</p>
              <p className="mt-0.5 truncate text-xs font-semibold sm:mt-1 sm:text-xl">{formatBytes(trafficTotals.bytesIn)}</p>
            </div>
            <ArrowDownToLine className="hidden h-4 w-4 shrink-0 text-chart-2 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 出向</p>
              <p className="mt-0.5 truncate text-xs font-semibold sm:mt-1 sm:text-xl">{formatBytes(trafficTotals.bytesOut)}</p>
            </div>
            <ArrowUpFromLine className="hidden h-4 w-4 shrink-0 text-chart-4 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 连接</p>
              <p className="mt-0.5 truncate text-xs font-semibold sm:mt-1 sm:text-xl">{trafficTotals.connections.toLocaleString()}</p>
            </div>
            <Activity className="hidden h-4 w-4 shrink-0 text-chart-3 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            <div className="space-y-3 p-6">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : filteredRules.length > 0 ? (
        <>
          {viewMode === "card" ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {pagedRules.map((rule: any) => renderRuleCard(rule))}
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:hidden">
                {pagedRules.map((rule: any) => renderRuleCard(rule))}
              </div>
              <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table className={user?.role === "admin" ? "min-w-[1100px] table-fixed" : "min-w-[980px] table-fixed"}>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[48px] text-center">状态</TableHead>
                          <TableHead className="w-[120px]">规则</TableHead>
                          {user?.role === "admin" && <TableHead className="w-[120px]">用户</TableHead>}
                          <TableHead className="w-[120px]">主机</TableHead>
                          <TableHead>转发配置</TableHead>
                          <TableHead className="w-[150px]">链路</TableHead>
                          <TableHead className="w-[86px]">协议</TableHead>
                          <TableHead className="w-[120px]">24h 流量</TableHead>
                          <TableHead className="w-[76px] text-center">开关</TableHead>
                          <TableHead className="w-[164px] text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {desktopRuleGroups.map((group) => (
                          <Fragment key={group.type}>
                            <TableRow className="border-border/40 bg-muted/35 hover:bg-muted/35">
                              <TableCell colSpan={user?.role === "admin" ? 10 : 9} className="py-2">
                                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                  {group.type === "group" ? (
                                    <Layers3 className="h-3.5 w-3.5" />
                                  ) : group.type === "tunnel" ? (
                                    <Network className="h-3.5 w-3.5" />
                                  ) : (
                                    <ArrowRightLeft className="h-3.5 w-3.5" />
                                  )}
                                  <span>{group.label}</span>
                                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{group.rules.length}</Badge>
                                </div>
                              </TableCell>
                            </TableRow>
                            {group.rules.map((rule: any) => {
                              const supported = isRuleSupported(rule);
                              const protocolKey = getRuleProtocolKey(rule);
                              return (
                                <TableRow key={rule.id} className={!supported ? "opacity-70" : ""} title={!supported ? unsupportedProtocolTitle : undefined}>
                                  <TableCell>
                                    <div className="flex items-center justify-center">
                                      {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <span className="block truncate font-medium" title={rule.name}>{rule.name}</span>
                                    {!supported && (
                                      <span className="mt-1 block text-[11px] text-destructive">
                                        {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "该协议"} 当前不支持
                                      </span>
                                    )}
                                    {rule.protocolBlockReason && (
                                      <span className="mt-1 block text-[11px] leading-4 text-destructive">
                                        {rule.protocolBlockReason}
                                      </span>
                                    )}
                                  </TableCell>
                                  {user?.role === "admin" && (
                                    <TableCell>
                                      <span className="block truncate text-sm text-muted-foreground" title={getRuleOwnerName(rule)}>
                                        {getRuleOwnerName(rule)}
                                      </span>
                                    </TableCell>
                                  )}
                                  <TableCell>
                                    <span className="block truncate text-sm text-muted-foreground" title={rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}>
                                      {rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}
                                    </span>
                                  </TableCell>
                                  <TableCell>{renderTransfer(rule)}</TableCell>
                                  <TableCell>{renderRouteBadge(rule)}</TableCell>
                                  <TableCell>
                                    <Badge variant="secondary" className="text-[10px] uppercase">{rule.protocol}</Badge>
                                  </TableCell>
                                  <TableCell>{renderRuleTraffic(rule)}</TableCell>
                                  <TableCell className="text-center">
                                    {supported ? (
                                      <Switch
                                        checked={rule.isEnabled}
                                        onCheckedChange={(checked) => handleToggleRule(rule, checked)}
                                        className="scale-75"
                                      />
                                    ) : (
                                      renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right">{renderRuleActions(rule)}</TableCell>
                                </TableRow>
                              );
                            })}
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
          <PersistentPagination pagination={rulePagination} itemName="条规则" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            {(rules && rules.length > 0) || hasActiveRuleFilter ? (
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
                  {canCreateRule
                    ? "创建转发规则开始端口转发"
                    : "请先获得可用主机或隧道授权，然后创建转发规则"}
                </p>
                {canAdd && canCreateRule && (
                  <Button onClick={openCreate} variant="outline" className="mt-4 gap-2">
                    <Plus className="h-4 w-4" />
                    创建第一条规则
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) resetForm();
          setShowDialog(open);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑规则" : "添加转发规则"}</DialogTitle>
            <DialogDescription>
              {editingId ? "修改规则配置" : "创建转发规则"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-muted/25 p-1">
              <div className={`grid gap-1 ${canUseForwardGroup ? "grid-cols-3" : "grid-cols-2"}`}>
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "local", !canUseLocalForward || (!!editingId && form.routeMode !== "local"))}
                  onClick={() => setRouteMode("local")}
                  disabled={!canUseLocalForward || (!!editingId && form.routeMode !== "local")}
                  title={!canUseLocalForward ? (hasHostChoices ? unsupportedProtocolTitle : "暂无可用主机") : undefined}
                >
                  <ArrowRightLeft className="h-4 w-4 shrink-0" />
                  <span className="truncate">端口转发</span>
                </button>
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "tunnel", !canUseGost || (!!editingId && form.routeMode !== "tunnel"))}
                  onClick={() => setRouteMode("tunnel")}
                  disabled={!canUseGost || (!!editingId && form.routeMode !== "tunnel")}
                  title={!canUseGost ? "暂无可用隧道" : undefined}
                >
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="truncate">隧道转发</span>
                </button>
                {canUseForwardGroup && (
                  <button
                    type="button"
                    className={routeModeOptionClass(form.routeMode === "group", !canUseForwardGroup || (!!editingId && form.routeMode !== "group"))}
                    onClick={() => setRouteMode("group")}
                    disabled={!canUseForwardGroup || (!!editingId && form.routeMode !== "group")}
                    title={!canUseForwardGroup ? "暂无可用转发组" : undefined}
                  >
                    <Layers3 className="h-4 w-4 shrink-0" />
                    <span className="truncate">转发组</span>
                  </button>
                )}
              </div>
              <div className="mt-2 rounded-md bg-background/55 px-3 py-2 text-xs leading-5 text-muted-foreground">
                {form.routeMode === "local" && "主机直接转发到目标地址。"}
                {form.routeMode === "tunnel" && "通过隧道出口连接目标地址。"}
                {form.routeMode === "group" && "使用转发组作为入口。"}
              </div>
            </div>

            {form.routeMode === "tunnel" && (
              <div className="space-y-3 rounded-lg border border-chart-4/20 bg-chart-4/5 p-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label>使用隧道</Label>
                    <Select
                      value={form.tunnelId ? String(form.tunnelId) : "none"}
                      disabled={availableTunnels.length === 0}
                      onValueChange={(v) => {
                        const nextTunnelId = v === "none" ? null : Number(v);
                        const tunnel = nextTunnelId ? tunnels?.find((t: any) => t.id === nextTunnelId) : null;
                        setForm({ ...form, tunnelId: nextTunnelId, hostId: tunnel ? tunnel.entryHostId : null });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择隧道</SelectItem>
                        {availableTunnels.map((t: any) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name} / {getHostName(t.entryHostId)} → {getHostName(t.exitHostId)} / {String(t.mode).toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="outline" className="h-9 justify-center gap-1.5 border-chart-4/30 px-3 text-chart-4">
                    <Network className="h-3.5 w-3.5" />
                    {selectedTunnelDisplay.shortLabel}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  主机由隧道入口自动决定。
                </p>
                {availableTunnels.length === 0 && (
                  <p className="text-xs text-amber-600">暂无可用隧道，请先在隧道管理中创建隧道。</p>
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
            )}

            {form.routeMode === "group" && (
              <div className="space-y-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label>使用转发组</Label>
                    <Select
                      value={form.forwardGroupId ? String(form.forwardGroupId) : "none"}
                      disabled={availableForwardGroups.length === 0}
                      onValueChange={(v) => {
                        const nextGroupId = v === "none" ? null : Number(v);
                        const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                        setForm({
                          ...form,
                          forwardGroupId: nextGroupId,
                          forwardType: group?.groupType === "tunnel" ? "gost" : form.forwardType,
                          hostId: null,
                          tunnelId: null,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择转发组</SelectItem>
                        {availableForwardGroups.map((group: any) => (
                          <SelectItem key={group.id} value={String(group.id)}>
                            {group.name} / {group.groupType === "tunnel" ? "隧道组" : "主机组"} / {group.members?.length || 0} 成员
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="outline" className="h-9 justify-center gap-1.5 border-emerald-500/30 px-3 text-emerald-600">
                    <Layers3 className="h-3.5 w-3.5" />
                    {selectedForwardGroup?.groupType === "tunnel" ? "隧道组" : "主机组"}
                  </Badge>
                </div>
                {selectedForwardGroup && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {(selectedForwardGroup.members || []).slice(0, 4).map((member: any, index: number) => (
                      <span key={member.id} className="rounded bg-background/60 px-1.5 py-0.5">
                        {index + 1}. {member.memberType === "host"
                          ? (member.hostId ? getHostName(member.hostId) : "主机成员")
                          : (member.tunnelId ? tunnelDisplayById.get(Number(member.tunnelId))?.shortLabel || `隧道 #${member.tunnelId}` : "隧道成员")}
                      </span>
                    ))}
                    {(selectedForwardGroup.members || []).length > 4 && <span>+{(selectedForwardGroup.members || []).length - 4}</span>}
                  </div>
                )}
              </div>
            )}

            <div className={`grid grid-cols-1 gap-4 ${form.routeMode === "local" ? "sm:grid-cols-2" : ""}`}>
              <div className="space-y-2">
                <Label>规则名称</Label>
                <Input
                  placeholder="例如: Web 服务转发"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              {form.routeMode === "local" && (
                <div className="space-y-2">
                  <Label>所属主机</Label>
                  <Select
                    value={form.hostId ? String(form.hostId) : ""}
                    onValueChange={(v) => {
                      latestPortCheckRef.current += 1;
                      setPortStatus("idle");
                      setPortRangeError(null);
                      setForm({ ...form, hostId: parseInt(v), tunnelId: null });
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="选择主机" /></SelectTrigger>
                    <SelectContent>
                      {hosts?.map((h: any) => (
                        <SelectItem key={h.id} value={String(h.id)}>{h.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className={`grid grid-cols-1 gap-4 ${form.routeMode === "local" || (form.routeMode === "group" && selectedForwardGroup?.groupType === "host") ? "sm:grid-cols-2" : ""}`}>
              {(form.routeMode === "local" || (form.routeMode === "group" && selectedForwardGroup?.groupType === "host")) && (
                <div className="space-y-2">
                  <Label>转发工具</Label>
                  <Select
                    value={form.forwardType}
                    onValueChange={(v) => setForm({ ...form, forwardType: v as any, gostMode: "direct", gostRelayHost: "", gostRelayPort: 0, tunnelId: null })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {usableForwardTypes.map((t) => (
                        <SelectItem key={t} value={t}>{FORWARD_TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
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
            </div>
            <div className="space-y-2">
              <Label>{form.routeMode === "local" ? "源端口" : "入口端口"}</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    type="text"
                    pattern="[0-9]*"
                    placeholder={form.routeMode === "group" ? "例如 8080" : "0=随机"}
                    value={form.sourcePort || ""}
                    inputMode="numeric"
                    onChange={(e) => {
                      latestPortCheckRef.current += 1;
                      setPortRangeError(null);
                      setPortStatus("idle");
                      setForm({ ...form, sourcePort: parseInt(e.target.value) || 0 });
                    }}
                    className={`pr-24 ${
                      portStatus === "used" ? "border-destructive" :
                      portStatus === "available" ? "border-emerald-500" : ""
                    }`}
                  />
                  {portStatus === "used" && (
                    <div className="absolute right-2.5 top-1/2 inline-flex max-w-[5.5rem] -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-destructive" title={portStatusHint?.title}>
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{portStatusHint?.text || "不可用"}</span>
                    </div>
                  )}
                  {portStatus === "available" && (
                    <div className="absolute right-2.5 top-1/2 inline-flex max-w-[5.5rem] -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-emerald-600" title={portStatusHint?.title}>
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{portStatusHint?.text || "可用"}</span>
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 gap-2 whitespace-nowrap px-3"
                  onClick={handleRandomPort}
                  title="随机分配端口"
                  disabled={form.routeMode === "group" ? !form.forwardGroupId : !form.hostId}
                >
                  <Shuffle className="h-4 w-4" />
                  随机端口
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{form.routeMode === "local" ? "目标地址" : "最终目标地址"}</Label>
                <Input
                  placeholder="例如: 10.0.0.1 或 example.com"
                  value={form.targetIp}
                  onChange={(e) => setForm({ ...form, targetIp: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{form.routeMode === "local" ? "目标端口" : "最终目标端口"} <span className="text-destructive">*</span></Label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
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
              disabled={isPending || !form.name || (form.routeMode !== "group" && !form.hostId) || !form.targetIp || !form.targetPort || (form.routeMode !== "group" && portStatus === "used") || (form.routeMode === "local" && !canUseLocalForward) || (form.routeMode === "tunnel" && !form.tunnelId) || (form.routeMode === "group" && !form.forwardGroupId)}
            >
              {isPending ? "处理中..." : editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCopyDialog} onOpenChange={setShowCopyDialog}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>复制转发规则</DialogTitle>
            <DialogDescription>复制已有端口转发规则。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>源主机</Label>
                <Select
                  value={copySourceHostId}
                  onValueChange={(value) => {
                    setCopySourceHostId(value);
                    setCopyRuleIds([]);
                    setCopyTargetHostIds((prev) => prev.filter((id) => String(id) !== value));
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="选择源主机" /></SelectTrigger>
                  <SelectContent>
                    {hosts?.map((host: any) => (
                      <SelectItem key={host.id} value={String(host.id)}>{host.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>端口冲突处理</Label>
                <Select value={copyConflictStrategy} onValueChange={(value) => setCopyConflictStrategy(value as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">跳过冲突规则</SelectItem>
                    <SelectItem value="auto">自动分配新端口</SelectItem>
                    <SelectItem value="error">遇到冲突时报错</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>选择规则</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setCopyRuleIds(copyableSourceRules.map((rule: any) => Number(rule.id)))}
                    disabled={copyableSourceRules.length === 0}
                  >
                    全选
                  </Button>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                  {copyableSourceRules.length > 0 ? copyableSourceRules.map((rule: any) => (
                    <label key={rule.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border/40 bg-background/60 p-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={copyRuleIds.includes(Number(rule.id))}
                        onChange={(e) => toggleCopyRule(Number(rule.id), e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{rule.name}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          :{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort} / {rule.forwardType} / {rule.protocol}
                        </span>
                      </span>
                    </label>
                  )) : (
                    <div className="py-10 text-center text-sm text-muted-foreground">该主机没有可复制的端口转发规则</div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>目标主机</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setCopyTargetHostIds(copyTargetHosts.map((host: any) => Number(host.id)))}
                    disabled={copyTargetHosts.length === 0}
                  >
                    全选
                  </Button>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border/60 p-2">
                  {copyTargetHosts.length > 0 ? copyTargetHosts.map((host: any) => (
                    <label key={host.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border/40 bg-background/60 p-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={copyTargetHostIds.includes(Number(host.id))}
                        onChange={(e) => toggleCopyTargetHost(Number(host.id), e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{host.name}</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">{host.entryIp || host.ip || "-"}</span>
                      </span>
                    </label>
                  )) : (
                    <div className="py-10 text-center text-sm text-muted-foreground">没有可选目标主机</div>
                  )}
                </div>
              </div>
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              仅复制规则配置，不复制状态和统计。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCopyDialog(false)}>取消</Button>
            <Button onClick={handleCopyRules} disabled={copyMutation.isPending || copyRuleIds.length === 0 || copyTargetHostIds.length === 0}>
              {copyMutation.isPending ? "复制中..." : "开始复制"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteRule} onOpenChange={(open) => !open && setDeleteRule(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除转发规则</DialogTitle>
            <DialogDescription>
              确认删除 "{deleteRule?.name}"？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRule(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={!deleteRule || deleteMutation.isPending}
              onClick={() => {
                if (!deleteRule) return;
                deleteMutation.mutate({ id: deleteRule.id });
                setDeleteRule(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
  const { data: latest } = trpc.rules.latestTest.useQuery(
    { ruleId },
    {
      enabled: open,
      refetchInterval: open ? 1500 : false,
      refetchOnWindowFocus: false,
    }
  );
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [activeTestId, setActiveTestId] = useState<number | null>(null);
  const startMutation = trpc.rules.startSelfTest.useMutation({
    onSuccess: (data) => {
      const nextTestId = Number(data?.id) || 0;
      if (nextTestId > 0) {
        setActiveTestId(nextTestId);
      } else {
        setOptimisticTesting(false);
        setActiveTestId(null);
      }
      utils.rules.latestTest.invalidate({ ruleId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setActiveTestId(null);
      toast.error(e?.message || "下发失败");
    },
  });

  const status = latest?.status as string | undefined;
  const isServerTesting = status === "pending" || status === "running";
  const isTerminalStatus = !!status && !isServerTesting;
  const latestTestId = Number((latest as any)?.id) || 0;
  useEffect(() => {
    if (!open) {
      setOptimisticTesting(false);
      setActiveTestId(null);
    }
  }, [open]);
  useEffect(() => {
    if (!optimisticTesting || !activeTestId || !isTerminalStatus) return;
    if (latestTestId >= activeTestId) {
      setOptimisticTesting(false);
      setActiveTestId(null);
    }
  }, [activeTestId, isTerminalStatus, latestTestId, optimisticTesting]);
  useEffect(() => {
    if (!startMutation.isError) return;
    setOptimisticTesting(false);
    setActiveTestId(null);
  }, [startMutation.isError]);
  const isTesting = startMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isTimeout = status === "timeout";
  const isFailed = !!latest && !isTesting && !isSuccess && !isTimeout;
  const lastFailureToastKey = useRef("");
  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = typeof latest?.message === "string" ? latest.message.trim() : "";
    if (!isTesting && latest && !isSuccess && message) {
      const key = `${ruleId}:${status}:${latest?.updatedAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        toast.error(isTimeout ? "转发链路自测超时" : "转发链路自测失败", {
          description: message,
          duration: 12000,
        });
      }
    }
  }, [open, isTesting, isSuccess, isTimeout, latest, latest?.message, latest?.updatedAt, ruleId, status]);
  const statusView = (() => {
    if (isTesting) {
      return (
        <span className="flex items-center gap-2 text-amber-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在测试中
        </span>
      );
    }
    if (!latest) return <span className="text-muted-foreground">尚未运行</span>;
    if (isSuccess) {
      return (
        <span className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          正常
        </span>
      );
    }
    if (isTimeout) {
      return (
        <span className="flex items-center gap-2 text-amber-600">
          <AlertCircle className="h-4 w-4" />
          超时
        </span>
      );
    }
    return (
      <span className="flex items-center gap-2 text-destructive">
        <XCircle className="h-4 w-4" />
        异常
      </span>
    );
  })();
  const reachableView = (() => {
    if (isTesting) return <Loader2 className="h-4 w-4 animate-spin text-amber-600" />;
    if (latest?.targetReachable) return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (latest || isFailed || isTimeout) return <XCircle className="h-4 w-4 text-destructive" />;
    return <span className="text-muted-foreground">--</span>;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>转发链路自测 - {ruleName}</DialogTitle>
          <DialogDescription>检测目标端口连通性。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">状态</span>
            <span className="text-sm font-medium">{statusView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">端口可达</span>
            <span className="text-sm font-medium">{reachableView}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <span className="text-sm text-muted-foreground">TCP 延迟</span>
            <span className="text-sm font-semibold tabular-nums">
              {isTesting ? "正在测试中" : typeof latest?.latencyMs === "number" && latest.latencyMs > 0 ? `${latest.latencyMs} ms` : "--"}
            </span>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            className="min-w-[112px] gap-2"
            disabled={isTesting}
            onClick={() => {
              setOptimisticTesting(true);
              setActiveTestId(null);
              startMutation.mutate({ ruleId });
            }}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
            </span>
            {isTesting ? "测试中..." : "运行测试"}
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

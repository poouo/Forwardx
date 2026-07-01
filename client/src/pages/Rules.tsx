import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import { LatencyRating } from "@/components/LatencyRating";
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
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
  ChevronRight,
  XCircle,
  Loader2,
  Shuffle,
  AlertCircle,
  Copy,
  Download,
  Upload,
  Search,
  Network,
  ClipboardCopy,
  Layers3,
  LayoutGrid,
  List,
  Rows3,
  GitBranch,
  Globe,
  RotateCcw,
} from "lucide-react";
import type { GlobeMethods } from "react-globe.gl";
import {
  FORWARD_TYPES,
  FORWARD_TYPE_LABELS,
  FORWARD_PROTOCOL_LABELS,
  formatForwardRuleProtocol,
  normalizeForwardProtocolSettings,
  type ForwardType,
  type ForwardProtocolKey,
} from "@shared/forwardTypes";
import { ruleLatencyProbeMethodForRule } from "@shared/latencyProbe";
import { Fragment, lazy, Suspense, useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { TcpingDetailDialog } from "@/components/rules/TcpingDetailDialog";
import { countryFeatureHasCode, normalizeCountryCode, type CountryFeatureLike } from "@/lib/countryFeatures";
import {
  addHostNodeMeta,
  addNodeMetaAliases,
  findHostByAddress,
  hostDisplayName,
  hostNodeMeta,
  targetGeoNodeMeta,
} from "@/lib/linkTestNodeMeta";
import { getTunnelHopIds, getTunnelRouteText, tunnelHopHostName } from "@/lib/tunnelDisplay";
import { useUrlTab } from "@/hooks/useUrlTab";
import { useIsMobile } from "@/hooks/useMobile";

const loadReactGlobe = () => import("react-globe.gl");
const ReactGlobe = lazy(loadReactGlobe) as typeof import("react-globe.gl").default;

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

function clearRuleTrafficStatCaches() {
  if (typeof window === "undefined") return;
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("forwardx.stat.rules.traffic."))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Local UI cache only; ignore storage failures.
  }
}

type PortPolicy = {
  rangeStart: number | null;
  rangeEnd: number | null;
  allowlist: number[];
  denyAll?: boolean;
};

function parsePortAllowlist(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return [];
  return Array.from(new Set(text
    .split(",")
    .map((item) => Number(String(item).trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)))
    .sort((a, b) => a - b);
}

function portPolicyFrom(source: any): PortPolicy {
  const start = source?.portRangeStart != null ? Number(source.portRangeStart) : null;
  const end = source?.portRangeEnd != null ? Number(source.portRangeEnd) : null;
  const hasRange = start != null && end != null && start >= 1 && end <= 65535 && start <= end;
  return {
    rangeStart: hasRange ? start : null,
    rangeEnd: hasRange ? end : null,
    allowlist: parsePortAllowlist(source?.portAllowlist),
  };
}

function hasPortRestriction(policy: PortPolicy) {
  return !!policy.denyAll || (policy.rangeStart !== null && policy.rangeEnd !== null) || policy.allowlist.length > 0;
}

function isPortAllowedByPolicy(port: number, policy: PortPolicy) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (policy.denyAll) return false;
  if (!hasPortRestriction(policy)) return true;
  const inRange = policy.rangeStart !== null && policy.rangeEnd !== null && port >= policy.rangeStart && port <= policy.rangeEnd;
  return inRange || policy.allowlist.includes(port);
}

function describePortPolicy(policy: PortPolicy) {
  if (policy.denyAll) return "无可用端口";
  const parts: string[] = [];
  if (policy.rangeStart !== null && policy.rangeEnd !== null) parts.push(`${policy.rangeStart}-${policy.rangeEnd}`);
  if (policy.allowlist.length > 0) parts.push(policy.allowlist.join(","));
  return parts.length > 0 ? parts.join(" + ") : "1-65535";
}

function combinePortPolicies(...policies: PortPolicy[]): PortPolicy {
  const restricted = policies.filter(hasPortRestriction);
  if (restricted.length === 0) return portPolicyFrom(null);
  const allowed: number[] = [];
  for (let port = 1; port <= 65535; port++) {
    if (restricted.every((policy) => isPortAllowedByPolicy(port, policy))) allowed.push(port);
  }
  if (allowed.length === 0) return { rangeStart: null, rangeEnd: null, allowlist: [], denyAll: true };
  const ranges: Array<{ start: number; end: number }> = [];
  let start = allowed[0];
  let previous = allowed[0];
  for (let i = 1; i <= allowed.length; i++) {
    const current = allowed[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push({ start, end: previous });
    start = current;
    previous = current;
  }
  const best = ranges.reduce((acc, range) => (range.end - range.start > acc.end - acc.start ? range : acc), ranges[0]);
  const useRange = best.end > best.start;
  return {
    rangeStart: useRange ? best.start : null,
    rangeEnd: useRange ? best.end : null,
    allowlist: allowed.filter((port) => !useRange || port < best.start || port > best.end),
  };
}

type RuleProtocol = "tcp" | "udp" | "both";
type RuleRouteMode = "local" | "tunnel" | "chain" | "group";

function isForwardGroupRouteModeValue(mode: RuleRouteMode) {
  return mode === "chain" || mode === "group";
}

type RuleFormData = {
  hostId: number | null;
  name: string;
  routeMode: RuleRouteMode;
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
  telegramErrorNotifyEnabled: boolean;
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: ProxyProtocolVersion;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  udpOverTcp: boolean;
  udpOverTcpPort: number;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargetsText: string;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

type ProxyProtocolVersion = 1 | 2;

type ProxyProtocolField =
  | "proxyProtocolReceive"
  | "proxyProtocolSend"
  | "proxyProtocolExitReceive"
  | "proxyProtocolExitSend";

type FailoverStrategy = "fallback" | "round_robin" | "random" | "ip_hash";
type FailoverMode = "disabled" | FailoverStrategy;

const failoverModeOptions: Array<{ value: FailoverMode; label: string }> = [
  { value: "disabled", label: "不使用" },
  { value: "fallback", label: "主备模式 - 自上而下" },
  { value: "round_robin", label: "轮询模式 - 依次轮换" },
  { value: "random", label: "随机模式 - 随机选择" },
  { value: "ip_hash", label: "哈希模式 - IP哈希" },
];
const failoverStrategyLabels: Record<FailoverStrategy, string> = {
  fallback: "主备",
  round_robin: "轮询",
  random: "随机",
  ip_hash: "IP哈希",
};
const normalizeFailoverStrategy = (value: unknown): FailoverStrategy => {
  return value === "round_robin" || value === "random" || value === "ip_hash" || value === "fallback"
    ? value
    : "fallback";
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
  telegramErrorNotifyEnabled: false,
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
  proxyProtocolReceive: false,
  proxyProtocolSend: false,
  proxyProtocolExitReceive: false,
  proxyProtocolExitSend: false,
  proxyProtocolVersion: 1,
  tcpFastOpen: false,
  zeroCopy: false,
  udpOverTcp: false,
  udpOverTcpPort: 0,
  failoverEnabled: false,
  failoverStrategy: "fallback",
  failoverTargetsText: "",
  failoverSeconds: 60,
  recoverSeconds: 120,
  autoFailback: true,
};

const gostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);
const nginxTunnelModes = new Set(["nginx_stream", "nginx_tls"]);
const unsupportedProtocolTitle = "当前不支持，请联系管理员";
const desktopRuleTypeLabels = {
  local: "端口转发",
  tunnel: "隧道转发",
  chain: "转发链",
  group: "转发组",
} as const;
const ruleTypeDescriptions = {
  local: "主机端口直接转发",
  tunnel: "通过隧道出口转发",
  chain: "按转发链顺序转发",
  group: "使用转发组入口",
} as const;

type RuleViewMode = "card" | "table" | "globe";
type RuleCardSize = "standard" | "compact";
type RuleDisplayMode = RuleCardSize | "table" | "globe";
type RulePageSize = 12 | 24 | 36 | 48;
type RuleGroupType = keyof typeof desktopRuleTypeLabels;
type RuleGroupCollapsedState = Partial<Record<RuleGroupType, boolean>>;
type RuleCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleTransferScopeType = Exclude<RuleCategory, "all">;

const RULE_CATEGORIES = ["all", "local", "tunnel", "chain", "group"] as const;
const RULE_TRANSFER_FILE_KIND = "forwardx.forward-rules";
const RULE_TRANSFER_FILE_VERSION = 1;
const RULE_TRANSFER_MAX_IMPORT_COUNT = 500;

const ruleTransferScopeLabels: Record<RuleTransferScopeType, string> = {
  local: "主机",
  tunnel: "隧道",
  chain: "转发链",
  group: "转发组",
};

const ruleTransferScopeOptions: Array<{ value: RuleTransferScopeType; label: string }> = [
  { value: "local", label: "主机" },
  { value: "tunnel", label: "隧道" },
  { value: "chain", label: "转发链" },
  { value: "group", label: "转发组" },
];

type RuleTransferFileRule = {
  name: string;
  forwardType: ForwardType;
  protocol: RuleProtocol;
  sourcePort: number;
  targetIp: string;
  targetPort: number;
  telegramErrorNotifyEnabled?: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: ProxyProtocolVersion;
  tcpFastOpen: boolean;
  zeroCopy: boolean;
  udpOverTcp: boolean;
  udpOverTcpPort: number;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargets: Array<{ targetIp: string; targetPort: number }>;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

type RuleTransferFile = {
  kind?: string;
  version?: number;
  exportedAt?: string;
  scope?: {
    type?: string;
    id?: number;
    name?: string;
  };
  rules?: unknown[];
};

const RULE_VIEW_MODE_STORAGE_KEY = "forwardx.rules.viewMode";
const RULE_CARD_SIZE_STORAGE_KEY = "forwardx.rules.cardSize";
const RULE_PAGE_SIZE_STORAGE_KEY = "forwardx.rules.pageSize";
const RULE_GROUP_COLLAPSED_STORAGE_KEY = "forwardx.rules.groupCollapsed";
const RULE_CATEGORY_STORAGE_KEY = "forwardx.rules.category";
const RULE_FILTER_USER_STORAGE_KEY = "forwardx.rules.filterUser";
const RULE_FILTER_HOST_STORAGE_KEY = "forwardx.rules.filterHost";
const RULE_PAGE_SIZE_OPTIONS: RulePageSize[] = [12, 24, 36, 48];
const RULE_GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";
const RULE_GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";
const RULE_GLOBE_PATH_SURFACE_ALTITUDE = 0.028;
const RULE_GLOBE_PATH_MIN_ALTITUDE = 0.04;
const RULE_GLOBE_PATH_MAX_ALTITUDE = 0.11;
const RULE_GLOBE_PATH_LAYER_ALTITUDE_STEP = 0.006;
const RULE_GLOBE_PATH_LAYER_ALTITUDE_MAX = 0.018;
const RULE_GLOBE_TARGET_OFFSET_DEGREES = 5.8;
const RULE_GLOBE_COLORS = ["#38bdf8", "#4ade80", "#f59e0b", "#a78bfa", "#fb7185", "#2dd4bf", "#f97316", "#84cc16", "#60a5fa", "#f472b6"];
let reactGlobePrefetchStarted = false;

function getStoredRuleViewMode(): RuleViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(RULE_VIEW_MODE_STORAGE_KEY);
    return value === "table" || value === "globe" ? value : "card";
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

function getDefaultRuleCardSize(): RuleCardSize {
  return "standard";
}

function getStoredRuleCardSize(): RuleCardSize {
  const fallback = getDefaultRuleCardSize();
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(RULE_CARD_SIZE_STORAGE_KEY);
    return value === "compact" || value === "standard" ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeRuleCardSize(cardSize: RuleCardSize) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_CARD_SIZE_STORAGE_KEY, cardSize);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredRulePageSize(fallback: RulePageSize = 12): RulePageSize {
  if (typeof window === "undefined") return fallback;
  try {
    const value = Number(window.localStorage.getItem(RULE_PAGE_SIZE_STORAGE_KEY)) as RulePageSize;
    return RULE_PAGE_SIZE_OPTIONS.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeRulePageSize(pageSize: RulePageSize) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredRuleGroupCollapsed(): RuleGroupCollapsedState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RULE_GROUP_COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const next: RuleGroupCollapsedState = {};
    (["local", "tunnel", "chain", "group"] as RuleGroupType[]).forEach((type) => {
      if (typeof parsed[type] === "boolean") next[type] = parsed[type];
    });
    return next;
  } catch {
    return {};
  }
}

function storeRuleGroupCollapsed(state: RuleGroupCollapsedState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RULE_GROUP_COLLAPSED_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getStoredString(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value || fallback;
  } catch {
    return fallback;
  }
}

function storeString(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so the page still works in restricted browsers.
  }
}

function getRuleForwardGroupKind(rule: any, forwardGroupById: Map<number, any>): "chain" | "group" | null {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (!groupId) return null;
  const group = forwardGroupById.get(groupId);
  return isForwardChainGroup(group) ? "chain" : "group";
}

function getRuleCategory(rule: any, forwardGroupById: Map<number, any>): Exclude<RuleCategory, "all"> {
  const groupKind = getRuleForwardGroupKind(rule, forwardGroupById);
  if (groupKind) return groupKind;
  return rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local";
}

function getRuleDisplayType(rule: any, forwardGroupById: Map<number, any>): RuleGroupType {
  return getRuleCategory(rule, forwardGroupById);
}

type RuleFilterState = {
  filterUser: string;
  filterHost: string;
  ruleCategory: RuleCategory;
  searchQuery: string;
  isAdmin: boolean;
  userId?: number | null;
  hostById: Map<number, any>;
  tunnelById: Map<number, any>;
  userById: Map<number, any>;
  forwardGroupById: Map<number, any>;
  getRuleEntryHostId: (rule: any) => number;
};

function RuleGroupItems({
  open,
  className,
  children,
  layout,
}: {
  open: boolean;
  className: string;
  children: ReactNode;
  layout?: boolean;
}) {
  return (
    <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <AutoAnimateContainer layout={layout} className={`min-h-0 overflow-hidden ${className}`}>
        {children}
      </AutoAnimateContainer>
    </div>
  );
}

function RuleContentTransition({
  transitionKey,
  className,
  children,
}: {
  transitionKey: string;
  className?: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey}
        className={className}
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

function RuleCardModeTransition({
  mode,
  className,
  children,
}: {
  mode: RuleCardSize;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const element = ref.current;
    if (!element || reduceMotion || typeof element.animate !== "function") return;

    const animation = element.animate(
      [
        { opacity: 0.9, transform: "translate3d(0, 4px, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 140, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, [mode, reduceMotion]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

function addRuleSearchPart(parts: string[], value: unknown) {
  const text = String(value ?? "").trim();
  if (text) parts.push(text);
}

function addRuleSearchPort(parts: string[], port: unknown, label: string) {
  const text = String(port ?? "").trim();
  if (!text || text === "0") return;
  addRuleSearchPart(parts, text);
  addRuleSearchPart(parts, `${label}${text}`);
  addRuleSearchPart(parts, `:${text}`);
}

function addRuleSearchHostParts(parts: string[], host: any | null | undefined, port?: number | string) {
  if (!host) return;
  addRuleSearchPart(parts, host.name);
  addRuleSearchPart(parts, host.displayRemark);
  addRuleSearchPart(parts, host.remark);
  addRuleSearchPart(parts, host.description);
  addRuleSearchPart(parts, host.hostname);
  addRuleSearchPart(parts, host.ip);
  addRuleSearchPart(parts, host.ipv4);
  addRuleSearchPart(parts, host.ipv6);
  addRuleSearchPart(parts, host.entryIp);
  addRuleSearchPart(parts, host.tunnelEntryIp);
  addRuleSearchPart(parts, host.ddnsDomain);
  addRuleSearchPart(parts, host.geoCountryName);
  addRuleSearchPart(parts, host.geoRegion);
  getHostEntryAddresses(host).forEach((entry) => {
    addRuleSearchPart(parts, entry.label);
    addRuleSearchPart(parts, entry.value);
    if (port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(entry.value, port));
  });
}

function addRuleSearchUserParts(parts: string[], owner: any | null | undefined) {
  if (!owner) return;
  addRuleSearchPart(parts, owner.name);
  addRuleSearchPart(parts, owner.username);
  addRuleSearchPart(parts, owner.displayRemark);
  addRuleSearchPart(parts, owner.email);
  addRuleSearchPart(parts, owner.id ? `用户 #${owner.id}` : "");
}

function addRuleSearchTunnelParts(parts: string[], tunnel: any | null | undefined, filters: RuleFilterState) {
  if (!tunnel) return;
  addRuleSearchPart(parts, tunnel.name);
  addRuleSearchPart(parts, tunnel.mode);
  addRuleSearchPart(parts, tunnel.id ? `隧道 #${tunnel.id}` : "");
  try {
    addRuleSearchPart(parts, getTunnelRouteText(tunnel, Array.from(filters.hostById.values())));
  } catch {
    // Ignore route text failures; individual hop names are still indexed below.
  }
  getTunnelHopIds(tunnel).forEach((hostId: number) => {
    addRuleSearchHostParts(parts, filters.hostById.get(Number(hostId)), undefined);
  });
}

function addRuleSearchForwardGroupParts(parts: string[], group: any | null | undefined, filters: RuleFilterState, port?: number | string) {
  if (!group) return;
  addRuleSearchPart(parts, group.name);
  addRuleSearchPart(parts, group.domain);
  addRuleSearchPart(parts, group.remark);
  addRuleSearchPart(parts, group.displayRemark);
  addRuleSearchPart(parts, group.description);
  addRuleSearchPart(parts, group.id ? `${getForwardGroupKindLabel(group)} #${group.id}` : "");
  addRuleSearchPart(parts, getForwardGroupKindLabel(group));
  addRuleSearchPart(parts, desktopRuleTypeLabels[getRuleForwardGroupKind({ forwardGroupId: group.id }, filters.forwardGroupById) || "group"]);
  if (group.domain && port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(group.domain, port));

  const entryGroup = isForwardChainGroup(group) && Number(group.entryGroupId || 0) > 0
    ? filters.forwardGroupById.get(Number(group.entryGroupId))
    : null;
  if (entryGroup) addRuleSearchForwardGroupParts(parts, entryGroup, filters, port);

  (group.members || []).forEach((member: any) => {
    addRuleSearchPart(parts, member.entryAddress);
    addRuleSearchPart(parts, member.connectHost);
    if (member.entryAddress && port !== undefined) addRuleSearchPart(parts, formatAddressWithPort(member.entryAddress, port));
    if (Number(member.hostId || 0) > 0) addRuleSearchHostParts(parts, filters.hostById.get(Number(member.hostId)), port);
    if (Number(member.tunnelId || 0) > 0) addRuleSearchTunnelParts(parts, filters.tunnelById.get(Number(member.tunnelId)), filters);
  });
}

function buildRuleSearchText(rule: any, filters: RuleFilterState) {
  const parts: string[] = [];
  const sourcePort = Number(rule?.sourcePort || 0);
  const targetPort = Number(rule?.targetPort || 0);
  const targetIp = String(rule?.targetIp || "").trim();
  const category = getRuleCategory(rule, filters.forwardGroupById);
  const group = rule?.forwardGroupId ? filters.forwardGroupById.get(Number(rule.forwardGroupId)) : null;
  const tunnel = rule?.tunnelId ? filters.tunnelById.get(Number(rule.tunnelId)) : null;
  const entryHostId = filters.getRuleEntryHostId(rule);

  addRuleSearchPart(parts, rule?.name);
  addRuleSearchPart(parts, rule?.id ? `规则 #${rule.id}` : "");
  addRuleSearchPart(parts, desktopRuleTypeLabels[category]);
  addRuleSearchPart(parts, ruleTypeDescriptions[category]);
  addRuleSearchPart(parts, rule?.forwardType);
  addRuleSearchPart(parts, FORWARD_TYPE_LABELS[rule?.forwardType as ForwardType]);
  addRuleSearchPart(parts, formatForwardRuleProtocol(rule?.protocol));
  addRuleSearchPart(parts, rule?.protocol);
  addRuleSearchPort(parts, sourcePort, "入口端口");
  addRuleSearchPort(parts, targetPort, "目标端口");
  addRuleSearchPart(parts, targetIp);
  if (targetIp && targetPort > 0) addRuleSearchPart(parts, formatAddressWithPort(targetIp, targetPort));
  if (sourcePort > 0 && targetIp && targetPort > 0) addRuleSearchPart(parts, `${sourcePort}->${formatAddressWithPort(targetIp, targetPort)}`);

  addRuleSearchHostParts(parts, filters.hostById.get(Number(rule?.hostId || 0)), sourcePort);
  if (entryHostId && entryHostId !== Number(rule?.hostId || 0)) addRuleSearchHostParts(parts, filters.hostById.get(entryHostId), sourcePort);
  addRuleSearchTunnelParts(parts, tunnel, filters);
  addRuleSearchForwardGroupParts(parts, group, filters, sourcePort);
  addRuleSearchUserParts(parts, filters.userById.get(Number(rule?.userId || 0)));

  parseRuleFailoverTargets(rule?.failoverTargets).forEach((target) => {
    addRuleSearchPart(parts, target.targetIp);
    addRuleSearchPort(parts, target.targetPort, "备用端口");
    if (target.targetIp && target.targetPort > 0) addRuleSearchPart(parts, formatAddressWithPort(target.targetIp, target.targetPort));
  });

  return parts.join("\n").toLowerCase();
}

function isRuleSearchMatch(rule: any, filters: RuleFilterState) {
  const tokens = String(filters.searchQuery || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const searchText = buildRuleSearchText(rule, filters);
  return tokens.every((token) => searchText.includes(token));
}
function isForwardRuleVisibleByFilters(rule: any, filters: RuleFilterState) {
  if (filters.isAdmin) {
    if (filters.filterUser === "self" && Number(rule.userId) !== Number(filters.userId)) {
      return false;
    }
    if (filters.filterUser !== "all" && filters.filterUser !== "self" && Number(rule.userId) !== Number(filters.filterUser)) {
      return false;
    }
  }
  if (filters.filterHost !== "all" && filters.getRuleEntryHostId(rule) !== parseInt(filters.filterHost)) {
    return false;
  }
  if (filters.ruleCategory !== "all") {
    if (getRuleCategory(rule, filters.forwardGroupById) !== filters.ruleCategory) return false;
  }
  if (!isRuleSearchMatch(rule, filters)) return false;
  return true;
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
  if (nginxTunnelModes.has(mode)) {
    return {
      shortLabel: "Nginx",
      badgeLabel: "隧道 / Nginx",
      toolLabel: "Nginx Stream 隧道",
    };
  }
  return {
    shortLabel: mode ? mode.toUpperCase() : "隧道",
    badgeLabel: mode ? `隧道 / ${mode.toUpperCase()}` : "隧道",
    toolLabel: "隧道转发",
  };
}

type EntryAddress = {
  label: string;
  value: string;
};

function pushUniqueEntryAddress(rows: EntryAddress[], label: string, value: unknown) {
  const text = String(value || "").trim();
  if (!text || rows.some((row) => row.value === text)) return;
  rows.push({ label, value: text });
}

function hostDdnsDomain(host: any | null | undefined) {
  return host?.ddnsEnabled ? String(host?.ddnsDomain || "").trim() : "";
}

function hostAutoIpv4(host: any | null | undefined) {
  const ipv4 = String(host?.ipv4 || "").trim();
  if (ipv4) return ipv4;
  const ip = String(host?.ip || "").trim();
  return ip && !ip.includes(":") ? ip : "";
}

function hostAutoIpv6(host: any | null | undefined) {
  const ipv6 = String(host?.ipv6 || "").trim();
  if (ipv6) return ipv6;
  const ip = String(host?.ip || "").trim();
  return ip && ip.includes(":") ? ip : "";
}

function getHostEntryAddresses(host: any | null | undefined): EntryAddress[] {
  const rows: EntryAddress[] = [];
  const manualEntry = String(host?.entryIp || "").trim();
  const ddnsDomain = hostDdnsDomain(host);
  const ipv4 = hostAutoIpv4(host);
  const ipv6 = hostAutoIpv6(host);
  const manualIsDomain = addressFamily(manualEntry) === "hostname";
  if (manualEntry && manualIsDomain) {
    pushUniqueEntryAddress(rows, "自定义", manualEntry);
  }
  if (ddnsDomain) {
    pushUniqueEntryAddress(rows, "DDNS", ddnsDomain);
  }
  if (manualEntry && !manualIsDomain) {
    pushUniqueEntryAddress(rows, "入口", manualEntry);
  }
  if (!manualEntry && !ddnsDomain) {
    pushUniqueEntryAddress(rows, ipv4 ? "IPv4" : ipv6 ? "IPv6" : "IP", ipv4 || ipv6 || host?.ip);
  }
  if (ipv6) pushUniqueEntryAddress(rows, "IPv6", ipv6);
  return rows;
}
function getHostEntryAddress(host: any | null | undefined): string {
  return getHostEntryAddresses(host)[0]?.value || "";
}

function getHostEntryAddressText(host: any | null | undefined, port?: number | string): string {
  const entries = getHostEntryAddresses(host);
  if (entries.length === 0) return "";
  return entries
    .map((entry) => port === undefined ? entry.value : formatAddressWithPort(entry.value, port))
    .join(" / ");
}

function formatAddressWithPort(address: string, port: number | string): string {
  const value = String(address || "").trim();
  if (!value) return "";
  if (value.includes(":") && !value.startsWith("[") && !value.endsWith("]")) {
    return `[${value}]:${port}`;
  }
  return `${value}:${port}`;
}

function normalizeForwardGroupModeForRule(group: any | null | undefined) {
  const mode = String(group?.groupMode || "failover");
  return mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function isForwardChainGroup(group: any | null | undefined) {
  return normalizeForwardGroupModeForRule(group) === "chain";
}


type AddressFamily = "ipv4" | "ipv6" | "hostname" | "unknown";
type LiteralAddressFamily = "ipv4" | "ipv6";

function cleanAddressLiteral(value: unknown) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^tcp:\/\//i, "").trim();
  if (text.startsWith("[") && text.includes("]")) return text.slice(1, text.indexOf("]")).trim();
  return text;
}

function isIpv4Literal(value: string) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function addressFamily(value: unknown): AddressFamily {
  const text = cleanAddressLiteral(value);
  if (!text) return "unknown";
  if (isIpv4Literal(text)) return "ipv4";
  const withoutZone = text.replace(/%.+$/, "");
  if (withoutZone.includes(":") && /^[0-9a-f:.]+$/i.test(withoutZone)) return "ipv6";
  if (/^[a-z0-9.-]+$/i.test(text)) return "hostname";
  return "unknown";
}

function isKernelForwardType(type: unknown) {
  const text = String(type || "").trim().toLowerCase();
  return text === "iptables" || text === "nftables";
}

function familyLabel(family: AddressFamily) {
  if (family === "ipv4") return "IPv4";
  if (family === "ipv6") return "IPv6";
  if (family === "hostname") return "域名";
  return "未知协议族";
}

function literalFamilySet(value: unknown) {
  const family = addressFamily(value);
  const families = new Set<LiteralAddressFamily>();
  if (family === "ipv4" || family === "ipv6") families.add(family);
  return families;
}

function addLiteralHostFamily(families: Set<LiteralAddressFamily>, value: unknown) {
  const family = addressFamily(value);
  if (family === "ipv4" || family === "ipv6") families.add(family);
}

function hostDdnsFamily(host: any | null | undefined): LiteralAddressFamily | null {
  const ipVersion = String(host?.ddnsIpVersion || "").trim().toLowerCase();
  const recordType = String(host?.ddnsRecordType || "").trim().toUpperCase();
  if (ipVersion === "ipv6" || recordType === "AAAA") return "ipv6";
  if (ipVersion === "ipv4" || recordType === "A") return "ipv4";
  return null;
}

function hostEntryFamilies(host: any | null | undefined) {
  const families = new Set<LiteralAddressFamily>();
  const manualEntry = String(host?.entryIp || "").trim();
  if (manualEntry) {
    addLiteralHostFamily(families, manualEntry);
  } else if (hostDdnsDomain(host)) {
    const ddnsFamily = hostDdnsFamily(host);
    if (ddnsFamily) families.add(ddnsFamily);
  } else {
    addLiteralHostFamily(families, hostAutoIpv4(host) || hostAutoIpv6(host) || host?.ip);
  }
  return families;
}
function warningHostName(host: any | null | undefined, fallback: string) {
  return String(host?.name || fallback).trim();
}

function resolveChainConnectHostForWarning(member: any, host: any | null | undefined) {
  const stored = String(member?.connectHost || "").trim();
  const publicAddr = getHostEntryAddress(host);
  const privateAddr = String(host?.tunnelEntryIp || "").trim();
  const ipv6Addr = String(host?.ipv6 || "").trim();
  if (stored && privateAddr && stored === privateAddr) return privateAddr;
  if (stored && ipv6Addr && stored === ipv6Addr) return ipv6Addr;
  return publicAddr || stored;
}

function enabledHostMembers(group: any | null | undefined) {
  return [...(group?.members || [])]
    .filter((member: any) => member?.memberType !== "tunnel" && member?.isEnabled !== false && Number(member?.hostId || 0) > 0)
    .sort((a: any, b: any) => Number(a.priority || 0) - Number(b.priority || 0));
}

function lookupHostForWarning(hosts: any[] | undefined, hostById: Map<number, any> | undefined, hostId: number) {
  if (!Number.isFinite(hostId) || hostId <= 0) return null;
  return hostById?.get(hostId) || (hosts || []).find((host: any) => Number(host.id) === hostId) || null;
}

function kernelFamilyWarning(toolLabel: string, fromLabel: string, sourceFamilies: Set<LiteralAddressFamily>, targetLabel: string, targetFamily: AddressFamily) {
  if (targetFamily !== "ipv4" && targetFamily !== "ipv6") return null;
  const families = Array.from(sourceFamilies);
  if (families.length === 0) return null;
  if (!families.includes(targetFamily)) {
    return `${toolLabel} 属于内核 NAT/防火墙规则，不能把 ${familyLabel(families[0])} 入口直接转成 ${familyLabel(targetFamily)} 目标；${fromLabel} 到 ${targetLabel} 需要改用 realm/socat/gost 等用户态转发，或把两端统一到同一协议族。`;
  }
  if (families.length > 1) {
    const otherFamily = families.find((family) => family !== targetFamily);
    if (otherFamily) {
      return `${toolLabel} 属于内核 NAT/防火墙规则，${fromLabel} 同时暴露 IPv4/IPv6，但 ${targetLabel} 只明确为 ${familyLabel(targetFamily)}；使用 ${familyLabel(otherFamily)} 入口访问时可能不通，跨 IPv4/IPv6 建议改用用户态转发。`;
    }
  }
  return null;
}

type KernelForwardWarningInput = {
  rule: any;
  host?: any | null;
  group?: any | null;
  hosts?: any[];
  hostById?: Map<number, any>;
  forwardGroupById?: Map<number, any>;
};

function buildKernelChainForwardWarning(input: Required<Pick<KernelForwardWarningInput, "rule">> & Omit<KernelForwardWarningInput, "rule"> & { group: any; toolLabel: string }) {
  const { rule, group, hosts, hostById, forwardGroupById, toolLabel } = input;
  const members = enabledHostMembers(group);
  if (members.length === 0) return null;
  const getHost = (hostId: number) => lookupHostForWarning(hosts, hostById, hostId);
  const firstMember = members[0];
  const firstHost = getHost(Number(firstMember.hostId || 0));
  const entryGroup = Number(group?.entryGroupId || 0) > 0 ? forwardGroupById?.get(Number(group.entryGroupId)) : null;
  const entryMembers = entryGroup && normalizeForwardGroupModeForRule(entryGroup) === "entry" ? enabledHostMembers(entryGroup) : [];
  const firstConnectHost = resolveChainConnectHostForWarning(firstMember, firstHost);
  let inboundFamilies = entryMembers.length > 0 ? literalFamilySet(firstConnectHost) : hostEntryFamilies(firstHost);

  if (entryMembers.length > 0) {
    const firstConnectFamily = addressFamily(firstConnectHost);
    const firstName = warningHostName(firstHost, `主机${Number(firstMember.hostId || 0) || ""}`);
    for (const entryMember of entryMembers) {
      const entryHost = getHost(Number(entryMember.hostId || 0));
      const entryName = warningHostName(entryHost, `入口主机${Number(entryMember.hostId || 0) || ""}`);
      const warning = kernelFamilyWarning(
        toolLabel,
        `${entryName} 入口`,
        hostEntryFamilies(entryHost),
        `${firstName} 连接地址`,
        firstConnectFamily,
      );
      if (warning) return warning;
    }
    if (inboundFamilies.size === 0) inboundFamilies = hostEntryFamilies(firstHost);
  }

  for (let index = 0; index < members.length - 1; index++) {
    const current = members[index];
    const next = members[index + 1];
    const currentHost = getHost(Number(current.hostId || 0));
    const nextHost = getHost(Number(next.hostId || 0));
    const nextConnectHost = resolveChainConnectHostForWarning(next, nextHost);
    const currentName = warningHostName(currentHost, `主机${Number(current.hostId || 0) || ""}`);
    const nextName = warningHostName(nextHost, `主机${Number(next.hostId || 0) || ""}`);
    const warning = kernelFamilyWarning(
      toolLabel,
      `${currentName} 入口`,
      inboundFamilies,
      `${nextName} 连接地址`,
      addressFamily(nextConnectHost),
    );
    if (warning) return warning;
    inboundFamilies = literalFamilySet(nextConnectHost);
    if (inboundFamilies.size === 0) inboundFamilies = hostEntryFamilies(nextHost);
  }

  const lastMember = members[members.length - 1];
  const lastHost = getHost(Number(lastMember.hostId || 0));
  return kernelFamilyWarning(
    toolLabel,
    `${warningHostName(lastHost, `主机${Number(lastMember.hostId || 0) || ""}`)} 入口`,
    inboundFamilies,
    `最终目标 ${String(rule?.targetIp || "").trim() || "-"}`,
    addressFamily(rule?.targetIp),
  );
}

function buildKernelForwardWarning({ rule, host, group, hosts = [], hostById, forwardGroupById }: KernelForwardWarningInput) {
  const forwardType = String(rule?.forwardType || "").trim().toLowerCase();
  if (!isKernelForwardType(forwardType)) return null;
  const toolLabel = FORWARD_TYPE_LABELS[forwardType as ForwardType] || forwardType;
  const activeGroup = group || (Number(rule?.forwardGroupId || 0) > 0 ? forwardGroupById?.get(Number(rule.forwardGroupId)) : null);
  if (activeGroup && isForwardChainGroup(activeGroup)) {
    return buildKernelChainForwardWarning({ rule, group: activeGroup, hosts, hostById, forwardGroupById, toolLabel });
  }
  if (activeGroup && normalizeForwardGroupModeForRule(activeGroup) === "failover" && activeGroup.groupType === "host") {
    for (const member of enabledHostMembers(activeGroup)) {
      const memberHost = lookupHostForWarning(hosts, hostById, Number(member.hostId || 0));
      const warning = kernelFamilyWarning(
        toolLabel,
        `${warningHostName(memberHost, `成员主机${Number(member.hostId || 0) || ""}`)} 入口`,
        hostEntryFamilies(memberHost),
        `最终目标 ${String(rule?.targetIp || "").trim() || "-"}`,
        addressFamily(rule?.targetIp),
      );
      if (warning) return warning;
    }
    return null;
  }
  const entryHost = host || lookupHostForWarning(hosts, hostById, Number(rule?.hostId || 0));
  if (!entryHost) return null;
  return kernelFamilyWarning(
    toolLabel,
    `${warningHostName(entryHost, "入口主机")} 入口`,
    hostEntryFamilies(entryHost),
    `目标 ${String(rule?.targetIp || "").trim() || "-"}`,
    addressFamily(rule?.targetIp),
  );
}
function isSelectableForwardRuleGroup(group: any | null | undefined) {
  const mode = normalizeForwardGroupModeForRule(group);
  return mode === "failover" || mode === "chain";
}

function getForwardGroupKindLabel(group: any | null | undefined) {
  const mode = normalizeForwardGroupModeForRule(group);
  if (mode === "chain") return "端口转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  return group?.groupType === "tunnel" ? "隧道组" : "主机组";
}

type RuleTrafficSummary = {
  bytesIn: number;
  bytesOut: number;
  connections: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | null;
};

type RuleTargetGeo = {
  address: string;
  resolvedAddress: string;
  geoCountryCode: string;
  geoCountryName: string | null;
  geoRegion: string | null;
  geoEmoji: string | null;
  geoLatitudeMicro: number | null;
  geoLongitudeMicro: number | null;
};

type RuleGlobePoint = {
  id: string;
  kind: "host" | "target";
  name: string;
  lat: number;
  lng: number;
  color: string;
  regionText: string;
  addressText: string;
  countryCode: string;
  targetText?: string;
  note?: string;
  rule?: any;
};

type RuleGlobePath = {
  id: string;
  variant: "track" | "flow";
  rule: any;
  color: string;
  trackColor: string;
  routeText: string;
  finalHopText: string;
  targetText: string;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  totalBytes: number;
  stroke: number;
  dashInitialGap: number;
  dashAnimateTime: number;
  coords: Array<{ lat: number; lng: number; alt: number }>;
};

type RuleGlobeCountryFeature = CountryFeatureLike & {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

function prefetchReactGlobe() {
  if (reactGlobePrefetchStarted || typeof window === "undefined") return;
  reactGlobePrefetchStarted = true;
  const startPrefetch = () => {
    loadReactGlobe().catch(() => {
      reactGlobePrefetchStarted = false;
    });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(startPrefetch, { timeout: 2200 });
  } else {
    globalThis.setTimeout(startPrefetch, 700);
  }
}

function escapeTooltipHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function hashText(value: unknown) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  if (![red, green, blue].every(Number.isFinite)) return `rgba(148,163,184,${alpha})`;
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha))})`;
}

function ruleGlobeColor(rule: any) {
  return RULE_GLOBE_COLORS[hashText(`${rule?.id}:${rule?.name}`) % RULE_GLOBE_COLORS.length];
}

function normalizeAddressKey(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function hostAddressCandidates(host: any | null | undefined) {
  return [host?.entryIp, host?.ipv4, host?.ipv6, host?.ip, host?.tunnelEntryIp]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function hostGeoCoordinate(host: any | null | undefined) {
  if (host?.geoLatitudeMicro == null || host?.geoLongitudeMicro == null) return null;
  const lat = Number(host.geoLatitudeMicro) / 1_000_000;
  const lng = Number(host.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function microGeoCoordinate(geo: Pick<RuleTargetGeo, "geoLatitudeMicro" | "geoLongitudeMicro"> | null | undefined) {
  if (geo?.geoLatitudeMicro == null || geo?.geoLongitudeMicro == null) return null;
  const lat = Number(geo.geoLatitudeMicro) / 1_000_000;
  const lng = Number(geo.geoLongitudeMicro) / 1_000_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function hostRegionText(host: any | null | undefined) {
  return [host?.geoCountryName || host?.geoCountryCode, host?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}

function hostCountryCode(host: any | null | undefined) {
  return normalizeCountryCode(host?.geoCountryCode);
}

function targetGeoRegionText(geo: RuleTargetGeo | null | undefined) {
  return [geo?.geoCountryName || geo?.geoCountryCode, geo?.geoRegion]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" / ");
}

function targetGeoCountryCode(geo: RuleTargetGeo | null | undefined) {
  return normalizeCountryCode(geo?.geoCountryCode);
}

function normalizeLongitude(lng: number) {
  if (lng < -180) return lng + 360;
  if (lng > 180) return lng - 360;
  return lng;
}

function longitudeDeltaDegrees(from: number, to: number) {
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function globeDistanceDegrees(start: Pick<RuleGlobePoint, "lat" | "lng">, end: Pick<RuleGlobePoint, "lat" | "lng">) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(start.lat);
  const lat2 = toRad(end.lat);
  const lng1 = toRad(start.lng);
  const lng2 = toRad(end.lng);
  const angle = Math.acos(Math.min(1, Math.max(-1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1))));
  return (angle * 180) / Math.PI;
}

function createRuleGlobeSegmentCoords(
  start: Pick<RuleGlobePoint, "lat" | "lng">,
  end: Pick<RuleGlobePoint, "lat" | "lng">,
  altitude: number,
  layerIndex: number,
  layerCount: number,
) {
  const dLat = end.lat - start.lat;
  const dLng = longitudeDeltaDegrees(start.lng, end.lng);
  const midLat = (start.lat + end.lat) / 2;
  const midLng = normalizeLongitude(start.lng + dLng / 2);
  const lngScale = Math.max(0.35, Math.cos((midLat * Math.PI) / 180));
  const projectedLng = dLng * lngScale;
  const distance = Math.sqrt(dLat * dLat + projectedLng * projectedLng);
  const greatCircleDistance = globeDistanceDegrees(start, end);
  const layerOffset = layerIndex - (layerCount - 1) / 2;
  const sideSpacing = layerCount > 1 ? Math.min(8, Math.max(1.8, greatCircleDistance / 24)) : 0;
  const offset = layerOffset * sideSpacing;
  const offsetLat = distance > 0 ? (projectedLng / distance) * offset : 0;
  const offsetLng = distance > 0 ? (-dLat / (distance * lngScale)) * offset : 0;
  const controlLat = Math.max(-85, Math.min(85, midLat + offsetLat));
  const controlLng = start.lng + dLng / 2 + offsetLng;
  const shortHopLift = greatCircleDistance < 18 ? (1 - greatCircleDistance / 18) * 0.026 : 0;
  const controlAlt = Math.min(0.16, altitude + shortHopLift);
  const steps = Math.max(12, Math.min(32, Math.ceil(greatCircleDistance / 3.2)));
  const coords: Array<{ lat: number; lng: number; alt: number }> = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const inv = 1 - t;
    const lat = inv * inv * start.lat + 2 * inv * t * controlLat + t * t * end.lat;
    const lng = inv * inv * start.lng + 2 * inv * t * controlLng + t * t * (start.lng + dLng);
    const alt = inv * inv * RULE_GLOBE_PATH_SURFACE_ALTITUDE + 2 * inv * t * controlAlt + t * t * RULE_GLOBE_PATH_SURFACE_ALTITUDE;
    coords.push({ lat: Math.max(-85, Math.min(85, lat)), lng: normalizeLongitude(lng), alt });
  }
  return coords;
}

function createRuleGlobeRouteCoords(routePoints: RuleGlobePoint[], layerIndex: number, layerCount: number, totalBytes: number) {
  const maxDistance = Math.max(0, ...routePoints.slice(0, -1).map((point, index) => globeDistanceDegrees(point, routePoints[index + 1])));
  const trafficLift = totalBytes > 0 ? Math.min(0.018, Math.log10(totalBytes + 1) / 420) : 0;
  const baseAltitude = Math.max(RULE_GLOBE_PATH_MIN_ALTITUDE, Math.min(RULE_GLOBE_PATH_MAX_ALTITUDE, 0.034 + maxDistance / 2100 + trafficLift));
  const altitude = baseAltitude + Math.min(RULE_GLOBE_PATH_LAYER_ALTITUDE_MAX, Math.abs(layerIndex - (layerCount - 1) / 2) * RULE_GLOBE_PATH_LAYER_ALTITUDE_STEP);
  const coords: Array<{ lat: number; lng: number; alt: number }> = [];
  routePoints.slice(0, -1).forEach((point, index) => {
    const segment = createRuleGlobeSegmentCoords(point, routePoints[index + 1], altitude, layerIndex, layerCount);
    if (coords.length > 0) segment.shift();
    coords.push(...segment);
  });
  return coords;
}

function ruleGlobeTargetOffset(anchor: RuleGlobePoint, rule: any, targetText: string) {
  const hash = hashText(`${rule?.id}:${targetText}`);
  const angle = ((hash % 360) * Math.PI) / 180;
  const ring = Math.floor((hash / 360) % 3);
  const distance = RULE_GLOBE_TARGET_OFFSET_DEGREES + ring * 1.6;
  const lat = Math.max(-82, Math.min(82, anchor.lat + Math.sin(angle) * distance));
  const lngScale = Math.max(0.45, Math.cos((anchor.lat * Math.PI) / 180));
  const lng = normalizeLongitude(anchor.lng + (Math.cos(angle) * distance) / lngScale);
  return { lat, lng };
}

function renderRuleGlobePointTooltip(point: RuleGlobePoint) {
  const rows = [
    { label: "类型", value: point.kind === "target" ? "目标端口" : "转发节点" },
    { label: "地址", value: point.addressText || "-" },
    { label: "地区", value: point.regionText || "未定位" },
    ...(point.targetText ? [{ label: "目标", value: point.targetText }] : []),
    ...(point.note ? [{ label: "说明", value: point.note }] : []),
  ];
  return `
    <div style="min-width:250px;max-width:360px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(point.name)}</div>
        <span style="width:9px;height:9px;border-radius:999px;background:${point.color};box-shadow:0 0 16px ${hexToRgba(point.color, .75)};"></span>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderRuleGlobePathTooltip(path: RuleGlobePath) {
  const rows = [
    { label: "规则", value: path.rule?.name || `规则 #${path.rule?.id}` },
    { label: "入口", value: `:${path.rule?.sourcePort || "-"}` },
    { label: "目标", value: path.targetText },
    { label: "路径", value: path.routeText },
    { label: "末跳", value: path.finalHopText },
    { label: "入向", value: formatBytes(path.bytesIn) },
    { label: "出向", value: formatBytes(path.bytesOut) },
    { label: "连接", value: String(path.connections || 0) },
  ];
  return `
    <div style="min-width:290px;max-width:390px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(8,13,24,.94);box-shadow:0 18px 44px rgba(0,0,0,.42);backdrop-filter:blur(10px);color:#f8fafc;padding:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;">${escapeTooltipHtml(path.rule?.name || `规则 #${path.rule?.id}`)}</div>
        <div style="display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;">
          <span style="width:8px;height:8px;border-radius:999px;background:${path.color};box-shadow:0 0 14px ${hexToRgba(path.color, .8)};"></span>
          ${escapeTooltipHtml(formatBytes(path.totalBytes))}
        </div>
      </div>
      ${rows.map((row) => `
        <div style="display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:start;margin-top:6px;font-size:12px;line-height:1.45;">
          <span style="color:#94a3b8;">${escapeTooltipHtml(row.label)}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;">${escapeTooltipHtml(row.value)}</span>
        </div>
      `).join("")}
      <div style="margin-top:10px;color:#93c5fd;font-size:12px;">点击编辑规则</div>
    </div>
  `;
}

function ruleGlobeRouteHostIds(rule: any, tunnelById: Map<number, any>, forwardGroupById: Map<number, any>) {
  const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
  if (group && isForwardChainGroup(group)) {
    return [...(group.members || [])]
      .filter((member: any) => member.memberType !== "tunnel" && member.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .map((member: any) => Number(member.hostId || 0))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }
  if (rule.forwardType === "gost" && rule.tunnelId) {
    return getTunnelHopIds(tunnelById.get(Number(rule.tunnelId)));
  }
  if (group && group.groupType === "tunnel") {
    const member = [...(group.members || [])]
      .filter((item: any) => item.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .find((item: any) => Number(item.tunnelId || 0) > 0);
    const tunnel = member ? tunnelById.get(Number(member.tunnelId)) : null;
    const hopIds = getTunnelHopIds(tunnel);
    if (hopIds.length > 0) return hopIds;
  }
  if (group && group.groupType !== "tunnel") {
    const member = [...(group.members || [])]
      .filter((item: any) => item.memberType !== "tunnel" && item.isEnabled !== false)
      .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
      .find((item: any) => Number(item.hostId || 0) > 0);
    if (member) return [Number(member.hostId)];
  }
  return [Number(rule.hostId || 0)].filter((id) => id > 0);
}

function buildRuleGlobeData(
  rules: any[],
  hosts: any[],
  tunnels: any[],
  forwardGroups: any[],
  trafficByRule: Map<number, RuleTrafficSummary>,
  targetGeoByAddress: Map<string, RuleTargetGeo>,
  targetGeoLookupReady: boolean,
) {
  const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map<number, any>((tunnels || []).map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const forwardGroupById = new Map<number, any>((forwardGroups || []).map((group: any) => [Number(group.id), group]));
  const hostPointById = new Map<number, RuleGlobePoint>();
  const hostByAddress = new Map<string, RuleGlobePoint>();

  const pointForHostId = (hostId: number) => {
    if (hostPointById.has(hostId)) return hostPointById.get(hostId) || null;
    const host = hostById.get(hostId);
    const coord = hostGeoCoordinate(host);
    if (!host || !coord) return null;
    const point: RuleGlobePoint = {
      id: `host:${hostId}`,
      kind: "host",
      name: String(host.name || `主机 #${hostId}`),
      lat: coord.lat,
      lng: coord.lng,
      color: "#e0f2fe",
      regionText: hostRegionText(host),
      addressText: hostAddressCandidates(host).join(" / "),
      countryCode: hostCountryCode(host),
    };
    hostPointById.set(hostId, point);
    hostAddressCandidates(host).forEach((address) => {
      hostByAddress.set(normalizeAddressKey(address), point);
    });
    return point;
  };

  (hosts || []).forEach((host: any) => {
    const point = pointForHostId(Number(host.id));
    if (!point) return;
  });

  const rawRoutes: Array<{
    rule: any;
    color: string;
    routePoints: RuleGlobePoint[];
    targetPoint: RuleGlobePoint;
    targetText: string;
    routeText: string;
    finalHopText: string;
    bytesIn: number;
    bytesOut: number;
    connections: number;
    totalBytes: number;
  }> = [];
  let skipped = 0;

  (rules || []).forEach((rule: any) => {
    const chainGroup = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const chainEntryGroup = chainGroup && isForwardChainGroup(chainGroup) && Number(chainGroup.entryGroupId || 0) > 0
      ? forwardGroupById.get(Number(chainGroup.entryGroupId))
      : null;
    const chainEntryMembers = chainEntryGroup && normalizeForwardGroupModeForRule(chainEntryGroup) === "entry" ? enabledHostMembers(chainEntryGroup) : [];
    const routeHostIds = ruleGlobeRouteHostIds(rule, tunnelById, forwardGroupById);
    const routePoints = routeHostIds.map((hostId: number) => pointForHostId(hostId)).filter(Boolean) as RuleGlobePoint[];
    if (routePoints.length === 0) {
      skipped += 1;
      return;
    }
    const targetText = formatAddressWithPort(String(rule.targetIp || "-"), Number(rule.targetPort || 0) || "-");
    const color = ruleGlobeColor(rule);
    const targetHostPoint = hostByAddress.get(normalizeAddressKey(rule.targetIp));
    const lastRoutePoint = routePoints[routePoints.length - 1];
    const targetGeo = targetGeoByAddress.get(normalizeAddressKey(rule.targetIp));
    const targetGeoCoord = microGeoCoordinate(targetGeo);
    const shouldOffsetTargetHost = !!targetHostPoint && targetHostPoint.id === lastRoutePoint.id;
    if (!targetHostPoint && !targetGeoCoord && !targetGeoLookupReady) {
      skipped += 1;
      return;
    }
    const targetCoord = shouldOffsetTargetHost
      ? ruleGlobeTargetOffset(lastRoutePoint, rule, targetText)
      : targetHostPoint
      ? { lat: targetHostPoint.lat, lng: targetHostPoint.lng }
      : targetGeoCoord
      ? targetGeoCoord
      : ruleGlobeTargetOffset(lastRoutePoint, rule, targetText);
    const targetRegionText = shouldOffsetTargetHost
      ? lastRoutePoint.regionText
      : targetHostPoint
      ? targetHostPoint.regionText
      : targetGeoCoord
      ? targetGeoRegionText(targetGeo)
      : "";
    const targetCountryCode = shouldOffsetTargetHost
      ? lastRoutePoint.countryCode
      : targetHostPoint
      ? targetHostPoint.countryCode
      : targetGeoCoord
      ? targetGeoCountryCode(targetGeo)
      : "";
    const targetNote = shouldOffsetTargetHost
      ? "目标端口位于出口节点，已偏移显示末跳"
      : targetHostPoint
      ? "目标地址匹配已登记主机"
      : targetGeoCoord
      ? `目标地址已定位${targetGeo?.resolvedAddress && normalizeAddressKey(targetGeo.resolvedAddress) !== normalizeAddressKey(rule.targetIp) ? `，解析到 ${targetGeo.resolvedAddress}` : ""}`
      : "目标地址未定位，临时放置在出口附近";
    const targetPoint: RuleGlobePoint = {
      id: `target:${rule.id}`,
      kind: "target",
      name: `目标 ${targetText}`,
      lat: targetCoord.lat,
      lng: targetCoord.lng,
      color,
      regionText: targetRegionText,
      addressText: targetText,
      countryCode: targetCountryCode,
      targetText,
      note: targetNote,
      rule,
    };
    const traffic = trafficByRule.get(Number(rule.id));
    const bytesIn = Number(traffic?.bytesIn || 0);
    const bytesOut = Number(traffic?.bytesOut || 0);
    const routeWithTarget = [...routePoints, targetPoint];
    const exitPoint = routePoints[routePoints.length - 1];
    const finalHopText = `${exitPoint.name} -> ${targetText}`;
    rawRoutes.push({
      rule,
      color,
      routePoints: routeWithTarget,
      targetPoint,
      targetText,
      routeText: routeWithTarget.map((point) => point.kind === "target" ? targetText : point.name).join(" -> "),
      finalHopText,
      bytesIn,
      bytesOut,
      connections: Number(traffic?.connections || 0),
      totalBytes: bytesIn + bytesOut,
    });
  });

  const layerCounts = new Map<string, number>();
  rawRoutes.forEach((route) => {
    const start = route.routePoints[0];
    const end = route.routePoints[route.routePoints.length - 1];
    const key = `${start.lat.toFixed(2)}:${start.lng.toFixed(2)}|${end.lat.toFixed(2)}:${end.lng.toFixed(2)}`;
    layerCounts.set(key, (layerCounts.get(key) || 0) + 1);
  });
  const usedLayers = new Map<string, number>();
  const paths: RuleGlobePath[] = [];
  rawRoutes.forEach((route) => {
    const start = route.routePoints[0];
    const end = route.routePoints[route.routePoints.length - 1];
    const layerKey = `${start.lat.toFixed(2)}:${start.lng.toFixed(2)}|${end.lat.toFixed(2)}:${end.lng.toFixed(2)}`;
    const layerIndex = usedLayers.get(layerKey) || 0;
    usedLayers.set(layerKey, layerIndex + 1);
    const layerCount = layerCounts.get(layerKey) || 1;
    const coords = createRuleGlobeRouteCoords(route.routePoints, layerIndex, layerCount, route.totalBytes);
    const trafficScale = route.totalBytes > 0 ? Math.log10(route.totalBytes + 1) : 0;
    const stroke = 1.25 + Math.min(2.3, trafficScale / 2.4);
    const dashAnimateTime = Math.max(900, 3200 - Math.min(1900, trafficScale * 190));
    const base: Omit<RuleGlobePath, "id" | "variant" | "trackColor" | "dashAnimateTime"> = {
      rule: route.rule,
      color: route.color,
      routeText: route.routeText,
      finalHopText: route.finalHopText,
      targetText: route.targetText,
      bytesIn: route.bytesIn,
      bytesOut: route.bytesOut,
      connections: route.connections,
      totalBytes: route.totalBytes,
      stroke,
      dashInitialGap: (hashText(route.rule.id) % 100) / 100,
      coords,
    };
    paths.push({
      ...base,
      id: `track:${route.rule.id}`,
      variant: "track",
      trackColor: hexToRgba(route.color, route.totalBytes > 0 ? 0.28 : 0.18),
      dashAnimateTime: 0,
    });
    if (route.totalBytes > 0) {
      paths.push({
        ...base,
        id: `flow:${route.rule.id}`,
        variant: "flow",
        trackColor: route.color,
        dashAnimateTime,
      });
    }
  });

  const sortedRoutes = rawRoutes
    .slice()
    .sort((a, b) => b.totalBytes - a.totalBytes || Number(a.rule.id || 0) - Number(b.rule.id || 0));

  return {
    paths,
    points: [
      ...Array.from(hostPointById.values()),
      ...rawRoutes.map((route) => route.targetPoint),
    ],
    summaries: sortedRoutes,
    skipped,
  };
}

function RuleTrafficGlobe({
  rules,
  hosts,
  tunnels,
  forwardGroups,
  trafficByRule,
  trafficRangeLabel = "24h",
  targetGeoByAddress,
  targetGeoLookupReady,
  onEditRule,
}: {
  rules: any[];
  hosts: any[];
  tunnels: any[];
  forwardGroups: any[];
  trafficByRule: Map<number, RuleTrafficSummary>;
  trafficRangeLabel?: string;
  targetGeoByAddress: Map<string, RuleTargetGeo>;
  targetGeoLookupReady: boolean;
  onEditRule: (rule: any) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [globeReady, setGlobeReady] = useState(false);
  const [size, setSize] = useState({ width: 1400, height: 780 });
  const [hoveredPath, setHoveredPath] = useState<RuleGlobePath | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<RuleGlobePoint | null>(null);
  const [countries, setCountries] = useState<RuleGlobeCountryFeature[]>([]);
  const globeData = useMemo(
    () => buildRuleGlobeData(rules, hosts, tunnels, forwardGroups, trafficByRule, targetGeoByAddress, targetGeoLookupReady),
    [forwardGroups, hosts, rules, targetGeoByAddress, targetGeoLookupReady, trafficByRule, tunnels],
  );
  const routeCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    globeData.points.forEach((point) => {
      const code = normalizeCountryCode(point.countryCode);
      if (code) codes.add(code);
    });
    return codes;
  }, [globeData.points]);

  useEffect(() => {
    if (!globeReady) return;
    let cancelled = false;
    fetch(RULE_GLOBE_COUNTRIES_URL)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.features)) return;
        setCountries(data.features as RuleGlobeCountryFeature[]);
      })
      .catch(() => {
        if (!cancelled) setCountries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [globeReady]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
      const width = Math.max(900, Math.round(rect.width));
      setSize({
        width,
        height: Math.max(720, Math.min(980, Math.round(Math.max(viewportHeight - 240, width * 0.52)))),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    if (!globeReady || !globeRef.current) return;
    const globe = globeRef.current;
    const controls = globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.58;
    controls.zoomSpeed = 0.85;
    controls.minDistance = 105;
    controls.maxDistance = 500;
    globe.pointOfView({ lat: 18, lng: 108, altitude: 1.28 }, 0);
  }, [globeReady]);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) return;
    controls.autoRotate = !(hoveredPath || hoveredPoint);
  }, [hoveredPath, hoveredPoint]);

  return (
    <>
      <div className="hidden overflow-hidden rounded-md border border-border/40 bg-[#030712] shadow-sm md:block">
        <div
          ref={containerRef}
          className="relative min-h-[720px] w-full overflow-hidden"
          style={{ height: size.height }}
        >
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center bg-[#030712] text-sm text-white/70">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在加载流量转发图
              </div>
            }
          >
            <ReactGlobe
              ref={globeRef}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(3,7,18,1)"
              globeImageUrl={RULE_GLOBE_EARTH_IMAGE_URL}
              showAtmosphere
              atmosphereColor="#38bdf8"
              atmosphereAltitude={0.22}
              showGraticules={false}
              globeCurvatureResolution={6}
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? 0.014 : 0.004}
              polygonCapColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(20,184,166,.34)" : "rgba(15,23,42,.05)"}
              polygonSideColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(20,184,166,.22)" : "rgba(2,6,23,.14)"}
              polygonStrokeColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? "rgba(94,234,212,.88)" : "rgba(148,163,184,.22)"}
              polygonCapCurvatureResolution={4}
              polygonsTransitionDuration={0}
              pointsData={globeData.points}
              pointLat="lat"
              pointLng="lng"
              pointAltitude={(point) => (point as RuleGlobePoint).kind === "target" ? 0.046 : 0.034}
              pointRadius={(point) => (point as RuleGlobePoint).kind === "target" ? 0.34 : 0.24}
              pointResolution={18}
              pointColor={(point) => (point as RuleGlobePoint).color}
              pointLabel={(point) => renderRuleGlobePointTooltip(point as RuleGlobePoint)}
              onPointHover={(point) => setHoveredPoint(point as RuleGlobePoint | null)}
              onPointClick={(point) => {
                const rule = (point as RuleGlobePoint | null)?.rule;
                if (rule) onEditRule(rule);
              }}
              pathsData={globeData.paths}
              pathPoints="coords"
              pathPointLat="lat"
              pathPointLng="lng"
              pathPointAlt="alt"
              pathResolution={12}
              pathColor={(path: object) => {
                const item = path as RuleGlobePath;
                if (item.variant === "track") return item.trackColor;
                return hoveredPath?.rule?.id === item.rule?.id ? item.color : hexToRgba(item.color, 0.88);
              }}
              pathStroke={(path: object) => {
                const item = path as RuleGlobePath;
                const hovered = hoveredPath?.rule?.id === item.rule?.id;
                return item.variant === "track" ? Math.max(1.1, item.stroke - 0.45) : item.stroke + (hovered ? 0.75 : 0);
              }}
              pathDashLength={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.16 : 1}
              pathDashGap={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.085 : 0}
              pathDashInitialGap={(path: object) => (path as RuleGlobePath).dashInitialGap}
              pathDashAnimateTime={(path: object) => (path as RuleGlobePath).variant === "flow" ? (path as RuleGlobePath).dashAnimateTime : 0}
              pathTransitionDuration={0}
              pathLabel={(path) => renderRuleGlobePathTooltip(path as RuleGlobePath)}
              onPathHover={(path) => setHoveredPath(path as RuleGlobePath | null)}
              onPathClick={(path) => {
                const rule = (path as RuleGlobePath | null)?.rule;
                if (rule) onEditRule(rule);
              }}
              showPointerCursor={(objectType) => objectType === "path" || objectType === "point"}
              enablePointerInteraction
              onGlobeReady={() => setGlobeReady(true)}
            />
          </Suspense>

          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="font-medium">流量转发图</div>
            <div className="mt-1 text-white/70">
              规则 {rules.length} 条 · 已定位 {globeData.summaries.length} 条
            </div>
            {globeData.skipped > 0 && (
              <div className="mt-1 text-amber-200/85">待定位 {globeData.skipped} 条</div>
            )}
          </div>

          <div className="pointer-events-none absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-[min(360px,calc(100%-2rem))] flex-col gap-2 overflow-hidden rounded-md border border-white/10 bg-black/35 p-3 text-xs text-white shadow-lg backdrop-blur-md">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{trafficRangeLabel} 流量走向</span>
              <span className="text-white/60">{formatBytes(globeData.summaries.reduce((sum, item) => sum + item.totalBytes, 0))}</span>
            </div>
            <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {globeData.summaries.slice(0, 12).map((item) => (
                <div key={item.rule.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color, boxShadow: `0 0 12px ${hexToRgba(item.color, .75)}` }} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.rule.name || `规则 #${item.rule.id}`}</div>
                    <div className="truncate text-white/55">{item.targetText}</div>
                  </div>
                  <div className="text-right tabular-nums text-white/75">{formatBytes(item.totalBytes)}</div>
                </div>
              ))}
              {globeData.summaries.length === 0 && (
                <div className="py-2 text-white/60">暂无可定位流量路径</div>
              )}
            </div>
          </div>

          {globeData.summaries.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center">
              <div className="rounded-md border border-white/10 bg-black/35 px-4 py-3 text-sm text-white/80 shadow-lg backdrop-blur-md">
                暂无可定位转发路径
              </div>
            </div>
          )}
        </div>
      </div>
      <Card className="border-border/40 bg-card/60 md:hidden">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          3D 流量转发图仅在 PC 端显示。
        </CardContent>
      </Card>
    </>
  );
}

function routeModeOptionClass(active: boolean, disabled = false) {
  return segmentedOptionClassName(active, disabled, "gap-1.5 px-3");
}

function isValidPort(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

function isValidTargetHost(value: string) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value.trim());
}

function normalizeRuleProtocol(value: unknown): RuleProtocol {
  return value === "tcp" || value === "udp" || value === "both" ? value : "both";
}

function normalizeRuleForwardType(value: unknown): ForwardType {
  return FORWARD_TYPES.includes(value as ForwardType) ? (value as ForwardType) : "iptables";
}

function normalizePositiveRuleNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRuleTransferScopeType(value: unknown): RuleTransferScopeType | null {
  return ["local", "tunnel", "chain", "group"].includes(value as string)
    ? (value as RuleTransferScopeType)
    : null;
}

function sanitizeRuleTransferFilePart(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "rules";
}

function splitFailoverTargetLine(line: string) {
  const value = line.trim();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 1 && value[end + 1] === ":") {
      return { targetIp: value.slice(1, end).trim(), targetPort: Number(value.slice(end + 2).trim()) };
    }
    return { error: "IPv6 地址请使用 [地址]:端口 格式" };
  }
  const index = value.lastIndexOf(":");
  if (index <= 0 || index === value.length - 1) return { error: "请按 地址:端口 格式填写" };
  return { targetIp: value.slice(0, index).trim(), targetPort: Number(value.slice(index + 1).trim()) };
}

function parseRuleFailoverTargets(raw: unknown) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((target: any) => ({
        targetIp: String(target?.targetIp || "").trim(),
        targetPort: Number(target?.targetPort || 0),
      }))
      .filter((target) => target.targetIp && isValidPort(target.targetPort))
      .slice(0, 10);
  } catch {
    return [];
  }
}

function normalizeProxyProtocolVersion(value: unknown): ProxyProtocolVersion {
  return Number(value) === 2 ? 2 : 1;
}

function formatFailoverTargetsText(raw: unknown) {
  return parseRuleFailoverTargets(raw)
    .map((target) => `${target.targetIp.includes(":") ? `[${target.targetIp}]` : target.targetIp}:${target.targetPort}`)
    .join("\n");
}

function exportRuleForTransfer(rule: any): RuleTransferFileRule {
  return {
    name: String(rule?.name || "导入规则"),
    forwardType: normalizeRuleForwardType(rule?.forwardType),
    protocol: normalizeRuleProtocol(rule?.protocol),
    sourcePort: Number(rule?.sourcePort || 0),
    targetIp: String(rule?.targetIp || ""),
    targetPort: Number(rule?.targetPort || 0),
    telegramErrorNotifyEnabled: Boolean(rule?.telegramErrorNotifyEnabled),
    proxyProtocolReceive: Boolean(rule?.proxyProtocolReceive),
    proxyProtocolSend: Boolean(rule?.proxyProtocolSend),
    proxyProtocolExitReceive: Boolean(rule?.proxyProtocolExitReceive),
    proxyProtocolExitSend: Boolean(rule?.proxyProtocolExitSend),
    proxyProtocolVersion: normalizeProxyProtocolVersion(rule?.proxyProtocolVersion),
    tcpFastOpen: Boolean(rule?.tcpFastOpen),
    zeroCopy: Boolean(rule?.zeroCopy),
    udpOverTcp: Boolean(rule?.udpOverTcp),
    udpOverTcpPort: Number(rule?.udpOverTcpPort || 0),
    failoverEnabled: Boolean(rule?.failoverEnabled),
    failoverStrategy: normalizeFailoverStrategy(rule?.failoverStrategy),
    failoverTargets: parseRuleFailoverTargets(rule?.failoverTargets),
    failoverSeconds: normalizePositiveRuleNumber(rule?.failoverSeconds, 60),
    recoverSeconds: normalizePositiveRuleNumber(rule?.recoverSeconds, 120),
    autoFailback: rule?.autoFailback !== false,
  };
}

function normalizeRuleTransferRule(raw: unknown): RuleTransferFileRule | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const name = String(source.name || "导入规则").trim().slice(0, 128) || "导入规则";
  const sourcePort = Number(source.sourcePort || 0);
  const targetPort = Number(source.targetPort || 0);
  const targetIp = String(source.targetIp || "").trim();
  if (!Number.isFinite(sourcePort) || sourcePort < 0 || sourcePort > 65535) return null;
  if (!targetIp || !isValidTargetHost(targetIp)) return null;
  if (!isValidPort(targetPort, false)) return null;
  return {
    name,
    forwardType: normalizeRuleForwardType(source.forwardType),
    protocol: normalizeRuleProtocol(source.protocol),
    sourcePort,
    targetIp,
    targetPort,
    telegramErrorNotifyEnabled: Boolean(source.telegramErrorNotifyEnabled),
    proxyProtocolReceive: Boolean(source.proxyProtocolReceive),
    proxyProtocolSend: Boolean(source.proxyProtocolSend),
    proxyProtocolExitReceive: Boolean(source.proxyProtocolExitReceive),
    proxyProtocolExitSend: Boolean(source.proxyProtocolExitSend),
    proxyProtocolVersion: normalizeProxyProtocolVersion(source.proxyProtocolVersion),
    tcpFastOpen: Boolean(source.tcpFastOpen),
    zeroCopy: Boolean(source.zeroCopy),
    udpOverTcp: Boolean(source.udpOverTcp),
    udpOverTcpPort: Number(source.udpOverTcpPort || 0),
    failoverEnabled: Boolean(source.failoverEnabled),
    failoverStrategy: normalizeFailoverStrategy(source.failoverStrategy),
    failoverTargets: parseRuleFailoverTargets(source.failoverTargets),
    failoverSeconds: normalizePositiveRuleNumber(source.failoverSeconds, 60),
    recoverSeconds: normalizePositiveRuleNumber(source.recoverSeconds, 120),
    autoFailback: source.autoFailback !== false,
  };
}

function normalizeRuleTransferFile(raw: unknown): RuleTransferFile {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as RuleTransferFile;
  return {
    kind: typeof source.kind === "string" ? source.kind : undefined,
    version: typeof source.version === "number" ? source.version : undefined,
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : undefined,
    scope: source.scope && typeof source.scope === "object"
      ? {
          type: typeof source.scope.type === "string" ? source.scope.type : undefined,
          id: typeof source.scope.id === "number" ? source.scope.id : undefined,
          name: typeof source.scope.name === "string" ? source.scope.name : undefined,
        }
      : undefined,
    rules: Array.isArray(source.rules) ? source.rules : undefined,
  };
}

function normalizeFailoverTargetsForSubmit(text: string) {
  const targets: Array<{ targetIp: string; targetPort: number }> = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 10) return { error: "备用出站最多支持 10 个" };
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = splitFailoverTargetLine(lines[index]);
    if (!parsed) continue;
    if ("error" in parsed) return { error: `第 ${index + 1} 行：${parsed.error}` };
    const targetIp = parsed.targetIp;
    const targetPort = parsed.targetPort;
    if (!isValidTargetHost(targetIp)) {
      return { error: `第 ${index + 1} 行：地址格式不正确` };
    }
    if (!isValidPort(targetPort)) {
      return { error: `第 ${index + 1} 行：端口必须在 1-65535 之间` };
    }
    targets.push({ targetIp, targetPort });
  }
  return { targets };
}

function RulesContent() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  const [secondaryQueriesReady, setSecondaryQueriesReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSecondaryQueriesReady(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  const { data: rules, isLoading } = trpc.rules.list.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
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
    refetchInterval: pollingInterval("normal"),
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });
  const { data: systemSettings, isFetched: systemSettingsFetched } = trpc.system.getSettings.useQuery(undefined, {
    enabled: secondaryQueriesReady,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: wallet, isLoading: walletLoading } = trpc.billing.me.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const { data: trafficBilling, isLoading: trafficBillingLoading } = trpc.trafficBilling.status.useQuery(undefined, {
    enabled: user?.role !== "admin" && secondaryQueriesReady,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteRule, setDeleteRule] = useState<any | null>(null);
  const [resetTrafficTarget, setResetTrafficTarget] = useState<{ scope: "all" } | { scope: "rule"; rule: any } | null>(null);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const [filterHost, setFilterHost] = useState<string>(() => getStoredString(RULE_FILTER_HOST_STORAGE_KEY, "all"));
  const [filterUser, setFilterUser] = useState<string>(() => getStoredString(RULE_FILTER_USER_STORAGE_KEY, "self"));
  const [ruleSearchQuery, setRuleSearchQuery] = useState("");
  const [ruleCategory, setRuleCategory] = useUrlTab<RuleCategory>({
    values: RULE_CATEGORIES,
    defaultValue: "all",
    storageKey: RULE_CATEGORY_STORAGE_KEY,
  });
  const [viewMode, setViewMode] = useState<RuleViewMode>(() => getStoredRuleViewMode());
  const [ruleCardSize, setRuleCardSize] = useState<RuleCardSize>(() => getStoredRuleCardSize());
  const effectiveViewMode: RuleViewMode = isMobile ? "card" : viewMode;
  const effectiveRuleCardSize: RuleCardSize = isMobile ? "standard" : ruleCardSize;
  const [rulePageSize, setRulePageSize] = useState<RulePageSize>(() =>
    getStoredRulePageSize(getStoredRuleCardSize() === "compact" ? 24 : 12)
  );
  const [ruleGroupCollapsed, setRuleGroupCollapsed] = useState<RuleGroupCollapsedState>(() => getStoredRuleGroupCollapsed());
  const selectedRulesQuery = useMemo(() => {
    if (user?.role !== "admin") return undefined;
    const input: { userId?: number; scope?: "self" | "all"; hostId?: number } = {};
    if (filterUser === "all") {
      input.scope = "all";
    } else if (filterUser === "self") {
      input.userId = Number(user.id);
    } else {
      input.userId = Number(filterUser);
    }
    return Object.keys(input).length ? input : undefined;
  }, [filterUser, user?.id, user?.role]);
  const effectiveRulesQuery = selectedRulesQuery || undefined;
  const selectedScopeQueryEnabled = user?.role === "admin" && !!effectiveRulesQuery;
  const [portStatus, setPortStatus] = useState<"idle" | "checking" | "available" | "used">("idle");
  const [portRangeError, setPortRangeError] = useState<string | null>(null);
  const latestPortCheckRef = useRef(0);
  const [copySourceHostId, setCopySourceHostId] = useState<string>("");
  const [copyTargetHostIds, setCopyTargetHostIds] = useState<number[]>([]);
  const [copyRuleIds, setCopyRuleIds] = useState<number[]>([]);
  const [copyConflictStrategy, setCopyConflictStrategy] = useState<"skip" | "auto" | "error">("skip");
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportScopeType, setExportScopeType] = useState<RuleTransferScopeType>("local");
  const [exportResourceId, setExportResourceId] = useState("");
  const [exportResourceSearch, setExportResourceSearch] = useState("");
  const [importScopeType, setImportScopeType] = useState<RuleTransferScopeType>("local");
  const [importResourceId, setImportResourceId] = useState("");
  const [importResourceSearch, setImportResourceSearch] = useState("");
  const [importFile, setImportFile] = useState<RuleTransferFile | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importFileError, setImportFileError] = useState("");
  const [importFileInputKey, setImportFileInputKey] = useState(0);
  const [importingRules, setImportingRules] = useState(false);
  const { data: selectedScopeRules } = trpc.rules.list.useQuery(effectiveRulesQuery as any, {
    enabled: selectedScopeQueryEnabled,
    refetchInterval: pollingInterval("normal"),
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });

  const walletBalanceKnown = wallet?.balanceCents !== undefined && wallet?.balanceCents !== null;
  const manuallyPaused = (user as any)?.forwardAccessPauseReason === "manual";
  const hasTrafficBillingBalance = !manuallyPaused && !!trafficBilling?.enabled && !!trafficBilling?.hasUsableResources && walletBalanceKnown && Number(wallet?.balanceCents || 0) > 0;
  // 权限检查：管理员、有 canAddRules 权限，或本地已确认流量计费余额可用
  const canAdd = user?.role === "admin" || user?.canAddRules === true || hasTrafficBillingBalance;
  const rulePermissionLoading = user?.role !== "admin" && user?.canAddRules !== true && (!secondaryQueriesReady || walletLoading || trafficBillingLoading);

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


  const importCreateMutation = trpc.rules.create.useMutation();

  const [trafficDetailRule, setTrafficDetailRule] = useState<{ id: number; name: string; isForwardChain?: boolean; probeMethod?: "tcping" | "ping" } | null>(null);
  const [selfTestRule, setSelfTestRule] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    prefetchReactGlobe();
  }, []);

  const setRouteMode = (mode: RuleRouteMode) => {
    if (mode === form.routeMode) return;
    if (mode === "local" && !canUseLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    const nextGroups = mode === "chain"
      ? availableForwardChainGroups
      : mode === "group"
      ? availableFailoverForwardGroups
      : [];
    const nextTunnel = mode === "tunnel"
      ? (selectedTunnel || availableTunnels[0] || supportedTunnels[0])
      : null;
    if (mode === "tunnel" && !nextTunnel) return;
    if (isForwardGroupRouteModeValue(mode) && nextGroups.length === 0) return;
    const expectedGroupMode = mode === "chain" ? "chain" : "failover";
    const nextGroup = isForwardGroupRouteModeValue(mode)
      ? (selectedForwardGroup && normalizeForwardGroupModeForRule(selectedForwardGroup) === expectedGroupMode ? selectedForwardGroup : nextGroups[0])
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
      forwardGroupId: isForwardGroupRouteModeValue(mode) && nextGroup ? Number(nextGroup.id) : null,
      hostId: mode === "tunnel" && nextTunnel ? nextTunnel.entryHostId : isForwardGroupRouteModeValue(mode) ? null : prev.hostId,
      failoverEnabled: mode === "chain" ? false : prev.failoverEnabled,
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
    setForm({ ...defaultForm, failoverTargetsText: "" });
    setEditingId(null);
    setPortStatus("idle");
  };

  const openCreate = () => {
    resetForm();
    const firstForwardType = canUseLocalForward ? usableForwardTypes[0] : undefined;
    const firstTunnel = canUseGost
      ? supportedTunnels[0]
      : null;
    const firstChain = canUseForwardChain ? availableForwardChainGroups[0] : null;
    const firstGroup = canUseFailoverGroup ? availableFailoverForwardGroups[0] : null;
    const firstForwardGroup = firstChain || firstGroup;
    if (firstForwardType || firstTunnel || firstForwardGroup) {
      setForm({
        ...defaultForm,
        failoverTargetsText: "",
        routeMode: firstForwardType ? "local" : firstTunnel ? "tunnel" : firstChain ? "chain" : firstGroup ? "group" : "local",
        hostId: firstForwardType ? hosts?.[0]?.id ?? null : firstTunnel ? firstTunnel.entryHostId : null,
        forwardType: firstTunnel && !firstForwardType ? "gost" : firstGroup && firstGroup?.groupType === "tunnel" ? "gost" : firstForwardType ?? "iptables",
        tunnelId: firstTunnel && !firstForwardType ? firstTunnel.id : null,
        forwardGroupId: !firstForwardType && !firstTunnel && firstForwardGroup ? Number(firstForwardGroup.id) : null,
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
    const editForwardGroup = rule.forwardGroupId
      ? (forwardGroups || []).find((group: any) => Number(group.id) === Number(rule.forwardGroupId))
      : null;
    setForm({
      hostId: rule.hostId,
      name: rule.name,
      routeMode: rule.forwardGroupId ? (isForwardChainGroup(editForwardGroup) ? "chain" : "group") : rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local",
      forwardType: rule.forwardType,
      protocol: rule.protocol,
      gostMode: "direct" as const,
      gostRelayHost: "",
      gostRelayPort: 0,
      tunnelId: rule.tunnelId || null,
      forwardGroupId: rule.forwardGroupId || null,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      telegramErrorNotifyEnabled: !!rule.telegramErrorNotifyEnabled,
      blockHttp: false,
      blockSocks: false,
      blockTls: false,
      proxyProtocolReceive: !!rule.proxyProtocolReceive,
      proxyProtocolSend: !!rule.proxyProtocolSend,
      proxyProtocolExitReceive: !!rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: !!rule.proxyProtocolExitSend,
      proxyProtocolVersion: normalizeProxyProtocolVersion(rule.proxyProtocolVersion),
      tcpFastOpen: !!rule.tcpFastOpen,
      zeroCopy: !!rule.zeroCopy,
      udpOverTcp: !!rule.udpOverTcp,
      udpOverTcpPort: Number(rule.udpOverTcpPort || 0),
      failoverEnabled: !!rule.failoverEnabled,
      failoverStrategy: normalizeFailoverStrategy(rule.failoverStrategy),
      failoverTargetsText: formatFailoverTargetsText(rule.failoverTargets),
      failoverSeconds: Number(rule.failoverSeconds || 60),
      recoverSeconds: Number(rule.recoverSeconds || 120),
      autoFailback: rule.autoFailback !== false,
    });
    setEditingId(rule.id);
    setPortStatus("idle");
    setShowDialog(true);
  };

  // 端口占用检测
  const checkPortMutation = trpc.rules.checkPort.useQuery(
    {
      hostId: form.hostId || 0,
      tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
      sourcePort: form.sourcePort,
      excludeRuleId: editingId || undefined,
    },
    {
      enabled: false,
    }
  );

  // 获取当前选中主机的端口区间
  const selectedHost = useMemo(() => {
    if (isForwardGroupRouteModeValue(form.routeMode)) return null;
    if (!form.hostId || !hosts) return null;
    return hosts.find((h: any) => h.id === form.hostId) || null;
  }, [form.hostId, form.routeMode, hosts]);
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
    if (mode === "nginx_tls") return "nginx_stream";
    return (["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp", "nginx_stream", "nginx_tls"] as const).includes(mode as any)
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
  const selectedEntryPortPolicy = useMemo(() => {
    if (!selectedHost) return portPolicyFrom(null);
    let policy = portPolicyFrom(selectedHost);
    if (form.routeMode === "tunnel" && selectedTunnel) {
      policy = combinePortPolicies(
        policy,
        portPolicyFrom({
          portRangeStart: (selectedTunnel as any).portRangeStart,
          portRangeEnd: (selectedTunnel as any).portRangeEnd,
        }),
      );
    }
    return policy;
  }, [form.routeMode, selectedHost, selectedTunnel]);
  const sourcePortRangeText = useMemo(() => describePortPolicy(selectedEntryPortPolicy), [selectedEntryPortPolicy]);
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
        title: `允许端口范围: ${sourcePortRangeText}`,
      };
    }
    return null;
  }, [portRangeError, portStatus, sourcePortRangeText]);
  const tunnelById = useMemo(() => {
    const map = new Map<number, any>();
    (tunnels || []).forEach((tunnel: any) => map.set(Number(tunnel.id), tunnel));
    return map;
  }, [tunnels]);
  const hostById = useMemo(() => {
    const map = new Map<number, any>();
    (hosts || []).forEach((host: any) => map.set(Number(host.id), host));
    return map;
  }, [hosts]);
  const selectedTunnelDisplay = useMemo(() => getTunnelDisplay(selectedTunnel), [selectedTunnel]);
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
  useEffect(() => {
    if (!String(filterHost).startsWith("group:")) return;
    setFilterHost("all");
    storeString(RULE_FILTER_HOST_STORAGE_KEY, "all");
  }, [filterHost]);
  const getRuleEntryHostIdForSort = useCallback((rule: any) => {
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    if (group) {
      const member = [...(group.members || [])]
        .filter((item: any) => item.isEnabled !== false)
        .sort((a: any, b: any) => Number(a.priority) - Number(b.priority))
        .find((item: any) => Number(item.hostId || 0) > 0 || Number(item.tunnelId || 0) > 0);
      if (Number(member?.hostId || 0) > 0) return Number(member.hostId);
      if (Number(member?.tunnelId || 0) > 0) {
        const tunnel = tunnelById.get(Number(member.tunnelId));
        if (Number(tunnel?.entryHostId || 0) > 0) return Number(tunnel.entryHostId);
      }
    }
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    if (Number(tunnel?.entryHostId || 0) > 0) return Number(tunnel.entryHostId);
    return Number(rule.hostId || 0);
  }, [forwardGroupById, tunnelById]);
  const availableForwardGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => isSelectableForwardRuleGroup(group) && group.isEnabled && (group.members || []).length > 0),
    [forwardGroups]
  );
  const availableForwardChainGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => isForwardChainGroup(group)),
    [availableForwardGroups]
  );
  const availableFailoverForwardGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => normalizeForwardGroupModeForRule(group) === "failover"),
    [availableForwardGroups]
  );
  const transferChainGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => isForwardChainGroup(group)),
    [forwardGroups]
  );
  const transferRuleGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => normalizeForwardGroupModeForRule(group) === "failover"),
    [forwardGroups]
  );
  const getTransferResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return hosts || [];
    if (type === "tunnel") return tunnels || [];
    if (type === "chain") return transferChainGroups;
    return transferRuleGroups;
  }, [hosts, tunnels, transferChainGroups, transferRuleGroups]);
  const exportResources = useMemo(() => getTransferResources(exportScopeType), [exportScopeType, getTransferResources]);
  const importResources = useMemo(() => getTransferResources(importScopeType), [importScopeType, getTransferResources]);
  useEffect(() => {
    const firstId = exportResources[0]?.id;
    if (!firstId) {
      if (exportResourceId) setExportResourceId("");
      return;
    }
    if (!exportResources.some((item: any) => String(item.id) === exportResourceId)) {
      setExportResourceId(String(firstId));
    }
  }, [exportResourceId, exportResources]);
  useEffect(() => {
    const firstId = importResources[0]?.id;
    if (!firstId) {
      if (importResourceId) setImportResourceId("");
      return;
    }
    if (!importResources.some((item: any) => String(item.id) === importResourceId)) {
      setImportResourceId(String(firstId));
    }
  }, [importResourceId, importResources]);
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
  const canUseForwardChain = availableForwardChainGroups.length > 0;
  const canUseFailoverGroup = availableFailoverForwardGroups.length > 0;
  const canCreateRule = canUseLocalForward || canUseGost || canUseForwardChain || canUseFailoverGroup;
  const isForwardGroupRouteMode = isForwardGroupRouteModeValue(form.routeMode);
  const telegramBotReady = !!systemSettings?.telegram?.enabled && !!systemSettings?.telegram?.configured;
  const selectedForwardGroupIsChain = form.routeMode === "chain" || isForwardChainGroup(selectedForwardGroup);
  const mainBackupForwardType = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel") ? "gost" : form.forwardType;
  const mainBackupIsTunnelRoute = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel");
  const canAutoSwitchMainBackupToGost = !selectedForwardGroupIsChain
    && mainBackupForwardType !== "gost"
    && usableForwardTypes.includes("gost")
    && user?.role === "admin"
    && (form.routeMode === "local" || (form.routeMode === "group" && selectedForwardGroup?.groupType === "host"));
  const canUseMainBackup = !selectedForwardGroupIsChain
    && (
      (mainBackupForwardType === "gost" && (user?.role === "admin" || mainBackupIsTunnelRoute))
      || canAutoSwitchMainBackupToGost
    );
  const mainBackupDisabledText = mainBackupForwardType !== "gost" && !canAutoSwitchMainBackupToGost
    ? "仅 GOST 端口转发、GOST 隧道和自定义加密隧道支持出站策略。"
    : selectedForwardGroupIsChain
    ? "端口转发链不支持出站策略。"
    : user?.role !== "admin" && !mainBackupIsTunnelRoute
    ? "普通端口转发不支持出站策略，请使用隧道转发。"
    : form.protocol !== "tcp"
    ? "出站策略仅支持 TCP 协议。"
    : "";
  const proxyProtocolForwardType = mainBackupForwardType;
  const proxyProtocolProtocolSupported = form.protocol === "tcp" || form.protocol === "both";
  const isTunnelProxyProtocolMode = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel");
  const canUseProxyProtocol = !selectedForwardGroupIsChain
    && proxyProtocolProtocolSupported
    && (proxyProtocolForwardType === "gost" || proxyProtocolForwardType === "realm");
  const proxyProtocolDisabledText = selectedForwardGroupIsChain
    ? "端口转发链不支持 PROXY Protocol。"
    : !proxyProtocolProtocolSupported
    ? "PROXY Protocol 仅支持 TCP 协议。"
    : proxyProtocolForwardType !== "gost" && proxyProtocolForwardType !== "realm"
    ? "当前转发工具不支持 PROXY Protocol。"
    : "";
  const proxyProtocolAnyEnabled = form.proxyProtocolReceive || form.proxyProtocolSend || form.proxyProtocolExitReceive || form.proxyProtocolExitSend;
  const isForwardXTunnelMode = isTunnelProxyProtocolMode && String(selectedTunnel?.mode || "").toLowerCase() === "forwardx";
  const canUseTcpFastOpen = !selectedForwardGroupIsChain
    && proxyProtocolProtocolSupported
    && (proxyProtocolForwardType === "realm" || (proxyProtocolForwardType === "gost" && isForwardXTunnelMode));
  const canUseZeroCopy = !selectedForwardGroupIsChain
    && proxyProtocolProtocolSupported
    && proxyProtocolForwardType === "realm"
    && !isTunnelProxyProtocolMode;
  const canUseUdpOverTcp = !selectedForwardGroupIsChain
    && (form.protocol === "udp" || form.protocol === "both")
    && proxyProtocolForwardType === "gost"
    && isForwardXTunnelMode;
  const transportTuningDisabledText = selectedForwardGroupIsChain
    ? "端口转发链不支持传输优化。"
    : !proxyProtocolProtocolSupported && form.protocol !== "udp"
    ? "当前协议不支持可用传输优化。"
    : "当前转发工具不支持该优化。";

  const kernelForwardWarning = useMemo(() => buildKernelForwardWarning({
    rule: form,
    host: selectedHost,
    group: selectedForwardGroup,
    hosts: hosts || [],
    hostById,
    forwardGroupById,
  }), [form, selectedHost, selectedForwardGroup, hosts, hostById, forwardGroupById]);
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
    if (isForwardGroupRouteMode) {
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
    if (!isPortAllowedByPolicy(sourcePort, selectedEntryPortPolicy)) {
      setPortRangeError(`端口必须在允许范围 ${describePortPolicy(selectedEntryPortPolicy)} 内`);
      setPortStatus("used");
      return;
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
  }, [form.hostId, form.routeMode, form.sourcePort, form.tunnelId, editingId, utils, selectedEntryPortPolicy, isForwardGroupRouteMode]);

  // 源端口变化时自动检测
  useEffect(() => {
    if (isForwardGroupRouteMode) {
      setPortStatus("idle");
      return;
    }
    if (form.sourcePort > 0 && form.hostId) {
      const timer = setTimeout(checkPort, 500);
      return () => clearTimeout(timer);
    } else {
      setPortStatus("idle");
    }
  }, [form.sourcePort, form.hostId, form.routeMode, checkPort, isForwardGroupRouteMode]);

  useEffect(() => {
    if (form.routeMode !== "local") return;
    if (usableForwardTypes.length === 0) return;
    if (!usableForwardTypes.includes(form.forwardType)) {
      setForm((prev) => ({ ...prev, forwardType: usableForwardTypes[0], tunnelId: null }));
    }
  }, [form.forwardType, form.routeMode, usableForwardTypes]);

  useEffect(() => {
    if (!isForwardGroupRouteMode) return;
    const candidates = form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups;
    if (!selectedForwardGroup && candidates.length > 0) {
      setForm((prev) => ({ ...prev, forwardGroupId: Number(candidates[0].id) }));
      return;
    }
    const expectedGroupMode = form.routeMode === "chain" ? "chain" : "failover";
    if (selectedForwardGroup && normalizeForwardGroupModeForRule(selectedForwardGroup) !== expectedGroupMode) {
      setForm((prev) => ({
        ...prev,
        forwardGroupId: candidates[0] ? Number(candidates[0].id) : null,
        failoverEnabled: form.routeMode === "chain" ? false : prev.failoverEnabled,
      }));
      return;
    }
    if (!isForwardChainGroup(selectedForwardGroup) && selectedForwardGroup?.groupType === "tunnel" && form.forwardType !== "gost") {
      setForm((prev) => ({ ...prev, forwardType: "gost" }));
    }
  }, [availableFailoverForwardGroups, availableForwardChainGroups, form.forwardType, form.routeMode, isForwardGroupRouteMode, selectedForwardGroup]);

  useEffect(() => {
    if (!form.failoverEnabled || canUseMainBackup) return;
    setForm((prev) => ({ ...prev, failoverEnabled: false }));
  }, [canUseMainBackup, form.failoverEnabled]);

  useEffect(() => {
    if (!systemSettingsFetched) return;
    if (telegramBotReady || !form.telegramErrorNotifyEnabled) return;
    setForm((prev) => prev.telegramErrorNotifyEnabled ? { ...prev, telegramErrorNotifyEnabled: false } : prev);
  }, [form.telegramErrorNotifyEnabled, systemSettingsFetched, telegramBotReady]);

  useEffect(() => {
    if (canUseProxyProtocol) return;
    if (!form.proxyProtocolReceive && !form.proxyProtocolSend && !form.proxyProtocolExitReceive && !form.proxyProtocolExitSend) return;
    setForm((prev) => ({
      ...prev,
      proxyProtocolReceive: false,
      proxyProtocolSend: false,
      proxyProtocolExitReceive: false,
      proxyProtocolExitSend: false,
    }));
  }, [canUseProxyProtocol, form.proxyProtocolExitReceive, form.proxyProtocolExitSend, form.proxyProtocolReceive, form.proxyProtocolSend]);

  useEffect(() => {
    if ((canUseTcpFastOpen || !form.tcpFastOpen) && (canUseZeroCopy || !form.zeroCopy) && (canUseUdpOverTcp || !form.udpOverTcp) && !form.udpOverTcpPort) return;
    setForm((prev) => ({
      ...prev,
      tcpFastOpen: canUseTcpFastOpen ? prev.tcpFastOpen : false,
      zeroCopy: canUseZeroCopy ? prev.zeroCopy : false,
      udpOverTcp: canUseUdpOverTcp ? prev.udpOverTcp : false,
      udpOverTcpPort: 0,
    }));
  }, [canUseTcpFastOpen, canUseZeroCopy, canUseUdpOverTcp, form.tcpFastOpen, form.zeroCopy, form.udpOverTcp, form.udpOverTcpPort]);

  // 随机分配端口
  const handleRandomPort = async () => {
    if (isForwardGroupRouteMode) {
      if (!form.forwardGroupId) {
        toast.error(form.routeMode === "chain" ? "请先选择转发链" : "请先选择转发组");
        return;
      }
    } else if (!form.hostId) {
      toast.error("请先选择主机");
      return;
    }
    try {
      const randomPortInput = isForwardGroupRouteMode
        ? { forwardGroupId: Number(form.forwardGroupId), excludeRuleId: editingId || undefined }
        : { hostId: Number(form.hostId), tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null, excludeRuleId: editingId || undefined };
      const result = await utils.rules.randomPort.fetch(randomPortInput);
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

  const handleConfirmResetTraffic = () => {
    if (!resetTrafficTarget) return;
    if (resetTrafficTarget.scope === "rule") {
      resetTrafficMutation.mutate({
        scope: "rule",
        ruleId: Number(resetTrafficTarget.rule?.id || 0),
      });
      return;
    }
    resetTrafficMutation.mutate({
      scope: "all",
      ruleIds: visibleRuleIdsForMetrics,
    });
  };

  const setProxyProtocolFlag = (field: ProxyProtocolField, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      [field]: checked,
    }));
  };

  const renderProxyProtocolSwitch = (label: string, field: ProxyProtocolField) => (
    <div className="flex min-h-9 items-center justify-between gap-3 rounded-md bg-background/65 px-3 py-1.5 ring-1 ring-border/40">
      <Label className="min-w-0 text-sm" title={label}>{label}</Label>
      <Switch
        checked={form[field]}
        disabled={!canUseProxyProtocol}
        onCheckedChange={(checked) => setProxyProtocolFlag(field, checked)}
      />
    </div>
  );

  const renderProxyProtocolRow = (
    title: string,
    firstLabel: string,
    firstField: ProxyProtocolField,
    secondLabel: string,
    secondField: ProxyProtocolField,
  ) => (
    <div className="grid gap-2 rounded-md border border-border/45 bg-background/35 p-2 sm:grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
      <div className="flex h-9 items-center rounded-md bg-muted/60 px-3 text-sm font-medium text-muted-foreground sm:justify-center sm:px-2">
        {title}
      </div>
      {renderProxyProtocolSwitch(firstLabel, firstField)}
      {renderProxyProtocolSwitch(secondLabel, secondField)}
    </div>
  );

  const renderTransportTuningSwitch = (
    label: string,
    description: string,
    field: "tcpFastOpen" | "zeroCopy" | "udpOverTcp",
    enabled: boolean,
  ) => (
    <div className="flex min-h-10 items-center justify-between gap-3 rounded-md bg-background/65 px-3 py-2 ring-1 ring-border/40">
      <div className="min-w-0">
        <Label className="block truncate text-sm" title={label}>{label}</Label>
        <p className="truncate text-[11px] text-muted-foreground" title={enabled ? description : transportTuningDisabledText}>
          {enabled ? description : transportTuningDisabledText}
        </p>
      </div>
      <Switch
        checked={enabled ? form[field] : false}
        disabled={!enabled}
        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, [field]: checked }))}
      />
    </div>
  );

  const handleSubmit = () => {
    const submitForwardType = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel")
      ? "gost"
      : form.forwardType;
    if (!form.name || !form.targetIp || !form.targetPort || (!isForwardGroupRouteMode && !form.hostId)) {
      toast.error("请填写所有必填字段（目标端口必须填写）");
      return;
    }
    if (isForwardGroupRouteMode && !form.forwardGroupId) {
      toast.error(form.routeMode === "chain" ? "请选择转发链" : "请选择转发组");
      return;
    }
    if (form.routeMode === "chain" && !canUseForwardChain) {
      toast.error("暂无可用转发链");
      return;
    }
    if (form.routeMode === "group" && !canUseFailoverGroup) {
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
    if (form.routeMode === "group" && !selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel" && !isProtocolEnabled("gost")) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (!isValidPort(form.sourcePort, !isForwardGroupRouteMode && !editingId)) {
      toast.error(isForwardGroupRouteMode || editingId ? "入口端口必须在 1-65535 之间" : "入口端口必须为 0 或 1-65535，0 表示随机分配");
      return;
    }
    if (!isValidPort(form.targetPort)) {
      toast.error("目标端口必须在 1-65535 之间");
      return;
    }
    if (form.telegramErrorNotifyEnabled && !telegramBotReady) {
      toast.error("请先在系统设置中配置并启用 Telegram 机器人，再开启异常TG提醒");
      return;
    }
    if ((form.proxyProtocolReceive || form.proxyProtocolSend || form.proxyProtocolExitReceive || form.proxyProtocolExitSend) && !canUseProxyProtocol) {
      toast.error(proxyProtocolDisabledText || "当前规则不支持 PROXY Protocol");
      return;
    }
    const failoverSubmit = normalizeFailoverTargetsForSubmit(form.failoverTargetsText);
    if (failoverSubmit.error) {
      toast.error(failoverSubmit.error);
      return;
    }
    const failoverTargets = failoverSubmit.targets || [];
    if (form.failoverEnabled) {
      if (!canUseMainBackup) {
        toast.error(mainBackupDisabledText || "当前规则类型不支持出站策略");
        return;
      }
      if (form.protocol !== "tcp") {
        toast.error("出站策略当前仅支持 TCP 协议");
        return;
      }
      if (failoverTargets.length === 0) {
        toast.error("启用出站策略后至少需要填写一个备用出站");
        return;
      }
      if (!Number.isInteger(form.failoverSeconds) || form.failoverSeconds < 10 || form.failoverSeconds > 3600) {
        toast.error("健康检查切换时间必须在 10-3600 秒之间");
        return;
      }
      if (!Number.isInteger(form.recoverSeconds) || form.recoverSeconds < 10 || form.recoverSeconds > 3600) {
        toast.error("恢复观察时间必须在 10-3600 秒之间");
        return;
      }
    }
    const failoverPayload = {
      failoverEnabled: selectedForwardGroupIsChain ? false : form.failoverEnabled,
      failoverStrategy: form.failoverStrategy,
      failoverTargets: selectedForwardGroupIsChain ? [] : form.failoverEnabled ? failoverTargets : [],
      failoverSeconds: form.failoverSeconds || 60,
      recoverSeconds: form.recoverSeconds || 120,
      autoFailback: form.autoFailback,
    };
    const proxyProtocolPayload = {
      proxyProtocolReceive: canUseProxyProtocol ? form.proxyProtocolReceive : false,
      proxyProtocolSend: canUseProxyProtocol ? form.proxyProtocolSend : false,
      proxyProtocolExitReceive: canUseProxyProtocol && isTunnelProxyProtocolMode ? form.proxyProtocolExitReceive : false,
      proxyProtocolExitSend: canUseProxyProtocol && isTunnelProxyProtocolMode ? form.proxyProtocolExitSend : false,
      proxyProtocolVersion: canUseProxyProtocol && proxyProtocolAnyEnabled ? form.proxyProtocolVersion : 1,
    };
    const transportTuningPayload = {
      tcpFastOpen: canUseTcpFastOpen ? form.tcpFastOpen : false,
      zeroCopy: canUseZeroCopy ? form.zeroCopy : false,
      udpOverTcp: canUseUdpOverTcp ? form.udpOverTcp : false,
      udpOverTcpPort: null,
    };
    if (!isForwardGroupRouteMode && portStatus === "used") {
      toast.error("源端口已被占用，请更换端口或使用随机分配");
      return;
    }
    if (!editingId && !isForwardGroupRouteMode && form.sourcePort > 0 && portStatus !== "available") {
      toast.error("请等待端口可用后再保存");
      return;
    }
    if (kernelForwardWarning) {
      toast.warning(kernelForwardWarning, { duration: 7000 });
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        hostId: isForwardGroupRouteMode ? undefined : form.hostId!,
        name: form.name,
        forwardType: submitForwardType,
        protocol: form.protocol,
        gostMode: "direct" as const,
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: isForwardGroupRouteMode ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        isEnabled: portStatus === "available" ? true : undefined,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        telegramErrorNotifyEnabled: form.telegramErrorNotifyEnabled,
        ...proxyProtocolPayload,
        ...transportTuningPayload,
        ...failoverPayload,
      });
    } else {
      createMutation.mutate({
        hostId: isForwardGroupRouteMode ? undefined : form.hostId!,
        name: form.name,
        forwardType: submitForwardType,
        protocol: form.protocol,
        gostMode: "direct" as const,
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: isForwardGroupRouteMode ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        telegramErrorNotifyEnabled: form.telegramErrorNotifyEnabled,
        ...proxyProtocolPayload,
        ...transportTuningPayload,
        ...failoverPayload,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const ruleFilters = useMemo<RuleFilterState>(() => ({
    filterUser,
    filterHost,
    ruleCategory,
    searchQuery: ruleSearchQuery,
    isAdmin: user?.role === "admin",
    userId: user?.id,
    hostById,
    tunnelById,
    userById,
    forwardGroupById,
    getRuleEntryHostId: getRuleEntryHostIdForSort,
  }), [filterHost, forwardGroupById, getRuleEntryHostIdForSort, hostById, ruleCategory, ruleSearchQuery, filterUser, tunnelById, user?.id, user?.role, userById]);
  const baseScopedRules = useMemo(() => rules || [], [rules]);
  const selectedScopedRules = selectedScopeQueryEnabled ? selectedScopeRules : undefined;
  const scopedRulesReady = selectedScopeQueryEnabled ? selectedScopedRules !== undefined : !!rules;
  const [stableFilteredRules, setStableFilteredRules] = useState<any[]>([]);
  const [filteredRulesPrimed, setFilteredRulesPrimed] = useState(false);
  useEffect(() => {
    if (!scopedRulesReady) return;
    const sourceRules = selectedScopeQueryEnabled ? selectedScopedRules || [] : baseScopedRules;
    setStableFilteredRules(sourceRules.filter((rule: any) => isForwardRuleVisibleByFilters(rule, ruleFilters)));
    setFilteredRulesPrimed(true);
  }, [baseScopedRules, ruleFilters, scopedRulesReady, selectedScopedRules, selectedScopeQueryEnabled]);
  const filteredRules = stableFilteredRules;
  const transferSourceRules = selectedScopeQueryEnabled ? selectedScopedRules || [] : baseScopedRules;
  const ruleCategoryCounts = useMemo(() => {
    const sourceRules = selectedScopeQueryEnabled ? selectedScopedRules || [] : baseScopedRules;
    const baseFilters = {
      ...ruleFilters,
      ruleCategory: "all" as RuleCategory,
    };
    const counts: Record<RuleCategory, number> = { all: 0, local: 0, tunnel: 0, chain: 0, group: 0 };
    sourceRules
      .filter((rule: any) => isForwardRuleVisibleByFilters(rule, baseFilters))
      .forEach((rule: any) => {
        const category = getRuleCategory(rule, forwardGroupById);
        counts.all += 1;
        counts[category] += 1;
      });
    return counts;
  }, [baseScopedRules, forwardGroupById, ruleFilters, selectedScopeQueryEnabled, selectedScopedRules]);
  const visibleRuleIdsForMetrics = useMemo(() => (
    Array.from(new Set(filteredRules.map((rule: any) => Number(rule.id)).filter((id: number) => Number.isInteger(id) && id > 0)))
  ), [filteredRules]);
  const selfTestRuleDetail = useMemo(() => {
    if (!selfTestRule) return null;
    return [...(rules || []), ...(selectedScopedRules || [])]
      .find((rule: any) => Number(rule.id) === Number(selfTestRule.id)) || null;
  }, [rules, selectedScopedRules, selfTestRule?.id]);
  const selfTestTargetAddress = useMemo(() => {
    const target = String(selfTestRuleDetail?.targetIp || "").trim();
    return target ? normalizeAddressKey(target) : "";
  }, [selfTestRuleDetail?.targetIp]);
  const ruleGlobeTargetAddresses = useMemo(() => (
    Array.from(new Set(
      filteredRules
        .map((rule: any) => String(rule.targetIp || "").trim())
        .filter(Boolean)
        .map((address: string) => normalizeAddressKey(address))
    )).slice(0, 100)
  ), [filteredRules]);
  const ruleTargetGeoAddresses = useMemo(() => (
    Array.from(new Set([
      ...(effectiveViewMode === "globe" ? ruleGlobeTargetAddresses : []),
      selfTestTargetAddress,
    ].filter(Boolean))).slice(0, 100)
  ), [effectiveViewMode, ruleGlobeTargetAddresses, selfTestTargetAddress]);
  const { data: ruleTargetGeoRows, isFetched: ruleTargetGeoFetched, isError: ruleTargetGeoError } = trpc.rules.targetGeoBatch.useQuery(
    { targets: ruleTargetGeoAddresses },
    {
      enabled: ruleTargetGeoAddresses.length > 0,
      staleTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );
  const targetGeoLookupReady = effectiveViewMode !== "globe" || ruleGlobeTargetAddresses.length === 0 || ruleTargetGeoFetched || ruleTargetGeoError;
  const targetGeoByAddress = useMemo(() => {
    const map = new Map<string, RuleTargetGeo>();
    (ruleTargetGeoRows || []).forEach((row: any) => {
      if (!row?.target || !row.geo) return;
      map.set(normalizeAddressKey(row.target), row.geo as RuleTargetGeo);
    });
    return map;
  }, [ruleTargetGeoRows]);
  const trafficRangeLabel = "近 24h";
  const trafficMetricHeaderLabels = ["累计", "24H", "延迟"];

  const { data: totalTrafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "total", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0,
      refetchInterval: pollingInterval("normal"),
      staleTime: 5000,
      refetchOnWindowFocus: false,
    }
  );
  const { data: dailyTrafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "24h", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0,
      refetchInterval: pollingInterval("normal"),
      staleTime: 5000,
      refetchOnWindowFocus: false,
    }
  );
  const [stableTotalTrafficSummaryRows, setStableTotalTrafficSummaryRows] = useState<any[]>([]);
  const [stableDailyTrafficSummaryRows, setStableDailyTrafficSummaryRows] = useState<any[]>([]);
  const resetTrafficMutation = trpc.rules.resetTraffic.useMutation({
    onSuccess: async () => {
      clearRuleTrafficStatCaches();
      setStableTotalTrafficSummaryRows([]);
      setStableDailyTrafficSummaryRows([]);
      await Promise.all([
        utils.rules.trafficSummary.invalidate(),
        utils.rules.traffic.invalidate(),
        utils.rules.trafficSeries.invalidate(),
        utils.dashboard.trafficTotals.invalidate(),
        utils.dashboard.trafficSeries.invalidate(),
        utils.dashboard.trafficBreakdown.invalidate(),
      ]);
      setResetTrafficTarget(null);
      toast.success("规则统计数据已重置");
    },
    onError: (err) => toast.error(err.message || "重置数据失败"),
  });
  useEffect(() => {
    if (visibleRuleIdsForMetrics.length === 0) {
      setStableTotalTrafficSummaryRows([]);
      return;
    }
    if (totalTrafficSummary) {
      setStableTotalTrafficSummaryRows(totalTrafficSummary);
    }
  }, [totalTrafficSummary, visibleRuleIdsForMetrics.length]);
  useEffect(() => {
    if (visibleRuleIdsForMetrics.length === 0) {
      setStableDailyTrafficSummaryRows([]);
      return;
    }
    if (dailyTrafficSummary) {
      setStableDailyTrafficSummaryRows(dailyTrafficSummary);
    }
  }, [dailyTrafficSummary, visibleRuleIdsForMetrics.length]);
  const totalTrafficSummaryRows = visibleRuleIdsForMetrics.length === 0 ? [] : totalTrafficSummary ?? stableTotalTrafficSummaryRows;
  const dailyTrafficSummaryRows = visibleRuleIdsForMetrics.length === 0 ? [] : dailyTrafficSummary ?? stableDailyTrafficSummaryRows;
  const trafficByRule = useMemo(() => {
    const m = new Map<number, {
      bytesIn: number;
      bytesOut: number;
      connections: number;
      latestLatencyMs: number | null;
      latestLatencyIsTimeout: boolean;
      latestLatencyAt: Date | string | null;
    }>();
    dailyTrafficSummaryRows.forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
        prev.connections += Number(t.connections) || 0;
        const prevAt = prev.latestLatencyAt ? new Date(prev.latestLatencyAt).getTime() : 0;
        const nextAt = t.latestLatencyAt ? new Date(t.latestLatencyAt).getTime() : 0;
        if (nextAt > prevAt) {
          prev.latestLatencyMs = t.latestLatencyMs === null || t.latestLatencyMs === undefined ? null : Number(t.latestLatencyMs);
          prev.latestLatencyIsTimeout = !!t.latestLatencyIsTimeout;
          prev.latestLatencyAt = t.latestLatencyAt || null;
        }
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
          connections: Number(t.connections) || 0,
          latestLatencyMs: t.latestLatencyMs === null || t.latestLatencyMs === undefined ? null : Number(t.latestLatencyMs),
          latestLatencyIsTimeout: !!t.latestLatencyIsTimeout,
          latestLatencyAt: t.latestLatencyAt || null,
        });
      }
    });
    return m;
  }, [dailyTrafficSummaryRows]);
  const dailyTrafficByRule = useMemo(() => {
    const m = new Map<number, { bytesIn: number; bytesOut: number }>();
    dailyTrafficSummaryRows.forEach((t: any) => {
      const rid = Number(t.ruleId);
      const prev = m.get(rid);
      if (prev) {
        prev.bytesIn += Number(t.bytesIn) || 0;
        prev.bytesOut += Number(t.bytesOut) || 0;
      } else {
        m.set(rid, {
          bytesIn: Number(t.bytesIn) || 0,
          bytesOut: Number(t.bytesOut) || 0,
        });
      }
    });
    return m;
  }, [dailyTrafficSummaryRows]);
  const totalTrafficByRule = useMemo(() => {
    const m = new Map<number, { bytesIn: number; bytesOut: number; connections: number }>();
    totalTrafficSummaryRows.forEach((t: any) => {
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
  }, [totalTrafficSummaryRows]);
  const dailyTrafficTotals = useMemo(() => {
    let bytesIn = 0;
    let bytesOut = 0;
    let connections = 0;
    dailyTrafficSummaryRows.forEach((t: any) => {
      bytesIn += Number(t.bytesIn) || 0;
      bytesOut += Number(t.bytesOut) || 0;
      connections += Number(t.connections) || 0;
    });
    return { bytesIn, bytesOut, connections };
  }, [dailyTrafficSummaryRows]);
  const totalTrafficTotals = useMemo(() => {
    let bytesIn = 0;
    let bytesOut = 0;
    let connections = 0;
    totalTrafficSummaryRows.forEach((t: any) => {
      bytesIn += Number(t.bytesIn) || 0;
      bytesOut += Number(t.bytesOut) || 0;
      connections += Number(t.connections) || 0;
    });
    return { bytesIn, bytesOut, connections };
  }, [totalTrafficSummaryRows]);
  const sortedFilteredRules = useMemo(() => {
    return [...filteredRules].sort((a: any, b: any) => {
      const aHostId = getRuleEntryHostIdForSort(a);
      const bHostId = getRuleEntryHostIdForSort(b);
      const aHostName = String(hosts?.find((host: any) => Number(host.id) === aHostId)?.name || "").toLowerCase();
      const bHostName = String(hosts?.find((host: any) => Number(host.id) === bHostId)?.name || "").toLowerCase();
      const hostCompare = (aHostName || `~${aHostId}`).localeCompare(bHostName || `~${bHostId}`, "zh-CN");
      if (hostCompare !== 0) return hostCompare;
      if (aHostId !== bHostId) return aHostId - bHostId;
      const categoryCompare = getRuleCategory(a, forwardGroupById).localeCompare(getRuleCategory(b, forwardGroupById));
      if (categoryCompare !== 0) return categoryCompare;
      const portCompare = Number(a.sourcePort || 0) - Number(b.sourcePort || 0);
      if (portCompare !== 0) return portCompare;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }, [filteredRules, forwardGroupById, getRuleEntryHostIdForSort, hosts]);
  const trafficTotalsCacheScope = useMemo(
    () => [
      user?.role === "admin" ? filterUser : `user-${user?.id || "self"}`,
      filterHost,
      ruleCategory,
      ruleSearchQuery.trim() || "search-all",
    ].join("."),
    [filterHost, ruleCategory, ruleSearchQuery, filterUser, user?.id, user?.role],
  );
  const trafficTotalsLastCacheScope = `${user?.role === "admin" ? "admin" : `user-${user?.id || "self"}`}`;
  const hasActiveUserFilter = user?.role === "admin" && filterUser !== "self";
  const hasActiveRuleFilter = hasActiveUserFilter || filterHost !== "all" || ruleCategory !== "all" || ruleSearchQuery.trim().length > 0;
  const rulesHeaderLoading = isLoading || !rules || !scopedRulesReady || !filteredRulesPrimed;
  const totalTrafficTotalsLoading = rulesHeaderLoading || (visibleRuleIdsForMetrics.length > 0 && (!secondaryQueriesReady || (!totalTrafficSummary && stableTotalTrafficSummaryRows.length === 0)));
  const dailyTrafficTotalsLoading = rulesHeaderLoading || (visibleRuleIdsForMetrics.length > 0 && (!secondaryQueriesReady || (!dailyTrafficSummary && stableDailyTrafficSummaryRows.length === 0)));
  const activeCount = useMemo(
    () => filteredRules.filter((r: any) => r.isEnabled && isRuleSupported(r)).length,
    [filteredRules, isRuleSupported]
  );
  const filteredRuleTotal = filteredRules.length;
  const rulePagination = usePersistentPagination(sortedFilteredRules, {
    storageKey: "forwardx.rules.page",
    pageSize: rulePageSize,
    isReady: !isLoading && !!rules,
  });
  const pagedRules = rulePagination.items;
  const desktopRuleGroups = useMemo(() => {
    const groups = [
      { type: "local" as const, label: desktopRuleTypeLabels.local, rules: [] as any[] },
      { type: "tunnel" as const, label: desktopRuleTypeLabels.tunnel, rules: [] as any[] },
      { type: "chain" as const, label: desktopRuleTypeLabels.chain, rules: [] as any[] },
      { type: "group" as const, label: desktopRuleTypeLabels.group, rules: [] as any[] },
    ];
    const groupByType = new Map(groups.map((group) => [group.type, group]));
    const groupedRules = ruleCategory === "all" ? filteredRules : pagedRules;
    groupedRules.forEach((rule: any) => {
      groupByType.get(getRuleDisplayType(rule, forwardGroupById))?.rules.push(rule);
    });
    return groups.filter((group) => group.rules.length > 0);
  }, [filteredRules, forwardGroupById, pagedRules, ruleCategory]);
  const shouldGroupRuleCards = ruleCategory === "all";

  const getHostName = (hostId: number) => {
    return hosts?.find((h: any) => h.id === hostId)?.name || `主机 #${hostId}`;
  };
  const getHostOptionName = (host: any) => host?.name || `主机 #${host?.id || "-"}`;
  const getHostOptionText = (host: any) => `${getHostOptionName(host)}（${host?.isOnline ? "在线" : "离线"}）`;
  const renderHostStatusLabel = (host: any) => {
    const online = !!host?.isOnline;
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={getHostOptionText(host)}>
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            online
              ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]"
              : "bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.14)]"
          }`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{getHostOptionName(host)}</span>
        <span className="sr-only">{online ? "在线" : "离线"}</span>
      </span>
    );
  };
  const getTunnelSelectText = (tunnel: any) => `${tunnel?.name || `隧道 #${tunnel?.id || "-"}`} / ${getTunnelRouteText(tunnel, hosts)} / ${String(tunnel?.mode || "").toUpperCase()}`;
  const getTunnelStatusText = (tunnel: any) => {
    if (tunnel?.isRunning) return "运行中";
    if (tunnel?.isEnabled) return "已启用";
    return "已停用";
  };
  const renderTunnelSelectStatusDot = (tunnel: any) => {
    if (tunnel?.isRunning) return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    if (tunnel?.isEnabled) return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" aria-hidden="true" />;
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
  };
  const renderTunnelSelectLabel = (tunnel: any) => (
    <span className="inline-flex min-w-0 items-center gap-2" title={`${getTunnelStatusText(tunnel)} / ${getTunnelSelectText(tunnel)}`}>
      {renderTunnelSelectStatusDot(tunnel)}
      <span className="min-w-0 truncate">{getTunnelSelectText(tunnel)}</span>
      <span className="sr-only">{getTunnelStatusText(tunnel)}</span>
    </span>
  );
  const getForwardGroupSelectText = (group: any) => `${group?.name || `转发组 #${group?.id || "-"}`} / ${getForwardGroupKindLabel(group)} / ${group?.members?.length || 0} 成员`;
  const getForwardGroupConfigStatus = (group: any): "available" | "pending" | "unavailable" | "error" | "disabled" => {
    if (!group) return "unavailable";
    if (group.isEnabled === false) return "disabled";
    if (isForwardChainGroup(group)) return "available";
    const mode = normalizeForwardGroupModeForRule(group);
    const enabledMembers = Array.isArray(group.members) ? group.members.filter((member: any) => member.isEnabled !== false) : [];
    if (enabledMembers.length === 0) return "unavailable";
    if ((mode === "failover" || mode === "entry") && !String(group.domain || "").trim()) return "unavailable";
    if (group.chinaHealthCheckEnabled) {
      if (enabledMembers.some((member: any) => String(member.chinaHealthStatus || "unknown").toLowerCase() === "healthy")) {
        return group.lastStatus === "error" ? "error" : "available";
      }
      if (enabledMembers.some((member: any) => String(member.chinaHealthStatus || "unknown").toLowerCase() !== "unhealthy")) return "pending";
      return "unavailable";
    }
    return group.lastStatus === "error" ? "error" : "available";
  };
  const getForwardGroupStatusText = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return "已停用";
    if (status === "available") return isForwardChainGroup(group) ? "链路可用" : "配置可用";
    if (status === "pending") return "等待检测";
    if (status === "error") return "异常";
    return "不可用";
  };
  const renderForwardGroupSelectStatusDot = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
    if (status === "available") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    }
    if (status === "error" || status === "unavailable") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" aria-hidden="true" />;
    }
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" aria-hidden="true" />;
  };
  const renderForwardGroupSelectLabel = (group: any) => (
    <span className="inline-flex min-w-0 items-center gap-2" title={`${getForwardGroupStatusText(group)} / ${getForwardGroupSelectText(group)}`}>
      {renderForwardGroupSelectStatusDot(group)}
      <span className="min-w-0 truncate">{getForwardGroupSelectText(group)}</span>
      <span className="sr-only">{getForwardGroupStatusText(group)}</span>
    </span>
  );
  const renderTunnelRoute = (tunnel: any, compact = false) => {
    const hopIds = getTunnelHopIds(tunnel);
    return (
      <div
        className={`flex min-w-0 items-center gap-1.5 text-xs ${compact ? "flex-wrap" : "whitespace-nowrap"}`}
        title={getTunnelRouteText(tunnel, hosts)}
      >
        {hopIds.map((hostId: number, index: number) => (
          <Fragment key={`${tunnel?.id || "tunnel"}-${hostId}-${index}`}>
            {index > 0 && <ArrowRight className="h-3 w-3 shrink-0" />}
            <span className={compact ? "max-w-[8rem] truncate" : "truncate"}>
              {tunnelHopHostName(tunnel, hostId, hosts)}
            </span>
          </Fragment>
        ))}
      </div>
    );
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

  const selfTestLinkTestNodeData = useMemo(() => {
    const meta: Record<string, any> = {};
    const rule = selfTestRuleDetail;
    if (!rule) {
      return { nodeMeta: meta, sourceLabel: selfTestRule?.name || "源节点", targetLabel: selfTestRule?.name || "目标", plannedSegments: [] as LinkTestPlannedSegment[] };
    }

    const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const tunnelHostById = new Map<number, any>();
    if (tunnel) {
      [
        ...(Array.isArray((tunnel as any).hopHosts) ? (tunnel as any).hopHosts : []),
        (tunnel as any).entryHost,
        (tunnel as any).exitHost,
        ...(Array.isArray((tunnel as any).loadBalanceExits) ? (tunnel as any).loadBalanceExits.map((exit: any) => exit?.host) : []),
      ].forEach((host: any) => {
        const id = Number(host?.id || 0);
        if (id > 0) tunnelHostById.set(id, host);
      });
    }
    const hostForRouteId = (hostId: number) => hostById.get(Number(hostId)) || tunnelHostById.get(Number(hostId));
    const chainGroup = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const chainEntryGroup = chainGroup && isForwardChainGroup(chainGroup) && Number(chainGroup.entryGroupId || 0) > 0
      ? forwardGroupById.get(Number(chainGroup.entryGroupId))
      : null;
    const chainEntryMembers = chainEntryGroup && normalizeForwardGroupModeForRule(chainEntryGroup) === "entry" ? enabledHostMembers(chainEntryGroup) : [];
    const tunnelEntryGroup = tunnel && Number((tunnel as any).entryGroupId || 0) > 0
      ? forwardGroupById.get(Number((tunnel as any).entryGroupId))
      : null;
    const tunnelEntryMembers = tunnelEntryGroup && normalizeForwardGroupModeForRule(tunnelEntryGroup) === "entry" ? enabledHostMembers(tunnelEntryGroup) : [];
    const tunnelEntryMemberByHostId = new Map<number, any>();
    tunnelEntryMembers.forEach((member: any) => {
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0) tunnelEntryMemberByHostId.set(hostId, member);
    });
    const labelForRouteHostId = (hostId: number) => {
      const host = hostForRouteId(hostId);
      const member = tunnelEntryMemberByHostId.get(Number(hostId));
      return hostDisplayName(host)
        || String(member?.name || member?.remark || "").trim()
        || (tunnel ? tunnelHopHostName(tunnel, hostId, hosts) : "")
        || `主机 #${hostId}`;
    };
    const routeHostIds = ruleGlobeRouteHostIds(rule, tunnelById, forwardGroupById);
    routeHostIds.forEach((hostId: number, index: number) => {
      const host = hostForRouteId(Number(hostId));
      addHostNodeMeta(meta, host, [
        index === 0 ? "入口" : "",
        index === routeHostIds.length - 1 ? "出口" : "",
        tunnel ? labelForRouteHostId(hostId) : "",
        tunnel ? tunnelHopHostName(tunnel, hostId, hosts) : "",
        `主机${hostId}`,
        `主机 #${hostId}`,
      ]);
    });

    const sourceHost = hostForRouteId(Number(routeHostIds[0] || rule.hostId || 0)) || getRuleEntryHost(rule);
    const exitHost = hostForRouteId(Number(routeHostIds[routeHostIds.length - 1] || 0));
    if (sourceHost) addHostNodeMeta(meta, sourceHost, ["入口", "源节点"]);
    chainEntryMembers.forEach((entryMember: any) => {
      const entryHost = hostForRouteId(Number(entryMember.hostId || 0));
      addHostNodeMeta(meta, entryHost, [
        "入口",
        "源节点",
        `主机${entryMember.hostId || ""}`,
        `主机 #${entryMember.hostId || ""}`,
      ]);
    });
    tunnelEntryMembers.forEach((entryMember: any) => {
      const entryHostId = Number(entryMember.hostId || 0);
      const entryHost = hostForRouteId(entryHostId);
      addHostNodeMeta(meta, entryHost, [
        "入口",
        "源节点",
        labelForRouteHostId(entryHostId),
        entryMember.entryAddress,
        `主机${entryHostId || ""}`,
        `主机 #${entryHostId || ""}`,
      ]);
    });
    if (exitHost) addHostNodeMeta(meta, exitHost, ["出口"]);

    const targetIp = String(rule.targetIp || "").trim();
    const targetText = formatAddressWithPort(targetIp || "-", Number(rule.targetPort || 0) || "-") || "目标";
    const ruleLabel = String(rule.name || selfTestRule?.name || `规则 #${rule.id || "-"}`).trim();
    const targetHost = findHostByAddress(hosts, targetIp);
    if (targetHost) {
      addHostNodeMeta(meta, targetHost);
      const hostMeta = {
        ...hostNodeMeta(targetHost),
        label: ruleLabel,
      };
      addNodeMetaAliases(meta, [
        ruleLabel,
        targetIp,
        targetText,
        `目标 ${targetText}`,
        `目标 ${targetIp}:${rule.targetPort || "-"}`,
        "目标",
        "目的节点",
      ], hostMeta);
    } else {
      const targetGeo = targetGeoByAddress.get(normalizeAddressKey(targetIp));
      const targetMeta = targetGeoNodeMeta(ruleLabel, targetIp || targetText, targetGeo);
      addNodeMetaAliases(meta, [
        ruleLabel,
        targetIp,
        targetText,
        `目标 ${targetText}`,
        `目标 ${targetIp}:${rule.targetPort || "-"}`,
        "目标",
        "目的节点",
      ], targetMeta);
    }

    const routeHosts = routeHostIds
      .map((hostId: number) => hostForRouteId(Number(hostId)))
      .filter(Boolean);
    const plannedSegments: LinkTestPlannedSegment[] = [];
    if (chainEntryMembers.length > 0 && routeHosts[0]) {
      const firstChainHost = routeHosts[0];
      chainEntryMembers.forEach((entryMember: any) => {
        const entryHost = hostForRouteId(Number(entryMember.hostId || 0));
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost),
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)],
        });
      });
    }
    const tunnelParsedMessage = tunnel ? parseLinkTestMessage((tunnel as any).lastTestMessage) : null;
    const tunnelTestStatus = String((tunnel as any)?.lastTestStatus || "");
    const tunnelDetails = tunnelTestStatus !== "pending" && tunnelTestStatus !== "running"
      ? (tunnelParsedMessage?.details || [])
        .filter((detail) => !detail.pending && (detail.success || detail.message || typeof detail.latencyMs === "number"))
      : [];
    const tunnelLatencyMs = typeof (tunnel as any)?.latestLatencyMs === "number" && Number.isFinite((tunnel as any).latestLatencyMs)
      ? Number((tunnel as any).latestLatencyMs)
      : typeof (tunnel as any)?.lastLatencyMs === "number" && Number.isFinite((tunnel as any).lastLatencyMs)
        ? Number((tunnel as any).lastLatencyMs)
        : null;
    const tunnelLatencyIsTimeout = !!(tunnel as any)?.latestLatencyIsTimeout || ((tunnel as any)?.lastTestStatus === "failed" && tunnelLatencyMs === null);
    const nodeMetaForHostId = (hostId: number) => {
      const host = hostForRouteId(hostId);
      return meta[hostDisplayName(host)] || meta[labelForRouteHostId(hostId)] || meta[String(hostId)] || undefined;
    };
    const createTunnelPlannedSegment = (
      fromHostId: number,
      toHostId: number,
      tunnelDetail: any,
      useTunnelLatencyFallback: boolean,
    ): LinkTestPlannedSegment => ({
      from: labelForRouteHostId(fromHostId),
      to: labelForRouteHostId(toHostId),
      fromMeta: nodeMetaForHostId(fromHostId),
      toMeta: nodeMetaForHostId(toHostId),
      success: tunnelDetail
        ? !!tunnelDetail.success
        : tunnelLatencyMs !== null && useTunnelLatencyFallback
          ? true
          : tunnelLatencyIsTimeout
            ? false
            : undefined,
      latencyMs: tunnelDetail && tunnelDetail.success && typeof tunnelDetail.latencyMs === "number"
        ? tunnelDetail.latencyMs
        : tunnelLatencyMs !== null && useTunnelLatencyFallback
          ? tunnelLatencyMs
          : null,
      message: tunnelDetail?.message || (tunnelLatencyIsTimeout ? "隧道段失败" : null),
      method: tunnelDetail?.method || null,
      pending: tunnelDetail?.pending || false,
    });
    const tunnelEntryHostIds = tunnel
      ? Array.from(new Set([
        Number(routeHostIds[0] || (tunnel as any).entryHostId || 0),
        ...tunnelEntryMembers.map((member: any) => Number(member?.hostId || 0)),
      ].filter((hostId: number) => Number.isFinite(hostId) && hostId > 0)))
      : [];
    const hasTunnelMultiEntry = !!tunnel && tunnelEntryHostIds.length > 1;
    if (hasTunnelMultiEntry) {
      const lastHostId = Number(routeHostIds[routeHostIds.length - 1] || (tunnel as any).exitHostId || 0);
      const restRouteHostIds = routeHostIds.filter((hostId: number) => !tunnelEntryHostIds.includes(Number(hostId)));
      const nextHostId = Number(restRouteHostIds[0] || lastHostId || (tunnel as any).exitHostId || 0);
      let detailIndex = 0;
      if (nextHostId > 0) {
        tunnelEntryHostIds.forEach((entryHostId) => {
          if (entryHostId !== nextHostId) {
            plannedSegments.push(createTunnelPlannedSegment(entryHostId, nextHostId, tunnelDetails[detailIndex], false));
            detailIndex += 1;
          }
        });
      }
      for (let index = 0; index < restRouteHostIds.length - 1; index += 1) {
        plannedSegments.push(createTunnelPlannedSegment(
          Number(restRouteHostIds[index]),
          Number(restRouteHostIds[index + 1]),
          tunnelDetails[detailIndex],
          false,
        ));
        detailIndex += 1;
      }
    } else {
      for (let index = 0; index < routeHostIds.length - 1; index += 1) {
        const singleTunnelSegment = routeHostIds.length - 1 === 1;
        plannedSegments.push(createTunnelPlannedSegment(
          Number(routeHostIds[index]),
          Number(routeHostIds[index + 1]),
          tunnelDetails[index],
          singleTunnelSegment || index === 0,
        ));
      }
    }
    const exitHostForTarget = routeHosts[routeHosts.length - 1] || sourceHost;
    if (exitHostForTarget) {
      plannedSegments.push({
        from: hostDisplayName(exitHostForTarget),
        to: ruleLabel,
        fromMeta: meta[hostDisplayName(exitHostForTarget)],
        toMeta: meta[ruleLabel] || meta[targetText] || meta[targetIp],
      });
    }

    return {
      nodeMeta: meta,
      sourceLabel: chainEntryMembers.length > 0
        ? chainEntryMembers
          .map((member: any) => hostDisplayName(hostForRouteId(Number(member.hostId || 0))) || `入口主机 #${member.hostId || "-"}`)
          .filter(Boolean)
          .join(" / ")
        : tunnelEntryHostIds.length > 1
          ? tunnelEntryHostIds.map((hostId) => labelForRouteHostId(hostId)).filter(Boolean).join(" / ")
          : hostDisplayName(sourceHost) || getRuleEntryHostName(rule),
      targetLabel: ruleLabel,
      plannedSegments,
    };
  }, [forwardGroupById, getRuleEntryHost, hosts, selfTestRule?.name, selfTestRuleDetail, targetGeoByAddress, tunnelById]);

  const getTransferResourceLabel = (type: RuleTransferScopeType, resource: any) => {
    if (!resource) return "";
    if (type === "local") return getHostOptionText(resource);
    if (type === "tunnel") return `${resource.name || `#${resource.id}`} / ${getTunnelRouteText(resource, hosts || [])}`;
    return resource.name || `#${resource.id}`;
  };

  const getTransferResourceSearchText = useCallback((type: RuleTransferScopeType, resource: any) => {
    const values: any[] = [resource?.id];
    if (type === "local") {
      values.push(
        getHostOptionName(resource),
        getHostEntryAddressText(resource),
        resource?.name,
        resource?.ip,
        resource?.entryIp,
        resource?.internalIp,
        resource?.tunnelEntryIp,
        resource?.networkInterface,
        resource?.isOnline ? "online 在线" : "offline 离线",
      );
    } else if (type === "tunnel") {
      values.push(
        resource?.name,
        getTunnelRouteText(resource, hosts || []),
        resource?.mode,
        resource?.type,
        resource?.listenPort,
        resource?.entryHostId,
        resource?.exitHostId,
      );
    } else {
      values.push(
        resource?.name,
        resource?.description,
        resource?.domain,
        resource?.groupType,
        resource?.type,
        resource?.mode,
      );
    }
    return values.filter((value) => value !== undefined && value !== null && String(value).trim()).join(" ");
  }, [hosts]);

  const filterTransferResources = useCallback((resources: any[], type: RuleTransferScopeType, search: string) => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return resources;
    return resources.filter((resource: any) => getTransferResourceSearchText(type, resource).toLowerCase().includes(keyword));
  }, [getTransferResourceSearchText]);

  const filteredExportResources = useMemo(
    () => filterTransferResources(exportResources, exportScopeType, exportResourceSearch),
    [exportResourceSearch, exportResources, exportScopeType, filterTransferResources]
  );

  const filteredImportResources = useMemo(
    () => filterTransferResources(importResources, importScopeType, importResourceSearch),
    [filterTransferResources, importResourceSearch, importResources, importScopeType]
  );

  const selectedExportResource = useMemo(
    () => exportResources.find((resource: any) => String(resource.id) === exportResourceId) || null,
    [exportResourceId, exportResources]
  );

  const selectedImportResource = useMemo(
    () => importResources.find((resource: any) => String(resource.id) === importResourceId) || null,
    [importResourceId, importResources]
  );

  const renderTransferResourceOption = (type: RuleTransferScopeType, resource: any) => {
    if (type === "local") {
      const online = !!resource?.isOnline;
      return (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              online
                ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]"
                : "bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.14)]"
            }`}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{getHostOptionName(resource)}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {getHostEntryAddressText(resource) || resource?.tunnelEntryIp || resource?.internalIp || ""}
          </span>
        </div>
      );
    }
    if (type === "tunnel") {
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">{resource.name || `#${resource.id}`}</span>
          <span className="truncate text-xs text-muted-foreground">{getTunnelRouteText(resource, hosts || [])}</span>
        </div>
      );
    }
    return <span className="truncate">{resource.name || `#${resource.id}`}</span>;
  };

  const renderTransferResourcePicker = ({
    type,
    resources,
    filteredResources,
    selectedResource,
    selectedId,
    search,
    onSearch,
    onSelect,
  }: {
    type: RuleTransferScopeType;
    resources: any[];
    filteredResources: any[];
    selectedResource: any;
    selectedId: string;
    search: string;
    onSearch: (value: string) => void;
    onSelect: (value: string) => void;
  }) => {
    const label = ruleTransferScopeLabels[type];
    const selectedVisible = filteredResources.some((resource: any) => String(resource.id) === selectedId);
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>{label}</Label>
          <span className="text-xs text-muted-foreground">{filteredResources.length}/{resources.length}</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border/70 bg-background">
          <div className="relative border-b border-border/60">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              disabled={resources.length === 0}
              placeholder={`搜索${label}`}
              className="h-9 border-0 pl-9 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filteredResources.length > 0 ? (
              filteredResources.map((resource: any) => {
                const id = String(resource.id);
                const selected = id === selectedId;
                return (
                  <button
                    key={id}
                    type="button"
                    title={getTransferResourceLabel(type, resource)}
                    aria-pressed={selected}
                    onClick={() => onSelect(id)}
                    className={`flex h-10 w-full min-w-0 items-center gap-2 rounded-sm px-3 text-left text-sm transition-colors hover:bg-muted ${
                      selected ? "bg-muted text-foreground" : "text-foreground"
                    }`}
                  >
                    {selected ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">{renderTransferResourceOption(type, resource)}</div>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {resources.length === 0 ? `暂无可选择的${label}` : `没有匹配的${label}`}
              </div>
            )}
          </div>
        </div>
        {selectedResource && !selectedVisible ? (
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {"已选择："}{getTransferResourceLabel(type, selectedResource)}
          </div>
        ) : null}
      </div>
    );
  };
  const getRulesForTransferScope = useCallback((type: RuleTransferScopeType, resourceId: string) => {
    const id = Number(resourceId);
    if (!Number.isFinite(id) || id <= 0) return [];
    return transferSourceRules.filter((rule: any) => {
      if (rule.forwardGroupRuleId || rule.forwardGroupMemberId) return false;
      const category = getRuleCategory(rule, forwardGroupById);
      if (category !== type) return false;
      if (type === "local") return Number(rule.hostId) === id && !rule.tunnelId && !rule.forwardGroupId;
      if (type === "tunnel") return Number(rule.tunnelId) === id;
      return Number(rule.forwardGroupId) === id;
    });
  }, [forwardGroupById, transferSourceRules]);

  const exportableRules = useMemo(
    () => getRulesForTransferScope(exportScopeType, exportResourceId),
    [exportScopeType, exportResourceId, getRulesForTransferScope]
  );

  const importValidation = useMemo<{ ok: boolean; message: string; rules: RuleTransferFileRule[] }>(() => {
    if (!importResourceId) return { ok: false, message: `请选择${ruleTransferScopeLabels[importScopeType]}`, rules: [] };
    if (importFileError) return { ok: false, message: importFileError, rules: [] };
    if (!importFile) return { ok: false, message: "请选择导入文件", rules: [] };
    if (importFile.kind !== RULE_TRANSFER_FILE_KIND) {
      return { ok: false, message: "文件不是 ForwardX 转发规则导出文件", rules: [] };
    }
    const fileScopeType = normalizeRuleTransferScopeType(importFile.scope?.type);
    if (!fileScopeType) return { ok: false, message: "文件缺少导出类型", rules: [] };
    if (fileScopeType !== importScopeType) {
      return {
        ok: false,
        message: `文件类型是${ruleTransferScopeLabels[fileScopeType]}，请切换为${ruleTransferScopeLabels[fileScopeType]}后导入`,
        rules: [],
      };
    }
    if (!Array.isArray(importFile.rules) || importFile.rules.length === 0) {
      return { ok: false, message: "文件中没有可导入的规则", rules: [] };
    }
    if (importFile.rules.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
      return { ok: false, message: `单次最多导入 ${RULE_TRANSFER_MAX_IMPORT_COUNT} 条规则`, rules: [] };
    }
    const normalizedRules = importFile.rules.map(normalizeRuleTransferRule);
    const invalidIndex = normalizedRules.findIndex((rule) => !rule);
    if (invalidIndex >= 0) {
      return { ok: false, message: `第 ${invalidIndex + 1} 条规则格式不完整`, rules: [] };
    }
    const fixedRules = normalizedRules as RuleTransferFileRule[];
    const zeroPortIndex = fixedRules.findIndex((rule) => rule.sourcePort <= 0);
    if ((importScopeType === "chain" || importScopeType === "group") && zeroPortIndex >= 0) {
      return { ok: false, message: `第 ${zeroPortIndex + 1} 条规则缺少监听端口`, rules: [] };
    }
    return { ok: true, message: `已识别 ${fixedRules.length} 条${ruleTransferScopeLabels[importScopeType]}规则`, rules: fixedRules };
  }, [importFile, importFileError, importResourceId, importScopeType]);

  const resetImportDialog = () => {
    setImportFile(null);
    setImportFileName("");
    setImportFileError("");
    setImportFileInputKey((key) => key + 1);
  };

  const openExportDialog = () => {
    const preferredType = ruleCategory === "all" ? "local" : ruleCategory;
    setExportScopeType(preferredType as RuleTransferScopeType);
    setShowExportDialog(true);
  };

  const openImportDialog = () => {
    if (!canAdd) {
      toast.error("当前没有添加规则权限");
      return;
    }
    const preferredType = ruleCategory === "all" ? "local" : ruleCategory;
    setImportScopeType(preferredType as RuleTransferScopeType);
    resetImportDialog();
    setShowImportDialog(true);
  };

  const handleImportFileChange = async (event: any) => {
    const file = event.target.files?.[0];
    setImportFile(null);
    setImportFileError("");
    setImportFileName(file?.name || "");
    if (!file) return;
    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText);
      setImportFile(normalizeRuleTransferFile(parsed));
    } catch {
      setImportFileError("文件无法解析，请选择 JSON 格式的规则文件");
    }
  };

  const buildImportRulePayload = (rule: RuleTransferFileRule) => {
    const resourceId = Number(importResourceId);
    const selectedTunnel = importScopeType === "tunnel" ? tunnelById.get(resourceId) : null;
    const selectedGroup = importScopeType === "chain" || importScopeType === "group" ? forwardGroupById.get(resourceId) : null;
    const groupUsesTunnel = importScopeType === "group" && selectedGroup && !isForwardChainGroup(selectedGroup) && selectedGroup.groupType === "tunnel";
    const payloadForwardType: ForwardType = importScopeType === "tunnel" || groupUsesTunnel ? "gost" : rule.forwardType;
    return {
      hostId: importScopeType === "local" ? resourceId : importScopeType === "tunnel" ? Number(selectedTunnel?.entryHostId || 0) : undefined,
      name: rule.name,
      forwardType: payloadForwardType,
      protocol: rule.protocol,
      gostMode: "direct" as const,
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId: importScopeType === "tunnel" ? resourceId : null,
      forwardGroupId: importScopeType === "chain" || importScopeType === "group" ? resourceId : null,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      telegramErrorNotifyEnabled: telegramBotReady && !!rule.telegramErrorNotifyEnabled,
      proxyProtocolReceive: rule.proxyProtocolReceive,
      proxyProtocolSend: rule.proxyProtocolSend,
      proxyProtocolExitReceive: rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: rule.proxyProtocolExitSend,
      proxyProtocolVersion: normalizeProxyProtocolVersion(rule.proxyProtocolVersion),
      tcpFastOpen: rule.tcpFastOpen,
      zeroCopy: rule.zeroCopy,
      udpOverTcp: rule.udpOverTcp,
      udpOverTcpPort: rule.udpOverTcpPort,
      failoverEnabled: importScopeType === "chain" ? false : rule.failoverEnabled,
      failoverStrategy: rule.failoverStrategy,
      failoverTargets: importScopeType === "chain" || !rule.failoverEnabled ? [] : rule.failoverTargets,
      failoverSeconds: rule.failoverSeconds,
      recoverSeconds: rule.recoverSeconds,
      autoFailback: rule.autoFailback,
    };
  };

  const handleImportRules = async () => {
    if (!importValidation.ok) {
      toast.error(importValidation.message);
      return;
    }
    setImportingRules(true);
    let importedCount = 0;
    try {
      for (const rule of importValidation.rules) {
        await importCreateMutation.mutateAsync(buildImportRulePayload(rule));
        importedCount += 1;
      }
      await utils.rules.list.invalidate();
      await utils.rules.trafficSummary.invalidate();
      toast.success(`已导入 ${importedCount} 条规则`);
      setShowImportDialog(false);
      resetImportDialog();
    } catch (error: any) {
      toast.error(`导入失败：已导入 ${importedCount} 条，${error?.message || "请检查规则配置"}`);
    } finally {
      setImportingRules(false);
    }
  };

  const handleExportRules = () => {
    const resource = exportResources.find((item: any) => String(item.id) === exportResourceId);
    if (!resource) {
      toast.error(`请选择${ruleTransferScopeLabels[exportScopeType]}`);
      return;
    }
    if (exportableRules.length === 0) {
      toast.error("当前选择没有可导出的规则");
      return;
    }
    const resourceLabel = getTransferResourceLabel(exportScopeType, resource);
    const payload = {
      kind: RULE_TRANSFER_FILE_KIND,
      version: RULE_TRANSFER_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      scope: {
        type: exportScopeType,
        id: Number(exportResourceId),
        name: resourceLabel,
      },
      rules: exportableRules.map(exportRuleForTransfer),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    anchor.href = url;
    anchor.download = `forwardx-rules-${exportScopeType}-${sanitizeRuleTransferFilePart(resourceLabel)}-${date}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${exportableRules.length} 条规则`);
    setShowExportDialog(false);
  };
  const getRuleOwnerName = (rule: any) => {
    const owner = userById.get(Number(rule.userId));
    return owner?.name || owner?.username || `用户 #${rule.userId}`;
  };

  /** 获取主机入口展示地址：优先展示自定义域名 / DDNS，最后回退自动检测 IP */
  const getForwardGroupName = (groupId: number) => {
    return forwardGroupById.get(Number(groupId))?.name || `转发组 #${groupId}`;
  };
  const getForwardGroupMemberLabel = (member: any) => {
    if (member.memberType === "host") {
      return member.hostId ? getHostName(member.hostId) : "主机成员";
    }
    const tunnel = member.tunnelId ? tunnelById.get(Number(member.tunnelId)) : null;
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : member.tunnelId ? `隧道 #${member.tunnelId}` : "隧道成员";
  };

  const getHostEntry = (hostId: number): string => {
    const h: any = hosts?.find((x: any) => x.id === hostId);
    return getHostEntryAddress(h);
  };

  const entryDomainForForwardGroup = (group: any | null | undefined) => {
    if (!group) return "";
    if (isForwardChainGroup(group) && group.entryGroupId) {
      const entryGroup = forwardGroupById.get(Number(group.entryGroupId));
      return String(entryGroup?.domain || "").trim();
    }
    return "";
  };

  const getRuleEntry = (rule: any): string => {
    return getRuleEntries(rule)[0]?.value || getHostEntryAddress(getRuleEntryHost(rule));
  };

  const getRuleEntries = (rule: any): EntryAddress[] => {
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const tunnelEntries = getTunnelEntryAddresses(tunnel);
    if (tunnelEntries.length > 0) return tunnelEntries;
    return getHostEntryAddresses(getRuleEntryHost(rule));
  };

  const getTunnelEntryHostForDisplay = (tunnel: any | null | undefined, hostId: number) => {
    const id = Number(hostId || 0);
    return (hosts || []).find((host: any) => Number(host.id) === id)
      || (Array.isArray(tunnel?.hopHosts) ? tunnel.hopHosts.find((host: any) => Number(host?.id) === id) : null)
      || (Number(tunnel?.entryHost?.id || 0) === id ? tunnel.entryHost : null)
      || (Number(tunnel?.exitHost?.id || 0) === id ? tunnel.exitHost : null);
  };

  const getTunnelEntryAddresses = (tunnel: any | null | undefined): EntryAddress[] => {
    if (!tunnel) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = Number(tunnel?.entryGroupId || 0) > 0 ? forwardGroupById.get(Number(tunnel.entryGroupId)) : null;
    const entryGroupDomain = String(entryGroup?.domain || "").trim();
    if (entryGroupDomain) {
      pushUniqueEntryAddress(rows, "入口组", entryGroupDomain);
      return rows;
    }
    const entryMembers = entryGroup && normalizeForwardGroupModeForRule(entryGroup) === "entry"
      ? enabledHostMembers(entryGroup)
      : [];
    if (entryMembers.length > 0) {
      const memberEntries = entryMembers.flatMap((member: any) => {
        const host = getTunnelEntryHostForDisplay(tunnel, Number(member.hostId || 0));
        return getHostEntryAddresses(host);
      });
      const memberDomain = memberEntries.find((entry) => entry.label === "DDNS")
        || memberEntries.find((entry) => addressFamily(entry.value) === "hostname");
      if (memberDomain) {
        pushUniqueEntryAddress(rows, memberDomain.label, memberDomain.value);
        return rows;
      }
      const firstEntryHost = getTunnelEntryHostForDisplay(tunnel, Number(entryMembers[0]?.hostId || 0));
      for (const entry of getHostEntryAddresses(firstEntryHost)) {
        pushUniqueEntryAddress(rows, entry.label, entry.value);
      }
      return rows;
    }
    const entryHostId = Number(tunnel?.entryHostId || getTunnelHopIds(tunnel)[0] || 0);
    for (const entry of getHostEntryAddresses(getTunnelEntryHostForDisplay(tunnel, entryHostId))) {
      pushUniqueEntryAddress(rows, entry.label, entry.value);
    }
    return rows;
  };

  const getMemberEntryHost = (member: any | null | undefined) => {
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0) return hosts?.find((host: any) => Number(host.id) === hostId) || null;
    const tunnelId = Number(member?.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnel = tunnelById.get(tunnelId);
      const entryHostId = Number(tunnel?.entryHostId || 0);
      return entryHostId > 0
        ? hosts?.find((host: any) => Number(host.id) === entryHostId) || tunnel?.entryHost || null
        : tunnel?.entryHost || null;
    }
    return null;
  };

  const pushMemberEntryAddresses = (rows: EntryAddress[], member: any | null | undefined) => {
    const tunnelId = Number(member?.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnelRows = getTunnelEntryAddresses(tunnelById.get(tunnelId));
      for (const entry of tunnelRows) {
        pushUniqueEntryAddress(rows, entry.label, entry.value);
      }
      if (tunnelRows.length > 0) return;
    }
    const entryHost = getMemberEntryHost(member);
    for (const entry of getHostEntryAddresses(entryHost)) {
      pushUniqueEntryAddress(rows, entry.label, entry.value);
    }
    pushUniqueEntryAddress(rows, "入口", member?.entryAddress);
  };

  const getForwardGroupEntryAddresses = (group: any | null | undefined): EntryAddress[] => {
    if (!group) return [];
    const rows: EntryAddress[] = [];
    const domain = String(group?.domain || "").trim();
    if (domain) {
      pushUniqueEntryAddress(rows, "转发组", domain);
      return rows;
    }
    const activeMemberId = Number(group?.activeMemberId || 0);
    const members = [...(group?.members || [])]
      .filter((member: any) => member?.isEnabled !== false)
      .sort((a: any, b: any) => {
        if (activeMemberId > 0) {
          if (Number(a.id) === activeMemberId) return -1;
          if (Number(b.id) === activeMemberId) return 1;
        }
        return Number(a.priority || 0) - Number(b.priority || 0);
      });
    for (const member of members) {
      pushMemberEntryAddresses(rows, member);
      if (rows.length > 0) return rows;
    }
    return rows;
  };

  const getForwardChainEntryAddresses = (group: any | null | undefined): EntryAddress[] => {
    if (!group) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = isForwardChainGroup(group) && group.entryGroupId
      ? forwardGroupById.get(Number(group.entryGroupId))
      : null;
    const domain = entryDomainForForwardGroup(group);
    if (domain) {
      pushUniqueEntryAddress(rows, "入口组", domain);
      return rows;
    }
    const entryMembers = entryGroup && normalizeForwardGroupModeForRule(entryGroup) === "entry"
      ? enabledHostMembers(entryGroup)
      : [];
    if (entryMembers.length > 0) {
      const memberDomain = entryMembers
        .map((member: any) => getHostEntryAddresses(getMemberEntryHost(member)).find((entry) => addressFamily(entry.value) === "hostname"))
        .find(Boolean);
      if (memberDomain) {
        pushUniqueEntryAddress(rows, memberDomain.label, memberDomain.value);
        return rows;
      }
      const firstEntryMember = entryMembers[0];
      pushMemberEntryAddresses(rows, firstEntryMember);
      return rows;
    }
    const entryMember = (group.members || [])[0];
    pushMemberEntryAddresses(rows, entryMember);
    return rows;
  };

  /** 复制入口 IP:端口 到剪贴板 */
  const copyEntryAddress = async (rule: any, entryValue?: string) => {
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      if (isForwardChainGroup(group)) {
        const entry = String(entryValue || getForwardChainEntryAddresses(group)[0]?.value || "").trim();
        if (!entry) {
          toast.error("该端口转发链未配置可用入口地址");
          return;
        }
        const text = formatAddressWithPort(entry, rule.sourcePort);
        try {
          await navigator.clipboard.writeText(text);
          toast.success(`已复制入口地址: ${text}`);
        } catch {
          toast.error("复制失败，请手动复制");
        }
        return;
      }
      const entry = String(entryValue || getForwardGroupEntryAddresses(group)[0]?.value || "").trim();
      if (!entry) {
        toast.error("该转发组未配置可用入口地址");
        return;
      }
      const text = formatAddressWithPort(entry, rule.sourcePort);
      try {
        await navigator.clipboard.writeText(text);
        toast.success(`已复制入口地址: ${text}`);
      } catch {
        toast.error("复制失败，请手动复制");
      }
      return;
    }
    const entry = String(entryValue || getRuleEntry(rule)).trim();
    if (!entry) {
      toast.error("未获取到主机入口地址");
      return;
    }
    const text = formatAddressWithPort(entry, rule.sourcePort);
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
      if (isForwardChainGroup(group)) {
        if (rule.isEnabled && group?.isEnabled !== false) {
          return <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
        }
        if (rule.isEnabled) {
          return <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />;
        }
        return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />;
      }
      const groupStatus = getForwardGroupConfigStatus(group);
      if (groupStatus === "disabled") {
        return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />;
      }
      if (groupStatus === "available") {
        return <span className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
      }
      if (groupStatus === "error" || groupStatus === "unavailable") {
        return <span className="h-2.5 w-2.5 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" />;
      }
      if (groupStatus === "pending") {
        return <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />;
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

  const getRuleTransferDisplay = (rule: any) => {
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupEntry = isForwardChainGroup(group)
      ? (entryDomainForForwardGroup(group) || group?.members?.[0]?.entryAddress || getForwardGroupName(rule.forwardGroupId))
      : (group?.domain || getForwardGroupName(rule.forwardGroupId));
    const chainEntryItems = isForwardChainGroup(group) ? getForwardChainEntryAddresses(group) : [];
    const groupEntryItems = rule.forwardGroupId && !isForwardChainGroup(group) ? getForwardGroupEntryAddresses(group) : [];
    const entryItems = rule.forwardGroupId
      ? (isForwardChainGroup(group) ? (chainEntryItems.length > 0 ? chainEntryItems : [{ label: "转发链", value: groupEntry }]) : (groupEntryItems.length > 0 ? groupEntryItems : [{ label: "转发组", value: groupEntry }]))
      : (getRuleEntries(rule).length > 0
        ? getRuleEntries(rule)
        : [{ label: "入口", value: getRuleEntryHostName(rule) }]);
    const entryAddresses = entryItems.map((entry) => ({
      ...entry,
      text: formatAddressWithPort(entry.value, rule.sourcePort),
    }));
    const entryAddress = entryAddresses.map((entry) => entry.text).join(" / ");
    const targetAddress = `${rule.targetIp}:${rule.targetPort}`;
    const entryTitle = rule.forwardGroupId
      ? `复制${isForwardChainGroup(group) ? "转发链" : "转发组"}入口: ${entryAddress}`
      : `复制入口地址: ${entryAddress}`;
    const failoverCount = parseRuleFailoverTargets(rule.failoverTargets).filter((target) => target.targetIp && target.targetPort > 0).length;
    return {
      entryAddresses,
      entryAddress,
      targetAddress,
      entryTitle,
      failoverCount,
      failoverEnabled: !!rule.failoverEnabled,
      failoverStrategy: normalizeFailoverStrategy(rule.failoverStrategy),
    };
  };

  const renderTransfer = (rule: any, compact = false) => {
    const {
      entryAddresses,
      targetAddress,
      entryTitle,
      failoverCount,
      failoverEnabled,
      failoverStrategy,
    } = getRuleTransferDisplay(rule);
    const failoverBadge = failoverEnabled ? (
      <Badge variant="outline" className="h-5 shrink-0 border-amber-500/30 px-1.5 text-[10px] text-amber-600">
        {failoverStrategyLabels[failoverStrategy]} {failoverCount}
      </Badge>
    ) : null;

    const panelClass = compact
      ? "rounded-md border border-border/50 bg-background/55 px-2 py-1.5"
      : "rounded-md border border-border/50 bg-background/55 px-2.5 py-2";
    const labelClass = "mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground";
    const valueClass = compact
      ? "min-w-0 break-all text-[11px] leading-4"
      : "min-w-0 break-all text-xs leading-5";

    return (
      <div className="min-w-0 space-y-1.5 font-mono text-xs">
        <div className={panelClass}>
          <div className={labelClass}>入口</div>
          <div className="flex min-w-0 flex-col gap-1">
            {entryAddresses.map((entry) => (
              <button
                key={`${entry.label}:${entry.value}`}
                type="button"
                onClick={() => copyEntryAddress(rule, entry.value)}
                className="group flex max-w-full min-w-0 items-start justify-between gap-1.5 rounded bg-muted/35 px-1.5 py-1 text-left transition-colors hover:bg-muted/70"
                title={`${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}`}
              >
                <code className={valueClass}>{entry.text}</code>
                <Copy className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-center">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/50 bg-background text-muted-foreground shadow-sm">
            <ArrowDownToLine className="h-3 w-3" />
          </span>
        </div>
        <div className={panelClass}>
          <div className={labelClass}>出口</div>
          <div className="flex min-w-0 items-start gap-1.5">
            <code className={`${valueClass} flex-1 rounded bg-muted/35 px-1.5 py-1`} title={targetAddress}>
              {targetAddress}
            </code>
            {failoverBadge}
          </div>
        </div>
      </div>
    );
  };

  const renderTableTransferEntry = (rule: any) => {
    const { entryAddresses, entryTitle } = getRuleTransferDisplay(rule);
    return (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-[11px] leading-5">
        {entryAddresses.map((entry) => (
          <button
            key={`${entry.label}:${entry.value}`}
            type="button"
            onClick={() => copyEntryAddress(rule, entry.value)}
            className="group inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-left transition-colors hover:bg-muted/70"
            title={`${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}`}
          >
            {entryAddresses.length > 1 && <span className="shrink-0 text-[10px] text-muted-foreground">{entry.label}</span>}
            <code className="min-w-0 truncate">{entry.text}</code>
            <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
          </button>
        ))}
      </div>
    );
  };

  const renderTableTransferExit = (rule: any) => {
    const { targetAddress, failoverCount, failoverEnabled, failoverStrategy } = getRuleTransferDisplay(rule);
    return (
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-5">
        <code className="min-w-0 truncate rounded border border-border/40 bg-muted/30 px-1.5 py-0.5" title={targetAddress}>
          {targetAddress}
        </code>
        {failoverEnabled && (
          <Badge variant="outline" className="h-5 shrink-0 border-amber-500/30 px-1.5 text-[10px] text-amber-600">
            {failoverStrategyLabels[failoverStrategy]} {failoverCount}
          </Badge>
        )}
      </div>
    );
  };

  const forwardToolBadgeClass = (forwardType: unknown) => {
    const type = String(forwardType || "");
    if (type === "iptables" || type === "nftables") return "border-primary/25 bg-primary/5 text-primary";
    if (type === "socat") return "border-chart-5/25 bg-chart-5/5 text-chart-5";
    if (type === "gost") return "border-chart-4/25 bg-chart-4/5 text-chart-4";
    return "border-chart-3/25 bg-chart-3/5 text-chart-3";
  };

  const renderForwardToolBadge = (rule: any) => {
    const forwardType = String(rule.forwardType || "");
    const label = FORWARD_TYPE_LABELS[forwardType as ForwardType] || forwardType || "-";
    return (
      <Badge
        variant="outline"
        className={`w-fit whitespace-nowrap text-[10px] ${forwardToolBadgeClass(forwardType)}`}
        title={`转发工具：${label}`}
      >
        {forwardType === "iptables" || forwardType === "nftables" ? (
          <Shield className="mr-1 h-3 w-3" />
        ) : forwardType === "socat" ? (
          <ArrowRightLeft className="mr-1 h-3 w-3" />
        ) : forwardType === "gost" ? (
          <Network className="mr-1 h-3 w-3" />
        ) : (
          <Zap className="mr-1 h-3 w-3" />
        )}
        {label}
      </Badge>
    );
  };

  const getRuleKernelForwardWarning = (rule: any) => buildKernelForwardWarning({
    rule,
    host: getRuleEntryHost(rule),
    group: rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null,
    hosts: hosts || [],
    hostById,
    forwardGroupById,
  });

  const renderKernelForwardWarningBadge = (warning: string | null) => {
    if (!warning) return null;
    return (
      <Badge
        variant="outline"
        className="h-5 w-fit border-amber-500/35 bg-amber-500/10 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"
        title={warning}
      >
        <AlertCircle className="mr-1 h-3 w-3" />
        跨 IPv4/IPv6 风险
      </Badge>
    );
  };
  const renderRouteBadge = (rule: any, compactRow = false) => {
    const tunnel = rule.forwardType === "gost" && rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const isChainRoute = !!rule.forwardGroupId && isForwardChainGroup(group);
    const kernelWarning = getRuleKernelForwardWarning(rule);
    const warningBadge = renderKernelForwardWarningBadge(kernelWarning);
    const badge = (
      <Badge
        variant="outline"
        className={`w-fit whitespace-nowrap text-[10px] ${
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
          <><Layers3 className="h-3 w-3 mr-1" />{isChainRoute ? "端口转发链" : "转发组"}</>
        ) : tunnel ? (
          <><Network className="h-3 w-3 mr-1" />{getTunnelDisplay(tunnel).badgeLabel}</>
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
    if (isChainRoute) {
      return (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {renderForwardToolBadge(rule)}
          {warningBadge}
        </div>
      );
    }
    if (!tunnel) {
      return warningBadge ? (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {warningBadge}
        </div>
      ) : badge;
    }
    if (compactRow) {
      return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {badge}
          <div className="min-w-0 flex-1 text-muted-foreground">
            {renderTunnelRoute(tunnel, false)}
          </div>
          {warningBadge}
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {badge}
        <div className="min-w-0 text-muted-foreground">
          {renderTunnelRoute(tunnel, true)}
        </div>
      </div>
    );
  };

  const renderUnsupportedHint = (children: ReactNode) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{unsupportedProtocolTitle}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  const renderTrafficBytesValue = (t: { bytesIn?: number | null; bytesOut?: number | null } | undefined, direction: "in" | "out") => {
    const value = direction === "in" ? Number(t?.bytesIn || 0) : Number(t?.bytesOut || 0);
    if (!t || value <= 0) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    const Icon = direction === "in" ? ArrowDownToLine : ArrowUpFromLine;
    const color = direction === "in" ? "text-chart-2" : "text-chart-4";
    return (
      <span className={`flex items-center gap-1 whitespace-nowrap text-xs tabular-nums ${color}`}>
        <Icon className="h-3 w-3 shrink-0" /> {formatBytes(value)}
      </span>
    );
  };

  const renderRuleTrafficValue = (rule: any, direction: "in" | "out") => (
    renderTrafficBytesValue(trafficByRule.get(rule.id), direction)
  );

  const renderRuleDailyTrafficValue = (rule: any, direction: "in" | "out") => (
    renderTrafficBytesValue(dailyTrafficByRule.get(rule.id), direction)
  );

  const renderRuleTraffic = (rule: any) => {
    const t = dailyTrafficByRule.get(rule.id);
    if (!t || (t.bytesIn === 0 && t.bytesOut === 0)) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    return (
      <div className="flex flex-col gap-0.5 text-xs leading-5">
        {renderRuleDailyTrafficValue(rule, "in")}
        {renderRuleDailyTrafficValue(rule, "out")}
      </div>
    );
  };

  const renderMobileRuleTotalTraffic = (rule: any) => {
    const t = totalTrafficByRule.get(rule.id);
    const total = Number(t?.bytesIn || 0) + Number(t?.bytesOut || 0);
    if (!t || total <= 0) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
        title={`累计入向 ${formatBytes(Number(t.bytesIn || 0))} / 出向 ${formatBytes(Number(t.bytesOut || 0))}`}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
        {formatBytes(total)}
      </span>
    );
  };

  const renderRuleTotalTraffic = (rule: any) => {
    const t = totalTrafficByRule.get(rule.id);
    if (!t) {
      return <span className="text-xs text-muted-foreground">累计 —</span>;
    }
    const total = Number(t.bytesIn || 0) + Number(t.bytesOut || 0);
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
        title={`累计入向 ${formatBytes(t.bytesIn)} / 出向 ${formatBytes(t.bytesOut)}`}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
        累计 {formatBytes(total)}
      </span>
    );
  };

  const renderRuleCombinedTraffic = (rule: any) => (
    <div className="space-y-1 whitespace-nowrap">
      {renderRuleTotalTraffic(rule)}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-xs text-muted-foreground">24H</span>
        {renderRuleTraffic(rule)}
      </div>
      {renderLatestLatency(rule)}
    </div>
  );

  const renderTableRuleTotalTraffic = (rule: any) => (
    <div className="min-w-0 whitespace-nowrap text-xs">
      {renderRuleTotalTraffic(rule)}
    </div>
  );

  const renderTableRuleDailyTraffic = (rule: any) => (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs">
      {renderRuleDailyTrafficValue(rule, "in")}
      {renderRuleDailyTrafficValue(rule, "out")}
    </div>
  );

  const renderTableRuleLatency = (rule: any) => (
    <div className="min-w-0 whitespace-nowrap text-xs">
      {renderLatestLatency(rule)}
    </div>
  );

  const renderLatestLatency = (rule: any) => {
    const t = trafficByRule.get(rule.id);
    if (!t?.latestLatencyAt) return <span className="whitespace-nowrap text-xs text-muted-foreground">未测试</span>;
    if (t.latestLatencyIsTimeout) {
      return <LatencyRating isTimeout timeoutText="超时" className="whitespace-nowrap" />;
    }
    if (typeof t.latestLatencyMs === "number" && Number.isFinite(t.latestLatencyMs)) {
      return <LatencyRating latencyMs={t.latestLatencyMs} className="whitespace-nowrap" />;
    }
    return <span className="whitespace-nowrap text-xs text-muted-foreground">未测试</span>;
  };

  const renderRuleActions = (rule: any) => {
    const supported = isRuleSupported(rule);
    if (!supported) {
      return (
        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
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
    const ruleCategory = getRuleCategory(rule, forwardGroupById);
    const isForwardChainRule = ruleCategory === "chain";
    const probeMethod = ruleLatencyProbeMethodForRule(rule);
    return (
      <div className="flex items-center justify-end gap-1 whitespace-nowrap">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setTrafficDetailRule({ id: rule.id, name: rule.name, isForwardChain: isForwardChainRule, probeMethod })}
          title={isForwardChainRule ? "查看链路延迟" : probeMethod === "ping" ? "查看 Ping 延迟" : "查看 TCPing 延迟"}
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
          onClick={() => setResetTrafficTarget({ scope: "rule", rule })}
          disabled={resetTrafficMutation.isPending}
          title={resetTrafficMutation.isPending ? "正在重置统计数据" : "重置规则数据"}
        >
          {resetTrafficMutation.isPending && resetTrafficTarget?.scope === "rule" && Number(resetTrafficTarget.rule?.id) === Number(rule.id)
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RotateCcw className="h-3.5 w-3.5" />}
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

  const handleDisplayModeChange = (nextMode: RuleDisplayMode) => {
    if (nextMode === "globe") {
      handleViewModeChange("globe");
      return;
    }
    if (nextMode === "table") {
      handleViewModeChange("table");
      return;
    }
    setViewMode("card");
    storeRuleViewMode("card");
    setRuleCardSize(nextMode);
    storeRuleCardSize(nextMode);
  };

  const displayMode: RuleDisplayMode = effectiveViewMode === "table" || effectiveViewMode === "globe" ? effectiveViewMode : effectiveRuleCardSize;

  const handleRuleCategoryChange = (value: string) => {
    const next = (value === "local" || value === "tunnel" || value === "chain" || value === "group" ? value : "all") as RuleCategory;
    setRuleCategory(next);
  };

  const handleFilterUserChange = (value: string) => {
    setFilterUser(value);
    storeString(RULE_FILTER_USER_STORAGE_KEY, value);
  };

  const handleFilterHostChange = (value: string) => {
    setFilterHost(value);
    storeString(RULE_FILTER_HOST_STORAGE_KEY, value);
  };

  const handleRulePageSizeChange = (value: string) => {
    const nextPageSize = Number(value) as RulePageSize;
    if (!RULE_PAGE_SIZE_OPTIONS.includes(nextPageSize)) return;
    setRulePageSize(nextPageSize);
    storeRulePageSize(nextPageSize);
  };

  const toggleRuleGroupCollapsed = (type: RuleGroupType) => {
    setRuleGroupCollapsed((prev) => {
      const next = { ...prev, [type]: !prev[type] };
      storeRuleGroupCollapsed(next);
      return next;
    });
  };

  const ruleCardGridClass = effectiveRuleCardSize === "compact"
    ? "standard-card-grid-compact rule-card-grid-static rule-card-grid-static-compact gap-3"
    : "standard-card-grid rule-card-grid-static rule-card-grid-static-standard gap-4";
  const ruleContentModeKey = effectiveViewMode === "card" ? "card" : displayMode;
  const ruleContentTransitionKey = `${ruleCategory}-${ruleContentModeKey}-${isLoading ? "loading" : filteredRules.length > 0 ? "list" : "empty"}`;

  const renderRuleGroupIcon = (type: RuleGroupType, className = "h-4 w-4") => {
    if (type === "chain") return <GitBranch className={`${className} text-amber-600`} />;
    if (type === "group") return <Layers3 className={`${className} text-emerald-600`} />;
    if (type === "tunnel") return <Network className={`${className} text-chart-4`} />;
    return <ArrowRightLeft className={`${className} text-primary`} />;
  };

  const renderRuleGroupHeader = (group: { type: RuleGroupType; label: string; rules: any[] }, compact = false) => {
    const collapsed = !!ruleGroupCollapsed[group.type];
    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => toggleRuleGroupCollapsed(group.type)}
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`} />
        {renderRuleGroupIcon(group.type, compact ? "h-3.5 w-3.5" : "h-4 w-4")}
        <span className="truncate text-sm font-semibold">{group.label}</span>
        <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">{group.rules.length}</Badge>
        {!compact && <span className="min-w-0 truncate text-xs text-muted-foreground">{ruleTypeDescriptions[group.type]}</span>}
      </button>
    );
  };

  const renderRuleTableRow = (rule: any) => {
    const supported = isRuleSupported(rule);
    const protocolKey = getRuleProtocolKey(rule);
    return (
      <TableRow key={rule.id} className={`animate-in fade-in-0 duration-150 ${!supported ? "opacity-70" : ""}`} title={!supported ? unsupportedProtocolTitle : undefined}>
        <TableCell className="px-3 py-2">
          <div className="flex items-center justify-center">
            {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
          </div>
        </TableCell>
        <TableCell className="px-3 py-2">
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
          <TableCell className="px-3 py-2">
            <span className="block truncate text-sm text-muted-foreground" title={getRuleOwnerName(rule)}>
              {getRuleOwnerName(rule)}
            </span>
          </TableCell>
        )}
        <TableCell className="px-3 py-2">
          <span className="block truncate text-sm text-muted-foreground" title={rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}>
            {rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}
          </span>
        </TableCell>
        <TableCell className="px-3 py-2">{renderTableTransferEntry(rule)}</TableCell>
        <TableCell className="px-3 py-2">{renderTableTransferExit(rule)}</TableCell>
        <TableCell className="px-3 py-2">{renderRouteBadge(rule, true)}</TableCell>
        <TableCell className="px-3 py-2 text-center">
          <Badge variant="secondary" className="whitespace-nowrap text-[10px]">{formatForwardRuleProtocol(rule.protocol)}</Badge>
        </TableCell>
        <TableCell className="px-3 py-2">{renderTableRuleTotalTraffic(rule)}</TableCell>
        <TableCell className="px-3 py-2">{renderTableRuleDailyTraffic(rule)}</TableCell>
        <TableCell className="px-3 py-2">{renderTableRuleLatency(rule)}</TableCell>
        <TableCell className="px-3 py-2 text-center">
          {supported ? (
            <Switch
              checked={rule.isEnabled}
              onCheckedChange={(checked) => handleToggleRule(rule, checked)}
              className="scale-75"
              title={rule.isEnabled ? "关闭后该转发规则将停止下发和转发" : "开启后该转发规则将重新下发并恢复转发"}
            />
          ) : (
            renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
          )}
        </TableCell>
        <TableCell className="px-3 py-2 text-right">{renderRuleActions(rule)}</TableCell>
      </TableRow>
    );
  };

  const renderRuleCard = (rule: any) => {
    const supported = isRuleSupported(rule);
    const protocolKey = getRuleProtocolKey(rule);
    if (effectiveRuleCardSize === "compact") {
      return (
        <Card
          key={rule.id}
          className={`border-border/40 bg-card/60 backdrop-blur-md ${!supported ? "opacity-70" : ""}`}
          title={!supported ? unsupportedProtocolTitle : undefined}
        >
          <CardContent className="space-y-2.5 p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <div className="mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{rule.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {rule.forwardGroupId ? getForwardGroupName(rule.forwardGroupId) : getRuleEntryHostName(rule)}
                  </div>
                </div>
              </div>
              {supported ? (
                <Switch
                  checked={rule.isEnabled}
                  onCheckedChange={(checked) => handleToggleRule(rule, checked)}
                  className="shrink-0 scale-75"
                  title={rule.isEnabled ? "关闭后该转发规则将停止下发和转发" : "开启后该转发规则将重新下发并恢复转发"}
                />
              ) : (
                renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="shrink-0 scale-75" /></span>)
              )}
            </div>

            <div className="min-w-0">
              {renderTransfer(rule, true)}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              {renderRouteBadge(rule)}
              <Badge variant="secondary" className="h-5 whitespace-nowrap px-1.5 text-[10px]">
                {formatForwardRuleProtocol(rule.protocol)}
              </Badge>
              {!supported && (
                <Badge variant="outline" className="h-5 border-destructive/30 px-1.5 text-[10px] text-destructive">
                  {protocolKey ? FORWARD_PROTOCOL_LABELS[protocolKey] : "协议"} 不支持
                </Badge>
              )}
            </div>

            {rule.protocolBlockReason && (
              <div className="line-clamp-2 text-[11px] leading-4 text-destructive">
                {rule.protocolBlockReason}
              </div>
            )}

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-t border-border/40 pt-1.5 text-xs">
              <div className="min-w-0">
                <div className="mb-0.5 text-[10px] text-muted-foreground">累计流量</div>
                {renderMobileRuleTotalTraffic(rule)}
              </div>
              <div className="min-w-0 text-right">
                <div className="mb-0.5 text-[10px] text-muted-foreground">24H</div>
                <div className="flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                  {renderRuleDailyTrafficValue(rule, "in")}
                  {renderRuleDailyTrafficValue(rule, "out")}
                </div>
              </div>
            </div>

            <div className="flex justify-end border-t border-border/40 pt-1.5">
              {renderRuleActions(rule)}
            </div>
          </CardContent>
        </Card>
      );
    }
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
                title={rule.isEnabled ? "关闭后该转发规则将停止下发和转发" : "开启后该转发规则将重新下发并恢复转发"}
              />
            ) : (
              renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
            )}
          </div>

          <div className="min-w-0">
            {renderTransfer(rule, true)}
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">链路</div>
              {renderRouteBadge(rule)}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">协议</div>
              <Badge variant="secondary" className="whitespace-nowrap text-[10px]">{formatForwardRuleProtocol(rule.protocol)}</Badge>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/40 pt-2 text-xs">
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">24H 入向</div>
              {renderRuleDailyTrafficValue(rule, "in")}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">24H 出向</div>
              {renderRuleDailyTrafficValue(rule, "out")}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">累计流量</div>
              {renderMobileRuleTotalTraffic(rule)}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">延迟</div>
              {renderLatestLatency(rule)}
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
            <AnimatedStatValue
              value={`${activeCount} / ${filteredRuleTotal} 活跃`}
              loading={rulesHeaderLoading}
              cacheKey={`rules.header.active.${trafficTotalsCacheScope}`}
              fallbackValue="0 / 0 活跃"
            />
          </Badge>
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 md:flex">
            <Button
              variant={displayMode === "compact" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("compact")}
              title="精简卡片"
            >
              <Rows3 className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "standard" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("standard")}
              title="标准卡片"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("table")}
              title="列表"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "globe" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("globe")}
              title="3D 流量转发图"
            >
              <Globe className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={() => setResetTrafficTarget({ scope: "all" })}
            className="gap-2"
            disabled={visibleRuleIdsForMetrics.length === 0 || resetTrafficMutation.isPending}
          >
            {resetTrafficMutation.isPending && resetTrafficTarget?.scope === "all"
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RotateCcw className="h-4 w-4" />}
            重置数据
          </Button>
          <Button
            variant="outline"
            onClick={openCopyDialog}
            className="gap-2"
            disabled={rulePermissionLoading || !canAdd || !hosts || hosts.length < 2 || !rules || rules.length === 0}
            title={!canAdd && !rulePermissionLoading ? "需要管理员授权后才能复制规则" : undefined}
          >
            <ClipboardCopy className="h-4 w-4" />
            复制规则
          </Button>
          <Button
            variant="outline"
            onClick={openImportDialog}
            disabled={rulePermissionLoading || !canAdd || importingRules}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            导入规则
          </Button>
          <Button
            variant="outline"
            onClick={openExportDialog}
            disabled={!transferSourceRules.length}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            导出规则
          </Button>
          {rulePermissionLoading ? (
            <Button disabled className="col-span-2 gap-2 sm:col-span-1">
              <Loader2 className="h-4 w-4 animate-spin" />
              权限加载中
            </Button>
          ) : canAdd ? (
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

      {!canAdd && !rulePermissionLoading && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>您暂无添加转发规则的权限，请联系管理员开通</span>
        </div>
      )}

      {(user?.role === "admin" || (rules && rules.length > 0)) && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">筛选:</span>
            </div>
            <div className="relative w-full sm:w-[260px] lg:w-[320px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={ruleSearchQuery}
                onChange={(event) => setRuleSearchQuery(event.target.value)}
                placeholder="搜索端口 / IP / 域名 / 备注"
                className="h-8 w-full pl-8 pr-8 text-xs"
              />
              {ruleSearchQuery ? (
                <button
                  type="button"
                  aria-label="清空搜索"
                  className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setRuleSearchQuery("")}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {user?.role === "admin" && (
              <Select value={filterUser} onValueChange={handleFilterUserChange}>
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
            <Select value={filterHost} onValueChange={handleFilterHostChange}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[160px]">
                <SelectValue placeholder="所有入口主机" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有入口主机</SelectItem>
                {hosts?.map((h: any) => (
                  <SelectItem key={h.id} value={String(h.id)} textValue={getHostOptionText(h)}>
                    {renderHostStatusLabel(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(rulePageSize)} onValueChange={handleRulePageSizeChange}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[120px]">
                <SelectValue placeholder="每页数量" />
              </SelectTrigger>
              <SelectContent>
                {RULE_PAGE_SIZE_OPTIONS.map((pageSize) => (
                  <SelectItem key={pageSize} value={String(pageSize)}>
                    每页 {pageSize} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Tabs value={ruleCategory} onValueChange={handleRuleCategoryChange}>
            <TabsList className="grid h-auto w-full grid-cols-2 border border-border/30 bg-muted/30 sm:grid-cols-5">
              {([
                { value: "all", label: "全部", icon: LayoutGrid, count: ruleCategoryCounts.all },
                { value: "local", label: desktopRuleTypeLabels.local, icon: ArrowRightLeft, count: ruleCategoryCounts.local },
                { value: "tunnel", label: desktopRuleTypeLabels.tunnel, icon: Network, count: ruleCategoryCounts.tunnel },
                { value: "chain", label: desktopRuleTypeLabels.chain, icon: GitBranch, count: ruleCategoryCounts.chain },
                { value: "group", label: desktopRuleTypeLabels.group, icon: Layers3, count: ruleCategoryCounts.group },
              ] as Array<{ value: RuleCategory; label: string; icon: typeof LayoutGrid; count: number }>).map((item) => {
                const Icon = item.icon;
                return (
                  <TabsTrigger key={item.value} value={item.value} className="min-w-0 justify-center gap-1.5 text-xs sm:text-sm">
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    <Badge variant="secondary" className="ml-0.5 h-5 shrink-0 px-1.5 text-[10px]">{item.count}</Badge>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* 转发流量汇总 */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:gap-3 sm:p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground">入向流量</p>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">累计</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(totalTrafficTotals.bytesIn)}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.bytesIn`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesIn`, "rules.traffic.total.last.bytesIn"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesIn`, "rules.traffic.total.last.bytesIn"]}
                    fallbackValue="0 B"
                    className="truncate text-xs font-semibold tabular-nums sm:text-xl"
                  />
                </div>
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(dailyTrafficTotals.bytesIn)}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesIn`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesIn`, "rules.traffic.daily.last.bytesIn"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesIn`, "rules.traffic.daily.last.bytesIn"]}
                    fallbackValue="0 B"
                    className="truncate text-[10px] font-semibold tabular-nums text-foreground sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <ArrowDownToLine className="h-5 w-5 shrink-0 text-chart-2 sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-3 p-3 sm:gap-4 sm:p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground">出向流量</p>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">累计</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(totalTrafficTotals.bytesOut)}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.bytesOut`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesOut`, "rules.traffic.total.last.bytesOut"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesOut`, "rules.traffic.total.last.bytesOut"]}
                    fallbackValue="0 B"
                    className="truncate text-xs font-semibold tabular-nums sm:text-xl"
                  />
                </div>
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(dailyTrafficTotals.bytesOut)}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesOut`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesOut`, "rules.traffic.daily.last.bytesOut"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesOut`, "rules.traffic.daily.last.bytesOut"]}
                    fallbackValue="0 B"
                    className="truncate text-[10px] font-semibold tabular-nums text-foreground sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <ArrowUpFromLine className="h-5 w-5 shrink-0 text-chart-4 sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-3 p-3 sm:gap-4 sm:p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] sm:text-xs text-muted-foreground">连接次数</p>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">累计</span>
                  <AnimatedStatValue
                    as="span"
                    value={totalTrafficTotals.connections.toLocaleString()}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.connections`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.connections`, "rules.traffic.total.last.connections"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.connections`, "rules.traffic.total.last.connections"]}
                    fallbackValue="0"
                    className="truncate text-xs font-semibold tabular-nums sm:text-xl"
                  />
                </div>
                <div className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="text-[9px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={dailyTrafficTotals.connections.toLocaleString()}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.connections`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.connections`, "rules.traffic.daily.last.connections"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.connections`, "rules.traffic.daily.last.connections"]}
                    fallbackValue="0"
                    className="truncate text-[10px] font-semibold tabular-nums text-foreground sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <Activity className="h-5 w-5 shrink-0 text-chart-3 sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
      </div>

      <RuleContentTransition transitionKey={ruleContentTransitionKey}>
      {isLoading ? (
        <DataSectionLoading label="正在加载转发规则" />
      ) : filteredRules.length > 0 ? (
        <>
          {effectiveViewMode === "globe" ? (
            (!hosts || !tunnels || !forwardGroups) ? (
              <DataSectionLoading label="正在加载转发流量地图" />
            ) : (
              <RuleTrafficGlobe
                rules={filteredRules}
                hosts={hosts || []}
                tunnels={tunnels || []}
                forwardGroups={forwardGroups || []}
                trafficByRule={trafficByRule}
                trafficRangeLabel={trafficRangeLabel}
                targetGeoByAddress={targetGeoByAddress}
                targetGeoLookupReady={targetGeoLookupReady}
                onEditRule={openEdit}
              />
            )
          ) : effectiveViewMode === "card" ? (
            <RuleCardModeTransition mode={effectiveRuleCardSize}>
              {shouldGroupRuleCards ? (
                <AutoAnimateContainer className="space-y-5">
                  {desktopRuleGroups.map((group) => {
                    const collapsed = !!ruleGroupCollapsed[group.type];
                    return (
                      <section key={group.type} className="space-y-2">
                        {renderRuleGroupHeader(group)}
                        <RuleGroupItems open={!collapsed} layout={false} className={ruleCardGridClass}>
                          {group.rules.map((rule: any) => renderRuleCard(rule))}
                        </RuleGroupItems>
                      </section>
                    );
                  })}
                </AutoAnimateContainer>
              ) : (
                <AutoAnimateContainer layout={false} className={ruleCardGridClass}>
                  {pagedRules.map((rule: any) => renderRuleCard(rule))}
                </AutoAnimateContainer>
              )}
            </RuleCardModeTransition>
          ) : (
            <>
              <RuleCardModeTransition mode={effectiveRuleCardSize} className="sm:hidden">
                <AutoAnimateContainer layout={false} className={effectiveRuleCardSize === "compact" ? "grid rule-card-grid-static rule-card-grid-static-compact gap-2" : "grid rule-card-grid-static rule-card-grid-static-standard gap-3"}>
                  {shouldGroupRuleCards ? (
                    desktopRuleGroups.map((group) => {
                      const collapsed = !!ruleGroupCollapsed[group.type];
                      return (
                        <section key={group.type} className="space-y-2">
                          {renderRuleGroupHeader(group)}
                          <RuleGroupItems open={!collapsed} layout={false} className={effectiveRuleCardSize === "compact" ? "grid rule-card-grid-static rule-card-grid-static-compact gap-2" : "grid rule-card-grid-static rule-card-grid-static-standard gap-3"}>
                            {group.rules.map((rule: any) => renderRuleCard(rule))}
                          </RuleGroupItems>
                        </section>
                      );
                    })
                  ) : (
                    pagedRules.map((rule: any) => renderRuleCard(rule))
                  )}
                </AutoAnimateContainer>
              </RuleCardModeTransition>
              <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table className={user?.role === "admin" ? "min-w-[1720px] table-fixed" : "min-w-[1610px] table-fixed"}>
                      <colgroup>
                        <col className="w-[56px]" />
                        <col className="w-[110px]" />
                        {user?.role === "admin" && <col className="w-[110px]" />}
                        <col className="w-[100px]" />
                        <col className="w-[285px]" />
                        <col className="w-[190px]" />
                        <col className="w-[170px]" />
                        <col className="w-[96px]" />
                        <col className="w-[120px]" />
                        <col className="w-[120px]" />
                        <col className="w-[120px]" />
                        <col className="w-[70px]" />
                        <col className="w-[154px]" />
                      </colgroup>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="whitespace-nowrap text-center">状态</TableHead>
                          <TableHead>规则</TableHead>
                          {user?.role === "admin" && <TableHead>用户</TableHead>}
                          <TableHead>主机</TableHead>
                          <TableHead>转发入口</TableHead>
                          <TableHead>转发出口</TableHead>
                          <TableHead>链路</TableHead>
                          <TableHead className="text-center">协议</TableHead>
                          {trafficMetricHeaderLabels.map((label) => (
                            <TableHead key={label} className="whitespace-nowrap">{label}</TableHead>
                          ))}
                          <TableHead className="text-center">开关</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shouldGroupRuleCards ? (
                          desktopRuleGroups.map((group) => {
                            const collapsed = !!ruleGroupCollapsed[group.type];
                            return (
                              <Fragment key={group.type}>
                                <TableRow className="border-border/40 bg-muted/35 hover:bg-muted/50">
                                  <TableCell colSpan={user?.role === "admin" ? 13 : 12} className="p-1">
                                    {renderRuleGroupHeader(group, true)}
                                  </TableCell>
                                </TableRow>
                                {!collapsed && group.rules.map((rule: any) => renderRuleTableRow(rule))}
                              </Fragment>
                            );
                          })
                        ) : (
                          pagedRules.map((rule: any) => renderRuleTableRow(rule))
                        )}
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
      </RuleContentTransition>

      {trafficDetailRule && (
        <TcpingDetailDialog
          ruleId={trafficDetailRule.id}
          ruleName={trafficDetailRule.name}
          isForwardChain={!!trafficDetailRule.isForwardChain}
          probeMethod={trafficDetailRule.probeMethod}
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
          sourceLabel={selfTestLinkTestNodeData.sourceLabel}
          targetLabel={selfTestLinkTestNodeData.targetLabel}
          nodeMeta={selfTestLinkTestNodeData.nodeMeta}
          plannedSegments={selfTestLinkTestNodeData.plannedSegments}
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
        <DialogContent className="flex max-h-[96svh] w-[calc(100vw-1rem)] flex-col gap-3 overflow-hidden p-4 sm:max-w-2xl sm:p-5">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑规则" : "添加转发规则"}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 scroll-pb-28 space-y-3 overflow-y-auto pb-5 pr-1">
            <div className={segmentedControlClassName}>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "local", !canUseLocalForward)}
                  aria-pressed={form.routeMode === "local"}
                  onClick={() => setRouteMode("local")}
                  disabled={!canUseLocalForward}
                  title={!canUseLocalForward ? (hasHostChoices ? unsupportedProtocolTitle : "暂无可用主机") : undefined}
                >
                  <ArrowRightLeft className="h-4 w-4 shrink-0" />
                  <span className="truncate">端口转发</span>
                </button>
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "tunnel", !canUseGost)}
                  aria-pressed={form.routeMode === "tunnel"}
                  onClick={() => setRouteMode("tunnel")}
                  disabled={!canUseGost}
                  title={!canUseGost ? "暂无可用隧道" : undefined}
                >
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="truncate">隧道转发</span>
                </button>
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "chain", !canUseForwardChain)}
                  aria-pressed={form.routeMode === "chain"}
                  onClick={() => setRouteMode("chain")}
                  disabled={!canUseForwardChain}
                  title={!canUseForwardChain ? "暂无可用转发链" : undefined}
                >
                  <GitBranch className="h-4 w-4 shrink-0" />
                  <span className="truncate">转发链</span>
                </button>
                <button
                  type="button"
                  className={routeModeOptionClass(form.routeMode === "group", !canUseFailoverGroup)}
                  aria-pressed={form.routeMode === "group"}
                  onClick={() => setRouteMode("group")}
                  disabled={!canUseFailoverGroup}
                  title={!canUseFailoverGroup ? "暂无可用转发组" : undefined}
                >
                  <Layers3 className="h-4 w-4 shrink-0" />
                  <span className="truncate">转发组</span>
                </button>
              </div>
            </div>

            {form.routeMode === "tunnel" && (
              <div className="space-y-2 rounded-md border border-chart-4/20 bg-chart-4/5 p-2.5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label>使用隧道</Label>
                    <Select
                      value={form.tunnelId ? String(form.tunnelId) : "none"}
                      disabled={availableTunnels.length === 0}
                      onValueChange={(v) => {
                        const nextTunnelId = v === "none" ? null : Number(v);
                        const tunnel = nextTunnelId ? tunnels?.find((t: any) => t.id === nextTunnelId) : null;
                        setForm({
                          ...form,
                          tunnelId: nextTunnelId,
                          hostId: tunnel ? tunnel.entryHostId : null,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择隧道</SelectItem>
                        {availableTunnels.map((t: any) => (
                          <SelectItem key={t.id} value={String(t.id)} textValue={getTunnelSelectText(t)}>
                            {renderTunnelSelectLabel(t)}
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
                {availableTunnels.length === 0 && (
                  <p className="text-xs text-amber-600">暂无可用隧道，请先在链路管理中创建隧道。</p>
                )}
                {selectedTunnel && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {renderTunnelRoute(selectedTunnel, true)}
                    <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedTunnel.listenPort}</code>
                  </div>
                )}
              </div>
            )}

            {isForwardGroupRouteMode && (
              <div className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label>{form.routeMode === "chain" ? "使用转发链" : "使用转发组"}</Label>
                    <Select
                      value={form.forwardGroupId ? String(form.forwardGroupId) : "none"}
                      disabled={(form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).length === 0}
                      onValueChange={(v) => {
                        const nextGroupId = v === "none" ? null : Number(v);
                        const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                        setForm({
                          ...form,
                          forwardGroupId: nextGroupId,
                          forwardType: !isForwardChainGroup(group) && group?.groupType === "tunnel" ? "gost" : form.forwardType,
                          hostId: null,
                          tunnelId: null,
                          failoverEnabled: isForwardChainGroup(group) ? false : form.failoverEnabled,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{form.routeMode === "chain" ? "请选择转发链" : "请选择转发组"}</SelectItem>
                        {(form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).map((group: any) => (
                          <SelectItem key={group.id} value={String(group.id)} textValue={getForwardGroupSelectText(group)}>
                            {renderForwardGroupSelectLabel(group)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Badge variant="outline" className="h-9 justify-center gap-1.5 border-emerald-500/30 px-3 text-emerald-600">
                    <Layers3 className="h-3.5 w-3.5" />
                    {getForwardGroupKindLabel(selectedForwardGroup)}
                  </Badge>
                </div>
                {selectedForwardGroup && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {(selectedForwardGroup.members || []).slice(0, 4).map((member: any, index: number) => (
                      <span key={member.id} className="rounded bg-background/60 px-1.5 py-0.5">
                        {index + 1}. {getForwardGroupMemberLabel(member)}
                      </span>
                    ))}
                    {(selectedForwardGroup.members || []).length > 4 && <span>+{(selectedForwardGroup.members || []).length - 4}</span>}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>规则名称</Label>
                <Input
                  placeholder="例如: Web 服务转发"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>协议</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(v) => setForm({
                    ...form,
                    protocol: v as any,
                    failoverEnabled: v === "tcp" ? form.failoverEnabled : false,
                    proxyProtocolReceive: v !== "udp" ? form.proxyProtocolReceive : false,
                    proxyProtocolSend: v !== "udp" ? form.proxyProtocolSend : false,
                    proxyProtocolExitReceive: v !== "udp" && isTunnelProxyProtocolMode ? form.proxyProtocolExitReceive : false,
                    proxyProtocolExitSend: v !== "udp" && isTunnelProxyProtocolMode ? form.proxyProtocolExitSend : false,
                    tcpFastOpen: v !== "udp" ? form.tcpFastOpen : false,
                    zeroCopy: v !== "udp" ? form.zeroCopy : false,
                    udpOverTcp: v === "udp" || v === "both" ? form.udpOverTcp : false,
                    udpOverTcpPort: 0,
                  })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                    <SelectItem value="both">TCP+UDP</SelectItem>
                  </SelectContent>
                </Select>
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
                        <SelectItem key={h.id} value={String(h.id)} textValue={getHostOptionText(h)}>
                          {renderHostStatusLabel(h)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(form.routeMode === "local" || (isForwardGroupRouteMode && (selectedForwardGroupIsChain || selectedForwardGroup?.groupType === "host"))) && (
                <div className="space-y-2">
                  <Label>转发工具</Label>
                  <Select
                    value={form.forwardType}
                    onValueChange={(v) => setForm({
                      ...form,
                      forwardType: v as any,
                      gostMode: "direct" as const,
                      gostRelayHost: "",
                      gostRelayPort: 0,
                      tunnelId: null,
                      proxyProtocolReceive: v === "gost" || v === "realm" ? form.proxyProtocolReceive : false,
                      proxyProtocolSend: v === "gost" || v === "realm" ? form.proxyProtocolSend : false,
                      proxyProtocolExitReceive: false,
                      proxyProtocolExitSend: false,
                      tcpFastOpen: v === "realm" ? form.tcpFastOpen : false,
                      zeroCopy: v === "realm" ? form.zeroCopy : false,
                      udpOverTcp: false,
                      udpOverTcpPort: 0,
                    })}
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
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{form.routeMode === "local" ? "源端口" : "入口端口"}</Label>
                  <span className="truncate text-xs text-muted-foreground" title={`允许端口范围: ${sourcePortRangeText}`}>
                    {sourcePortRangeText}
                  </span>
                </div>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input
                      type="text"
                      pattern="[0-9]*"
                      placeholder={isForwardGroupRouteMode ? "例如 8080" : "0=随机"}
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
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    onClick={handleRandomPort}
                    title="随机分配端口"
                    disabled={isForwardGroupRouteMode ? !form.forwardGroupId : !form.hostId}
                  >
                    <Shuffle className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{form.routeMode === "local" ? "目标地址" : "最终目标地址"}</Label>
                <Input
                  placeholder="例如: 10.0.0.1 或 example.com"
                  value={form.targetIp}
                  onChange={(e) => setForm({ ...form, targetIp: e.target.value })}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] sm:items-end">
                  <div className="space-y-2">
                    <Label>{form.routeMode === "local" ? "目标端口" : "最终目标端口"} <span className="text-destructive">*</span></Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
                      placeholder="例如: 80"
                      value={form.targetPort || ""}
                      onChange={(e) => setForm({ ...form, targetPort: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="flex min-h-10 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">异常TG提醒</Label>
                      <p className="text-xs text-muted-foreground">
                        {telegramBotReady ? "规则运行异常时提醒已绑定 Telegram 的管理员。" : "请先在系统设置中配置并启用 TG 机器人。"}
                      </p>
                    </div>
                    <Switch
                      checked={telegramBotReady && form.telegramErrorNotifyEnabled}
                      disabled={!telegramBotReady}
                      onCheckedChange={(checked) => setForm({ ...form, telegramErrorNotifyEnabled: checked })}
                    />
                  </div>
                </div>
              </div>
            </div>
            {kernelForwardWarning && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                <div className="flex min-w-0 items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 leading-5">{kernelForwardWarning}</span>
                </div>
              </div>
            )}
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <Label className="text-sm">PROXY Protocol</Label>
                  {!canUseProxyProtocol && proxyProtocolDisabledText && (
                    <span className="text-xs text-amber-600">{proxyProtocolDisabledText}</span>
                  )}
                  {canUseProxyProtocol && isTunnelProxyProtocolMode && (
                    <span className="text-xs text-muted-foreground">入口和出口独立配置</span>
                  )}
                </div>
                <div className={segmentedControlClassName}>
                  <div className="grid grid-cols-2 gap-1">
                    {([1, 2] as ProxyProtocolVersion[]).map((version) => (
                      <button
                        key={version}
                        type="button"
                        className={segmentedOptionClassName(form.proxyProtocolVersion === version)}
                        aria-pressed={form.proxyProtocolVersion === version}
                        disabled={!canUseProxyProtocol || !proxyProtocolAnyEnabled}
                        onClick={() => setForm((prev) => ({ ...prev, proxyProtocolVersion: version }))}
                        title={!proxyProtocolAnyEnabled ? "开启任一 PROXY Protocol 开关后可选择版本" : undefined}
                      >
                        V{version}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {isTunnelProxyProtocolMode ? (
                <div className="space-y-2">
                  {renderProxyProtocolRow("入口", "接收上游", "proxyProtocolReceive", "发送到出口", "proxyProtocolSend")}
                  {renderProxyProtocolRow("出口", "接收入口", "proxyProtocolExitReceive", "发送到目标", "proxyProtocolExitSend")}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {renderProxyProtocolSwitch("接收上游 PROXY", "proxyProtocolReceive")}
                  {renderProxyProtocolSwitch("发送到目标", "proxyProtocolSend")}
                </div>
              )}
              {(form.proxyProtocolSend || form.proxyProtocolExitSend) && (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  发送到下游时，对端服务需启用 PROXY Protocol 解析。
                </p>
              )}
            </div>
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Label className="text-sm">传输优化</Label>
                {!canUseTcpFastOpen && !canUseZeroCopy && !canUseUdpOverTcp && (
                  <span className="text-xs text-amber-600">{transportTuningDisabledText}</span>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {renderTransportTuningSwitch("TCP Fast Open", "降低 TCP 建连等待", "tcpFastOpen", canUseTcpFastOpen)}
                {renderTransportTuningSwitch("zero-copy", "减少内核与用户态拷贝", "zeroCopy", canUseZeroCopy)}
                {renderTransportTuningSwitch("mimic UDP 混淆", "专为 UDP 封锁环境优化，适合游戏场景", "udpOverTcp", canUseUdpOverTcp)}
              </div>
              {canUseUdpOverTcp && form.udpOverTcp && (
                <div className="space-y-1.5 text-[11px] leading-4">
                  <p className="text-muted-foreground">
                    开启后 ForwardX UDP 仍走原生 UDP 加密通道，并在配置网卡的 Agent 上通过 mimic 做 TCP 外观混淆；需要 Agent 系统已安装 mimic 和 mimic-dkms。
                  </p>
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-700 dark:text-amber-300">
                    mimic TCP 外观伪装会增加封装开销。游戏、直播或 UDP 测速在 1400 以上明显丢包时，建议把客户端或业务 UDP MTU 调整到 1200-1300。
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Label className="text-sm">出站策略</Label>
                  {!canUseMainBackup && mainBackupDisabledText && (
                    <p className="mt-1 text-xs text-amber-600">{mainBackupDisabledText}</p>
                  )}
                </div>
                <Select
                  value={form.failoverEnabled ? form.failoverStrategy : "disabled"}
                  onValueChange={(value: FailoverMode) => {
                    const nextEnabled = !selectedForwardGroupIsChain && value !== "disabled";
                    setForm({
                      ...form,
                      forwardType: nextEnabled && canAutoSwitchMainBackupToGost ? "gost" : form.forwardType,
                      failoverEnabled: nextEnabled,
                      failoverStrategy: value === "disabled" ? form.failoverStrategy : value,
                      protocol: nextEnabled ? "tcp" : form.protocol,
                    });
                  }}
                  disabled={!canUseMainBackup}
                >
                  <SelectTrigger className="h-9 w-full sm:w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {failoverModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.failoverEnabled && (
                <div className="space-y-2">
                  <div className="space-y-2">
                    <Label>备用出站（每行一个，最多 10 个）</Label>
                    <Textarea
                      value={form.failoverTargetsText}
                      onChange={(event) => setForm({ ...form, failoverTargetsText: event.target.value })}
                      placeholder={"10.0.0.1:80\nexample.com:443"}
                      className="min-h-24 font-mono text-sm"
                      spellCheck={false}
                    />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label>切换时间（秒）</Label>
                      <Input
                        type="number"
                        min={10}
                        max={3600}
                        step={1}
                        value={form.failoverSeconds || ""}
                        onChange={(event) => setForm({ ...form, failoverSeconds: parseInt(event.target.value) || 0 })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>恢复观察（秒）</Label>
                      <Input
                        type="number"
                        min={10}
                        max={3600}
                        step={1}
                        value={form.recoverSeconds || ""}
                        onChange={(event) => setForm({ ...form, recoverSeconds: parseInt(event.target.value) || 0 })}
                      />
                    </div>
                    {form.failoverStrategy === "fallback" && (
                      <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
                        <div>
                          <Label className="text-sm">恢复后切回</Label>
                        </div>
                        <Switch
                          checked={form.autoFailback}
                          onCheckedChange={(checked) => setForm({ ...form, autoFailback: checked })}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-background/95 pt-3">
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !form.name || (!isForwardGroupRouteMode && !form.hostId) || !form.targetIp || !form.targetPort || (!isForwardGroupRouteMode && portStatus === "used") || (form.routeMode === "local" && !canUseLocalForward) || (form.routeMode === "tunnel" && !form.tunnelId) || (isForwardGroupRouteMode && !form.forwardGroupId) || (form.failoverEnabled && form.protocol !== "tcp")}
            >
              {isPending ? "处理中..." : editingId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              {"导出规则"}
            </DialogTitle>
            <DialogDescription>{"选择范围后导出对应的转发规则"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              <div className="space-y-2">
                <Label>{"类型"}</Label>
                <Select
                  value={exportScopeType}
                  onValueChange={(value) => {
                    setExportScopeType(value as RuleTransferScopeType);
                    setExportResourceId("");
                    setExportResourceSearch("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ruleTransferScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {renderTransferResourcePicker({
                type: exportScopeType,
                resources: exportResources,
                filteredResources: filteredExportResources,
                selectedResource: selectedExportResource,
                selectedId: exportResourceId,
                search: exportResourceSearch,
                onSearch: setExportResourceSearch,
                onSelect: setExportResourceId,
              })}
            </div>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {exportResourceId
                ? `将导出 ${exportableRules.length} 条${ruleTransferScopeLabels[exportScopeType]}规则`
                : `请选择${ruleTransferScopeLabels[exportScopeType]}`}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowExportDialog(false)}>
              {"取消"}
            </Button>
            <Button type="button" onClick={handleExportRules} disabled={!exportResourceId || exportableRules.length === 0}>
              {"确定导出"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showImportDialog}
        onOpenChange={(open) => {
          setShowImportDialog(open);
          if (!open) resetImportDialog();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              {"导入规则"}
            </DialogTitle>
            <DialogDescription>{"选择范围与规则文件后导入"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              <div className="space-y-2">
                <Label>{"类型"}</Label>
                <Select
                  value={importScopeType}
                  onValueChange={(value) => {
                    setImportScopeType(value as RuleTransferScopeType);
                    setImportResourceId("");
                    setImportResourceSearch("");
                    resetImportDialog();
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ruleTransferScopeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {renderTransferResourcePicker({
                type: importScopeType,
                resources: importResources,
                filteredResources: filteredImportResources,
                selectedResource: selectedImportResource,
                selectedId: importResourceId,
                search: importResourceSearch,
                onSearch: setImportResourceSearch,
                onSelect: setImportResourceId,
              })}
            </div>
            <div className="space-y-2">
              <Label>{"规则文件"}</Label>
              <Input key={importFileInputKey} type="file" accept=".json,application/json" onChange={handleImportFileChange} />
            </div>
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                importValidation.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : importFileName || importFileError
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-border/60 bg-muted/30 text-muted-foreground"
              }`}
            >
              {importValidation.message}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowImportDialog(false)} disabled={importingRules}>
              {"取消"}
            </Button>
            <Button type="button" onClick={handleImportRules} disabled={!importValidation.ok || importingRules}>
              {importingRules && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {"导入"}
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
                      <SelectItem key={host.id} value={String(host.id)} textValue={getHostOptionText(host)}>
                        {renderHostStatusLabel(host)}
                      </SelectItem>
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
                          :{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort} / {rule.forwardType} / {formatForwardRuleProtocol(rule.protocol)}
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
                        <span className="block truncate text-sm font-medium">{renderHostStatusLabel(host)}</span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">{getHostEntryAddressText(host) || "-"}</span>
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

      <Dialog open={!!resetTrafficTarget} onOpenChange={(open) => !open && !resetTrafficMutation.isPending && setResetTrafficTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{resetTrafficTarget?.scope === "all" ? "重置全部规则数据" : "重置规则数据"}</DialogTitle>
            <DialogDescription>
              {resetTrafficTarget?.scope === "all"
                ? `确认重置当前列表中 ${visibleRuleIdsForMetrics.length} 条规则的所有统计数据？`
                : `确认重置规则 "${resetTrafficTarget?.rule?.name || ""}" 的所有统计数据？`}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
            这里只清除规则页面展示的统计数据，不会清除用户已使用累计值、余额、套餐用量或计费记录。
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetTrafficTarget(null)}
              disabled={resetTrafficMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmResetTraffic}
              disabled={!resetTrafficTarget || resetTrafficMutation.isPending || (resetTrafficTarget.scope === "all" && visibleRuleIdsForMetrics.length === 0)}
              className="gap-2"
            >
              {resetTrafficMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {resetTrafficMutation.isPending ? "重置中..." : "确认重置"}
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
  sourceLabel,
  targetLabel,
  nodeMeta,
  plannedSegments,
  open,
  onOpenChange,
}: {
  ruleId: number;
  ruleName: string;
  sourceLabel?: string;
  targetLabel?: string;
  nodeMeta?: Record<string, any>;
  plannedSegments?: LinkTestPlannedSegment[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data: latest } = trpc.rules.latestTest.useQuery(
    { ruleId },
    {
      enabled: open,
      refetchInterval: pollingInterval("interactive", open),
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
  const parsedMessage = useMemo(() => parseLinkTestMessage(latest?.message), [latest?.message]);
  const plannedSegmentCount = plannedSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";
  const lastFailureToastKey = useRef("");
  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = parsedMessage.message.trim();
    if (!isTesting && latest && !isSuccess && (message || isTimeout)) {
      const key = `${ruleId}:${status}:${latest?.updatedAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        toast.error(isTimeout ? "转发链路自测超时" : "转发链路自测失败", { duration: 5000 });
      }
    }
  }, [open, isTesting, isSuccess, isTimeout, latest, latest?.updatedAt, parsedMessage.message, ruleId, status]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${probeDialogSizeClass} min-w-0`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            延迟探测
          </DialogTitle>
          <DialogDescription>{ruleName}</DialogDescription>
        </DialogHeader>

        <LinkTestProbeView
          parsed={parsedMessage}
          fallbackLatencyMs={typeof latest?.latencyMs === "number" && latest.latencyMs > 0 ? latest.latencyMs : null}
          isSuccess={isSuccess}
          isTesting={isTesting}
          sourceLabel={sourceLabel}
          targetLabel={targetLabel}
          nodeMeta={nodeMeta}
          plannedSegments={plannedSegments}
          compactFrom={3}
          roomyNodes
          mobileStacked
          wrapDesktopRows
        />

        <DialogFooter className="gap-2">
          <Button
            className="w-full min-w-0 gap-2 sm:w-auto sm:min-w-[112px]"
            disabled={isTesting}
            onClick={() => {
              setOptimisticTesting(true);
              setActiveTestId(null);
              startMutation.mutate({ ruleId });
            }}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            </span>
            {isTesting ? "探测中..." : "链路测试"}
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

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
  Network,
  ClipboardCopy,
  Layers3,
  LayoutGrid,
  List,
  Rows3,
  GitBranch,
  Globe,
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
  blockHttp: boolean;
  blockSocks: boolean;
  blockTls: boolean;
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  failoverEnabled: boolean;
  failoverStrategy: FailoverStrategy;
  failoverTargetsText: string;
  failoverSeconds: number;
  recoverSeconds: number;
  autoFailback: boolean;
};

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
  blockHttp: false,
  blockSocks: false,
  blockTls: false,
  proxyProtocolReceive: false,
  proxyProtocolSend: false,
  proxyProtocolExitReceive: false,
  proxyProtocolExitSend: false,
  failoverEnabled: false,
  failoverStrategy: "fallback",
  failoverTargetsText: "",
  failoverSeconds: 60,
  recoverSeconds: 120,
  autoFailback: true,
};

const gostTunnelModes = new Set(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);
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
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches) {
    return "compact";
  }
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

function getStoredRuleCategory(): RuleCategory {
  const value = getStoredString(RULE_CATEGORY_STORAGE_KEY, "all");
  return value === "local" || value === "tunnel" || value === "chain" || value === "group" ? value : "all";
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
  isAdmin: boolean;
  userId?: number | null;
  forwardGroupById: Map<number, any>;
  getRuleEntryHostId: (rule: any) => number;
};

function RuleGroupItems({
  open,
  className,
  children,
}: {
  open: boolean;
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <AutoAnimateContainer className={`min-h-0 overflow-hidden ${className}`}>
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

function getHostEntryAddresses(host: any | null | undefined): EntryAddress[] {
  const customEntry = String(host?.entryIp || "").trim();
  if (customEntry) return [{ label: "入口", value: customEntry }];

  const rows: EntryAddress[] = [];
  pushUniqueEntryAddress(rows, "IPv4", host?.ipv4);
  pushUniqueEntryAddress(rows, "IPv6", host?.ipv6);
  if (rows.length === 0) pushUniqueEntryAddress(rows, "IP", host?.ip);
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

function isForwardChainGroup(group: any | null | undefined) {
  return String(group?.groupMode || "failover") === "chain";
}

function getForwardGroupKindLabel(group: any | null | undefined) {
  if (isForwardChainGroup(group)) return "端口转发链";
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
  targetGeoByAddress,
  targetGeoLookupReady,
  onEditRule,
}: {
  rules: any[];
  hosts: any[];
  tunnels: any[];
  forwardGroups: any[];
  trafficByRule: Map<number, RuleTrafficSummary>;
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
              <span className="font-medium">24h 流量走向</span>
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
  return [
    "flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    active ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
    disabled ? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground" : "cursor-pointer",
  ].join(" ");
}

function isValidPort(port: number, allowZero = false) {
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535;
}

function isValidTargetHost(value: string) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/.test(value.trim());
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

function formatFailoverTargetsText(raw: unknown) {
  return parseRuleFailoverTargets(raw)
    .map((target) => `${target.targetIp.includes(":") ? `[${target.targetIp}]` : target.targetIp}:${target.targetPort}`)
    .join("\n");
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
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  const [filterHost, setFilterHost] = useState<string>(() => getStoredString(RULE_FILTER_HOST_STORAGE_KEY, "all"));
  const [filterUser, setFilterUser] = useState<string>(() => getStoredString(RULE_FILTER_USER_STORAGE_KEY, "self"));
  const [ruleCategory, setRuleCategory] = useState<RuleCategory>(() => getStoredRuleCategory());
  const [viewMode, setViewMode] = useState<RuleViewMode>(() => getStoredRuleViewMode());
  const [ruleCardSize, setRuleCardSize] = useState<RuleCardSize>(() => getStoredRuleCardSize());
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
  const { data: selectedScopeRules } = trpc.rules.list.useQuery(effectiveRulesQuery as any, {
    enabled: selectedScopeQueryEnabled,
    refetchInterval: 15000,
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

  const [trafficDetailRule, setTrafficDetailRule] = useState<{ id: number; name: string } | null>(null);
  const [selfTestRule, setSelfTestRule] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    prefetchReactGlobe();
  }, []);

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
      : mode === "group" && !isForwardChainGroup(nextGroup) && nextGroup?.groupType === "tunnel"
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
      failoverEnabled: mode === "group" && isForwardChainGroup(nextGroup) ? false : prev.failoverEnabled,
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
    const firstGroup = canUseForwardGroup ? availableForwardGroups[0] : null;
    if (firstForwardType || firstTunnel || firstGroup) {
      setForm({
        ...defaultForm,
        failoverTargetsText: "",
        routeMode: firstForwardType ? "local" : firstTunnel ? "tunnel" : firstGroup ? "group" : "local",
        hostId: firstForwardType ? hosts?.[0]?.id ?? null : firstTunnel ? firstTunnel.entryHostId : null,
        forwardType: firstTunnel && !firstForwardType ? "gost" : !isForwardChainGroup(firstGroup) && firstGroup?.groupType === "tunnel" ? "gost" : firstForwardType ?? "iptables",
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
      blockHttp: false,
      blockSocks: false,
      blockTls: false,
      proxyProtocolReceive: !!rule.proxyProtocolReceive,
      proxyProtocolSend: !!rule.proxyProtocolSend,
      proxyProtocolExitReceive: !!rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: !!rule.proxyProtocolExitSend,
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
    if (form.routeMode === "group") return null;
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
  const selectedForwardGroupIsChain = isForwardChainGroup(selectedForwardGroup);
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
  const canAutoSwitchProxyProtocolToGost = !selectedForwardGroupIsChain
    && proxyProtocolProtocolSupported
    && proxyProtocolForwardType !== "gost"
    && usableForwardTypes.includes("gost")
    && (form.routeMode === "local" || (form.routeMode === "group" && selectedForwardGroup?.groupType === "host"));
  const canUseProxyProtocol = !selectedForwardGroupIsChain
    && proxyProtocolProtocolSupported
    && (proxyProtocolForwardType === "gost" || canAutoSwitchProxyProtocolToGost);
  const proxyProtocolDisabledText = selectedForwardGroupIsChain
    ? "端口转发链不支持 PROXY Protocol。"
    : !proxyProtocolProtocolSupported
    ? "PROXY Protocol 仅支持 TCP 协议。"
    : proxyProtocolForwardType !== "gost" && !canAutoSwitchProxyProtocolToGost
    ? "仅 GOST 端口转发、GOST 隧道和自定义加密隧道支持 PROXY Protocol。"
    : "";

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
  }, [form.hostId, form.routeMode, form.sourcePort, form.tunnelId, editingId, utils, selectedEntryPortPolicy]);

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
    if (!isForwardChainGroup(selectedForwardGroup) && selectedForwardGroup?.groupType === "tunnel" && form.forwardType !== "gost") {
      setForm((prev) => ({ ...prev, forwardType: "gost" }));
    }
  }, [availableForwardGroups, form.forwardType, form.routeMode, selectedForwardGroup]);

  useEffect(() => {
    if (!form.failoverEnabled || canUseMainBackup) return;
    setForm((prev) => ({ ...prev, failoverEnabled: false }));
  }, [canUseMainBackup, form.failoverEnabled]);

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
      const randomPortInput = form.routeMode === "group"
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

  const setProxyProtocolFlag = (field: ProxyProtocolField, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      forwardType: checked && canAutoSwitchProxyProtocolToGost ? "gost" : prev.forwardType,
      [field]: checked,
    }));
  };

  const renderProxyProtocolSwitch = (label: string, field: ProxyProtocolField) => (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2">
      <Label className="min-w-0 truncate text-sm" title={label}>{label}</Label>
      <Switch
        checked={form[field]}
        disabled={!canUseProxyProtocol}
        onCheckedChange={(checked) => setProxyProtocolFlag(field, checked)}
      />
    </div>
  );

  const handleSubmit = () => {
    const submitForwardType = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel")
      ? "gost"
      : (form.proxyProtocolReceive || form.proxyProtocolSend || form.proxyProtocolExitReceive || form.proxyProtocolExitSend) && canAutoSwitchProxyProtocolToGost
      ? "gost"
      : form.forwardType;
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
    if (form.routeMode === "group" && !selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel" && !isProtocolEnabled("gost")) {
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
    };
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
        forwardType: submitForwardType,
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
        ...proxyProtocolPayload,
        ...failoverPayload,
      });
    } else {
      createMutation.mutate({
        hostId: form.routeMode === "group" ? undefined : form.hostId!,
        name: form.name,
        forwardType: submitForwardType,
        protocol: form.protocol,
        gostMode: "direct",
        gostRelayHost: null,
        gostRelayPort: null,
        tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null,
        forwardGroupId: form.routeMode === "group" ? form.forwardGroupId : null,
        sourcePort: form.sourcePort,
        targetIp: form.targetIp,
        targetPort: form.targetPort,
        ...proxyProtocolPayload,
        ...failoverPayload,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const ruleFilters = useMemo<RuleFilterState>(() => ({
    filterUser,
    filterHost,
    ruleCategory,
    isAdmin: user?.role === "admin",
    userId: user?.id,
    forwardGroupById,
    getRuleEntryHostId: getRuleEntryHostIdForSort,
  }), [filterHost, forwardGroupById, getRuleEntryHostIdForSort, ruleCategory, filterUser, user?.id, user?.role]);
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
      ...(viewMode === "globe" ? ruleGlobeTargetAddresses : []),
      selfTestTargetAddress,
    ].filter(Boolean))).slice(0, 100)
  ), [ruleGlobeTargetAddresses, selfTestTargetAddress, viewMode]);
  const { data: ruleTargetGeoRows, isFetched: ruleTargetGeoFetched, isError: ruleTargetGeoError } = trpc.rules.targetGeoBatch.useQuery(
    { targets: ruleTargetGeoAddresses },
    {
      enabled: ruleTargetGeoAddresses.length > 0,
      staleTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );
  const targetGeoLookupReady = viewMode !== "globe" || ruleGlobeTargetAddresses.length === 0 || ruleTargetGeoFetched || ruleTargetGeoError;
  const targetGeoByAddress = useMemo(() => {
    const map = new Map<string, RuleTargetGeo>();
    (ruleTargetGeoRows || []).forEach((row: any) => {
      if (!row?.target || !row.geo) return;
      map.set(normalizeAddressKey(row.target), row.geo as RuleTargetGeo);
    });
    return map;
  }, [ruleTargetGeoRows]);
  // 近 24h 按规则汇总的流量
  const { data: trafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0,
      refetchInterval: 30000,
      staleTime: 15000,
      refetchOnWindowFocus: false,
    }
  );
  const [stableTrafficSummaryRows, setStableTrafficSummaryRows] = useState<any[]>([]);
  useEffect(() => {
    if (!filteredRulesPrimed) return;
    if (visibleRuleIdsForMetrics.length === 0) {
      setStableTrafficSummaryRows([]);
      return;
    }
    if (trafficSummary) {
      setStableTrafficSummaryRows(trafficSummary);
    }
  }, [filteredRulesPrimed, trafficSummary, visibleRuleIdsForMetrics.length]);
  const trafficSummaryRows = visibleRuleIdsForMetrics.length === 0 ? [] : trafficSummary ?? stableTrafficSummaryRows;
  const trafficByRule = useMemo(() => {
    const m = new Map<number, {
      bytesIn: number;
      bytesOut: number;
      connections: number;
      latestLatencyMs: number | null;
      latestLatencyIsTimeout: boolean;
      latestLatencyAt: Date | string | null;
    }>();
    trafficSummaryRows.forEach((t: any) => {
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
  }, [trafficSummaryRows]);
  const trafficTotals = useMemo(() => {
    let bytesIn = 0;
    let bytesOut = 0;
    let connections = 0;
    trafficSummaryRows.forEach((t: any) => {
      bytesIn += Number(t.bytesIn) || 0;
      bytesOut += Number(t.bytesOut) || 0;
      connections += Number(t.connections) || 0;
    });
    return { bytesIn, bytesOut, connections };
  }, [trafficSummaryRows]);
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
    ].join("."),
    [filterHost, ruleCategory, filterUser, user?.id, user?.role],
  );
  const trafficTotalsLastCacheScope = user?.role === "admin" ? "admin" : `user-${user?.id || "self"}`;
  const hasActiveUserFilter = user?.role === "admin" && filterUser !== "self";
  const hasActiveRuleFilter = hasActiveUserFilter || filterHost !== "all" || ruleCategory !== "all";
  const rulesHeaderLoading = isLoading || !rules || !scopedRulesReady || !filteredRulesPrimed;
  const trafficTotalsLoading = rulesHeaderLoading || (visibleRuleIdsForMetrics.length > 0 && (!secondaryQueriesReady || (!trafficSummary && stableTrafficSummaryRows.length === 0)));
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
    pagedRules.forEach((rule: any) => {
      groupByType.get(getRuleDisplayType(rule, forwardGroupById))?.rules.push(rule);
    });
    return groups.filter((group) => group.rules.length > 0);
  }, [forwardGroupById, pagedRules]);
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
    const routeHostIds = ruleGlobeRouteHostIds(rule, tunnelById, forwardGroupById);
    const tunnel = rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    routeHostIds.forEach((hostId: number, index: number) => {
      const host = hostById.get(Number(hostId));
      addHostNodeMeta(meta, host, [
        index === 0 ? "入口" : "",
        index === routeHostIds.length - 1 ? "出口" : "",
        tunnel ? tunnelHopHostName(tunnel, hostId, hosts) : "",
        `主机${hostId}`,
        `主机 #${hostId}`,
      ]);
    });

    const sourceHost = hostById.get(Number(routeHostIds[0] || rule.hostId || 0)) || getRuleEntryHost(rule);
    const exitHost = hostById.get(Number(routeHostIds[routeHostIds.length - 1] || 0));
    if (sourceHost) addHostNodeMeta(meta, sourceHost, ["入口", "源节点"]);
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
      .map((hostId: number) => hostById.get(Number(hostId)))
      .filter(Boolean);
    const plannedSegments: LinkTestPlannedSegment[] = [];
    for (let index = 0; index < routeHosts.length - 1; index += 1) {
      const fromHost = routeHosts[index];
      const toHost = routeHosts[index + 1];
      plannedSegments.push({
        from: hostDisplayName(fromHost),
        to: hostDisplayName(toHost),
        fromMeta: meta[hostDisplayName(fromHost)],
        toMeta: meta[hostDisplayName(toHost)],
      });
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
      sourceLabel: hostDisplayName(sourceHost) || getRuleEntryHostName(rule),
      targetLabel: ruleLabel,
      plannedSegments,
    };
  }, [forwardGroupById, getRuleEntryHost, hosts, selfTestRule?.name, selfTestRuleDetail, targetGeoByAddress, tunnelById]);

  const getRuleOwnerName = (rule: any) => {
    const owner = userById.get(Number(rule.userId));
    return owner?.name || owner?.username || `用户 #${rule.userId}`;
  };

  /** 获取主机的入口地址：优先用用户自定义的 entryIp，未填则回退 ip */
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

  const getRuleEntry = (rule: any): string => {
    return getHostEntryAddress(getRuleEntryHost(rule));
  };

  const getRuleEntries = (rule: any): EntryAddress[] => {
    return getHostEntryAddresses(getRuleEntryHost(rule));
  };

  /** 复制入口 IP:端口 到剪贴板 */
  const copyEntryAddress = async (rule: any, entryValue?: string) => {
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      if (isForwardChainGroup(group)) {
        const entry = String(group?.members?.[0]?.entryAddress || "").trim();
        if (!entry) {
          toast.error("该端口转发链第一台主机未配置入口地址");
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
      const domain = String(group?.domain || "").trim();
      if (!domain) {
        toast.error("该转发组未配置 DDNS 域名");
        return;
      }
      const text = formatAddressWithPort(domain, rule.sourcePort);
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

  const renderTransfer = (rule: any, compact = false) => {
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupEntry = isForwardChainGroup(group)
      ? (group?.members?.[0]?.entryAddress || getForwardGroupName(rule.forwardGroupId))
      : (group?.domain || getForwardGroupName(rule.forwardGroupId));
    const entryItems = rule.forwardGroupId
      ? [{ label: isForwardChainGroup(group) ? "转发链" : "转发组", value: groupEntry }]
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
    const failoverBadge = rule.failoverEnabled ? (
      <Badge variant="outline" className="h-5 shrink-0 border-amber-500/30 px-1.5 text-[10px] text-amber-600">
        {failoverStrategyLabels[normalizeFailoverStrategy(rule.failoverStrategy)]} {failoverCount}
      </Badge>
    ) : null;

    if (compact) {
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-xs">
          {entryAddresses.map((entry) => (
            <button
              key={`${entry.label}:${entry.value}`}
              type="button"
              onClick={() => copyEntryAddress(rule, entry.value)}
              className="group inline-flex max-w-full min-w-0 items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 transition-colors hover:bg-muted/70"
              title={`${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}`}
            >
              <code className="truncate">{entry.text}</code>
              <Copy className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
            </button>
          ))}
          <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <code className="max-w-full truncate rounded bg-muted/40 px-1.5 py-0.5" title={targetAddress}>
            {targetAddress}
          </code>
          {failoverBadge}
        </div>
      );
    }

    return (
      <div className="min-w-0 space-y-1 font-mono text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] text-muted-foreground">入口</span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {entryAddresses.map((entry) => (
              <button
                key={`${entry.label}:${entry.value}`}
                type="button"
                onClick={() => copyEntryAddress(rule, entry.value)}
                className="group inline-flex max-w-full min-w-0 items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 transition-colors hover:bg-muted/70"
                title={`${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}`}
              >
                <code className="min-w-0 break-all leading-4">{entry.text}</code>
                <Copy className="h-3 w-3 flex-shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] text-muted-foreground">出口</span>
          <code className="min-w-0 flex-1 break-all rounded bg-muted/40 px-1.5 py-0.5 leading-4" title={targetAddress}>
            {targetAddress}
          </code>
          {failoverBadge}
        </div>
      </div>
    );
  };

  const renderRouteBadge = (rule: any) => {
    const tunnel = rule.forwardType === "gost" && rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
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
          <><Layers3 className="h-3 w-3 mr-1" />{isForwardChainGroup(group) ? "端口转发链" : "转发组"}</>
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
    if (!tunnel) return badge;
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

  const renderRuleTrafficValue = (rule: any, direction: "in" | "out") => {
    const t = trafficByRule.get(rule.id);
    const value = direction === "in" ? Number(t?.bytesIn || 0) : Number(t?.bytesOut || 0);
    if (!t || value <= 0) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    const Icon = direction === "in" ? ArrowDownToLine : ArrowUpFromLine;
    const color = direction === "in" ? "text-chart-2" : "text-chart-4";
    return (
      <span className={`flex items-center gap-1 text-xs ${color}`}>
        <Icon className="h-3 w-3" /> {formatBytes(value)}
      </span>
    );
  };

  const renderRuleTraffic = (rule: any) => {
    const t = trafficByRule.get(rule.id);
    if (!t || (t.bytesIn === 0 && t.bytesOut === 0)) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    return (
      <div className="flex flex-col gap-0.5 text-xs">
        {renderRuleTrafficValue(rule, "in")}
        {renderRuleTrafficValue(rule, "out")}
      </div>
    );
  };

  const renderLatestLatency = (rule: any) => {
    const t = trafficByRule.get(rule.id);
    if (!t?.latestLatencyAt) return <span className="text-xs text-muted-foreground">未测试</span>;
    if (t.latestLatencyIsTimeout) {
      return <LatencyRating isTimeout timeoutText="超时" />;
    }
    if (typeof t.latestLatencyMs === "number" && Number.isFinite(t.latestLatencyMs)) {
      return <LatencyRating latencyMs={t.latestLatencyMs} />;
    }
    return <span className="text-xs text-muted-foreground">未测试</span>;
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

  const displayMode: RuleDisplayMode = viewMode === "table" || viewMode === "globe" ? viewMode : ruleCardSize;

  const handleRuleCategoryChange = (value: string) => {
    const next = (value === "local" || value === "tunnel" || value === "chain" || value === "group" ? value : "all") as RuleCategory;
    setRuleCategory(next);
    storeString(RULE_CATEGORY_STORAGE_KEY, next);
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

  const ruleCardGridClass = ruleCardSize === "compact"
    ? "standard-card-grid-compact gap-3"
    : "standard-card-grid gap-4";
  const ruleContentModeKey = viewMode === "card" ? "card" : displayMode;
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
          <Badge variant="secondary" className="whitespace-nowrap text-[10px]">{formatForwardRuleProtocol(rule.protocol)}</Badge>
        </TableCell>
        <TableCell>
          <div className="space-y-1">
            {renderRuleTraffic(rule)}
            {renderLatestLatency(rule)}
          </div>
        </TableCell>
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
  };

  const renderRuleCard = (rule: any) => {
    const supported = isRuleSupported(rule);
    const protocolKey = getRuleProtocolKey(rule);
    if (ruleCardSize === "compact") {
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
                />
              ) : (
                renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="shrink-0 scale-75" /></span>)
              )}
            </div>

            <div className="rounded-md bg-muted/25 p-1.5">
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
              />
            ) : (
              renderUnsupportedHint(<span className="inline-flex"><Switch checked={false} disabled className="scale-75" /></span>)
            )}
          </div>

          <div className="rounded-md bg-muted/25 p-2">
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
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">近 24h 入向</div>
              {renderRuleTrafficValue(rule, "in")}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">近 24h 出向</div>
              {renderRuleTrafficValue(rule, "out")}
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
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
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
            onClick={openCopyDialog}
            className="gap-2"
            disabled={rulePermissionLoading || !canAdd || !hosts || hosts.length < 2 || !rules || rules.length === 0}
            title={!canAdd && !rulePermissionLoading ? "需要管理员授权后才能复制规则" : undefined}
          >
            <ClipboardCopy className="h-4 w-4" />
            复制规则
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

      {/* 近 24 小时转发流量汇总 */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 入向</p>
              <AnimatedStatValue
                as="p"
                value={formatBytes(trafficTotals.bytesIn)}
                loading={trafficTotalsLoading}
                cacheKey={`rules.traffic.${trafficTotalsCacheScope}.bytesIn`}
                fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.bytesIn`, "rules.traffic.last.bytesIn"]}
                mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.bytesIn`, "rules.traffic.last.bytesIn"]}
                fallbackValue="0 B"
                className="mt-0.5 truncate text-xs font-semibold tabular-nums sm:mt-1 sm:text-xl"
              />
            </div>
            <ArrowDownToLine className="hidden h-4 w-4 shrink-0 text-chart-2 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 出向</p>
              <AnimatedStatValue
                as="p"
                value={formatBytes(trafficTotals.bytesOut)}
                loading={trafficTotalsLoading}
                cacheKey={`rules.traffic.${trafficTotalsCacheScope}.bytesOut`}
                fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.bytesOut`, "rules.traffic.last.bytesOut"]}
                mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.bytesOut`, "rules.traffic.last.bytesOut"]}
                fallbackValue="0 B"
                className="mt-0.5 truncate text-xs font-semibold tabular-nums sm:mt-1 sm:text-xl"
              />
            </div>
            <ArrowUpFromLine className="hidden h-4 w-4 shrink-0 text-chart-4 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardContent className="flex min-w-0 items-center justify-between gap-2 p-3 sm:p-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs text-muted-foreground">近 24h 连接</p>
              <AnimatedStatValue
                as="p"
                value={trafficTotals.connections.toLocaleString()}
                loading={trafficTotalsLoading}
                cacheKey={`rules.traffic.${trafficTotalsCacheScope}.connections`}
                fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.connections`, "rules.traffic.last.connections"]}
                mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.last.connections`, "rules.traffic.last.connections"]}
                fallbackValue="0"
                className="mt-0.5 truncate text-xs font-semibold tabular-nums sm:mt-1 sm:text-xl"
              />
            </div>
            <Activity className="hidden h-4 w-4 shrink-0 text-chart-3 sm:block sm:h-6 sm:w-6" />
          </CardContent>
        </Card>
      </div>

      <RuleContentTransition transitionKey={ruleContentTransitionKey}>
      {isLoading ? (
        <DataSectionLoading label="正在加载转发规则" />
      ) : filteredRules.length > 0 ? (
        <>
          {viewMode === "globe" ? (
            (!hosts || !tunnels || !forwardGroups) ? (
              <DataSectionLoading label="正在加载转发流量地图" />
            ) : (
              <RuleTrafficGlobe
                rules={filteredRules}
                hosts={hosts || []}
                tunnels={tunnels || []}
                forwardGroups={forwardGroups || []}
                trafficByRule={trafficByRule}
                targetGeoByAddress={targetGeoByAddress}
                targetGeoLookupReady={targetGeoLookupReady}
                onEditRule={openEdit}
              />
            )
          ) : viewMode === "card" ? (
            <RuleCardModeTransition mode={ruleCardSize}>
              {shouldGroupRuleCards ? (
                <AutoAnimateContainer className="space-y-5">
                  {desktopRuleGroups.map((group) => {
                    const collapsed = !!ruleGroupCollapsed[group.type];
                    return (
                      <section key={group.type} className="space-y-2">
                        {renderRuleGroupHeader(group)}
                        <RuleGroupItems open={!collapsed} className={ruleCardGridClass}>
                          {group.rules.map((rule: any) => renderRuleCard(rule))}
                        </RuleGroupItems>
                      </section>
                    );
                  })}
                </AutoAnimateContainer>
              ) : (
                <AutoAnimateContainer className={ruleCardGridClass}>
                  {pagedRules.map((rule: any) => renderRuleCard(rule))}
                </AutoAnimateContainer>
              )}
            </RuleCardModeTransition>
          ) : (
            <>
              <RuleCardModeTransition mode={ruleCardSize} className="sm:hidden">
                <AutoAnimateContainer className={ruleCardSize === "compact" ? "grid gap-2" : "grid gap-3"}>
                  {shouldGroupRuleCards ? (
                    desktopRuleGroups.map((group) => {
                      const collapsed = !!ruleGroupCollapsed[group.type];
                      return (
                        <section key={group.type} className="space-y-2">
                          {renderRuleGroupHeader(group)}
                          <RuleGroupItems open={!collapsed} className={ruleCardSize === "compact" ? "grid gap-2" : "grid gap-3"}>
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
                    <Table className={user?.role === "admin" ? "min-w-[1100px] table-fixed" : "min-w-[980px] table-fixed"}>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-[72px] whitespace-nowrap text-center">状态</TableHead>
                          <TableHead className="w-[120px]">规则</TableHead>
                          {user?.role === "admin" && <TableHead className="w-[120px]">用户</TableHead>}
                          <TableHead className="w-[120px]">主机</TableHead>
                          <TableHead>转发配置</TableHead>
                          <TableHead className="w-[150px]">链路</TableHead>
                          <TableHead className="w-[86px]">协议</TableHead>
                          <TableHead className="w-[140px]">24h 流量 / 延迟</TableHead>
                          <TableHead className="w-[76px] text-center">开关</TableHead>
                          <TableHead className="w-[164px] text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shouldGroupRuleCards ? (
                          desktopRuleGroups.map((group) => {
                            const collapsed = !!ruleGroupCollapsed[group.type];
                            return (
                              <Fragment key={group.type}>
                                <TableRow className="border-border/40 bg-muted/35 hover:bg-muted/50">
                                  <TableCell colSpan={user?.role === "admin" ? 10 : 9} className="p-1">
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
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="rounded-md border border-border/60 bg-muted/25 p-1">
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
                        setForm({ ...form, tunnelId: nextTunnelId, hostId: tunnel ? tunnel.entryHostId : null });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择隧道</SelectItem>
                        {availableTunnels.map((t: any) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.name} / {getTunnelRouteText(t, hosts)} / {String(t.mode).toUpperCase()}
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
                  <p className="text-xs text-amber-600">暂无可用隧道，请先在隧道管理中创建隧道。</p>
                )}
                {selectedTunnel && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {renderTunnelRoute(selectedTunnel, true)}
                    <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedTunnel.listenPort}</code>
                  </div>
                )}
              </div>
            )}

            {form.routeMode === "group" && (
              <div className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
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
                          forwardType: !isForwardChainGroup(group) && group?.groupType === "tunnel" ? "gost" : form.forwardType,
                          hostId: null,
                          tunnelId: null,
                          failoverEnabled: isForwardChainGroup(group) ? false : form.failoverEnabled,
                        });
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">请选择转发组</SelectItem>
                        {availableForwardGroups.map((group: any) => (
                          <SelectItem key={group.id} value={String(group.id)}>
                            {group.name} / {getForwardGroupKindLabel(group)} / {group.members?.length || 0} 成员
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
              {(form.routeMode === "local" || (form.routeMode === "group" && (selectedForwardGroupIsChain || selectedForwardGroup?.groupType === "host"))) && (
                <div className="space-y-2">
                  <Label>转发工具</Label>
                  <Select
                    value={form.forwardType}
                    onValueChange={(v) => setForm({
                      ...form,
                      forwardType: v as any,
                      gostMode: "direct",
                      gostRelayHost: "",
                      gostRelayPort: 0,
                      tunnelId: null,
                      proxyProtocolReceive: v === "gost" ? form.proxyProtocolReceive : false,
                      proxyProtocolSend: v === "gost" ? form.proxyProtocolSend : false,
                      proxyProtocolExitReceive: false,
                      proxyProtocolExitSend: false,
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
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    onClick={handleRandomPort}
                    title="随机分配端口"
                    disabled={form.routeMode === "group" ? !form.forwardGroupId : !form.hostId}
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
            </div>
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <Label className="text-sm">PROXY Protocol</Label>
                {!canUseProxyProtocol && proxyProtocolDisabledText && (
                  <span className="text-xs text-amber-600">{proxyProtocolDisabledText}</span>
                )}
                {canUseProxyProtocol && isTunnelProxyProtocolMode && (
                  <span className="text-xs text-muted-foreground">入口和出口独立配置</span>
                )}
              </div>
              {isTunnelProxyProtocolMode ? (
                <div className="grid gap-2 lg:grid-cols-2">
                  <div className="space-y-2 rounded-md border border-border/50 bg-background/40 p-2">
                    <div className="text-xs font-medium text-muted-foreground">入口</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      {renderProxyProtocolSwitch("接收上游", "proxyProtocolReceive")}
                      {renderProxyProtocolSwitch("发送到出口", "proxyProtocolSend")}
                    </div>
                  </div>
                  <div className="space-y-2 rounded-md border border-border/50 bg-background/40 p-2">
                    <div className="text-xs font-medium text-muted-foreground">出口</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      {renderProxyProtocolSwitch("接收入口", "proxyProtocolExitReceive")}
                      {renderProxyProtocolSwitch("发送到目标", "proxyProtocolExitSend")}
                    </div>
                  </div>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !form.name || (form.routeMode !== "group" && !form.hostId) || !form.targetIp || !form.targetPort || (form.routeMode !== "group" && portStatus === "used") || (form.routeMode === "local" && !canUseLocalForward) || (form.routeMode === "tunnel" && !form.tunnelId) || (form.routeMode === "group" && !form.forwardGroupId) || (form.failoverEnabled && form.protocol !== "tcp")}
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
  const parsedMessage = useMemo(() => parseLinkTestMessage(latest?.message), [latest?.message]);
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
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
        />

        <DialogFooter>
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

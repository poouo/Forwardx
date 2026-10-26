import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import { HintSwitch } from "@/components/ui/hint-switch";
import { useAuth } from "@/_core/hooks/useAuth";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import { RuleLimitsForm, newRuleLimitsForm, ruleLimitsPayload, type RuleLimitsFormValue } from "@/components/rules/RuleLimitsForm";
import { RuleUsageSummary } from "@/components/rules/RuleUsageSummary";
import { RuleGroupBar, RuleGroupMultiSelect, RuleGroupBulkEditor, RuleGroupBulkPagination, RuleGroupBulkApplyButton, useRuleGroupBulkEditor } from "@/components/rules/PersonalRuleGroups";
import { RuleCardControls } from "@/components/rules/RuleCardControls";
import { RulePersonalGroupBadges } from "@/components/rules/RulePersonalGroupBadges";
import { RuleCardMetadata } from "@/components/rules/RuleCardMetadata";
import ListSettings from "@/components/ListSettings";
import ColumnResizeHandle from "@/components/ColumnResizeHandle";
import { useRuleTableLayout } from "@/hooks/useRuleTableLayout";
import type { RuleTableColumnId } from "@shared/ruleTableLayout";
import { NyanpassImportPreview } from "@/components/rules/NyanpassImportPreview";
import { isAdminManagedRule } from "../../../shared/ruleLimits";
import { matchesPersonalRuleGroup } from "../../../shared/ruleGroups";
import { forwardGroupRouteMembers, forwardGroupSelfTestSource } from "../../../shared/forwardGroup";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DashboardLayout from "@/components/DashboardLayout";
import UserSelect from "@/components/UserSelect";
import { ruleOwnerOptionIds } from "@/lib/userSelection";
import { isCompleteRuleSortScope } from "@/lib/ruleSortScope";
import { LatencyRating } from "@/components/LatencyRating";
import { LinkTestProbeView, parseLinkTestMessage, type LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
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
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { Tabs } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
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
import { adaptivePollingInterval } from "@/lib/queryPolicy";
import { handoffManualTestResult } from "@/lib/manualTestCache";
import {
  buildStableRuleProbeMap,
  clearRuleProbeCache,
  hasRuleProbeAfterInvalidation,
  updateRuleProbeCache,
} from "@/lib/ruleProbeCache";
import {
  clearRuleStatusSnapshots,
  readRuleStatusSnapshots,
  writeRuleStatusSnapshots,
  type RuleVisualStatusSnapshot,
} from "@/lib/ruleStatusCache";
import { batchOperationErrorMessage, chunkBatchItems, type BatchOperationResult } from "@/lib/batchOperations";
import { submitRuleTask } from "@/lib/ruleTaskTracker";
import type { RuleTaskAction, RuleTaskResult } from "@shared/ruleTaskQueue";
import {
  RULE_TRANSFER_FILE_KIND,
  RULE_TRANSFER_FILE_VERSION,
  RULE_TRANSFER_MAX_FILE_SIZE,
  RULE_TRANSFER_MAX_IMPORT_COUNT,
  RULE_IMPORT_PORT_TEXT_MAX_LENGTH,
  parseRuleImportPorts,
  assignRuleImportPorts,
  parseManualRuleImportLine,
  findRuleTransferPortConflict,
  serializeRuleTransferText,
  type RuleTransferFileRule,
} from "@/lib/ruleTransfer";
import { parseCompatibleRuleTransferText, validateNyanpassImportTarget, type CompatibleRuleFile } from "@/lib/nyanpassImport";
import {
  filterRuleEntryAddressesForDisplay,
  getEntryAddressFamily as addressFamily,
  resolveRuleEntryHost,
  type EntryAddressFamily,
} from "@/lib/ruleEntryDisplay";
import { cn } from "@/lib/utils";
import { ruleBatchStages, ruleBatchCanAdvance, ruleBatchCategory, ruleBatchModes, ruleBatchModeAvailable, type RuleBatchManageMode } from "@/lib/ruleBatchFlow";
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
  Play,
  Pause,
} from "lucide-react";
import { GlobeWorkspace, globeTooltip, useGlobeScene } from "@/components/GlobeWorkspace";
import {
  FORWARD_TYPES,
  FORWARD_TYPE_LABELS,
  FORWARD_PROTOCOL_LABELS,
  TUNNEL_PROTOCOLS,
  formatForwardRuleProtocol,
  normalizeForwardProtocolSettings,
  type ForwardType,
  type ForwardProtocolKey,
} from "@shared/forwardTypes";
import { ruleLatencyProbeMethodForRule } from "@shared/latencyProbe";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import { Fragment, lazy, Suspense, useState, useMemo, useEffect, useCallback, useRef, type ReactNode, type CSSProperties } from "react";
import { ContentTransition } from "@/components/ui/content-transition";
import { useMotionEnabled } from "@/components/MotionPolicy";
import { toast } from "@/lib/localizedToast";
import { useLocation, useSearch } from "wouter";
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
import { getTunnelExitNames, getTunnelHopIds, getTunnelRouteText, tunnelHopHostName } from "@/lib/tunnelDisplay";
import {
  preferLastKnownForwardRuleVisualStatus,
  resolveForwardRuleVisualStatus,
} from "@/lib/forwardRuleStatus";
import { buildLinkAvailabilityIndex } from "@/lib/linkAvailability";
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

type RuleProtocol = "tcp" | "udp" | "both";
type RuleRouteMode = "local" | "tunnel" | "chain" | "group";


function isForwardGroupBackedRouteModeValue(mode: RuleRouteMode, forwardGroupId?: number | null) {
  return mode === "chain" || mode === "group" || (mode === "local" && Number(forwardGroupId || 0) > 0);
}

type RuleFormData = {
  limits: RuleLimitsFormValue;
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

type FailoverStrategy = "fallback" | "round_robin" | "random" | "ip_hash";
type FailoverMode = "disabled" | FailoverStrategy;

const failoverModeOptions: Array<{ value: FailoverMode; label: string }> = [
  { value: "disabled", label: translateText("不使用") },
  { value: "fallback", label: translateText("主备模式 - 自上而下") },
  { value: "round_robin", label: translateText("轮询模式 - 依次轮换") },
  { value: "random", label: translateText("随机模式 - 随机选择") },
  { value: "ip_hash", label: translateText("哈希模式 - IP哈希") },
];
const failoverStrategyLabels: Record<FailoverStrategy, string> = {
  fallback: translateText("主备"),
  round_robin: translateText("轮询"),
  random: translateText("随机"),
  ip_hash: translateText("IP哈希"),
};
const normalizeFailoverStrategy = (value: unknown): FailoverStrategy => {
  return value === "round_robin" || value === "random" || value === "ip_hash" || value === "fallback"
    ? value
    : "fallback";
};

const defaultForm: RuleFormData = {
  limits: newRuleLimitsForm(),
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
const nginxTunnelModes = new Set(["nginx_stream"]);
const unsupportedProtocolTitle = translateText("当前转发方式已停用，请编辑并切换到可用资源");
const revokedResourceTitle = translateText("资源授权已失效，请编辑规则并选择当前有权限的端口转发或隧道");
const desktopRuleTypeLabels = {
  local: translateText("端口转发"),
  tunnel: translateText("隧道转发"),
  chain: translateText("转发链"),
  group: translateText("转发组"),
} as const;
const ruleTypeDescriptions = {
  local: translateText("使用已保存端口转发"),
  tunnel: translateText("通过隧道出口转发"),
  chain: translateText("按转发链顺序转发"),
  group: translateText("使用转发组入口"),
} as const;

type RuleViewMode = "card" | "table" | "globe";
type RuleCardSize = "standard" | "compact";
type RuleDisplayMode = RuleCardSize | "table" | "globe";
type RulePageSize = 12 | 24 | 36 | 48;
type RuleGroupType = keyof typeof desktopRuleTypeLabels;
type RuleGroupCollapsedState = Partial<Record<RuleGroupType, boolean>>;
type RuleCategory = "all" | "local" | "tunnel" | "chain" | "group";
type RuleCategoryCounts = Record<RuleCategory, number>;
type RuleTransferScopeType = Exclude<RuleCategory, "all">;
type RuleResourceFilter = "all" | `${RuleTransferScopeType}` | `${RuleTransferScopeType}:${number}`;
type BatchEditFormData = Pick<RuleFormData, "routeMode" | "forwardType" | "tunnelId" | "forwardGroupId" | "targetIp" | "targetPort">;

const RULE_CATEGORIES = ["all", "local", "tunnel", "chain", "group"] as const;
const ruleTransferScopeLabels: Record<RuleTransferScopeType, string> = {
  local: translateText("端口转发"),
  tunnel: translateText("隧道"),
  chain: translateText("转发链"),
  group: translateText("转发组"),
};

const ruleTransferScopeOptions: Array<{ value: RuleTransferScopeType; label: string }> = [
  { value: "local", label: translateText("端口转发") },
  { value: "tunnel", label: translateText("隧道") },
  { value: "chain", label: translateText("转发链") },
  { value: "group", label: translateText("转发组") },
];
const importRuleTransferScopeOptions = ruleTransferScopeOptions;

function parseRuleResourceFilter(value: unknown): { type: RuleTransferScopeType | null; id: number | null } {
  const raw = String(value || "").trim();
  if (!raw || raw === "all") return { type: null, id: null };
  const [type, idText] = raw.split(":", 2);
  if (!(ruleTransferScopeOptions as readonly { value: string }[]).some((item) => item.value === type)) {
    return { type: null, id: null };
  }
  const id = idText ? Number(idText) : 0;
  return {
    type: type as RuleTransferScopeType,
    id: Number.isInteger(id) && id > 0 ? id : null,
  };
}

function normalizeRuleResourceFilter(value: unknown): RuleResourceFilter {
  const parsed = parseRuleResourceFilter(value);
  if (!parsed.type) return "all";
  return parsed.id ? `${parsed.type}:${parsed.id}` : parsed.type;
}

const RULE_VIEW_MODE_STORAGE_KEY = "forwardx.rules.viewMode";
const RULE_CARD_SIZE_STORAGE_KEY = "forwardx.rules.cardSize";
const RULE_PAGE_SIZE_STORAGE_KEY = "forwardx.rules.pageSize";
const RULE_GROUP_COLLAPSED_STORAGE_KEY = "forwardx.rules.groupCollapsed";
const RULE_CATEGORY_STORAGE_KEY = "forwardx.rules.category";
const RULE_FILTER_RESOURCE_STORAGE_KEY = "forwardx.rules.filterResource";
const RULE_SORT_CATEGORY_ORDER: RuleTransferScopeType[] = ["local", "tunnel", "chain", "group"];
const RULE_SORT_CATEGORY_RANK = new Map<RuleTransferScopeType, number>(
  RULE_SORT_CATEGORY_ORDER.map((category, index) => [category, index]),
);
const RULE_PAGE_SIZE_OPTIONS: RulePageSize[] = [12, 24, 36, 48];
const EMPTY_RULE_CATEGORY_COUNTS: RuleCategoryCounts = { all: 0, local: 0, tunnel: 0, chain: 0, group: 0 };
const RULE_CATEGORY_COUNTS_CACHE_PREFIX = "forwardx.rules.categoryCounts.v2.";
const RULE_GLOBE_EARTH_IMAGE_URL = "/globe/earth-dark.jpg";
const RULE_GLOBE_COUNTRIES_URL = "/globe/ne_110m_admin_0_countries.geojson";
const RULE_GLOBE_PATH_SURFACE_ALTITUDE = 0.028;
const RULE_GLOBE_PATH_MIN_ALTITUDE = 0.04;
const RULE_GLOBE_PATH_MAX_ALTITUDE = 0.11;
const RULE_GLOBE_PATH_LAYER_ALTITUDE_STEP = 0.006;
const RULE_GLOBE_PATH_LAYER_ALTITUDE_MAX = 0.018;
const RULE_GLOBE_TARGET_OFFSET_DEGREES = 5.8;
const RULE_GLOBE_COLORS = ["#334155", "#4ade80", "#f59e0b", "#fb7185", "#2dd4bf", "#f97316", "#84cc16", "#64748b", "#f472b6", "#14b8a6"];
let reactGlobePrefetchStarted = false;

function normalizeRuleCategoryCounts(value: unknown): RuleCategoryCounts {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const count = (key: RuleCategory) => Math.max(0, Math.floor(Number(source[key]) || 0));
  const local = count("local");
  const tunnel = count("tunnel");
  const chain = count("chain");
  const group = count("group");
  return {
    all: Math.max(0, Math.floor(Number(source.all) || local + tunnel + chain + group)),
    local,
    tunnel,
    chain,
    group,
  };
}

function readCachedRuleCategoryCounts(cacheKey: string): RuleCategoryCounts | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${RULE_CATEGORY_COUNTS_CACHE_PREFIX}${cacheKey}`);
    return raw ? normalizeRuleCategoryCounts(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCachedRuleCategoryCounts(cacheKey: string, counts: RuleCategoryCounts) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${RULE_CATEGORY_COUNTS_CACHE_PREFIX}${cacheKey}`, JSON.stringify(counts));
  } catch {
    // Local UI cache only; ignore storage failures.
  }
}

function ruleCategoryCountsEqual(a: RuleCategoryCounts, b: RuleCategoryCounts) {
  return RULE_CATEGORIES.every((category) => a[category] === b[category]);
}

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

function ruleFilterStorageKey(key: string, user: { id?: number; role?: string } | null | undefined) {
  const identity = user?.id ? `${String(user.role || "user")}-${Number(user.id)}` : "guest";
  return `${key}.${identity}`;
}

function getRuleForwardGroupKind(rule: any, forwardGroupById: Map<number, any>): "local" | "chain" | "group" | null {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (!groupId) return null;
  const group = forwardGroupById.get(groupId);
  const mode = normalizeForwardGroupModeForRule(group);
  if (mode === "port") return "local";
  return mode === "chain" ? "chain" : "group";
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
  filterResource: RuleResourceFilter;
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

type RuleSortableRenderState = {
  itemProps: any;
  handleProps: any;
  isDragging: boolean;
  isDropTarget: boolean;
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
  const motionEnabled = useMotionEnabled();
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (!open || !motionEnabled) {
      setExpanded(open);
      return;
    }
    // Clip only while expanding/collapsing, not the resting cards' shadows.
    const timer = window.setTimeout(() => setExpanded(true), 320);
    return () => window.clearTimeout(timer);
  }, [open, motionEnabled]);

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={`pearl-disclosure-grid grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      {/* The disclosure already animates its height. Do not also scale/FLIP
          the cards inside it: that gives grouped text a different rasterization. */}
      <div className={cn("min-h-0", open && (!motionEnabled || expanded) ? "overflow-visible" : "overflow-hidden", className)}>
        {children}
      </div>
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
  return <ContentTransition transitionKey={transitionKey} className={className}>{children}</ContentTransition>;
}

function RuleRouteTransition({
  transitionKey: _transitionKey,
  className,
  children,
}: {
  transitionKey: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={className}>{children}</div>;
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
  const motionEnabled = useMotionEnabled();
  const mountedModeRef = useRef<RuleCardSize | null>(null);

  useEffect(() => {
    if (mountedModeRef.current === null) {
      mountedModeRef.current = mode;
      return;
    }
    if (mountedModeRef.current === mode) return;
    mountedModeRef.current = mode;
    const element = ref.current;
    if (!element || !motionEnabled || typeof element.animate !== "function") return;

    const animation = element.animate(
      [
        { opacity: 0.9, transform: "translate3d(0, 4px, 0)" },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 140, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => animation.cancel();
  }, [mode, motionEnabled]);

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

  const entryGroup = (isForwardChainGroup(group) || normalizeForwardGroupModeForRule(group) === "port") && Number(group.entryGroupId || 0) > 0
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

  const storedHostId = Number(rule?.hostId || 0);
  if (!entryHostId || entryHostId === storedHostId) {
    addRuleSearchHostParts(parts, filters.hostById.get(storedHostId), sourcePort);
  } else {
    addRuleSearchHostParts(parts, filters.hostById.get(entryHostId), sourcePort);
  }
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
  const resourceFilter = parseRuleResourceFilter(filters.filterResource);
  if (resourceFilter.type) {
    const group = rule?.forwardGroupId ? filters.forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const resourceType = getRuleCategory(rule, filters.forwardGroupById);
    if (resourceType !== resourceFilter.type) return false;
    if (resourceFilter.id) {
      const resourceId = resourceType === "tunnel"
        ? Number(rule?.tunnelId || 0)
        : Number(rule?.forwardGroupId || 0);
      if (resourceId !== resourceFilter.id || (resourceType !== "tunnel" && !group)) return false;
    }
  }
  if (filters.ruleCategory !== "all") {
    if (getRuleCategory(rule, filters.forwardGroupById) !== filters.ruleCategory) return false;
  }
  if (!isRuleSearchMatch(rule, filters)) return false;
  return true;
}

function getTunnelDisplay(tunnel: any | null | undefined, showNginxLabel = true) {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "forwardx") {
    return {
      shortLabel: "ForwardX",
      badgeLabel: translateText("隧道 / ForwardX"),
      toolLabel: translateText("ForwardX 加密隧道"),
    };
  }
  if (gostTunnelModes.has(mode)) {
    return {
      shortLabel: "GOST",
      badgeLabel: translateText("隧道 / GOST"),
      toolLabel: translateText("GOST 隧道"),
    };
  }
  if (nginxTunnelModes.has(mode)) {
    if (!showNginxLabel) {
      return {
        shortLabel: translateText("隧道"),
        badgeLabel: translateText("隧道"),
        toolLabel: translateText("隧道转发"),
      };
    }
    return {
      shortLabel: "Nginx",
      badgeLabel: translateText("隧道 / Nginx"),
      toolLabel: translateText("Nginx Stream 隧道"),
    };
  }
  return {
    shortLabel: mode ? mode.toUpperCase() : translateText("隧道"),
    badgeLabel: mode ? translateText("隧道 / {0}", [mode.toUpperCase()]) : translateText("隧道"),
    toolLabel: translateText("隧道转发"),
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
  return mode === "port" || mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function isForwardChainGroup(group: any | null | undefined) {
  return normalizeForwardGroupModeForRule(group) === "chain";
}

function getForwardGroupRouteLabel(group: any | null | undefined) {
  const mode = normalizeForwardGroupModeForRule(group);
  if (mode === "port") return translateText("端口转发");
  if (mode === "chain") return translateText("转发链");
  return translateText("转发组");
}

function isGostTunnelForMainBackup(tunnel: any | null | undefined) {
  return gostTunnelModes.has(String(tunnel?.mode || "").toLowerCase());
}

function isForwardGroupMainBackupTunnelSupported(group: any | null | undefined, tunnelById: Map<number, any>) {
  if (!group || isForwardChainGroup(group) || String(group?.groupType || "") !== "tunnel") return false;
  const tunnelMembers = (Array.isArray(group.members) ? group.members : [])
    .filter((member: any) => member?.isEnabled !== false && Number(member?.tunnelId || 0) > 0);
  if (tunnelMembers.length === 0) return false;
  return tunnelMembers.every((member: any) => isGostTunnelForMainBackup(tunnelById.get(Number(member.tunnelId))));
}


type LiteralAddressFamily = "ipv4" | "ipv6";

function isKernelForwardType(type: unknown) {
  const text = String(type || "").trim().toLowerCase();
  return text === "iptables" || text === "nftables";
}

function familyLabel(family: EntryAddressFamily) {
  if (family === "ipv4") return "IPv4";
  if (family === "ipv6") return "IPv6";
  if (family === "hostname") return translateText("域名");
  return translateText("未知协议族");
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
    if (host?.ddnsIpVersion === "both" || host?.ddnsRecordType === "BOTH") {
      families.add("ipv4"); families.add("ipv6");
    }
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

function kernelFamilyWarning(toolLabel: string, fromLabel: string, sourceFamilies: Set<LiteralAddressFamily>, targetLabel: string, targetFamily: EntryAddressFamily) {
  if (targetFamily !== "ipv4" && targetFamily !== "ipv6") return null;
  const families = Array.from(sourceFamilies);
  if (families.length === 0) return null;
  if (!families.includes(targetFamily)) {
    return translateText("{0} 属于内核 NAT/防火墙规则，不能把 {1} 入口直接转成 {2} 目标；{3} 到 {4} 需要改用 realm/socat/gost 等用户态转发，或把两端统一到同一协议族。", [toolLabel, familyLabel(families[0]), familyLabel(targetFamily), fromLabel, targetLabel]);
  }
  if (families.length > 1) {
    const otherFamily = families.find((family) => family !== targetFamily);
    if (otherFamily) {
      return translateText("{0} 属于内核 NAT/防火墙规则，{1} 同时暴露 IPv4/IPv6，但 {2} 只明确为 {3}；使用 {4} 入口访问时可能不通，跨 IPv4/IPv6 建议改用用户态转发。", [toolLabel, fromLabel, targetLabel, familyLabel(targetFamily), familyLabel(otherFamily)]);
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
    const firstName = warningHostName(firstHost, translateText("主机{0}", [Number(firstMember.hostId || 0) || ""]));
    for (const entryMember of entryMembers) {
      const entryHost = getHost(Number(entryMember.hostId || 0));
      const entryName = warningHostName(entryHost, translateText("入口主机{0}", [Number(entryMember.hostId || 0) || ""]));
      const warning = kernelFamilyWarning(
        toolLabel,
        translateText("{0} 入口", [entryName]),
        hostEntryFamilies(entryHost),
        translateText("{0} 连接地址", [firstName]),
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
    const currentName = warningHostName(currentHost, translateText("主机{0}", [Number(current.hostId || 0) || ""]));
    const nextName = warningHostName(nextHost, translateText("主机{0}", [Number(next.hostId || 0) || ""]));
    const warning = kernelFamilyWarning(
      toolLabel,
      translateText("{0} 入口", [currentName]),
      inboundFamilies,
      translateText("{0} 连接地址", [nextName]),
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
    translateText("{0} 入口", [warningHostName(lastHost, translateText("主机{0}", [Number(lastMember.hostId || 0) || ""]))]),
    inboundFamilies,
    translateText("最终目标 {0}", [String(rule?.targetIp || "").trim() || "-"]),
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
        translateText("{0} 入口", [warningHostName(memberHost, translateText("成员主机{0}", [Number(member.hostId || 0) || ""]))]),
        hostEntryFamilies(memberHost),
        translateText("最终目标 {0}", [String(rule?.targetIp || "").trim() || "-"]),
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
    translateText("{0} 入口", [warningHostName(entryHost, "入口主机")]),
    hostEntryFamilies(entryHost),
    translateText("目标 {0}", [String(rule?.targetIp || "").trim() || "-"]),
    addressFamily(rule?.targetIp),
  );
}
function isSelectableForwardRuleGroup(group: any | null | undefined) {
  const mode = normalizeForwardGroupModeForRule(group);
  return mode === "port" || mode === "failover" || mode === "chain";
}

function getForwardGroupKindLabel(group: any | null | undefined) {
  const mode = normalizeForwardGroupModeForRule(group);
  if (mode === "port") return translateText("端口转发");
  if (mode === "chain") return translateText("转发链");
  if (mode === "entry") return translateText("入口组");
  if (mode === "exit") return translateText("出口组");
  return group?.groupType === "tunnel" ? translateText("隧道组") : translateText("主机组");
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
  return globeTooltip({
    title: point.name,
    color: point.color,
    rows: [
      { label: translateText("类型"), value: point.kind === "target" ? translateText("目标端口") : translateText("转发节点") },
      { label: translateText("地址"), value: point.addressText || "-" },
      { label: translateText("地区"), value: point.regionText || translateText("未定位") },
      ...(point.targetText ? [{ label: translateText("目标"), value: point.targetText }] : []),
      ...(point.note ? [{ label: translateText("说明"), value: point.note }] : []),
    ],
  });
}

function renderRuleGlobePathTooltip(path: RuleGlobePath) {
  return globeTooltip({
    title: path.rule?.name || translateText("规则 #{0}", [path.rule?.id]),
    color: path.color,
    status: formatBytes(path.totalBytes),
    rows: [
      { label: translateText("入口"), value: `:${path.rule?.sourcePort || "-"}` },
      { label: translateText("目标"), value: path.targetText },
      { label: translateText("路径"), value: path.routeText },
      { label: translateText("末跳"), value: path.finalHopText },
      { label: translateText("入向"), value: formatBytes(path.bytesIn) },
      { label: translateText("出向"), value: formatBytes(path.bytesOut) },
      { label: translateText("连接"), value: String(path.connections || 0) },
    ],
    action: translateText("点击编辑规则"),
  });
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
    const member = forwardGroupRouteMembers(group)
      .find((item: any) => Number(item.tunnelId || 0) > 0);
    const tunnel = member ? tunnelById.get(Number(member.tunnelId)) : null;
    const hopIds = getTunnelHopIds(tunnel);
    if (hopIds.length > 0) return hopIds;
  }
  if (group && group.groupType !== "tunnel") {
    const member = forwardGroupRouteMembers(group)
      .find((item: any) => item.memberType !== "tunnel" && Number(item.hostId || 0) > 0);
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
  (forwardGroups || []).forEach((group: any) => {
    const entryGroup = group?.entryGroup;
    const entryGroupId = Number(entryGroup?.id || group?.entryGroupId || 0);
    if (entryGroupId > 0 && entryGroup && !forwardGroupById.has(entryGroupId)) {
      forwardGroupById.set(entryGroupId, entryGroup);
    }
  });
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
      ? translateText("目标端口位于出口节点，已偏移显示末跳")
      : targetHostPoint
      ? translateText("目标地址匹配已登记主机")
      : targetGeoCoord
      ? translateText("目标地址已定位{0}", [targetGeo?.resolvedAddress && normalizeAddressKey(targetGeo.resolvedAddress) !== normalizeAddressKey(rule.targetIp) ? translateText("，解析到 {0}", [targetGeo.resolvedAddress]) : ""])
      : translateText("目标地址未定位，临时放置在出口附近");
    const targetPoint: RuleGlobePoint = {
      id: `target:${rule.id}`,
      kind: "target",
      name: translateText("目标 {0}", [targetText]),
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
  const [hoveredPath, setHoveredPath] = useState<RuleGlobePath | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<RuleGlobePoint | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null);
  const scene = useGlobeScene(Boolean(hoveredPath || hoveredPoint));
  const { globeRef, size, palette } = scene;
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
  }, []);

  const selectedRoute = globeData.summaries.find((item) => Number(item.rule.id) === selectedRuleId);
  const activeRuleId = hoveredPath?.rule?.id ?? selectedRoute?.rule.id;
  const totalTraffic = globeData.summaries.reduce((sum, item) => sum + item.totalBytes, 0);

  return (
    <>
      <GlobeWorkspace scene={scene} title={translateText("流量转发图")} subtitle={translateText("全球链路 · 流量与节点分布")}
        stats={[{ label: translateText("已定位"), value: `${globeData.summaries.length} / ${rules.length}` }, { label: trafficRangeLabel, value: formatBytes(totalTraffic) }, { label: translateText("待定位"), value: globeData.skipped, tone: globeData.skipped ? "warning" : undefined }]}
        empty={globeData.summaries.length === 0 ? translateText("暂无可定位转发路径") : undefined}
        legend={<><span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full bg-primary" />{translateText("流量路径")}</span><span>{translateText("点击路径可编辑规则")}</span></>}
        sidebar={<>
          <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-3"><h4 className="text-xs font-semibold">{translateText("流量排行")}</h4><span className="text-[11px] text-muted-foreground">{trafficRangeLabel}</span></div>
          {selectedRoute && <div className="m-3 rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words text-xs font-semibold">{selectedRoute.rule.name}</span><button type="button" aria-label={translateText("取消选择")} className="text-muted-foreground hover:text-foreground" onClick={() => setSelectedRuleId(null)}>×</button></div>
            <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">{selectedRoute.routeText}</p>
            <div className="mt-3 flex justify-between gap-2 text-xs tabular-nums"><span>↓ {formatBytes(selectedRoute.bytesIn)}</span><span>↑ {formatBytes(selectedRoute.bytesOut)}</span></div>
            <Button variant="outline" size="sm" className="mt-3 h-7 w-full text-xs" onClick={() => onEditRule(selectedRoute.rule)}>{translateText("编辑规则")}</Button>
          </div>}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {globeData.summaries.slice(0, 50).map((item, index) => <button type="button" key={item.rule.id} className="globe-list-row" data-active={selectedRoute?.rule.id === item.rule.id} aria-pressed={selectedRoute?.rule.id === item.rule.id} onClick={() => { setSelectedRuleId(Number(item.rule.id)); if (item.routePoints[0]) scene.focus(item.routePoints[0]); }}>
              <div className="flex min-w-0 items-center gap-2"><span className="w-4 shrink-0 text-[10px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} /><span className="min-w-0 flex-1 truncate text-xs font-medium">{item.rule.name || translateText("规则 #{0}", [item.rule.id])}</span><span className="shrink-0 text-[11px] tabular-nums">{formatBytes(item.totalBytes)}</span></div>
              <div className="ml-6 mt-1 truncate font-mono text-[10px] text-muted-foreground">{item.targetText}</div>
              <div className="ml-6 mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${totalTraffic ? Math.max(2, item.totalBytes / totalTraffic * 100) : 0}%`, backgroundColor: item.color }} /></div>
            </button>)}
            {globeData.summaries.length === 0 && <p className="px-2 py-8 text-center text-xs text-muted-foreground">{translateText("暂无可定位流量路径")}</p>}
          </div>
          <div className="border-t border-border/50 px-4 py-3 text-[11px] text-muted-foreground">{translateText("点击排行定位链路")}{globeData.summaries.length > 50 ? ` · ${translateText("显示前 {0} 项", [50])}` : ""}</div>
        </>}
      >
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />{translateText("正在加载流量转发图")}</div>
            }
          >
            <ReactGlobe
              ref={globeRef}
              width={size.width}
              height={size.height}
              backgroundColor="rgba(0,0,0,0)"
              globeImageUrl={RULE_GLOBE_EARTH_IMAGE_URL}
              showAtmosphere
              atmosphereColor={palette.primary}
              atmosphereAltitude={0.14}
              showGraticules={false}
              globeCurvatureResolution={6}
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? 0.014 : 0.004}
              polygonCapColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? palette.cap : "rgba(15,23,42,.03)"}
              polygonSideColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? palette.side : "rgba(2,6,23,.1)"}
              polygonStrokeColor={(country) => countryFeatureHasCode(country as RuleGlobeCountryFeature, routeCountryCodes) ? palette.stroke : palette.mutedStroke}
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
                if (activeRuleId != null && activeRuleId !== item.rule?.id) return hexToRgba(item.color, 0.12);
                if (item.variant === "track") return item.trackColor;
                return hoveredPath?.rule?.id === item.rule?.id ? item.color : hexToRgba(item.color, 0.88);
              }}
              pathStroke={(path: object) => {
                const item = path as RuleGlobePath;
                const hovered = activeRuleId === item.rule?.id;
                return item.variant === "track" ? Math.max(1.1, item.stroke - 0.45) : item.stroke + (hovered ? 0.75 : 0);
              }}
              pathDashLength={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.16 : 1}
              pathDashGap={(path: object) => (path as RuleGlobePath).variant === "flow" ? 0.085 : 0}
              pathDashInitialGap={(path: object) => (path as RuleGlobePath).dashInitialGap}
              pathDashAnimateTime={(path: object) => scene.motionEnabled && (path as RuleGlobePath).variant === "flow" ? (path as RuleGlobePath).dashAnimateTime : 0}
              pathTransitionDuration={0}
              pathLabel={(path) => renderRuleGlobePathTooltip(path as RuleGlobePath)}
              onPathHover={(path) => setHoveredPath(path as RuleGlobePath | null)}
              onPathClick={(path) => {
                const rule = (path as RuleGlobePath | null)?.rule;
                if (rule) onEditRule(rule);
              }}
              showPointerCursor={(objectType) => objectType === "path" || objectType === "point"}
              enablePointerInteraction
              onGlobeReady={() => scene.setReady(true)}
            />
          </Suspense>

      </GlobeWorkspace>
      <Card className="border-border/40 bg-card/60 md:hidden">
        <CardContent className="p-6 text-center text-sm text-muted-foreground">{translateText("3D 流量转发图仅在 PC 端显示。")}</CardContent>
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

function getForwardGroupRuleForwardType(group: any | null | undefined, fallback: ForwardType | undefined = "iptables"): ForwardType {
  if (!group) return fallback || "iptables";
  if (!isForwardChainGroup(group) && String(group?.groupType || "") === "tunnel") return "gost";
  return normalizeRuleForwardType(group?.forwardType || fallback);
}

function normalizePositiveRuleNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRuleTransferSeconds(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(3600, Math.max(10, Math.round(parsed))) : fallback;
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
    return { error: translateText("IPv6 地址请使用 [地址]:端口 格式") };
  }
  const index = value.lastIndexOf(":");
  if (index <= 0 || index === value.length - 1) return { error: translateText("请按 地址:端口 格式填写") };
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
    isEnabled: rule?.isEnabled !== false,
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
    failoverSeconds: normalizeRuleTransferSeconds(rule?.failoverSeconds, 60),
    recoverSeconds: normalizeRuleTransferSeconds(rule?.recoverSeconds, 120),
    autoFailback: rule?.autoFailback !== false,
  };
}

function downloadRuleTransferFiles(
  rules: readonly any[],
  scope: Record<string, unknown>,
  fileNameBase: string,
  format: "json" | "text" = "json",
) {
  const chunks = chunkBatchItems(rules, RULE_TRANSFER_MAX_IMPORT_COUNT);
  chunks.forEach((chunk, index) => {
    const payload = {
      kind: RULE_TRANSFER_FILE_KIND,
      version: RULE_TRANSFER_FILE_VERSION,
      exportedAt: new Date().toISOString(),
      scope,
      rules: chunk.map(exportRuleForTransfer),
    };
    const content = format === "text" ? serializeRuleTransferText(payload.rules) : JSON.stringify(payload, null, 2);
    const blob = new Blob([content], { type: format === "text" ? "text/plain;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const partSuffix = chunks.length > 1 ? `-part-${index + 1}-of-${chunks.length}` : "";
    anchor.href = url;
    anchor.download = `${fileNameBase}${partSuffix}.${format === "text" ? "txt" : "json"}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  return chunks.length;
}

function normalizeFailoverTargetsForSubmit(text: string) {
  const targets: Array<{ targetIp: string; targetPort: number }> = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 10) return { error: translateText("备用出站最多支持 10 个") };
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = splitFailoverTargetLine(lines[index]);
    if (!parsed) continue;
    if ("error" in parsed) return { error: translateText("第 {0} 行：{1}", [index + 1, parsed.error]) };
    const targetIp = parsed.targetIp;
    const targetPort = parsed.targetPort;
    if (!isValidTargetHost(targetIp)) {
      return { error: translateText("第 {0} 行：地址格式不正确", [index + 1]) };
    }
    if (!isValidPort(targetPort)) {
      return { error: translateText("第 {0} 行：端口必须在 1-65535 之间", [index + 1]) };
    }
    targets.push({ targetIp, targetPort });
  }
  return { targets };
}

function RulesContent() {
  const confirmDialog = useConfirmDialog();
  const { user } = useAuth();
  const tableLayout = useRuleTableLayout(user);
  const [, setLocation] = useLocation();
  const search = useSearch();
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  const [ruleProbeCacheRevision, setRuleProbeCacheRevision] = useState(0);
  const invalidatedRuleProbeIdsRef = useRef(new Set<number>());
  const invalidateRuleProbeStatuses = useCallback((ruleIds: Iterable<number> | undefined) => {
    if (!ruleIds) return;
    const ids = Array.from(new Set(Array.from(ruleIds)
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (ids.length === 0) return;
    ids.forEach((id) => invalidatedRuleProbeIdsRef.current.add(id));
    clearRuleProbeCache(user?.id, ids);
    clearRuleStatusSnapshots(user?.id, ids);
    setRuleProbeCacheRevision((revision) => revision + 1);
  }, [user?.id]);
  const [secondaryQueriesReady, setSecondaryQueriesReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSecondaryQueriesReady(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  const { data: hosts, isFetched: hostsFetched } = trpc.hosts.options.useQuery(undefined, {
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
  const { data: tunnels } = trpc.tunnels.options.useQuery(undefined, {
    refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
    staleTime: 10000,
    refetchOnWindowFocus: false,
  });
  const { data: forwardGroups, isFetched: forwardGroupsFetched, isError: forwardGroupsError } = trpc.forwardGroups.options.useQuery(undefined, {
    refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
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
  const [formGroupIds, setFormGroupIds] = useState<number[]>([]);
  const [editingRuleOwnerId, setEditingRuleOwnerId] = useState<number | null>(null);
  const [personalGroupFilter, setPersonalGroupFilter] = useState<number | null>(null);
  const [editingOriginalProtocol, setEditingOriginalProtocol] = useState<RuleProtocol | null>(null);
  const [legacyLocalRuleEditId, setLegacyLocalRuleEditId] = useState<number | null>(null);
  const [deleteRule, setDeleteRule] = useState<any | null>(null);
  const [resetTrafficTarget, setResetTrafficTarget] = useState<{ scope: "all" } | { scope: "rule"; rule: any } | null>(null);
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [form, setForm] = useState<RuleFormData>(defaultForm);
  useEffect(() => {
    if (showDialog && !editingId) setForm(prev => ({ ...prev, limits: newRuleLimitsForm() }));
  }, [showDialog, editingId]);
  const filterResourceStorageKey = ruleFilterStorageKey(RULE_FILTER_RESOURCE_STORAGE_KEY, user);
  const ruleCategoryStorageKey = ruleFilterStorageKey(RULE_CATEGORY_STORAGE_KEY, user);
  const [filterResource, setFilterResource] = useState<RuleResourceFilter>(() => (
    normalizeRuleResourceFilter(getStoredString(filterResourceStorageKey, "all"))
  ));
  const [ruleResourceMenuOpen, setRuleResourceMenuOpen] = useState(false);
  const [ruleResourceMenuType, setRuleResourceMenuType] = useState<RuleTransferScopeType>(
    parseRuleResourceFilter(getStoredString(filterResourceStorageKey, "all")).type || "local",
  );
  // Owner scope is deliberate for this visit only. Never restore "all" or a
  // different user's scope from browser storage when opening the rule list.
  const [filterUser, setFilterUser] = useState<string>("self");
  const previousFilterIdentity = useRef(filterResourceStorageKey);
  useEffect(() => {
    if (previousFilterIdentity.current === filterResourceStorageKey) return;
    previousFilterIdentity.current = filterResourceStorageKey;
    const nextResource = normalizeRuleResourceFilter(getStoredString(filterResourceStorageKey, "all"));
    setFilterResource(nextResource);
    setRuleResourceMenuType(parseRuleResourceFilter(nextResource).type || "local");
    setFilterUser("self");
  }, [filterResourceStorageKey]);
  const [ruleSearchQuery, setRuleSearchQuery] = useState("");
  const [ruleCategory, setRuleCategory] = useUrlTab<RuleCategory>({
    values: RULE_CATEGORIES,
    defaultValue: "all",
    storageKey: ruleCategoryStorageKey,
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
  const isOwnRuleScope = user?.role !== "admin" || filterUser === "self" || Number(filterUser) === Number(user?.id);
  const batchGroupEditor = useRuleGroupBulkEditor({ enabled: showCopyDialog && isOwnRuleScope });
  const personalGroupsQuery = trpc.rules.personalGroups.useQuery(undefined, {
    enabled: !!user?.id,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const activePersonalGroupId = isOwnRuleScope ? personalGroupFilter : null;
  useEffect(() => { setPersonalGroupFilter(null); }, [user?.id]);
  const createOwnerUserId = user?.role === "admin" && filterUser !== "self" && filterUser !== "all"
    ? Number(filterUser)
    : undefined;
  const [portStatus, setPortStatus] = useState<"idle" | "checking" | "available" | "used">("idle");
  const [portRangeError, setPortRangeError] = useState<string | null>(null);
  const latestPortCheckRef = useRef(0);
  const [copyRuleIds, setCopyRuleIds] = useState<number[]>([]);
  const [copyRuleSearch, setCopyRuleSearch] = useState("");
  const [copyRuleCategory, setCopyRuleCategory] = useState<RuleCategory>("all");
  const [copyRulePersonalGroupId, setCopyRulePersonalGroupId] = useState<number | null>(null);
  useEffect(() => {
    if (!copyRulePersonalGroupId || !personalGroupsQuery.data) return;
    if (personalGroupsQuery.data.groups.some((group) => group.id === copyRulePersonalGroupId)) return;
    setCopyRulePersonalGroupId(null);
    setCopyRuleIds([]);
  }, [copyRulePersonalGroupId, personalGroupsQuery.data]);
  const [copyManageMode, setCopyManageMode] = useState<RuleBatchManageMode>("copy");
  const [batchStep, setBatchStep] = useState(1);
  const copyBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { copyBodyRef.current?.scrollTo({ top: 0 }); }, [batchStep, copyManageMode]);
  const [copyTargetScopeType, setCopyTargetScopeType] = useState<RuleTransferScopeType>("local");
  const [copyTargetResourceIds, setCopyTargetResourceIds] = useState<number[]>([]);
  // Keep an eagerly-updated snapshot of the target selection.  React state is
  // normally flushed before the next click, but a user can click a checkbox
  // and the action button in the same frame (especially on a busy page).  In
  // that case the button handler may still be running the previous render's
  // closure.  The ref is updated by the selection handlers before scheduling
  // the state update, so a copy always uses the most recent explicit choice.
  const copyTargetSelectionRef = useRef<{
    scopeType: RuleTransferScopeType;
    resourceIds: number[];
  }>({ scopeType: "local", resourceIds: [] });
  const commitCopyTargetSelection = useCallback((scopeType: RuleTransferScopeType, resourceIds: readonly number[]) => {
    const normalizedIds = Array.from(new Set(resourceIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)));
    copyTargetSelectionRef.current = { scopeType, resourceIds: normalizedIds };
    setCopyTargetScopeType(scopeType);
    setCopyTargetResourceIds(normalizedIds);
  }, []);
  const [copyTargetSearch, setCopyTargetSearch] = useState("");
  const [copyConflictStrategy, setCopyConflictStrategy] = useState<"skip" | "auto" | "error">("auto");
  const [copyWorking, setCopyWorking] = useState(false);
  const [batchEditForm, setBatchEditForm] = useState<BatchEditFormData>({
    routeMode: "local",
    forwardType: defaultForm.forwardType,
    tunnelId: null,
    forwardGroupId: null,
    targetIp: "",
    targetPort: 0,
  });
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "text">("json");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportScopeType, setExportScopeType] = useState<RuleTransferScopeType>("local");
  const [exportResourceId, setExportResourceId] = useState("");
  const [exportResourceSearch, setExportResourceSearch] = useState("");
  const [importScopeType, setImportScopeType] = useState<RuleTransferScopeType>("tunnel");
  const [importResourceId, setImportResourceId] = useState("");
  const [importResourceSearch, setImportResourceSearch] = useState("");
  const [importSourceMode, setImportSourceMode] = useState<"file" | "manual" | "nyanpass">("file");
  const [importFile, setImportFile] = useState<CompatibleRuleFile | null>(null);
  const [importNyanpassProtocol, setImportNyanpassProtocol] = useState<RuleProtocol>("both");
  const [importNyanpassAcknowledged, setImportNyanpassAcknowledged] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importFileError, setImportFileError] = useState("");
  const [importFileInputKey, setImportFileInputKey] = useState(0);
  const [importManualText, setImportManualText] = useState("");
  const [importPortText, setImportPortText] = useState("");
  const [importRetryState, setImportRetryState] = useState<{ ports: number[]; preservePorts: boolean } | null>(null);
  const [importingRules, setImportingRules] = useState(false);
  const importingRulesRef = useRef(false);
  const rulePageRequest = usePersistentPageRequest("forwardx.rules.page");
  const rulePageResource = parseRuleResourceFilter(filterResource);
  const rulePageFilterKey = [filterUser, filterResource, ruleCategory, ruleSearchQuery.trim(), rulePageSize, activePersonalGroupId].join(":");
  const previousRulePageFilterKey = useRef(rulePageFilterKey);
  useEffect(() => {
    if (previousRulePageFilterKey.current === rulePageFilterKey) return;
    previousRulePageFilterKey.current = rulePageFilterKey;
    rulePageRequest.setPage(1);
  }, [rulePageFilterKey, rulePageRequest.setPage]);
  const rulePageQuery = trpc.rules.listPage.useQuery({
    personalGroupId: activePersonalGroupId,
    ...(effectiveRulesQuery || {}),
    page: rulePageRequest.page,
    pageSize: rulePageSize,
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
  }, {
    refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const isRuleGlobeView = effectiveViewMode === "globe";
  const ruleMapQuery = trpc.rules.mapItems.useInfiniteQuery({
    personalGroupId: activePersonalGroupId,
    ...(effectiveRulesQuery || {}),
    limit: 100,
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
  }, {
    enabled: isRuleGlobeView,
    initialCursor: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const mapRules = useMemo<any[]>(
    () => ruleMapQuery.data?.pages.flatMap((page) => page.items as any[]) || [],
    [ruleMapQuery.data?.pages],
  );
  useEffect(() => {
    if (!isRuleGlobeView || !ruleMapQuery.hasNextPage || ruleMapQuery.isFetchingNextPage) return;
    const loadNextPage = () => void ruleMapQuery.fetchNextPage();
    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
    if ("requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(loadNextPage, { timeout: 1_500 });
    } else {
      timeoutHandle = globalThis.setTimeout(loadNextPage, 120);
    }
    return () => {
      if (idleHandle !== undefined && "cancelIdleCallback" in window) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
    };
  }, [isRuleGlobeView, ruleMapQuery.fetchNextPage, ruleMapQuery.hasNextPage, ruleMapQuery.isFetchingNextPage]);
  const needsFullRuleList = (showCopyDialog && copyManageMode !== "groups")
    || showExportDialog
    || showImportDialog;
  const fullRulesQuery = trpc.rules.list.useQuery(effectiveRulesQuery as any, {
    enabled: needsFullRuleList,
    refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData: any) => previousData,
  });
  useEffect(() => {
    if (!showCopyDialog || copyManageMode === "groups") return;
    void fullRulesQuery.refetch();
  }, [showCopyDialog]);
  const {
    data: ruleListSummary,
    isLoading: ruleListSummaryInitialLoading,
    isPlaceholderData: ruleListSummaryPlaceholder,
  } = trpc.rules.listSummary.useQuery({
    personalGroupId: activePersonalGroupId,
    ...(effectiveRulesQuery || {}),
    resourceType: rulePageResource.type,
    resourceId: rulePageResource.id,
    category: ruleCategory,
    search: ruleSearchQuery,
  }, {
    enabled: secondaryQueriesReady,
    refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const ruleListSummaryLoading = ruleListSummaryInitialLoading || ruleListSummaryPlaceholder;
  const [stableRuleListSummary, setStableRuleListSummary] = useState<any | null>(null);
  useEffect(() => {
    if (!ruleListSummary || ruleListSummaryPlaceholder) return;
    setStableRuleListSummary(ruleListSummary);
  }, [ruleListSummary, ruleListSummaryPlaceholder]);
  // The batch-management dialog may load a separate full rule list, but it
  // must never replace the paged list rendered underneath the dialog.
  const rules = (isRuleGlobeView ? mapRules : rulePageQuery.data?.items) as any[] | undefined;
  const isLoading = isRuleGlobeView
    ? ruleMapQuery.isLoading
    : rulePageQuery.isLoading;
  const ruleListDataReady = isRuleGlobeView
    ? ruleMapQuery.data !== undefined && !ruleMapQuery.isPlaceholderData
    : rulePageQuery.data !== undefined && !rulePageQuery.isPlaceholderData;

  const ownerOptionIds = useMemo(() => ruleOwnerOptionIds(rules || [], createOwnerUserId), [rules, createOwnerUserId]);
  const { data: users } = trpc.users.optionsByIds.useQuery({ ids: ownerOptionIds }, {
    enabled: user?.role === "admin" && ownerOptionIds.length > 0,
    staleTime: 60_000,
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
      utils.rules.personalGroups.invalidate();
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      setShowDialog(false);
      resetForm();
      const msg = data.sourcePort ? translateText("规则创建成功，源端口: {0}", [data.sourcePort]) : translateText("规则创建成功");
      toast.success(msg);
    },
    onError: (err) => toast.error(err.message || translateText("创建失败")),
  });

  const updateMutation = trpc.rules.update.useMutation({
    onSuccess: (_data, variables) => {
      utils.rules.personalGroups.invalidate();
      invalidateRuleProbeStatuses([Number(variables.id)]);
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      setShowDialog(false);
      resetForm();
      toast.success(translateText("规则更新成功"));
    },
    onError: (err) => toast.error(err.message || translateText("更新失败")),
  });

  const deleteMutation = trpc.rules.delete.useMutation({
    onSuccess: (_data, variables) => {
      utils.rules.personalGroups.invalidate();
      invalidateRuleProbeStatuses([Number(variables.id)]);
      utils.rules.list.invalidate();
      utils.rules.listPage.invalidate();
      utils.rules.mapItems.invalidate();
      utils.rules.listSummary.invalidate();
      toast.success(translateText("规则已删除"));
    },
    onError: (err) => toast.error(err.message || translateText("删除失败")),
  });

  const reorderRulesMutation = trpc.rules.reorder.useMutation({
    onError: (err) => toast.error(err.message || translateText("排序保存失败")),
  });
  const ruleReorderPending = reorderRulesMutation.isPending;

  const [ruleTaskEnqueued, setRuleTaskEnqueued] = useState(false);
  const ruleTaskSubmitting = useRef(false);
  const runQueuedRules = async <T, R,>(items: readonly T[], title: string, action: (item: T) => RuleTaskAction,
    value: (result: RuleTaskResult, item: T) => R): Promise<Array<BatchOperationResult<T, R>>> => {
    if (ruleTaskSubmitting.current) throw Error(translateText("已有批量任务正在提交或执行"));
    if (!user) throw Error(translateText("请先登录"));
    ruleTaskSubmitting.current = true;
    try {
      const task = await submitRuleTask({
        enqueue: input => utils.client.rules.enqueueTask.mutate(input),
        lookup: input => utils.client.rules.taskLookup.query(input),
      }, user.id, title, items.map(action), () => setRuleTaskEnqueued(true));
      return (task.results || []).map(result => result.status === "failed" || result.status === "cancelled"
        ? { item: items[result.index], status: "rejected" as const, reason: Error(result.error || translateText("任务已停止，该项未执行")) }
        : { item: items[result.index], status: "fulfilled" as const, value: value(result, items[result.index]) });
    } finally { ruleTaskSubmitting.current = false; setRuleTaskEnqueued(false); }
  };

  const [trafficDetailRule, setTrafficDetailRule] = useState<{ id: number; name: string; isForwardChain?: boolean; probeMethod?: "tcping" | "ping" } | null>(null);
  const [selfTestRule, setSelfTestRule] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    prefetchReactGlobe();
  }, []);

  const setRouteMode = (mode: RuleRouteMode) => {
    if (mode === form.routeMode) return;
    if (mode === "local" && !canUseLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    const localUsesSavedForward = mode === "local" && canUseSavedLocalForward;
    const nextGroups = localUsesSavedForward
      ? availablePortForwardGroups
      : mode === "chain"
      ? availableForwardChainGroups
      : mode === "group"
      ? availableFailoverForwardGroups
      : [];
    const nextTunnel = mode === "tunnel"
      ? (selectedTunnel || availableTunnels[0] || supportedTunnels[0])
      : null;
    const usesForwardGroup = mode === "chain" || mode === "group" || localUsesSavedForward;
    const nextBillingHost = mode === "local" && !localUsesSavedForward
      ? (availableTrafficBillingHosts.find((host: any) => Number(host.id) === Number(form.hostId)) || availableTrafficBillingHosts[0] || null)
      : null;
    if (mode === "tunnel" && !nextTunnel) return;
    if (usesForwardGroup && nextGroups.length === 0) return;
    if (mode === "local" && !usesForwardGroup && !nextBillingHost) return;
    const expectedGroupMode = mode === "local" ? "port" : mode === "chain" ? "chain" : "failover";
    const nextGroup = usesForwardGroup
      ? (selectedForwardGroup && normalizeForwardGroupModeForRule(selectedForwardGroup) === expectedGroupMode ? selectedForwardGroup : nextGroups[0])
      : null;
    const nextDirectForwardType = usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0];
    const nextForwardType = mode === "tunnel"
      ? "gost"
      : usesForwardGroup
      ? getForwardGroupRuleForwardType(nextGroup, usableForwardTypes.includes(form.forwardType) ? form.forwardType : usableForwardTypes[0])
      : nextDirectForwardType;
    if (!nextForwardType) return;
    latestPortCheckRef.current += 1;
    setPortStatus("idle");
    setPortRangeError(null);
    setForm((prev) => ({
      ...prev,
      routeMode: mode,
      forwardType: nextForwardType,
      tunnelId: mode === "tunnel" && nextTunnel ? Number(nextTunnel.id) : null,
      forwardGroupId: usesForwardGroup && nextGroup ? Number(nextGroup.id) : null,
      hostId: mode === "tunnel" && nextTunnel
        ? nextTunnel.entryHostId
        : usesForwardGroup
        ? null
        : availableTrafficBillingHosts.some((host: any) => Number(host.id) === Number(prev.hostId))
        ? prev.hostId
        : (Number(nextBillingHost?.id || 0) || null),
      failoverEnabled: false,
      failoverTargetsText: "",
    }));
  };
  const toggleMutation = trpc.rules.toggle.useMutation({
    onSuccess: async (_data, variables) => {
      invalidateRuleProbeStatuses([Number(variables.id)]);
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.auth.me.invalidate(),
        utils.billing.me.invalidate(),
      ]);
    },
  });

  const isTrafficBillingRule = (rule: any) => {
    if (!trafficBilling?.enabled) return false;
    const resourceIds = trafficBilling.usableResourceIds || { hostIds: [], tunnelIds: [], forwardGroupIds: [] };
    if (rule.forwardGroupId) {
      return (resourceIds.forwardGroupIds || []).map(Number).includes(Number(rule.forwardGroupId));
    }
    if (rule.tunnelId) {
      return (resourceIds.tunnelIds || []).map(Number).includes(Number(rule.tunnelId));
    }
    return (resourceIds.hostIds || []).map(Number).includes(Number(rule.hostId));
  };

  const toggleRuleEnabled = async (rule: any, checked: boolean) => {
    const id = Number(rule?.id || 0);
    if (!id) throw new Error(translateText("规则不存在"));
    if (
      checked &&
      user?.role !== "admin" &&
      trafficBilling?.enabled &&
      isTrafficBillingRule(rule) &&
      walletBalanceKnown &&
      Number(wallet?.balanceCents || 0) <= 0
    ) {
      throw new Error(translateText("流量计费余额不足，请充值后再启用规则"));
    }
    await toggleMutation.mutateAsync({ id, isEnabled: checked });
  };

  const renderRuleEnabledSwitch = (rule: any) => {
    if (user?.role !== "admin" && isAdminManagedRule(rule)) {
      return <span title={translateText("管理员自定义规则仅可查看，请联系管理员修改")}><Switch checked={isRuleSupported(rule) && rule.resourceAccessAllowed !== false && !!rule.isEnabled && !rule.ruleLimitReason} disabled className="scale-75" aria-label={translateText("仅可查看")} /></span>;
    }
    const supported = isRuleSupported(rule);
    const resourceAccessAllowed = rule.resourceAccessAllowed !== false;
    const enabled = resourceAccessAllowed && !!rule.isEnabled;
    const title = enabled ? translateText("关闭后该转发规则将停止下发和转发") : translateText("开启后该转发规则将重新下发并恢复转发");
    const content = supported && resourceAccessAllowed ? (
      <OptimisticSwitch
        checked={enabled}
        onCheckedChangeAsync={(checked) => toggleRuleEnabled(rule, checked)}
        onToggleSuccess={(checked) => toast.success(checked ? translateText("规则已开启") : translateText("规则已关闭"))}
        onToggleError={(error) => toast.error(error instanceof Error ? error.message : translateText("切换规则状态失败"))}
        className="scale-75"
        title={title}
        aria-label={translateText("{0}转发规则 {1}", [enabled ? translateText("停用") : translateText("启用"), rule.name || ""])}
      />
    ) : (
      <span className="inline-flex shrink-0" title={resourceAccessAllowed ? unsupportedProtocolTitle : revokedResourceTitle}>
        <Switch checked={false} disabled className="scale-75" aria-label={resourceAccessAllowed ? translateText("当前协议不支持，规则已停用") : translateText("资源授权已失效，规则已停用")} />
      </span>
    );
    return supported && resourceAccessAllowed ? content : renderUnsupportedHint(content, resourceAccessAllowed ? unsupportedProtocolTitle : revokedResourceTitle);
  };

  const resetForm = () => {
    setFormGroupIds([]);
    setEditingRuleOwnerId(null);
    setForm({ ...defaultForm, failoverTargetsText: "" });
    setEditingId(null);
    setEditingOriginalProtocol(null);
    setLegacyLocalRuleEditId(null);
    setPortStatus("idle");
  };

  const openCreate = (preferredRouteMode?: RuleRouteMode) => {
    resetForm();
    setFormGroupIds(activePersonalGroupId && isOwnRuleScope ? [activePersonalGroupId] : []);
    const firstPortGroup = canUseSavedLocalForward ? availablePortForwardGroups[0] : null;
    const firstLocalForwardType = firstPortGroup ? getForwardGroupRuleForwardType(firstPortGroup, defaultForm.forwardType) : null;
    const firstBillingHost = canUseBillingHostLocalForward ? availableTrafficBillingHosts[0] : null;
    const firstDirectForwardType = usableForwardTypes.includes(defaultForm.forwardType) ? defaultForm.forwardType : usableForwardTypes[0];
    const firstTunnel = canUseGost
      ? supportedTunnels[0]
      : null;
    const firstChain = canUseForwardChain ? availableForwardChainGroups[0] : null;
    const firstGroup = canUseFailoverGroup ? availableFailoverForwardGroups[0] : null;
    const hasSavedLocalForward = !!firstPortGroup && !!firstLocalForwardType;
    const hasBillingHostLocalForward = !!firstBillingHost && !!firstDirectForwardType;
    if (preferredRouteMode === "local") {
      if (hasSavedLocalForward) {
        setForm({
          ...defaultForm,
          failoverTargetsText: "",
          routeMode: "local",
          hostId: null,
          forwardType: firstLocalForwardType,
          tunnelId: null,
          forwardGroupId: Number(firstPortGroup.id),
        });
        setShowDialog(true);
        return;
      }
      if (hasBillingHostLocalForward) {
        setForm({
          ...defaultForm,
          failoverTargetsText: "",
          routeMode: "local",
          hostId: Number(firstBillingHost.id),
          forwardType: firstDirectForwardType,
          tunnelId: null,
          forwardGroupId: null,
        });
        setShowDialog(true);
        return;
      }
      toast.error(translateText("暂无可用端口转发，请检查链路配置、授权或计费余额"));
      return;
    }
    if (hasSavedLocalForward || hasBillingHostLocalForward || firstTunnel || firstChain || firstGroup) {
      const routeMode: RuleRouteMode = hasSavedLocalForward || hasBillingHostLocalForward ? "local" : firstTunnel ? "tunnel" : firstChain ? "chain" : "group";
      const localUsesSavedForward = routeMode === "local" && hasSavedLocalForward;
      setForm({
        ...defaultForm,
        failoverTargetsText: "",
        routeMode,
        hostId: routeMode === "tunnel" && firstTunnel
          ? firstTunnel.entryHostId
          : routeMode === "local" && !localUsesSavedForward && firstBillingHost
          ? Number(firstBillingHost.id)
          : null,
        forwardType: routeMode === "tunnel"
          ? "gost"
          : routeMode === "group" && firstGroup
          ? getForwardGroupRuleForwardType(firstGroup, "iptables")
          : routeMode === "local" && localUsesSavedForward
          ? firstLocalForwardType
          : routeMode === "local"
          ? firstDirectForwardType
          : "iptables",
        tunnelId: routeMode === "tunnel" && firstTunnel ? firstTunnel.id : null,
        forwardGroupId: routeMode === "local" && localUsesSavedForward && firstPortGroup ? Number(firstPortGroup.id) : routeMode === "chain" && firstChain ? Number(firstChain.id) : routeMode === "group" && firstGroup ? Number(firstGroup.id) : null,
      });
    } else {
      toast.error(translateText("暂无可用转发资源，请检查链路配置、授权或计费余额。"));
      return;
    }
    setShowDialog(true);
  };
  const openCopyDialog = () => {
    setBatchStep(1);
    setCopyManageMode(transferSourceRules.length ? "operate" : "import");
    setBatchEditForm(buildEmptyBatchEditForm());
    setCopyRuleCategory(ruleCategory);
    setCopyRulePersonalGroupId(isOwnRuleScope ? activePersonalGroupId : null);
    setCopyRuleSearch(ruleSearchQuery);
    const preferredCopyTargetScope: RuleTransferScopeType = canUseSavedLocalForward
      ? "local"
      : canUseGost
        ? "tunnel"
        : canUseForwardChain
          ? "chain"
          : "group";
    commitCopyTargetSelection(preferredCopyTargetScope, []);
    setCopyTargetSearch("");
    setCopyRuleIds([]);
    setCopyConflictStrategy("auto");
    const preferredImportType: RuleTransferScopeType = canUseSavedLocalForward
      ? "local"
      : canUseGost
        ? "tunnel"
        : canUseForwardChain
          ? "chain"
          : "group";
    setImportScopeType(preferredImportType);
    setImportResourceId("");
    setImportResourceSearch("");
    setShowCopyDialog(true);
  };

  const openEdit = (rule: any) => {
    setFormGroupIds(rule.personalGroupIds || []);
    setEditingRuleOwnerId(Number(rule.userId));
    const editForwardGroup = rule.forwardGroupId
      ? (forwardGroups || []).find((group: any) => Number(group.id) === Number(rule.forwardGroupId))
      : null;
    const isLegacyLocalRule = !Number(rule.forwardGroupId || 0)
      && !(rule.forwardType === "gost" && Number(rule.tunnelId || 0) > 0);
    setForm({
      hostId: rule.hostId,
      limits: newRuleLimitsForm(rule),
      name: rule.name,
      routeMode: rule.forwardGroupId ? (normalizeForwardGroupModeForRule(editForwardGroup) === "port" ? "local" : isForwardChainGroup(editForwardGroup) ? "chain" : "group") : rule.forwardType === "gost" && rule.tunnelId ? "tunnel" : "local",
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
    setEditingOriginalProtocol(normalizeRuleProtocol(rule.protocol));
    setLegacyLocalRuleEditId(isLegacyLocalRule ? Number(rule.id) : null);
    setPortStatus("idle");
    setShowDialog(true);
  };

  const isLegacyLocalRuleEdit = editingId !== null && legacyLocalRuleEditId === editingId;

  // 获取当前选中主机的端口区间
  const selectedHost = useMemo(() => {
    if (isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId) || (isLegacyLocalRuleEdit && form.routeMode === "local")) return null;
    if (!form.hostId || !hosts) return null;
    return hosts.find((h: any) => h.id === form.hostId) || null;
  }, [form.forwardGroupId, form.hostId, form.routeMode, hosts, isLegacyLocalRuleEdit]);
  const forwardProtocolSettings = useMemo(
    () => normalizeForwardProtocolSettings(systemSettings?.forwardProtocols),
    [systemSettings?.forwardProtocols]
  );
  const nginxTunnelEnabled = forwardProtocolSettings.nginx_stream !== false;
  const protocolUnsupportedLabel = useCallback((protocolKey: ForwardProtocolKey | null | undefined) => {
    const genericLabel = translateText("该协议");
    if (!protocolKey) return genericLabel;
    if (protocolKey === "nginx" && forwardProtocolSettings.nginx === false) return genericLabel;
    if (protocolKey === "nginx_stream" && !nginxTunnelEnabled) return genericLabel;
    return FORWARD_PROTOCOL_LABELS[protocolKey] || genericLabel;
  }, [forwardProtocolSettings.nginx, nginxTunnelEnabled]);
  const forwardTypeDisplayLabel = useCallback((forwardType: unknown) => {
    const type = String(forwardType || "");
    if (type === "nginx" && forwardProtocolSettings.nginx === false) return translateText("转发工具");
    return FORWARD_TYPE_LABELS[type as ForwardType] || type || "-";
  }, [forwardProtocolSettings.nginx]);

  const isProtocolEnabled = useCallback((key: ForwardProtocolKey | null | undefined) => {
    if (!key) return false;
    return forwardProtocolSettings[key] !== false;
  }, [forwardProtocolSettings]);
  const getTunnelProtocolKey = useCallback((tunnel: any | null | undefined): ForwardProtocolKey | null => {
    const mode = String(tunnel?.mode || "").toLowerCase();
    return (TUNNEL_PROTOCOLS as readonly string[]).includes(mode)
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
  const isPortPolicyForwardGroupRouteMode = isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId);
  const hasSelectedPortResource = isPortPolicyForwardGroupRouteMode ? !!form.forwardGroupId : !!form.hostId;
  const portPolicyResourceInput = isPortPolicyForwardGroupRouteMode && form.forwardGroupId
    ? { forwardGroupId: Number(form.forwardGroupId) }
    : { hostId: Number(form.hostId || 1), tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null };
  const portPolicyInput = { ...portPolicyResourceInput, userId: editingId ? undefined : createOwnerUserId };
  const { data: effectivePortPolicy, isLoading: effectivePortPolicyLoading, isError: effectivePortPolicyError } = trpc.rules.effectivePortPolicy.useQuery(portPolicyInput, {
    enabled: showDialog && hasSelectedPortResource,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const sourcePortRangeText = hasSelectedPortResource
    ? effectivePortPolicy?.rangeText || (effectivePortPolicyLoading ? translateText("读取中...") : effectivePortPolicyError ? translateText("暂不可用") : translateText("读取中..."))
    : translateText("请选择链路");
  const portStatusHint = useMemo(() => {
    if (portStatus === "used") {
      return {
        type: "used" as const,
        text: portRangeError ? translateText("超范围") : translateText("不可用"),
        title: portRangeError || translateText("端口已被占用"),
      };
    }
    if (portStatus === "available") {
      return {
        type: "available" as const,
        text: translateText("可用"),
        title: translateText("允许端口范围: {0}", [sourcePortRangeText]),
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
  const selectedTunnelDisplay = useMemo(() => getTunnelDisplay(selectedTunnel, nginxTunnelEnabled), [selectedTunnel, nginxTunnelEnabled]);
  const userById = useMemo(() => {
    const map = new Map<number, any>();
    (users || []).forEach((item: any) => map.set(Number(item.id), item));
    return map;
  }, [users]);
  const ruleOperationOwner = createOwnerUserId ? userById.get(createOwnerUserId) : user;
  const ruleOperationOwnerLabel = ruleOperationOwner?.name || ruleOperationOwner?.username || translateText("用户 #{0}", [createOwnerUserId || user?.id]);
  const forwardGroupById = useMemo(() => {
    const map = new Map<number, any>();
    (forwardGroups || []).forEach((group: any) => map.set(Number(group.id), group));
    // Ordinary users receive ACL-filtered supporting entry groups nested on
    // their chain. Merge those display-only records into the lookup without
    // adding them to selectable resource lists.
    (forwardGroups || []).forEach((group: any) => {
      const entryGroup = group?.entryGroup;
      const entryGroupId = Number(entryGroup?.id || group?.entryGroupId || 0);
      if (entryGroupId > 0 && entryGroup && !map.has(entryGroupId)) map.set(entryGroupId, entryGroup);
    });
    return map;
  }, [forwardGroups]);
  const linkAvailabilityIndex = useMemo(() => buildLinkAvailabilityIndex({
    hosts,
    tunnels,
    groups: forwardGroups,
    isTunnelSupported: (tunnel: any) => isProtocolEnabled(getTunnelProtocolKey(tunnel)),
  }), [forwardGroups, getTunnelProtocolKey, hosts, isProtocolEnabled, tunnels]);
  const tunnelAvailabilityById = linkAvailabilityIndex.tunnelAvailabilityById;
  const groupAvailabilityById = linkAvailabilityIndex.groupAvailabilityById;
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
  const availablePortForwardGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => normalizeForwardGroupModeForRule(group) === "port"),
    [availableForwardGroups]
  );
  const availableForwardChainGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => isForwardChainGroup(group)),
    [availableForwardGroups]
  );
  const availableFailoverForwardGroups = useMemo(
    () => availableForwardGroups.filter((group: any) => normalizeForwardGroupModeForRule(group) === "failover"),
    [availableForwardGroups]
  );
  const transferPortGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => normalizeForwardGroupModeForRule(group) === "port"),
    [forwardGroups]
  );
  const transferChainGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => isForwardChainGroup(group)),
    [forwardGroups]
  );
  const transferRuleGroups = useMemo(
    () => (forwardGroups || []).filter((group: any) => normalizeForwardGroupModeForRule(group) === "failover"),
    [forwardGroups]
  );
  const getRuleFilterResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return transferPortGroups;
    if (type === "tunnel") return tunnels || [];
    if (type === "chain") return transferChainGroups;
    return transferRuleGroups;
  }, [transferChainGroups, transferPortGroups, transferRuleGroups, tunnels]);
  useEffect(() => {
    const selected = parseRuleResourceFilter(filterResource);
    if (!selected.type || !selected.id) return;
    if (selected.type === "tunnel" ? !Array.isArray(tunnels) : !Array.isArray(forwardGroups)) return;
    if (getRuleFilterResources(selected.type).some((resource: any) => Number(resource.id) === selected.id)) return;
    setFilterResource("all");
    storeString(filterResourceStorageKey, "all");
  }, [filterResource, filterResourceStorageKey, getRuleFilterResources]);
  const getTransferResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return transferPortGroups;
    if (type === "tunnel") return tunnels || [];
    if (type === "chain") return transferChainGroups;
    return transferRuleGroups;
  }, [tunnels, transferPortGroups, transferChainGroups, transferRuleGroups]);
  const getImportResources = useCallback((type: RuleTransferScopeType): any[] => {
    if (type === "local") return availablePortForwardGroups;
    if (type === "tunnel") return supportedTunnels;
    if (type === "chain") return availableForwardChainGroups;
    return availableFailoverForwardGroups;
  }, [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, supportedTunnels]);
  const exportResources = useMemo(() => getTransferResources(exportScopeType), [exportScopeType, getTransferResources]);
  const importResources = useMemo(() => getImportResources(importScopeType), [getImportResources, importScopeType]);
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
  const routeModeLocked = false;
  const isForwardGroupRouteMode = isForwardGroupBackedRouteModeValue(form.routeMode, form.forwardGroupId)
    || (isLegacyLocalRuleEdit && form.routeMode === "local");
  const effectiveRouteForwardType = useMemo<ForwardType>(() => {
    if (form.routeMode === "tunnel") return "gost";
    if (isForwardGroupRouteMode) {
      return getForwardGroupRuleForwardType(selectedForwardGroup, form.forwardType);
    }
    return form.forwardType;
  }, [form.forwardGroupId, form.forwardType, form.routeMode, isForwardGroupRouteMode, selectedForwardGroup]);
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
  const trafficBillingHostIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.hostIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const trafficBillingTunnelIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.tunnelIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const trafficBillingForwardGroupIds = useMemo(() => {
    const ids = (trafficBilling?.usableResourceIds?.forwardGroupIds || []) as Array<number | string>;
    return new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  }, [trafficBilling?.usableResourceIds]);
  const availableTrafficBillingHosts = useMemo(
    () => (hosts || []).filter((host: any) => trafficBillingHostIds.has(Number(host.id))),
    [hosts, trafficBillingHostIds]
  );
  const canUseSavedLocalForward = availablePortForwardGroups.length > 0;
  const canUseBillingHostLocalForward = user?.role !== "admin" && hasTrafficBillingBalance && availableTrafficBillingHosts.length > 0 && usableForwardTypes.length > 0;
  const canUseLocalForward = canUseSavedLocalForward || canUseBillingHostLocalForward;
  const canUseGost = allowedForwardTypes.includes("gost") && supportedTunnels.length > 0;
  const canUseForwardChain = availableForwardChainGroups.length > 0;
  const canUseFailoverGroup = availableFailoverForwardGroups.length > 0;
  const canCreateRule = canUseLocalForward || canUseGost || canUseForwardChain || canUseFailoverGroup;
  const routeModeTabItems: SlidingTabItem<RuleRouteMode>[] = [
    {
      value: "local",
      label: translateText("端口转发"),
      icon: ArrowRightLeft,
      disabled: !canUseLocalForward || (routeModeLocked && form.routeMode !== "local"),
    },
    {
      value: "tunnel",
      label: translateText("隧道转发"),
      icon: Network,
      disabled: !canUseGost || (routeModeLocked && form.routeMode !== "tunnel"),
    },
    {
      value: "chain",
      label: translateText("转发链"),
      icon: GitBranch,
      disabled: !canUseForwardChain || (routeModeLocked && form.routeMode !== "chain"),
    },
    {
      value: "group",
      label: translateText("转发组"),
      icon: Layers3,
      disabled: !canUseFailoverGroup || (routeModeLocked && form.routeMode !== "group"),
    },
  ];
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("create") !== "local") return;
    if (rulePermissionLoading || !hostsFetched || !systemSettingsFetched) return;
    params.delete("create");
    const nextSearch = params.toString();
    setLocation(`/rules${nextSearch ? `?${nextSearch}` : ""}`, { replace: true });
    if (!canAdd) {
      toast.error(translateText("当前账号没有添加转发规则的权限"));
      return;
    }
    openCreate("local");
  }, [search, setLocation, rulePermissionLoading, hostsFetched, systemSettingsFetched, canAdd, canUseLocalForward, canUseSavedLocalForward, canUseBillingHostLocalForward, availablePortForwardGroups, availableTrafficBillingHosts, usableForwardTypes]);

  const notificationConfig = systemSettings?.notificationChannel === "discord" ? systemSettings.discord : systemSettings?.telegram;
  const telegramBotReady = !!notificationConfig?.enabled && !!notificationConfig?.configured;
  const selectedForwardGroupIsChain = form.routeMode === "chain" || isForwardChainGroup(selectedForwardGroup);
  const selectedForwardGroupIsPort = normalizeForwardGroupModeForRule(selectedForwardGroup) === "port";
  const mainBackupForwardType = effectiveRouteForwardType;
  const mainBackupUsesTunnelRoute = form.routeMode === "tunnel" || (!selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel");
  const mainBackupIsTunnelRoute =
    (form.routeMode === "tunnel" && isGostTunnelForMainBackup(selectedTunnel))
    || isForwardGroupMainBackupTunnelSupported(selectedForwardGroup, tunnelById);
  const mainBackupPortForwardSupported = !mainBackupUsesTunnelRoute
    && mainBackupForwardType === "gost"
    && (user?.role === "admin" || selectedForwardGroupIsPort);
  const canAutoSwitchMainBackupToGost = !selectedForwardGroupIsChain
    && !mainBackupUsesTunnelRoute
    && mainBackupForwardType !== "gost"
    && usableForwardTypes.includes("gost")
    && !routeModeLocked
    && user?.role === "admin"
    && form.routeMode === "local"
    && !selectedForwardGroupIsPort;
  const canUseMainBackup = !selectedForwardGroupIsChain
    && (
      (mainBackupUsesTunnelRoute && mainBackupForwardType === "gost" && mainBackupIsTunnelRoute)
      || mainBackupPortForwardSupported
      || canAutoSwitchMainBackupToGost
    );
  const mainBackupDisabledText = selectedForwardGroupIsChain
    ? translateText("转发链不支持出站策略。")
    : mainBackupUsesTunnelRoute && !mainBackupIsTunnelRoute
    ? translateText("当前隧道或转发工具不支持出站策略。")
    : mainBackupForwardType !== "gost" && !canAutoSwitchMainBackupToGost
    ? translateText("仅支持 GOST 的隧道或转发工具可以使用出站策略。")
    : user?.role !== "admin" && !mainBackupUsesTunnelRoute && !selectedForwardGroupIsPort
    ? translateText("普通用户的普通端口转发不支持出站策略，请使用已保存的 GOST 端口转发或 GOST 隧道。")
    : form.protocol !== "tcp"
    ? translateText("出站策略仅支持 TCP 协议。")
    : "";
  const showMainBackupConfig = canUseMainBackup;
  const kernelForwardWarning = useMemo(() => buildKernelForwardWarning({
    rule: form,
    host: selectedHost,
    group: selectedForwardGroup,
    hosts: hosts || [],
    hostById,
    forwardGroupById,
  }), [form, selectedHost, selectedForwardGroup, hosts, hostById, forwardGroupById]);
  const checkPort = useCallback(async () => {
    const checkId = latestPortCheckRef.current + 1;
    latestPortCheckRef.current = checkId;
    const routeMode = form.routeMode;
    const hostId = form.hostId;
    const forwardGroupId = form.forwardGroupId;
    const tunnelId = form.tunnelId;
    const sourcePort = form.sourcePort;
    if (!sourcePort || sourcePort < 1) return;
    if (isForwardGroupRouteMode ? !forwardGroupId : !hostId) return;
    if (!isValidPort(sourcePort)) {
      setPortRangeError(translateText("端口必须在 1-65535 之间"));
      setPortStatus("used");
      return;
    }
    setPortRangeError(null);
    setPortStatus("checking");
    try {
      const result = await utils.rules.checkPort.fetch({
        userId: editingId ? undefined : createOwnerUserId,
        ...(isForwardGroupRouteMode
          ? { forwardGroupId: Number(forwardGroupId) }
          : { hostId: Number(hostId), tunnelId: routeMode === "tunnel" ? tunnelId : null }),
        sourcePort,
        excludeRuleId: editingId || undefined,
        protocol: form.protocol,
      });
      if (latestPortCheckRef.current !== checkId) return;
      setPortRangeError(result.used ? result.reason ?? null : null);
      setPortStatus(result.used ? "used" : "available");
    } catch {
      if (latestPortCheckRef.current !== checkId) return;
      setPortStatus("idle");
    }
  }, [form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.sourcePort, form.tunnelId, editingId, createOwnerUserId, utils, isForwardGroupRouteMode]);

  // A response started for the previous route must not mark the new route occupied.
  useEffect(() => {
    latestPortCheckRef.current += 1;
    setPortStatus("idle");
  }, [editingId, form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.sourcePort, form.tunnelId, isForwardGroupRouteMode]);

  // 源端口变化时自动检测
  useEffect(() => {
    const hasTarget = isForwardGroupRouteMode ? !!form.forwardGroupId : !!form.hostId;
    if (form.sourcePort > 0 && hasTarget) {
      const timer = setTimeout(checkPort, 500);
      return () => clearTimeout(timer);
    } else {
      setPortStatus("idle");
    }
  }, [form.sourcePort, form.forwardGroupId, form.hostId, form.protocol, form.routeMode, form.tunnelId, checkPort, isForwardGroupRouteMode]);

  useEffect(() => {
    if (form.routeMode !== "local") return;
    if (editingId) return;
    if (usableForwardTypes.length === 0) return;
    if (!usableForwardTypes.includes(form.forwardType)) {
      setForm((prev) => ({ ...prev, forwardType: usableForwardTypes[0], tunnelId: null }));
    }
  }, [editingId, form.forwardType, form.routeMode, usableForwardTypes]);

  useEffect(() => {
    if (!isForwardGroupRouteMode) return;
    const candidates = form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups;
    if (!selectedForwardGroup && candidates.length > 0) {
      if (isLegacyLocalRuleEdit && form.routeMode === "local" && !form.forwardGroupId) return;
      setForm((prev) => ({ ...prev, forwardGroupId: Number(candidates[0].id) }));
      return;
    }
    const expectedGroupMode = form.routeMode === "local" ? "port" : form.routeMode === "chain" ? "chain" : "failover";
    if (selectedForwardGroup && normalizeForwardGroupModeForRule(selectedForwardGroup) !== expectedGroupMode) {
      setForm((prev) => ({
        ...prev,
        forwardGroupId: candidates[0] ? Number(candidates[0].id) : null,
        failoverEnabled: form.routeMode === "chain" ? false : prev.failoverEnabled,
      }));
      return;
    }
    const groupForwardType = getForwardGroupRuleForwardType(selectedForwardGroup, form.forwardType);
    if (selectedForwardGroup && form.forwardType !== groupForwardType) {
      setForm((prev) => ({ ...prev, forwardType: groupForwardType }));
    }
  }, [availablePortForwardGroups, availableFailoverForwardGroups, availableForwardChainGroups, form.forwardGroupId, form.forwardType, form.routeMode, isForwardGroupRouteMode, isLegacyLocalRuleEdit, selectedForwardGroup]);

  useEffect(() => {
    if (!form.failoverEnabled || canUseMainBackup) return;
    setForm((prev) => ({ ...prev, failoverEnabled: false }));
  }, [canUseMainBackup, form.failoverEnabled]);

  useEffect(() => {
    if (!systemSettingsFetched) return;
    if (telegramBotReady || !form.telegramErrorNotifyEnabled) return;
    setForm((prev) => prev.telegramErrorNotifyEnabled ? { ...prev, telegramErrorNotifyEnabled: false } : prev);
  }, [form.telegramErrorNotifyEnabled, systemSettingsFetched, telegramBotReady]);

  // 随机分配端口
  const handleRandomPort = async () => {
    if (isForwardGroupRouteMode) {
      if (!form.forwardGroupId) {
        toast.error(form.routeMode === "local" ? translateText("请先选择端口转发") : form.routeMode === "chain" ? translateText("请先选择转发链") : translateText("请先选择转发组"));
        return;
      }
    } else if (!form.hostId) {
      toast.error(translateText("请先选择主机"));
      return;
    }
    try {
      const randomPortInput = isForwardGroupRouteMode
        ? { forwardGroupId: Number(form.forwardGroupId), excludeRuleId: editingId || undefined, protocol: form.protocol }
        : { hostId: Number(form.hostId), tunnelId: form.routeMode === "tunnel" ? form.tunnelId : null, excludeRuleId: editingId || undefined, protocol: form.protocol };
      const result = await utils.rules.randomPort.fetch({ ...randomPortInput, userId: editingId ? undefined : createOwnerUserId });
      setForm({ ...form, sourcePort: result.port });
      setPortStatus("available");
      toast.success(translateText("已分配随机端口: {0}", [result.port]));
    } catch (err: any) {
      toast.error(err.message || translateText("无法获取随机端口"));
    }
  };

  const toggleCopyRule = (ruleId: number, checked: boolean) => {
    setCopyRuleIds((prev) => checked ? Array.from(new Set([...prev, ruleId])) : prev.filter((id) => id !== ruleId));
  };

  const switchCopyManageMode = (mode: RuleBatchManageMode) => {
    if (copyActionPending || mode === copyManageMode || !ruleBatchModeAvailable(mode, batchAccess)) return;
    setBatchStep(1);
    setCopyManageMode(mode);
    if (mode === "edit") {
      commitCopyTargetSelection(copyTargetSelectionRef.current.scopeType, []);
      setBatchEditForm(buildEmptyBatchEditForm());
    }
    if (mode === "import") {
      const preferredImportType: RuleTransferScopeType = canUseSavedLocalForward
        ? "local"
        : canUseGost
          ? "tunnel"
          : canUseForwardChain
            ? "chain"
            : "group";
      setImportScopeType(preferredImportType);
      setImportResourceId("");
      setImportResourceSearch("");
      resetImportDialog();
    }
  };

  const setBatchEditRouteMode = (mode: RuleRouteMode) => {
    if (mode === batchEditForm.routeMode) return;
    if (mode === "local" && !canUseSavedLocalForward) return;
    if (mode === "tunnel" && !canUseGost) return;
    if (mode === "chain" && !canUseForwardChain) return;
    if (mode === "group" && !canUseFailoverGroup) return;
    setBatchEditForm((prev) => ({
      ...prev,
      routeMode: mode,
      forwardType: mode === "tunnel" ? "gost" : prev.forwardType,
      tunnelId: null,
      forwardGroupId: null,
    }));
  };

  const toggleCopyTargetResource = (resourceId: number, checked: boolean, renderedScopeType: RuleTransferScopeType) => {
    const current = copyTargetSelectionRef.current;
    // If the scope selector changed but this checkbox belongs to the previous
    // render, do not mix IDs from the two scopes.  The checkbox's rendered
    // scope is the authoritative context for this event.
    const currentIds = current.scopeType === renderedScopeType ? current.resourceIds : [];
    const nextIds = !checked
      ? currentIds.filter((id) => id !== resourceId)
      : copyManageMode === "edit"
        ? [resourceId]
        : Array.from(new Set([...currentIds, resourceId]));
    commitCopyTargetSelection(renderedScopeType, nextIds);
  };

  const buildBatchCopyRulePayload = (rule: any, targetType: RuleTransferScopeType, resource: any, sourcePort: number) => {
    const isTunnelTarget = targetType === "tunnel";
    const isForwardGroupTarget = !isTunnelTarget;
    const forwardType = isTunnelTarget ? "gost" : getForwardGroupRuleForwardType(resource, rule.forwardType);
    const keepFailover = targetType === "group" && !!rule.failoverEnabled;
    return {
      hostId: isTunnelTarget ? Number(resource.entryHostId) : undefined,
      userId: createOwnerUserId,
      name: String(rule.name || "复制规则").trim().slice(0, 128) || "复制规则",
      forwardType,
      protocol: normalizeRuleProtocol(rule.protocol),
      gostMode: "direct" as const,
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId: isTunnelTarget ? Number(resource.id) : null,
      forwardGroupId: isForwardGroupTarget ? Number(resource.id) : null,
      sourcePort,
      targetIp: String(rule.targetIp || ""),
      targetPort: Number(rule.targetPort || 0),
      telegramErrorNotifyEnabled: telegramBotReady && !!rule.telegramErrorNotifyEnabled,
      proxyProtocolReceive: !!rule.proxyProtocolReceive,
      proxyProtocolSend: !!rule.proxyProtocolSend,
      proxyProtocolExitReceive: !!rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: !!rule.proxyProtocolExitSend,
      proxyProtocolVersion: normalizeProxyProtocolVersion(rule.proxyProtocolVersion),
      tcpFastOpen: !!rule.tcpFastOpen,
      zeroCopy: !!rule.zeroCopy,
      udpOverTcp: !!rule.udpOverTcp,
      udpOverTcpPort: Number(rule.udpOverTcpPort || 0),
      failoverEnabled: keepFailover,
      failoverStrategy: normalizeFailoverStrategy(rule.failoverStrategy),
      failoverTargets: keepFailover ? parseRuleFailoverTargets(rule.failoverTargets) : [],
      failoverSeconds: normalizePositiveRuleNumber(rule.failoverSeconds, 60),
      recoverSeconds: normalizePositiveRuleNumber(rule.recoverSeconds, 120),
      autoFailback: rule.autoFailback !== false,
    };
  };

  const buildBatchEditRulePayload = (rule: any, sourcePort: number) => {
    const payload: Record<string, any> = { id: Number(rule.id) };
    if (hasBatchEditRouteSelection) {
      if (batchEditForm.routeMode === "tunnel" && selectedBatchEditTunnel) {
        payload.forwardType = "gost";
        payload.tunnelId = Number(selectedBatchEditTunnel.id);
        payload.forwardGroupId = null;
        payload.hostId = Number(selectedBatchEditTunnel.entryHostId);
        payload.sourcePort = sourcePort;
      } else if (selectedBatchEditForwardGroup) {
        payload.forwardGroupId = Number(selectedBatchEditForwardGroup.id);
        payload.forwardType = getForwardGroupRuleForwardType(selectedBatchEditForwardGroup, rule.forwardType);
        payload.sourcePort = sourcePort;
      }
    }
    if (hasBatchEditTargetIpChange) payload.targetIp = batchEditTargetIp;
    if (hasBatchEditTargetPortChange) payload.targetPort = batchEditTargetPort;
    return payload;
  };

  const handleCopyRules = async () => {
    if (!canAdd) {
      toast.error(translateText("当前账号没有添加转发规则的权限"));
      return;
    }
    if (copySelectedRules.length === 0) {
      toast.error(translateText("请选择要复制的规则"));
      return;
    }
    // Read the eagerly-updated selection snapshot instead of relying solely
    // on values captured by the render that created this click handler.  This
    // prevents a checkbox click immediately followed by "复制" from using a
    // previous target (or a previous scope when the resource list is being
    // refreshed).
    const targetSelection = copyTargetSelectionRef.current;
    const targetType = targetSelection.scopeType;
    const targetResources = targetType === "local"
      ? availablePortForwardGroups
      : targetType === "tunnel"
        ? supportedTunnels
        : targetType === "chain"
          ? availableForwardChainGroups
          : availableFailoverForwardGroups;
    const selectedTargetIds = new Set(targetSelection.resourceIds.map(Number));
    const selectedTargets = targetResources.filter((resource: any) => selectedTargetIds.has(Number(resource.id)));
    if (selectedTargets.length === 0) {
      toast.error(translateText("请选择目标") + ruleTransferScopeLabels[targetType]);
      return;
    }
    setCopyWorking(true);
    let copied = 0;
    try {
      const jobs: Array<{ resource: any; rule: any }> = selectedTargets.flatMap((resource: any) => (
        copySelectedRules.map((rule: any) => ({ resource, rule }))
      ));
      const results = await runQueuedRules(jobs, "批量复制", ({ resource, rule }) => ({ operation: "create",
        input: buildBatchCopyRulePayload(rule, targetType, resource, Number(rule.sourcePort || 0)), conflictStrategy: copyConflictStrategy,
      }), result => ({ copied: result.status === "succeeded", skipped: result.status === "skipped" }));
      for (const result of results) {
        if (result.status === "rejected") continue;
        if (result.value.copied) copied += 1;
      }
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
        utils.rules.personalGroups.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
      const failures = results.filter((result) => result.status === "rejected");
      if (!failures.length && copied > 0) setShowCopyDialog(false);
    } catch (error: any) {
      toast.error(translateText("批量复制处理失败：") + (error?.message || translateText("请检查目标配置")));
    } finally {
      setCopyWorking(false);
    }
  };

  const handleBatchEditRules = async () => {
    if (copySelectedRules.length === 0) {
      toast.error(translateText("请选择要批量编辑的规则"));
      return;
    }
    if (!hasBatchEditChanges) {
      toast.error(translateText("请至少选择要替换的入口资源，或填写目标地址/端口"));
      return;
    }
    if (batchEditForm.routeMode === "tunnel" && !selectedBatchEditTunnel && !hasBatchEditTargetIpChange && !hasBatchEditTargetPortChange) {
      toast.error(translateText("请选择要替换到的隧道"));
      return;
    }
    if (batchEditForm.routeMode !== "tunnel" && !selectedBatchEditForwardGroup && !hasBatchEditTargetIpChange && !hasBatchEditTargetPortChange) {
      toast.error(batchEditForm.routeMode === "local" ? translateText("请选择要替换到的端口转发") : batchEditForm.routeMode === "chain" ? translateText("请选择要替换到的转发链") : translateText("请选择要替换到的转发组"));
      return;
    }
    if (hasBatchEditTargetIpChange && !isValidTargetHost(batchEditTargetIp)) {
      toast.error(translateText("请输入有效的目标地址"));
      return;
    }
    if (batchEditForm.targetPort && !hasBatchEditTargetPortChange) {
      toast.error(translateText("请输入有效的目标端口"));
      return;
    }
    setCopyWorking(true);
    let updated = 0;
    try {
      const results = await runQueuedRules(copySelectedRules, "批量编辑", (rule: any) => ({ operation: "update",
        input: buildBatchEditRulePayload(rule, Number(rule.sourcePort || 0)), conflictStrategy: hasBatchEditRouteSelection ? copyConflictStrategy : "error",
      }), result => ({ updated: result.status === "succeeded", skipped: result.status === "skipped" }));
      for (const result of results) {
        if (result.status === "rejected") continue;
        if (result.value.updated) updated += 1;
      }
      invalidateRuleProbeStatuses(results
        .filter((result) => result.status === "fulfilled" && result.value.updated)
        .map((result) => Number(result.item.id)));
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
        utils.rules.personalGroups.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
      const failures = results.filter((result) => result.status === "rejected");
      if (!failures.length && updated > 0) setShowCopyDialog(false);
    } catch (error: any) {
      toast.error(translateText("批量编辑处理失败：") + (error?.message || translateText("请检查目标配置")));
    } finally {
      setCopyWorking(false);
    }
  };

  const handleBatchExportRules = () => {
    if (copySelectedRules.length === 0) {
      toast.error(translateText("请选择要导出的规则"));
      return;
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const partCount = downloadRuleTransferFiles(
      copySelectedRules,
      { type: "batch", name: "批量管理选中规则" },
      `forwardx-rules-batch-${date}`,
      exportFormat,
    );
    toast.success(translateText("已导出 {0} 条规则{1}", [copySelectedRules.length, partCount > 1 ? translateText("，共 {0} 个文件", [partCount]) : ""]));
  };

  const refreshBatchRuleState = async () => {
    invalidateRuleProbeStatuses(copySelectedRules.map((rule: any) => Number(rule.id)));
    await Promise.all([
      utils.rules.list.invalidate(), utils.rules.listPage.invalidate(),
      utils.rules.mapItems.invalidate(), utils.rules.listSummary.invalidate(),
      utils.rules.trafficSummary.invalidate(), utils.rules.personalGroups.invalidate(),
      utils.auth.me.invalidate(), utils.billing.me.invalidate(),
    ]);
    await fullRulesQuery.refetch();
  };

  const handleBatchRuleOperation = async (operation: "enable" | "pause" | "restart") => {
    if (copyActionPending || !copySelectedRules.length) return;
    setCopyWorking(true);
    try {
      const results = await runQueuedRules(copySelectedRules, operation === "enable" ? "批量启用" : operation === "pause" ? "批量暂停" : "批量重启", (rule: any) => ({
        operation: operation === "restart" ? "restart" : "toggle",
        input: operation === "restart" ? { id: Number(rule.id) } : { id: Number(rule.id), isEnabled: operation === "enable" }, conflictStrategy: "error",
      }), result => result.value || {});
      const failures = results.filter((result) => result.status === "rejected");
      setCopyRuleIds(failures.map((result) => Number(result.item.id)));
      await refreshBatchRuleState();
    } catch (error) {
      toast.error(batchOperationErrorMessage(error));
    } finally {
      setCopyWorking(false);
    }
  };

  const handleBatchDeleteRules = async () => {
    if (copyActionPending) return;
    if (copySelectedRules.length === 0) {
      toast.error(translateText("请选择要删除的规则"));
      return;
    }
    if (!(await confirmDialog({
      title: translateText("删除转发规则"),
      description: translateText("确认删除选中的 {0} 条转发规则？", [copySelectedRules.length]),
      confirmText: translateText("删除"),
      tone: "destructive",
    }))) return;
    setCopyWorking(true);
    try {
      const requestedIds = Array.from(new Set(copySelectedRules.map((rule: any) => Number(rule.id))));
      const chunkResults = await runQueuedRules(requestedIds, "批量删除", id => ({ operation: "delete", input: { id }, conflictStrategy: "error" }),
        (_result, id) => ({ deletedIds: [id], failures: [] as Array<{ id: number; error: string }> }));
      const deletedIdList: number[] = [];
      const failures: Array<{ id: number; error: string }> = [];
      for (const chunkResult of chunkResults) {
        if (chunkResult.status === "fulfilled") {
          deletedIdList.push(...(chunkResult.value.deletedIds || []).map(Number));
          failures.push(...(chunkResult.value.failures || []).map((failure) => ({
            id: Number(failure.id),
            error: String(failure.error || translateText("删除失败")),
          })));
          continue;
        }
        const error = batchOperationErrorMessage(chunkResult.reason);
        failures.push({ id: Number(chunkResult.item), error });
      }
      const deletedIds = new Set(deletedIdList);
      invalidateRuleProbeStatuses(deletedIdList);
      setCopyRuleIds((prev) => prev.filter((id) => !deletedIds.has(Number(id))));
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
        utils.rules.personalGroups.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
    } catch (error: any) {
      toast.error(translateText("批量删除失败：") + (error?.message || translateText("请稍后重试")));
    } finally {
      setCopyWorking(false);
    }
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
      userId: user?.role === "admin" && filterUser === "all"
        ? undefined
        : createOwnerUserId ?? Number(user?.id),
    });
  };

  const handleSubmit = async () => {
    let limitPayload: Partial<ReturnType<typeof ruleLimitsPayload>> = {};
    if (user?.role === "admin") {
      try { limitPayload = ruleLimitsPayload(form.limits); }
      catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return; }
    }
    const submitForwardType = effectiveRouteForwardType;
    if (!form.name || !form.targetIp || !form.targetPort || (!isForwardGroupRouteMode && !form.hostId)) {
      toast.error(translateText("请填写所有必填字段（目标端口必须填写）"));
      return;
    }
    if (isForwardGroupRouteMode && !form.forwardGroupId) {
      toast.error(form.routeMode === "local" ? translateText("请选择端口转发") : form.routeMode === "chain" ? translateText("请选择转发链") : translateText("请选择转发组"));
      return;
    }
    if (form.routeMode === "local" && !canUseLocalForward) {
      toast.error(translateText("暂无可用端口转发或按量计费资源"));
      return;
    }
    if (form.routeMode === "chain" && !canUseForwardChain) {
      toast.error(translateText("暂无可用转发链"));
      return;
    }
    if (form.routeMode === "group" && !canUseFailoverGroup) {
      toast.error(translateText("暂无可用转发组"));
      return;
    }
    if (form.routeMode === "tunnel" && !canUseGost) {
      toast.error(translateText("当前账号没有隧道转发权限"));
      return;
    }
    if (form.routeMode === "tunnel" && !form.tunnelId) {
      toast.error(translateText("请选择要使用的隧道"));
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
    if (isForwardGroupRouteMode && !isProtocolEnabled(effectiveRouteForwardType)) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (form.routeMode === "group" && !selectedForwardGroupIsChain && selectedForwardGroup?.groupType === "tunnel" && !isProtocolEnabled("gost")) {
      toast.error(unsupportedProtocolTitle);
      return;
    }
    if (!isValidPort(form.sourcePort, !editingId)) {
      toast.error(editingId ? translateText("源端口必须在 1-65535 之间") : translateText("源端口必须为 0 或 1-65535，0 表示随机分配"));
      return;
    }
    if (!isValidPort(form.targetPort)) {
      toast.error(translateText("目标端口必须在 1-65535 之间"));
      return;
    }
    if (form.telegramErrorNotifyEnabled && !telegramBotReady) {
      toast.error(translateText("请先在系统设置中配置并启用所选通知渠道，再开启异常通知"));
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
        toast.error(mainBackupDisabledText || translateText("当前规则类型不支持出站策略"));
        return;
      }
      if (form.protocol !== "tcp") {
        toast.error(translateText("出站策略当前仅支持 TCP 协议"));
        return;
      }
      if (failoverTargets.length === 0) {
        toast.error(translateText("启用出站策略后至少需要填写一个备用出站"));
        return;
      }
      if (!Number.isInteger(form.failoverSeconds) || form.failoverSeconds < 10 || form.failoverSeconds > 3600) {
        toast.error(translateText("健康检查切换时间必须在 10-3600 秒之间"));
        return;
      }
      if (!Number.isInteger(form.recoverSeconds) || form.recoverSeconds < 10 || form.recoverSeconds > 3600) {
        toast.error(translateText("恢复观察时间必须在 10-3600 秒之间"));
        return;
      }
    }
    const failoverPayload = {
      failoverEnabled: canUseMainBackup ? form.failoverEnabled : false,
      failoverStrategy: form.failoverStrategy,
      failoverTargets: canUseMainBackup && form.failoverEnabled ? failoverTargets : [],
      failoverSeconds: form.failoverSeconds || 60,
      recoverSeconds: form.recoverSeconds || 120,
      autoFailback: form.autoFailback,
    };
    if (!isForwardGroupRouteMode && portStatus === "used") {
      toast.error(translateText("源端口已被占用，请更换端口或使用随机分配"));
      return;
    }
    if (!editingId && !isForwardGroupRouteMode && form.sourcePort > 0 && portStatus !== "available") {
      toast.error(translateText("请等待端口可用后再保存"));
      return;
    }
    if (kernelForwardWarning) {
      toast.warning(kernelForwardWarning, { duration: 7000 });
    }
    if (editingId && editingOriginalProtocol === "both" && form.protocol !== "both") {
      const confirmed = await confirmDialog({
        title: translateText("确认缩小协议范围"),
        description: translateText("当前规则同时转发 TCP 和 UDP。保存后将只保留 {0}，另一协议的监听会被停止。", [form.protocol.toUpperCase()]),
        confirmText: translateText("继续保存"),
      });
      if (!confirmed) return;
    }
    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        ...(editingRuleOwnerId === Number(user?.id) ? { personalGroupIds: formGroupIds } : {}),
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
        ...failoverPayload,
        ...limitPayload,
      });
    } else {
      createMutation.mutate({
        userId: createOwnerUserId,
        ...(!createOwnerUserId || createOwnerUserId === Number(user?.id) ? { personalGroupIds: formGroupIds } : {}),
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
        ...failoverPayload,
        ...limitPayload,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  const ruleFilters = useMemo<RuleFilterState>(() => ({
    filterUser,
    filterResource,
    ruleCategory,
    searchQuery: ruleSearchQuery,
    isAdmin: user?.role === "admin",
    userId: user?.id,
    hostById,
    tunnelById,
    userById,
    forwardGroupById,
    getRuleEntryHostId: getRuleEntryHostIdForSort,
  }), [filterResource, forwardGroupById, getRuleEntryHostIdForSort, hostById, ruleCategory, ruleSearchQuery, filterUser, tunnelById, user?.id, user?.role, userById]);
  const baseScopedRules = useMemo(() => rules || [], [rules]);
  const [stableFilteredRules, setStableFilteredRules] = useState<any[]>([]);
  const [filteredRulesPrimed, setFilteredRulesPrimed] = useState(false);
  useEffect(() => {
    if (!ruleListDataReady) return;
    // Page/map endpoints already apply ownership, route, category and search.
    // Local option lists are incomplete (especially shared tunnel hosts), so
    // re-filtering here can hide valid matches while server counts remain > 0.
    // Keep local filtering only for the separate full-list batch tools below.
    setStableFilteredRules(baseScopedRules);
    setFilteredRulesPrimed(true);
  }, [baseScopedRules, ruleListDataReady]);
  const filteredRules = stableFilteredRules;
  // Batch tools need all matching source rules, while the page itself stays
  // on its current server page.  Keep these two data sources separate.
  const transferSourceRuleCandidates = needsFullRuleList
    ? (fullRulesQuery.data as any[] | undefined) || []
    : baseScopedRules;
  const transferSourceRules = useMemo(() => transferSourceRuleCandidates.filter((rule: any) => user?.role === "admin" || !isAdminManagedRule(rule)), [transferSourceRuleCandidates, user?.role]);
  const copyableSourceRules = useMemo(() => {
    const batchFilters: RuleFilterState = {
      ...ruleFilters,
      filterResource: "all",
      ruleCategory: copyRuleCategory,
      searchQuery: copyRuleSearch,
    };
    return transferSourceRules
      .filter((rule: any) => !rule.forwardGroupRuleId && !rule.forwardGroupMemberId && isRuleSupported(rule))
      .filter((rule: any) => matchesPersonalRuleGroup(rule.personalGroupIds, isOwnRuleScope ? copyRulePersonalGroupId : null))
      .filter((rule: any) => isForwardRuleVisibleByFilters(rule, batchFilters));
  }, [copyRuleCategory, copyRulePersonalGroupId, isOwnRuleScope, copyRuleSearch, isRuleSupported, ruleFilters, transferSourceRules]);
  const copySelectedRules = useMemo(() => {
    const selected = new Set(copyRuleIds.map(Number));
    return transferSourceRules.filter((rule: any) => selected.has(Number(rule.id)) && !rule.forwardGroupRuleId && !rule.forwardGroupMemberId
      && matchesPersonalRuleGroup(rule.personalGroupIds, isOwnRuleScope ? copyRulePersonalGroupId : null));
  }, [copyRuleIds, copyRulePersonalGroupId, isOwnRuleScope, transferSourceRules]);
  const copyTargetResources = useMemo(() => {
    if (copyTargetScopeType === "local") return availablePortForwardGroups;
    if (copyTargetScopeType === "tunnel") return supportedTunnels;
    if (copyTargetScopeType === "chain") return availableForwardChainGroups;
    return availableFailoverForwardGroups;
  }, [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, copyTargetScopeType, supportedTunnels]);
  const filteredCopyTargetResources = useMemo(() => {
    const keyword = copyTargetSearch.trim().toLowerCase();
    if (!keyword) return copyTargetResources;
    return copyTargetResources.filter((resource: any) => {
      const values = [
        resource?.id,
        resource?.name,
        resource?.description,
        resource?.displayRemark,
        resource?.domain,
        resource?.forwardType,
        resource?.groupMode,
        resource?.groupType,
        resource?.mode,
        resource?.listenPort,
        resource?.entryHostId,
        resource?.exitHostId,
        getForwardGroupKindLabel(resource),
        copyTargetScopeType === "tunnel" ? getTunnelRouteText(resource, hosts || []) : "",
      ];
      (resource?.members || []).forEach((member: any) => {
        values.push(member?.hostId, member?.tunnelId, member?.entryAddress, member?.connectHost, member?.name);
      });
      return values.filter((value) => value !== undefined && value !== null && String(value).trim()).join(" ").toLowerCase().includes(keyword);
    });
  }, [copyTargetResources, copyTargetScopeType, copyTargetSearch, hosts]);
  const selectedCopyTargetResources = useMemo(() => {
    const selected = new Set(copyTargetResourceIds.map(Number));
    return copyTargetResources.filter((resource: any) => selected.has(Number(resource.id)));
  }, [copyTargetResourceIds, copyTargetResources]);
  const copyTargetScopeLabel = ruleTransferScopeLabels[copyTargetScopeType];
  const copyActionPending = copyWorking || importingRules || batchGroupEditor.isPending;
  const batchAccess = { hasRules: transferSourceRules.length > 0, canAdd, isOwnRuleScope };
  const batchCategory = ruleBatchCategory(copyManageMode);
  const batchModeLabels: Record<RuleBatchManageMode, string> = {
    operate: translateText("批量操作"), copy: translateText("批量复制"),
    edit: translateText("批量编辑"), groups: translateText("调整分组"),
    import: translateText("批量导入"), export: translateText("批量导出"),
  };
  const batchCategories = [
    { value: "manage", label: translateText("规则管理"), icon: Rows3 },
    { value: "transfer", label: translateText("导入导出"), icon: ArrowRightLeft },
  ] as const;
  const isBatchOperateMode = copyManageMode === "operate";
  const isBatchEditMode = copyManageMode === "edit";
  const isBatchCopyMode = copyManageMode === "copy";
  const isBatchExportMode = copyManageMode === "export";
  const isBatchImportMode = copyManageMode === "import";
  const isBatchGroupMode = copyManageMode === "groups" && isOwnRuleScope;
  const selectedBatchRuleCount = copySelectedRules.length;
  const selectedBatchTargetCount = selectedCopyTargetResources.length;
  const allVisibleCopyRulesSelected = copyableSourceRules.length > 0
    && copyableSourceRules.every((rule: any) => copyRuleIds.includes(Number(rule.id)));
  const allVisibleCopyTargetsSelected = filteredCopyTargetResources.length > 0
    && filteredCopyTargetResources.every((resource: any) => copyTargetResourceIds.includes(Number(resource.id)));
  const batchSteps = ruleBatchStages(copyManageMode);
  const batchIsFinalStep = batchStep === batchSteps.length;
  const batchStepLabels = {
    selectRules: translateText("选择规则"), importSource: translateText("导入内容"),
    configureTarget: translateText("选择目标"), editRules: translateText("编辑内容"),
    confirm: translateText("确认执行"), operate: translateText("批量操作"),
    export: translateText("批量导出"), groups: translateText("调整分组"),
  };
  const batchSelectionSummary = (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
      <span>{translateText("已选择 {0} 条规则", [selectedBatchRuleCount])}</span>
      <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={copyActionPending} onClick={() => setBatchStep(1)}>{translateText("重新选择")}</Button>
    </div>
  );
  const batchRuleSelectionPanel = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-40 space-y-1">
          <Label>{translateText("规则筛选")}</Label>
        </div>
        <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <span>{translateText("已选规则")}</span>
          <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchRuleCount}</span>
          <span className="text-primary/70">/ {copyableSourceRules.length}</span>
        </div>
      </div>
      <div className="grid gap-2">
        <div className={cn("grid min-w-0 gap-2", isOwnRuleScope && "grid-cols-2")}>
          <Select value={copyRuleCategory} onValueChange={(value) => setCopyRuleCategory(value as RuleCategory)} disabled={copyActionPending}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{translateText("全部规则")}</SelectItem>
              <SelectItem value="local">{translateText("端口转发")}</SelectItem>
              <SelectItem value="tunnel">{translateText("隧道转发")}</SelectItem>
              <SelectItem value="chain">{translateText("转发链")}</SelectItem>
              <SelectItem value="group">{translateText("转发组")}</SelectItem>
            </SelectContent>
          </Select>
          {isOwnRuleScope && <Select value={copyRulePersonalGroupId === null ? "all" : String(copyRulePersonalGroupId)} disabled={copyActionPending} onValueChange={(value) => {
            setCopyRulePersonalGroupId(value === "all" ? null : Number(value));
            setCopyRuleIds([]);
          }}>
            <SelectTrigger className="h-9 text-xs" aria-label={translateText("规则分组")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{translateText("全部分组")}</SelectItem>
              {(personalGroupsQuery.data?.groups || []).map((group) => <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>)}
              <SelectItem value="0">{translateText("未分组")}</SelectItem>
            </SelectContent>
          </Select>}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={copyRuleSearch}
            disabled={copyActionPending}
            onChange={(event) => setCopyRuleSearch(event.target.value)}
            placeholder={translateText("查找规则名称、端口或目标地址")}
            className="h-9 pl-8 pr-8 text-xs"
          />
          {copyRuleSearch ? (
            <button
              type="button"
              aria-label={translateText("清空查找")}
              className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setCopyRuleSearch("")}
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => {
            const visibleRuleIds = copyableSourceRules.map((rule: any) => Number(rule.id));
            const visibleRuleIdSet = new Set(visibleRuleIds);
            setCopyRuleIds((prev) => (
              allVisibleCopyRulesSelected
                ? prev.filter((id) => !visibleRuleIdSet.has(id))
                : Array.from(new Set([...prev, ...visibleRuleIds]))
            ));
          }}
          disabled={copyableSourceRules.length === 0 || copyActionPending}
        >
          {allVisibleCopyRulesSelected ? translateText("取消") : translateText("全选")}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {copyableSourceRules.length}{translateText(" 项")}</span>
      </div>
      <div className="space-y-2 rounded-md border border-border/60 p-2">
        {copyableSourceRules.length > 0 ? copyableSourceRules.map((rule: any) => {
          const category = getRuleCategory(rule, forwardGroupById);
          return (
            <label
              key={rule.id}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 transition-colors hover:bg-muted/40 ${
                copyRuleIds.includes(Number(rule.id))
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-border/40 bg-background/70"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={copyRuleIds.includes(Number(rule.id))}
                disabled={copyActionPending}
                onChange={(event) => toggleCopyRule(Number(rule.id), event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {renderRuleGroupIcon(category, "h-3.5 w-3.5")}
                  <span className="min-w-0 truncate text-sm font-medium">{rule.name}</span>
                  <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">{desktopRuleTypeLabels[category]}</Badge>
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  :{rule.sourcePort} -&gt; {rule.targetIp}:{rule.targetPort} / {forwardTypeDisplayLabel(rule.forwardType)} / {formatForwardRuleProtocol(rule.protocol)}
                </span>
              </span>
            </label>
          );
        }) : (
          <div className="py-10 text-center text-sm text-muted-foreground">{translateText("没有匹配的转发规则")}</div>
        )}
      </div>
    </div>
  );
  const buildEmptyBatchEditForm = useCallback((): BatchEditFormData => ({
    routeMode: canUseSavedLocalForward ? "local" : canUseGost ? "tunnel" : canUseForwardChain ? "chain" : canUseFailoverGroup ? "group" : "local",
    forwardType: defaultForm.forwardType,
    tunnelId: null,
    forwardGroupId: null,
    targetIp: "",
    targetPort: 0,
  }), [canUseFailoverGroup, canUseForwardChain, canUseGost, canUseSavedLocalForward]);
  const selectedBatchEditTunnel = useMemo(() => {
    if (!batchEditForm.tunnelId || !tunnels) return null;
    return tunnels.find((t: any) => Number(t.id) === Number(batchEditForm.tunnelId)) || null;
  }, [batchEditForm.tunnelId, tunnels]);
  const selectedBatchEditForwardGroup = useMemo(() => {
    if (!batchEditForm.forwardGroupId) return null;
    return forwardGroupById.get(Number(batchEditForm.forwardGroupId)) || null;
  }, [batchEditForm.forwardGroupId, forwardGroupById]);
  const selectedBatchEditTunnelDisplay = useMemo(
    () => getTunnelDisplay(selectedBatchEditTunnel, nginxTunnelEnabled),
    [selectedBatchEditTunnel, nginxTunnelEnabled],
  );
  const batchEditAvailableGroups = useMemo(
    () => batchEditForm.routeMode === "local"
      ? availablePortForwardGroups
      : batchEditForm.routeMode === "chain"
        ? availableForwardChainGroups
        : availableFailoverForwardGroups,
    [availableFailoverForwardGroups, availableForwardChainGroups, availablePortForwardGroups, batchEditForm.routeMode],
  );
  const batchEditTargetIp = String(batchEditForm.targetIp || "").trim();
  const batchEditTargetPort = Number(batchEditForm.targetPort || 0);
  const hasBatchEditRouteSelection = batchEditForm.routeMode === "tunnel"
    ? !!selectedBatchEditTunnel
    : !!selectedBatchEditForwardGroup;
  const hasBatchEditTargetIpChange = batchEditTargetIp.length > 0;
  const hasBatchEditTargetPortChange = isValidPort(batchEditTargetPort);
  const hasBatchEditChanges = hasBatchEditRouteSelection || hasBatchEditTargetIpChange || hasBatchEditTargetPortChange;
  const batchCopyDisabled = !canAdd || copyActionPending || selectedBatchRuleCount === 0 || selectedBatchTargetCount === 0;
  const batchEditDisabled = copyActionPending || selectedBatchRuleCount === 0 || !hasBatchEditChanges;
  const ruleFilterCacheScope = user?.role === "admin"
    ? `admin-${user?.id || "self"}-${filterUser}`
    : `user-${user?.id || "self"}`;
  const ruleCategoryCountsCacheKey = useMemo(() => encodeURIComponent(JSON.stringify([
    ruleFilterCacheScope,
    ruleSearchQuery.trim(),
  ])), [ruleFilterCacheScope, ruleSearchQuery]);
  const [stableRuleCategoryCounts, setStableRuleCategoryCounts] = useState(() => {
    const cached = readCachedRuleCategoryCounts(ruleCategoryCountsCacheKey);
    return { cacheKey: ruleCategoryCountsCacheKey, counts: cached || EMPTY_RULE_CATEGORY_COUNTS, ready: !!cached };
  });
  const previousRuleCategoryCountsCacheKey = useRef(ruleCategoryCountsCacheKey);
  useEffect(() => {
    if (previousRuleCategoryCountsCacheKey.current === ruleCategoryCountsCacheKey) return;
    previousRuleCategoryCountsCacheKey.current = ruleCategoryCountsCacheKey;
    const cached = readCachedRuleCategoryCounts(ruleCategoryCountsCacheKey);
    setStableRuleCategoryCounts({ cacheKey: ruleCategoryCountsCacheKey, counts: cached || EMPTY_RULE_CATEGORY_COUNTS, ready: !!cached });
  }, [ruleCategoryCountsCacheKey]);
  const liveRuleCategoryCounts = useMemo<RuleCategoryCounts>(() => {
    if (rulePageQuery.data?.categoryCounts) {
      return normalizeRuleCategoryCounts(rulePageQuery.data.categoryCounts);
    }
    // A filtered/paged list cannot reconstruct global category totals.
    // Keep the last full counts while a new page is loading instead.
    return EMPTY_RULE_CATEGORY_COUNTS;
  }, [rulePageQuery.data?.categoryCounts]);
  const hasFreshRuleCategoryCounts = rulePageQuery.data?.categoryCounts !== undefined && !rulePageQuery.isPlaceholderData;
  useEffect(() => {
    if (!hasFreshRuleCategoryCounts) return;
    setStableRuleCategoryCounts((previous) => (
      previous.cacheKey === ruleCategoryCountsCacheKey && previous.ready && ruleCategoryCountsEqual(previous.counts, liveRuleCategoryCounts)
        ? previous
        : { cacheKey: ruleCategoryCountsCacheKey, counts: liveRuleCategoryCounts, ready: true }
    ));
    writeCachedRuleCategoryCounts(ruleCategoryCountsCacheKey, liveRuleCategoryCounts);
  }, [hasFreshRuleCategoryCounts, liveRuleCategoryCounts, ruleCategoryCountsCacheKey]);
  // Do not show the previous owner's/search's counts during the render
  // before the cache-reset effect runs.
  const matchingCachedRuleCategoryCounts = stableRuleCategoryCounts.cacheKey === ruleCategoryCountsCacheKey
    ? stableRuleCategoryCounts
    : { counts: EMPTY_RULE_CATEGORY_COUNTS, ready: false };
  const ruleCategoryCountsReady = hasFreshRuleCategoryCounts || matchingCachedRuleCategoryCounts.ready;
  const ruleCategoryCounts = hasFreshRuleCategoryCounts ? liveRuleCategoryCounts : matchingCachedRuleCategoryCounts.counts;
  const ruleCategoryItems = useMemo<SlidingTabItem<RuleCategory>[]>(() => [
    { value: "all", label: translateText("全部"), icon: LayoutGrid, badge: ruleCategoryCountsReady ? ruleCategoryCounts.all : null },
    { value: "local", label: desktopRuleTypeLabels.local, icon: ArrowRightLeft, badge: ruleCategoryCountsReady ? ruleCategoryCounts.local : null },
    { value: "tunnel", label: desktopRuleTypeLabels.tunnel, icon: Network, badge: ruleCategoryCountsReady ? ruleCategoryCounts.tunnel : null },
    { value: "chain", label: desktopRuleTypeLabels.chain, icon: GitBranch, badge: ruleCategoryCountsReady ? ruleCategoryCounts.chain : null },
    { value: "group", label: desktopRuleTypeLabels.group, icon: Layers3, badge: ruleCategoryCountsReady ? ruleCategoryCounts.group : null },
  ], [ruleCategoryCounts, ruleCategoryCountsReady]);
  const visibleRuleIdsForMetrics = useMemo(() => (
    Array.from(new Set(filteredRules.map((rule: any) => Number(rule.id)).filter((id: number) => Number.isInteger(id) && id > 0)))
      .sort((a, b) => a - b)
  ), [filteredRules]);
  const selfTestRuleDetail = useMemo(() => {
    if (!selfTestRule) return null;
    return (rules || [])
      .find((rule: any) => Number(rule.id) === Number(selfTestRule.id)) || null;
  }, [rules, selfTestRule?.id]);
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
  const trafficRangeLabel = translateText("近 24h");

  const { data: totalTrafficSummary } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "total", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: secondaryQueriesReady && visibleRuleIdsForMetrics.length > 0,
      refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
      staleTime: 5000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    }
  );
  const { data: dailyTrafficSummary, isFetched: dailyTrafficSummaryFetched } = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "24h", ruleIds: visibleRuleIdsForMetrics },
    {
      enabled: visibleRuleIdsForMetrics.length > 0,
      refetchInterval: adaptivePollingInterval(pollingInterval("normal")),
      staleTime: 5000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    }
  );
  const [stableTotalTrafficSummaryRows, setStableTotalTrafficSummaryRows] = useState<any[]>([]);
  const [stableDailyTrafficSummaryRows, setStableDailyTrafficSummaryRows] = useState<any[]>([]);
  const resetTrafficMutation = trpc.rules.resetTraffic.useMutation({
    onSuccess: async (_data, variables) => {
      invalidateRuleProbeStatuses(
        variables.scope === "rule" && variables.ruleId
          ? [Number(variables.ruleId)]
          : variables.ruleIds,
      );
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
      toast.success(translateText("规则统计数据已重置"));
    },
    onError: (err) => toast.error(err.message || translateText("重置数据失败")),
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
  useEffect(() => {
    if (dailyTrafficSummary === undefined) return;
    updateRuleProbeCache(user?.id, trafficByRule);
    let released = false;
    for (const ruleId of invalidatedRuleProbeIdsRef.current) {
      if (!hasRuleProbeAfterInvalidation(user?.id, ruleId, trafficByRule.get(ruleId))) continue;
      invalidatedRuleProbeIdsRef.current.delete(ruleId);
      released = true;
    }
    if (released) setRuleProbeCacheRevision((revision) => revision + 1);
  }, [dailyTrafficSummary, trafficByRule, user?.id]);
  const stableProbeByRule = useMemo(() => (
    buildStableRuleProbeMap(
      user?.id,
      visibleRuleIdsForMetrics,
      trafficByRule,
      Date.now(),
      invalidatedRuleProbeIdsRef.current,
    )
  ), [ruleProbeCacheRevision, trafficByRule, user?.id, visibleRuleIdsForMetrics]);
  const hasForwardGroupRules = useMemo(
    () => filteredRules.some((rule: any) => Number(rule.forwardGroupId || 0) > 0),
    [filteredRules],
  );
  const ruleStatusSnapshotReady = filteredRules.length === 0 || (
    dailyTrafficSummaryFetched
    && (!hasForwardGroupRules || forwardGroupsFetched || forwardGroupsError)
  );
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
  const pageDailyTrafficTotals = useMemo(() => {
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
  const pageTotalTrafficTotals = useMemo(() => {
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
  const effectiveRuleListSummary = ruleListSummary ?? stableRuleListSummary;
  const dailyTrafficTotals = effectiveRuleListSummary?.dailyTraffic || pageDailyTrafficTotals;
  const totalTrafficTotals = effectiveRuleListSummary?.totalTraffic || pageTotalTrafficTotals;
  const compareRulesBySavedOrder = useCallback((a: any, b: any) => {
    const aCategory = getRuleCategory(a, forwardGroupById);
    const bCategory = getRuleCategory(b, forwardGroupById);
    if (ruleCategory === "all") {
      const categoryCompare = (RULE_SORT_CATEGORY_RANK.get(aCategory) ?? 99) - (RULE_SORT_CATEGORY_RANK.get(bCategory) ?? 99);
      if (categoryCompare !== 0) return categoryCompare;
    }
    const aSortOrder = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
    const bSortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (aSortOrder !== bSortOrder) return aSortOrder - bSortOrder;
    const createdCompare = new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    if (createdCompare !== 0) return createdCompare;
    return Number(b.id || 0) - Number(a.id || 0);
  }, [forwardGroupById, ruleCategory]);
  const sortedFilteredRules = useMemo(() => {
    return [...filteredRules].sort(compareRulesBySavedOrder);
  }, [compareRulesBySavedOrder, filteredRules]);
  const ruleOrder = useOptimisticSortableOrder({
    items: sortedFilteredRules,
    getId: (rule: any) => Number(rule.id),
  });
  const orderedFilteredRules = ruleOrder.items;
  const trafficTotalsCacheScope = useMemo(
    () => [
      ruleFilterCacheScope,
      filterResource,
      ruleCategory,
      `personal-${activePersonalGroupId ?? "all"}`,
      ruleSearchQuery.trim() || "search-all",
    ].join("."),
    [filterResource, ruleCategory, ruleFilterCacheScope, ruleSearchQuery, activePersonalGroupId],
  );
  const trafficTotalsLastCacheScope = user?.role === "admin"
    ? `admin-${user?.id || "self"}`
    : `user-${user?.id || "self"}`;
  const hasActiveUserFilter = user?.role === "admin" && filterUser !== "self";
  const hasActiveRuleFilter = hasActiveUserFilter || filterResource !== "all" || ruleCategory !== "all" || ruleSearchQuery.trim().length > 0;
  const rulesHeaderLoading = isLoading || !rules || !ruleListDataReady || !filteredRulesPrimed;
  const totalTrafficTotalsLoading = rulesHeaderLoading || !secondaryQueriesReady || ruleListSummaryLoading;
  const dailyTrafficTotalsLoading = rulesHeaderLoading || !secondaryQueriesReady || ruleListSummaryLoading;
  const [stableRulePageMeta, setStableRulePageMeta] = useState({ activeItems: 0, totalItems: 0, scopeTotalItems: 0 });
  useEffect(() => {
    if (!rulePageQuery.data || rulePageQuery.isPlaceholderData) return;
    setStableRulePageMeta({
      activeItems: Math.max(0, Number(rulePageQuery.data.activeItems) || 0),
      totalItems: Math.max(0, Number(rulePageQuery.data.totalItems) || 0),
      scopeTotalItems: Math.max(0, Number(rulePageQuery.data.scopeTotalItems) || 0),
    });
  }, [rulePageQuery.data, rulePageQuery.isPlaceholderData]);
  const rulePageMeta = rulePageQuery.data ?? stableRulePageMeta;
  const ruleScopeTotal = Math.max(0, Number(rulePageMeta.scopeTotalItems) || 0);
  const activeCount = Math.max(0, Number(rulePageMeta.activeItems) || 0);
  const filteredRuleTotal = Math.max(0, Number(rulePageMeta.totalItems) || 0);
  const rulePagination = useServerPagination(isRuleGlobeView ? [] : orderedFilteredRules, filteredRuleTotal, rulePageRequest, {
    pageSize: rulePageSize,
    isReady: !isLoading && !!rulePageQuery.data,
  });
  const pagedRules = rulePagination.items;
  const ruleSortingEnabled = isCompleteRuleSortScope(ruleCategory, filterResource)
    && activePersonalGroupId === null
    && (user?.role === "admin" || !pagedRules.some(isAdminManagedRule))
    && effectiveViewMode !== "globe"
    && ruleSearchQuery.trim().length === 0
    && (user?.role !== "admin" || filterUser !== "all");
  const ruleSortingReady = ruleSortingEnabled && !rulePageQuery.isPlaceholderData;
  const ruleSortableItems = useMemo(() => {
    if (!ruleSortingEnabled) return [];
    return pagedRules.filter((rule: any) => !rule.forwardGroupRuleId && !rule.forwardGroupMemberId);
  }, [pagedRules, ruleSortingEnabled]);
  const ruleSortable = useSortableReorder({
    items: ruleSortableItems,
    getId: (rule: any) => Number(rule.id),
    disabled: !ruleSortingReady || ruleReorderPending || ruleSortableItems.length < 2,
    onReorder: (nextRules) => {
      if (ruleCategory === "all") return;
      const requestId = ruleOrder.begin(nextRules);
      reorderRulesMutation.mutate({
        category: ruleCategory,
        ids: nextRules.map((rule: any) => Number(rule.id)),
        startIndex: (rulePagination.currentPage - 1) * rulePagination.pageSize,
      }, {
        onError: () => ruleOrder.release(requestId),
        onSettled: () => ruleOrder.resync(requestId, () => Promise.all([
          utils.rules.list.invalidate(),
          utils.rules.listPage.invalidate(),
          utils.rules.mapItems.invalidate(),
          utils.rules.listSummary.invalidate(),
        ])),
      });
    },
  });
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
    return hosts?.find((h: any) => h.id === hostId)?.name || translateText("主机 #{0}", [hostId]);
  };
  const getHostOptionName = (host: any) => host?.name || translateText("主机 #{0}", [host?.id || "-"]);
  const renderTrafficBillingResourceBadge = (enabled = true) => enabled ? (
    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:text-amber-300">{translateText("按量计费资源")}</span>
  ) : null;
  const getHostOptionText = (host: any) => `${getHostOptionName(host)}（${host?.isOnline ? translateText("在线") : translateText("离线")}）${trafficBillingHostIds.has(Number(host?.id)) ? translateText(" / 按量计费资源") : ""}`;
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
        {renderTrafficBillingResourceBadge(trafficBillingHostIds.has(Number(host?.id)))}
        <span className="sr-only">{online ? translateText("在线") : translateText("离线")}</span>
      </span>
    );
  };
  const getPortRangeText = (item: any) => {
    const start = Number(item?.portRangeStart || 0);
    const end = Number(item?.portRangeEnd || 0);
    return start > 0 && end > 0 ? `${start}-${end}` : "";
  };
  const trafficMultiplierBadgeClass = (_value: unknown) => "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  const renderTrafficMultiplierBadge = (value: unknown) => (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${trafficMultiplierBadgeClass(value)}`}>
      {formatTrafficMultiplier(value)}
    </span>
  );
  const getTunnelSelectName = (tunnel: any) => String(tunnel?.name || translateText("隧道 #{0}", [tunnel?.id || "-"]));
  const getTunnelSelectModeLabel = (tunnel: any) => getTunnelDisplay(tunnel, true).shortLabel;
  const getTunnelSelectText = (tunnel: any) => [
    getTunnelSelectName(tunnel),
    getTunnelSelectModeLabel(tunnel),
    getPortRangeText(tunnel),
    formatTrafficMultiplier((tunnel as any)?.trafficMultiplier),
    trafficBillingTunnelIds.has(Number(tunnel?.id)) ? translateText("按量计费资源") : "",
  ].filter(Boolean).join(" / ");
  const renderTunnelModeBadge = (tunnel: any) => (
    <span className="shrink-0 rounded border border-chart-4/30 bg-chart-4/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-chart-4">
      {getTunnelSelectModeLabel(tunnel)}
    </span>
  );
  const getTunnelStatusText = (tunnel: any) => {
    const state = tunnelAvailabilityById.get(Number(tunnel?.id || 0));
    if (state?.status === "available") return translateText("可用");
    if (state?.status === "degraded") return translateText("部分可用");
    if (state?.status === "pending") return translateText("等待检测");
    if (state?.status === "unavailable") return translateText("不可用");
    return state?.message || translateText("已停用");
  };
  const renderTunnelSelectStatusDot = (tunnel: any) => {
    const state = tunnelAvailabilityById.get(Number(tunnel?.id || 0));
    if (state?.status === "available") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    if (state?.status === "degraded" || state?.status === "pending") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" aria-hidden="true" />;
    if (state?.status === "unavailable") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" aria-hidden="true" />;
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
  };
  const renderTunnelSelectLabel = (tunnel: any) => (
    <span className="inline-flex min-w-0 items-center gap-2" title={`${getTunnelStatusText(tunnel)} / ${getTunnelSelectText(tunnel)}`}>
      {renderTunnelSelectStatusDot(tunnel)}
      <span className="min-w-0 truncate">{getTunnelSelectName(tunnel)}</span>
      {renderTunnelModeBadge(tunnel)}
      {getPortRangeText(tunnel) && <span className="shrink-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">{getPortRangeText(tunnel)}</span>}
      {renderTrafficMultiplierBadge((tunnel as any).trafficMultiplier)}
      {renderTrafficBillingResourceBadge(trafficBillingTunnelIds.has(Number(tunnel?.id)))}
      <span className="sr-only">{getTunnelStatusText(tunnel)}</span>
    </span>
  );
  const getForwardGroupSelectName = (group: any) => String(group?.name || `${getForwardGroupRouteLabel(group)} #${group?.id || "-"}`);
  const isTrafficBillingForwardGroup = (group: any) => {
    if (!trafficBilling?.enabled || !group) return false;
    if (trafficBillingForwardGroupIds.has(Number(group.id))) return true;
    const members = Array.isArray(group.members) ? group.members : [];
    return members.some((member: any) => {
      if (!member || member.isEnabled === false) return false;
      if (member.memberType === "host") return trafficBillingHostIds.has(Number(member.hostId || 0));
      if (member.memberType === "tunnel") return trafficBillingTunnelIds.has(Number(member.tunnelId || 0));
      return false;
    });
  };
  const getForwardGroupSelectText = (group: any) => {
    const mode = normalizeForwardGroupModeForRule(group);
    const billingText = isTrafficBillingForwardGroup(group) ? translateText(" / 按量计费资源") : "";
    if (isForwardChainGroup(group) || mode === "port") {
      return [getForwardGroupSelectName(group), formatTrafficMultiplier((group as any)?.trafficMultiplier)].join(" / ") + billingText;
    }
    return translateText("{0} / {1} / {2} 成员{3}", [getForwardGroupSelectName(group), getForwardGroupKindLabel(group), group?.members?.length || 0, billingText]);
  };
  const getForwardGroupConfigStatus = useCallback((group: any): "available" | "degraded" | "pending" | "unavailable" | "disabled" => (
    groupAvailabilityById.get(Number(group?.id || 0))?.status || "unavailable"
  ), [groupAvailabilityById]);
  const resolveRuleVisualStatus = useCallback((rule: any): ReturnType<typeof resolveForwardRuleVisualStatus> => {
    if (rule.ruleLimitReason) return { state: "disabled", title: rule.ruleLimitReason === "expired" ? translateText("规则已到期") : translateText("规则流量额度已用尽") };
    const latest = stableProbeByRule.get(Number(rule.id));
    if (rule.forwardGroupId) {
      const group = forwardGroupById.get(Number(rule.forwardGroupId));
      const runtime = Array.isArray(group?.ruleRuntimeStatuses)
        ? group.ruleRuntimeStatuses.find((item: any) => Number(item.templateRuleId) === Number(rule.id))
        : null;
      const rawGroupStatus = group
        ? getForwardGroupConfigStatus(group)
        : forwardGroupsFetched || forwardGroupsError
          ? "unavailable"
          : "pending";
      const groupStatus = rawGroupStatus === "degraded" ? "available" : rawGroupStatus;
      return resolveForwardRuleVisualStatus({
        ruleEnabled: !!rule.isEnabled,
        ruleRunning: !!rule.isRunning,
        resourceAccessAllowed: rule.resourceAccessAllowed,
        groupEnabled: group?.isEnabled !== false,
        groupConfigStatus: groupStatus,
        runtimeStatus: runtime?.status,
        runningCount: runtime?.runningRuleCount,
        expectedCount: runtime?.expectedRuleCount,
        latestLatencyMs: latest?.latestLatencyMs,
        latestLatencyIsTimeout: latest?.latestLatencyIsTimeout,
        latestLatencyAt: latest?.latestLatencyAt,
      });
    }
    return resolveForwardRuleVisualStatus({
      ruleEnabled: !!rule.isEnabled,
      ruleRunning: !!rule.isRunning,
      resourceAccessAllowed: rule.resourceAccessAllowed,
      groupEnabled: true,
      groupConfigStatus: "available",
      latestLatencyMs: latest?.latestLatencyMs,
      latestLatencyIsTimeout: latest?.latestLatencyIsTimeout,
      latestLatencyAt: latest?.latestLatencyAt,
    });
  }, [forwardGroupById, forwardGroupsError, forwardGroupsFetched, getForwardGroupConfigStatus, stableProbeByRule]);
  const ruleVisualStatuses = useMemo(() => {
    const statuses = new Map<number, {
      current: ReturnType<typeof resolveForwardRuleVisualStatus>;
      display: ReturnType<typeof resolveForwardRuleVisualStatus>;
      lastKnown: RuleVisualStatusSnapshot | null;
      invalidated: boolean;
    }>();
    const ruleIds = filteredRules
      .map((rule: any) => Number(rule?.id || 0))
      .filter((ruleId: number) => Number.isInteger(ruleId) && ruleId > 0);
    const lastKnownByRule = readRuleStatusSnapshots(user?.id, ruleIds);
    for (const rule of filteredRules) {
      const ruleId = Number(rule?.id || 0);
      if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
      const current = resolveRuleVisualStatus(rule);
      const invalidated = invalidatedRuleProbeIdsRef.current.has(ruleId);
      const lastKnown = invalidated ? null : lastKnownByRule.get(ruleId) || null;
      statuses.set(ruleId, {
        current,
        lastKnown,
        invalidated,
        display: preferLastKnownForwardRuleVisualStatus(current, lastKnown),
      });
    }
    return statuses;
  }, [filteredRules, resolveRuleVisualStatus, ruleProbeCacheRevision, user?.id]);
  const hasCachedRuleStatus = useMemo(
    () => Array.from(ruleVisualStatuses.values()).some((item) => !!item.lastKnown),
    [ruleVisualStatuses],
  );
  useEffect(() => {
    if (!user?.id || ruleVisualStatuses.size === 0) return;
    const snapshots = new Map<number, { state: ReturnType<typeof resolveForwardRuleVisualStatus>["state"]; title: string }>();
    ruleVisualStatuses.forEach(({ current, lastKnown, invalidated }, ruleId) => {
      // Do not repopulate a just-cleared snapshot from React Query's previous
      // rule object. The invalidation is released only after a new probe has
      // been observed, at which point the new concrete state can be cached.
      if (invalidated) return;
      // A pending result is commonly the short interval between page mount
      // and the next Agent report. Keep a confirmed previous state until a
      // concrete result arrives; first-time pending rules are still cached.
      if (current.state === "pending" && lastKnown) return;
      if (lastKnown && lastKnown.state === current.state && lastKnown.title === current.title) return;
      snapshots.set(ruleId, { state: current.state, title: current.title });
    });
    if (snapshots.size > 0) writeRuleStatusSnapshots(user.id, snapshots);
  }, [ruleVisualStatuses, user?.id]);
  const getForwardGroupStatusText = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return translateText("已停用");
    if (status === "available") return translateText("可用");
    if (status === "degraded") return translateText("部分可用");
    if (status === "pending") return translateText("等待检测");
    return translateText("不可用");
  };
  const renderForwardGroupSelectStatusDot = (group: any) => {
    const status = getForwardGroupConfigStatus(group);
    if (status === "disabled") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden="true" />;
    if (status === "available") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" aria-hidden="true" />;
    }
    if (status === "unavailable") {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" aria-hidden="true" />;
    }
    if (status === "degraded") return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" aria-hidden="true" />;
    return <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" aria-hidden="true" />;
  };
  const renderForwardGroupSelectLabel = (group: any) => {
    const mode = normalizeForwardGroupModeForRule(group);
    const memberCount = Number(group?.members?.length || 0);
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={`${getForwardGroupStatusText(group)} / ${getForwardGroupSelectText(group)}`}>
        {renderForwardGroupSelectStatusDot(group)}
        <span className="min-w-0 truncate">{getForwardGroupSelectName(group)}</span>
        {(isForwardChainGroup(group) || mode === "port") && renderTrafficMultiplierBadge((group as any).trafficMultiplier)}
        {renderTrafficBillingResourceBadge(isTrafficBillingForwardGroup(group))}
        {mode === "failover" && (
          <span className="shrink-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
            {memberCount}{translateText(" 成员")}</span>
        )}
        <span className="sr-only">{getForwardGroupStatusText(group)}</span>
      </span>
    );
  };
  const renderTunnelRoute = (tunnel: any, compact = false) => {
    const hopIds = getTunnelHopIds(tunnel);
    const exitGroup = Number(tunnel?.exitGroupId || 0) > 0
      ? forwardGroupById.get(Number(tunnel.exitGroupId))
      : null;
    const exitGroupName = exitGroup ? getForwardGroupSelectName(exitGroup) : "";
    const exitNames = exitGroupName ? getTunnelExitNames(tunnel, hosts) : [];
    const routeTitle = getTunnelRouteText(tunnel, hosts, exitGroupName);
    return (
      <div
        className={`flex min-w-0 items-center gap-1.5 text-xs ${compact ? "flex-wrap" : "whitespace-nowrap"}`}
        title={routeTitle}
      >
        {hopIds.map((hostId: number, index: number) => (
          <Fragment key={`${tunnel?.id || "tunnel"}-${hostId}-${index}`}>
            {index > 0 && <ArrowRight className="h-3 w-3 shrink-0" />}
            <span
              className={exitGroupName && index === hopIds.length - 1
                ? (compact ? "min-w-0 max-w-full break-words" : "min-w-0 truncate")
                : (compact ? "max-w-[8rem] truncate" : "truncate")}
            >
              {exitGroupName && index === hopIds.length - 1 ? (
                <>
                  {exitGroupName}
                  {exitNames.length > 0 && (
                    <span className="text-muted-foreground">
                      {translateText("；出口：")}{exitNames.join(" / ")}
                    </span>
                  )}
                </>
              ) : tunnelHopHostName(tunnel, hostId, hosts)}
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
      return { nodeMeta: meta, sourceLabel: selfTestRule?.name || translateText("源节点"), targetLabel: selfTestRule?.name || translateText("目标"), plannedSegments: [] as LinkTestPlannedSegment[] };
    }

    const hostById = new Map<number, any>((hosts || []).map((host: any) => [Number(host.id), host]));
    const routeGroup = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const routeMember = routeGroup && !isForwardChainGroup(routeGroup) ? forwardGroupRouteMembers(routeGroup)[0] : null;
    const tunnelId = Number(rule.tunnelId || routeMember?.tunnelId || 0);
    const tunnel = tunnelId ? tunnelById.get(tunnelId) : null;
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
      ? forwardGroupById.get(Number((tunnel as any).entryGroupId)) || (tunnel as any).entryGroup
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
        || translateText("主机 #{0}", [hostId]);
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
    const targetText = formatAddressWithPort(targetIp || "-", Number(rule.targetPort || 0) || "-") || translateText("目标");
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
    const isChainRule = !!chainGroup && isForwardChainGroup(chainGroup);
    const routeHopCount = Math.max(0, routeHostIds.length - 1);
    const pathHopCount = isChainRule
      ? (chainEntryMembers.length > 0 ? 1 : 0) + routeHopCount + 1
      : routeHopCount;
    if (chainEntryMembers.length > 0 && routeHosts[0]) {
      const firstChainHost = routeHosts[0];
      const firstChainHostId = Number(routeHostIds[0] || 0);
      chainEntryMembers.forEach((entryMember: any) => {
        const entryHostId = Number(entryMember.hostId || 0);
        const entryHost = hostForRouteId(entryHostId);
        plannedSegments.push({
          from: hostDisplayName(entryHost) || `入口主机 #${entryMember.hostId || "-"}`,
          to: hostDisplayName(firstChainHost),
          fromHostId: entryHostId || null,
          toHostId: firstChainHostId || null,
          hopIndex: 0,
          hopCount: pathHopCount,
          fromMeta: meta[hostDisplayName(entryHost)] || meta[String(entryMember.hostId || "")],
          toMeta: meta[hostDisplayName(firstChainHost)],
        });
      });
    }
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
      useTunnelLatencyFallback: boolean,
      hopIndex: number,
    ): LinkTestPlannedSegment => ({
      from: labelForRouteHostId(fromHostId),
      to: labelForRouteHostId(toHostId),
      fromHostId: fromHostId || null,
      toHostId: toHostId || null,
      hopIndex,
      hopCount: pathHopCount,
      fromMeta: nodeMetaForHostId(fromHostId),
      toMeta: nodeMetaForHostId(toHostId),
      success: tunnelLatencyMs !== null && useTunnelLatencyFallback
        ? true
        : tunnelLatencyIsTimeout && useTunnelLatencyFallback
          ? false
          : undefined,
      latencyMs: tunnelLatencyMs !== null && useTunnelLatencyFallback ? tunnelLatencyMs : null,
      message: tunnelLatencyIsTimeout && useTunnelLatencyFallback ? translateText("隧道段失败") : null,
      method: null,
      pending: false,
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
      if (nextHostId > 0) {
        tunnelEntryHostIds.forEach((entryHostId) => {
          if (entryHostId !== nextHostId) {
            plannedSegments.push(createTunnelPlannedSegment(entryHostId, nextHostId, false, 0));
          }
        });
      }
      for (let index = 0; index < restRouteHostIds.length - 1; index += 1) {
        plannedSegments.push(createTunnelPlannedSegment(
          Number(restRouteHostIds[index]),
          Number(restRouteHostIds[index + 1]),
          false,
          index + 1,
        ));
      }
    } else {
      for (let index = 0; index < routeHostIds.length - 1; index += 1) {
        const singleTunnelSegment = routeHostIds.length - 1 === 1;
        plannedSegments.push(createTunnelPlannedSegment(
          Number(routeHostIds[index]),
          Number(routeHostIds[index + 1]),
          singleTunnelSegment,
          index + (chainEntryMembers.length > 0 ? 1 : 0),
        ));
      }
    }
    const exitHostForTarget = routeHosts[routeHosts.length - 1] || sourceHost;
    if (exitHostForTarget) {
      const exitHostId = Number(exitHostForTarget.id || routeHostIds[routeHostIds.length - 1] || 0);
      plannedSegments.push({
        from: hostDisplayName(exitHostForTarget),
        to: ruleLabel,
        fromHostId: exitHostId || null,
        toHostId: Number(targetHost?.id || 0) || null,
        hopIndex: isChainRule ? Math.max(0, pathHopCount - 1) : null,
        hopCount: isChainRule ? pathHopCount : null,
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
    if (type === "local") return resource.name || translateText("端口转发 #{0}", [resource.id]);
    if (type === "tunnel") return `${resource.name || `#${resource.id}`} / ${getTunnelRouteText(resource, hosts || [])}`;
    return resource.name || `#${resource.id}`;
  };

  const getTransferResourceSearchText = useCallback((type: RuleTransferScopeType, resource: any) => {
    const values: any[] = [resource?.id];
    if (type === "local") {
      values.push(
        resource?.name,
        resource?.description,
        resource?.displayRemark,
        resource?.domain,
        resource?.forwardType,
        resource?.groupMode,
        getForwardGroupKindLabel(resource),
      );
      (resource?.members || []).forEach((member: any) => {
        values.push(member?.hostId, member?.entryAddress, member?.connectHost, member?.name);
      });
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

  const getTransferResourceStatusMeta = (type: RuleTransferScopeType, resource: any) => {
    if (type === "tunnel") {
      const state = tunnelAvailabilityById.get(Number(resource?.id || 0));
      if (state?.status === "available") {
        return {
          label: translateText("可用"),
          dotClassName: "bg-emerald-500",
          textClassName: "text-muted-foreground",
        };
      }
      if (state?.status === "degraded" || state?.status === "pending") {
        return {
          label: state.status === "degraded" ? translateText("部分可用") : translateText("检测中"),
          dotClassName: "bg-amber-500",
          textClassName: "text-muted-foreground",
        };
      }
      return {
        label: state?.status === "disabled" ? translateText("停用") : translateText("不可用"),
        dotClassName: state?.status === "disabled" ? "bg-muted-foreground/60" : "bg-destructive",
        textClassName: "text-muted-foreground",
      };
    }

    const status = getForwardGroupConfigStatus(resource);
    if (status === "available") {
      return {
        label: translateText("可用"),
        dotClassName: "bg-emerald-500",
        textClassName: "text-muted-foreground",
      };
    }
    if (status === "pending" || status === "degraded") {
      return {
        label: status === "degraded" ? translateText("部分可用") : translateText("检测中"),
        dotClassName: "bg-amber-500",
        textClassName: "text-muted-foreground",
      };
    }
    if (status === "disabled") {
      return {
        label: translateText("停用"),
        dotClassName: "bg-muted-foreground/60",
        textClassName: "text-muted-foreground",
      };
    }
    return {
      label: translateText("离线"),
      dotClassName: "bg-muted-foreground/60",
      textClassName: "text-muted-foreground",
    };
  };

  const renderTransferResourceOption = (type: RuleTransferScopeType, resource: any, options?: { showStatus?: boolean }) => {
    const statusMeta = options?.showStatus ? getTransferResourceStatusMeta(type, resource) : null;
    const statusBadge = statusMeta ? (
      <span className="inline-flex shrink-0 items-center" title={statusMeta.label}>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusMeta.dotClassName}`} aria-hidden="true" />
        <span className="sr-only">{statusMeta.label}</span>
      </span>
    ) : null;

    if (type === "local") {
      const members = (resource?.members || []).filter((member: any) => member?.isEnabled !== false);
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {statusBadge}
            <span className="truncate">{resource.name || translateText("端口转发 #{0}", [resource.id])}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {members.length > 0 ? members.map((member: any) => member.entryAddress || member.connectHost || (member.hostId ? translateText("主机 #{0}", [member.hostId]) : translateText("所属主机"))).join(" / ") : getForwardGroupKindLabel(resource)}
          </span>
        </div>
      );
    }
    if (type === "tunnel") {
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {statusBadge}
            <span className="truncate">{resource.name || `#${resource.id}`}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{getTunnelRouteText(resource, hosts || [])}</span>
        </div>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-2">
        {statusBadge}
        <span className="truncate">{resource.name || `#${resource.id}`}</span>
      </span>
    );
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
    showStatus = false,
    cardList = false,
    stackedList = false,
  }: {
    type: RuleTransferScopeType;
    resources: any[];
    filteredResources: any[];
    selectedResource: any;
    selectedId: string;
    search: string;
    onSearch: (value: string) => void;
    onSelect: (value: string) => void;
    showStatus?: boolean;
    cardList?: boolean;
    stackedList?: boolean;
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
              placeholder={translateText("搜索{0}", [label])}
              className="h-9 border-0 pl-9 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {filteredResources.length > 0 ? (
              filteredResources.map((resource: any) => {
                const id = String(resource.id);
                const selected = id === selectedId;
                if (cardList) {
                  return (
                    <button
                      key={id}
                      type="button"
                      title={getTransferResourceLabel(type, resource)}
                      aria-pressed={selected}
                      onClick={() => onSelect(id)}
                      className={`flex w-full min-w-0 items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/40 ${
                        selected
                          ? "border-primary/50 bg-primary/5 shadow-sm"
                          : "border-border/40 bg-background/70"
                      }`}
                    >
                      {selected ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-border/70 bg-background" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1">{renderTransferResourceOption(type, resource, { showStatus })}</div>
                    </button>
                  );
                }
                return (
                  <button
                    key={id}
                    type="button"
                    title={getTransferResourceLabel(type, resource)}
                    aria-pressed={selected}
                    onClick={() => onSelect(id)}
                    className={`flex w-full min-w-0 gap-2 rounded-sm px-3 text-left text-sm transition-colors hover:bg-muted ${
                      stackedList ? "min-h-[3.25rem] items-start py-2" : "h-10 items-center"
                    } ${
                      selected ? "bg-muted text-foreground" : "text-foreground"
                    }`}
                  >
                    {selected ? (
                      <CheckCircle2 className={`${stackedList ? "mt-0.5" : ""} h-4 w-4 shrink-0 text-primary`} />
                    ) : (
                      <span className={`${stackedList ? "mt-0.5" : ""} h-4 w-4 shrink-0`} aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">{renderTransferResourceOption(type, resource, { showStatus })}</div>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                {resources.length === 0 ? translateText("暂无可选择的{0}", [label]) : translateText("没有匹配的{0}", [label])}
              </div>
            )}
          </div>
        </div>
        {selectedResource && !selectedVisible ? (
          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {translateText("已选择：")}{getTransferResourceLabel(type, selectedResource)}
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
      if (type === "local") return Number(rule.forwardGroupId) === id;
      if (type === "tunnel") return Number(rule.tunnelId) === id;
      return Number(rule.forwardGroupId) === id;
    });
  }, [forwardGroupById, transferSourceRules]);

  const exportableRules = useMemo(
    () => getRulesForTransferScope(exportScopeType, exportResourceId),
    [exportScopeType, exportResourceId, getRulesForTransferScope]
  );

  const manualImportValidation = useMemo<{ ok: boolean; message: string; rules: RuleTransferFileRule[] }>(() => {
    const lines = String(importManualText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { ok: false, message: translateText("每行填写 目标地址:端口，可在前面加上 监听端口:"), rules: [] };
    }
    if (lines.length > RULE_TRANSFER_MAX_IMPORT_COUNT) {
      return { ok: false, message: translateText("单次最多导入 {0} 条规则", [RULE_TRANSFER_MAX_IMPORT_COUNT]), rules: [] };
    }
    const rules: RuleTransferFileRule[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = parseManualRuleImportLine(lines[index]);
      if ("error" in parsed) {
        return { ok: false, message: translateText("第 {0} 行：{1}", [index + 1, parsed.error]), rules: [] };
      }
      const targetIp = String(parsed.targetIp || "").trim();
      const targetPort = Number(parsed.targetPort || 0);
      if (!isValidTargetHost(targetIp)) {
        return { ok: false, message: translateText("第 {0} 行：地址格式不正确", [index + 1]), rules: [] };
      }
      if (!isValidPort(targetPort)) {
        return { ok: false, message: translateText("第 {0} 行：端口必须在 1-65535 之间", [index + 1]), rules: [] };
      }
      rules.push({
        name: formatAddressWithPort(targetIp, targetPort).slice(0, 128),
        forwardType: defaultForm.forwardType,
        protocol: defaultForm.protocol,
        sourcePort: parsed.sourcePort,
        targetIp,
        targetPort,
        isEnabled: true,
        telegramErrorNotifyEnabled: false,
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
        failoverTargets: [],
        failoverSeconds: 60,
        recoverSeconds: 120,
        autoFailback: true,
      });
    }
    return { ok: true, message: translateText("已识别 {0} 条手动输入规则", [rules.length]), rules };
  }, [defaultForm.forwardType, defaultForm.protocol, importManualText]);

  const nyanpassPaste = useMemo(() => importSourceMode === "nyanpass" && importManualText.trim()
    ? parseCompatibleRuleTransferText(importManualText) : null, [importSourceMode,importManualText]);
  const nyanpassFile = importSourceMode === "nyanpass"
    ? nyanpassPaste?.ok && nyanpassPaste.file.importSource === "nyanpass" ? nyanpassPaste.file : null
    : importSourceMode === "file" && importFile?.importSource === "nyanpass" ? importFile : null;
  const isNyanpassImport = importSourceMode === "nyanpass" || !!nyanpassFile;
  useEffect(() => { setImportNyanpassAcknowledged(false); }, [importResourceId,importScopeType,importNyanpassProtocol,importManualText,importPortText]);

  const baseImportValidation = useMemo<{ ok: boolean; message: string; rules: RuleTransferFileRule[] }>(() => {
    if (isNyanpassImport) {
      if (nyanpassPaste && !nyanpassPaste.ok) return {ok:false,message:nyanpassPaste.error,rules:[]};
      if (!nyanpassFile) return {ok:false,message:translateText("请选择或粘贴 ny 导出的逐行 JSON 规则"),rules:[]};
      const rules=nyanpassFile.rules.map(rule=>({...rule,protocol:importNyanpassProtocol}));
      const error=selectedImportResource ? validateNyanpassImportTarget(rules,{protocol:importNyanpassProtocol,scope:importScopeType,resource:selectedImportResource,admin:user?.role === "admin"}) : null;
      if (error) return {ok:false,message:error,rules};
      if (!importNyanpassAcknowledged) return {ok:false,message:translateText("请确认实验性导入说明后继续"),rules};
      return {ok:true,message:translateText("ny（实验性）：已识别 {0} 条规则，导入后停用，端口冲突保留为失败项",[rules.length]),rules};
    }
    if (importSourceMode === "manual") {
      if (!manualImportValidation.ok) return manualImportValidation;
      return manualImportValidation;
    }
    if (importFileError) return { ok: false, message: importFileError, rules: [] };
    if (!importFile) return { ok: false, message: translateText("请选择导入文件"), rules: [] };
    return { ok: true, message: translateText("已识别 {0} 条{1}规则", [importFile.rules.length, ruleTransferScopeLabels[importScopeType]]), rules: importFile.rules };
  }, [importFile, importFileError, importResourceId, importScopeType, importSourceMode, manualImportValidation,isNyanpassImport,nyanpassPaste,nyanpassFile,importNyanpassProtocol,importNyanpassAcknowledged,selectedImportResource,user?.role]);

  const importValidation = useMemo(() => {
    const parsed = parseRuleImportPorts(importPortText);
    if (!parsed.ok) return { ok: false, message: parsed.error, rules: [] as RuleTransferFileRule[], preservePorts: true };
    const rules = assignRuleImportPorts(baseImportValidation.rules, importRetryState?.ports ?? parsed.ports, importSourceMode === "manual" && !importRetryState);
    const conflict = importSourceMode === "manual" ? findRuleTransferPortConflict(rules) : null;
    if (conflict) return { ok: false, message: translateText("第 {0}、{1} 行的监听端口 {2} 重复", [conflict.firstIndex + 1, conflict.secondIndex + 1, conflict.port]), rules, preservePorts: true };
    if (!selectedImportResource && baseImportValidation.ok) return { ok: false, message: translateText("请选择{0}", [ruleTransferScopeLabels[importScopeType]]), rules, preservePorts: true };
    return { ...baseImportValidation,
      rules,
      preservePorts: isNyanpassImport || importFile?.importSource === "text" || !!parsed.ports.length || !!importRetryState?.preservePorts || (importSourceMode === "manual" && rules.some(rule => rule.sourcePort > 0)),
    };
  }, [baseImportValidation, importPortText, importRetryState, isNyanpassImport, importSourceMode, importFile?.importSource, selectedImportResource, importScopeType]);

  const batchImportSourceReady = (isNyanpassImport ? !!nyanpassFile && (!nyanpassPaste || nyanpassPaste.ok)
    : importSourceMode === "manual" ? manualImportValidation.ok : !!importFile && !importFileError)
    && parseRuleImportPorts(importPortText).ok && importValidation.rules.length > 0
    && !(importSourceMode === "manual" && findRuleTransferPortConflict(importValidation.rules));
  const batchImportTargetError = isNyanpassImport && selectedImportResource
    ? validateNyanpassImportTarget(importValidation.rules, { protocol: importNyanpassProtocol, scope: importScopeType, resource: selectedImportResource, admin: user?.role === "admin" }) : null;
  const batchCanAdvance = ruleBatchCanAdvance(copyManageMode, batchStep, {
    busy: copyActionPending, selectedRules: selectedBatchRuleCount, selectedTargets: selectedBatchTargetCount,
    importSourceReady: !!batchImportSourceReady, importTargetReady: !!selectedImportResource && !batchImportTargetError,
  });

  const renderExportFormatPicker = () => <div className="space-y-1.5">
    <Label>{translateText("导出格式")}</Label>
    <Select value={exportFormat} onValueChange={value => setExportFormat(value as "json" | "text")}>
      <SelectTrigger aria-label={translateText("导出格式")}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="json">{translateText("JSON（完整配置）")}</SelectItem>
        <SelectItem value="text">{translateText("TXT（监听端口:目标地址:端口）")}</SelectItem>
      </SelectContent>
    </Select>
    {exportFormat === "text" && <p className="text-xs text-muted-foreground">{translateText("仅包含监听端口和目标，可直接重新导入；完整配置请用 JSON。")}</p>}
  </div>;

  const renderImportPortInput = () => <div className="space-y-1.5">
    <Label htmlFor="rule-import-ports">{translateText("监听端口")}</Label>
    <Input id="rule-import-ports" value={importPortText} maxLength={RULE_IMPORT_PORT_TEXT_MAX_LENGTH} disabled={importingRules}
      onChange={event => { setImportPortText(event.target.value); setImportRetryState(null); }}
      placeholder="10000-10020,10025" aria-describedby="rule-import-ports-hint" />
    <p id="rule-import-ports-hint" className="text-xs text-muted-foreground">{translateText(importSourceMode === "manual" ? "仅分配给未指定端口的行，不足随机。" : "按顺序分配，不足随机；留空沿用文件端口。")}</p>
  </div>;

  const renderNyanpassImportOptions = (showAcknowledgement = true) => isNyanpassImport ? (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
      <p className="font-medium text-amber-700 dark:text-amber-300">{translateText("ny / Nyanpass 导入（实验性）")}</p>
      <p className="text-muted-foreground">{translateText("导出未包含完整协议、启停状态及拓扑。请选择协议；规则导入后停用，不迁移历史流量，不覆盖已有规则或自动更换冲突端口。")}</p>
      <Select value={importNyanpassProtocol} onValueChange={value=>setImportNyanpassProtocol(value as RuleProtocol)} disabled={importingRules}>
        <SelectTrigger aria-label={translateText("ny 导入协议")}><SelectValue /></SelectTrigger>
        <SelectContent>{(["tcp","udp","both"] as const).map(value=><SelectItem key={value} value={value}>{formatForwardRuleProtocol(value)}</SelectItem>)}</SelectContent>
      </Select>
      {showAcknowledgement && <label className="flex cursor-pointer items-start gap-2 leading-5">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={importNyanpassAcknowledged} onChange={event=>setImportNyanpassAcknowledged(event.target.checked)} disabled={importingRules} />
        <span>{translateText("我已核对目标资源、协议和预览，接受实验性兼容限制")}</span>
      </label>}
    </div>
  ) : null;

  const resetImportDialog = () => {
    setImportPortText("");
    setImportRetryState(null);
    setImportFile(null);
    setImportFileName("");
    setImportFileError("");
    setImportFileInputKey((key) => key + 1);
    setImportManualText("");
    setImportNyanpassAcknowledged(false);
  };

  const handleImportFileChange = async (event: any) => {
    setImportRetryState(null);
    const file = event.target.files?.[0];
    setImportFile(null);
    setImportFileError("");
    setImportFileName(file?.name || "");
    setImportNyanpassAcknowledged(false);
    if (!file) return;
    if (Number(file.size || 0) > RULE_TRANSFER_MAX_FILE_SIZE) {
      setImportFileError(translateText("规则文件不能超过 5 MiB"));
      return;
    }
    try {
      const rawText = await file.text();
      const result = parseCompatibleRuleTransferText(rawText);
      if (!result.ok) {
        setImportFileError(result.error);
        return;
      }
      setImportFile(result.file);
    } catch {
      setImportFileError(translateText("文件无法解析，请选择 JSON 或 TXT 规则文件"));
    }
  };

  const buildImportRulePayload = (rule: RuleTransferFileRule) => {
    const resourceId = Number(importResourceId);
    const selectedTunnel = importScopeType === "tunnel" ? tunnelById.get(resourceId) : null;
    const selectedGroup = importScopeType === "tunnel" ? null : forwardGroupById.get(resourceId);
    const payloadForwardType: ForwardType = importScopeType === "tunnel"
      ? "gost"
      : getForwardGroupRuleForwardType(selectedGroup, rule.forwardType);
    return {
      hostId: importScopeType === "tunnel" ? Number(selectedTunnel?.entryHostId || 0) : undefined,
      userId: createOwnerUserId,
      name: rule.name,
      forwardType: payloadForwardType,
      protocol: rule.protocol,
      gostMode: "direct" as const,
      gostRelayHost: null,
      gostRelayPort: null,
      tunnelId: importScopeType === "tunnel" ? resourceId : null,
      forwardGroupId: importScopeType === "tunnel" ? null : resourceId,
      sourcePort: rule.sourcePort,
      targetIp: rule.targetIp,
      targetPort: rule.targetPort,
      isEnabled: rule.isEnabled,
      ...(isNyanpassImport && rule.rateLimitMbps ? {rateLimitMbps:rule.rateLimitMbps} : {}),
      telegramErrorNotifyEnabled: telegramBotReady && !!rule.telegramErrorNotifyEnabled,
      proxyProtocolReceive: rule.proxyProtocolReceive,
      proxyProtocolSend: rule.proxyProtocolSend,
      proxyProtocolExitReceive: rule.proxyProtocolExitReceive,
      proxyProtocolExitSend: rule.proxyProtocolExitSend,
      proxyProtocolVersion: rule.proxyProtocolVersion,
      tcpFastOpen: rule.tcpFastOpen,
      zeroCopy: rule.zeroCopy,
      udpOverTcp: rule.udpOverTcp,
      udpOverTcpPort: rule.udpOverTcpPort || null,
      failoverEnabled: importScopeType === "chain" ? false : rule.failoverEnabled,
      failoverStrategy: rule.failoverStrategy,
      failoverTargets: importScopeType === "chain" || !rule.failoverEnabled ? [] : rule.failoverTargets,
      failoverSeconds: rule.failoverSeconds,
      recoverSeconds: rule.recoverSeconds,
      autoFailback: rule.autoFailback,
    };
  };

  const handleImportRules = async () => {
    if (importingRulesRef.current) return;
    if (!importValidation.ok) {
      toast.error(importValidation.message);
      return;
    }
    importingRulesRef.current = true;
    setImportingRules(true);
    try {
      const orderedRules = [...importValidation.rules.filter(rule => rule.sourcePort > 0), ...importValidation.rules.filter(rule => rule.sourcePort <= 0)];
      const results = await runQueuedRules(orderedRules, "批量导入", rule => ({ operation: "create", input: buildImportRulePayload(rule),
        conflictStrategy: importValidation.preservePorts || rule.sourcePort <= 0 ? "error" : "auto",
      }), result => result.value);
      const failures = results.filter((result) => result.status === "rejected");
      await Promise.all([
        utils.rules.list.invalidate(),
        utils.rules.listPage.invalidate(),
        utils.rules.mapItems.invalidate(),
        utils.rules.listSummary.invalidate(),
        utils.rules.trafficSummary.invalidate(),
      ]);
      if (showCopyDialog) await fullRulesQuery.refetch();
      if (failures.length > 0) {
        const failedRules = failures.map((result) => result.item);
        setImportRetryState({ ports: failedRules.map(rule => rule.sourcePort), preservePorts: importValidation.preservePorts });
        if (isNyanpassImport && nyanpassFile) {
          setImportFile({...nyanpassFile,rules:failedRules});
          setImportSourceMode("file");
          setImportFileName(translateText("ny 剩余失败规则（实验性）"));
          setImportFileError("");
        } else if (importSourceMode === "file") {
          setImportFile((current) => current ? { ...current, rules: failedRules } : current);
        } else {
          setImportManualText(failedRules
            .map((rule) => `${rule.sourcePort > 0 ? rule.sourcePort + ":" : ""}${formatAddressWithPort(rule.targetIp, rule.targetPort)}`)
            .join("\n"));
        }
      } else {
        setShowImportDialog(false);
        setShowCopyDialog(false);
        resetImportDialog();
      }
    } catch (error: any) {
      toast.error(translateText("批量导入处理失败：{0}", [error?.message || translateText("请检查规则配置")]));
    } finally {
      importingRulesRef.current = false;
      setImportingRules(false);
    }
  };

  const handleExportRules = () => {
    const resource = exportResources.find((item: any) => String(item.id) === exportResourceId);
    if (!resource) {
      toast.error(translateText("请选择{0}", [ruleTransferScopeLabels[exportScopeType]]));
      return;
    }
    if (exportableRules.length === 0) {
      toast.error(translateText("当前选择没有可导出的规则"));
      return;
    }
    const resourceLabel = getTransferResourceLabel(exportScopeType, resource);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const partCount = downloadRuleTransferFiles(
      exportableRules,
      {
        type: exportScopeType,
        id: Number(exportResourceId),
        name: resourceLabel,
      },
      `forwardx-rules-${exportScopeType}-${sanitizeRuleTransferFilePart(resourceLabel)}-${date}`,
      exportFormat,
    );
    toast.success(translateText("已导出 {0} 条规则{1}", [exportableRules.length, partCount > 1 ? translateText("，共 {0} 个文件", [partCount]) : ""]));
    setShowExportDialog(false);
  };
  const getRuleOwnerName = (rule: any) => {
    const owner = userById.get(Number(rule.userId));
    return owner?.name || owner?.username || translateText("用户 #{0}", [rule.userId]);
  };

  /** 获取主机入口展示地址：优先展示自定义域名 / DDNS，最后回退自动检测 IP */
  const getForwardGroupName = (groupId: number) => {
    const group = forwardGroupById.get(Number(groupId));
    return group?.name || `${getForwardGroupRouteLabel(group)} #${groupId}`;
  };
  const getRuleResourceName = (rule: any) => {
    const forwardGroupId = Number(rule?.forwardGroupId || 0);
    if (forwardGroupId > 0) return getForwardGroupName(forwardGroupId);

    const tunnelId = Number(rule?.tunnelId || 0);
    if (tunnelId > 0) {
      return getTunnelSelectName(tunnelById.get(tunnelId) || { id: tunnelId });
    }

    return getRuleEntryHostName(rule);
  };
  const getForwardGroupMemberLabel = (member: any) => {
    if (member.memberType === "host") {
      return member.hostId ? getHostName(member.hostId) : translateText("主机成员");
    }
    const tunnel = member.tunnelId ? tunnelById.get(Number(member.tunnelId)) : null;
    return tunnel ? `${tunnel.name} / ${getTunnelRouteText(tunnel, hosts)}` : member.tunnelId ? translateText("隧道 #{0}", [member.tunnelId]) : translateText("隧道成员");
  };

  const entryDomainForForwardGroup = (group: any | null | undefined) => {
    if (!group) return "";
    if ((isForwardChainGroup(group) || normalizeForwardGroupModeForRule(group) === "port") && group.entryGroupId) {
      const entryGroup = forwardGroupById.get(Number(group.entryGroupId)) || group.entryGroup;
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
      || (Number(tunnel?.exitHost?.id || 0) === id ? tunnel.exitHost : null)
      || (Array.isArray(tunnel?.entryGroup?.members)
        ? tunnel.entryGroup.members.find((member: any) => Number(member?.host?.id || 0) === id)?.host
        : null);
  };

  const getTunnelEntryAddresses = (tunnel: any | null | undefined): EntryAddress[] => {
    if (!tunnel) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = Number(tunnel?.entryGroupId || 0) > 0
      ? forwardGroupById.get(Number(tunnel.entryGroupId)) || tunnel.entryGroup
      : null;
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
    if (hostId > 0) {
      // Shared groups may expose the member host only through the ACL-filtered
      // `member.host` payload. Keep that nested summary as a display fallback;
      // otherwise a configured DDNS/domain entry is replaced by entryAddress
      // (usually an IPv4 literal) for ordinary users.
      return resolveRuleEntryHost(hosts, hostId, member?.host || null);
    }
    const tunnelId = Number(member?.tunnelId || 0);
    if (tunnelId > 0) {
      const tunnel = tunnelById.get(tunnelId);
      const entryHostId = Number(tunnel?.entryHostId || 0);
      return resolveRuleEntryHost(hosts, entryHostId, tunnel?.entryHost || member?.host || null);
    }
    return member?.host || null;
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
    const parallel = normalizeForwardGroupModeForRule(group) === "port" && Number(group.entryGroupId || 0) > 0;
    const domain = String(group?.domain || (parallel ? entryDomainForForwardGroup(group) : "")).trim();
    if (domain) {
      pushUniqueEntryAddress(rows, getForwardGroupRouteLabel(group), domain);
      if (!parallel) return rows;
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
      if (rows.length > 0 && !parallel) return rows;
    }
    return rows;
  };

  const getForwardChainEntryAddresses = (group: any | null | undefined): EntryAddress[] => {
    if (!group) return [];
    const rows: EntryAddress[] = [];
    const entryGroup = isForwardChainGroup(group) && group.entryGroupId
      ? forwardGroupById.get(Number(group.entryGroupId)) || group.entryGroup
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
          toast.error(translateText("该转发链未配置可用入口地址"));
          return;
        }
        const text = formatAddressWithPort(entry, rule.sourcePort);
        try {
          await navigator.clipboard.writeText(text);
          toast.success(translateText("已复制入口地址: {0}", [text]));
        } catch {
          toast.error(translateText("复制失败，请手动复制"));
        }
        return;
      }
      const entry = String(entryValue || getForwardGroupEntryAddresses(group)[0]?.value || "").trim();
      if (!entry) {
        toast.error(translateText("该{0}未配置可用入口地址", [getForwardGroupRouteLabel(group)]));
        return;
      }
      const text = formatAddressWithPort(entry, rule.sourcePort);
      try {
        await navigator.clipboard.writeText(text);
        toast.success(translateText("已复制入口地址: {0}", [text]));
      } catch {
        toast.error(translateText("复制失败，请手动复制"));
      }
      return;
    }
    const entry = String(entryValue || getRuleEntry(rule)).trim();
    if (!entry) {
      toast.error(translateText("未获取到主机入口地址"));
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
      toast.success(translateText("已复制入口地址: {0}", [text]));
    } catch {
      toast.error(translateText("复制失败，请手动复制"));
    }
  };

  const renderResolvedStatusDot = (visual: ReturnType<typeof resolveForwardRuleVisualStatus>) => {
    if (visual.state === "running") {
      return <span title={visual.title} className="h-2.5 w-2.5 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />;
    }
    if (visual.state === "error") {
      return <span title={visual.title} className="h-2.5 w-2.5 rounded-full bg-destructive/70 shadow-sm shadow-destructive/40" />;
    }
    if (visual.state === "pending") {
      return <span title={visual.title} className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />;
    }
    return <span title={visual.title} className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />;
  };

  const renderStatusDot = (rule: any) => {
    const visual = ruleVisualStatuses.get(Number(rule.id))?.display || resolveRuleVisualStatus(rule);
    return renderResolvedStatusDot(visual);
  };

  const getRuleTransferDisplay = (rule: any) => {
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupRouteLabel = getForwardGroupRouteLabel(group);
    const groupEntry = isForwardChainGroup(group)
      ? (entryDomainForForwardGroup(group) || group?.members?.[0]?.entryAddress || "")
      : (group?.domain || group?.members?.[0]?.entryAddress || "");
    const chainEntryItems = isForwardChainGroup(group) ? getForwardChainEntryAddresses(group) : [];
    const groupEntryItems = rule.forwardGroupId && !isForwardChainGroup(group) ? getForwardGroupEntryAddresses(group) : [];
    const entryItems = rule.forwardGroupId
      ? (isForwardChainGroup(group) ? (chainEntryItems.length > 0 ? chainEntryItems : [{ label: translateText("转发链"), value: groupEntry }]) : (groupEntryItems.length > 0 ? groupEntryItems : [{ label: groupRouteLabel, value: groupEntry }]))
      : (getRuleEntries(rule).length > 0
        ? getRuleEntries(rule)
        : [{ label: translateText("入口"), value: "" }]);
    const resolvedEntryAddresses = filterRuleEntryAddressesForDisplay(entryItems)
      .filter((entry) => String(entry.value || "").trim())
      .map((entry) => ({
        ...entry,
        text: formatAddressWithPort(entry.value, rule.sourcePort),
        copyable: true,
      }));
    const entryAddresses = resolvedEntryAddresses.length > 0
      ? resolvedEntryAddresses
      : [{ label: translateText("入口"), value: "", text: translateText("入口地址暂不可用"), copyable: false }];
    const entryAddress = resolvedEntryAddresses.map((entry) => entry.text).join(" / ");
    const targetAddress = `${rule.targetIp}:${rule.targetPort}`;
    const entryTitle = rule.forwardGroupId
      ? translateText("复制{0}入口: {1}", [groupRouteLabel, entryAddress])
      : translateText("复制入口地址: {0}", [entryAddress]);
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
      ? "pearl-readout rounded-xl border border-border/50 px-2 py-1.5"
      : "pearl-readout rounded-xl border border-border/50 px-2.5 py-2";
    const labelClass = "mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground";
    const valueClass = compact
      ? "min-w-0 break-all text-[11px] leading-4"
      : "min-w-0 break-all text-xs leading-5";

    return (
      <div className="pearl-transfer min-w-0 space-y-1.5 font-mono text-xs">
        <div className={panelClass}>
          <div className={labelClass}>{translateText("入口")}</div>
          <div className="flex min-w-0 flex-col gap-1">
            {entryAddresses.map((entry) => (
              <button
                key={`${entry.label}:${entry.value}`}
                type="button"
                onClick={() => entry.copyable && copyEntryAddress(rule, entry.value)}
                disabled={!entry.copyable}
                className="group flex max-w-full min-w-0 items-start justify-between gap-1.5 rounded bg-muted/35 px-1.5 py-1 text-left transition-colors enabled:hover:bg-muted/70 disabled:cursor-default disabled:text-muted-foreground"
                title={entry.copyable ? `${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}` : entry.text}
              >
                <code className={valueClass}>{entry.text}</code>
                {entry.copyable && <Copy className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-center">
          <span aria-hidden="true" className="pearl-transfer-connector inline-flex h-5 w-5 items-center justify-center rounded-full border border-border/50 bg-card text-primary shadow-sm">
            <ArrowDownToLine className="h-3 w-3" />
          </span>
        </div>
        <div className={panelClass}>
          <div className={labelClass}>{translateText("出口")}</div>
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
            onClick={() => entry.copyable && copyEntryAddress(rule, entry.value)}
            disabled={!entry.copyable}
            className="group inline-flex min-w-0 max-w-full shrink items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-left transition-colors enabled:hover:bg-muted/70 disabled:cursor-default disabled:text-muted-foreground"
            title={entry.copyable ? `${entryTitle}${entryAddresses.length > 1 ? ` (${entry.label})` : ""}` : entry.text}
          >
            {entryAddresses.length > 1 && <span className="shrink-0 text-[10px] text-muted-foreground">{entry.label}</span>}
            <code className="min-w-0 truncate">{entry.text}</code>
            {entry.copyable && <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />}
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

  const renderForwardToolBadge = (rule: any, group?: any | null) => {
    const forwardType = group
      ? getForwardGroupRuleForwardType(group, rule.forwardType)
      : normalizeRuleForwardType(rule.forwardType);
    const label = forwardTypeDisplayLabel(forwardType);
    return (
      <Badge
        variant="outline"
        className={`h-5 min-w-0 w-fit whitespace-nowrap px-1.5 text-[10px] [&>svg]:shrink-0 ${forwardToolBadgeClass(forwardType)}`}
        title={translateText("转发工具：{0}", [label])}
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
        <span className="truncate">{label}</span>
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
        <AlertCircle className="mr-1 h-3 w-3" />{translateText("跨 IPv4/IPv6 风险")}</Badge>
    );
  };
  const renderRouteBadge = (rule: any, compactRow = false, badgesOnly = false) => {
    const tunnel = rule.forwardType === "gost" && rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    const group = rule.forwardGroupId ? forwardGroupById.get(Number(rule.forwardGroupId)) : null;
    const groupMode = normalizeForwardGroupModeForRule(group);
    const groupRouteLabel = getForwardGroupRouteLabel(group);
    const GroupRouteIcon = groupMode === "port" ? ArrowRightLeft : Layers3;
    const kernelWarning = getRuleKernelForwardWarning(rule);
    const warningBadge = renderKernelForwardWarningBadge(kernelWarning);
    const routeLabel = rule.forwardGroupId ? groupRouteLabel
      : tunnel ? getTunnelDisplay(tunnel, nginxTunnelEnabled).badgeLabel
      : forwardTypeDisplayLabel(rule.forwardType);
    const RouteIcon = rule.forwardGroupId ? GroupRouteIcon
      : tunnel || rule.forwardType === "gost" ? Network
      : rule.forwardType === "iptables" || rule.forwardType === "nftables" ? Shield
      : rule.forwardType === "socat" ? ArrowRightLeft : Zap;
    const badge = (
      <Badge
        variant="outline"
        title={routeLabel}
        className={`h-5 min-w-0 w-fit whitespace-nowrap px-1.5 text-[10px] ${
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
        <RouteIcon className="mr-1 h-3 w-3 shrink-0" /><span className="truncate">{routeLabel}</span>
      </Badge>
    );
    if (badgesOnly) return <>{badge}{!!rule.forwardGroupId && renderForwardToolBadge(rule, group)}</>;
    if (rule.forwardGroupId) {
      return (
        <div className={`flex min-w-0 items-center gap-1 ${compactRow ? "overflow-hidden" : "flex-wrap"}`}>
          {badge}
          {renderForwardToolBadge(rule, group)}
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

  const renderRuleCardMetadata = (rule: any) => {
    const tunnel = !rule.forwardGroupId && rule.forwardType === "gost" && rule.tunnelId ? tunnelById.get(Number(rule.tunnelId)) : null;
    return <RuleCardMetadata
      routeBadges={renderRouteBadge(rule, false, true)}
      protocol={formatForwardRuleProtocol(rule.protocol)}
      groupIds={rule.personalGroupIds}
      groups={personalGroupsQuery.data?.groups || []}
      path={tunnel ? renderTunnelRoute(tunnel, false) : null}
      warning={<>{renderKernelForwardWarningBadge(getRuleKernelForwardWarning(rule))}{!isRuleSupported(rule) && <Badge variant="outline" className="h-5 border-destructive/30 px-1.5 text-[10px] text-destructive">{protocolUnsupportedLabel(getRuleProtocolKey(rule))}{translateText(" 不支持")}</Badge>}</>}
    />;
  };

  const renderUnsupportedHint = (children: ReactNode, title = unsupportedProtocolTitle) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
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

  const renderRuleDailyTrafficValue = (rule: any, direction: "in" | "out") => (
    renderTrafficBytesValue(dailyTrafficByRule.get(rule.id), direction)
  );

  const renderMobileRuleTotalTraffic = (rule: any) => {
    const t = totalTrafficByRule.get(rule.id);
    const total = Number(t?.bytesIn || 0) + Number(t?.bytesOut || 0);
    if (!t || total <= 0) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
        title={translateText("累计入向 {0} / 出向 {1}", [formatBytes(Number(t.bytesIn || 0)), formatBytes(Number(t.bytesOut || 0))])}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
        {formatBytes(total)}
      </span>
    );
  };

  const renderRuleTotalTraffic = (rule: any) => {
    const t = totalTrafficByRule.get(rule.id);
    if (!t) {
      return <span className="text-xs text-muted-foreground">{translateText("累计 —")}</span>;
    }
    const total = Number(t.bytesIn || 0) + Number(t.bytesOut || 0);
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular-nums text-foreground"
        title={translateText("累计入向 {0} / 出向 {1}", [formatBytes(t.bytesIn), formatBytes(t.bytesOut)])}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />{translateText("累计 ")}{formatBytes(total)}
      </span>
    );
  };

  const renderTableRuleTotalTraffic = (rule: any) => (
    <div className="min-w-0 whitespace-nowrap text-xs">
      {renderRuleTotalTraffic(rule)}
    </div>
  );

  const renderTableRuleDailyTraffic = (rule: any) => (
    <div className="flex min-w-0 flex-col items-start gap-0.5 whitespace-nowrap text-xs leading-4">
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
    const t = stableProbeByRule.get(Number(rule.id));
    if (!t?.latestLatencyAt) return <span className="whitespace-nowrap text-xs text-muted-foreground">{translateText("未测试")}</span>;
    if (t.latestLatencyIsTimeout) {
      return <LatencyRating isTimeout timeoutText={translateText("超时")} className="whitespace-nowrap" />;
    }
    if (typeof t.latestLatencyMs === "number" && Number.isFinite(t.latestLatencyMs)) {
      return <LatencyRating latencyMs={t.latestLatencyMs} className="whitespace-nowrap" />;
    }
    return <span className="whitespace-nowrap text-xs text-muted-foreground">{translateText("未测试")}</span>;
  };

  const renderRuleActions = (rule: any) => {
    if (user?.role !== "admin" && isAdminManagedRule(rule)) {
      return <div className="flex items-center justify-end gap-1">
        <span className="text-[11px] text-muted-foreground">{translateText("仅可查看")}</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" title={translateText("查看流量和延迟")} onClick={() => setTrafficDetailRule({ id: rule.id, name: rule.name, isForwardChain: getRuleCategory(rule, forwardGroupById) === "chain", probeMethod: ruleLatencyProbeMethodForRule(rule) })}><Activity className="h-3.5 w-3.5" /></Button>
      </div>;
    }
    const supported = isRuleSupported(rule);
    if (!supported) {
      return (
        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => openEdit(rule)}
            title={translateText("编辑并切换到可用转发资源")}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => setDeleteRule(rule)}
            title={translateText("删除规则")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
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
          title={isForwardChainRule ? translateText("查看链路延迟") : probeMethod === "ping" ? translateText("查看 Ping 延迟") : translateText("查看 TCPing 延迟")}
        >
          <Activity className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setSelfTestRule({ id: rule.id, name: rule.name })}
          title={translateText("转发链路自测")}
        >
          <Stethoscope className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setResetTrafficTarget({ scope: "rule", rule })}
          disabled={resetTrafficMutation.isPending}
          title={resetTrafficMutation.isPending ? translateText("正在重置统计数据") : translateText("重置规则数据")}
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
    const selected = parseRuleResourceFilter(filterResource);
    if (next === "all" && selected.type) {
      setFilterResource("all");
      storeString(filterResourceStorageKey, "all");
    } else if (next !== "all" && selected.type !== next) {
      setFilterResource(next);
      storeString(filterResourceStorageKey, next);
      setRuleResourceMenuType(next);
    }
  };

  const handleFilterUserChange = (value: string) => {
    setCopyRuleIds([]);
    setShowCopyDialog(false);
    setShowDialog(false);
    setResetTrafficTarget(null);
    setFilterUser(value);
  };

  const handleFilterResourceChange = (value: string) => {
    const next = normalizeRuleResourceFilter(value);
    const parsed = parseRuleResourceFilter(next);
    setFilterResource(next);
    storeString(filterResourceStorageKey, next);
    if (parsed.type) {
      setRuleResourceMenuType(parsed.type);
      setRuleCategory(parsed.type);
    } else {
      setRuleCategory("all");
    }
    setRuleResourceMenuOpen(false);
  };

  const clearRuleFilters = () => {
    setRuleSearchQuery("");
    setRuleCategory("all");
    handleFilterResourceChange("all");
    if (user?.role === "admin") {
      setFilterUser("self");
    }
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

  const groupedRuleCardGridClass = effectiveRuleCardSize === "compact"
    ? "standard-card-grid-compact rule-card-grid-static rule-card-grid-static-compact gap-3"
    : "standard-card-grid rule-card-grid-static rule-card-grid-static-standard gap-4";
  const sortableRuleCardGridClass = effectiveRuleCardSize === "compact"
    ? "standard-card-grid-compact gap-3"
    : "standard-card-grid gap-4";
  const groupedRuleMobileGridClass = effectiveRuleCardSize === "compact"
    ? "grid rule-card-grid-static rule-card-grid-static-compact gap-2"
    : "grid rule-card-grid-static rule-card-grid-static-standard gap-3";
  const sortableRuleMobileGridClass = effectiveRuleCardSize === "compact"
    ? "grid gap-2"
    : "grid gap-3";
  const ruleContentModeKey = effectiveViewMode === "card" ? "card" : displayMode;
  const ruleContentTransitionKey = `${ruleCategory}-${ruleContentModeKey}-${isLoading ? "loading" : filteredRules.length > 0 ? "list" : "empty"}`;

  function renderRuleGroupIcon(type: RuleGroupType, className = "h-4 w-4") {
    if (type === "chain") return <GitBranch className={`${className} text-amber-600`} />;
    if (type === "group") return <Layers3 className={`${className} text-emerald-600`} />;
    if (type === "tunnel") return <Network className={`${className} text-chart-4`} />;
    return <ArrowRightLeft className={`${className} text-primary`} />;
  }

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

  const renderRuleTableCell = (rule: any, column: RuleTableColumnId) => {
    switch (column) {
      case "status": return <div className="flex justify-center">{isRuleSupported(rule) ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}</div>;
      case "name": {
        const warning = [!isRuleSupported(rule) && `${protocolUnsupportedLabel(getRuleProtocolKey(rule))}${translateText(" 当前不支持")}`, rule.protocolBlockReason || (rule.resourceAccessAllowed === false && revokedResourceTitle)].filter(Boolean).join(" · ");
        return <><span className="block truncate font-medium" title={rule.name}>{rule.name}</span>{warning && <span className="mt-1 block truncate text-[11px] leading-4 text-destructive" title={warning}>{warning}</span>}</>;
      }
      case "owner": return <span className="block truncate text-sm text-muted-foreground" title={getRuleOwnerName(rule)}>{getRuleOwnerName(rule)}</span>;
      case "resource": return <span className="block truncate text-sm text-muted-foreground" title={getRuleResourceName(rule)}>{getRuleResourceName(rule)}</span>;
      case "groups": return <RulePersonalGroupBadges groupIds={rule.personalGroupIds} groups={personalGroupsQuery.data?.groups || []} emptyPlaceholder />;
      case "entry": return renderTableTransferEntry(rule);
      case "exit": return renderTableTransferExit(rule);
      case "route": return renderRouteBadge(rule, true);
      case "protocol": return <Badge variant="secondary" className="max-w-full truncate whitespace-nowrap text-[10px]" title={formatForwardRuleProtocol(rule.protocol)}>{formatForwardRuleProtocol(rule.protocol)}</Badge>;
      case "total": return renderTableRuleTotalTraffic(rule);
      case "quota": return isAdminManagedRule(rule) ? <RuleUsageSummary rule={rule} totals={totalTrafficByRule.get(rule.id)} compact /> : <span className="text-muted-foreground">—</span>;
      case "daily": return renderTableRuleDailyTraffic(rule);
      case "latency": return renderTableRuleLatency(rule);
      case "enabled": return <div className="flex justify-center">{renderRuleEnabledSwitch(rule)}</div>;
      case "actions": return renderRuleActions(rule);
    }
  };

  const renderRuleTableRow = (rule: any, sortable?: RuleSortableRenderState) => {
    const supported = isRuleSupported(rule);
    return (
      <TableRow
        key={rule.id}
        {...(sortable?.itemProps || {})}
        className={cn(
          "group/sortable h-16 animate-in fade-in-0 duration-150",
          !supported && "opacity-70",
          sortable?.isDragging && "opacity-55",
          sortable?.isDropTarget && "bg-primary/5",
        )}
        title={!supported ? unsupportedProtocolTitle : undefined}
      >
        <TableCell className="w-[44px] px-2 py-2">
          {sortable && (
            <SortableDragHandle
              dragHandleProps={sortable.handleProps}
              visible={sortable.isDragging}
              busy={ruleReorderPending}
              className="mx-auto"
            />
          )}
        </TableCell>
        {tableLayout.columns.map(column => <TableCell key={column.id} className={cn("overflow-hidden px-3 py-2", ["status", "protocol", "enabled"].includes(column.id) && "text-center", column.id === "actions" && "text-right")}>
          {renderRuleTableCell(rule, column.id)}
        </TableCell>)}
      </TableRow>
    );
  };

  const renderRuleCard = (rule: any, sortable?: RuleSortableRenderState) => {
    const supported = isRuleSupported(rule);
    const protocolKey = getRuleProtocolKey(rule);
    if (effectiveRuleCardSize === "compact") {
      return (
        <Card
          key={rule.id}
          disableEnterAnimation
          interactive={supported && !sortable?.isDragging}
          {...(sortable?.itemProps || {})}
          className={cn(
            "group/sortable relative action-card border-border/40 bg-card/60 transition-[box-shadow,opacity]",
            !supported && "opacity-70",
            sortable?.isDragging && "opacity-55 ring-1 ring-primary/35",
            sortable?.isDropTarget && "ring-1 ring-primary/45",
          )}
          title={!supported ? unsupportedProtocolTitle : undefined}
        >
          <CardContent className="action-card-content space-y-2.5 p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <div className="mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{rule.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {getRuleResourceName(rule)}
                  </div>
                </div>
              </div>
              <RuleCardControls dragHandle={sortable && (
                <SortableDragHandle
                  dragHandleProps={sortable.handleProps}
                  visible={sortable.isDragging}
                  busy={ruleReorderPending}
                  className="h-6 w-6 bg-card/70"
                />
              )}>
                {renderRuleEnabledSwitch(rule)}
              </RuleCardControls>
            </div>

            <div className="min-w-0">
              {renderTransfer(rule, true)}
            </div>

            {renderRuleCardMetadata(rule)}

            {(rule.protocolBlockReason || rule.resourceAccessAllowed === false) && (
              <div className="line-clamp-2 text-[11px] leading-4 text-destructive">
                {rule.protocolBlockReason || revokedResourceTitle}
              </div>
            )}

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-t border-border/40 pt-1.5 text-xs">
              <div className="min-w-0">
                <div className="mb-0.5 flex h-4 items-center gap-1 text-[10px] text-muted-foreground">{translateText("累计流量")}<RuleUsageSummary rule={rule} totals={totalTrafficByRule.get(rule.id)} iconOnly /></div>
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

            <div className="action-card-footer flex justify-end border-t border-border/40 pt-1.5">
              {renderRuleActions(rule)}
            </div>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card
        key={rule.id}
        disableEnterAnimation
        interactive={supported && !sortable?.isDragging}
        {...(sortable?.itemProps || {})}
        className={cn(
          "group/sortable relative action-card border-border/40 bg-card/60 transition-[box-shadow,opacity]",
          !supported && "opacity-70",
          sortable?.isDragging && "opacity-55 ring-1 ring-primary/35",
          sortable?.isDropTarget && "ring-1 ring-primary/45",
        )}
        title={!supported ? unsupportedProtocolTitle : undefined}
      >
        <CardContent className="action-card-content space-y-3 p-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <div className="mt-2 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                {supported ? renderStatusDot(rule) : <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />}
              </div>
              <div className="min-w-0">
                <div className="truncate font-medium">{rule.name}</div>
                {user?.role === "admin" && (
                  <div className="mt-1 text-xs text-muted-foreground">{translateText("用户: ")}{getRuleOwnerName(rule)}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {getRuleResourceName(rule)}
                </div>
                {!supported && (
                  <div className="mt-1 text-[11px] text-destructive">
                    {protocolUnsupportedLabel(protocolKey)}{translateText(" 当前不支持")}</div>
                )}
                {(rule.protocolBlockReason || rule.resourceAccessAllowed === false) && (
                  <div className="mt-1 text-[11px] leading-4 text-destructive">
                    {rule.protocolBlockReason || revokedResourceTitle}
                  </div>
                )}
              </div>
            </div>
            <RuleCardControls dragHandle={sortable && (
              <SortableDragHandle
                dragHandleProps={sortable.handleProps}
                visible={sortable.isDragging}
                busy={ruleReorderPending}
                className="h-6 w-6 bg-card/70"
              />
            )}>
              {renderRuleEnabledSwitch(rule)}
            </RuleCardControls>
          </div>

          <div className="min-w-0">
            {renderTransfer(rule, true)}
          </div>
          {renderRuleCardMetadata(rule)}
          <div className="pearl-readout grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-border/40 p-2.5 text-xs">
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">{translateText("24H 入向")}</div>
              {renderRuleDailyTrafficValue(rule, "in")}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">{translateText("24H 出向")}</div>
              {renderRuleDailyTrafficValue(rule, "out")}
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex h-4 items-center gap-1 text-muted-foreground">{translateText("累计流量")}<RuleUsageSummary rule={rule} totals={totalTrafficByRule.get(rule.id)} iconOnly /></div>
              {renderMobileRuleTotalTraffic(rule)}
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-muted-foreground">{translateText("延迟")}</div>
              {renderLatestLatency(rule)}
            </div>
          </div>
          <div className="action-card-footer flex justify-end border-t border-border/40 pt-2">
            {renderRuleActions(rule)}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="pearl-page-header flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{translateText("转发规则")}</h1>
        </div>
        <div className="responsive-actions grid min-w-0 w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <Badge variant="outline" className="justify-center gap-1.5 px-3 py-1.5 text-xs">
            <Zap className="h-3 w-3 text-chart-2" />
            <AnimatedStatValue
              value={translateText("{0} / {1} 已启用", [activeCount, filteredRuleTotal])}
              loading={rulesHeaderLoading}
              cacheKey={`rules.header.active.${trafficTotalsCacheScope}`}
              fallbackValue={translateText("0 / 0 已启用")}
            />
          </Badge>
          <div className="hidden items-center overflow-hidden rounded-md border border-border/40 md:flex">
            <Button
              variant={displayMode === "compact" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("compact")}
              title={translateText("精简卡片")}
            >
              <Rows3 className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "standard" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("standard")}
              title={translateText("标准卡片")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("table")}
              title={translateText("列表")}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={displayMode === "globe" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              onClick={() => handleDisplayModeChange("globe")}
              title={translateText("3D 流量转发图")}
            >
              <Globe className="h-4 w-4" />
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={() => setResetTrafficTarget({ scope: "all" })}
            className="gap-2"
            disabled={ruleScopeTotal === 0 || resetTrafficMutation.isPending}
          >
            {resetTrafficMutation.isPending && resetTrafficTarget?.scope === "all"
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RotateCcw className="h-4 w-4" />}{translateText("重置数据")}</Button>
          <Button
            variant="outline"
            onClick={openCopyDialog}
            className="gap-2"
            disabled={!transferSourceRules.length && !canAdd}
            title={!transferSourceRules.length && !canAdd ? translateText("暂无可批量管理或导入的规则") : undefined}
          >
            <ClipboardCopy className="h-4 w-4" />{translateText("批量管理")}</Button>
          {rulePermissionLoading ? (
            <Button disabled className="col-span-2 gap-2 sm:col-span-1">
              <Loader2 className="h-4 w-4 animate-spin" />{translateText("权限加载中")}</Button>
          ) : canAdd ? (
            <Button
              onClick={() => openCreate()}
              className="col-span-2 gap-2 sm:col-span-1"
              disabled={!canCreateRule}
              title={!canCreateRule ? translateText("暂无可用转发资源") : undefined}
            >
              <Plus className="h-4 w-4" />{translateText("添加规则")}</Button>
          ) : (
            <Button disabled className="col-span-2 gap-2 sm:col-span-1" title={translateText("需要管理员授权后才能添加规则")}>
              <Plus className="h-4 w-4" />{translateText("添加规则")}</Button>
          )}
        </div>
      </div>

      {!canAdd && !rulePermissionLoading && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-700 dark:text-amber-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{translateText("当前账号没有添加转发规则的权限")}</span>
        </div>
      )}

      {(user?.role === "admin" || ruleScopeTotal > 0 || hasActiveRuleFilter || (rules && rules.length > 0)) && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{translateText("筛选：")}</span>
            </div>
            <div className="relative w-full sm:w-[260px] lg:w-[320px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={ruleSearchQuery}
                onChange={(event) => setRuleSearchQuery(event.target.value)}
                placeholder={translateText("搜索端口、IP、域名或备注")}
                className="h-8 w-full pl-8 pr-8 text-xs"
              />
              {ruleSearchQuery ? (
                <button
                  type="button"
                  aria-label={translateText("清空搜索")}
                  className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => setRuleSearchQuery("")}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {user?.role === "admin" && (
              <UserSelect value={filterUser} onValueChange={handleFilterUserChange} excludeUserId={user?.id}
                className="h-8 w-full text-xs sm:w-[180px]"
                specialOptions={[{ value: "self", label: translateText("我的规则") }, { value: "all", label: translateText("所有用户") }]} />
            )}
            <DropdownMenu open={ruleResourceMenuOpen} onOpenChange={setRuleResourceMenuOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 w-full justify-between px-3 text-xs font-normal sm:w-[190px]"
                >
                  {(() => {
                    const selected = parseRuleResourceFilter(filterResource);
                    if (!selected.type) return translateText("所有链路");
                    if (!selected.id) return translateText("全部{0}", [ruleTransferScopeLabels[selected.type]]);
                    const resource = getRuleFilterResources(selected.type).find((item: any) => Number(item.id) === selected.id);
                    return resource?.name || `${ruleTransferScopeLabels[selected.type]} #${selected.id}`;
                  })()}
                  <ChevronRight className="h-3.5 w-3.5 rotate-90 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[min(34rem,calc(100vw-2rem))] p-1">
                <div className="grid min-h-[13rem] grid-cols-[8.5rem_minmax(0,1fr)]">
                  <div className="border-r border-border/60 p-1">
                    <button
                      type="button"
                      onClick={() => handleFilterResourceChange("all")}
                      className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors ${filterResource === "all" ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />{translateText("全部")}</button>
                    {ruleTransferScopeOptions.map((option) => {
                      const Icon = option.value === "local" ? ArrowRightLeft : option.value === "tunnel" ? Network : option.value === "chain" ? GitBranch : Layers3;
                      const active = ruleResourceMenuType === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onMouseEnter={() => setRuleResourceMenuType(option.value)}
                          onFocus={() => setRuleResourceMenuType(option.value)}
                          onClick={() => setRuleResourceMenuType(option.value)}
                          className={`flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs transition-colors ${active ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {option.label}
                          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="min-w-0 p-1">
                    <button
                      type="button"
                      onClick={() => handleFilterResourceChange(ruleResourceMenuType)}
                      className={`flex h-8 w-full items-center rounded px-2 text-left text-xs font-medium transition-colors ${filterResource === ruleResourceMenuType ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                    >{translateText("全部")}{ruleTransferScopeLabels[ruleResourceMenuType]}
                    </button>
                    <div className="mt-1 max-h-64 overflow-y-auto">
                      {getRuleFilterResources(ruleResourceMenuType).length > 0 ? getRuleFilterResources(ruleResourceMenuType).map((resource: any) => {
                        const value = `${ruleResourceMenuType}:${Number(resource.id)}` as RuleResourceFilter;
                        const detail = ruleResourceMenuType === "tunnel"
                          ? getTunnelRouteText(resource, hosts || [])
                          : resource?.domain || resource?.displayRemark || resource?.remark || resource?.description || "";
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => handleFilterResourceChange(value)}
                            className={`flex min-h-9 w-full flex-col justify-center rounded px-2 text-left transition-colors ${filterResource === value ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                          >
                            <span className="truncate text-xs font-medium">{resource?.name || `${ruleTransferScopeLabels[ruleResourceMenuType]} #${resource?.id}`}</span>
                            {detail ? <span className="truncate text-[11px] text-muted-foreground">{detail}</span> : null}
                          </button>
                        );
                      }) : (
                        <div className="px-2 py-6 text-center text-xs text-muted-foreground">{translateText("暂无可筛选的")}{ruleTransferScopeLabels[ruleResourceMenuType]}</div>
                      )}
                    </div>
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <Select value={String(rulePageSize)} onValueChange={handleRulePageSizeChange}>
              <SelectTrigger className="h-8 w-full text-xs sm:w-[120px]">
                <SelectValue placeholder={translateText("每页数量")} />
              </SelectTrigger>
              <SelectContent>
                {RULE_PAGE_SIZE_OPTIONS.map((pageSize) => (
                  <SelectItem key={pageSize} value={String(pageSize)}>{translateText("每页 ")}{pageSize}{translateText(" 条")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Tabs value={ruleCategory} onValueChange={handleRuleCategoryChange}>
            <SlidingTabsList items={ruleCategoryItems} activeValue={ruleCategory} onValueChange={handleRuleCategoryChange} ariaLabel={translateText("转发规则分类")} minItemWidthRem={8.5} />
          </Tabs>
        </div>
      )}

      {/* 转发流量汇总 */}
      <div className="grid grid-cols-3 gap-1.5 sm:gap-4">
        <Card hoverable className="group relative overflow-hidden border-border/40 bg-card/60">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
          <CardContent className="relative flex min-w-0 items-center justify-between p-2 sm:gap-3 sm:p-4">
            <div className="w-full min-w-0 sm:flex-1">
              <p className="whitespace-nowrap text-[10px] text-muted-foreground sm:text-xs">{translateText("入向流量")}</p>
              <div className="mt-1 grid min-w-0 gap-0.5 sm:mt-0.5 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-2 sm:gap-y-1">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">
                    <span className="sm:hidden">{translateText("总")}</span>
                    <span className="hidden sm:inline">{translateText("累计")}</span>
                  </span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(totalTrafficTotals.bytesIn)}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.bytesIn`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesIn`, "rules.traffic.total.last.bytesIn"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesIn`, "rules.traffic.total.last.bytesIn"]}
                    fallbackValue="0 B"
                    className="min-w-0 whitespace-nowrap text-[10px] font-semibold tabular-nums sm:truncate sm:text-xl"
                  />
                </div>
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(dailyTrafficTotals.bytesIn)}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesIn`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesIn`, "rules.traffic.daily.last.bytesIn"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesIn`, "rules.traffic.daily.last.bytesIn"]}
                    fallbackValue="0 B"
                    className="min-w-0 whitespace-nowrap text-[9px] font-semibold tabular-nums text-foreground sm:truncate sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <ArrowDownToLine className="hidden h-6 w-6 shrink-0 text-chart-2 sm:block" />
          </CardContent>
        </Card>
        <Card hoverable className="group relative overflow-hidden border-border/40 bg-card/60">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
          <CardContent className="relative flex min-w-0 items-center justify-between p-2 sm:gap-4 sm:p-4">
            <div className="w-full min-w-0 sm:flex-1">
              <p className="whitespace-nowrap text-[10px] text-muted-foreground sm:text-xs">{translateText("出向流量")}</p>
              <div className="mt-1 grid min-w-0 gap-0.5 sm:mt-0.5 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-2 sm:gap-y-1">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">
                    <span className="sm:hidden">{translateText("总")}</span>
                    <span className="hidden sm:inline">{translateText("累计")}</span>
                  </span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(totalTrafficTotals.bytesOut)}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.bytesOut`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesOut`, "rules.traffic.total.last.bytesOut"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.bytesOut`, "rules.traffic.total.last.bytesOut"]}
                    fallbackValue="0 B"
                    className="min-w-0 whitespace-nowrap text-[10px] font-semibold tabular-nums sm:truncate sm:text-xl"
                  />
                </div>
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={formatBytes(dailyTrafficTotals.bytesOut)}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.bytesOut`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesOut`, "rules.traffic.daily.last.bytesOut"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.bytesOut`, "rules.traffic.daily.last.bytesOut"]}
                    fallbackValue="0 B"
                    className="min-w-0 whitespace-nowrap text-[9px] font-semibold tabular-nums text-foreground sm:truncate sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <ArrowUpFromLine className="hidden h-6 w-6 shrink-0 text-chart-4 sm:block" />
          </CardContent>
        </Card>
        <Card hoverable className="group relative overflow-hidden border-border/40 bg-card/60">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-[0.035] transition-opacity group-hover:opacity-[0.07]" />
          <CardContent className="relative flex min-w-0 items-center justify-between p-2 sm:gap-4 sm:p-4">
            <div className="w-full min-w-0 sm:flex-1">
              <p className="whitespace-nowrap text-[10px] text-muted-foreground sm:text-xs">{translateText("连接次数")}</p>
              <div className="mt-1 grid min-w-0 gap-0.5 sm:mt-0.5 sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-2 sm:gap-y-1">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">
                    <span className="sm:hidden">{translateText("总")}</span>
                    <span className="hidden sm:inline">{translateText("累计")}</span>
                  </span>
                  <AnimatedStatValue
                    as="span"
                    value={totalTrafficTotals.connections.toLocaleString(getFormatLocale())}
                    loading={totalTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.total.connections`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.connections`, "rules.traffic.total.last.connections"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.total.last.connections`, "rules.traffic.total.last.connections"]}
                    fallbackValue="0"
                    className="min-w-0 whitespace-nowrap text-[10px] font-semibold tabular-nums sm:truncate sm:text-xl"
                  />
                </div>
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-1 sm:inline-flex">
                  <span className="shrink-0 whitespace-nowrap text-[8px] font-medium uppercase text-muted-foreground sm:text-[10px]">24H</span>
                  <AnimatedStatValue
                    as="span"
                    value={dailyTrafficTotals.connections.toLocaleString(getFormatLocale())}
                    loading={dailyTrafficTotalsLoading}
                    cacheKey={`rules.traffic.${trafficTotalsCacheScope}.daily.connections`}
                    fallbackCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.connections`, "rules.traffic.daily.last.connections"]}
                    mirrorCacheKeys={[`rules.traffic.${trafficTotalsLastCacheScope}.daily.last.connections`, "rules.traffic.daily.last.connections"]}
                    fallbackValue="0"
                    className="min-w-0 whitespace-nowrap text-[9px] font-semibold tabular-nums text-foreground sm:truncate sm:text-xs"
                  />
                </div>
              </div>
            </div>
            <Activity className="hidden h-6 w-6 shrink-0 text-chart-3 sm:block" />
          </CardContent>
        </Card>
      </div>

      {isOwnRuleScope && <RuleGroupBar value={activePersonalGroupId} onChange={setPersonalGroupFilter} />}
      <RuleContentTransition transitionKey={ruleContentTransitionKey}>
      {isLoading || (!ruleStatusSnapshotReady && !hasCachedRuleStatus) ? (
        <DataSectionLoading label={isLoading ? translateText("正在加载转发规则") : translateText("正在加载规则状态")} />
      ) : filteredRules.length > 0 ? (
        <>
          {effectiveViewMode === "globe" ? (
            (!hosts || !tunnels || !forwardGroups) ? (
              <DataSectionLoading label={translateText("正在加载转发流量地图")} />
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
                        <RuleGroupItems open={!collapsed} className={groupedRuleCardGridClass}>
                          {group.rules.map((rule: any) => renderRuleCard(rule))}
                        </RuleGroupItems>
                      </section>
                    );
                  })}
                </AutoAnimateContainer>
              ) : (
                <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="rect">
                  <div className={sortableRuleCardGridClass}>
                    {pagedRules.map((rule: any) => (
                      <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled}>
                        {(sortable) => renderRuleCard(rule, ruleSortingEnabled ? sortable : undefined)}
                      </SortableItem>
                    ))}
                  </div>
                </SortableReorderContext>
              )}
            </RuleCardModeTransition>
          ) : (
            <>
              <RuleCardModeTransition mode={effectiveRuleCardSize} className="sm:hidden">
                {shouldGroupRuleCards ? (
                  <AutoAnimateContainer layout={false} className={groupedRuleMobileGridClass}>
                    {desktopRuleGroups.map((group) => {
                      const collapsed = !!ruleGroupCollapsed[group.type];
                      return (
                        <section key={group.type} className="space-y-2">
                          {renderRuleGroupHeader(group)}
                          <RuleGroupItems open={!collapsed} className={groupedRuleMobileGridClass}>
                            {group.rules.map((rule: any) => renderRuleCard(rule))}
                          </RuleGroupItems>
                        </section>
                      );
                    })}
                  </AutoAnimateContainer>
                ) : (
                  <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="vertical" restrictToList>
                    <div className={sortableRuleMobileGridClass}>
                      {pagedRules.map((rule: any) => (
                        <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled}>
                          {(sortable) => renderRuleCard(rule, ruleSortingEnabled ? sortable : undefined)}
                        </SortableItem>
                      ))}
                    </div>
                  </SortableReorderContext>
                )}
              </RuleCardModeTransition>
              <Card className="hidden border-border/40 bg-card/60 backdrop-blur-md sm:block">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table floatingScrollbar className="table-fixed" style={{
                      ...Object.fromEntries(tableLayout.columns.map(column => [`--list-col-${column.id}`, `${column.width}px`])),
                      width: `max(100%, calc(${["44px", ...tableLayout.columns.map(column => `var(--list-col-${column.id})`)].join(" + ")}))`,
                    } as CSSProperties}>
                      <colgroup>
                        <col className="w-[44px]" />
                        {tableLayout.columns.map(column => <col key={column.id} style={{ width: column.id === tableLayout.columns.at(-1)?.id ? undefined : `var(--list-col-${column.id})` }} />)}
                      </colgroup>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="sticky left-0 z-20 w-[44px] bg-card px-2 text-center" style={{ background: "color-mix(in srgb, var(--muted) 70%, var(--card))" }}>
                            <ListSettings columns={tableLayout.allColumns} layout={tableLayout.layout} onChange={tableLayout.setLayout} onReset={tableLayout.reset} />
                          </TableHead>
                          {tableLayout.columns.map(column => <TableHead key={column.id} className={cn("relative overflow-hidden whitespace-nowrap px-3 pr-4", ["status", "protocol", "enabled"].includes(column.id) && "text-center", column.id === "actions" && "text-right")}>
                            <span className="block truncate" title={translateText(column.label)}>{translateText(column.label)}</span>
                            <ColumnResizeHandle column={column} onResize={width => tableLayout.setLayout({ ...tableLayout.layout, widths: { ...tableLayout.layout.widths, [column.id]: width } })} onReset={() => {
                              const widths = { ...tableLayout.layout.widths };
                              delete widths[column.id];
                              tableLayout.setLayout({ ...tableLayout.layout, widths });
                            }} />
                          </TableHead>)}
                        </TableRow>
                      </TableHeader>
                      {shouldGroupRuleCards ? (
                        <TableBody>
                          {desktopRuleGroups.map((group) => {
                            const collapsed = !!ruleGroupCollapsed[group.type];
                            return (
                              <Fragment key={group.type}>
                                <TableRow className="border-border/40 bg-muted/35 hover:bg-muted/50">
                                  <TableCell colSpan={tableLayout.columns.length + 1} className="p-1">
                                    {renderRuleGroupHeader(group, true)}
                                  </TableCell>
                                </TableRow>
                                {!collapsed && group.rules.map((rule: any) => renderRuleTableRow(rule))}
                              </Fragment>
                            );
                          })}
                        </TableBody>
                      ) : (
                        <SortableReorderContext sortable={ruleSortable} ids={pagedRules.map((rule: any) => Number(rule.id))} strategy="vertical" restrictToList>
                          <TableBody>
                            {pagedRules.map((rule: any) => (
                              <SortableItem key={rule.id} id={Number(rule.id)} disabled={ruleSortable.disabled} itemKind="row">
                                {(sortable) => renderRuleTableRow(rule, ruleSortingEnabled ? sortable : undefined)}
                              </SortableItem>
                            ))}
                          </TableBody>
                        </SortableReorderContext>
                      )}
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
          <PersistentPagination pagination={rulePagination} itemName={translateText("条规则")} className="mt-5" />
        </>
      ) : (
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardContent className="p-0">
            {(rules && rules.length > 0) || ruleScopeTotal > 0 || hasActiveRuleFilter ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Filter className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-base font-medium">{translateText("没有匹配的规则")}</p>
                <p className="text-sm mt-1 text-muted-foreground/60">{translateText("尝试调整筛选条件")}</p>
                {hasActiveRuleFilter && (
                  <Button type="button" variant="outline" className="mt-4 gap-2" onClick={clearRuleFilters}>
                    <XCircle className="h-4 w-4" />{translateText("清除筛选")}</Button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                  <ArrowRightLeft className="h-8 w-8 opacity-40" />
                </div>
                <p className="text-lg font-medium">{translateText("暂无转发规则")}</p>
                <p className="text-sm mt-1 text-muted-foreground/60">
                  {canCreateRule
                    ? translateText("创建第一条转发规则")
                    : translateText("当前账号没有可用的转发资源")}
                </p>
                {canAdd && canCreateRule && (
                  <Button onClick={() => openCreate()} variant="outline" className="mt-4 gap-2">
                    <Plus className="h-4 w-4" />{translateText("创建第一条规则")}</Button>
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
        <DialogContent className="max-h-[96svh] w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-4 sm:max-w-2xl sm:p-5">
          <DialogHeader>
            <DialogTitle>{editingId ? translateText("编辑规则") : translateText("添加转发规则")}</DialogTitle>
            {!editingId && user?.role === "admin" && <DialogDescription>{translateText("新增规则归属：")}{ruleOperationOwnerLabel}</DialogDescription>}
          </DialogHeader>
          <div className="min-h-0 touch-pan-y scroll-pb-28 space-y-3 overflow-y-auto overscroll-contain pb-5 pr-1">
            <Tabs
              value={form.routeMode}
              onValueChange={(value) => setRouteMode(value as RuleRouteMode)}
              className="space-y-3"
            >
              <SlidingTabsList
                items={routeModeTabItems}
                activeValue={form.routeMode}
                onValueChange={setRouteMode}
                ariaLabel={translateText("转发规则类型")}
                minItemWidthRem={5.75}
              />
            </Tabs>

            <RuleRouteTransition
              transitionKey={`rule-route-${form.routeMode}-${isForwardGroupRouteMode ? "resource" : "direct"}`}
              className="space-y-3"
            >
              {form.routeMode === "tunnel" && (
                <div className="space-y-2 rounded-md border border-chart-4/20 bg-chart-4/5 p-2.5">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="space-y-2">
                      <Label>{translateText("使用隧道")}</Label>
                      <Select
                        value={form.tunnelId ? String(form.tunnelId) : undefined}
                        disabled={availableTunnels.length === 0}
                        onValueChange={(v) => {
                          const nextTunnelId = Number(v);
                          const tunnel = nextTunnelId ? tunnels?.find((t: any) => t.id === nextTunnelId) : null;
                          setForm({
                            ...form,
                            tunnelId: nextTunnelId,
                            hostId: tunnel ? tunnel.entryHostId : null,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={translateText("请选择隧道")} /></SelectTrigger>
                        <SelectContent>
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
                    <p className="text-xs text-amber-600">{translateText("暂无可用隧道，请先在链路管理中创建隧道。")}</p>
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
                      <Label>{form.routeMode === "local" ? (isLegacyLocalRuleEdit ? translateText("迁移到新版端口转发") : translateText("使用端口转发")) : form.routeMode === "chain" ? translateText("使用转发链") : translateText("使用转发组")}</Label>
                      <Select
                        value={form.forwardGroupId ? String(form.forwardGroupId) : undefined}
                        disabled={(form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).length === 0}
                        onValueChange={(v) => {
                          const nextGroupId = Number(v);
                          const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                          setForm({
                            ...form,
                            forwardGroupId: nextGroupId,
                            forwardType: getForwardGroupRuleForwardType(group, form.forwardType),
                            hostId: null,
                            tunnelId: null,
                            failoverEnabled: isForwardChainGroup(group) ? false : form.failoverEnabled,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={form.routeMode === "local" ? translateText("请选择端口转发") : form.routeMode === "chain" ? translateText("请选择转发链") : translateText("请选择转发组")} /></SelectTrigger>
                        <SelectContent>
                          {(form.routeMode === "local" ? availablePortForwardGroups : form.routeMode === "chain" ? availableForwardChainGroups : availableFailoverForwardGroups).map((group: any) => (
                            <SelectItem key={group.id} value={String(group.id)} textValue={getForwardGroupSelectText(group)}>
                              {renderForwardGroupSelectLabel(group)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Badge variant="outline" className="h-9 justify-center gap-1.5 border-emerald-500/30 px-3 text-emerald-600">
                      {form.routeMode === "local" ? <ArrowRightLeft className="h-3.5 w-3.5" /> : form.routeMode === "chain" ? <GitBranch className="h-3.5 w-3.5" /> : <Layers3 className="h-3.5 w-3.5" />}
                      {isLegacyLocalRuleEdit && !selectedForwardGroup ? translateText("待选择") : FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType}
                    </Badge>
                  </div>
                  {isLegacyLocalRuleEdit && form.routeMode === "local" && (
                    <p className="text-xs text-amber-600">{translateText("旧版端口转发规则需要选择新版端口转发，保存后会保留当前目标地址和端口配置。")}</p>
                  )}
                  {form.routeMode === "local" && availablePortForwardGroups.length === 0 && (
                    <p className="text-xs text-amber-600">{translateText("暂无可用端口转发，请先在链路管理中创建并启用。")}</p>
                  )}
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

              {form.routeMode === "local" && !isForwardGroupRouteMode && (
                <div className="space-y-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div className="space-y-2">
                      <Label>{translateText("使用按量计费资源")}</Label>
                      <Select
                        value={form.hostId ? String(form.hostId) : undefined}
                        disabled={availableTrafficBillingHosts.length === 0}
                        onValueChange={(v) => {
                          const nextHostId = Number(v);
                          latestPortCheckRef.current += 1;
                          setPortStatus("idle");
                          setPortRangeError(null);
                          setForm({
                            ...form,
                            hostId: nextHostId,
                            tunnelId: null,
                            forwardGroupId: null,
                          });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder={translateText("请选择按量计费资源")} /></SelectTrigger>
                        <SelectContent>
                          {availableTrafficBillingHosts.map((host: any) => (
                            <SelectItem key={host.id} value={String(host.id)} textValue={getHostOptionText(host)}>
                              {renderHostStatusLabel(host)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Badge variant="outline" className="h-9 justify-center gap-1.5 border-emerald-500/30 px-3 text-emerald-600">
                      <ArrowRightLeft className="h-3.5 w-3.5" />{translateText("按量计费")}</Badge>
                  </div>
                  {availableTrafficBillingHosts.length === 0 && (
                    <p className="text-xs text-amber-600">{translateText("暂无可用按量计费资源，请确认资源授权和余额。")}</p>
                  )}
                  {selectedHost && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {renderHostStatusLabel(selectedHost)}
                      <span className="rounded bg-background/60 px-1.5 py-0.5">{translateText("端口 ")}{sourcePortRangeText}</span>
                    </div>
                  )}
                </div>
              )}
            </RuleRouteTransition>
            <div className="grid min-w-0 grid-cols-2 gap-3 [&>*]:min-w-0">
              <div className="col-span-2 space-y-2 sm:col-span-1">
                <Label>{translateText("规则名称")}</Label>
                <Input
                  placeholder={translateText("例如: Web 服务转发")}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{translateText("协议")}</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(v) => setForm({
                    ...form,
                    protocol: v as any,
                    failoverEnabled: v === "tcp" ? form.failoverEnabled : false,
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
              {!isForwardGroupRouteMode && form.routeMode === "local" && (
                <div className="space-y-2">
                  <Label>{translateText("转发工具")}</Label>
                  {!routeModeLocked && form.routeMode === "local" ? (
                    <Select
                      value={form.forwardType}
                      onValueChange={(v) => setForm({
                        ...form,
                        forwardType: v as any,
                        gostMode: "direct" as const,
                        gostRelayHost: "",
                        gostRelayPort: 0,
                        tunnelId: null,
                      })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {usableForwardTypes.map((t) => (
                          <SelectItem key={t} value={t}>{FORWARD_TYPE_LABELS[t]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 text-sm">
                      <span className="truncate">{FORWARD_TYPE_LABELS[effectiveRouteForwardType] || effectiveRouteForwardType}</span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {isForwardGroupRouteMode ? translateText("上级决定") : translateText("已锁定")}
                      </Badge>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                <Label>{translateText("源端口")}</Label>
                  <span className="truncate text-xs text-muted-foreground" title={translateText("允许端口范围: {0}", [sourcePortRangeText])}>
                    {sourcePortRangeText}
                  </span>
                </div>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input
                      type="text"
                      pattern="[0-9]*"
                      placeholder={isForwardGroupRouteMode ? translateText("例如 8080") : translateText("0=随机")}
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
                        <span className="truncate">{portStatusHint?.text || translateText("不可用")}</span>
                      </div>
                    )}
                    {portStatus === "available" && (
                      <div className="absolute right-2.5 top-1/2 inline-flex max-w-[5.5rem] -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-emerald-600" title={portStatusHint?.title}>
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{portStatusHint?.text || translateText("可用")}</span>
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    onClick={handleRandomPort}
                    title={translateText("随机分配端口")}
                    disabled={isForwardGroupRouteMode ? !form.forwardGroupId : !form.hostId}
                  >
                    <Shuffle className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{translateText("目标地址")}</Label>
                <Input
                  placeholder={translateText("例如: 10.0.0.1 或 example.com")}
                  value={form.targetIp}
                  onChange={(e) => setForm({ ...form, targetIp: e.target.value })}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.9fr)] sm:items-end">
                  <div className="space-y-2">
                    <Label>{translateText("目标端口 ")}<span className="text-destructive">*</span></Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
                      placeholder={translateText("例如: 80")}
                      value={form.targetPort || ""}
                      onChange={(e) => setForm({ ...form, targetPort: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="flex min-h-10 flex-col gap-2 rounded-md bg-muted/35 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">{translateText("异常通知")}</Label>
                    </div>
                    <HintSwitch
                      aria-label={translateText("异常通知")}
                      hint={telegramBotReady ? translateText("规则运行异常时提醒已绑定所选通知渠道的管理员。") : translateText("请先在系统设置中配置并启用所选通知渠道。")}
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
            {showMainBackupConfig && (
            <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Label className="text-sm">{translateText("出站策略")}</Label>
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
                    <Label>{translateText("备用出站（每行一个，最多 10 个）")}</Label>
                    <Textarea
                      value={form.failoverTargetsText}
                      onChange={(event) => setForm({ ...form, failoverTargetsText: event.target.value })}
                      placeholder={"10.0.0.1:80\nexample.com:443"}
                      className="min-h-24 font-mono text-sm"
                      spellCheck={false}
                    />
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 [&>*]:min-w-0">
                    <div className="space-y-2">
                      <Label>{translateText("切换时间（秒）")}</Label>
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
                      <Label>{translateText("恢复观察（秒）")}</Label>
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
                      <div className="col-span-2 flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/55 px-2.5 py-2 sm:col-span-1">
                        <div>
                          <Label className="text-sm">{translateText("恢复后切回")}</Label>
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
            )}
            {(editingId ? editingRuleOwnerId === Number(user?.id) : !createOwnerUserId || createOwnerUserId === Number(user?.id)) && <RuleGroupMultiSelect value={formGroupIds} onChange={setFormGroupIds} />}
            {user?.role === "admin" && <RuleLimitsForm key={`${showDialog}-${editingId}`} value={form.limits} onChange={limits => setForm(prev => ({ ...prev, limits }))} />}
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-background/95 pt-3">
            <Button variant="outline" onClick={() => setShowDialog(false)}>{translateText("取消")}</Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending || !form.name || (!isForwardGroupRouteMode && !form.hostId) || !form.targetIp || !form.targetPort || portStatus === "used" || (form.routeMode === "local" && !canUseLocalForward) || (form.routeMode === "tunnel" && !form.tunnelId) || (isForwardGroupRouteMode && !form.forwardGroupId) || (form.failoverEnabled && form.protocol !== "tcp")}
            >
              {isPending ? translateText("处理中...") : editingId ? translateText("保存") : translateText("创建")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="h-5 w-5" />
              {translateText("导出规则")}
            </DialogTitle>
            <DialogDescription>{translateText("选择范围后导出规则")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              <div className="space-y-2">
                <Label>{translateText("类型")}</Label>
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
            {renderExportFormatPicker()}
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {exportResourceId
                ? translateText("将导出 {0} 条{1}规则", [exportableRules.length, ruleTransferScopeLabels[exportScopeType]])
                : translateText("请选择{0}", [ruleTransferScopeLabels[exportScopeType]])}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowExportDialog(false)}>
              {translateText("取消")}
            </Button>
            <Button type="button" onClick={handleExportRules} disabled={!exportResourceId || exportableRules.length === 0}>
              {translateText("确定导出")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showImportDialog}
        onOpenChange={(open) => {
          if (importingRules && !ruleTaskEnqueued) return;
          setShowImportDialog(open);
          if (!open && !importingRules) resetImportDialog();
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              {translateText("导入规则")}
            </DialogTitle>
            <DialogDescription>{translateText("选择范围和规则文件后导入")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
              <div className="space-y-2">
                <Label>{translateText("类型")}</Label>
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
                    {importRuleTransferScopeOptions.map((option) => (
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
                showStatus: true,
                stackedList: true,
              })}
            </div>
            <div className="space-y-2">
              <Label>{translateText("规则文件")}</Label>
              <Input key={importFileInputKey} type="file" accept=".json,.jsonl,.ndjson,.txt,application/json,text/plain" onChange={handleImportFileChange} />
              <p className="text-xs text-muted-foreground">{translateText("支持 JSON 规则、逐行端口文本及 ny 导出")}</p>
            </div>
            {renderImportPortInput()}
            {renderNyanpassImportOptions()}
            {isNyanpassImport && <NyanpassImportPreview rules={importValidation.rules} />}
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
            <Button type="button" variant="outline" onClick={() => setShowImportDialog(false)} disabled={importingRules && !ruleTaskEnqueued}>
              {translateText(ruleTaskEnqueued ? "后台执行" : "取消")}
            </Button>
            <Button type="button" onClick={handleImportRules} disabled={!importValidation.ok || importingRules}>
              {importingRules && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {translateText("导入")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showCopyDialog} onOpenChange={(open) => (!copyActionPending || ruleTaskEnqueued) && setShowCopyDialog(open)}>
        <DialogContent className={cn("grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden sm:max-w-[640px]", isBatchGroupMode && "h-[min(720px,85svh)]")}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCopy className="h-5 w-5" />{translateText("批量管理转发规则")}</DialogTitle>
            <DialogDescription>{translateText("复制或导入归属：")}{ruleOperationOwnerLabel}{translateText("；编辑不改变归属。")}</DialogDescription>
            <div className={cn(segmentedControlClassName, "!mt-3")}>
              <div className="grid grid-cols-2 gap-1">
                {batchCategories.map(({ value, label, icon: Icon }) => {
                  const nextMode = ruleBatchModes(value, isOwnRuleScope).find((mode) => ruleBatchModeAvailable(mode, batchAccess));
                  const disabled = copyActionPending || !nextMode;
                  return <button key={value} type="button" className={routeModeOptionClass(batchCategory === value, disabled)} aria-pressed={batchCategory === value} disabled={disabled} onClick={() => {
                    if (batchCategory !== value && nextMode) switchCopyManageMode(nextMode);
                  }}>
                    <Icon className="h-4 w-4 shrink-0" /><span className="truncate">{label}</span>
                  </button>;
                })}
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 pt-2 text-left">
              <Label htmlFor="batch-manage-operation" className="shrink-0">{translateText("操作方式")}</Label>
              <Select value={copyManageMode} onValueChange={(mode) => switchCopyManageMode(mode as RuleBatchManageMode)} disabled={copyActionPending}>
                <SelectTrigger id="batch-manage-operation" className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ruleBatchModes(batchCategory, isOwnRuleScope).map((mode) => <SelectItem key={mode} value={mode} disabled={!ruleBatchModeAvailable(mode, batchAccess)}>{batchModeLabels[mode]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </DialogHeader>
          <div ref={copyBodyRef} className="min-h-0 touch-pan-y space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
            {batchSteps.length > 1 && <div className="flex items-center justify-between gap-2 text-sm font-medium">
              <span>{batchStepLabels[batchSteps[batchStep - 1]]}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{batchStep} / {batchSteps.length}</span>
            </div>}
            {batchStep > 1 && !isBatchImportMode && batchSelectionSummary}
            {batchStep > 1 && isBatchImportMode && <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <span>{translateText("待导入 {0} 条规则", [importValidation.rules.length])}</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" disabled={copyActionPending} onClick={() => setBatchStep(1)}>{translateText("修改内容")}</Button>
            </div>}

            {batchIsFinalStep && (isBatchCopyMode || isBatchImportMode) ? (
              <div className="space-y-3">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-lg border border-border/60 p-3 text-sm">
                  <dt className="text-muted-foreground">{translateText("操作")}</dt><dd>{isBatchImportMode ? translateText("批量导入") : translateText("批量复制")}</dd>
                  <dt className="text-muted-foreground">{translateText("所属用户")}</dt><dd className="break-words">{ruleOperationOwnerLabel}</dd>
                  <dt className="text-muted-foreground">{translateText("目标资源")}</dt>
                  <dd className="min-w-0 space-y-1 break-words">
                    {isBatchImportMode ? (selectedImportResource ? getTransferResourceLabel(importScopeType, selectedImportResource) : translateText("请选择目标资源"))
                      : <>{selectedCopyTargetResources.slice(0, 4).map((resource: any) => <p key={resource.id}>{getTransferResourceLabel(copyTargetScopeType, resource)}</p>)}{selectedBatchTargetCount > 4 && <p className="text-xs text-muted-foreground">{translateText("共 {0} 个目标", [selectedBatchTargetCount])}</p>}</>}
                  </dd>
                  <dt className="text-muted-foreground">{translateText("预计新增")}</dt><dd className="tabular-nums">{translateText("{0} 条规则", [isBatchImportMode ? importValidation.rules.length : selectedBatchRuleCount * selectedBatchTargetCount])}</dd>
                  {!isBatchImportMode && <><dt className="text-muted-foreground">{translateText("端口冲突处理")}</dt><dd>{copyConflictStrategy === "auto" ? translateText("自动分配新端口") : copyConflictStrategy === "skip" ? translateText("跳过冲突规则") : translateText("遇到冲突时报错")}</dd></>}
                </dl>
                {isBatchImportMode ? <>
                  {renderNyanpassImportOptions()}
                  {isNyanpassImport && <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer">{translateText("查看导入预览")}</summary><div className="mt-3"><NyanpassImportPreview rules={importValidation.rules} /></div></details>}
                  <p role={!importValidation.ok ? "alert" : undefined} className={cn("text-xs leading-5", importValidation.ok ? "text-muted-foreground" : "text-destructive")}>{importValidation.message}</p>
                </> : <p className="text-xs leading-5 text-muted-foreground">{translateText("复制会保留原规则基础配置，并按当前选择的目标资源生成副本。")}</p>}
              </div>
            ) : isBatchOperateMode ? (
              <div className="space-y-3">
                {batchRuleSelectionPanel}
                  <p className="text-xs leading-5 text-muted-foreground">{translateText("重启会重新下发已启用规则，已暂停规则保持暂停，不清空统计。")}</p>
                  {copyWorking && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{translateText("处理中...")}</div>}
              </div>
            ) : isBatchGroupMode ? <RuleGroupBulkEditor editor={batchGroupEditor} /> : isBatchImportMode ? (
              <>
              <div className="space-y-3">
                {batchStep === 1 && <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-40 space-y-1">
                      <Label>{translateText("导入文件")}</Label>
                      <div className="text-xs text-muted-foreground">{translateText("支持从文件导入，或手动输入目标地址与端口后批量导入。")}</div>
                    </div>
                    <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                      <span>{translateText("待导入")}</span>
                      <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{importValidation.rules.length}</span>
                    </div>
                  </div>
                  <div className={segmentedControlClassName}>
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        className={routeModeOptionClass(importSourceMode === "file", importingRules)}
                        aria-pressed={importSourceMode === "file"}
                        onClick={() => {
                          if (importSourceMode === "file") return;
                          setImportSourceMode("file");
                          setImportRetryState(null);
                          setImportManualText("");
                        }}
                        disabled={importingRules}
                      >
                        <Upload className="h-4 w-4 shrink-0" />
                        <span className="truncate">{translateText("文件导入")}</span>
                      </button>
                      <button
                        type="button"
                        className={routeModeOptionClass(importSourceMode === "manual", importingRules)}
                        aria-pressed={importSourceMode === "manual"}
                        onClick={() => {
                          if (importSourceMode === "manual") return;
                          setImportSourceMode("manual");
                          setImportRetryState(null);
                          setImportFile(null);
                          setImportFileName("");
                          setImportFileError("");
                          setImportFileInputKey((key) => key + 1);
                        }}
                        disabled={importingRules}
                      >
                        <Pencil className="h-4 w-4 shrink-0" />
                        <span className="truncate">{translateText("手动输入")}</span>
                      </button>
                      <button type="button" className={routeModeOptionClass(importSourceMode === "nyanpass", importingRules)} aria-pressed={importSourceMode === "nyanpass"}
                        onClick={() => {setImportSourceMode("nyanpass");setImportRetryState(null);setImportManualText("");setImportFile(null);setImportFileError("");setImportNyanpassAcknowledged(false);}} disabled={importingRules}>
                        <span className="whitespace-normal leading-4">{translateText("ny（实验性）")}</span>
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{importSourceMode === "file" ? translateText("规则文件") : importSourceMode === "nyanpass" ? translateText("ny 导出内容（逐行 JSON）") : translateText("目标地址列表")}</Label>
                    {importSourceMode === "file" ? (
                      <><Input key={importFileInputKey} type="file" accept=".json,.jsonl,.ndjson,.txt,application/json,text/plain" onChange={handleImportFileChange} />
                        <p className="text-xs text-muted-foreground">{translateText("支持 JSON 规则、逐行端口文本及 ny 导出")}</p></>
                    ) : (
                      <Textarea
                        value={importManualText}
                        onChange={(event) => { setImportManualText(event.target.value); setImportRetryState(null); }}
                        placeholder={importSourceMode === "nyanpass" ? translateText("粘贴 ny 批量导出的内容，每行一条 JSON") : translateText("每行一条，监听端口可省略：\n10001:example.com:443\n10002:10.0.0.8:8080\n10003:[2408:xxxx::1]:8443\nexample.com:443")}
                        className="min-h-[7.5rem] resize-y"
                      />
                    )}
                  </div>
                  {renderImportPortInput()}
                  {renderNyanpassImportOptions(false)}
                  {importSourceMode === "file" && importFileName && <p className="break-words text-xs text-muted-foreground">{importFileName}</p>}
                  {(importSourceMode === "file" || importFileName || importFileError || importValidation.ok || importPortText.trim() || String(importManualText || "").trim()) && (
                    <div
                      className={`rounded-md border px-3 py-2 text-sm ${
                        batchImportSourceReady
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : importFileName || importFileError || importPortText.trim() || String(importManualText || "").trim()
                            ? "border-destructive/30 bg-destructive/10 text-destructive"
                            : "border-border/60 bg-muted/30 text-muted-foreground"
                      }`}
                    >
                      {batchImportSourceReady ? translateText("已识别 {0} 条规则", [importValidation.rules.length]) : importValidation.message}
                    </div>
                  )}
                  {isNyanpassImport && <NyanpassImportPreview rules={importValidation.rules} />}
                  {!isNyanpassImport && importValidation.rules.length > 0 && (
                    <div className="space-y-2 rounded-md border border-border/60 p-2">
                      {importValidation.rules.map((rule, index) => (
                        <div key={`${rule.name}-${rule.sourcePort}-${index}`} className="rounded-md border border-border/40 bg-background/70 px-3 py-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <ArrowRightLeft className="h-3.5 w-3.5 text-primary" />
                            <span className="min-w-0 truncate text-sm font-medium">{rule.name}</span>
                            <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">{formatForwardRuleProtocol(rule.protocol)}</Badge>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {rule.sourcePort > 0 ? `:${rule.sourcePort}` : translateText("随机端口")} -&gt; {rule.targetIp}:{rule.targetPort} / {forwardTypeDisplayLabel(rule.forwardType)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>}

                {batchStep === 2 && <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-40 space-y-1">
                      <Label>{translateText("导入目标")}</Label>
                      <div className="text-xs text-muted-foreground">{translateText("选择要导入到哪个端口转发、隧道、转发链或转发组。")}</div>
                    </div>
                    <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      <span>{translateText("已选择")}</span>
                      <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedImportResource ? 1 : 0}</span>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <Select
                      value={importScopeType}
                      onValueChange={(value) => {
                        setImportScopeType(value as RuleTransferScopeType);
                        setImportResourceId("");
                        setImportResourceSearch("");
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {importRuleTransferScopeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={importResourceSearch}
                        onChange={(event) => setImportResourceSearch(event.target.value)}
                        placeholder={translateText("查找{0}", [ruleTransferScopeLabels[importScopeType]])}
                        className="h-9 pl-8 pr-8 text-xs"
                      />
                      {importResourceSearch ? (
                        <button
                          type="button"
                          aria-label={translateText("清空导入目标查找")}
                          className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setImportResourceSearch("")}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {filteredImportResources.length}{translateText(" 项")}</span>
                  </div>
                  <div className="space-y-2 rounded-md border border-border/60 p-2">
                    {filteredImportResources.length > 0 ? filteredImportResources.map((resource: any) => {
                      const selected = String(resource.id) === importResourceId;
                      return (
                        <button
                          key={resource.id}
                          type="button"
                          title={getTransferResourceLabel(importScopeType, resource)}
                          aria-pressed={selected}
                          onClick={() => setImportResourceId(String(resource.id))}
                          className={`flex w-full min-w-0 items-start gap-3 rounded-md border p-2 text-left transition-colors hover:bg-muted/40 ${
                            selected
                              ? "border-emerald-500/50 bg-emerald-500/5 shadow-sm"
                              : "border-border/40 bg-background/70"
                          }`}
                        >
                          {selected ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          ) : (
                            <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-border/70 bg-background" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1">{renderTransferResourceOption(importScopeType, resource, { showStatus: true })}</span>
                        </button>
                      );
                    }) : (
                      <div className="py-10 text-center text-sm text-muted-foreground">{translateText("没有可选择的")}{ruleTransferScopeLabels[importScopeType]}</div>
                    )}
                  </div>
                  <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                    {selectedImportResource
                      ? translateText("将导入到 {0}", [getTransferResourceLabel(importScopeType, selectedImportResource)])
                      : translateText("请选择{0}", [ruleTransferScopeLabels[importScopeType]])}
                  </div>
                  {batchImportTargetError && <p role="alert" className="text-xs text-destructive">{batchImportTargetError}</p>}
                </div>}
              </div>
              {batchStep === 2 && importSourceMode === "file" && (
                <p className="text-xs leading-5 text-muted-foreground">{translateText("导入会保留文件中的规则配置，并应用到所选目标资源。")}</p>
              )}
              </>
            ) : (
            <>
            <div className="space-y-3">
              {isBatchExportMode && <div className="border-b border-border/60 pb-3">{renderExportFormatPicker()}</div>}
              {(batchStep === 1 || isBatchExportMode) && batchRuleSelectionPanel}

              {batchStep === 2 && <div className="space-y-3">
                {isBatchEditMode ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-40 space-y-1">
                      <Label>{translateText("批量编辑内容")}</Label>
                      <div className="text-xs text-muted-foreground">{translateText("入口资源和目标地址可独立替换；未填写的项会保留每条规则原来的值。")}</div>
                    </div>
                    <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                      {hasBatchEditChanges ? translateText("按填写项替换") : translateText("未设置替换项")}
                    </div>
                  </div>

                  <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-sm">{translateText("替换入口资源")}</Label>
                      <span className="text-xs text-muted-foreground">
                        {hasBatchEditRouteSelection ? translateText("已设置新入口") : translateText("保持原入口")}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <Label>{translateText("入口类型")}</Label>
                      <Select
                        value={batchEditForm.routeMode}
                        onValueChange={(value) => setBatchEditRouteMode(value as RuleRouteMode)}
                        disabled={copyActionPending}
                      >
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="local" disabled={!canUseSavedLocalForward}>{translateText("端口转发")}</SelectItem>
                          <SelectItem value="tunnel" disabled={!canUseGost}>{translateText("隧道转发")}</SelectItem>
                          <SelectItem value="chain" disabled={!canUseForwardChain}>{translateText("转发链")}</SelectItem>
                          <SelectItem value="group" disabled={!canUseFailoverGroup}>{translateText("转发组")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {batchEditForm.routeMode === "tunnel" ? (
                      <div className="space-y-2">
                        <Label>{translateText("使用隧道")}</Label>
                        <Select
                          value={batchEditForm.tunnelId ? String(batchEditForm.tunnelId) : "none"}
                          disabled={copyActionPending}
                          onValueChange={(value) => {
                            setBatchEditForm((prev) => ({
                              ...prev,
                              tunnelId: value === "none" ? null : Number(value),
                              forwardGroupId: null,
                              forwardType: "gost",
                            }));
                          }}
                        >
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{translateText("不替换入口")}</SelectItem>
                            {supportedTunnels.map((tunnel: any) => (
                              <SelectItem key={tunnel.id} value={String(tunnel.id)} textValue={getTunnelSelectText(tunnel)}>
                                {renderTunnelSelectLabel(tunnel)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedBatchEditTunnel && (
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {renderTunnelRoute(selectedBatchEditTunnel, true)}
                            <code className="rounded bg-background/60 px-1.5 py-0.5">:{selectedBatchEditTunnel.listenPort}</code>
                            <span className="rounded bg-background/60 px-1.5 py-0.5">{selectedBatchEditTunnelDisplay.shortLabel}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label>{batchEditForm.routeMode === "local" ? translateText("使用端口转发") : batchEditForm.routeMode === "chain" ? translateText("使用转发链") : translateText("使用转发组")}</Label>
                        <Select
                          value={batchEditForm.forwardGroupId ? String(batchEditForm.forwardGroupId) : "none"}
                          disabled={copyActionPending}
                          onValueChange={(value) => {
                            const nextGroupId = value === "none" ? null : Number(value);
                            const group = nextGroupId ? forwardGroupById.get(nextGroupId) : null;
                            setBatchEditForm((prev) => ({
                              ...prev,
                              forwardGroupId: nextGroupId,
                              tunnelId: null,
                              forwardType: getForwardGroupRuleForwardType(group, prev.forwardType),
                            }));
                          }}
                        >
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{translateText("不替换入口")}</SelectItem>
                            {batchEditAvailableGroups.map((group: any) => (
                              <SelectItem key={group.id} value={String(group.id)} textValue={getForwardGroupSelectText(group)}>
                                {renderForwardGroupSelectLabel(group)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedBatchEditForwardGroup && (
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {(selectedBatchEditForwardGroup.members || []).slice(0, 4).map((member: any, index: number) => (
                              <span key={member.id} className="rounded bg-background/60 px-1.5 py-0.5">
                                {index + 1}. {getForwardGroupMemberLabel(member)}
                              </span>
                            ))}
                            {(selectedBatchEditForwardGroup.members || []).length > 4 && <span>+{(selectedBatchEditForwardGroup.members || []).length - 4}</span>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-sm">{translateText("替换目标地址")}</Label>
                      <span className="text-xs text-muted-foreground">
                        {hasBatchEditTargetIpChange || hasBatchEditTargetPortChange ? translateText("按填写项替换") : translateText("保持原目标")}
                      </span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{translateText("目标地址")}</Label>
                        <Input
                          placeholder={translateText("留空则保持原目标地址")}
                          value={batchEditForm.targetIp}
                          onChange={(event) => setBatchEditForm((prev) => ({ ...prev, targetIp: event.target.value }))}
                          disabled={copyActionPending}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{translateText("目标端口")}</Label>
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          step={1}
                          placeholder={translateText("留空则保持原目标端口")}
                          value={batchEditForm.targetPort || ""}
                          onChange={(event) => setBatchEditForm((prev) => ({ ...prev, targetPort: parseInt(event.target.value) || 0 }))}
                          disabled={copyActionPending}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>{translateText("端口冲突处理")}</Label>
                    <Select value={copyConflictStrategy} onValueChange={(value) => setCopyConflictStrategy(value as any)} disabled={!hasBatchEditRouteSelection}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="skip">{translateText("跳过冲突规则")}</SelectItem>
                        <SelectItem value="auto">{translateText("自动分配新端口")}</SelectItem>
                        <SelectItem value="error">{translateText("遇到冲突时报错")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{translateText("仅在替换入口资源且原源端口冲突时生效。")}</p>
                  </div>
                </div>
                ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-40 space-y-1">
                      <Label>{translateText("复制目标")}</Label>
                      <div className="text-xs text-muted-foreground">{translateText("可同时选择多个")}{copyTargetScopeLabel}{translateText("；搜索仅筛选显示，不会取消已选目标。")}</div>
                    </div>
                    <div className="inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      <span>{translateText("已选目标")}</span>
                      <span className="rounded-full bg-background/90 px-2 py-0.5 tabular-nums">{selectedBatchTargetCount}</span>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                    <Select
                      value={copyTargetScopeType}
                      disabled={copyActionPending}
                      onValueChange={(value) => {
                        commitCopyTargetSelection(value as RuleTransferScopeType, []);
                        setCopyTargetSearch("");
                      }}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ruleTransferScopeOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={copyTargetSearch}
                        onChange={(event) => setCopyTargetSearch(event.target.value)}
                        placeholder={translateText("查找") + copyTargetScopeLabel}
                        className="h-9 pl-8 pr-8 text-xs"
                        disabled={copyActionPending}
                      />
                      {copyTargetSearch ? (
                        <button
                          type="button"
                          aria-label={translateText("清空目标查找")}
                          className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => setCopyTargetSearch("")}
                          disabled={copyActionPending}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{translateText("端口冲突处理")}</Label>
                    <Select value={copyConflictStrategy} onValueChange={(value) => setCopyConflictStrategy(value as any)} disabled={copyActionPending}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="skip">{translateText("跳过冲突规则")}</SelectItem>
                        <SelectItem value="auto">{translateText("自动分配新端口")}</SelectItem>
                        <SelectItem value="error">{translateText("遇到冲突时报错")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        const visibleTargetIds = filteredCopyTargetResources.map((resource: any) => Number(resource.id));
                        const visibleTargetIdSet = new Set(visibleTargetIds);
                        const current = copyTargetSelectionRef.current;
                        const renderedScopeType = copyTargetScopeType;
                        const currentIds = current.scopeType === renderedScopeType ? current.resourceIds : [];
                        const visibleSelected = visibleTargetIds.length > 0
                          && visibleTargetIds.every((id) => currentIds.includes(id));
                        const nextIds = visibleSelected
                          ? currentIds.filter((id) => !visibleTargetIdSet.has(id))
                          : Array.from(new Set([...currentIds, ...visibleTargetIds]));
                        commitCopyTargetSelection(renderedScopeType, nextIds);
                      }}
                      disabled={filteredCopyTargetResources.length === 0 || copyActionPending}
                    >
                      {allVisibleCopyTargetsSelected ? translateText("取消") : translateText("全选")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => commitCopyTargetSelection(copyTargetScopeType, [])}
                      disabled={copyTargetResourceIds.length === 0 || copyActionPending}
                    >{translateText("清空目标")}</Button>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {filteredCopyTargetResources.length}{translateText(" 项")}</span>
                  </div>
                  <div className="space-y-2 rounded-md border border-border/60 p-2">
                    {filteredCopyTargetResources.length > 0 ? filteredCopyTargetResources.map((resource: any) => (
                      <label
                        key={`${copyTargetScopeType}:${resource.id}`}
                        className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 transition-colors hover:bg-muted/40 ${
                          copyTargetResourceIds.includes(Number(resource.id))
                            ? "border-emerald-500/50 bg-emerald-500/5 shadow-sm"
                            : "border-border/40 bg-background/70"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={copyTargetResourceIds.includes(Number(resource.id))}
                          disabled={copyActionPending}
                          onChange={(event) => toggleCopyTargetResource(Number(resource.id), event.target.checked, copyTargetScopeType)}
                        />
                        <span className="min-w-0 flex-1">{renderTransferResourceOption(copyTargetScopeType, resource, { showStatus: true })}</span>
                      </label>
                    )) : (
                      <div className="py-10 text-center text-sm text-muted-foreground">{translateText("没有可选择的")}{copyTargetScopeLabel}</div>
                    )}
                  </div>
                  <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs leading-5 text-emerald-800 dark:text-emerald-200">
                    {selectedCopyTargetResources.length > 0 ? (
                      <>
                        <span className="font-medium">{translateText("本次复制目标：")}</span>
                        <span>
                          {selectedCopyTargetResources.slice(0, 4).map((resource: any, index: number) => (
                            <span key={`${copyTargetScopeType}-summary-${resource.id}`}>
                              {index > 0 ? "、" : ""}{getTransferResourceLabel(copyTargetScopeType, resource)} (#{Number(resource.id)})
                            </span>
                          ))}
                          {selectedCopyTargetResources.length > 4 ? translateText(" 等 {0} 个目标", [selectedCopyTargetResources.length]) : ""}
                        </span>
                      </>
                    ) : (
                      <span>{translateText("尚未选择复制目标")}</span>
                    )}
                  </div>
                </div>
                )}
              </div>}
            </div>
            {(batchStep === 2 || isBatchExportMode) && <p className="text-xs leading-5 text-muted-foreground">
              {isBatchExportMode
                ? translateText("按所选规则及格式导出。")
                : isBatchEditMode
                ? translateText("仅覆盖已填写项；未选择的入口和留空的目标保持不变。")
                : translateText("复制会保留原规则基础配置，并按当前选择的目标资源生成副本。")}
            </p>}
            </>
            )}
          </div>
          <DialogFooter className="gap-2 border-t border-border/50 pt-3 sm:justify-between">
            {ruleTaskEnqueued ? <Button variant="outline" onClick={() => setShowCopyDialog(false)}>{translateText("后台执行")}</Button> : isBatchOperateMode ? <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                <Button variant="outline" onClick={() => handleBatchRuleOperation("enable")} disabled={copyActionPending || !selectedBatchRuleCount}><Play className="mr-2 h-4 w-4" />{translateText("启用")}</Button>
                <Button variant="outline" onClick={() => handleBatchRuleOperation("pause")} disabled={copyActionPending || !selectedBatchRuleCount}><Pause className="mr-2 h-4 w-4" />{translateText("暂停")}</Button>
                <Button variant="outline" onClick={() => handleBatchRuleOperation("restart")} disabled={copyActionPending || !selectedBatchRuleCount}><RotateCcw className="mr-2 h-4 w-4" />{translateText("重启")}</Button>
                <Button variant="destructive" onClick={handleBatchDeleteRules} disabled={copyActionPending || !selectedBatchRuleCount}><Trash2 className="mr-2 h-4 w-4" />{translateText("删除所选")}</Button>
              </div>
              <Button variant="outline" className="w-full sm:w-auto" disabled={copyActionPending} onClick={() => setShowCopyDialog(false)}>{translateText("关闭")}</Button>
            </div> : !batchIsFinalStep ? <>
              <Button variant="outline" disabled={copyActionPending} onClick={() => batchStep > 1 ? setBatchStep(batchStep - 1) : setShowCopyDialog(false)}>{batchStep > 1 ? translateText("上一步") : translateText("取消")}</Button>
              <Button type="button" disabled={!batchCanAdvance} onClick={() => setBatchStep(batchStep + 1)}>{translateText("下一步")}</Button>
            </> : isBatchGroupMode ? <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <RuleGroupBulkPagination editor={batchGroupEditor} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" disabled={copyActionPending} onClick={() => setShowCopyDialog(false)}>{translateText("关闭")}</Button>
                <RuleGroupBulkApplyButton editor={batchGroupEditor} />
              </div>
            </div> : isBatchImportMode ? (
              <>
                <Button variant="outline" onClick={() => setBatchStep(batchStep - 1)} disabled={copyActionPending}>{translateText("上一步")}</Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={importingRules}>{translateText("取消")}</Button>
                  <Button type="button" onClick={handleImportRules} disabled={!importValidation.ok || importingRules}>
                    {importingRules && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{translateText("导入规则")}</Button>
                </div>
              </>
            ) : isBatchExportMode ? (
              <>
                <div />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setShowCopyDialog(false)}>{translateText("取消")}</Button>
                  <Button type="button" onClick={handleBatchExportRules} disabled={selectedBatchRuleCount === 0 || copyActionPending}>
                    <Download className="mr-2 h-4 w-4" />{translateText("导出规则")}</Button>
                </div>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setBatchStep(batchStep - 1)} disabled={copyActionPending}>{translateText("上一步")}</Button>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setShowCopyDialog(false)} disabled={copyActionPending}>{translateText("取消")}</Button>
                  <Button
                    type="button"
                    variant={isBatchEditMode ? "default" : "outline"}
                    onClick={isBatchEditMode ? handleBatchEditRules : handleCopyRules}
                    disabled={isBatchEditMode ? batchEditDisabled : batchCopyDisabled}
                  >
                    {copyActionPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isBatchEditMode ? <Pencil className="mr-2 h-4 w-4" /> : <ClipboardCopy className="mr-2 h-4 w-4" />}
                    {isBatchEditMode ? translateText("应用批量编辑") : translateText("复制所选规则")}
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resetTrafficTarget} onOpenChange={(open) => !open && !resetTrafficMutation.isPending && setResetTrafficTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{resetTrafficTarget?.scope === "all" ? translateText("重置全部规则数据") : translateText("重置规则数据")}</DialogTitle>
            <DialogDescription>
              {resetTrafficTarget?.scope === "all"
                ? translateText("确认重置{0}的全部规则统计数据？此操作包含其他分页中的规则，不受链路和搜索筛选影响。", [filterUser === "all" ? translateText("所有用户") : filterUser === "self" ? translateText("我的规则") : translateText("所选用户")])
                : translateText("确认重置规则 \"{0}\" 的所有统计数据？", [resetTrafficTarget?.rule?.name || ""])}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-5 text-amber-700 dark:text-amber-300">{translateText("这里只清除规则页面展示的统计数据，不会清除用户套餐已用流量、余额或流量按量计费记录。")}</div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetTrafficTarget(null)}
              disabled={resetTrafficMutation.isPending}
            >{translateText("取消")}</Button>
            <Button
              variant="destructive"
              onClick={handleConfirmResetTraffic}
              disabled={!resetTrafficTarget || resetTrafficMutation.isPending || (resetTrafficTarget.scope === "all" && ruleScopeTotal === 0)}
              className="gap-2"
            >
              {resetTrafficMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {resetTrafficMutation.isPending ? translateText("重置中...") : translateText("确认重置")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteRule} onOpenChange={(open) => !open && setDeleteRule(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{translateText("删除转发规则")}</DialogTitle>
            <DialogDescription>{translateText("确认删除 \"")}{deleteRule?.name}"？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteRule(null)}>{translateText("取消")}</Button>
            <Button
              variant="destructive"
              disabled={!deleteRule || deleteMutation.isPending}
              onClick={() => {
                if (!deleteRule) return;
                deleteMutation.mutate({ id: deleteRule.id });
                setDeleteRule(null);
              }}
            >{translateText("删除")}</Button>
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
  const [optimisticTesting, setOptimisticTesting] = useState(false);
  const [activeTestId, setActiveTestId] = useState<number | null>(null);
  const manualTestRef = useRef(false);
  const { data: latest } = trpc.rules.latestTest.useQuery(
    { ruleId, includeActive: optimisticTesting },
    {
      enabled: open,
      refetchInterval: adaptivePollingInterval(pollingInterval("interactive", open)),
      refetchOnWindowFocus: false,
    }
  );
  const startMutation = trpc.rules.startSelfTest.useMutation({
    onSuccess: (data) => {
      const nextTestId = Number(data?.id) || 0;
      if (nextTestId > 0) {
        setActiveTestId(nextTestId);
      } else {
        setOptimisticTesting(false);
        setActiveTestId(null);
        manualTestRef.current = false;
      }
      utils.rules.latestTest.invalidate({ ruleId });
    },
    onError: (e) => {
      setOptimisticTesting(false);
      setActiveTestId(null);
      manualTestRef.current = false;
      toast.error(e?.message || translateText("下发失败"));
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
      manualTestRef.current = false;
    }
  }, [open]);
  useEffect(() => {
    if (!optimisticTesting || !activeTestId || !isTerminalStatus) return;
    if (latestTestId >= activeTestId) {
      handoffManualTestResult(
        latest,
        (result) => utils.rules.latestTest.setData(
          { ruleId, includeActive: false },
          result,
        ),
        () => setOptimisticTesting(false),
      );
      void Promise.all([
        utils.rules.trafficSummary.invalidate(),
        utils.rules.tcpingSeries.invalidate({ ruleId, hours: 24 }),
      ]);
      setActiveTestId(null);
      if (status === "success") manualTestRef.current = false;
    }
  }, [activeTestId, isTerminalStatus, latest, latestTestId, optimisticTesting, ruleId, status, utils]);
  useEffect(() => {
    if (!startMutation.isError) return;
    setOptimisticTesting(false);
    setActiveTestId(null);
  }, [startMutation.isError]);
  const isTesting = startMutation.isPending || optimisticTesting || isServerTesting;
  const isSuccess = status === "success";
  const isTimeout = status === "timeout";
  const awaitingNewTest = optimisticTesting && (!activeTestId || latestTestId < activeTestId);
  const displayedMessage = awaitingNewTest ? null : latest?.message;
  const parsedMessage = useMemo(() => parseLinkTestMessage(displayedMessage), [displayedMessage]);
  const testSource = forwardGroupSelfTestSource(latest);
  const testSegments: LinkTestPlannedSegment[] | undefined = testSource ? [{
    from: testSource.label,
    to: testSource.targetLabel || targetLabel || ruleName,
    fromHostId: testSource.hostId,
    toHostId: null,
    fromMeta: nodeMeta?.[String(testSource.hostId)],
    toMeta: nodeMeta?.[testSource.targetLabel || targetLabel || ruleName],
  }] : plannedSegments;
  const plannedSegmentCount = testSegments?.length || 0;
  const probeDialogSizeClass = plannedSegmentCount >= 3 ? "sm:max-w-4xl" : plannedSegmentCount >= 2 ? "sm:max-w-3xl" : "sm:max-w-xl";
  const lastFailureToastKey = useRef("");
  useEffect(() => {
    if (!open) {
      lastFailureToastKey.current = "";
      return;
    }
    const message = parsedMessage.message.trim();
    if (!isTesting && manualTestRef.current && latest && !isSuccess && isTerminalStatus) {
      const key = `${ruleId}:${status}:${latest?.updatedAt || ""}:${message}`;
      if (lastFailureToastKey.current !== key) {
        lastFailureToastKey.current = key;
        manualTestRef.current = false;
        toast.error(isTimeout ? translateText("转发链路自测超时") : translateText("转发链路自测失败"), { duration: 5000 });
      }
    }
  }, [open, isTesting, isSuccess, isTerminalStatus, isTimeout, latest, latest?.updatedAt, parsedMessage.message, ruleId, status]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${probeDialogSizeClass} min-w-0`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />{translateText("延迟探测")}</DialogTitle>
          <DialogDescription>{ruleName}</DialogDescription>
        </DialogHeader>

        <LinkTestProbeView
          parsed={parsedMessage}
          fallbackLatencyMs={!awaitingNewTest && typeof latest?.latencyMs === "number" && latest.latencyMs > 0 ? latest.latencyMs : null}
          isSuccess={isSuccess}
          isTesting={isTesting}
          sourceLabel={testSource?.label || sourceLabel}
          targetLabel={targetLabel}
          nodeMeta={nodeMeta}
          plannedSegments={testSegments}
          ignorePlannedResultsWhenDetailsPresent
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
              manualTestRef.current = true;
              setOptimisticTesting(true);
              setActiveTestId(null);
              startMutation.mutate({ ruleId });
            }}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            </span>
            {isTesting ? translateText("探测中...") : translateText("链路测试")}
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

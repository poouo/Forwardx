import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import DataSectionLoading from "@/components/DataSectionLoading";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Key,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
  Users,
  Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/localizedToast";
import { isTokenHostOnline } from "@/lib/agentTokenStatus";

type AgentTokenManagerProps = {
  createSignal?: number;
  className?: string;
  showCreateButton?: boolean;
  hideViewModeToggle?: boolean;
  dialogOnly?: boolean;
  viewMode?: AgentTokenViewMode;
  onViewModeChange?: (viewMode: AgentTokenViewMode) => void;
  onCreateSignalHandled?: () => void;
  searchQuery?: string;
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
};

export type AgentTokenViewMode = "card" | "table";
type InstallAddressMode = "public" | "current";
type InstallAddressOption = {
  id: InstallAddressMode;
  label: string;
  description: string;
  url: string;
};

type EnrollmentHostPreview = {
  id: number;
  name: string;
  address: string;
  online: boolean;
};

type EnrollmentHostEditState = {
  enrollmentId: string;
  hostId: number;
  name: string;
};

type EnrollmentPreview = {
  id: string;
  kind: "enrollment";
  description: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  maxRegistrations: number;
  usedRegistrations: number;
  hosts: EnrollmentHostPreview[];
  tokenId?: number;
};

type AgentCardItem =
  | { kind: "token"; value: any }
  | { kind: "enrollment"; value: EnrollmentPreview };

function agentCardItemId(item: AgentCardItem) {
  return item.kind === "token" ? Number(item.value.id) : item.value.id;
}

const DEV_ENROLLMENT_PREVIEW_ENABLED = typeof window !== "undefined"
  && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname === "::1");

const DEV_ENROLLMENT_HOSTS: EnrollmentHostPreview[] = [
  { id: 901, name: "广州入口-01", address: "203.0.113.21", online: true },
  { id: 902, name: "香港出口-02", address: "198.51.100.42", online: true },
  { id: 903, name: "东京中转-03", address: "2001:db8:20::31", online: false },
  { id: 904, name: "新加坡备用-04", address: "198.51.100.77", online: true },
  { id: 905, name: "洛杉矶节点-05", address: "2001:db8:40::8", online: true },
];

function createDevEnrollmentPreview(overrides: Partial<EnrollmentPreview> = {}): EnrollmentPreview {
  const now = Date.now();
  return {
    id: "dev-enrollment-main",
    kind: "enrollment",
    description: "生产节点批量注册",
    token: "enroll_7F3k••••••••••••••••",
    createdAt: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
    expiresAt: new Date(now + 1000 * 60 * 60 * 24 * 27).toISOString(),
    maxRegistrations: 20,
    usedRegistrations: DEV_ENROLLMENT_HOSTS.length,
    hosts: DEV_ENROLLMENT_HOSTS,
    ...overrides,
  };
}

function enrollmentDate(value: unknown) {
  if (!value) return "";
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 2_000_000_000 ? value * 1000 : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function enrollmentFromToken(tokenItem: any): EnrollmentPreview {
  const hosts = Array.isArray(tokenItem?.hosts)
    ? tokenItem.hosts
    : tokenItem?.host
      ? [tokenItem.host]
      : [];
  return {
    id: `token-${tokenItem.id}`,
    tokenId: Number(tokenItem.id),
    kind: "enrollment",
    description: String(tokenItem.description || translateText("批量注册")),
    token: String(tokenItem.token || ""),
    createdAt: enrollmentDate(tokenItem.createdAt) || new Date().toISOString(),
    expiresAt: enrollmentDate(tokenItem.registrationExpiresAt),
    maxRegistrations: Math.max(0, Number(tokenItem.maxRegistrations) || 0),
    usedRegistrations: Math.max(0, Number(tokenItem.usedRegistrations) || hosts.length),
    hosts: hosts.map((host: any) => ({
      id: Number(host.id),
      name: String(host.name || translateText("未命名主机")),
      address: tokenHostAddress(host),
      online: isTokenHostOnline(host),
    })),
  };
}

function nonNegativeInteger(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

const AGENT_TOKEN_VIEW_MODE_STORAGE_KEY = "forwardx.agentTokens.viewMode";
function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  return visible;
}

function getStoredAgentTokenViewMode(): AgentTokenViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(AGENT_TOKEN_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeAgentTokenViewMode(viewMode: AgentTokenViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_TOKEN_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so the token manager remains usable.
  }
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isLoopbackPanelUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function panelUrlKey(value: string) {
  return normalizeConfigUrl(value).toLowerCase();
}

function tokenHostAddress(host: any) {
  if (!host) return "";
  return host.entryIp || host.ipv4 || host.ipv6 || host.ip || "";
}

function tokenMatchesSearchQuery(tokenItem: any, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const host = tokenItem?.host;
  const status = !host
    ? tokenItem?.isUsed ? "已使用 已绑定 关联主机不存在" : "未使用 未绑定 可用"
    : isTokenHostOnline(host) ? "已使用 已绑定 在线" : "已使用 已绑定 离线";
  const haystack = [
    tokenItem?.id,
    tokenItem?.token,
    tokenItem?.description,
    status,
    host?.id,
    host?.name,
    host?.entryIp,
    host?.ipv4,
    host?.ipv6,
    host?.ip,
  ].filter((value) => value !== null && value !== undefined).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function TokenStatusBadge({ tokenItem }: { tokenItem: any }) {
  const host = tokenItem.host;
  if (!host) {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1.5 text-[11px]">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />{translateText("未绑定")}</Badge>
    );
  }

  const isOnline = isTokenHostOnline(host);
  return isOnline ? (
    <Badge className="shrink-0 gap-1.5 border-chart-2/25 bg-chart-2/10 text-chart-2 text-[11px]">
      <span className="h-2 w-2 rounded-full bg-chart-2 shadow-sm shadow-chart-2/50 animate-pulse" />{translateText("在线")}</Badge>
  ) : (
    <Badge className="shrink-0 gap-1.5 border-destructive/25 bg-destructive/10 text-destructive text-[11px]">
      <span className="h-2 w-2 rounded-full bg-destructive shadow-sm shadow-destructive/50" />{translateText("离线")}</Badge>
  );
}

function TokenHostInfo({ tokenItem, compact = false }: { tokenItem: any; compact?: boolean }) {
  if (!tokenItem.host) {
    return <span className="text-xs text-muted-foreground">{tokenItem.isUsed ? translateText("关联主机不存在") : "-"}</span>;
  }
  const address = tokenHostAddress(tokenItem.host);
  return (
    <div className={`flex min-w-0 items-center gap-2 text-xs leading-5 ${compact ? "" : "max-w-[240px]"}`}>
      <span className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0">
        <span className="block truncate font-medium" title={tokenItem.host.name}>
          {tokenItem.host.name}
        </span>
        {address && (
          <span className="block truncate font-mono text-muted-foreground" title={address}>
            {address}
          </span>
        )}
      </div>
    </div>
  );
}

function EnrollmentStatusBadge({ enrollment }: { enrollment: EnrollmentPreview }) {
  const expiresAt = enrollment.expiresAt ? new Date(enrollment.expiresAt).getTime() : Number.POSITIVE_INFINITY;
  const expired = expiresAt <= Date.now();
  return (
    <Badge className={cn(
      "shrink-0 gap-1.5 text-[11px]",
      expired
        ? "border-destructive/25 bg-destructive/10 text-destructive"
        : "border-primary/25 bg-primary/10 text-primary",
    )}>
      <span className={cn("h-2 w-2 rounded-full", expired ? "bg-destructive" : "bg-primary")} />
      {expired ? translateText("已过期") : translateText("批量注册")}
    </Badge>
  );
}

function EnrollmentHostSummary({
  enrollment,
  onOpen,
}: {
  enrollment: EnrollmentPreview;
  onOpen: () => void;
}) {
  const visibleHosts = enrollment.hosts.slice(0, 2);
  const remaining = Math.max(0, enrollment.hosts.length - visibleHosts.length);
  return (
    <button
      type="button"
      className="w-full rounded-md bg-muted/25 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      onClick={onOpen}
      title={translateText("查看全部已注册主机")}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{translateText("已注册主机")}</p>
        <span className="text-xs font-medium text-primary">{enrollment.usedRegistrations} / {enrollment.maxRegistrations > 0 ? enrollment.maxRegistrations : translateText("不限")}</span>
      </div>
      <div className="space-y-1.5">
        {visibleHosts.map((host) => (
          <div key={host.id} className="flex min-w-0 items-center gap-2 text-xs">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", host.online ? "bg-chart-2" : "bg-muted-foreground/40")} />
            <span className="min-w-0 flex-1 truncate font-medium" title={host.name}>{host.name}</span>
            <span className="max-w-[9rem] truncate font-mono text-muted-foreground" title={host.address}>{host.address}</span>
          </div>
        ))}
        {remaining > 0 && (
          <span className="block pt-0.5 text-xs text-primary">{translateText("还有 {0} 台主机，点击查看", [remaining])}</span>
        )}
        {visibleHosts.length === 0 && (
          <span className="block text-xs text-muted-foreground">{translateText("还没有注册主机")}</span>
        )}
      </div>
    </button>
  );
}

function EnrollmentCard({
  enrollment,
  onOpenHosts,
  onInstall,
  onEdit,
  onDelete,
  dragHandle,
  sortableClassName,
}: {
  enrollment: EnrollmentPreview;
  onOpenHosts: (enrollment: EnrollmentPreview) => void;
  onInstall: (enrollment: EnrollmentPreview) => void;
  onEdit: (enrollment: EnrollmentPreview) => void;
  onDelete: (enrollment: EnrollmentPreview) => void;
  dragHandle?: any;
  sortableClassName?: string;
}) {
  const createdAtText = new Date(enrollment.createdAt).toLocaleString(getFormatLocale());
  const expiresAtText = enrollment.expiresAt
    ? new Date(enrollment.expiresAt).toLocaleDateString(getFormatLocale())
    : translateText("不限时");
  return (
    <Card className={cn("action-card group/sortable border-border/40 bg-card/60 backdrop-blur-md", sortableClassName)}>
      <CardContent className="action-card-content space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Key className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={enrollment.description}>{enrollment.description}</p>
              <p className="truncate text-xs text-muted-foreground" title={translateText("创建时间 · {0} · 有效期至 {1}", [createdAtText, expiresAtText])}>
                {translateText("创建时间 · ")}{createdAtText} · {translateText("有效期至 {0}", [expiresAtText])}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {dragHandle}
            <EnrollmentStatusBadge enrollment={enrollment} />
          </div>
        </div>

        <code className="block break-all rounded-md border border-border/40 bg-background/60 px-3 py-2 font-mono text-xs" title={enrollment.token}>
          {enrollment.token}
        </code>

        <EnrollmentHostSummary enrollment={enrollment} onOpen={() => onOpenHosts(enrollment)} />

        <div className="action-card-footer flex justify-end border-t border-border/40 pt-2">
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" title={translateText("查看安装命令")} onClick={() => onInstall(enrollment)}>
              <Terminal className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title={translateText("管理主机")} onClick={() => onOpenHosts(enrollment)}>
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title={translateText("编辑批量注册")} onClick={() => onEdit(enrollment)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title={translateText("删除批量注册")} onClick={() => onDelete(enrollment)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TokenActionButtons({
  tokenItem,
  loadingScriptTokenId,
  onOpenScript,
  onEdit,
  onDelete,
}: {
  tokenItem: any;
  loadingScriptTokenId: number | null;
  onOpenScript: (id: number) => void;
  onEdit: (tokenItem: any) => void;
  onDelete: (tokenItem: any) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={translateText("查看安装命令")}
        disabled={loadingScriptTokenId === tokenItem.id}
        onClick={() => onOpenScript(tokenItem.id)}
      >
        {loadingScriptTokenId === tokenItem.id ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Terminal className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={translateText("编辑备注")}
        onClick={() => onEdit(tokenItem)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive hover:text-destructive"
        title={translateText("删除 Token")}
        onClick={() => onDelete(tokenItem)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function AgentTokenCard({
  tokenItem,
  loadingScriptTokenId,
  onOpenScript,
  onEdit,
  onDelete,
  dragHandle,
  sortableClassName,
}: {
  tokenItem: any;
  loadingScriptTokenId: number | null;
  onOpenScript: (id: number) => void;
  onEdit: (tokenItem: any) => void;
  onDelete: (tokenItem: any) => void;
  dragHandle?: any;
  sortableClassName?: string;
}) {
  const description = typeof tokenItem.description === "string" ? tokenItem.description.trim() : "";
  const createdAtText = new Date(tokenItem.createdAt).toLocaleString(getFormatLocale());

  return (
    <Card className={cn("action-card group/sortable border-border/40 bg-card/60 backdrop-blur-md", sortableClassName)}>
      <CardContent className="action-card-content space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Key className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={description || "Agent Token"}>
                  {description || "Agent Token"}
                </p>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={translateText("创建时间：{0}", [createdAtText])}
                >{translateText("创建时间 · ")}{createdAtText}
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {dragHandle}
            <TokenStatusBadge tokenItem={tokenItem} />
          </div>
        </div>

        <code className="block break-all rounded-md border border-border/40 bg-background/60 px-3 py-2 font-mono text-xs">
          {tokenItem.token}
        </code>

        <div className="rounded-md bg-muted/25 p-3">
          <p className="mb-2 text-xs text-muted-foreground">{translateText("对应主机")}</p>
          <TokenHostInfo tokenItem={tokenItem} compact />
        </div>

        <div className="action-card-footer flex justify-end border-t border-border/40 pt-2">
          <TokenActionButtons
            tokenItem={tokenItem}
            loadingScriptTokenId={loadingScriptTokenId}
            onOpenScript={onOpenScript}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CommandRow({
  label,
  command,
  onCopy,
  copyDisabled,
}: {
  label: string;
  command: string;
  onCopy: () => void;
  copyDisabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0 overflow-hidden rounded border bg-muted/30">
          <div className="h-12 overflow-x-scroll overflow-y-hidden">
            <code className="flex h-full w-max min-w-full items-center whitespace-nowrap px-3 pb-3 pt-2 font-mono text-xs leading-5">
              {command}
            </code>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          aria-disabled={copyDisabled}
          onClick={() => {
            if (copyDisabled) return;
            onCopy();
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function InstallAddressSelector({
  options,
  selectedId,
  onChange,
}: {
  options: InstallAddressOption[];
  selectedId: InstallAddressMode;
  onChange: (value: InstallAddressMode) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <div className="space-y-2 rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{translateText("安装连接地址")}</p>
          <p className="text-xs text-muted-foreground">{translateText("需要直连 IP 和端口时，请选择“当前访问地址”。")}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const active = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.id)}
              className={cn(
                "min-w-0 rounded-md border px-3 py-2 text-left transition-colors",
                active
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/50 bg-background/70 hover:bg-muted/50",
              )}
            >
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" title={option.url}>
                {option.url}
              </span>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AgentTokenManager({
  createSignal,
  className,
  showCreateButton = true,
  hideViewModeToggle = false,
  dialogOnly = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  onCreateSignalHandled,
  searchQuery = "",
  onFilterStatsChange,
}: AgentTokenManagerProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const pageVisible = usePageVisible();
  const [showCreate, setShowCreate] = useState(false);
  const [showNewToken, setShowNewToken] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const [scriptToken, setScriptToken] = useState("");
  const [scriptPanelUrl, setScriptPanelUrl] = useState("");
  const [reuseInstall, setReuseInstall] = useState<{ command: string; hostName: string; online: boolean } | null>(null);
  const installTokenIds = useRef(new Map<string, number>());
  const [loadingScriptTokenId, setLoadingScriptTokenId] = useState<number | null>(null);
  const [newToken, setNewToken] = useState("");
  const [description, setDescription] = useState("");
  const [registrationMode, setRegistrationMode] = useState<"single" | "batch">("single");
  const [batchRegistrationLimit, setBatchRegistrationLimit] = useState("20");
  const [batchRegistrationExpiryDays, setBatchRegistrationExpiryDays] = useState("30");
  const [devEnrollmentItems, setDevEnrollmentItems] = useState<EnrollmentPreview[]>(() => (
    DEV_ENROLLMENT_PREVIEW_ENABLED ? [createDevEnrollmentPreview()] : []
  ));
  const [selectedEnrollment, setSelectedEnrollment] = useState<EnrollmentPreview | null>(null);
  const [editingEnrollmentHost, setEditingEnrollmentHost] = useState<EnrollmentHostEditState | null>(null);
  const [editingEnrollment, setEditingEnrollment] = useState<EnrollmentPreview | null>(null);
  const [enrollmentCommand, setEnrollmentCommand] = useState<EnrollmentPreview | null>(null);
  const [editEnrollmentDescription, setEditEnrollmentDescription] = useState("");
  const [editEnrollmentLimit, setEditEnrollmentLimit] = useState("20");
  const [editEnrollmentExpiryDays, setEditEnrollmentExpiryDays] = useState("30");
  const [editingToken, setEditingToken] = useState<any>(null);
  const [editDescription, setEditDescription] = useState("");
  const [tokenToDelete, setTokenToDelete] = useState<any | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<AgentTokenViewMode>(() => getStoredAgentTokenViewMode());
  const [installAddressMode, setInstallAddressMode] = useState<InstallAddressMode>("public");
  const lastCreateSignalRef = useRef(0);
  const viewMode = controlledViewMode ?? internalViewMode;
  const confirm = useConfirmDialog();

  const openCreateDialog = () => {
    setDescription("");
    setRegistrationMode("single");
    setBatchRegistrationLimit("20");
    setBatchRegistrationExpiryDays("30");
    setShowCreate(true);
  };

  const handleViewModeChange = (nextViewMode: AgentTokenViewMode) => {
    if (onViewModeChange) onViewModeChange(nextViewMode);
    else setInternalViewMode(nextViewMode);
    storeAgentTokenViewMode(nextViewMode);
  };

  useEffect(() => {
    if (!createSignal) {
      lastCreateSignalRef.current = 0;
      return;
    }
    if (createSignal === lastCreateSignalRef.current) return;
    lastCreateSignalRef.current = createSignal;
    openCreateDialog();
    onCreateSignalHandled?.();
  }, [createSignal]);

  const { data: tokens, isLoading } = trpc.agentTokens.list.useQuery(
    undefined,
    {
      enabled: user?.role === "admin" && !dialogOnly,
      refetchInterval: !dialogOnly && pageVisible ? 2000 : false,
      refetchOnWindowFocus: true,
    }
  );
  const tokenItems = useMemo(() => (tokens as any[] | undefined) || [], [tokens]);
  const realEnrollmentItems = useMemo(
    () => tokenItems.filter((tokenItem: any) => tokenItem.registrationMode === "batch").map(enrollmentFromToken),
    [tokenItems],
  );
  const enrollmentItems = useMemo(
    () => [...(DEV_ENROLLMENT_PREVIEW_ENABLED ? devEnrollmentItems : []), ...realEnrollmentItems],
    [devEnrollmentItems, realEnrollmentItems],
  );
  const regularTokenItems = useMemo(
    () => tokenItems.filter((tokenItem: any) => tokenItem.registrationMode !== "batch"),
    [tokenItems],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isTextFiltered = normalizedSearchQuery.length > 0;
  const filteredTokenItems = useMemo(
    () => isTextFiltered
      ? regularTokenItems.filter((tokenItem: any) => tokenMatchesSearchQuery(tokenItem, normalizedSearchQuery))
      : regularTokenItems,
    [isTextFiltered, normalizedSearchQuery, regularTokenItems],
  );
  // Card mode intentionally uses the complete token list. Batch registrations
  // and single-host tokens share one backend sort order, so filtering or
  // rebuilding them as two separate arrays would make the grid split again
  // after each polling refresh.
  const filteredCardTokenItems = useMemo(
    () => isTextFiltered
      ? tokenItems.filter((tokenItem: any) => tokenMatchesSearchQuery(tokenItem, normalizedSearchQuery))
      : tokenItems,
    [isTextFiltered, normalizedSearchQuery, tokenItems],
  );
  const tokenOrder = useOptimisticSortableOrder({
    items: filteredTokenItems,
    getId: (tokenItem: any) => Number(tokenItem.id),
  });
  const displayedTokenItems = tokenOrder.items;
  const cardBaseItems = useMemo<AgentCardItem[]>(
    () => [
      ...(DEV_ENROLLMENT_PREVIEW_ENABLED ? devEnrollmentItems.map((value) => ({ kind: "enrollment" as const, value })) : []),
      ...filteredCardTokenItems.map((value) => value.registrationMode === "batch"
        ? ({ kind: "enrollment" as const, value: enrollmentFromToken(value) })
        : ({ kind: "token" as const, value })),
    ],
    [devEnrollmentItems, filteredCardTokenItems],
  );
  const cardOrder = useOptimisticSortableOrder({ items: cardBaseItems, getId: agentCardItemId });
  const hasVisibleItems = viewMode === "card" ? cardOrder.items.length > 0 : displayedTokenItems.length > 0;
  useEffect(() => {
    onFilterStatsChange?.({ filtered: filteredCardTokenItems.length, total: tokenItems.length });
  }, [filteredCardTokenItems.length, onFilterStatsChange, tokenItems.length]);

  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const configuredPanelUrl = normalizeConfigUrl(systemSettings?.panelPublicUrl || "");
  const currentPanelUrl = typeof window !== "undefined" ? normalizeConfigUrl(window.location.origin) : "";
  const panelUrl = configuredPanelUrl || currentPanelUrl;
  const installAddressOptions = useMemo<InstallAddressOption[]>(() => {
    const options: InstallAddressOption[] = [];
    if (configuredPanelUrl) {
      options.push({
        id: "public",
        label: translateText("公开域名"),
        description: translateText("系统设置中的公开地址。"),
        url: configuredPanelUrl,
      });
    }
    if (currentPanelUrl && (!configuredPanelUrl || panelUrlKey(currentPanelUrl) !== panelUrlKey(configuredPanelUrl))) {
      options.push({
        id: "current",
        label: configuredPanelUrl ? translateText("当前访问地址") : translateText("默认地址"),
        description: configuredPanelUrl ? translateText("当前浏览器使用的地址。") : translateText("当前面板地址。"),
        url: currentPanelUrl,
      });
    }
    if (options.length === 0 && panelUrl) {
      options.push({
        id: "current",
        label: translateText("默认地址"),
        description: translateText("当前面板地址。"),
        url: panelUrl,
      });
    }
    return options;
  }, [configuredPanelUrl, currentPanelUrl, panelUrl]);
  useEffect(() => {
    if (installAddressOptions.length === 0) return;
    if (!installAddressOptions.some((option) => option.id === installAddressMode)) {
      setInstallAddressMode(installAddressOptions[0].id);
    }
  }, [installAddressMode, installAddressOptions]);
  const activeInstallAddress = installAddressOptions.find((option) => option.id === installAddressMode) || installAddressOptions[0];
  const defaultCommandPanelUrl = activeInstallAddress?.url || panelUrl;
  const commandPanelUrl = (showScript && scriptPanelUrl) || defaultCommandPanelUrl;
  const panelUrlUsesLoopback = isLoopbackPanelUrl(commandPanelUrl);
  const githubAcceleratorUrl = normalizeConfigUrl(systemSettings?.githubAccelerator?.url || "");
  const githubAcceleratorActive = !!systemSettings?.githubAccelerator?.enabled && !!githubAcceleratorUrl;
  const agentPreferPanelInstall = !!systemSettings?.agentPreferPanelInstall;

  const createTokenMutation = trpc.agentTokens.create.useMutation({
    onSuccess: (data) => {
      utils.hosts.managementCounts.invalidate();
      utils.agentTokens.list.invalidate();
      toast.success(translateText("安装 Token 已生成"));
      setNewToken(data.token);
      installTokenIds.current.set(data.token, data.id);
      setShowNewToken(true);
      setShowCreate(false);
    },
    onError: (err) => toast.error(err.message || translateText("生成 Token 失败")),
  });

  const createEnrollmentMutation = trpc.agentTokens.create.useMutation({
    onSuccess: (data) => {
      utils.hosts.managementCounts.invalidate();
      utils.agentTokens.list.invalidate();
      setShowCreate(false);
      setEnrollmentCommand({
        id: `token-${data.id}`,
        tokenId: data.id,
        kind: "enrollment",
        description: description.trim() || translateText("批量注册"),
        token: data.token,
        createdAt: new Date().toISOString(),
        expiresAt: batchRegistrationExpiryDays === "0"
          ? ""
          : new Date(Date.now() + nonNegativeInteger(batchRegistrationExpiryDays, 30) * 86400 * 1000).toISOString(),
        maxRegistrations: nonNegativeInteger(batchRegistrationLimit, 20),
        usedRegistrations: 0,
        hosts: [],
      });
      toast.success(translateText("批量注册密钥已生成"));
    },
    onError: (err) => toast.error(err.message || translateText("生成批量注册密钥失败")),
  });

  const deleteTokenMutation = trpc.agentTokens.delete.useMutation({
    onSuccess: (data) => {
      utils.hosts.managementCounts.invalidate();
      utils.agentTokens.list.invalidate();
      utils.hosts.list.invalidate();
      utils.hosts.options.invalidate();
      utils.hosts.listPage.invalidate();
      utils.hosts.summary.invalidate();
      utils.hosts.statusSummary.invalidate();
      const released = Number(data?.releasedPendingCleanup || 0);
      const removedHosts = Number(data?.removedHosts || 0);
      toast.success(released > 0
        ? translateText("Token 已删除，已释放 {0} 条待清理规则并移除 {1} 台关联主机", [released, removedHosts])
        : removedHosts > 0
          ? translateText("Token 已删除，已移除 {0} 台关联主机", [removedHosts])
          : translateText("Token 已删除"));
    },
    onError: (err) => toast.error(err.message || translateText("删除 Token 失败")),
  });

  const updateTokenMutation = trpc.agentTokens.update.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      toast.success(translateText("Token 备注已更新"));
      setEditingToken(null);
      setEditDescription("");
    },
    onError: (err) => toast.error(err.message || translateText("更新 Token 备注失败")),
  });
  const updateEnrollmentMutation = trpc.agentTokens.update.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      setEditingEnrollment(null);
      toast.success(translateText("批量注册信息已更新"));
    },
    onError: (err) => toast.error(err.message || translateText("更新批量注册信息失败")),
  });
  const removeEnrollmentHostMutation = trpc.agentTokens.removeHost.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      utils.hosts.managementCounts.invalidate();
      utils.hosts.list.invalidate();
      utils.hosts.listPage.invalidate();
      setSelectedEnrollment((current) => current ? {
        ...current,
        usedRegistrations: Math.max(0, current.usedRegistrations - 1),
        hosts: current.hosts.filter((host) => host.id !== removeEnrollmentHostMutation.variables?.hostId),
      } : current);
      toast.success(translateText("主机已从批量注册列表移出"));
    },
    onError: (err) => toast.error(err.message || translateText("移出批量注册主机失败")),
  });
  const updateEnrollmentHostMutation = trpc.hosts.update.useMutation({
    onSuccess: () => {
      utils.agentTokens.list.invalidate();
      utils.hosts.list.invalidate();
      utils.hosts.listPage.invalidate();
      setEditingEnrollmentHost(null);
      toast.success(translateText("主机名称已更新"));
    },
    onError: (err) => toast.error(err.message || translateText("更新主机名称失败")),
  });
  const reorderTokenMutation = trpc.agentTokens.reorder.useMutation({
    onSuccess: () => toast.success(translateText("Token 顺序已更新")),
    onError: (err) => toast.error(err.message || translateText("更新 Token 顺序失败")),
  });
  const tokenReorderPending = reorderTokenMutation.isPending;
  const tokenSortable = useSortableReorder({
    items: displayedTokenItems,
    getId: (tokenItem: any) => Number(tokenItem.id),
    disabled: isTextFiltered || tokenReorderPending || displayedTokenItems.length < 2,
    onReorder: (nextTokens) => {
      const requestId = tokenOrder.begin(nextTokens);
      reorderTokenMutation.mutate(
        { ids: nextTokens.map((tokenItem: any) => Number(tokenItem.id)) },
        {
          onError: () => tokenOrder.release(requestId),
          onSettled: () => tokenOrder.resync(requestId, () => utils.agentTokens.list.invalidate()),
        },
      );
    },
  });
  const cardSortable = useSortableReorder({
    items: cardOrder.items,
    getId: agentCardItemId,
    disabled: isTextFiltered || tokenReorderPending || cardOrder.items.length < 2,
    onReorder: (nextItems) => {
      const nextTokenIds = nextItems
        .filter((item) => item.kind === "token" || !!item.value.tokenId)
        .map((item) => item.kind === "token" ? Number(item.value.id) : Number(item.value.tokenId))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (nextTokenIds.length === 0) return;
      const requestId = cardOrder.begin(nextItems);
      reorderTokenMutation.mutate(
        { ids: nextTokenIds },
        {
          onError: () => cardOrder.release(requestId),
          onSettled: () => cardOrder.resync(requestId, () => utils.agentTokens.list.invalidate()),
        },
      );
    },
  });

  const openScriptDialog = async (tokenId: number) => {
    try {
      setLoadingScriptTokenId(tokenId);
      const data = await utils.agentTokens.getInstallToken.fetch({ id: tokenId });
      installTokenIds.current.set(data.token, tokenId);
      setScriptPanelUrl(data.agentPanelUrl || "");
      setScriptToken(data.token);
      setShowScript(true);
    } catch (err: any) {
      toast.error(err?.message || translateText("获取安装命令失败"));
    } finally {
      setLoadingScriptTokenId(null);
    }
  };

  const openEnrollmentCommand = async (enrollment: EnrollmentPreview) => {
    if (!enrollment.tokenId) {
      setEnrollmentCommand(enrollment);
      return;
    }
    try {
      const data = await utils.agentTokens.getInstallToken.fetch({ id: enrollment.tokenId }, { staleTime: 0 });
      setEnrollmentCommand({ ...enrollment, token: data.token });
    } catch (error: any) {
      toast.error(error?.message || translateText("获取批量注册命令失败"));
    }
  };

  const copyToClipboard = async (text: string) => {
    if (await copyTextToClipboard(text)) {
      toast.success(translateText("已复制到剪贴板"));
      return;
    }

    try {
      window.prompt(translateText("复制失败，请手动选中并复制 (Ctrl+C / Cmd+C)："), text);
      toast.warning(translateText("未能自动写入剪贴板，已弹出手动复制窗口"));
    } catch {
      toast.error(translateText("复制未成功。请检查浏览器权限；HTTP 访问建议使用 HTTPS，也可手动复制。"));
    }
  };

  const getAgentScriptCommand = (args: string, targetPanelUrl = commandPanelUrl) => {
    const installPanelUrl = normalizeConfigUrl(targetPanelUrl) || panelUrl;
    const env = [
      githubAcceleratorActive ? "GITHUB_ACCELERATOR_ENABLED=true" : "",
      githubAcceleratorActive ? `GITHUB_ACCELERATOR_URL=${shellQuote(githubAcceleratorUrl)}` : "",
      agentPreferPanelInstall ? "FORWARDX_AGENT_PANEL_FIRST=true" : "",
    ].filter(Boolean).join(" ");
    const bashPrefix = env ? `${env} bash` : "bash";
    const withPipefail = (pipeline: string) => `bash -c ${shellQuote(`set -o pipefail; ${pipeline}`)}`;
    const curlScriptArgs = "--connect-timeout 15 --speed-limit 1024 --speed-time 60";
    const panelCommand = withPipefail(`curl -fsSL ${curlScriptArgs} ${shellQuote(`${installPanelUrl}/api/agent/install.sh`)} | PANEL_URL=${shellQuote(installPanelUrl)} ${bashPrefix} -s -- ${args}`);
    const githubScriptUrl = githubAcceleratorActive
      ? `${githubAcceleratorUrl}/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh`
      : "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh";
    const githubCommand = withPipefail(`curl -fsSL ${curlScriptArgs} "${githubScriptUrl}" | PANEL_URL=${shellQuote(installPanelUrl)} ${bashPrefix} -s -- ${args}`);
    if (agentPreferPanelInstall) {
      return `${panelCommand} || ${githubCommand}`;
    }
    return `${githubCommand} || ${panelCommand}`;
  };

  const getInstallCommand = (token: string, targetPanelUrl = commandPanelUrl) => getAgentScriptCommand(`install ${token}`, targetPanelUrl);
  const copyInstallCommand = async (token: string) => {
    try {
      // Fetch on every copy: an open dialog may outlive the first installation.
      const id = installTokenIds.current.get(token);
      if (!id) throw new Error(translateText("获取安装命令失败"));
      const data = await utils.agentTokens.getInstallToken.fetch({ id }, { staleTime: 0 });
      if (showScript && data.token === scriptToken) setScriptPanelUrl(data.agentPanelUrl || "");
      const command = getInstallCommand(data.token, data.agentPanelUrl || defaultCommandPanelUrl);
      if (data.boundHost) {
        setReuseInstall({ command, hostName: data.boundHost.name, online: !!data.boundHost.isOnline });
        return;
      }
      await copyToClipboard(command);
    } catch (error: any) { toast.error(error?.message || translateText("获取安装命令失败")); }
  };
  const getUninstallCommand = () => getAgentScriptCommand("uninstall");
  const getUpgradeCommand = () => getAgentScriptCommand("upgrade");
  const openEditToken = (tokenItem: any) => {
    setEditingToken(tokenItem);
    setEditDescription(tokenItem.description || "");
  };

  const openEditEnrollment = (enrollment: EnrollmentPreview) => {
    setEditingEnrollment(enrollment);
    setEditEnrollmentDescription(enrollment.description);
    setEditEnrollmentLimit(String(enrollment.maxRegistrations));
    const remainingDays = enrollment.expiresAt
      ? Math.max(1, Math.ceil((new Date(enrollment.expiresAt).getTime() - Date.now()) / 86400000))
      : 0;
    setEditEnrollmentExpiryDays(String(remainingDays));
  };

  const saveEditEnrollment = () => {
    if (!editingEnrollment) return;
    const limit = Math.max(editingEnrollment.usedRegistrations, Math.min(1000, nonNegativeInteger(editEnrollmentLimit, editingEnrollment.maxRegistrations)));
    const expiryDays = Math.min(365, nonNegativeInteger(editEnrollmentExpiryDays, 30));
    if (editingEnrollment.tokenId) {
      updateEnrollmentMutation.mutate({
        id: editingEnrollment.tokenId,
        description: editEnrollmentDescription.trim() || null,
        maxRegistrations: limit,
        registrationExpiryDays: expiryDays,
      });
      return;
    }
    setDevEnrollmentItems((items) => items.map((item) => item.id === editingEnrollment.id
      ? {
        ...item,
        description: editEnrollmentDescription.trim() || item.description,
        maxRegistrations: limit,
        expiresAt: expiryDays === 0 ? "" : new Date(Date.now() + expiryDays * 86400000).toISOString(),
      }
      : item));
    setEditingEnrollment(null);
    toast.success(translateText("批量注册信息已更新"));
  };

  const deleteEnrollmentPreview = (enrollment: EnrollmentPreview) => {
    if (enrollment.tokenId) {
      setTokenToDelete({ id: enrollment.tokenId, token: enrollment.token, description: enrollment.description });
      return;
    }
    setDevEnrollmentItems((items) => items.filter((item) => item.id !== enrollment.id));
    if (selectedEnrollment?.id === enrollment.id) setSelectedEnrollment(null);
    toast.success(translateText("批量注册预览已删除"));
  };

  const openEditEnrollmentHost = (enrollment: EnrollmentPreview, host: EnrollmentHostPreview) => {
    setEditingEnrollmentHost({ enrollmentId: enrollment.id, hostId: host.id, name: host.name });
  };

  const saveEditEnrollmentHost = () => {
    if (!editingEnrollmentHost) return;
    const name = editingEnrollmentHost.name.trim();
    if (!name) {
      toast.error(translateText("请填写主机名称"));
      return;
    }
    const targetEnrollment = enrollmentItems.find((item) => item.id === editingEnrollmentHost.enrollmentId);
    if (targetEnrollment?.tokenId) {
      updateEnrollmentHostMutation.mutate({ id: editingEnrollmentHost.hostId, name });
      return;
    }
    const update = (enrollment: EnrollmentPreview) => enrollment.id !== editingEnrollmentHost.enrollmentId
      ? enrollment
      : {
        ...enrollment,
        hosts: enrollment.hosts.map((host) => host.id === editingEnrollmentHost.hostId ? { ...host, name } : host),
      };
    setDevEnrollmentItems((items) => items.map(update));
    setSelectedEnrollment((enrollment) => enrollment ? update(enrollment) : enrollment);
    setEditingEnrollmentHost(null);
    toast.success(translateText("主机信息已更新"));
  };

  const removeEnrollmentHost = async (enrollment: EnrollmentPreview, host: EnrollmentHostPreview) => {
    const confirmed = await confirm({
      title: translateText("移出批量注册"),
      description: translateText("确定将“{0}”从这个批量注册列表中移出吗？不会删除主机本身。", [host.name]),
      confirmText: translateText("移出"),
      tone: "destructive",
    });
    if (!confirmed) return;
    if (enrollment.tokenId) {
      removeEnrollmentHostMutation.mutate({ id: enrollment.tokenId, hostId: host.id });
      return;
    }
    const update = (item: EnrollmentPreview) => item.id !== enrollment.id
      ? item
      : {
        ...item,
        usedRegistrations: Math.max(0, item.usedRegistrations - 1),
        hosts: item.hosts.filter((itemHost) => itemHost.id !== host.id),
      };
    setDevEnrollmentItems((items) => items.map(update));
    setSelectedEnrollment((item) => item ? update(item) : item);
    toast.success(translateText("主机已从批量注册列表移出"));
  };

  const createEnrollment = () => {
    const limit = Math.min(1000, nonNegativeInteger(batchRegistrationLimit, 20));
    const expiryDays = Math.min(365, nonNegativeInteger(batchRegistrationExpiryDays, 30));
    createEnrollmentMutation.mutate({
      description: description.trim() || undefined,
      registrationMode: "batch",
      maxRegistrations: limit,
      registrationExpiryDays: expiryDays,
    });
  };

  if (user?.role !== "admin") return null;

  return (
    <div className={dialogOnly ? "contents" : `space-y-4 ${className || ""}`}>
      {!dialogOnly && (
      <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">{translateText("生成 Agent 安装命令；上线后自动绑定到面板。")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {!hideViewModeToggle && <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
            <Button
              variant={viewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title={translateText("卡片视图")}
              onClick={() => handleViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title={translateText("列表视图")}
              onClick={() => handleViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>}
          {showCreateButton && (
            <Button onClick={openCreateDialog} className="w-full gap-2 sm:w-auto">
              <Plus className="h-4 w-4" />{translateText("添加主机")}</Button>
          )}
        </div>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label={translateText("正在加载 Agent Token")} />
            </div>
          ) : hasVisibleItems ? (
            <>
              {viewMode === "card" ? (
                <SortableReorderContext sortable={cardSortable} ids={cardOrder.items.map(agentCardItemId)} strategy="rect">
                  <div key="agent-token-card-view" className="standard-card-grid card-mode-transition gap-4 p-3">
                    {cardOrder.items.map((item) => (
                      <SortableItem key={agentCardItemId(item)} id={agentCardItemId(item)} disabled={cardSortable.disabled}>
                        {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                          <div {...itemProps}>
                            {item.kind === "token" ? (
                              <AgentTokenCard
                                tokenItem={item.value}
                                loadingScriptTokenId={loadingScriptTokenId}
                                onOpenScript={openScriptDialog}
                                onEdit={openEditToken}
                                onDelete={setTokenToDelete}
                                dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />}
                                sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                              />
                            ) : (
                              <EnrollmentCard
                                enrollment={item.value}
                                onOpenHosts={setSelectedEnrollment}
                                onInstall={openEnrollmentCommand}
                                onEdit={openEditEnrollment}
                                onDelete={deleteEnrollmentPreview}
                                dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />}
                                sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                              />
                            )}
                          </div>
                        )}
                      </SortableItem>
                    ))}
                  </div>
                </SortableReorderContext>
              ) : (
              <div key="agent-token-table-view" className="card-mode-transition">
              <SortableReorderContext sortable={tokenSortable} ids={displayedTokenItems.map((tokenItem: any) => Number(tokenItem.id))} strategy="vertical" restrictToList>
                <div className="grid grid-cols-1 gap-4 p-3 sm:hidden">
                  {displayedTokenItems.map((tokenItem: any) => (
                    <SortableItem key={tokenItem.id} id={Number(tokenItem.id)} disabled={tokenSortable.disabled}>
                      {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                        <div {...itemProps}>
                          <AgentTokenCard
                            tokenItem={tokenItem}
                            loadingScriptTokenId={loadingScriptTokenId}
                            onOpenScript={openScriptDialog}
                            onEdit={openEditToken}
                            onDelete={setTokenToDelete}
                            dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />}
                            sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                          />
                        </div>
                      )}
                    </SortableItem>
                  ))}
                </div>
              </SortableReorderContext>
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[44px]" />
                      <TableHead>Token</TableHead>
                      <TableHead className="hidden sm:table-cell">{translateText("描述")}</TableHead>
                      <TableHead>{translateText("主机状态")}</TableHead>
                      <TableHead>{translateText("对应主机")}</TableHead>
                      <TableHead className="hidden md:table-cell">{translateText("创建时间")}</TableHead>
                      <TableHead className="text-right">{translateText("操作")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <SortableReorderContext sortable={tokenSortable} ids={displayedTokenItems.map((tokenItem: any) => Number(tokenItem.id))} strategy="vertical" restrictToList>
                  <TableBody>
                    {displayedTokenItems.map((tokenItem: any) => (
                      <SortableItem key={tokenItem.id} id={Number(tokenItem.id)} disabled={tokenSortable.disabled} itemKind="row">
                        {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                      <TableRow
                        {...itemProps}
                        className={cn(
                          "group/sortable",
                          isDragging && "opacity-55 ring-1 ring-primary/35",
                          isDropTarget && "ring-1 ring-primary/45",
                        )}
                      >
                        <TableCell className="w-[44px] px-2">
                          <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={tokenReorderPending} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <code className="text-xs bg-muted/40 px-2 py-1 rounded font-mono">
                              {tokenItem.token}
                            </code>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-sm text-muted-foreground">{tokenItem.description || "-"}</span>
                        </TableCell>
                        <TableCell>
                          <TokenStatusBadge tokenItem={tokenItem} />
                        </TableCell>
                        <TableCell>
                          <TokenHostInfo tokenItem={tokenItem} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {new Date(tokenItem.createdAt).toLocaleString(getFormatLocale())}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <TokenActionButtons
                            tokenItem={tokenItem}
                            loadingScriptTokenId={loadingScriptTokenId}
                            onOpenScript={openScriptDialog}
                            onEdit={openEditToken}
                            onDelete={setTokenToDelete}
                          />
                        </TableCell>
                      </TableRow>
                        )}
                      </SortableItem>
                    ))}
                  </TableBody>
                  </SortableReorderContext>
                </Table>
              </div>
              </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="h-16 w-16 rounded-2xl bg-muted/30 flex items-center justify-center mb-4">
                <Key className="h-8 w-8 opacity-40" />
              </div>
              <p className="text-lg font-medium">{isTextFiltered && tokenItems.length > 0 ? translateText("未找到匹配 Token") : translateText("暂无 Token")}</p>
              <p className="text-sm mt-1 text-muted-foreground/80">
                {isTextFiltered && tokenItems.length > 0 ? translateText("调整筛选内容或清空搜索") : translateText("添加主机后会生成 Agent 安装命令")}
              </p>
              {showCreateButton && (
                <Button
                  onClick={openCreateDialog}
                  variant="outline"
                  className="mt-4 gap-2"
                >
                  <Plus className="h-4 w-4" />{translateText("添加主机")}</Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      </>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateText("添加主机")}</DialogTitle>
            <DialogDescription>
              {registrationMode === "batch"
                ? translateText("生成一个可在有效期内注册多台 Agent 的批量注册密钥。")
                : translateText("先生成 Agent 安装 Token，再复制命令到目标主机执行。")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{translateText("描述（可选）")}</Label>
              <Input
                placeholder={registrationMode === "batch" ? translateText("例如：生产节点批量注册") : translateText("例如: 香港节点 Agent")}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
              <div className="min-w-0">
                <Label className="text-sm font-medium">{translateText("批量注册")}</Label>
                <p className="mt-1 text-xs text-muted-foreground">{translateText("允许使用同一注册密钥添加多台独立主机")}</p>
              </div>
              <Switch checked={registrationMode === "batch"} onCheckedChange={(checked) => setRegistrationMode(checked ? "batch" : "single")} />
            </div>
            {registrationMode === "batch" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{translateText("最大注册数量（0 = 不限）")}</Label>
                  <Input type="number" min={0} max={1000} value={batchRegistrationLimit} onChange={(event) => setBatchRegistrationLimit(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{translateText("有效期（天，0 = 不限）")}</Label>
                  <Input type="number" min={0} max={365} value={batchRegistrationExpiryDays} onChange={(event) => setBatchRegistrationExpiryDays(event.target.value)} />
                </div>
              </div>
            )}
            {registrationMode === "batch" && DEV_ENROLLMENT_PREVIEW_ENABLED && (
              <Alert className="border-primary/25 bg-primary/5">
                <Users className="h-4 w-4" />
                <AlertTitle>{translateText("开发环境预览")}</AlertTitle>
                <AlertDescription>{translateText("页面保留演示卡片用于预览；新建批量注册会写入真实密钥，注册的主机会正常出现在主机管理。")}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{translateText("取消")}</Button>
            <Button
              onClick={() => registrationMode === "batch" ? createEnrollment() : createTokenMutation.mutate({ description: description || undefined })}
              disabled={registrationMode === "batch" ? createEnrollmentMutation.isPending : createTokenMutation.isPending}
            >{registrationMode === "batch" ? translateText("生成批量注册密钥") : translateText("生成安装命令")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedEnrollment} onOpenChange={(open) => !open && setSelectedEnrollment(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />{translateText("批量注册主机")}
            </DialogTitle>
            <DialogDescription>
              {selectedEnrollment
                ? `${selectedEnrollment.description} · ${selectedEnrollment.usedRegistrations} / ${selectedEnrollment.maxRegistrations > 0 ? selectedEnrollment.maxRegistrations : translateText("不限")}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
            {selectedEnrollment?.hosts.length ? selectedEnrollment.hosts.map((host) => (
              <div key={host.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-muted/15 px-3 py-2.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", host.online ? "bg-chart-2" : "bg-muted-foreground/40")} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={host.name}>{host.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={host.address}>{host.address}</p>
                </div>
                <Badge variant={host.online ? "default" : "secondary"} className="shrink-0">{host.online ? translateText("在线") : translateText("离线")}</Badge>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={translateText("编辑主机信息")}
                    aria-label={translateText("编辑主机信息")}
                    onClick={() => selectedEnrollment && openEditEnrollmentHost(selectedEnrollment, host)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    title={translateText("移出批量注册")}
                    aria-label={translateText("移出批量注册")}
                    onClick={() => selectedEnrollment && void removeEnrollmentHost(selectedEnrollment, host)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )) : (
              <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-sm text-muted-foreground">{translateText("还没有注册主机")}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedEnrollment(null)}>{translateText("关闭")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingEnrollmentHost} onOpenChange={(open) => !open && setEditingEnrollmentHost(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{translateText("编辑批量注册主机")}</DialogTitle>
            <DialogDescription>{translateText("这里只修改主机名称，主机地址由 Agent 上报且不可编辑。")}</DialogDescription>
          </DialogHeader>
          {editingEnrollmentHost && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="enrollment-host-name">{translateText("主机名称")}</Label>
                <Input id="enrollment-host-name" value={editingEnrollmentHost.name} onChange={(event) => setEditingEnrollmentHost((current) => current ? { ...current, name: event.target.value } : current)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditingEnrollmentHost(null)}>{translateText("取消")}</Button>
            <Button type="button" onClick={saveEditEnrollmentHost}>{translateText("保存")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingEnrollment} onOpenChange={(open) => !open && setEditingEnrollment(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateText("编辑批量注册")}</DialogTitle>
            <DialogDescription>{translateText("开发环境预览中的批量注册信息")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{translateText("描述（可选）")}</Label>
              <Input value={editEnrollmentDescription} onChange={(event) => setEditEnrollmentDescription(event.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                  <Label>{translateText("最大注册数量（0 = 不限）")}</Label>
                  <Input type="number" min={0} max={1000} value={editEnrollmentLimit} onChange={(event) => setEditEnrollmentLimit(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{translateText("有效期（天，0 = 不限）")}</Label>
                <Input type="number" min={0} max={365} value={editEnrollmentExpiryDays} onChange={(event) => setEditEnrollmentExpiryDays(event.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEnrollment(null)}>{translateText("取消")}</Button>
            <Button onClick={saveEditEnrollment}>{translateText("保存")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!enrollmentCommand} onOpenChange={(open) => !open && setEnrollmentCommand(null)}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />{translateText("批量注册命令")}
            </DialogTitle>
            <DialogDescription>{translateText("在目标主机执行安装命令；升级和卸载命令可用于已注册的批量主机。")}</DialogDescription>
          </DialogHeader>
          {enrollmentCommand && (
            <div className="space-y-4">
              <CommandRow
                label={translateText("安装命令")}
                command={getAgentScriptCommand(`install ${enrollmentCommand.token}`)}
                onCopy={() => copyToClipboard(getAgentScriptCommand(`install ${enrollmentCommand.token}`))}
              />
              <CommandRow
                label={translateText("卸载命令")}
                command={getUninstallCommand()}
                onCopy={() => copyToClipboard(getUninstallCommand())}
              />
              <CommandRow
                label={translateText("升级命令")}
                command={getUpgradeCommand()}
                onCopy={() => copyToClipboard(getUpgradeCommand())}
              />
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setEnrollmentCommand(null)}>{translateText("关闭")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewToken} onOpenChange={setShowNewToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-chart-2" />{translateText("安装命令已生成")}</DialogTitle>
            <DialogDescription>{translateText("在目标主机执行命令；Agent 上线后会出现在主机列表。")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <InstallAddressSelector
              options={installAddressOptions}
              selectedId={installAddressMode}
              onChange={setInstallAddressMode}
            />
            {panelUrlUsesLoopback && (
              <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{translateText("当前安装地址是本机回环地址")}</AlertTitle>
                <AlertDescription>{translateText("localhost、127.0.0.1 和 ::1 指向的是 Agent 所在的机器，装到其他主机上连不上面板，装在面板本机也可能不上线。请先在系统设置里填写面板公开地址，或用实际 IP、域名打开面板后再复制命令。")}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <p className="text-sm font-medium">{translateText("快速安装命令：")}</p>
              <div className="p-3 rounded-lg bg-background/50 border">
                <code className="text-xs font-mono break-all">
                  {getInstallCommand(newToken)}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={() => copyInstallCommand(newToken)}
              >
                <Copy className="h-3 w-3" />{translateText("复制安装命令")}</Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setShowNewToken(false)}>{translateText("确定")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingToken} onOpenChange={(open) => {
        if (!open) {
          setEditingToken(null);
          setEditDescription("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateText("编辑 Token 备注")}</DialogTitle>
            <DialogDescription>{translateText("备注会作为新主机默认名称。")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{translateText("备注")}</Label>
            <Input
              value={editDescription}
              maxLength={200}
              placeholder={translateText("例如：香港节点 Agent")}
              onChange={(event) => setEditDescription(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingToken(null)}>{translateText("取消")}</Button>
            <Button
              disabled={updateTokenMutation.isPending || !editingToken}
              onClick={() => updateTokenMutation.mutate({
                id: editingToken.id,
                description: editDescription.trim() || null,
              })}
            >{translateText("保存")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!tokenToDelete} onOpenChange={(open) => !open && setTokenToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />{translateText("删除 Agent Token")}</DialogTitle>
            <DialogDescription>{translateText("删除后该 Token 将失效；如果关联主机没有转发规则、转发组或隧道引用，会同步从主机管理中移除。")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-sm">
            <div className="font-mono break-all">{tokenToDelete?.token}</div>
            {tokenToDelete?.description && (
              <div className="mt-2 text-xs text-muted-foreground">{tokenToDelete.description}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenToDelete(null)}>{translateText("取消")}</Button>
            <Button
              variant="destructive"
              disabled={deleteTokenMutation.isPending || !tokenToDelete}
              onClick={() => {
                if (!tokenToDelete) return;
                const id = tokenToDelete.id;
                setTokenToDelete(null);
                deleteTokenMutation.mutate({ id });
              }}
            >{translateText("确认删除")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showScript} onOpenChange={(open) => {
        setShowScript(open);
        if (!open) setScriptPanelUrl("");
        if (!open) setScriptToken("");
      }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[42rem] sm:w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />{translateText("安装命令")}</DialogTitle>
            <DialogDescription>{translateText("使用 root 执行命令。")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {scriptPanelUrl ? (
              <div className="min-w-0 space-y-1 rounded-md bg-muted/35 px-3 py-2 text-sm">
                <span className="text-muted-foreground">{translateText("Agent 面板连接地址")}</span>
                <div className="break-all font-mono text-xs">{scriptPanelUrl}</div>
              </div>
            ) : <InstallAddressSelector options={installAddressOptions} selectedId={installAddressMode} onChange={setInstallAddressMode} />}
            {panelUrlUsesLoopback && (
              <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{translateText("当前安装地址是本机回环地址")}</AlertTitle>
                <AlertDescription>{translateText("localhost、127.0.0.1 和 ::1 指向的是 Agent 所在的机器，装到其他主机上连不上面板，装在面板本机也可能不上线。请先在系统设置里填写面板公开地址，或用实际 IP、域名打开面板后再复制命令。")}</AlertDescription>
              </Alert>
            )}
            <CommandRow
              label={translateText("安装命令")}
              command={scriptToken ? getInstallCommand(scriptToken) : ""}
              copyDisabled={!scriptToken}
              onCopy={() => scriptToken && copyInstallCommand(scriptToken)}
            />
            <CommandRow
              label={translateText("卸载命令")}
              command={getUninstallCommand()}
              onCopy={() => copyToClipboard(getUninstallCommand())}
            />
            <CommandRow
              label={translateText("升级命令")}
              command={getUpgradeCommand()}
              onCopy={() => copyToClipboard(getUpgradeCommand())}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowScript(false);
              setScriptToken("");
            }}>{translateText("关闭")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!reuseInstall} onOpenChange={(open) => { if (!open) setReuseInstall(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{translateText("此 Token 已关联 Agent")}</DialogTitle>
            <DialogDescription>
              {translateText("已关联主机：{0}（{1}）。", [reuseInstall?.hostName || "", reuseInstall?.online ? translateText("在线") : translateText("离线")])}
              {translateText("继续安装将由新 Agent 接管该主机及规则。旧 Agent 停止面板同步，已有转发保留运行；如需管理两台主机，请新建 Token。")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReuseInstall(null)}>{translateText("取消")}</Button>
            <Button onClick={() => {
              if (reuseInstall) void copyToClipboard(reuseInstall.command);
              setReuseInstall(null);
            }}>{translateText("确认并复制")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

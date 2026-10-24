import { getFormatLocale } from "@/i18n";
import { t as translateText } from "@/i18n";
import DashboardLayout from "@/components/DashboardLayout";
import UserSelect from "@/components/UserSelect";
import { PersistentPagination, usePersistentPageRequest, useServerPagination } from "@/components/PersistentPagination";
import { PlanManagementSettings } from "@/components/PlanManagementSettings";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import TrafficBillingConfigManager from "@/components/TrafficBillingConfigManager";
import { PlanDetails } from "@/components/PlanDetails";
import { ProductStockBadge, ProductStockField } from "@/components/ProductStock";
import { PlanDescriptionEditor } from "@/components/PlanDescriptionEditor";
import { useUrlTab } from "@/hooks/useUrlTab";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { planDescription, planDescriptionTemplate } from "@/lib/planDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatTrafficMultiplier } from "@shared/trafficMultiplier";
import { CheckCircle2, Coins, Package, Pencil, Plus, RefreshCw, Settings2, ShoppingBag, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "@/lib/localizedToast";

type PlanForm = {
  stockLimit: string;
  id?: number;
  name: string;
  description: string;
  price: string;
  currency: string;
  durationDays: string;
  portCount: string;
  trafficGB: string;
  rateLimitMbps: string;
  maxRules: string;
  maxConnections: string;
  maxIPs: string;
  isActive: boolean;
  isStoreVisible: boolean;
  syncExistingSubscribers: boolean;
  sortOrder: string;
  hostIds: number[];
  tunnelIds: number[];
  forwardGroupIds: number[];
  trafficAddons: TrafficAddonForm[];
};

type TrafficAddonForm = {
  trafficGB: string;
  price: string;
  isActive: boolean;
  sortOrder: string;
};

type PlanDurationDays = 30 | 90 | 180 | 365 | 730;
type AssignDurationDays = 0 | 30 | 90 | 180;
type PlanManageTab = "plans" | "billing";
type PlanDialogTab = "settings" | "resources";
type PlanResourceKey = "hostIds" | "tunnelIds" | "forwardGroupIds";
type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type PlanResourcePart = { label: string; count: number };
const PLAN_MANAGE_TABS = ["plans", "billing"] as const;
const PLAN_MANAGE_TAB_ITEMS = [
  { value: "plans", label: translateText("订阅套餐"), icon: Package },
  { value: "billing", label: translateText("按量计费资源"), icon: Coins },
] as const satisfies readonly SlidingTabItem<PlanManageTab>[];
const PLAN_MANAGE_TAB_STORAGE_KEY = "forwardx.plans.tab";

const emptyForm: PlanForm = {
  stockLimit: "0",
  name: "",
  description: "",
  price: "0",
  currency: "CNY",
  durationDays: "30",
  portCount: "20",
  trafficGB: "0",
  rateLimitMbps: "0",
  maxRules: "20",
  maxConnections: "2000",
  maxIPs: "10",
  isActive: true,
  isStoreVisible: true,
  syncExistingSubscribers: true,
  sortOrder: "0",
  hostIds: [],
  tunnelIds: [],
  forwardGroupIds: [],
  trafficAddons: [],
};

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat(getFormatLocale(), { style: "currency", currency }).format((cents || 0) / 100);
}

function bytes(size?: number | null) {
  const value = Number(size || 0);
  if (!value) return translateText("不限");
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx++;
  }
  return `${n >= 10 || idx === 0 ? n.toFixed(0) : n.toFixed(2)} ${units[idx]}`;
}

function speed(value?: number | null) {
  const num = Number(value || 0);
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : translateText("不限");
}

const durationOptions = [
  { value: "30", label: translateText("一个月") },
  { value: "90", label: translateText("三个月") },
  { value: "180", label: translateText("半年") },
  { value: "365", label: translateText("一年") },
  { value: "730", label: translateText("两年") },
];

const assignMonthlyDurationOptions = [
  { value: "30", label: translateText("一个月") },
  { value: "90", label: translateText("三个月") },
  { value: "180", label: translateText("半年") },
  { value: "0", label: translateText("永久") },
];

function durationLabel(days?: number | null) {
  if (Number(days) === 0) return translateText("永久");
  return durationOptions.find((item) => Number(item.value) === Number(days))?.label || translateText("{0} 天", [days || 30]);
}

function MobileInfoRow({
  label,
  children,
  valueClassName = "",
}: {
  label: string;
  children: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="grid grid-cols-[4.75rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className={`min-w-0 text-right break-words ${valueClassName}`}>{children}</div>
    </div>
  );
}

function PlanStatusQuickToggle({
  plan,
  disabled,
  onToggleActive,
  onToggleStoreVisible,
  align = "left",
}: {
  plan: any;
  disabled?: boolean;
  onToggleActive: () => void;
  onToggleStoreVisible: () => void;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${align === "right" ? "justify-end" : ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onToggleActive}
        className={cn(
          "h-7 rounded-full border px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
          plan.isActive
            ? "border-primary bg-primary text-primary-foreground shadow-sm"
            : "border-border/60 bg-background/70 text-muted-foreground hover:border-primary/45 hover:text-foreground",
        )}
      >
        {plan.isActive ? translateText("启用") : translateText("停用")}
      </button>
      <button
        type="button"
        disabled={disabled || !plan.isActive}
        onClick={onToggleStoreVisible}
        className={cn(
          "h-7 rounded-full border px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-60",
          plan.isActive && plan.isStoreVisible
            ? "border-emerald-500/50 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300"
            : "border-border/60 bg-background/70 text-muted-foreground hover:border-emerald-500/35 hover:text-foreground",
        )}
      >
        {plan.isActive && plan.isStoreVisible ? translateText("商店展示") : translateText("后台分配")}
      </button>
    </div>
  );
}

function PlanCard({
  plan,
  resourceParts,
  onEdit,
  onDelete,
  toggling,
  onToggleActive,
  onToggleStoreVisible,
  dragHandle,
  isDragging,
}: {
  plan: any;
  resourceParts: PlanResourcePart[];
  onEdit: () => void;
  onDelete: () => void;
  toggling?: boolean;
  onToggleActive: () => void;
  onToggleStoreVisible: () => void;
  dragHandle?: ReactNode;
  isDragging?: boolean;
}) {
  return (
    <div className="pearl-hover-card rounded-lg border border-border/50 bg-background/40 p-3" style={isDragging ? { transform: "none" } : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{plan.name}</p>
          {!planDescription(plan) && <p className="mt-1 break-words text-xs text-muted-foreground">{translateText("无描述")}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {dragHandle}
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={onEdit} title={translateText("编辑套餐")} aria-label={translateText("编辑套餐")}><Pencil className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete} title={translateText("删除")} aria-label={translateText("删除")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
        <ProductStockBadge product={plan} />
        <PlanDetails description={plan.description}>
        <MobileInfoRow label={translateText("价格")}>{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</MobileInfoRow>
        <MobileInfoRow label={translateText("资源")}>
          <div className="flex flex-wrap justify-end gap-1">
            {resourceParts.map((item) => (
              <Badge key={item.label} variant="outline">{item.label} {item.count}</Badge>
            ))}
          </div>
        </MobileInfoRow>
        <MobileInfoRow label={translateText("端口")}>{plan.portCount}{translateText(" 个端口")}</MobileInfoRow>
        <MobileInfoRow label={translateText("规则/流量")}>{translateText("规则 ")}{plan.maxRules || translateText("不限")}{translateText(" · 流量 ")}{bytes(plan.trafficLimit)}</MobileInfoRow>
        <MobileInfoRow label={translateText("连接/IP")}>{translateText("连接 ")}{plan.maxConnections || translateText("不限")}{translateText(" · 单 IP ")}{plan.maxIPs || translateText("不限")}</MobileInfoRow>
        <MobileInfoRow label={translateText("限速")}>{speed(plan.rateLimitMbps)}</MobileInfoRow>
        <MobileInfoRow label={translateText("附加流量")}>{plan.trafficAddons?.length || 0}{translateText(" 档")}</MobileInfoRow>
        </PlanDetails>
        <MobileInfoRow label={translateText("状态")}>
          <PlanStatusQuickToggle
            plan={plan}
            disabled={toggling}
            align="right"
            onToggleActive={onToggleActive}
            onToggleStoreVisible={onToggleStoreVisible}
          />
        </MobileInfoRow>
      </div>
    </div>
  );
}

function hostTitle(host: any) {
  return host?.name || host?.ip || host?.ipv4 || host?.ipv6 || translateText("主机 #{0}", [host?.id || "-"]);
}

function hostMeta(host: any) {
  return Array.from(new Set([host?.ip, host?.ipv4, host?.ipv6].filter(Boolean))).join(" / ");
}

function forwardGroupMode(group: any): ForwardGroupMode {
  const mode = String(group?.groupMode || "failover");
  return mode === "port" || mode === "failover" || mode === "chain" || mode === "entry" || mode === "exit"
    ? mode
    : "failover";
}

function isPortForwardGroup(group: any) {
  return forwardGroupMode(group) === "port";
}

function isChainForwardGroup(group: any) {
  return forwardGroupMode(group) === "chain";
}

function isStandardForwardGroup(group: any) {
  return forwardGroupMode(group) === "failover";
}

function forwardGroupTypeText(group: any) {
  const mode = forwardGroupMode(group);
  if (mode === "port") return translateText("端口转发");
  if (mode === "chain") return translateText("转发链");
  if (mode === "entry") return translateText("入口组");
  if (mode === "exit") return translateText("出口组");
  if (group?.groupType === "tunnel") return translateText("隧道转发组");
  return translateText("转发组");
}

function planResourcePartsForDisplay(plan: any, forwardGroupMap: Map<number, any>): PlanResourcePart[] {
  const counts = {
    legacyHosts: Number(plan?.hostIds?.length || 0),
    ports: 0,
    tunnels: Number(plan?.tunnelIds?.length || 0),
    chains: 0,
    groups: 0,
    otherForwardResources: 0,
  };
  const refs = Array.isArray(plan?.forwardGroupRefs) && plan.forwardGroupRefs.length > 0
    ? plan.forwardGroupRefs
    : (Array.isArray(plan?.forwardGroupIds) ? plan.forwardGroupIds : []).map((id: number) => ({ id }));

  for (const ref of refs) {
    const id = Number(typeof ref === "object" ? ref.id : ref);
    const group = forwardGroupMap.get(id) || ref;
    if (isPortForwardGroup(group)) {
      counts.ports += 1;
    } else if (isChainForwardGroup(group)) {
      counts.chains += 1;
    } else if (isStandardForwardGroup(group)) {
      counts.groups += 1;
    } else {
      counts.otherForwardResources += 1;
    }
  }

  return [
    { label: translateText("端口转发"), count: counts.ports },
    { label: translateText("隧道"), count: counts.tunnels },
    { label: translateText("转发链"), count: counts.chains },
    { label: translateText("转发组"), count: counts.groups },
    { label: translateText("历史主机"), count: counts.legacyHosts },
    { label: translateText("转发资源"), count: counts.otherForwardResources },
  ].filter((item) => item.count > 0);
}

function selectedResourceItems(ids: number[], items: any[], fallbackType: string) {
  return ids
    .map(Number)
    .filter(Boolean)
    .map((id) => items.find((item: any) => Number(item.id) === id) || { id, missing: true, name: `${fallbackType} #${id}` });
}

function missingResourceHint(item: any) {
  return item?.missing ? translateText("资源不存在或已删除，可删除清理") : "";
}

function planResourceStatusTone(type: "host" | "tunnel" | "forward_group", item: any) {
  if (!item || item.missing) return "offline";
  if (type === "host") return item.isOnline ? "online" : "offline";
  if (type === "tunnel") {
    if (item.isRunning) return "online";
    if (item.isEnabled) return "warning";
    return "offline";
  }
  if (item.isEnabled === false) return "offline";
  if (String(item.lastStatus || "").toLowerCase() === "error") return "offline";
  if (item.latestLatencyIsTimeout) return "warning";
  return "online";
}

function PlanResourceStatusDot({ tone }: { tone: string }) {
  const className = tone === "online"
    ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]"
    : tone === "warning"
    ? "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.18)]"
    : "bg-muted-foreground/35";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />;
}

function PlanResourceOption({
  type,
  item,
  hosts,
  title,
  kind,
  meta,
  showMultiplier = true,
}: {
  type: "host" | "tunnel" | "forward_group";
  item: any;
  hosts: any[];
  title: string;
  kind: string;
  meta?: string;
  showMultiplier?: boolean;
}) {
  const multiplier = type === "host" || !showMultiplier ? null : formatTrafficMultiplier(item?.trafficMultiplier ?? 100);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PlanResourceStatusDot tone={planResourceStatusTone(type, item)} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 rounded border border-border/60 bg-background/70 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">{kind}</span>
          {multiplier ? (
            <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-emerald-700 dark:text-emerald-300">
              {multiplier}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{missingResourceHint(item) || meta || (type === "tunnel" ? getTunnelRouteText(item, hosts) : kind)}</p>
      </div>
    </div>
  );
}

function PlanResourcePicker({
  title,
  countText,
  loading,
  loadingLabel,
  selectedItems,
  availableItems,
  addPlaceholder,
  emptyText,
  allAddedText,
  onAdd,
  onRemove,
  getId,
  renderOption,
  renderSelected,
}: {
  title: string;
  countText: string;
  loading: boolean;
  loadingLabel: string;
  selectedItems: any[];
  availableItems: any[];
  addPlaceholder: string;
  emptyText: string;
  allAddedText: string;
  onAdd: (id: string) => void;
  onRemove: (id: number) => void;
  getId: (item: any) => number;
  renderOption: (item: any) => ReactNode;
  renderSelected: (item: any) => ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-medium">{title}</Label>
        <Badge variant="outline" className="h-6 shrink-0 rounded-full px-2 text-xs">{countText}</Badge>
      </div>
      {loading ? (
        <DataSectionLoading label={loadingLabel} minHeight="min-h-[84px]" />
      ) : (
        <>
          {selectedItems.length > 0 ? (
            <div className="space-y-1.5">
              {selectedItems.map((item) => (
                <div key={getId(item)} className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                  <div className="min-w-0 flex-1">{renderSelected(item)}</div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-destructive"
                    title={translateText("删除")}
                    onClick={() => onRemove(getId(item))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
              {emptyText}
            </div>
          )}
          <Select value="" onValueChange={onAdd} disabled={availableItems.length === 0}>
            <SelectTrigger>
              <SelectValue placeholder={availableItems.length > 0 ? addPlaceholder : allAddedText} />
            </SelectTrigger>
            <SelectContent>
              {availableItems.length === 0 ? (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">{allAddedText}</div>
              ) : availableItems.map((item) => (
                <SelectItem key={getId(item)} value={String(getId(item))}>
                  {renderOption(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}

function PlanSelectedResourceList({
  title,
  countText,
  selectedItems,
  emptyText,
  note,
  onRemove,
  getId,
  renderSelected,
}: {
  title: string;
  countText: string;
  selectedItems: any[];
  emptyText: string;
  note?: string;
  onRemove: (id: number) => void;
  getId: (item: any) => number;
  renderSelected: (item: any) => ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-medium">{title}</Label>
        <Badge variant="outline" className="h-6 shrink-0 rounded-full px-2 text-xs">{countText}</Badge>
      </div>
      {selectedItems.length > 0 ? (
        <div className="space-y-1.5">
          {selectedItems.map((item) => (
            <div key={getId(item)} className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
              <div className="min-w-0 flex-1">{renderSelected(item)}</div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-destructive"
                title={translateText("删除")}
                onClick={() => onRemove(getId(item))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {emptyText}
        </div>
      )}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function toForm(plan: any): PlanForm {
  return {
    stockLimit: String(plan.stockLimit ?? 0),
    id: plan.id,
    name: plan.name || "",
    description: plan.description || "",
    price: String((Number(plan.priceCents || 0) / 100).toFixed(2)),
    currency: plan.currency || "CNY",
    durationDays: String(plan.durationDays ?? 30),
    portCount: String(plan.portCount ?? 20),
    trafficGB: String(Number(plan.trafficLimit || 0) / 1024 / 1024 / 1024 || 0),
    rateLimitMbps: String(Number(plan.rateLimitMbps || 0) || 0),
    maxRules: String(plan.maxRules ?? 20),
    maxConnections: String(plan.maxConnections ?? 2000),
    maxIPs: String(plan.maxIPs ?? 10),
    isActive: !!plan.isActive,
    isStoreVisible: !!plan.isStoreVisible,
    syncExistingSubscribers: true,
    sortOrder: String(plan.sortOrder ?? 0),
    hostIds: plan.hostIds || [],
    tunnelIds: plan.tunnelIds || [],
    forwardGroupIds: plan.forwardGroupIds || [],
    trafficAddons: (plan.trafficAddons || []).map((addon: any, index: number) => ({
      trafficGB: String(Number(addon.trafficBytes || 0) / 1024 / 1024 / 1024 || 0),
      price: String((Number(addon.priceCents || 0) / 100).toFixed(2)),
      isActive: addon.isActive !== false,
      sortOrder: String(addon.sortOrder ?? index),
    })),
  };
}

function payload(form: PlanForm) {
  const durationDays = Number(form.durationDays || 30);
  return {
    stockLimit: Number(form.stockLimit || 0),
    name: form.name.trim(),
    description: form.description.trim() || null,
    priceCents: Math.round(Number(form.price || 0) * 100),
    currency: (form.currency || "CNY").toUpperCase(),
    durationDays: ([30, 90, 180, 365, 730].includes(durationDays) ? durationDays : 30) as PlanDurationDays,
    portCount: Math.max(1, Math.floor(Number(form.portCount || 1))),
    trafficLimit: Math.max(0, Math.floor(Number(form.trafficGB || 0) * 1024 * 1024 * 1024)),
    rateLimitMbps: Math.max(0, Math.floor(Number(form.rateLimitMbps || 0))),
    maxRules: Math.max(0, Math.floor(Number(form.maxRules || 0))),
    maxConnections: Math.max(0, Math.floor(Number(form.maxConnections || 0))),
    maxIPs: Math.max(0, Math.floor(Number(form.maxIPs || 0))),
    isActive: form.isActive,
    isStoreVisible: form.isActive && form.isStoreVisible,
    sortOrder: Math.max(0, Math.floor(Number(form.sortOrder || 0))),
    hostIds: form.hostIds,
    tunnelIds: form.tunnelIds,
    forwardGroupIds: form.forwardGroupIds,
    trafficAddons: form.trafficAddons
      .map((addon, index) => ({
        trafficBytes: Math.max(0, Math.floor(Number(addon.trafficGB || 0) * 1024 * 1024 * 1024)),
        priceCents: Math.max(0, Math.round(Number(addon.price || 0) * 100)),
        isActive: addon.isActive,
        sortOrder: Math.max(0, Math.floor(Number(addon.sortOrder || index))),
      }))
      .filter((addon) => addon.trafficBytes > 0),
  };
}

export default function Plans() {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [editing, setEditing] = useState(false);
  const [planDialogTab, setPlanDialogTab] = useState<PlanDialogTab>("settings");
  const [assignOpen, setAssignOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignPlanId, setAssignPlanId] = useState("");
  const [assignDurationDays, setAssignDurationDays] = useState("30");
  const [activeTab, setActiveTab] = useUrlTab<PlanManageTab>({
    values: PLAN_MANAGE_TABS,
    defaultValue: "plans",
    storageKey: PLAN_MANAGE_TAB_STORAGE_KEY,
  });
  const [billingCreateRequestKey, setBillingCreateRequestKey] = useState(0);
  const [statusUpdatingPlanId, setStatusUpdatingPlanId] = useState<number | null>(null);

  const planPageRequest = usePersistentPageRequest("forwardx.plans.page");
  const planPageInput = { page: planPageRequest.page, pageSize: 12 } as const;
  const planPageQuery = trpc.plans.listPage.useQuery(planPageInput, {
    enabled: activeTab === "plans",
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
  const plans = (planPageQuery.data?.items || []) as any[];
  const isLoading = planPageQuery.isLoading;
  const planPagination = useServerPagination(
    plans,
    Number(planPageQuery.data?.totalItems || 0),
    planPageRequest,
    { pageSize: 12, isReady: !isLoading && !!planPageQuery.data },
  );
  const planOrder = useOptimisticSortableOrder({ items: plans, getId: (plan: any) => Number(plan.id) });
  const reorderPlans = trpc.plans.reorder.useMutation({
    onError: (error) => toast.error(error.message || translateText("保存失败")),
  });
  const planSortDisabled = planPageQuery.isPlaceholderData || reorderPlans.isPending || plans.length < 2;
  const planSortable = useSortableReorder({
    items: planOrder.items,
    getId: (plan: any) => Number(plan.id),
    disabled: planSortDisabled,
    onReorder: (nextPlans) => {
      const requestId = planOrder.begin(nextPlans);
      reorderPlans.mutate({
        ids: nextPlans.map((plan: any) => Number(plan.id)),
        startIndex: (planPagination.currentPage - 1) * planPagination.pageSize,
      }, {
        onError: () => planOrder.release(requestId),
        onSettled: () => planOrder.resync(requestId, () => Promise.all([
          utils.plans.list.invalidate(), utils.plans.listPage.invalidate(),
          utils.plans.options.invalidate(), utils.plans.storeList.invalidate(),
        ])),
      });
    },
  });

  const storeStatusQuery = trpc.plans.storeStatus.useQuery(undefined, { enabled: settingsOpen });
  const needsPlanResourceOptions = editing && planDialogTab === "resources";
  const { data: hosts = [], isLoading: hostsLoading } = trpc.hosts.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: tunnels = [], isLoading: tunnelsLoading } = trpc.tunnels.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: forwardGroups = [], isLoading: forwardGroupsLoading } = trpc.forwardGroups.options.useQuery(undefined, {
    enabled: needsPlanResourceOptions,
    staleTime: 30_000,
  });
  const { data: planOptions = [] } = trpc.plans.options.useQuery(undefined, {
    enabled: assignOpen,
    staleTime: 30_000,
  });
  const trafficBillingQuery = trpc.trafficBilling.configs.useQuery(undefined, { enabled: settingsOpen });

  const createPlan = trpc.plans.create.useMutation({
    onSuccess: () => {
      toast.success(translateText("套餐已创建"));
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("创建失败")),
  });

  const updatePlan = trpc.plans.update.useMutation({
    onSuccess: () => {
      toast.success(translateText("套餐已保存"));
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
      utils.plans.storeList.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("保存失败")),
  });

  const updatePlanStatus = trpc.plans.updateStatus.useMutation({
    onMutate: async (variables) => {
      setStatusUpdatingPlanId(variables.id);
      await utils.plans.list.cancel();
      const previous = utils.plans.list.getData();
      utils.plans.list.setData(
        undefined,
        (previous || []).map((plan: any) =>
          Number(plan.id) === Number(variables.id)
            ? { ...plan, isActive: variables.isActive, isStoreVisible: variables.isActive && variables.isStoreVisible }
            : plan,
        ) as any,
      );
      return { previous };
    },
    onSuccess: (_result, variables) => {
      toast.success(variables.isActive ? translateText("套餐状态已更新") : translateText("套餐已停用"));
      utils.plans.storeList.invalidate();
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.list.setData(undefined, context.previous as any);
      toast.error(error.message || translateText("状态更新失败"));
    },
    onSettled: () => {
      setStatusUpdatingPlanId(null);
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
      utils.plans.storeList.invalidate();
    },
  });

  const deletePlan = trpc.plans.delete.useMutation({
    onSuccess: () => {
      toast.success(translateText("套餐已删除"));
      utils.plans.list.invalidate();
      utils.plans.listPage.invalidate();
      utils.plans.summary.invalidate();
      utils.plans.options.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("删除失败")),
  });

  const setStoreEnabled = trpc.plans.setStoreEnabled.useMutation({
    onMutate: async ({ enabled }) => {
      await utils.plans.storeStatus.cancel();
      const previous = utils.plans.storeStatus.getData();
      utils.plans.storeStatus.setData(undefined, { enabled });
      return { previous };
    },
    onSuccess: (_result, { enabled }) => {
      utils.plans.storeStatus.setData(undefined, { enabled });
      utils.plans.storeList.invalidate();
      toast.success(enabled ? translateText("套餐商店已开启") : translateText("套餐商店已关闭"));
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.storeStatus.setData(undefined, context.previous);
      toast.error(error.message || translateText("更新失败"));
    },
    onSettled: async () => {
      await utils.plans.storeStatus.invalidate();
    },
  });

  const setTrafficBillingEnabled = trpc.trafficBilling.setEnabled.useMutation({
    onMutate: async ({ enabled }) => {
      await utils.trafficBilling.configs.cancel();
      const previous = utils.trafficBilling.configs.getData();
      utils.trafficBilling.configs.setData(undefined, { ...(previous || { configs: [] }), enabled });
      return { previous };
    },
    onSuccess: (_result, { enabled }) => {
      const current = utils.trafficBilling.configs.getData();
      utils.trafficBilling.configs.setData(undefined, { ...(current || { configs: [] }), enabled });
      utils.trafficBilling.storeResources.invalidate();
      toast.success(enabled ? translateText("按量计费已开启") : translateText("按量计费已关闭"));
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.trafficBilling.configs.setData(undefined, context.previous);
      toast.error(error.message || translateText("更新失败"));
    },
    onSettled: async () => {
      await utils.trafficBilling.configs.invalidate();
    },
  });

  const assignPlan = trpc.plans.assign.useMutation({
    onSuccess: (result) => {
      toast.success(translateText("套餐已分配，端口段 {0}-{1}", [result.portRangeStart, result.portRangeEnd]));
      setAssignOpen(false);
      setAssignUserId("");
      setAssignPlanId("");
      setAssignDurationDays("30");
      utils.plans.subscriptions.invalidate();
      utils.plans.subscriptionsPage.invalidate();
      utils.users.list.invalidate();
      utils.users.options.invalidate();
      utils.users.listPage.invalidate();
    },
    onError: (error) => toast.error(error.message || translateText("分配失败")),
  });

  const forwardGroupMap = useMemo<Map<number, any>>(() => {
    const map = new Map<number, any>();
    for (const plan of plans) {
      for (const ref of Array.isArray(plan?.forwardGroupRefs) ? plan.forwardGroupRefs : []) {
        const id = Number(ref?.id || 0);
        if (id > 0) map.set(id, ref);
      }
    }
    for (const group of forwardGroups) map.set(Number(group.id), group);
    return map;
  }, [forwardGroups, plans]);
  const selectedTunnelIds = useMemo(() => new Set(form.tunnelIds.map(Number)), [form.tunnelIds]);
  const selectedForwardGroupIds = useMemo(() => new Set(form.forwardGroupIds.map(Number)), [form.forwardGroupIds]);
  const portForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isPortForwardGroup(group)), [forwardGroups]);
  const chainForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isChainForwardGroup(group)), [forwardGroups]);
  const standardForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isStandardForwardGroup(group)), [forwardGroups]);
  const selectedHosts = useMemo(() => selectedResourceItems(form.hostIds, hosts, translateText("主机")), [form.hostIds, hosts]);
  const selectedTunnels = useMemo(() => selectedResourceItems(form.tunnelIds, tunnels, translateText("隧道")), [form.tunnelIds, tunnels]);
  const selectedAssignPlan = useMemo(
    () => planOptions.find((plan: any) => Number(plan.id) === Number(assignPlanId)) || null,
    [assignPlanId, planOptions],
  );
  const selectedAssignPlanDurationDays = Number((selectedAssignPlan as any)?.durationDays || 0);
  const assignPlanIsMonthly = selectedAssignPlanDurationDays === 30;
  const selectedPortForwardIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isPortForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedChainForwardIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isChainForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedStandardForwardGroupIds = useMemo(
    () => form.forwardGroupIds.map(Number).filter((id) => isStandardForwardGroup(forwardGroupMap.get(id))),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedOtherForwardResourceIds = useMemo(
    () =>
      form.forwardGroupIds
        .map(Number)
        .filter((id) => {
          const group = forwardGroupMap.get(id);
          return !group || (!isPortForwardGroup(group) && !isChainForwardGroup(group) && !isStandardForwardGroup(group));
        }),
    [form.forwardGroupIds, forwardGroupMap],
  );
  const selectedPortForwards = useMemo(
    () => selectedResourceItems(selectedPortForwardIds, portForwardGroups, translateText("端口转发")),
    [portForwardGroups, selectedPortForwardIds],
  );
  const selectedChains = useMemo(
    () => selectedResourceItems(selectedChainForwardIds, chainForwardGroups, translateText("转发链")),
    [chainForwardGroups, selectedChainForwardIds],
  );
  const selectedManagedForwardGroups = useMemo(
    () => selectedResourceItems(selectedStandardForwardGroupIds, standardForwardGroups, translateText("转发组")),
    [selectedStandardForwardGroupIds, standardForwardGroups],
  );
  const selectedOtherForwardResources = useMemo(
    () => selectedResourceItems(selectedOtherForwardResourceIds, forwardGroups, translateText("转发资源")),
    [forwardGroups, selectedOtherForwardResourceIds],
  );
  const availableTunnels = useMemo(() => tunnels.filter((tunnel: any) => !selectedTunnelIds.has(Number(tunnel.id))), [tunnels, selectedTunnelIds]);
  const availablePortForwards = useMemo(
    () => portForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [portForwardGroups, selectedForwardGroupIds],
  );
  const availableChains = useMemo(
    () => chainForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [chainForwardGroups, selectedForwardGroupIds],
  );
  const availableManagedForwardGroups = useMemo(
    () => standardForwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))),
    [selectedForwardGroupIds, standardForwardGroups],
  );

  const openPlanCreate = () => {
    setForm({ ...emptyForm, description: planDescriptionTemplate() });
    setPlanDialogTab("settings");
    setEditing(true);
  };

  const openPlanEdit = (plan: any) => {
    setForm(toForm(plan));
    setPlanDialogTab("settings");
    setEditing(true);
  };
  const openCreate = () => {
    if (activeTab === "billing") {
      setBillingCreateRequestKey((value) => value + 1);
      return;
    }
    openPlanCreate();
  };

  const save = () => {
    if (!form.name.trim()) {
      setPlanDialogTab("settings");
      return toast.error(translateText("请填写套餐名称"));
    }
    if (form.hostIds.length === 0 && form.tunnelIds.length === 0 && form.forwardGroupIds.length === 0) {
      setPlanDialogTab("resources");
      toast.error(translateText("至少选择一个端口转发、隧道、转发链或转发组"));
      return;
    }
    const data = payload(form);
    if (form.id) updatePlan.mutate({ id: form.id, syncExistingSubscribers: form.syncExistingSubscribers, ...data });
    else createPlan.mutate(data);
  };
  const togglePlanActive = (plan: any) => {
    const isActive = !plan.isActive;
    updatePlanStatus.mutate({
      id: Number(plan.id),
      isActive,
      isStoreVisible: isActive ? !!plan.isStoreVisible : false,
    });
  };
  const togglePlanStoreVisible = (plan: any) => {
    if (!plan.isActive) {
      toast.info(translateText("套餐启用后才能开启商店展示"));
      return;
    }
    updatePlanStatus.mutate({
      id: Number(plan.id),
      isActive: true,
      isStoreVisible: !plan.isStoreVisible,
    });
  };
  const submitAssignPlan = () => {
    if (!assignUserId || !assignPlanId) return;
    const durationDays = assignPlanIsMonthly
      ? (Number(assignDurationDays) as AssignDurationDays)
      : undefined;
    assignPlan.mutate({
      userId: Number(assignUserId),
      planId: Number(assignPlanId),
      durationDays,
    });
  };
  const addPlanResource = (key: PlanResourceKey, value: string) => {
    const id = Number(value);
    if (!id) return;
    setForm((current) => {
      const ids = current[key].map(Number);
      if (ids.includes(id)) return current;
      return { ...current, [key]: [...ids, id] };
    });
  };
  const removePlanResource = (key: PlanResourceKey, id: number) => {
    setForm((current) => ({ ...current, [key]: current[key].map(Number).filter((item) => item !== Number(id)) }));
  };
  const updateTrafficAddon = (index: number, patch: Partial<TrafficAddonForm>) => {
    setForm((current) => ({
      ...current,
      trafficAddons: current.trafficAddons.map((addon, addonIndex) => addonIndex === index ? { ...addon, ...patch } : addon),
    }));
  };
  const addTrafficAddon = () => {
    setForm((current) => ({
      ...current,
      trafficAddons: [
        ...current.trafficAddons,
        { trafficGB: "50", price: "10", isActive: true, sortOrder: String(current.trafficAddons.length) },
      ],
    }));
  };
  const removeTrafficAddon = (index: number) => {
    setForm((current) => ({
      ...current,
      trafficAddons: current.trafficAddons.filter((_, addonIndex) => addonIndex !== index),
    }));
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="pearl-page-header flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{translateText("套餐管理")}</h1>
          </div>
          <div className="responsive-actions flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />{translateText("设置")}
            </Button>
            <Button variant="outline" onClick={() => setAssignOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />{translateText(" 手动分配")}</Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> {activeTab === "billing" ? translateText("新增计费资源") : translateText("新增套餐")}
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlanManageTab)} className="space-y-4">
          <SlidingTabsList items={PLAN_MANAGE_TAB_ITEMS} activeValue={activeTab} onValueChange={setActiveTab} ariaLabel={translateText("套餐管理")} minItemWidthRem={9.5} />

          <TabsContent value="plans" className="mt-0 space-y-6">
            <Card>
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" />{translateText(" 套餐列表")}</CardTitle>
                  <CardDescription>{translateText("订阅后分配连续端口段。")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <DataSectionLoading label={translateText("正在加载套餐数据")} />
                ) : (
                  <SortableReorderContext sortable={planSortable} strategy="rect">
                    <div className="standard-card-grid gap-3">
                      {planOrder.items.map((plan: any) => (
                        <SortableItem key={plan.id} id={Number(plan.id)} disabled={planSortDisabled}>
                          {({ itemProps, handleProps, isDragging }) => (
                            <div {...itemProps} className="group/sortable min-w-0">
                              <PlanCard
                                dragHandle={<SortableDragHandle dragHandleProps={handleProps} busy={reorderPlans.isPending} />}
                                isDragging={isDragging}
                                plan={plan}
                                resourceParts={planResourcePartsForDisplay(plan, forwardGroupMap)}
                                toggling={statusUpdatingPlanId === Number(plan.id)}
                                onEdit={() => openPlanEdit(plan)}
                                onDelete={() => deletePlan.mutate({ id: plan.id })}
                                onToggleActive={() => togglePlanActive(plan)}
                                onToggleStoreVisible={() => togglePlanStoreVisible(plan)}
                              />
                            </div>
                          )}
                        </SortableItem>
                      ))}
                      {plans.length === 0 && (
                        <div className="col-span-full rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{translateText("还没有套餐")}</div>
                      )}
                    </div>
                  </SortableReorderContext>
                )}
              </CardContent>
            </Card>
            <PersistentPagination pagination={planPagination} itemName={translateText("个套餐")} />
          </TabsContent>

          <TabsContent value="billing" className="mt-0">
            <TrafficBillingConfigManager
              showHeader={false}
              showEmbeddedHeader={false}
              showSummary={false}
              hideCreateButton
              createRequestKey={billingCreateRequestKey}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{translateText("套餐管理设置")}</DialogTitle>
            <DialogDescription>{translateText("管理商店和按量计费开关，修改后立即生效。")}</DialogDescription>
          </DialogHeader>
          <PlanManagementSettings
            store={{
              enabled: !!storeStatusQuery.data?.enabled,
              unavailable: !storeStatusQuery.data || storeStatusQuery.isError || setStoreEnabled.isPending,
              onChange: (enabled) => setStoreEnabled.mutateAsync({ enabled }),
            }}
            trafficBilling={{
              enabled: !!trafficBillingQuery.data?.enabled,
              unavailable: !trafficBillingQuery.data || trafficBillingQuery.isError || setTrafficBillingEnabled.isPending,
              onChange: (enabled) => setTrafficBillingEnabled.mutateAsync({ enabled }),
            }}
          />
          {(storeStatusQuery.isError || trafficBillingQuery.isError) && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
              <span>{translateText("设置加载失败，请重试")}</span>
              <Button variant="outline" size="sm" onClick={() => {
                void storeStatusQuery.refetch();
                void trafficBillingQuery.refetch();
              }}>{translateText("重试")}</Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>{translateText("关闭")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5">
            <DialogTitle>{form.id ? translateText("编辑套餐") : translateText("新增套餐")}</DialogTitle>
            <DialogDescription>{translateText("配置套餐限制，并绑定订阅后可用资源。")}</DialogDescription>
          </DialogHeader>

          <Tabs value={planDialogTab} onValueChange={(value) => setPlanDialogTab(value as PlanDialogTab)} className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden px-4 sm:px-5">
            <TabsList className="grid h-auto w-full shrink-0 grid-cols-2">
              <TabsTrigger value="settings">{translateText("套餐设置")}</TabsTrigger>
              <TabsTrigger value="resources">{translateText("资源绑定")}</TabsTrigger>
            </TabsList>

            <div className="min-h-0 touch-pan-y overflow-y-auto overscroll-contain pb-1 pr-1 [scrollbar-gutter:stable]">
              <TabsContent value="settings" className="m-0 space-y-4 !animate-none">
                <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 [&>*]:min-w-0">
            <div className="col-span-2 space-y-2 md:col-span-1">
              <Label>{translateText("套餐名称")}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={translateText("例如：基础套餐")} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("价格")}</Label>
              <Input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("有效期")}</Label>
              <Select value={form.durationDays} onValueChange={(durationDays) => setForm({ ...form, durationDays })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {durationOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{translateText("超过一个月按月重置流量。")}</p>
            </div>
            <div className="space-y-2">
              <Label>{translateText("连续端口数")}</Label>
              <Input type="number" min={1} max={1024} value={form.portCount} onChange={(e) => setForm({ ...form, portCount: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("总流量（GB，0 为不限）")}</Label>
              <Input type="number" min={0} value={form.trafficGB} onChange={(e) => setForm({ ...form, trafficGB: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("限速（Mbps，0 为不限）")}</Label>
              <Input type="number" min={0} max={1000000} step={1} value={form.rateLimitMbps} onChange={(e) => setForm({ ...form, rateLimitMbps: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("最大规则数（0 为不限）")}</Label>
              <Input type="number" min={0} value={form.maxRules} onChange={(e) => setForm({ ...form, maxRules: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("最大连接数")}</Label>
              <Input type="number" min={0} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: e.target.value })} />
              <p className="text-xs text-muted-foreground">{translateText("按主机或隧道聚合。")}</p>
            </div>
            <div className="space-y-2">
              <Label>{translateText("单 IP 接入限制")}</Label>
              <Input type="number" min={0} value={form.maxIPs} onChange={(e) => setForm({ ...form, maxIPs: e.target.value })} />
              <p className="text-xs text-muted-foreground">{translateText("同组规则共享限制。")}</p>
            </div>
            <div className="space-y-2">
              <Label>{translateText("排序")}</Label>
              <Input type="number" min={0} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </div>
            <ProductStockField value={form.stockLimit} onChange={(stockLimit) => setForm({ ...form, stockLimit })} />
                </div>

                <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{translateText("套餐状态")}</p>
                      <p className="text-xs text-muted-foreground">{translateText("关闭后该套餐不可购买或分配。")}</p>
                    </div>
                    <Switch
                      className="shrink-0"
                      checked={form.isActive}
                      onCheckedChange={(isActive) => setForm((current) => ({
                        ...current,
                        isActive,
                        isStoreVisible: isActive ? current.isStoreVisible : false,
                      }))}
                    />
                  </div>
                  <div className={`flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2 ${form.isActive ? "" : "opacity-60"}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{translateText("购买入口")}</p>
                      <p className="text-xs text-muted-foreground">{translateText("开启后普通用户可在商店自助购买。")}</p>
                    </div>
                    <Switch
                      className="shrink-0"
                      checked={form.isActive && form.isStoreVisible}
                      disabled={!form.isActive}
                      onCheckedChange={(isStoreVisible) => setForm({ ...form, isStoreVisible })}
                    />
                  </div>
                  {form.id && (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2 sm:col-span-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{translateText("同步已购买用户")}</p>
                        <p className="text-xs text-muted-foreground">{translateText("开启后保存套餐会同步已购买用户的生效权益；关闭后仅影响后续新购或新分配。")}</p>
                      </div>
                      <Switch
                        className="shrink-0"
                        checked={form.syncExistingSubscribers}
                        onCheckedChange={(syncExistingSubscribers) => setForm({ ...form, syncExistingSubscribers })}
                        title={form.syncExistingSubscribers ? translateText("保存后同步已购买该套餐用户的生效权益") : translateText("保存后仅影响后续新购或新分配，已购买用户保持当前权益")}
                      />
                    </div>
                  )}
                </div>

                <PlanDescriptionEditor value={form.description} onChange={(description) => setForm({ ...form, description })} />
              </TabsContent>

              <TabsContent value="resources" className="m-0 space-y-3 !animate-none">
                <div className="space-y-3">
                  {true ? (
                    <>
                      {selectedHosts.length > 0 ? (
                        <PlanSelectedResourceList
                          title={translateText("历史主机绑定（兼容）")}
                          countText={translateText("{0} 台", [selectedHosts.length])}
                          selectedItems={selectedHosts}
                          emptyText={translateText("当前没有历史主机绑定。")}
                          note={translateText("仅用于兼容旧套餐，已不再支持新增主机绑定。")}
                          onRemove={(id) => removePlanResource("hostIds", id)}
                          getId={(host) => Number(host.id)}
                          renderSelected={(host) => (
                            <PlanResourceOption
                              type="host"
                              item={host}
                              hosts={hosts}
                              title={hostTitle(host)}
                              kind={translateText("历史主机")}
                              meta={hostMeta(host)}
                              showMultiplier={false}
                            />
                          )}
                        />
                      ) : null}
                      <PlanResourcePicker
                        title={translateText("端口转发")}
                        countText={translateText("{0} 个", [selectedPortForwards.length])}
                        loading={forwardGroupsLoading}
                        loadingLabel={translateText("正在加载端口转发资源")}
                        selectedItems={selectedPortForwards}
                        availableItems={availablePortForwards}
                        addPlaceholder={translateText("选择要添加的端口转发")}
                        emptyText={translateText("暂未添加端口转发，可从下方选择添加。")}
                        allAddedText={portForwardGroups.length > 0 ? translateText("端口转发已全部添加") : translateText("暂无可添加端口转发")}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("端口转发 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 成员", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("端口转发 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 成员", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title={translateText("隧道转发")}
                        countText={translateText("{0} 条", [form.tunnelIds.length])}
                        loading={tunnelsLoading}
                        loadingLabel={translateText("正在加载隧道资源")}
                        selectedItems={selectedTunnels}
                        availableItems={availableTunnels}
                        addPlaceholder={translateText("选择要添加的隧道")}
                        emptyText={translateText("暂未添加隧道，可从下方选择添加。")}
                        allAddedText={tunnels.length > 0 ? translateText("隧道已全部添加") : translateText("暂无可添加隧道")}
                        onAdd={(id) => addPlanResource("tunnelIds", id)}
                        onRemove={(id) => removePlanResource("tunnelIds", id)}
                        getId={(tunnel) => Number(tunnel.id)}
                        renderOption={(tunnel) => (
                          <PlanResourceOption
                            type="tunnel"
                            item={tunnel}
                            hosts={hosts}
                            title={tunnel.name || translateText("隧道 #{0}", [tunnel.id])}
                            kind={String(tunnel.mode || "").toUpperCase() || translateText("隧道")}
                            meta={getTunnelRouteText(tunnel, hosts)}
                          />
                        )}
                        renderSelected={(tunnel) => (
                          <PlanResourceOption
                            type="tunnel"
                            item={tunnel}
                            hosts={hosts}
                            title={tunnel.name || translateText("隧道 #{0}", [tunnel.id])}
                            kind={String(tunnel.mode || "").toUpperCase() || translateText("隧道")}
                            meta={getTunnelRouteText(tunnel, hosts)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title={translateText("转发链")}
                        countText={translateText("{0} 条", [selectedChains.length])}
                        loading={forwardGroupsLoading}
                        loadingLabel={translateText("正在加载转发链资源")}
                        selectedItems={selectedChains}
                        availableItems={availableChains}
                        addPlaceholder={translateText("选择要添加的转发链")}
                        emptyText={translateText("暂未添加转发链，可从下方选择添加。")}
                        allAddedText={chainForwardGroups.length > 0 ? translateText("转发链已全部添加") : translateText("暂无可添加转发链")}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("转发链 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 节点", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("转发链 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 节点", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      <PlanResourcePicker
                        title={translateText("转发组")}
                        countText={translateText("{0} 个", [selectedManagedForwardGroups.length])}
                        loading={forwardGroupsLoading}
                        loadingLabel={translateText("正在加载转发组资源")}
                        selectedItems={selectedManagedForwardGroups}
                        availableItems={availableManagedForwardGroups}
                        addPlaceholder={translateText("选择要添加的转发组")}
                        emptyText={translateText("暂未添加转发组，可从下方选择添加。")}
                        allAddedText={standardForwardGroups.length > 0 ? translateText("转发组已全部添加") : translateText("暂无可添加转发组")}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("转发组 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 成员", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                        renderSelected={(group) => (
                          <PlanResourceOption
                            type="forward_group"
                            item={group}
                            hosts={hosts}
                            title={group.name || translateText("转发组 #{0}", [group.id])}
                            kind={forwardGroupTypeText(group)}
                            meta={(group.members || []).length ? translateText("{0} 成员", [group.members.length]) : forwardGroupTypeText(group)}
                          />
                        )}
                      />
                      {selectedOtherForwardResources.length > 0 ? (
                        <PlanSelectedResourceList
                          title={translateText("其他转发资源（兼容）")}
                          countText={translateText("{0} 个", [selectedOtherForwardResources.length])}
                          selectedItems={selectedOtherForwardResources}
                          emptyText={translateText("当前没有兼容转发资源。")}
                          note={translateText("旧数据会继续保留，但这里不再支持新增入口组或出口组。")}
                          onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                          getId={(group) => Number(group.id)}
                          renderSelected={(group) => (
                            <PlanResourceOption
                              type="forward_group"
                              item={group}
                              hosts={hosts}
                              title={group.name || translateText("转发资源 #{0}", [group.id])}
                              kind={forwardGroupTypeText(group)}
                              meta={(group.members || []).length ? translateText("{0} 成员", [group.members.length]) : forwardGroupTypeText(group)}
                            />
                          )}
                        />
                      ) : null}
                    </>
                  ) : (
                    <></>
                  )}
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-sm font-medium">{translateText("附加流量包")}</Label>
                <p className="mt-1 text-xs text-muted-foreground">{translateText("用户在“我的订阅”内余额购买，仅当前流量周期有效。")}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addTrafficAddon}>
                <Plus className="mr-2 h-4 w-4" />{translateText(" 添加档位")}</Button>
            </div>
            <div className="space-y-2">
              {form.trafficAddons.map((addon, index) => (
                <div key={index} className="grid gap-2 rounded-md border border-border/50 p-3 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{translateText("流量（GB）")}</Label>
                    <Input type="number" min={0} step="0.01" value={addon.trafficGB} onChange={(e) => updateTrafficAddon(index, { trafficGB: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{translateText("价格（元）")}</Label>
                    <Input type="number" min={0} step="0.01" value={addon.price} onChange={(e) => updateTrafficAddon(index, { price: e.target.value })} />
                  </div>
                  <label className="flex h-10 items-center justify-between gap-2 rounded-md border px-3 text-sm">{translateText("启用")}<Switch checked={addon.isActive} onCheckedChange={(isActive) => updateTrafficAddon(index, { isActive })} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => removeTrafficAddon(index)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.trafficAddons.length === 0 && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{translateText("未配置时用户不能自助购买附加流量。")}</div>
              )}
            </div>
          </div>

              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter className="border-t border-border/60 px-4 py-3 sm:px-5">
            <Button variant="outline" onClick={() => setEditing(false)}>{translateText("取消")}</Button>
            <Button onClick={save} disabled={createPlan.isPending || updatePlan.isPending}>
              {(createPlan.isPending || updatePlan.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{translateText("保存")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={(open) => {
        setAssignOpen(open);
        if (!open) setAssignDurationDays("30");
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateText("手动分配套餐")}</DialogTitle>
            <DialogDescription>{translateText("手动给用户分配套餐。")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="assign-plan-user">{translateText("用户")}</Label>
              <UserSelect id="assign-plan-user" value={assignUserId} onValueChange={setAssignUserId} />
            </div>
            <div className="space-y-2">
              <Label>{translateText("套餐")}</Label>
              <Select value={assignPlanId} onValueChange={(value) => {
                setAssignPlanId(value);
                setAssignDurationDays("30");
              }}>
                <SelectTrigger><SelectValue placeholder={translateText("选择套餐")} /></SelectTrigger>
                <SelectContent>
                  {planOptions.map((plan: any) => <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {selectedAssignPlan && (
              assignPlanIsMonthly ? (
                <div className="space-y-2">
                  <Label>{translateText("分配周期")}</Label>
                  <Select value={assignDurationDays} onValueChange={setAssignDurationDays}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {assignMonthlyDurationOptions.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{translateText("选择永久时不会设置到期时间。")}</p>
                </div>
              ) : (
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{translateText("当前套餐有效期为 ")}{durationLabel(selectedAssignPlanDurationDays)}{translateText("，将按套餐自身周期分配；如需其他周期，请先编辑套餐。")}</div>
              )
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>{translateText("取消")}</Button>
            <Button
              onClick={submitAssignPlan}
              disabled={!assignUserId || !assignPlanId || assignPlan.isPending}
            >
              <ShoppingBag className="mr-2 h-4 w-4" />{translateText(" 分配")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

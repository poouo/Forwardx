import DashboardLayout from "@/components/DashboardLayout";
import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Textarea } from "@/components/ui/textarea";
import DataSectionLoading from "@/components/DataSectionLoading";
import TrafficBillingConfigManager from "@/components/TrafficBillingConfigManager";
import { useUrlTab } from "@/hooks/useUrlTab";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CheckCircle2, Coins, LayoutGrid, List, Package, Plus, RefreshCw, Settings2, ShoppingBag, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

type PlanForm = {
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
type PlanListViewMode = "card" | "table";
type PlanResourceKey = "hostIds" | "tunnelIds" | "forwardGroupIds";
type ForwardGroupMode = "port" | "failover" | "chain" | "entry" | "exit";
type PlanResourcePart = { label: string; count: number };
const PLAN_MANAGE_TABS = ["plans", "billing"] as const;
const PLAN_MANAGE_TAB_ITEMS = [
  { value: "plans", label: "订阅套餐", icon: Package },
  { value: "billing", label: "按量计费资源", icon: Coins },
] as const satisfies readonly SlidingTabItem<PlanManageTab>[];
const PLAN_MANAGE_TAB_STORAGE_KEY = "forwardx.plans.tab";
const PLAN_LIST_VIEW_MODE_STORAGE_KEY = "forwardx.plans.viewMode";

const emptyForm: PlanForm = {
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

function getStoredPlanListViewMode(): PlanListViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(PLAN_LIST_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storePlanListViewMode(viewMode: PlanListViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PLAN_LIST_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // View preference is optional.
  }
}

function money(cents?: number, currency = "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format((cents || 0) / 100);
}

function bytes(size?: number | null) {
  const value = Number(size || 0);
  if (!value) return "不限";
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
  return num > 0 ? `${parseFloat(num.toFixed(2))} Mbps` : "不限";
}

const durationOptions = [
  { value: "30", label: "一个月" },
  { value: "90", label: "三个月" },
  { value: "180", label: "半年" },
  { value: "365", label: "一年" },
  { value: "730", label: "两年" },
];

const assignMonthlyDurationOptions = [
  { value: "30", label: "一个月" },
  { value: "90", label: "三个月" },
  { value: "180", label: "半年" },
  { value: "0", label: "永久" },
];

function durationLabel(days?: number | null) {
  if (Number(days) === 0) return "永久";
  return durationOptions.find((item) => Number(item.value) === Number(days))?.label || `${days || 30} 天`;
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
        {plan.isActive ? "启用" : "停用"}
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
        {plan.isActive && plan.isStoreVisible ? "商店展示" : "后台分配"}
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
}: {
  plan: any;
  resourceParts: PlanResourcePart[];
  onEdit: () => void;
  onDelete: () => void;
  toggling?: boolean;
  onToggleActive: () => void;
  onToggleStoreVisible: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{plan.name}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">{plan.description || "无描述"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onEdit}>编辑</Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
        <MobileInfoRow label="价格">{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</MobileInfoRow>
        <MobileInfoRow label="资源">
          <div className="flex flex-wrap justify-end gap-1">
            {resourceParts.map((item) => (
              <Badge key={item.label} variant="outline">{item.label} {item.count}</Badge>
            ))}
          </div>
        </MobileInfoRow>
        <MobileInfoRow label="端口">{plan.portCount} 个端口</MobileInfoRow>
        <MobileInfoRow label="规则/流量">规则 {plan.maxRules || "不限"} · 流量 {bytes(plan.trafficLimit)}</MobileInfoRow>
        <MobileInfoRow label="连接/IP">连接 {plan.maxConnections || "不限"} · 单 IP {plan.maxIPs || "不限"}</MobileInfoRow>
        <MobileInfoRow label="限速">{speed(plan.rateLimitMbps)}</MobileInfoRow>
        <MobileInfoRow label="附加流量">{plan.trafficAddons?.length || 0} 档</MobileInfoRow>
        <MobileInfoRow label="状态">
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
  return host?.name || host?.ip || host?.ipv4 || host?.ipv6 || `主机 #${host?.id || "-"}`;
}

function hostMeta(host: any) {
  return Array.from(new Set([host?.ip, host?.ipv4, host?.ipv6].filter(Boolean))).join(" / ");
}

function tunnelTitle(tunnel: any, hosts: any[]) {
  return `${tunnel?.name || `隧道 #${tunnel?.id || "-"}`} / ${getTunnelRouteText(tunnel, hosts)} / ${String(tunnel?.mode || "").toUpperCase()}`;
}

function legacyForwardGroupTypeText(group: any) {
  if (group?.groupMode === "chain") return "端口转发链";
  if (group?.groupType === "tunnel") return "隧道组";
  return "主机组";
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
  if (mode === "port") return "端口转发";
  if (mode === "chain") return "转发链";
  if (mode === "entry") return "入口组";
  if (mode === "exit") return "出口组";
  if (group?.groupType === "tunnel") return "隧道转发组";
  return "转发组";
}

function planResourcePartsForDisplay(plan: any, forwardGroupMap: Map<number, any>): PlanResourcePart[] {
  const counts = {
    ports: Number(plan?.hostIds?.length || 0),
    tunnels: Number(plan?.tunnelIds?.length || 0),
    chains: 0,
    groups: 0,
    otherForwardResources: 0,
  };

  for (const rawId of Array.isArray(plan?.forwardGroupIds) ? plan.forwardGroupIds : []) {
    const group = forwardGroupMap.get(Number(rawId));
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
    { label: "端口转发", count: counts.ports },
    { label: "隧道", count: counts.tunnels },
    { label: "转发链", count: counts.chains },
    { label: "转发组", count: counts.groups },
    { label: "转发资源", count: counts.otherForwardResources },
  ].filter((item) => item.count > 0);
}

function selectedResourceItems(ids: number[], items: any[], fallbackType: string) {
  return ids
    .map(Number)
    .filter(Boolean)
    .map((id) => items.find((item: any) => Number(item.id) === id) || { id, missing: true, name: `${fallbackType} #${id}` });
}

function missingResourceHint(item: any) {
  return item?.missing ? "资源不存在或已删除，可删除清理" : "";
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
                    title="删除"
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
                title="删除"
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
  const { data: plans = [], isLoading } = trpc.plans.list.useQuery();
  const { data: storeStatus, isLoading: storeStatusLoading } = trpc.plans.storeStatus.useQuery();
  const { data: hosts = [], isLoading: hostsLoading } = trpc.hosts.listAll.useQuery();
  const { data: tunnels = [], isLoading: tunnelsLoading } = trpc.tunnels.list.useQuery();
  const { data: forwardGroups = [], isLoading: forwardGroupsLoading } = trpc.forwardGroups.list.useQuery();
  const { data: users = [] } = trpc.users.list.useQuery();
  const { data: trafficBillingData, isLoading: trafficBillingLoading } = trpc.trafficBilling.configs.useQuery();
  const { data: trafficBillingSummary, isLoading: trafficBillingSummaryLoading } = trpc.trafficBilling.status.useQuery();

  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [editing, setEditing] = useState(false);
  const [planDialogTab, setPlanDialogTab] = useState<PlanDialogTab>("settings");
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignPlanId, setAssignPlanId] = useState("");
  const [assignDurationDays, setAssignDurationDays] = useState("30");
  const [activeTab, setActiveTab] = useUrlTab<PlanManageTab>({
    values: PLAN_MANAGE_TABS,
    defaultValue: "plans",
    storageKey: PLAN_MANAGE_TAB_STORAGE_KEY,
  });
  const [planViewMode, setPlanViewMode] = useState<PlanListViewMode>(() => getStoredPlanListViewMode());
  const [billingCreateRequestKey, setBillingCreateRequestKey] = useState(0);
  const [statusUpdatingPlanId, setStatusUpdatingPlanId] = useState<number | null>(null);

  const createPlan = trpc.plans.create.useMutation({
    onSuccess: () => {
      toast.success("套餐已创建");
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "创建失败"),
  });

  const updatePlan = trpc.plans.update.useMutation({
    onSuccess: () => {
      toast.success("套餐已保存");
      setEditing(false);
      setForm(emptyForm);
      utils.plans.list.invalidate();
      utils.plans.storeList.invalidate();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
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
      toast.success(variables.isActive ? "套餐状态已更新" : "套餐已停用");
      utils.plans.storeList.invalidate();
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.list.setData(undefined, context.previous as any);
      toast.error(error.message || "状态更新失败");
    },
    onSettled: () => {
      setStatusUpdatingPlanId(null);
      utils.plans.list.invalidate();
      utils.plans.storeList.invalidate();
    },
  });

  const deletePlan = trpc.plans.delete.useMutation({
    onSuccess: () => {
      toast.success("套餐已删除");
      utils.plans.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
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
      toast.success("商店状态已更新");
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.plans.storeStatus.setData(undefined, context.previous);
      toast.error(error.message || "更新失败");
    },
    onSettled: () => {
      utils.plans.storeStatus.invalidate();
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
      toast.success("流量计费开关已更新");
    },
    onError: (error, _variables, context) => {
      if (context?.previous) utils.trafficBilling.configs.setData(undefined, context.previous);
      toast.error(error.message || "更新失败");
    },
    onSettled: () => {
      utils.trafficBilling.configs.invalidate();
    },
  });

  const assignPlan = trpc.plans.assign.useMutation({
    onSuccess: (result) => {
      toast.success(`套餐已分配，端口段 ${result.portRangeStart}-${result.portRangeEnd}`);
      setAssignOpen(false);
      setAssignUserId("");
      setAssignPlanId("");
      setAssignDurationDays("30");
      utils.plans.subscriptions.invalidate();
      utils.users.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "分配失败"),
  });

  const activePlans = useMemo(() => plans.filter((p: any) => p.isActive).length, [plans]);
  const storeEnabled = !!storeStatus?.enabled;
  const trafficBillingEnabled = !!trafficBillingData?.enabled;
  const trafficBillingConfigs = trafficBillingData?.configs || [];
  const trafficBillingCharged = Number(trafficBillingSummary?.totalAmountCents || 0);
  const trafficBillingGb = Number(trafficBillingSummary?.totalBilledGb || 0);
  const forwardGroupMap = useMemo(
    () => new Map(forwardGroups.map((group: any) => [Number(group.id), group])),
    [forwardGroups],
  );
  const planResourceSummary: any = useMemo(() => {
    return plans.reduce(
      (summary: { ports: number; tunnels: number; chains: number; groups: number; otherForwardResources: number }, plan: any) => {
        for (const item of planResourcePartsForDisplay(plan, forwardGroupMap)) {
          if (item.label === "端口转发") summary.ports += item.count;
          if (item.label === "隧道") summary.tunnels += item.count;
          if (item.label === "转发链") summary.chains += item.count;
          if (item.label === "转发组") summary.groups += item.count;
          if (item.label === "转发资源") summary.otherForwardResources += item.count;
        }
        return summary;
      },
      { ports: 0, tunnels: 0, chains: 0, groups: 0, otherForwardResources: 0 },
    );
  }, [forwardGroupMap, plans]);
  const planResourceTotal = planResourceSummary.ports + planResourceSummary.tunnels + planResourceSummary.chains + planResourceSummary.groups + planResourceSummary.otherForwardResources;
  const selectedHostIds = useMemo(() => new Set(form.hostIds.map(Number)), [form.hostIds]);
  const selectedTunnelIds = useMemo(() => new Set(form.tunnelIds.map(Number)), [form.tunnelIds]);
  const selectedForwardGroupIds = useMemo(() => new Set(form.forwardGroupIds.map(Number)), [form.forwardGroupIds]);
  const portForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isPortForwardGroup(group)), [forwardGroups]);
  const chainForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isChainForwardGroup(group)), [forwardGroups]);
  const standardForwardGroups = useMemo(() => forwardGroups.filter((group: any) => isStandardForwardGroup(group)), [forwardGroups]);
  const selectedHosts = useMemo(() => selectedResourceItems(form.hostIds, hosts, "主机"), [form.hostIds, hosts]);
  const selectedTunnels = useMemo(() => selectedResourceItems(form.tunnelIds, tunnels, "隧道"), [form.tunnelIds, tunnels]);
  const selectedForwardGroups = useMemo(() => selectedResourceItems(form.forwardGroupIds, forwardGroups, "转发组"), [form.forwardGroupIds, forwardGroups]);
  const selectedAssignPlan = useMemo(
    () => plans.find((plan: any) => Number(plan.id) === Number(assignPlanId)) || null,
    [assignPlanId, plans],
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
    () => selectedResourceItems(selectedPortForwardIds, portForwardGroups, "端口转发"),
    [portForwardGroups, selectedPortForwardIds],
  );
  const selectedChains = useMemo(
    () => selectedResourceItems(selectedChainForwardIds, chainForwardGroups, "转发链"),
    [chainForwardGroups, selectedChainForwardIds],
  );
  const selectedManagedForwardGroups = useMemo(
    () => selectedResourceItems(selectedStandardForwardGroupIds, standardForwardGroups, "转发组"),
    [selectedStandardForwardGroupIds, standardForwardGroups],
  );
  const selectedOtherForwardResources = useMemo(
    () => selectedResourceItems(selectedOtherForwardResourceIds, forwardGroups, "转发资源"),
    [forwardGroups, selectedOtherForwardResourceIds],
  );
  const availableHosts = useMemo(() => hosts.filter((host: any) => !selectedHostIds.has(Number(host.id))), [hosts, selectedHostIds]);
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
  const availableForwardGroups = useMemo(() => forwardGroups.filter((group: any) => !selectedForwardGroupIds.has(Number(group.id))), [forwardGroups, selectedForwardGroupIds]);

  const openPlanCreate = () => {
    setForm(emptyForm);
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

  const handlePlanViewModeChange = (viewMode: PlanListViewMode) => {
    setPlanViewMode(viewMode);
    storePlanListViewMode(viewMode);
  };

  const save = () => {
    if (!form.name.trim()) {
      setPlanDialogTab("settings");
      return toast.error("请填写套餐名称");
    }
    if (form.hostIds.length === 0 && form.tunnelIds.length === 0 && form.forwardGroupIds.length === 0) {
      setPlanDialogTab("resources");
      toast.error("至少选择一个端口转发、隧道、转发链或转发组");
      return;
      return toast.error("至少选择一个主机、隧道或转发组");
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
      toast.info("套餐启用后才能开启商店展示");
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">套餐管理</h1>
            <p className="text-sm text-muted-foreground">配置套餐、资源和端口。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAssignOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" /> 手动分配
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> {activeTab === "billing" ? "新增计费资源" : "新增套餐"}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>按量计费</CardDescription>
              <CardTitle className="flex items-center justify-between gap-3">
                <span>{trafficBillingEnabled ? "已开启" : "已关闭"}</span>
                {trafficBillingLoading ? (
                  <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                ) : (
                  <Switch
                    instant
                    checked={trafficBillingEnabled}
                    disabled={setTrafficBillingEnabled.isPending}
                    onCheckedChange={(enabled) => setTrafficBillingEnabled.mutate({ enabled })}
                  />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">公开资源可在余额充足时直接使用。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>商店状态</CardDescription>
              <CardTitle className="flex items-center justify-between">
                <span>{storeEnabled ? "已开启" : "已关闭"}</span>
                <Switch
                  instant
                  checked={storeEnabled}
                  disabled={storeStatusLoading || setStoreEnabled.isPending}
                  onCheckedChange={(enabled) => setStoreEnabled.mutate({ enabled })}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">开启后用户可自助购买。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>套餐数量</CardDescription>
              <CardTitle>
                <AnimatedStatValue value={plans.length} loading={isLoading} cacheKey="plans.count" fallbackValue={0} />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <AnimatedStatValue
                value={`其中 ${activePlans} 个处于启用状态`}
                loading={isLoading}
                cacheKey="plans.activeCount"
                fallbackValue="其中 0 个处于启用状态"
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>套餐资源</CardDescription>
              <CardTitle>
                <AnimatedStatValue
                  value={planResourceTotal}
                  loading={isLoading}
                  cacheKey="plans.resourceTotal"
                  fallbackValue={0}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {planResourceSummary.ports} 个端口转发 · {planResourceSummary.tunnels} 条隧道 · {planResourceSummary.chains} 条转发链 · {planResourceSummary.groups} 个转发组
              {planResourceSummary.otherForwardResources > 0 ? ` · ${planResourceSummary.otherForwardResources} 个兼容资源` : ""}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>累计扣费</CardDescription>
              <CardTitle>
                <AnimatedStatValue
                  value={money(trafficBillingCharged)}
                  loading={trafficBillingSummaryLoading}
                  cacheKey="trafficBilling.totalCharged"
                  fallbackValue={money(0)}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">历史扣费合计。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>已计费流量</CardDescription>
              <CardTitle>
                <AnimatedStatValue
                  value={`${trafficBillingGb} GB`}
                  loading={trafficBillingSummaryLoading}
                  cacheKey="trafficBilling.totalGb"
                  fallbackValue="0 GB"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">扣费记录累计。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>计费资源</CardDescription>
              <CardTitle>
                <AnimatedStatValue
                  value={trafficBillingConfigs.length}
                  loading={trafficBillingLoading}
                  cacheKey="trafficBilling.configsCount"
                  fallbackValue={0}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">已配置资源。</CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as PlanManageTab)} className="space-y-4">
          <SlidingTabsList items={PLAN_MANAGE_TAB_ITEMS} activeValue={activeTab} ariaLabel="套餐管理" minItemWidthRem={9.5} />

          <TabsContent value="plans" className="mt-0 space-y-6">
            <Card>
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> 套餐列表</CardTitle>
                  <CardDescription>订阅后分配连续端口段。</CardDescription>
                </div>
                <div className="flex items-center overflow-hidden rounded-md border border-border/40">
                  <Button
                    variant={planViewMode === "card" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-8 w-8 rounded-none"
                    title="卡片视图"
                    onClick={() => handlePlanViewModeChange("card")}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={planViewMode === "table" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-8 w-8 rounded-none"
                    title="列表视图"
                    onClick={() => handlePlanViewModeChange("table")}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <DataSectionLoading label="正在加载套餐数据" />
                ) : (
                  <AutoAnimateContainer duration={220}>
                    {planViewMode === "card" ? (
                      <AutoAnimateContainer key="plan-card-view" className="standard-card-grid gap-3" duration={220}>
                        {plans.map((plan: any) => (
                          <PlanCard
                            key={plan.id}
                            plan={plan}
                            resourceParts={planResourcePartsForDisplay(plan, forwardGroupMap)}
                            toggling={statusUpdatingPlanId === Number(plan.id)}
                            onEdit={() => openPlanEdit(plan)}
                            onDelete={() => deletePlan.mutate({ id: plan.id })}
                            onToggleActive={() => togglePlanActive(plan)}
                            onToggleStoreVisible={() => togglePlanStoreVisible(plan)}
                          />
                        ))}
                        {plans.length === 0 && (
                          <div className="col-span-full rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有套餐</div>
                        )}
                      </AutoAnimateContainer>
                    ) : (
                      <div key="plan-table-view" className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>套餐</TableHead>
                              <TableHead>价格</TableHead>
                              <TableHead>资源</TableHead>
                              <TableHead>限制</TableHead>
                              <TableHead>状态</TableHead>
                              <TableHead className="text-right">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <AutoAnimateContainer as={TableBody} duration={220}>
                            {plans.map((plan: any) => (
                              <TableRow key={plan.id}>
                                <TableCell>
                                  <div className="font-medium">{plan.name}</div>
                                  <div className="max-w-md truncate text-xs text-muted-foreground">{plan.description || "无描述"}</div>
                                </TableCell>
                                <TableCell>{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {planResourcePartsForDisplay(plan, forwardGroupMap).map((item) => (
                                      <Badge key={item.label} variant="outline">{item.label} {item.count}</Badge>
                                    ))}
                                  </div>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  <div>{plan.portCount} 个端口</div>
                                  <div>规则 {plan.maxRules || "不限"} · 流量 {bytes(plan.trafficLimit)}</div>
                                  <div>附加流量 {plan.trafficAddons?.length || 0} 档</div>
                                  <div>连接 {plan.maxConnections || "不限"} · 单 IP {plan.maxIPs || "不限"} · 限速 {speed(plan.rateLimitMbps)}</div>
                                </TableCell>
                                <TableCell>
                                  <PlanStatusQuickToggle
                                    plan={plan}
                                    disabled={statusUpdatingPlanId === Number(plan.id)}
                                    onToggleActive={() => togglePlanActive(plan)}
                                    onToggleStoreVisible={() => togglePlanStoreVisible(plan)}
                                  />
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button variant="ghost" size="sm" onClick={() => openPlanEdit(plan)}>编辑</Button>
                                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deletePlan.mutate({ id: plan.id })}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                            {plans.length === 0 && (
                              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">还没有套餐</TableCell></TableRow>
                            )}
                          </AutoAnimateContainer>
                        </Table>
                      </div>
                    )}
                  </AutoAnimateContainer>
                )}
              </CardContent>
            </Card>
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

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5">
            <DialogTitle>{form.id ? "编辑套餐" : "新增套餐"}</DialogTitle>
            <DialogDescription>配置套餐限制，并绑定订阅后可用资源。</DialogDescription>
          </DialogHeader>

          <Tabs value={planDialogTab} onValueChange={(value) => setPlanDialogTab(value as PlanDialogTab)} className="flex min-h-0 flex-1 flex-col px-4 sm:px-5">
            <TabsList className="grid h-auto w-full grid-cols-2">
              <TabsTrigger value="settings">套餐设置</TabsTrigger>
              <TabsTrigger value="resources">资源绑定</TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
              <TabsContent value="settings" className="mt-4 space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>套餐名称</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：基础套餐" />
            </div>
            <div className="space-y-2">
              <Label>价格</Label>
              <Input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>有效期</Label>
              <Select value={form.durationDays} onValueChange={(durationDays) => setForm({ ...form, durationDays })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {durationOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">超过一个月按月重置流量。</p>
            </div>
            <div className="space-y-2">
              <Label>连续端口数</Label>
              <Input type="number" min={1} max={1024} value={form.portCount} onChange={(e) => setForm({ ...form, portCount: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>总流量（GB，0 为不限）</Label>
              <Input type="number" min={0} value={form.trafficGB} onChange={(e) => setForm({ ...form, trafficGB: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>限速（Mbps，0 为不限）</Label>
              <Input type="number" min={0} step={1} value={form.rateLimitMbps} onChange={(e) => setForm({ ...form, rateLimitMbps: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>最大规则数（0 为不限）</Label>
              <Input type="number" min={0} value={form.maxRules} onChange={(e) => setForm({ ...form, maxRules: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>最大连接数</Label>
              <Input type="number" min={0} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: e.target.value })} />
              <p className="text-xs text-muted-foreground">按主机或隧道聚合。</p>
            </div>
            <div className="space-y-2">
              <Label>单 IP 接入限制</Label>
              <Input type="number" min={0} value={form.maxIPs} onChange={(e) => setForm({ ...form, maxIPs: e.target.value })} />
              <p className="text-xs text-muted-foreground">同组规则共享限制。</p>
            </div>
            <div className="space-y-2">
              <Label>排序</Label>
              <Input type="number" min={0} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </div>
                </div>

                <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-3 rounded-md bg-muted/20 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">套餐状态</p>
                      <p className="text-xs text-muted-foreground">关闭后该套餐不可购买或分配。</p>
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
                      <p className="text-sm font-medium">购买入口</p>
                      <p className="text-xs text-muted-foreground">开启后普通用户可在商店自助购买。</p>
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
                        <p className="text-sm font-medium">同步已购买用户</p>
                        <p className="text-xs text-muted-foreground">开启后保存套餐会同步已购买用户的生效权益；关闭后仅影响后续新购或新分配。</p>
                      </div>
                      <Switch
                        className="shrink-0"
                        checked={form.syncExistingSubscribers}
                        onCheckedChange={(syncExistingSubscribers) => setForm({ ...form, syncExistingSubscribers })}
                        title={form.syncExistingSubscribers ? "保存后同步已购买该套餐用户的生效权益" : "保存后仅影响后续新购或新分配，已购买用户保持当前权益"}
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>说明</Label>
                  <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="展示给用户看的套餐说明" />
                </div>
              </TabsContent>

              <TabsContent value="resources" className="mt-3 space-y-3">
                <div className="space-y-3">
                  {true ? (
                    <>
                      {selectedHosts.length > 0 ? (
                        <PlanSelectedResourceList
                          title="历史主机绑定（兼容）"
                          countText={`${selectedHosts.length} 台`}
                          selectedItems={selectedHosts}
                          emptyText="当前没有历史主机绑定。"
                          note="仅用于兼容旧套餐，已不再支持新增主机绑定。"
                          onRemove={(id) => removePlanResource("hostIds", id)}
                          getId={(host) => Number(host.id)}
                          renderSelected={(host) => (
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{hostTitle(host)}</p>
                              {(missingResourceHint(host) || hostMeta(host)) && (
                                <p className={`truncate text-xs text-muted-foreground ${missingResourceHint(host) ? "" : "font-mono"}`}>
                                  {missingResourceHint(host) || hostMeta(host)}
                                </p>
                              )}
                            </div>
                          )}
                        />
                      ) : null}
                      <PlanResourcePicker
                        title="端口转发"
                        countText={`${selectedPortForwards.length} 个`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载端口转发资源"
                        selectedItems={selectedPortForwards}
                        availableItems={availablePortForwards}
                        addPlaceholder="选择要添加的端口转发"
                        emptyText="暂未添加端口转发，可从下方选择添加。"
                        allAddedText={portForwardGroups.length > 0 ? "端口转发已全部添加" : "暂无可添加端口转发"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => `${group.name || `端口转发 #${group.id}`} / ${forwardGroupTypeText(group)}`}
                        renderSelected={(group) => (
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{group.name || `端口转发 #${group.id}`}</p>
                            <p className="truncate text-xs text-muted-foreground">{missingResourceHint(group) || forwardGroupTypeText(group)}</p>
                          </div>
                        )}
                      />
                      <PlanResourcePicker
                        title="隧道转发"
                        countText={`${form.tunnelIds.length} 条`}
                        loading={tunnelsLoading}
                        loadingLabel="正在加载隧道资源"
                        selectedItems={selectedTunnels}
                        availableItems={availableTunnels}
                        addPlaceholder="选择要添加的隧道"
                        emptyText="暂未添加隧道，可从下方选择添加。"
                        allAddedText={tunnels.length > 0 ? "隧道已全部添加" : "暂无可添加隧道"}
                        onAdd={(id) => addPlanResource("tunnelIds", id)}
                        onRemove={(id) => removePlanResource("tunnelIds", id)}
                        getId={(tunnel) => Number(tunnel.id)}
                        renderOption={(tunnel) => tunnelTitle(tunnel, hosts)}
                        renderSelected={(tunnel) => (
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{tunnel.name || `隧道 #${tunnel.id}`}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {missingResourceHint(tunnel) || `${getTunnelRouteText(tunnel, hosts)} / ${String(tunnel.mode || "").toUpperCase()}`}
                            </p>
                          </div>
                        )}
                      />
                      <PlanResourcePicker
                        title="转发链"
                        countText={`${selectedChains.length} 条`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载转发链资源"
                        selectedItems={selectedChains}
                        availableItems={availableChains}
                        addPlaceholder="选择要添加的转发链"
                        emptyText="暂未添加转发链，可从下方选择添加。"
                        allAddedText={chainForwardGroups.length > 0 ? "转发链已全部添加" : "暂无可添加转发链"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => `${group.name || `转发链 #${group.id}`} / ${forwardGroupTypeText(group)}`}
                        renderSelected={(group) => (
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{group.name || `转发链 #${group.id}`}</p>
                            <p className="truncate text-xs text-muted-foreground">{missingResourceHint(group) || forwardGroupTypeText(group)}</p>
                          </div>
                        )}
                      />
                      <PlanResourcePicker
                        title="转发组"
                        countText={`${selectedManagedForwardGroups.length} 个`}
                        loading={forwardGroupsLoading}
                        loadingLabel="正在加载转发组资源"
                        selectedItems={selectedManagedForwardGroups}
                        availableItems={availableManagedForwardGroups}
                        addPlaceholder="选择要添加的转发组"
                        emptyText="暂未添加转发组，可从下方选择添加。"
                        allAddedText={standardForwardGroups.length > 0 ? "转发组已全部添加" : "暂无可添加转发组"}
                        onAdd={(id) => addPlanResource("forwardGroupIds", id)}
                        onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                        getId={(group) => Number(group.id)}
                        renderOption={(group) => `${group.name || `转发组 #${group.id}`} / ${forwardGroupTypeText(group)}`}
                        renderSelected={(group) => (
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{group.name || `转发组 #${group.id}`}</p>
                            <p className="truncate text-xs text-muted-foreground">{missingResourceHint(group) || forwardGroupTypeText(group)}</p>
                          </div>
                        )}
                      />
                      {selectedOtherForwardResources.length > 0 ? (
                        <PlanSelectedResourceList
                          title="其他转发资源（兼容）"
                          countText={`${selectedOtherForwardResources.length} 个`}
                          selectedItems={selectedOtherForwardResources}
                          emptyText="当前没有兼容转发资源。"
                          note="旧数据会继续保留，但这里不再支持新增入口组或出口组。"
                          onRemove={(id) => removePlanResource("forwardGroupIds", id)}
                          getId={(group) => Number(group.id)}
                          renderSelected={(group) => (
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{group.name || `转发资源 #${group.id}`}</p>
                              <p className="truncate text-xs text-muted-foreground">{missingResourceHint(group) || forwardGroupTypeText(group)}</p>
                            </div>
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
                <Label className="text-sm font-medium">附加流量包</Label>
                <p className="mt-1 text-xs text-muted-foreground">用户在“我的订阅”内余额购买，仅当前流量周期有效。</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addTrafficAddon}>
                <Plus className="mr-2 h-4 w-4" /> 添加档位
              </Button>
            </div>
            <div className="space-y-2">
              {form.trafficAddons.map((addon, index) => (
                <div key={index} className="grid gap-2 rounded-md border border-border/50 p-3 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
                  <div className="space-y-1.5">
                    <Label className="text-xs">流量（GB）</Label>
                    <Input type="number" min={0} step="0.01" value={addon.trafficGB} onChange={(e) => updateTrafficAddon(index, { trafficGB: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">价格（元）</Label>
                    <Input type="number" min={0} step="0.01" value={addon.price} onChange={(e) => updateTrafficAddon(index, { price: e.target.value })} />
                  </div>
                  <label className="flex h-10 items-center justify-between gap-2 rounded-md border px-3 text-sm">
                    启用
                    <Switch checked={addon.isActive} onCheckedChange={(isActive) => updateTrafficAddon(index, { isActive })} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => removeTrafficAddon(index)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.trafficAddons.length === 0 && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">未配置时用户不能自助购买附加流量。</div>
              )}
            </div>
          </div>

              </TabsContent>
            </div>
          </Tabs>

          <DialogFooter className="border-t border-border/60 px-4 py-3 sm:px-5">
            <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
            <Button onClick={save} disabled={createPlan.isPending || updatePlan.isPending}>
              {(createPlan.isPending || updatePlan.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={(open) => {
        setAssignOpen(open);
        if (!open) setAssignDurationDays("30");
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动分配套餐</DialogTitle>
            <DialogDescription>手动给用户分配套餐。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>用户</Label>
              <Select value={assignUserId} onValueChange={setAssignUserId}>
                <SelectTrigger><SelectValue placeholder="选择用户" /></SelectTrigger>
                <SelectContent>
                  {users.map((user: any) => <SelectItem key={user.id} value={String(user.id)}>{user.name || user.username}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>套餐</Label>
              <Select value={assignPlanId} onValueChange={(value) => {
                setAssignPlanId(value);
                setAssignDurationDays("30");
              }}>
                <SelectTrigger><SelectValue placeholder="选择套餐" /></SelectTrigger>
                <SelectContent>
                  {plans.map((plan: any) => <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {selectedAssignPlan && (
              assignPlanIsMonthly ? (
                <div className="space-y-2">
                  <Label>分配周期</Label>
                  <Select value={assignDurationDays} onValueChange={setAssignDurationDays}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {assignMonthlyDurationOptions.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">选择永久时不会设置到期时间。</p>
                </div>
              ) : (
                <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  当前套餐有效期为 {durationLabel(selectedAssignPlanDurationDays)}，将按套餐自身周期分配；如需其他周期，请先编辑套餐。
                </div>
              )
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>取消</Button>
            <Button
              onClick={submitAssignPlan}
              disabled={!assignUserId || !assignPlanId || assignPlan.isPending}
            >
              <ShoppingBag className="mr-2 h-4 w-4" /> 分配
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

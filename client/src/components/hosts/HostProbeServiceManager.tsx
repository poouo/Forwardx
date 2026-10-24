import { t as translateText } from "@/i18n";
import DataSectionLoading from "@/components/DataSectionLoading";
import { useEffect, useId, useMemo, useState } from "react";
import { Activity, LayoutGrid, List, Loader2, Pencil, RadioTower, Trash2 } from "lucide-react";
import HostStatusLabel from "@/components/HostStatusLabel";
import { SortableDragHandle, SortableItem, SortableReorderContext, useOptimisticSortableOrder, useSortableReorder } from "@/components/SortableDragHandle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptimisticSwitch, Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/localizedToast";
import HostChinaHealthSettings, { createChinaHealthDraft, chinaHealthPayload, applyHostProbeServiceMode, HostProbeServiceModeTabs, type ChinaHealthDraft, type HostProbeServiceMode } from "./HostChinaHealthSettings";
import HostResourceAlertSettings, { type ResourceAlertSaveState } from "./HostResourceAlertSettings";
import HostUrlProbeFields from "./HostUrlProbeFields";
import { normalizeHostProbeMethod, urlProbeOptionsSchema, type HostProbeMethod } from "@shared/urlProbe";
import type { ResourceAlertService } from "@shared/operationsMonitor";

type ServiceForm = {
  name: string;
  method: HostProbeMethod;
  targetIp: string;
  targetPort: string;
  targetUrl: string;
  timeoutSeconds: number;
  expectedStatus: number;
  hostScope: "all" | "exclude" | "specific";
  hostIds: number[];
  excludeHostIds: number[];
  intervalSeconds: number;
  isEnabled: boolean;
  health: ChinaHealthDraft;
};

export type HostProbeServiceViewMode = "card" | "table";

const SERVICE_VIEW_MODE_STORAGE_KEY = "forwardx.hostProbeServices.viewMode";

const defaultForm: ServiceForm = {
  name: "",
  method: "tcping",
  targetIp: "",
  targetPort: "",
  targetUrl: "",
  timeoutSeconds: 5,
  expectedStatus: 200,
  hostScope: "all",
  hostIds: [],
  excludeHostIds: [],
  intervalSeconds: 30,
  isEnabled: true,
  health: createChinaHealthDraft(),
};

function getStoredServiceViewMode(): HostProbeServiceViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(SERVICE_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeServiceViewMode(viewMode: HostProbeServiceViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SERVICE_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // Ignore storage failures so service management remains usable.
  }
}

function serviceTarget(service: any) {
  if (service.resourceAlert) return `${service.threshold}%`;
  if (service.method === "url") return service.targetUrl || "—";
  return service.method === "ping" ? service.targetIp : `${service.targetIp}:${service.targetPort || "-"}`;
}

function serviceMethodLabel(service: any) {
  if (service.resourceAlert) return translateText("资源告警") + " · " + (service.metric === "cpu" ? "CPU" : translateText(service.metric === "memory" ? "内存" : "磁盘"));
  return service.method === "url" ? translateText("URL 连接检测") : service.method;
}

function scopeText(service: any, hostsById: Map<number, any>) {
  const names = (ids: number[]) => ids.map((id) => hostsById.get(id)?.name || `#${id}`).join("、");
  if (service.hostScope === "specific") return service.hostIds?.length ? translateText("特定主机：{0}", [names(service.hostIds)]) : translateText("特定主机");
  if (service.hostScope === "exclude") return service.excludeHostIds?.length ? translateText("所有主机，排除：{0}", [names(service.excludeHostIds)]) : translateText("所有主机");
  return translateText("所有主机");
}

function serviceMatchesSearchQuery(service: any, query: string, hostsById: Map<number, any>) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const scopeHostIds = [
    ...(Array.isArray(service?.hostIds) ? service.hostIds : []),
    ...(Array.isArray(service?.excludeHostIds) ? service.excludeHostIds : []),
  ].map(Number).filter(Boolean);
  const scopeHostValues = scopeHostIds.flatMap((hostId) => {
    const host = hostsById.get(hostId);
    return [hostId, host?.name, host?.entryIp, host?.ipv4, host?.ipv6, host?.ip];
  });
  const status = service?.isEnabled !== false ? "启用 已启用" : "停用 已停用 禁用";
  const method = service?.method === "url" ? "url http https " + translateText("URL 连接检测") : service?.method === "ping" ? "ping" : "tcping tcp";
  const haystack = [
    service?.id,
    service?.name,
    method,
    service?.targetIp,
    service?.targetPort,
    serviceTarget(service),
    status,
    scopeText(service, hostsById),
    ...scopeHostValues,
  ].filter((value) => value !== null && value !== undefined).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function ServiceActionButtons({
  service,
  onEdit,
  onDelete,
}: {
  service: any;
  onEdit: (service: any) => void;
  onDelete: (service: any) => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="icon" className="h-8 w-8" title={translateText("编辑服务")} onClick={() => onEdit(service)}>
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title={translateText("删除服务")} onClick={() => onDelete(service)}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function buildServiceUpdatePayload(service: any, isEnabled = service?.isEnabled !== false) {
  const method = normalizeHostProbeMethod(service?.method);
  return {
    id: Number(service?.id),
    name: String(service?.name || "").trim(),
    method,
    targetIp: String(service?.targetIp || "").trim(),
    targetPort: method === "tcping" ? Number(service?.targetPort || 0) : null,
    targetUrl: method === "url" ? service.targetUrl : null,
    timeoutSeconds: Number(service.timeoutSeconds ?? 5),
    expectedStatus: Number(service.expectedStatus ?? 200),
    hostScope: service?.hostScope === "exclude" || service?.hostScope === "specific" ? service.hostScope : "all",
    hostIds: Array.isArray(service?.hostIds) ? service.hostIds.map(Number).filter(Boolean) : [],
    excludeHostIds: Array.isArray(service?.excludeHostIds) ? service.excludeHostIds.map(Number).filter(Boolean) : [],
    intervalSeconds: Math.max(5, Number(service?.intervalSeconds) || 30),
    isEnabled,
  };
}

function ServiceEnabledSwitch({
  service,
  onToggle,
}: {
  service: any;
  onToggle: (service: any, checked: boolean) => Promise<unknown>;
}) {
  const enabled = service.isEnabled !== false;
  return (
    <OptimisticSwitch
      checked={enabled}
      onCheckedChangeAsync={(checked) => onToggle(service, checked)}
      onToggleSuccess={(checked) => toast.success(service.resourceAlert ? translateText(checked ? "已启用" : "已关闭") : checked ? translateText("探测服务已开启") : translateText("探测服务已关闭"))}
      onToggleError={(error) => toast.error(error instanceof Error ? error.message : translateText("切换探测服务状态失败"))}
      className="scale-75"
      title={translateText("{0}服务 {1}", [enabled ? translateText("停用") : translateText("启用"), service.name || ""])}
      aria-label={translateText("{0}服务 {1}", [enabled ? translateText("停用") : translateText("启用"), service.name || ""])}
    />
  );
}

function ServiceCard({
  service,
  hostsById,
  onEdit,
  onDelete,
  onToggle,
  dragHandle,
  sortableClassName,
}: {
  service: any;
  hostsById: Map<number, any>;
  onEdit: (service: any) => void;
  onDelete: (service: any) => void;
  onToggle: (service: any, checked: boolean) => Promise<unknown>;
  dragHandle?: any;
  sortableClassName?: string;
}) {
  const target = serviceTarget(service);
  const scope = scopeText(service, hostsById);
  return (
    <Card className={cn("action-card group/sortable border-border/40 bg-card/60 backdrop-blur-md", sortableClassName)}>
      <CardContent className="action-card-content space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Activity className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={service.name}>{service.name}</p>
                <Badge variant="outline" className="mt-1 px-1.5 py-0 text-[10px] uppercase">{serviceMethodLabel(service)}</Badge>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {dragHandle}
            <ServiceEnabledSwitch service={service} onToggle={onToggle} />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-md bg-muted/25 p-3">
            <p className="mb-1 text-xs text-muted-foreground">{translateText(service.resourceAlert ? "阈值 (%)" : "目标")}</p>
            <p className="truncate font-mono text-xs" title={target}>{target}</p>
          </div>
          <div className="min-w-0 rounded-md bg-muted/25 p-3">
            <p className="mb-1 text-xs text-muted-foreground">{translateText(service.resourceAlert ? "连续超限时长（秒）" : "运行时间")}</p>
            <p className="text-sm tabular-nums">{service.resourceAlert ? service.durationSeconds : service.intervalSeconds || 30}S</p>
          </div>
        </div>

        <div className="min-w-0 rounded-md bg-muted/25 p-3">
          <p className="mb-1 text-xs text-muted-foreground">{translateText("主机范围")}</p>
          <p className="truncate text-sm" title={scope}>{scope}</p>
        </div>

        <div className="action-card-footer flex justify-end border-t border-border/40 pt-2">
          <ServiceActionButtons service={service} onEdit={onEdit} onDelete={onDelete} />
        </div>
      </CardContent>
    </Card>
  );
}

type HostProbeServiceManagerProps = {
  createSignal: number;
  onCreateSignalHandled: () => void;
  viewMode?: HostProbeServiceViewMode;
  onViewModeChange?: (viewMode: HostProbeServiceViewMode) => void;
  hideViewModeToggle?: boolean;
  searchQuery?: string;
  onFilterStatsChange?: (stats: { filtered: number; total: number }) => void;
};

export default function HostProbeServiceManager({
  createSignal,
  onCreateSignalHandled,
  viewMode: controlledViewMode,
  onViewModeChange,
  hideViewModeToggle = false,
  searchQuery = "",
  onFilterStatsChange,
}: HostProbeServiceManagerProps) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const { data: hosts = [] } = trpc.hosts.options.useQuery(undefined, { staleTime: 30000 });
  const { data: services = [], isLoading } = trpc.hosts.probeServices.useQuery(undefined, { refetchInterval: pollingInterval("slow") });
  const resourceAlertsQuery = trpc.hosts.resourceAlertServices.useQuery(undefined, { staleTime: 30000 });
  const resourceServices = resourceAlertsQuery.data ?? [];
  const serviceItems = useMemo(() => (services as any[] | undefined) || [], [services]);
  const hostsById = useMemo(() => new Map((hosts as any[]).map((host) => [Number(host.id), host])), [hosts]);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isTextFiltered = normalizedSearchQuery.length > 0;
  const filteredServiceItems = useMemo(
    () => isTextFiltered
      ? serviceItems.filter((service) => serviceMatchesSearchQuery(service, normalizedSearchQuery, hostsById))
      : serviceItems,
    [hostsById, isTextFiltered, normalizedSearchQuery, serviceItems],
  );
  const serviceOrder = useOptimisticSortableOrder({
    items: filteredServiceItems,
    getId: (service: any) => Number(service.id),
  });
  const displayedServiceItems = serviceOrder.items;
  const filteredResourceServices = resourceServices.filter(service => !isTextFiltered || `${service.name} ${serviceMethodLabel({ ...service, resourceAlert: true })} ${scopeText(service, hostsById)}`.toLowerCase().includes(normalizedSearchQuery));
  useEffect(() => {
    onFilterStatsChange?.({ filtered: filteredServiceItems.length + filteredResourceServices.length, total: serviceItems.length + resourceServices.length });
  }, [filteredServiceItems.length, filteredResourceServices.length, onFilterStatsChange, serviceItems.length, resourceServices.length]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ServiceForm>(defaultForm);
  const [serviceMode, setServiceMode] = useState<HostProbeServiceMode>("standard");
  const [editingResource, setEditingResource] = useState<ResourceAlertService | null>(null);
  const resourceAlertFormId = useId();
  const [resourceAlertSaveState, setResourceAlertSaveState] = useState<ResourceAlertSaveState>({ ready: false, pending: false });
  const [internalViewMode, setInternalViewMode] = useState<HostProbeServiceViewMode>(() => getStoredServiceViewMode());
  const refreshResourceServices = () => {
    void utils.hosts.resourceAlertServices.invalidate();
    void utils.hosts.managementCounts.invalidate();
    void utils.operations.monitor.invalidate();
  };
  const toggleResourceMutation = trpc.hosts.toggleResourceAlertService.useMutation({ onSuccess: refreshResourceServices });
  const deleteResourceMutation = trpc.hosts.deleteResourceAlertService.useMutation({
    onSuccess: () => { refreshResourceServices(); toast.success(translateText("服务已删除")); },
    onError: error => toast.error(error.message),
  });
  const openResourceEdit = (service: ResourceAlertService) => {
    setEditingId(null);
    setEditingResource(service);
    setServiceMode("resource");
    setDialogOpen(true);
  };
  const deleteResource = async (service: ResourceAlertService) => {
    if (await confirmDialog({ title: translateText("删除服务"), description: translateText("确定要删除“{0}”吗？", [service.name]), confirmText: translateText("删除"), tone: "destructive" })) {
      deleteResourceMutation.mutate({ id: service.id });
    }
  };
  const viewMode = controlledViewMode ?? internalViewMode;
  const selectedScopeHostIds = form.hostScope === "exclude" ? form.excludeHostIds : form.hostIds;
  const selectedScopeHostIdSet = useMemo(() => new Set(selectedScopeHostIds.map(Number)), [selectedScopeHostIds]);
  const availableScopeHosts = useMemo(
    () => (hosts as any[]).filter((host) => !selectedScopeHostIdSet.has(Number(host.id))),
    [hosts, selectedScopeHostIdSet]
  );
  const selectedScopeHosts = useMemo(
    () => selectedScopeHostIds
      .map((id) => {
        const hostId = Number(id);
        const host = hostsById.get(hostId);
        return { id: hostId, host, name: host?.name || `#${hostId}` };
      })
      .filter((item) => Number.isInteger(item.id) && item.id > 0),
    [hostsById, selectedScopeHostIds]
  );

  const createMutation = trpc.hosts.createProbeService.useMutation({
    onSuccess: () => { utils.hosts.managementCounts.invalidate(); utils.hosts.probeServices.invalidate(); setDialogOpen(false); setForm(defaultForm); toast.success(translateText("服务已添加")); },
    onError: (err) => toast.error(err.message || translateText("添加服务失败")),
  });
  const updateMutation = trpc.hosts.updateProbeService.useMutation({
    onSuccess: () => { utils.hosts.probeServices.invalidate(); setDialogOpen(false); setEditingId(null); setForm(defaultForm); toast.success(translateText("服务已更新")); },
    onError: (err) => toast.error(err.message || translateText("更新服务失败")),
  });
  const toggleMutation = trpc.hosts.updateProbeService.useMutation({
    onSuccess: async () => {
      await utils.hosts.probeServices.invalidate();
    },
  });
  const deleteMutation = trpc.hosts.deleteProbeService.useMutation({
    onSuccess: () => { utils.hosts.managementCounts.invalidate(); utils.hosts.probeServices.invalidate(); toast.success(translateText("服务已删除")); },
    onError: (err) => toast.error(err.message || translateText("删除服务失败")),
  });
  const reorderServicesMutation = trpc.hosts.reorderProbeServices.useMutation({
    onSuccess: () => toast.success(translateText("服务顺序已更新")),
    onError: (err) => toast.error(err.message || translateText("更新服务顺序失败")),
  });
  const serviceReorderPending = reorderServicesMutation.isPending;
  const serviceSortable = useSortableReorder({
    items: displayedServiceItems,
    getId: (service: any) => Number(service.id),
    disabled: isTextFiltered || serviceReorderPending || displayedServiceItems.length < 2,
    onReorder: (nextServices) => {
      const requestId = serviceOrder.begin(nextServices);
      reorderServicesMutation.mutate(
        { ids: nextServices.map((service: any) => Number(service.id)) },
        {
          onError: () => serviceOrder.release(requestId),
          onSettled: () => serviceOrder.resync(requestId, () => utils.hosts.probeServices.invalidate()),
        },
      );
    },
  });

  const handleViewModeChange = (nextViewMode: HostProbeServiceViewMode) => {
    if (controlledViewMode === undefined) setInternalViewMode(nextViewMode);
    storeServiceViewMode(nextViewMode);
    onViewModeChange?.(nextViewMode);
  };

  const toggleServiceEnabled = async (service: any, checked: boolean) => {
    const id = Number(service?.id || 0);
    if (!id) throw new Error(translateText("探测服务不存在"));
    await toggleMutation.mutateAsync(buildServiceUpdatePayload(service, checked));
  };

  useEffect(() => {
    if (createSignal <= 0) return;
    setEditingId(null);
    setEditingResource(null);
    setForm(defaultForm);
    setServiceMode("standard");
    setDialogOpen(true);
    onCreateSignalHandled();
  }, [createSignal, onCreateSignalHandled]);

  const submit = () => {
    const name = form.name.trim();
    let targetIp = form.targetIp.trim();
    const targetPort = Number(form.targetPort);
    if (!name) { toast.error(translateText("请输入服务名称")); return; }
    if (form.method === "url") {
      const parsed = urlProbeOptionsSchema.safeParse({ targetUrl: form.targetUrl, timeoutSeconds: form.timeoutSeconds, expectedStatus: form.expectedStatus });
      if (!parsed.success) { toast.error(translateText("请检查检测 URL、超时和预期状态码")); return; }
      targetIp = new URL(parsed.data.targetUrl!).hostname.replace(/^\[|\]$/g, "");
    } else if (!targetIp) { toast.error(translateText("请输入 IP 地址")); return; }
    if (form.method === "tcping" && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) { toast.error(translateText("目标端口必须在 1-65535 之间")); return; }
    if (form.hostScope === "specific" && form.hostIds.length === 0) { toast.error(translateText("请选择需要运行服务的主机")); return; }
    if (form.health.enabled && (form.hostScope !== "specific" || form.hostIds.length !== 1)) { toast.error(translateText("国内健康检测必须选择一台特定主机")); return; }
    let health;
    try { health = chinaHealthPayload(form.health); } catch { toast.error(translateText("请检查国内健康检测阈值、接口地址、请求头和成功条件")); return; }
    const payload = { ...form, health, name, targetIp, targetUrl: form.method === "url" ? form.targetUrl.trim() : null, targetPort: form.method === "tcping" ? targetPort : null, intervalSeconds: Math.max(5, Number(form.intervalSeconds) || 30) };
    if (editingId) updateMutation.mutate({ ...payload, id: editingId });
    else createMutation.mutate(payload);
  };

  const addScopeHost = (hostId: string) => {
    const id = Number(hostId);
    if (!Number.isInteger(id) || id <= 0) return;
    setForm((prev) => {
      if (prev.hostScope === "exclude") {
        if (prev.excludeHostIds.map(Number).includes(id)) return prev;
        return { ...prev, excludeHostIds: [...prev.excludeHostIds, id] };
      }
      if (prev.hostScope === "specific") {
        if (prev.hostIds.map(Number).includes(id)) return prev;
        return { ...prev, hostIds: prev.health.enabled ? [id] : [...prev.hostIds, id] };
      }
      return prev;
    });
  };

  const removeScopeHost = (hostId: number) => {
    setForm((prev) => {
      if (prev.hostScope === "exclude") {
        return { ...prev, excludeHostIds: prev.excludeHostIds.filter((id) => Number(id) !== hostId) };
      }
      if (prev.hostScope === "specific") {
        return { ...prev, hostIds: prev.hostIds.filter((id) => Number(id) !== hostId) };
      }
      return prev;
    });
  };

  const openEdit = (service: any) => {
    setEditingResource(null);
    setEditingId(Number(service.id));
    setServiceMode(service.health?.enabled ? "china" : "standard");
    setForm({
      name: service.name || "",
      method: normalizeHostProbeMethod(service.method),
      targetIp: service.targetIp || "",
      targetPort: service.targetPort ? String(service.targetPort) : "",
      targetUrl: service.targetUrl || "",
      timeoutSeconds: Number(service.timeoutSeconds ?? 5),
      expectedStatus: Number(service.expectedStatus ?? 200),
      hostScope: service.hostScope === "exclude" || service.hostScope === "specific" ? service.hostScope : "all",
      hostIds: Array.isArray(service.hostIds) ? service.hostIds.map(Number).filter(Boolean) : [],
      excludeHostIds: Array.isArray(service.excludeHostIds) ? service.excludeHostIds.map(Number).filter(Boolean) : [],
      intervalSeconds: Math.max(5, Number(service.intervalSeconds) || 30),
      isEnabled: service.isEnabled !== false,
      health: createChinaHealthDraft(service.health),
    });
    setDialogOpen(true);
  };

  const confirmDelete = async (service: any) => {
    if (await confirmDialog({
      title: translateText("删除探测服务"),
      description: translateText("确定要删除“{0}”吗？删除后主机将不再执行该服务探测。", [service.name || translateText("此服务")]),
      confirmText: translateText("删除"),
      tone: "destructive",
    })) deleteMutation.mutate({ id: service.id });
  };

  return (
    <div className="space-y-4">
      {!hideViewModeToggle && (
      <div className="flex justify-end">
        <div className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex">
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
        </div>
      </div>
      )}

      {resourceAlertsQuery.error && <p role="alert" className="text-sm text-destructive">{resourceAlertsQuery.error.message}</p>}
      {filteredResourceServices.length > 0 && <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {viewMode === "card" ? <div className="standard-card-grid gap-4 p-3">
            {filteredResourceServices.map(service => <ServiceCard key={service.id} service={{ ...service, resourceAlert: true, isEnabled: service.enabled }} hostsById={hostsById} onEdit={() => openResourceEdit(service)} onDelete={() => deleteResource(service)} onToggle={(_, enabled) => toggleResourceMutation.mutateAsync({ id: service.id, enabled })} />)}
          </div> : <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow><TableHead>{translateText("服务")}</TableHead><TableHead>{translateText("阈值 (%)")}</TableHead><TableHead>{translateText("主机范围")}</TableHead><TableHead>{translateText("连续超限时长（秒）")}</TableHead><TableHead>{translateText("状态")}</TableHead><TableHead className="text-right">{translateText("操作")}</TableHead></TableRow></TableHeader>
            <TableBody>{filteredResourceServices.map(service => <TableRow key={service.id}>
              <TableCell><div className="font-medium">{service.name}</div><Badge variant="outline" className="mt-1 text-[10px]">{serviceMethodLabel({ ...service, resourceAlert: true })}</Badge></TableCell>
              <TableCell className="tabular-nums">{service.threshold}%</TableCell><TableCell className="max-w-[360px] truncate" title={scopeText(service, hostsById)}>{scopeText(service, hostsById)}</TableCell><TableCell>{service.durationSeconds}S</TableCell>
              <TableCell><ServiceEnabledSwitch service={{ ...service, resourceAlert: true, isEnabled: service.enabled }} onToggle={(_, enabled) => toggleResourceMutation.mutateAsync({ id: service.id, enabled })} /></TableCell>
              <TableCell><ServiceActionButtons service={service} onEdit={() => openResourceEdit(service)} onDelete={() => deleteResource(service)} /></TableCell>
            </TableRow>)}</TableBody>
          </Table></div>}
        </CardContent>
      </Card>}

      {(displayedServiceItems.length > 0 || (filteredResourceServices.length === 0 && !resourceAlertsQuery.isLoading)) && <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4">
              <DataSectionLoading label={translateText("正在加载服务")} />
            </div>
          ) : displayedServiceItems.length === 0 ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center text-muted-foreground">
              <RadioTower className="mb-3 h-9 w-9 opacity-40" />
              <p className="text-sm">{isTextFiltered && serviceItems.length > 0 ? translateText("未找到匹配服务") : translateText("暂无服务")}</p>
              {isTextFiltered && serviceItems.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground/60">{translateText("调整筛选内容或清空搜索")}</p>
              )}
            </div>
          ) : viewMode === "card" ? (
            <SortableReorderContext sortable={serviceSortable} ids={displayedServiceItems.map((service) => Number(service.id))} strategy="rect">
              <div key="host-probe-service-card-view" className="standard-card-grid card-mode-transition gap-4 p-3">
                {displayedServiceItems.map((service) => (
                  <SortableItem key={service.id} id={Number(service.id)} disabled={serviceSortable.disabled}>
                    {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                      <div {...itemProps}>
                        <ServiceCard
                          service={service}
                          hostsById={hostsById}
                          onEdit={openEdit}
                          onDelete={confirmDelete}
                          onToggle={toggleServiceEnabled}
                          dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={serviceReorderPending} />}
                          sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                        />
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableReorderContext>
          ) : (
            <div key="host-probe-service-table-view" className="card-mode-transition">
            <SortableReorderContext sortable={serviceSortable} ids={displayedServiceItems.map((service) => Number(service.id))} strategy="vertical" restrictToList>
              <div className="grid grid-cols-1 gap-4 p-3 sm:hidden">
                {displayedServiceItems.map((service) => (
                  <SortableItem key={service.id} id={Number(service.id)} disabled={serviceSortable.disabled}>
                    {({ itemProps, handleProps, isDragging, isDropTarget }) => (
                      <div {...itemProps}>
                        <ServiceCard
                          service={service}
                          hostsById={hostsById}
                          onEdit={openEdit}
                          onDelete={confirmDelete}
                          onToggle={toggleServiceEnabled}
                          dragHandle={<SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={serviceReorderPending} />}
                          sortableClassName={cn(isDragging && "opacity-55 ring-1 ring-primary/35", isDropTarget && "ring-1 ring-primary/45")}
                        />
                      </div>
                    )}
                  </SortableItem>
                ))}
              </div>
            </SortableReorderContext>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[44px]" />
                    <TableHead>{translateText("服务")}</TableHead>
                    <TableHead>{translateText("目标")}</TableHead>
                    <TableHead>{translateText("主机范围")}</TableHead>
                    <TableHead>{translateText("运行时间")}</TableHead>
                    <TableHead className="w-[120px]">{translateText("状态")}</TableHead>
                    <TableHead className="text-right">{translateText("操作")}</TableHead>
                  </TableRow>
                </TableHeader>
                <SortableReorderContext sortable={serviceSortable} ids={displayedServiceItems.map((service) => Number(service.id))} strategy="vertical" restrictToList>
                <TableBody>
                  {displayedServiceItems.map((service) => (
                    <SortableItem key={service.id} id={Number(service.id)} disabled={serviceSortable.disabled} itemKind="row">
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
                        <SortableDragHandle dragHandleProps={handleProps} visible={isDragging} busy={serviceReorderPending} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Activity className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="font-medium">{service.name}</div>
                            <Badge variant="outline" className="mt-1 px-1.5 py-0 text-[10px] uppercase">{serviceMethodLabel(service)}</Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{serviceTarget(service)}</TableCell>
                      <TableCell className="max-w-[360px] truncate text-sm" title={scopeText(service, hostsById)}>{scopeText(service, hostsById)}</TableCell>
                      <TableCell className="text-sm tabular-nums">{service.intervalSeconds || 30}S</TableCell>
                      <TableCell>
                        <ServiceEnabledSwitch service={service} onToggle={toggleServiceEnabled} />
                      </TableCell>
                      <TableCell className="text-right">
                        <ServiceActionButtons service={service} onEdit={openEdit} onDelete={confirmDelete} />
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
        </CardContent>
      </Card>}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[88svh] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden sm:max-w-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{editingId || editingResource ? translateText("编辑服务") : translateText("添加服务")}</DialogTitle>
            <DialogDescription>{translateText(serviceMode === "resource" ? "资源告警" : "配置主机 Ping / TCPing / URL 连接检测")}</DialogDescription>
          </DialogHeader>
          <HostProbeServiceModeTabs mode={serviceMode} onModeChange={mode => {
            setServiceMode(mode);
            if (mode === "resource") return;
            setForm(previous => {
              const next = applyHostProbeServiceMode(previous, mode);
              return mode === "china" && previous.method === "url" ? { ...next, method: "tcping" } : next;
            });
          }}>
            {serviceMode === "resource" ? <HostResourceAlertSettings hosts={hosts} formId={resourceAlertFormId} onSaveStateChange={setResourceAlertSaveState} service={editingResource} onSaved={() => setDialogOpen(false)} /> : <>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="probe-service-name" className="flex min-h-5 items-center text-xs">{translateText("服务名")}</Label>
                <Input id="probe-service-name" className="h-9 sm:h-8" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={translateText("例如: 公网 API 延迟")} />
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor="probe-service-method" className="flex min-h-5 items-center text-xs">{translateText("类型")}</Label>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Select value={form.method} onValueChange={(value) => setForm({ ...form, method: value as ServiceForm["method"] })}>
                      <SelectTrigger id="probe-service-method" className="h-9 sm:h-8"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="tcping">TCPing</SelectItem><SelectItem value="ping">Ping</SelectItem>{!form.health.enabled && <SelectItem value="url">{translateText("URL 连接检测")}</SelectItem>}</SelectContent>
                    </Select>
                  </div>
                  <Label htmlFor="probe-service-enabled" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {translateText("启用服务")}
                    <Switch id="probe-service-enabled" checked={form.isEnabled} onCheckedChange={(checked) => setForm({ ...form, isEnabled: checked })} />
                  </Label>
                </div>
              </div>
            </div>
            {form.method === "url" ? <HostUrlProbeFields value={form} onChange={patch => setForm(previous => ({ ...previous, ...patch }))} /> : <div className={`grid min-w-0 gap-2.5 ${form.method === "tcping" ? "grid-cols-[minmax(0,1fr)_5.5rem] sm:grid-cols-[minmax(0,1fr)_8rem]" : ""}`}>
              <div className="min-w-0 space-y-1"><Label className="text-xs">{translateText("IP 地址 / 域名")}</Label><Input className="h-9 sm:h-8" value={form.targetIp} onChange={(e) => setForm({ ...form, targetIp: e.target.value })} placeholder={translateText("1.1.1.1 或 example.com")} /></div>
              {form.method === "tcping" && <div className="min-w-0 space-y-1"><Label className="text-xs">{translateText("目标端口")}</Label><Input className="h-9 sm:h-8" type="number" min={1} max={65535} value={form.targetPort} onChange={(e) => setForm({ ...form, targetPort: e.target.value })} placeholder="443" /></div>}
            </div>}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] gap-2.5 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <div className="min-w-0 space-y-1"><Label className="text-xs">{translateText("选择主机")}</Label><Select disabled={form.health.enabled} value={form.hostScope} onValueChange={(value) => setForm({ ...form, hostScope: value as ServiceForm["hostScope"] })}><SelectTrigger className="h-9 sm:h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{translateText("所有主机")}</SelectItem><SelectItem value="exclude">{translateText("排除主机")}</SelectItem><SelectItem value="specific">{translateText("特定主机")}</SelectItem></SelectContent></Select></div>
              <div className="min-w-0 space-y-1"><Label className="text-xs">{translateText("服务运行时间")}</Label><Input className="h-9 sm:h-8" type="number" min={5} value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Math.max(5, Number(e.target.value) || 5) })} /></div>
            </div>
            {form.hostScope !== "all" && (
              <div className="space-y-2 rounded-md border border-border/50 bg-muted/15 p-2.5">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <Label className="text-xs">{form.hostScope === "exclude" ? translateText("添加需要排除在外的主机") : translateText("选择需要运行服务的主机")}</Label>
                    {selectedScopeHostIds.length > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{selectedScopeHostIds.length}{translateText(" 台")}</span>
                    )}
                  </div>
                  <Select value="" onValueChange={addScopeHost}>
                    <SelectTrigger className="h-9 sm:h-8 sm:w-52 sm:shrink-0">
                      <SelectValue placeholder={availableScopeHosts.length === 0 ? translateText("已全部添加") : form.hostScope === "exclude" ? translateText("添加排除主机...") : translateText("添加运行主机...")} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableScopeHosts.length === 0 ? (
                        <div className="px-2 py-4 text-center text-xs text-muted-foreground">{translateText("已全部添加")}</div>
                      ) : availableScopeHosts.map((host) => (
                        <SelectItem key={host.id} value={String(host.id)} textValue={host.name}>
                          <HostStatusLabel host={host} label={host.name} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {selectedScopeHosts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{translateText("从上方选择主机")}</p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {selectedScopeHosts.map((item, index) => (
                      <div key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                          {index + 1}
                        </span>
                        <HostStatusLabel host={item.host} label={item.name} className="min-w-0 text-sm font-medium" labelClassName="truncate" />
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeScopeHost(item.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <HostChinaHealthSettings value={form.health} onChange={health => setForm(previous => ({ ...previous, health }))} />
            </>}
          </HostProbeServiceModeTabs>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{translateText("取消")}</Button>
            {serviceMode === "resource" ? <Button type="submit" form={resourceAlertFormId} disabled={!resourceAlertSaveState.ready || resourceAlertSaveState.pending}>{resourceAlertSaveState.pending ? translateText("处理中...") : translateText("保存")}</Button> : <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>{createMutation.isPending || updateMutation.isPending ? translateText("处理中...") : translateText("保存")}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

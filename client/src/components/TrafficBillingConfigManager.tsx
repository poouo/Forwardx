import AnimatedStatValue from "@/components/AnimatedStatValue";
import AutoAnimateContainer from "@/components/AutoAnimateContainer";
import DataSectionLoading from "@/components/DataSectionLoading";
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
import { Textarea } from "@/components/ui/textarea";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { Coins, Gauge, LayoutGrid, List, Pencil, Plus, ReceiptText, Route, Server, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { toast } from "sonner";

function money(cents?: number | null) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((Number(cents) || 0) / 100);
}

const MILLI_CENTS_PER_CENT = 1000;
const MILLI_CENTS_PER_YUAN = 100000;
const MIN_PRICE_PER_GB_MILLI_CENTS = 100;

function pricePerGbMilliCents(config: any) {
  const milliCents = Math.round(Number(config?.pricePerGbMilliCents || 0));
  if (milliCents > 0) return milliCents;
  return Math.round(Number(config?.pricePerGbCents || 0)) * MILLI_CENTS_PER_CENT;
}

function formatPricePerGb(config: any) {
  const yuan = pricePerGbMilliCents(config) / MILLI_CENTS_PER_YUAN;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: yuan > 0 && yuan < 0.01 ? 3 : 2,
    maximumFractionDigits: 3,
  }).format(yuan);
}

function formatPriceInput(milliCents: number) {
  return (milliCents / MILLI_CENTS_PER_YUAN).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function TrafficBillingStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  loading = false,
  cacheKey,
  fallbackValue,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ElementType;
  tone: string;
  loading?: boolean;
  cacheKey: string;
  fallbackValue?: string | number;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-border/70 hover:shadow-lg hover:shadow-primary/5">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <AnimatedStatValue
              as="p"
              value={value}
              loading={loading}
              cacheKey={cacheKey}
              fallbackValue={fallbackValue}
              className="break-words text-2xl font-bold tracking-tight tabular-nums"
            />
            {subtitle && (
              <AnimatedStatValue
                as="p"
                value={subtitle}
                loading={loading}
                cacheKey={`${cacheKey}.subtitle`}
                fallbackValue=""
                className="break-words text-xs text-muted-foreground/80"
              />
            )}
          </div>
          <div className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm sm:flex ${tone}`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
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

type BillingResourceType = "host" | "tunnel";
type BillingConfigViewMode = "card" | "table";
const BILLING_CONFIG_VIEW_MODE_STORAGE_KEY = "forwardx.trafficBilling.configs.viewMode";

function getStoredBillingConfigViewMode(): BillingConfigViewMode {
  if (typeof window === "undefined") return "card";
  try {
    const value = window.localStorage.getItem(BILLING_CONFIG_VIEW_MODE_STORAGE_KEY);
    return value === "table" ? "table" : "card";
  } catch {
    return "card";
  }
}

function storeBillingConfigViewMode(viewMode: BillingConfigViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BILLING_CONFIG_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // View preference is optional.
  }
}

type BillingConfigForm = {
  id?: number;
  resourceType: BillingResourceType;
  resourceId: string;
  description: string;
  price: string;
  multiplier: string;
  enabled: boolean;
  requiresPermission: boolean;
};

const defaultBillingConfigForm = (): BillingConfigForm => ({
  resourceType: "host",
  resourceId: "",
  description: "",
  price: "",
  multiplier: "1",
  enabled: true,
  requiresPermission: false,
});

function BillingConfigCard({
  config,
  onEdit,
  onDelete,
}: {
  config: any;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {config.resourceType === "host" ? <Server className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Route className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 break-words text-sm font-medium">{config.resourceName}</span>
        </div>
        <div className="-mr-2 -mt-2 flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
        <MobileInfoRow label="类型">{config.resourceType === "host" ? "主机" : "隧道"} #{config.resourceId}</MobileInfoRow>
        <MobileInfoRow label="单价">{formatPricePerGb(config)} / GB</MobileInfoRow>
        <MobileInfoRow label="倍率">{(Number(config.multiplier || 100) / 100).toFixed(2)}x</MobileInfoRow>
        <MobileInfoRow label="权限">
          <Badge variant={config.requiresPermission ? "outline" : "secondary"}>
            {config.requiresPermission ? "需要授权" : "公开可用"}
          </Badge>
        </MobileInfoRow>
        <MobileInfoRow label="状态"><Badge variant={config.enabled ? "outline" : "secondary"}>{config.enabled ? "启用" : "停用"}</Badge></MobileInfoRow>
      </div>
    </div>
  );
}

export default function TrafficBillingConfigManager({
  showHeader = true,
  showEmbeddedHeader = true,
  showSummary = true,
  hideCreateButton = false,
  createRequestKey = 0,
}: {
  showHeader?: boolean;
  showEmbeddedHeader?: boolean;
  showSummary?: boolean;
  hideCreateButton?: boolean;
  createRequestKey?: number;
}) {
  const utils = trpc.useUtils();
  const { data: hosts = [] } = trpc.hosts.listAll.useQuery();
  const { data: tunnels = [] } = trpc.tunnels.listAll.useQuery();
  const { data, isLoading: configsLoading } = trpc.trafficBilling.configs.useQuery();
  const { data: summary, isLoading: summaryLoading } = trpc.trafficBilling.status.useQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [configForm, setConfigForm] = useState<BillingConfigForm>(() => defaultBillingConfigForm());
  const [configViewMode, setConfigViewMode] = useState<BillingConfigViewMode>(() => getStoredBillingConfigViewMode());
  const lastCreateRequestKey = useRef(createRequestKey);

  const resources = configForm.resourceType === "host" ? hosts : tunnels;
  const resourceLabel = (item: any) => {
    if (configForm.resourceType === "host") return `${item.name} #${item.id}`;
    return `${item.name} / ${getTunnelRouteText(item, hosts)} / ${String(item.mode || "").toUpperCase()} #${item.id}`;
  };
  const totalCharged = Number(summary?.totalAmountCents || 0);
  const totalGb = Number(summary?.totalBilledGb || 0);

  const invalidateBilling = () => {
    utils.trafficBilling.configs.invalidate();
    utils.trafficBilling.status.invalidate();
    utils.trafficBilling.storeResources.invalidate();
  };

  const setEnabledMutation = trpc.trafficBilling.setEnabled.useMutation({
    onSuccess: () => {
      invalidateBilling();
      toast.success("流量计费开关已更新");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });
  const saveConfig = trpc.trafficBilling.saveConfig.useMutation({
    onSuccess: () => {
      invalidateBilling();
      toast.success("计费配置已保存");
      setDialogOpen(false);
      setConfigForm(defaultBillingConfigForm());
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const deleteConfig = trpc.trafficBilling.deleteConfig.useMutation({
    onSuccess: () => {
      invalidateBilling();
      toast.success("计费配置已删除");
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const openCreate = () => {
    setConfigForm(defaultBillingConfigForm());
    setDialogOpen(true);
  };

  const handleConfigViewModeChange = (viewMode: BillingConfigViewMode) => {
    setConfigViewMode(viewMode);
    storeBillingConfigViewMode(viewMode);
  };

  useEffect(() => {
    if (createRequestKey > lastCreateRequestKey.current) openCreate();
    lastCreateRequestKey.current = createRequestKey;
  }, [createRequestKey]);

  const openEdit = (config: any) => {
    setConfigForm({
      id: Number(config.id),
      resourceType: config.resourceType === "tunnel" ? "tunnel" : "host",
      resourceId: String(config.resourceId || ""),
      description: String(config.description || ""),
      price: formatPriceInput(pricePerGbMilliCents(config)),
      multiplier: String((Number(config.multiplier || 100) / 100).toFixed(2)).replace(/\.00$/, ""),
      enabled: config.enabled !== false,
      requiresPermission: !!config.requiresPermission,
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    const id = Number(configForm.resourceId);
    const pricePerGbMilliCents = Math.round(Number(configForm.price || 0) * MILLI_CENTS_PER_YUAN);
    const multiplierValue = Math.round(Number(configForm.multiplier || 1) * 100);
    if (!id) return toast.error("请选择资源");
    if (pricePerGbMilliCents < MIN_PRICE_PER_GB_MILLI_CENTS) return toast.error("单价最低 0.001/GB");
    if (multiplierValue < 1 || multiplierValue > 3000) return toast.error("倍率必须在 0.01 - 30 之间");
    saveConfig.mutate({
      id: configForm.id,
      resourceType: configForm.resourceType,
      resourceId: id,
      enabled: configForm.enabled,
      requiresPermission: configForm.requiresPermission,
      description: configForm.description.trim() || undefined,
      pricePerGbMilliCents,
      multiplier: multiplierValue,
    });
  };

  return (
    <div className="space-y-6">
      {showHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">流量计费管理</h1>
            <p className="text-sm text-muted-foreground">按资源设置流量单价。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
              <span className="text-sm text-muted-foreground">功能开关</span>
              {configsLoading ? (
                <Skeleton className="h-6 w-11 rounded-full" />
              ) : (
                <Switch checked={!!data?.enabled} disabled={setEnabledMutation.isPending} onCheckedChange={(checked) => setEnabledMutation.mutate({ enabled: checked })} />
              )}
            </div>
            {!hideCreateButton && (
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> 新增计费资源
              </Button>
            )}
          </div>
        </div>
      )}

      {!showHeader && showEmbeddedHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">按量计费资源</h2>
            <p className="text-sm text-muted-foreground">公开资源会在商店中展示，用户有余额即可直接使用。</p>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
            <span className="text-sm text-muted-foreground">功能开关</span>
            {configsLoading ? (
              <Skeleton className="h-6 w-11 rounded-full" />
            ) : (
              <Switch checked={!!data?.enabled} disabled={setEnabledMutation.isPending} onCheckedChange={(checked) => setEnabledMutation.mutate({ enabled: checked })} />
            )}
          </div>
        </div>
      )}

      {showSummary && (
        <div className="grid gap-4 md:grid-cols-3">
          <TrafficBillingStatCard
            title="累计扣费"
            value={money(totalCharged)}
            subtitle="历史扣费合计"
            icon={Coins}
            tone="bg-gradient-to-br from-teal-500 to-teal-600"
            loading={summaryLoading}
            cacheKey="trafficBilling.totalCharged"
            fallbackValue={money(0)}
          />
          <TrafficBillingStatCard
            title="已计费流量"
            value={`${totalGb} GB`}
            subtitle="扣费记录累计"
            icon={Gauge}
            tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
            loading={summaryLoading}
            cacheKey="trafficBilling.totalGb"
            fallbackValue="0 GB"
          />
          <TrafficBillingStatCard
            title="计费资源"
            value={data?.configs?.length || 0}
            subtitle="已配置资源"
            icon={ReceiptText}
            tone="bg-gradient-to-br from-orange-500 to-orange-600"
            loading={configsLoading}
            cacheKey="trafficBilling.configsCount"
            fallbackValue={0}
          />
        </div>
      )}

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>计费配置</CardTitle>
            <CardDescription>按 GB 扣费，可设置是否需要额外授权。</CardDescription>
          </div>
          <div className="flex items-center overflow-hidden rounded-md border border-border/40">
            <Button
              variant={configViewMode === "card" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title="卡片视图"
              onClick={() => handleConfigViewModeChange("card")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={configViewMode === "table" ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 rounded-none"
              title="列表视图"
              onClick={() => handleConfigViewModeChange("table")}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {configsLoading ? (
            <DataSectionLoading label="正在加载计费配置" />
          ) : (
            <AutoAnimateContainer duration={220}>
              {configViewMode === "card" ? (
                <AutoAnimateContainer key="billing-config-card-view" className="standard-card-grid gap-3" duration={220}>
                  {(data?.configs || []).map((config: any) => (
                    <BillingConfigCard
                      key={config.id}
                      config={config}
                      onEdit={() => openEdit(config)}
                      onDelete={() => deleteConfig.mutate({ id: config.id })}
                    />
                  ))}
                  {(data?.configs || []).length === 0 && (
                    <div className="col-span-full rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无计费配置</div>
                  )}
                </AutoAnimateContainer>
              ) : (
                <div key="billing-config-table-view" className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>资源</TableHead><TableHead>单价</TableHead><TableHead>倍率</TableHead><TableHead>权限</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                    <AutoAnimateContainer as={TableBody} duration={220}>
                      {(data?.configs || []).map((config: any) => (
                        <TableRow key={config.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {config.resourceType === "host" ? <Server className="h-4 w-4 text-muted-foreground" /> : <Route className="h-4 w-4 text-muted-foreground" />}
                              <span>{config.resourceName}</span>
                            </div>
                          </TableCell>
                          <TableCell>{formatPricePerGb(config)} / GB</TableCell>
                          <TableCell>{(Number(config.multiplier || 100) / 100).toFixed(2)}x</TableCell>
                          <TableCell>
                            <Badge variant={config.requiresPermission ? "outline" : "secondary"}>
                              {config.requiresPermission ? "需要授权" : "公开可用"}
                            </Badge>
                          </TableCell>
                          <TableCell><Badge variant={config.enabled ? "outline" : "secondary"}>{config.enabled ? "启用" : "停用"}</Badge></TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="icon" onClick={() => openEdit(config)}><Pencil className="h-4 w-4" /></Button>
                              <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteConfig.mutate({ id: config.id })}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {(data?.configs || []).length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">暂无计费配置</TableCell>
                        </TableRow>
                      )}
                    </AutoAnimateContainer>
                  </Table>
                </div>
              )}
            </AutoAnimateContainer>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl sm:max-h-[90svh]">
          <DialogHeader>
            <DialogTitle>{configForm.id ? "编辑计费资源" : "新增计费资源"}</DialogTitle>
            <DialogDescription>设置计费资源、单价倍率和使用权限。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>类型</Label>
              <Select
                value={configForm.resourceType}
                onValueChange={(value: BillingResourceType) => setConfigForm((current) => ({ ...current, resourceType: value, resourceId: "" }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="host">主机</SelectItem><SelectItem value="tunnel">隧道</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>资源</Label>
              <Select value={configForm.resourceId} onValueChange={(resourceId) => setConfigForm((current) => ({ ...current, resourceId }))}>
                <SelectTrigger><SelectValue placeholder="选择资源" /></SelectTrigger>
                <SelectContent>
                  {resources.map((item: any) => (
                    <SelectItem key={item.id} value={String(item.id)}>{resourceLabel(item)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>单价 / GB</Label>
              <Input type="number" min={0.001} step="0.001" value={configForm.price} onChange={(e) => setConfigForm((current) => ({ ...current, price: e.target.value }))} placeholder="例如 0.001" />
            </div>
            <div className="space-y-2">
              <Label>倍率</Label>
              <Input type="number" min={0.01} max={30} step="0.01" value={configForm.multiplier} onChange={(e) => setConfigForm((current) => ({ ...current, multiplier: e.target.value }))} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>说明</Label>
              <Textarea
                value={configForm.description}
                onChange={(e) => setConfigForm((current) => ({ ...current, description: e.target.value }))}
                placeholder="留空时商店展示系统默认说明"
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 p-3 sm:col-span-2">
              <div className="min-w-0">
                <Label className="text-sm">启用计费资源</Label>
                <p className="mt-1 text-xs text-muted-foreground">停用后该资源不再作为流量计费资源使用。</p>
              </div>
              <Switch className="shrink-0" checked={configForm.enabled} onCheckedChange={(enabled) => setConfigForm((current) => ({ ...current, enabled }))} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 p-3 sm:col-span-2">
              <div className="min-w-0">
                <Label className="text-sm">需要额外计费权限</Label>
                <p className="mt-1 text-xs text-muted-foreground">关闭时普通用户有余额即可使用；开启时需要在用户管理中单独授权。</p>
              </div>
              <Switch className="shrink-0" checked={configForm.requiresPermission} onCheckedChange={(requiresPermission) => setConfigForm((current) => ({ ...current, requiresPermission }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saveConfig.isPending}>取消</Button>
            <Button onClick={handleSave} disabled={saveConfig.isPending}>{saveConfig.isPending ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

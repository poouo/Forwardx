import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { planResourceParts } from "@/lib/planDisplay";
import { getTunnelRouteText } from "@/lib/tunnelDisplay";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Package, Plus, RefreshCw, Settings2, ShoppingBag, Trash2 } from "lucide-react";
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
  rateLimitMB: string;
  maxRules: string;
  maxConnections: string;
  maxIPs: string;
  isActive: boolean;
  isStoreVisible: boolean;
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

const emptyForm: PlanForm = {
  name: "",
  description: "",
  price: "0",
  currency: "CNY",
  durationDays: "30",
  portCount: "20",
  trafficGB: "0",
  rateLimitMB: "0",
  maxRules: "20",
  maxConnections: "2000",
  maxIPs: "10",
  isActive: true,
  isStoreVisible: true,
  sortOrder: "0",
  hostIds: [],
  tunnelIds: [],
  forwardGroupIds: [],
  trafficAddons: [],
};

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
  return value ? `${bytes(value)}/s` : "不限";
}

const durationOptions = [
  { value: "30", label: "一个月" },
  { value: "90", label: "三个月" },
  { value: "180", label: "半年" },
  { value: "365", label: "一年" },
  { value: "730", label: "两年" },
];

function durationLabel(days?: number | null) {
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
    rateLimitMB: String(Number(plan.rateLimitMbps || 0) / 1024 / 1024 || 0),
    maxRules: String(plan.maxRules ?? 20),
    maxConnections: String(plan.maxConnections ?? 2000),
    maxIPs: String(plan.maxIPs ?? 10),
    isActive: !!plan.isActive,
    isStoreVisible: !!plan.isStoreVisible,
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
    rateLimitMbps: Math.max(0, Math.floor(Number(form.rateLimitMB || 0) * 1024 * 1024)),
    maxRules: Math.max(0, Math.floor(Number(form.maxRules || 0))),
    maxConnections: Math.max(0, Math.floor(Number(form.maxConnections || 0))),
    maxIPs: Math.max(0, Math.floor(Number(form.maxIPs || 0))),
    isActive: form.isActive,
    isStoreVisible: form.isStoreVisible,
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
  const { data: storeStatus } = trpc.plans.storeStatus.useQuery();
  const { data: hosts = [] } = trpc.hosts.listAll.useQuery();
  const { data: tunnels = [] } = trpc.tunnels.list.useQuery();
  const { data: forwardGroups = [] } = trpc.forwardGroups.list.useQuery();
  const { data: users = [] } = trpc.users.list.useQuery();
  const { data: subscriptions = [] } = trpc.plans.subscriptions.useQuery({});

  const [form, setForm] = useState<PlanForm>(emptyForm);
  const [editing, setEditing] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState("");
  const [assignPlanId, setAssignPlanId] = useState("");

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

  const deletePlan = trpc.plans.delete.useMutation({
    onSuccess: () => {
      toast.success("套餐已删除");
      utils.plans.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const setStoreEnabled = trpc.plans.setStoreEnabled.useMutation({
    onSuccess: () => {
      utils.plans.storeStatus.invalidate();
      toast.success("商店状态已更新");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const assignPlan = trpc.plans.assign.useMutation({
    onSuccess: (result) => {
      toast.success(`套餐已分配，端口段 ${result.portRangeStart}-${result.portRangeEnd}`);
      setAssignOpen(false);
      setAssignUserId("");
      setAssignPlanId("");
      utils.plans.subscriptions.invalidate();
      utils.users.list.invalidate();
    },
    onError: (error) => toast.error(error.message || "分配失败"),
  });

  const activePlans = useMemo(() => plans.filter((p: any) => p.isActive).length, [plans]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditing(true);
  };

  const save = () => {
    if (!form.name.trim()) return toast.error("请填写套餐名称");
    if (form.hostIds.length === 0 && form.tunnelIds.length === 0 && form.forwardGroupIds.length === 0) return toast.error("至少选择一个主机、隧道或转发组");
    const data = payload(form);
    if (form.id) updatePlan.mutate({ id: form.id, ...data });
    else createPlan.mutate(data);
  };

  const toggleId = (list: number[], id: number) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
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
              <Plus className="mr-2 h-4 w-4" /> 新增套餐
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>商店状态</CardDescription>
              <CardTitle className="flex items-center justify-between">
                {storeStatus?.enabled ? "已开启" : "已关闭"}
                <Switch checked={!!storeStatus?.enabled} onCheckedChange={(enabled) => setStoreEnabled.mutate({ enabled })} />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">开启后用户可自助购买。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>套餐数量</CardDescription>
              <CardTitle>{plans.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">其中 {activePlans} 个处于启用状态。</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>订阅记录</CardDescription>
              <CardTitle>{subscriptions.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">包含购买和分配记录。</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" /> 套餐列表</CardTitle>
            <CardDescription>订阅后分配连续端口段。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:hidden">
              {plans.map((plan: any) => (
                <div key={plan.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{plan.name}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{plan.description || "无描述"}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => { setForm(toForm(plan)); setEditing(true); }}>编辑</Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => deletePlan.mutate({ id: plan.id })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                    <MobileInfoRow label="价格">{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</MobileInfoRow>
                    <MobileInfoRow label="资源">
                      <div className="flex flex-wrap justify-end gap-1">
                        {planResourceParts(plan).map((item) => (
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
                      <div className="flex flex-wrap justify-end gap-1">
                        <Badge variant={plan.isActive ? "default" : "secondary"}>{plan.isActive ? "启用" : "停用"}</Badge>
                        <Badge variant={plan.isStoreVisible ? "outline" : "secondary"}>{plan.isStoreVisible ? "商店可见" : "后台分配"}</Badge>
                      </div>
                    </MobileInfoRow>
                  </div>
                </div>
              ))}
              {!isLoading && plans.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">还没有套餐</div>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
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
              <TableBody>
                {plans.map((plan: any) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="font-medium">{plan.name}</div>
                      <div className="max-w-md truncate text-xs text-muted-foreground">{plan.description || "无描述"}</div>
                    </TableCell>
                    <TableCell>{money(plan.priceCents, plan.currency)} / {durationLabel(plan.durationDays)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {planResourceParts(plan).map((item) => (
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
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={plan.isActive ? "default" : "secondary"}>{plan.isActive ? "启用" : "停用"}</Badge>
                        <Badge variant={plan.isStoreVisible ? "outline" : "secondary"}>{plan.isStoreVisible ? "商店可见" : "后台分配"}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => { setForm(toForm(plan)); setEditing(true); }}>编辑</Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deletePlan.mutate({ id: plan.id })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!isLoading && plans.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">还没有套餐</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>订阅记录</CardTitle>
            <CardDescription>订阅记录。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:hidden">
              {subscriptions.slice(0, 20).map((sub: any) => (
                <div key={sub.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{sub.name || sub.username || `用户 #${sub.userId}`}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{sub.planName || `套餐 #${sub.planId}`}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0">{sub.source === "payment" ? "购买" : "后台分配"}</Badge>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                    <MobileInfoRow label="端口段">{sub.portRangeStart}-{sub.portRangeEnd}</MobileInfoRow>
                    <MobileInfoRow label="到期时间">{sub.expiresAt ? new Date(sub.expiresAt).toLocaleString() : "永久"}</MobileInfoRow>
                  </div>
                </div>
              ))}
              {subscriptions.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无订阅记录</div>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>端口段</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>到期时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.slice(0, 20).map((sub: any) => (
                  <TableRow key={sub.id}>
                    <TableCell>{sub.name || sub.username || `用户 #${sub.userId}`}</TableCell>
                    <TableCell>{sub.planName || `套餐 #${sub.planId}`}</TableCell>
                    <TableCell>{sub.portRangeStart}-{sub.portRangeEnd}</TableCell>
                    <TableCell><Badge variant="outline">{sub.source === "payment" ? "购买" : "后台分配"}</Badge></TableCell>
                    <TableCell>{sub.expiresAt ? new Date(sub.expiresAt).toLocaleString() : "永久"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-3xl sm:max-h-[90svh]">
          <DialogHeader>
            <DialogTitle>{form.id ? "编辑套餐" : "新增套餐"}</DialogTitle>
            <DialogDescription>选择订阅后可用资源。</DialogDescription>
          </DialogHeader>
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
              <Label>限速（MB/s，0 为不限）</Label>
              <Input type="number" min={0} value={form.rateLimitMB} onChange={(e) => setForm({ ...form, rateLimitMB: e.target.value })} />
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
            <div className="space-y-2 md:col-span-2">
              <Label>说明</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="展示给用户看的套餐说明" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">转发主机</CardTitle></CardHeader>
              <CardContent className="grid max-h-56 gap-2 overflow-y-auto">
                {hosts.map((host: any) => (
                  <label key={host.id} className="flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm">
                    <span>{host.name || host.ipv4 || host.ipv6}</span>
                    <Switch checked={form.hostIds.includes(host.id)} onCheckedChange={() => setForm({ ...form, hostIds: toggleId(form.hostIds, host.id) })} />
                  </label>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">隧道转发</CardTitle></CardHeader>
              <CardContent className="grid max-h-56 gap-2 overflow-y-auto">
                {tunnels.map((tunnel: any) => (
                  <label key={tunnel.id} className="flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm">
                    <span className="min-w-0">
                      <span>{tunnel.name}</span>
                      <span className="ml-1 text-muted-foreground">/ {getTunnelRouteText(tunnel, hosts)} / {tunnel.mode}</span>
                    </span>
                    <Switch checked={form.tunnelIds.includes(tunnel.id)} onCheckedChange={() => setForm({ ...form, tunnelIds: toggleId(form.tunnelIds, tunnel.id) })} />
                  </label>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">转发组</CardTitle></CardHeader>
              <CardContent className="grid max-h-56 gap-2 overflow-y-auto">
                {forwardGroups.map((group: any) => (
                  <label key={group.id} className="flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm">
                    <span>{group.name} <span className="text-muted-foreground">/{group.groupType === "tunnel" ? "隧道组" : "主机组"}</span></span>
                    <Switch checked={form.forwardGroupIds.includes(group.id)} onCheckedChange={() => setForm({ ...form, forwardGroupIds: toggleId(form.forwardGroupIds, group.id) })} />
                  </label>
                ))}
                {forwardGroups.length === 0 && (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">暂无转发组</div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 p-4">
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

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm"><Switch checked={form.isActive} onCheckedChange={(isActive) => setForm({ ...form, isActive })} /> 启用套餐</label>
            <label className="flex items-center gap-2 text-sm"><Switch checked={form.isStoreVisible} onCheckedChange={(isStoreVisible) => setForm({ ...form, isStoreVisible })} /> 商店可见</label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
            <Button onClick={save} disabled={createPlan.isPending || updatePlan.isPending}>
              {(createPlan.isPending || updatePlan.isPending) ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
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
              <Select value={assignPlanId} onValueChange={setAssignPlanId}>
                <SelectTrigger><SelectValue placeholder="选择套餐" /></SelectTrigger>
                <SelectContent>
                  {plans.map((plan: any) => <SelectItem key={plan.id} value={String(plan.id)}>{plan.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>取消</Button>
            <Button
              onClick={() => assignPlan.mutate({ userId: Number(assignUserId), planId: Number(assignPlanId) })}
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

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { Coins, Gauge, Plus, ReceiptText, Server, Trash2, Route } from "lucide-react";
import { useMemo, useState, type ElementType, type ReactNode } from "react";
import { toast } from "sonner";

function money(cents?: number | null) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((Number(cents) || 0) / 100);
}

function formatBytes(bytes: number | string | null | undefined) {
  const num = Number(bytes);
  if (!num || Number.isNaN(num)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
  return `${parseFloat((num / 1024 ** index).toFixed(index === 0 ? 0 : 2))} ${units[index]}`;
}

function TrafficBillingStatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ElementType;
  tone: string;
}) {
  return (
    <Card className="group relative overflow-hidden border-border/40 bg-card/60 backdrop-blur-md transition-all duration-300 hover:border-border/70">
      <div className={`absolute inset-0 opacity-[0.04] transition-opacity group-hover:opacity-[0.08] ${tone}`} />
      <CardContent className="relative p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
            <p className="break-words text-2xl font-bold tracking-tight tabular-nums">{value}</p>
            {subtitle && <p className="break-words text-xs text-muted-foreground/80">{subtitle}</p>}
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

export default function TrafficBilling() {
  const utils = trpc.useUtils();
  const { data: hosts = [] } = trpc.hosts.listAll.useQuery();
  const { data: tunnels = [] } = trpc.tunnels.listAll.useQuery();
  const { data } = trpc.trafficBilling.configs.useQuery();
  const { data: records = [] } = trpc.trafficBilling.records.useQuery({ limit: 100 });
  const [resourceType, setResourceType] = useState<"host" | "tunnel">("host");
  const [resourceId, setResourceId] = useState("");
  const [price, setPrice] = useState("");
  const [multiplier, setMultiplier] = useState("1");
  const [enabled, setEnabled] = useState(true);

  const resources = resourceType === "host" ? hosts : tunnels;
  const totalCharged = useMemo(() => records.reduce((sum: number, item: any) => sum + Number(item.amountCents || 0), 0), [records]);
  const totalGb = useMemo(() => records.reduce((sum: number, item: any) => sum + Number(item.billedGb || 0), 0), [records]);

  const setEnabledMutation = trpc.trafficBilling.setEnabled.useMutation({
    onSuccess: () => {
      utils.trafficBilling.configs.invalidate();
      toast.success("流量计费开关已更新");
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });
  const saveConfig = trpc.trafficBilling.saveConfig.useMutation({
    onSuccess: () => {
      utils.trafficBilling.configs.invalidate();
      toast.success("计费配置已保存");
      setResourceId("");
      setPrice("");
      setMultiplier("1");
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  const deleteConfig = trpc.trafficBilling.deleteConfig.useMutation({
    onSuccess: () => {
      utils.trafficBilling.configs.invalidate();
      toast.success("计费配置已删除");
    },
    onError: (error) => toast.error(error.message || "删除失败"),
  });

  const handleSave = () => {
    const id = Number(resourceId);
    const pricePerGbCents = Math.round(Number(price || 0) * 100);
    const multiplierValue = Math.round(Number(multiplier || 1) * 100);
    if (!id) return toast.error("请选择资源");
    if (pricePerGbCents <= 0) return toast.error("请输入有效单价");
    if (multiplierValue < 1 || multiplierValue > 3000) return toast.error("倍率必须在 0.01 - 30 之间");
    saveConfig.mutate({ resourceType, resourceId: id, enabled, pricePerGbCents, multiplier: multiplierValue });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">流量计费管理</h1>
            <p className="text-sm text-muted-foreground">按资源设置流量单价。</p>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
            <span className="text-sm text-muted-foreground">功能开关</span>
            <Switch checked={!!data?.enabled} onCheckedChange={(checked) => setEnabledMutation.mutate({ enabled: checked })} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <TrafficBillingStatCard
            title="累计扣费"
            value={money(totalCharged)}
            subtitle="历史扣费合计"
            icon={Coins}
            tone="bg-gradient-to-br from-blue-500 to-blue-600"
          />
          <TrafficBillingStatCard
            title="已计费流量"
            value={`${totalGb} GB`}
            subtitle="扣费记录累计"
            icon={Gauge}
            tone="bg-gradient-to-br from-emerald-500 to-emerald-600"
          />
          <TrafficBillingStatCard
            title="计费资源"
            value={data?.configs?.length || 0}
            subtitle="已配置资源"
            icon={ReceiptText}
            tone="bg-gradient-to-br from-violet-500 to-violet-600"
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5" /> 新增计费资源</CardTitle>
            <CardDescription>按 GB 阶梯扣费。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-[140px_1fr_140px_140px_90px_auto] md:items-end">
            <div className="space-y-2">
              <Label>类型</Label>
              <Select value={resourceType} onValueChange={(value: "host" | "tunnel") => { setResourceType(value); setResourceId(""); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="host">主机</SelectItem><SelectItem value="tunnel">隧道</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>资源</Label>
              <Select value={resourceId} onValueChange={setResourceId}>
                <SelectTrigger><SelectValue placeholder="选择资源" /></SelectTrigger>
                <SelectContent>
                  {resources.map((item: any) => (
                    <SelectItem key={item.id} value={String(item.id)}>{item.name} #{item.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>单价 / GB</Label><Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
            <div className="space-y-2"><Label>倍率</Label><Input type="number" min={0.01} max={30} step="0.01" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} /></div>
            <div className="space-y-2"><Label>启用</Label><div className="flex h-10 items-center"><Switch checked={enabled} onCheckedChange={setEnabled} /></div></div>
            <Button onClick={handleSave} disabled={saveConfig.isPending}>保存</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>计费配置</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:hidden">
              {(data?.configs || []).map((config: any) => (
                <div key={config.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {config.resourceType === "host" ? <Server className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Route className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 break-words text-sm font-medium">{config.resourceName}</span>
                    </div>
                    <Button variant="ghost" size="icon" className="-mr-2 -mt-2 shrink-0 text-destructive" onClick={() => deleteConfig.mutate({ id: config.id })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                    <MobileInfoRow label="类型">{config.resourceType === "host" ? "主机" : "隧道"} #{config.resourceId}</MobileInfoRow>
                    <MobileInfoRow label="单价">{money(config.pricePerGbCents)} / GB</MobileInfoRow>
                    <MobileInfoRow label="倍率">{(Number(config.multiplier || 100) / 100).toFixed(2)}x</MobileInfoRow>
                    <MobileInfoRow label="状态"><Badge variant={config.enabled ? "outline" : "secondary"}>{config.enabled ? "启用" : "停用"}</Badge></MobileInfoRow>
                  </div>
                </div>
              ))}
              {(data?.configs || []).length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无计费配置</div>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
              <TableHeader><TableRow><TableHead>资源</TableHead><TableHead>单价</TableHead><TableHead>倍率</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {(data?.configs || []).map((config: any) => (
                  <TableRow key={config.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {config.resourceType === "host" ? <Server className="h-4 w-4 text-muted-foreground" /> : <Route className="h-4 w-4 text-muted-foreground" />}
                        <span>{config.resourceName}</span>
                      </div>
                    </TableCell>
                    <TableCell>{money(config.pricePerGbCents)} / GB</TableCell>
                    <TableCell>{(Number(config.multiplier || 100) / 100).toFixed(2)}x</TableCell>
                    <TableCell><Badge variant={config.enabled ? "outline" : "secondary"}>{config.enabled ? "启用" : "停用"}</Badge></TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="text-destructive" onClick={() => deleteConfig.mutate({ id: config.id })}><Trash2 className="h-4 w-4" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Coins className="h-5 w-5" /> 扣费记录</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:hidden">
              {records.map((record: any) => (
                <div key={record.id} className="rounded-lg border border-border/50 bg-background/40 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{record.name || record.username || `#${record.userId}`}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">{record.ruleName || `#${record.ruleId}`}</p>
                    </div>
                    <div className="shrink-0 text-right text-sm font-medium text-destructive">-{money(record.amountCents)}</div>
                  </div>
                  <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                    <MobileInfoRow label="资源">{record.resourceType === "host" ? "主机" : "隧道"} #{record.resourceId}</MobileInfoRow>
                    <MobileInfoRow label="流量">{formatBytes(record.bytes)} / 计费 {record.billedGb}GB</MobileInfoRow>
                    <MobileInfoRow label="时间">{record.createdAt ? new Date(record.createdAt).toLocaleString() : "-"}</MobileInfoRow>
                  </div>
                </div>
              ))}
              {records.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无扣费记录</div>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
              <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>规则</TableHead><TableHead>资源</TableHead><TableHead>流量</TableHead><TableHead>金额</TableHead><TableHead>时间</TableHead></TableRow></TableHeader>
              <TableBody>
                {records.map((record: any) => (
                  <TableRow key={record.id}>
                    <TableCell>{record.name || record.username || `#${record.userId}`}</TableCell>
                    <TableCell>{record.ruleName || `#${record.ruleId}`}</TableCell>
                    <TableCell>{record.resourceType === "host" ? "主机" : "隧道"} #{record.resourceId}</TableCell>
                    <TableCell>{formatBytes(record.bytes)} / 计费 {record.billedGb}GB</TableCell>
                    <TableCell className="text-destructive">-{money(record.amountCents)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{record.createdAt ? new Date(record.createdAt).toLocaleString() : "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

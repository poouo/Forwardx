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
import { Coins, Plus, Server, Trash2, Route } from "lucide-react";
import { useMemo, useState } from "react";
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
            <p className="text-sm text-muted-foreground">按主机或隧道设置 GB 单价和倍率，用户需被授权后才能使用。</p>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2">
            <span className="text-sm text-muted-foreground">功能开关</span>
            <Switch checked={!!data?.enabled} onCheckedChange={(checked) => setEnabledMutation.mutate({ enabled: checked })} />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card><CardHeader className="pb-2"><CardDescription>累计扣费</CardDescription><CardTitle>{money(totalCharged)}</CardTitle></CardHeader></Card>
          <Card><CardHeader className="pb-2"><CardDescription>已计费流量</CardDescription><CardTitle>{totalGb} GB</CardTitle></CardHeader></Card>
          <Card><CardHeader className="pb-2"><CardDescription>计费资源</CardDescription><CardTitle>{data?.configs?.length || 0}</CardTitle></CardHeader></Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5" /> 新增计费资源</CardTitle>
            <CardDescription>不足 1GB 先按 1GB 扣费；之后每跨过新的 GB 档位再扣下一 GB。</CardDescription>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Coins className="h-5 w-5" /> 扣费记录</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

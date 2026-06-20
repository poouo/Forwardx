import { useEffect, useMemo, useState } from "react";
import { Activity, Loader2, Pencil, RadioTower, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

type ServiceForm = {
  name: string;
  method: "tcping" | "ping";
  targetIp: string;
  targetPort: string;
  hostScope: "all" | "exclude" | "specific";
  hostIds: number[];
  excludeHostIds: number[];
  intervalSeconds: number;
  isEnabled: boolean;
};

const defaultForm: ServiceForm = {
  name: "",
  method: "tcping",
  targetIp: "",
  targetPort: "",
  hostScope: "all",
  hostIds: [],
  excludeHostIds: [],
  intervalSeconds: 30,
  isEnabled: true,
};

function toggleId(ids: number[], id: number) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

function serviceTarget(service: any) {
  return service.method === "ping" ? service.targetIp : `${service.targetIp}:${service.targetPort || "-"}`;
}

function scopeText(service: any, hostsById: Map<number, any>) {
  const names = (ids: number[]) => ids.map((id) => hostsById.get(id)?.name || `#${id}`).join("、");
  if (service.hostScope === "specific") return service.hostIds?.length ? `特定主机：${names(service.hostIds)}` : "特定主机";
  if (service.hostScope === "exclude") return service.excludeHostIds?.length ? `所有主机，排除：${names(service.excludeHostIds)}` : "所有主机";
  return "所有主机";
}

export default function HostProbeServiceManager({ createSignal, onCreateSignalHandled }: { createSignal: number; onCreateSignalHandled: () => void }) {
  const utils = trpc.useUtils();
  const { data: hosts = [] } = trpc.hosts.list.useQuery(undefined, { staleTime: 30000 });
  const { data: services = [], isLoading } = trpc.hosts.probeServices.useQuery(undefined, { refetchInterval: 30000 });
  const hostsById = useMemo(() => new Map((hosts as any[]).map((host) => [Number(host.id), host])), [hosts]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ServiceForm>(defaultForm);

  const createMutation = trpc.hosts.createProbeService.useMutation({
    onSuccess: () => { utils.hosts.probeServices.invalidate(); setDialogOpen(false); setForm(defaultForm); toast.success("服务已添加"); },
    onError: (err) => toast.error(err.message || "添加服务失败"),
  });
  const updateMutation = trpc.hosts.updateProbeService.useMutation({
    onSuccess: () => { utils.hosts.probeServices.invalidate(); setDialogOpen(false); setEditingId(null); setForm(defaultForm); toast.success("服务已更新"); },
    onError: (err) => toast.error(err.message || "更新服务失败"),
  });
  const deleteMutation = trpc.hosts.deleteProbeService.useMutation({
    onSuccess: () => { utils.hosts.probeServices.invalidate(); toast.success("服务已删除"); },
    onError: (err) => toast.error(err.message || "删除服务失败"),
  });

  useEffect(() => {
    if (createSignal <= 0) return;
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
    onCreateSignalHandled();
  }, [createSignal, onCreateSignalHandled]);

  const submit = () => {
    const name = form.name.trim();
    const targetIp = form.targetIp.trim();
    const targetPort = Number(form.targetPort);
    if (!name) { toast.error("请输入服务名称"); return; }
    if (!targetIp) { toast.error("请输入 IP 地址"); return; }
    if (form.method === "tcping" && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) { toast.error("目标端口必须在 1-65535 之间"); return; }
    if (form.hostScope === "specific" && form.hostIds.length === 0) { toast.error("请选择需要运行服务的主机"); return; }
    const payload = { ...form, name, targetIp, targetPort: form.method === "tcping" ? targetPort : null, intervalSeconds: Math.max(5, Number(form.intervalSeconds) || 30) };
    if (editingId) updateMutation.mutate({ ...payload, id: editingId });
    else createMutation.mutate(payload);
  };

  const openEdit = (service: any) => {
    setEditingId(Number(service.id));
    setForm({
      name: service.name || "",
      method: service.method === "ping" ? "ping" : "tcping",
      targetIp: service.targetIp || "",
      targetPort: service.targetPort ? String(service.targetPort) : "",
      hostScope: service.hostScope === "exclude" || service.hostScope === "specific" ? service.hostScope : "all",
      hostIds: service.hostIds || [],
      excludeHostIds: service.excludeHostIds || [],
      intervalSeconds: Math.max(5, Number(service.intervalSeconds) || 30),
      isEnabled: service.isEnabled !== false,
    });
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载服务</div>
          ) : (services as any[]).length === 0 ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center text-muted-foreground">
              <RadioTower className="mb-3 h-9 w-9 opacity-40" />
              <p className="text-sm">暂无服务</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>服务</TableHead>
                    <TableHead>目标</TableHead>
                    <TableHead>主机范围</TableHead>
                    <TableHead>运行时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(services as any[]).map((service) => (
                    <TableRow key={service.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Activity className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="font-medium">{service.name}</div>
                            <Badge variant="outline" className="mt-1 px-1.5 py-0 text-[10px] uppercase">{service.method}</Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{serviceTarget(service)}</TableCell>
                      <TableCell className="max-w-[360px] truncate text-sm" title={scopeText(service, hostsById)}>{scopeText(service, hostsById)}</TableCell>
                      <TableCell className="text-sm tabular-nums">{service.intervalSeconds || 30}S</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(service)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => { if (confirm("确定要删除此服务吗？")) deleteMutation.mutate({ id: service.id }); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑服务" : "添加服务"}</DialogTitle>
            <DialogDescription>配置主机 Ping / TCPing 探测服务</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>服务名</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如: 公网 API 延迟" /></div>
              <div className="space-y-1.5"><Label>类型</Label><Select value={form.method} onValueChange={(value) => setForm({ ...form, method: value as ServiceForm["method"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tcping">TCPing</SelectItem><SelectItem value="ping">Ping</SelectItem></SelectContent></Select></div>
            </div>
            <div className={`grid gap-3 ${form.method === "tcping" ? "sm:grid-cols-[minmax(0,1fr)_150px]" : ""}`}>
              <div className="space-y-1.5"><Label>IP 地址 / 域名</Label><Input value={form.targetIp} onChange={(e) => setForm({ ...form, targetIp: e.target.value })} placeholder="1.1.1.1 或 example.com" /></div>
              {form.method === "tcping" && <div className="space-y-1.5"><Label>目标端口</Label><Input type="number" min={1} max={65535} value={form.targetPort} onChange={(e) => setForm({ ...form, targetPort: e.target.value })} placeholder="443" /></div>}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <div className="space-y-1.5"><Label>选择主机</Label><Select value={form.hostScope} onValueChange={(value) => setForm({ ...form, hostScope: value as ServiceForm["hostScope"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">所有主机</SelectItem><SelectItem value="exclude">排除主机</SelectItem><SelectItem value="specific">特定主机</SelectItem></SelectContent></Select></div>
              <div className="space-y-1.5"><Label>服务运行时间</Label><Input type="number" min={5} value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Math.max(5, Number(e.target.value) || 5) })} /></div>
            </div>
            {form.hostScope !== "all" && (
              <div className="space-y-2 rounded-md border border-border/50 p-3">
                <Label className="text-sm">{form.hostScope === "exclude" ? "添加需要排除在外的主机" : "选择需要运行服务的主机"}</Label>
                <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
                  {(hosts as any[]).map((host) => {
                    const ids = form.hostScope === "exclude" ? form.excludeHostIds : form.hostIds;
                    const checked = ids.includes(Number(host.id));
                    return (
                      <label key={host.id} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">{host.name}</span>
                        <Switch checked={checked} onCheckedChange={() => form.hostScope === "exclude" ? setForm({ ...form, excludeHostIds: toggleId(form.excludeHostIds, Number(host.id)) }) : setForm({ ...form, hostIds: toggleId(form.hostIds, Number(host.id)) })} />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2.5">
              <span className="text-sm font-medium">启用服务</span>
              <Switch checked={form.isEnabled} onCheckedChange={(checked) => setForm({ ...form, isEnabled: checked })} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={submit} disabled={createMutation.isPending || updateMutation.isPending}>{createMutation.isPending || updateMutation.isPending ? "处理中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
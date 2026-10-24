import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { t } from "@/i18n";
import HostStatusLabel from "@/components/HostStatusLabel";
import { trpc } from "@/lib/trpc";
import { toast } from "@/lib/localizedToast";
import { defaultResourceAlertService, resourceAlertServiceSchema, type ResourceAlertServiceInput, type ResourceAlertService } from "@shared/operationsMonitor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { HintSwitch } from "@/components/ui/hint-switch";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ResourceAlertSaveState = { ready: boolean; pending: boolean };

export function ResourceAlertFields({ settings, onChange, disabled = false }: {
  settings: ResourceAlertServiceInput;
  onChange: (patch: Partial<ResourceAlertServiceInput>) => void;
  disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    <div className="grid min-w-0 gap-2.5 sm:grid-cols-2 [&>*]:min-w-0">
      <div className="space-y-1">
        <Label className="flex min-h-5 items-center text-xs" htmlFor="resource-alert-name">{t("服务名")}</Label>
        <Input id="resource-alert-name" className="h-9 sm:h-8" maxLength={80} value={settings.name} onChange={event => onChange({ name: event.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="flex min-h-5 items-center text-xs" htmlFor="resource-alert-metric">{t("告警项目")}</Label>
        <div className="flex min-w-0 items-center gap-2">
          <Select value={settings.metric} onValueChange={metric => {
            const label = (value: string) => value === "cpu" ? "CPU" : t(value === "memory" ? "内存" : "磁盘");
            onChange({ metric: metric as ResourceAlertServiceInput["metric"], ...(settings.name === label(settings.metric) ? { name: label(metric) } : {}) });
          }}>
            <SelectTrigger id="resource-alert-metric" className="h-9 min-w-0 flex-1 sm:h-8"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="cpu">CPU</SelectItem><SelectItem value="memory">{t("内存")}</SelectItem><SelectItem value="disk">{t("磁盘")}</SelectItem></SelectContent>
          </Select>
          <Label htmlFor="resource-alert-enabled" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            {t("启用服务")}<Switch id="resource-alert-enabled" checked={settings.enabled} onCheckedChange={enabled => onChange({ enabled })} />
          </Label>
        </div>
      </div>
    </div>
    <div className="grid min-w-0 grid-cols-2 gap-2.5 sm:grid-cols-3 [&>*]:min-w-0">
      <div className="col-span-2 space-y-1 sm:col-span-1">
        <Label className="flex min-h-5 items-center text-xs" htmlFor="resource-alert-threshold">{t("阈值 (%)")}</Label>
        <Input id="resource-alert-threshold" className="h-9 sm:h-8" type="number" min={1} max={100} step="any" value={settings.threshold} onChange={event => onChange({ threshold: Number(event.target.value) })} />
      </div>
      {(["durationSeconds", "recoverySeconds"] as const).map(key => <div key={key} className="min-w-0 space-y-1">
        <Label className="flex min-h-5 items-center text-xs" htmlFor={"resource-" + key}>{t(key === "durationSeconds" ? "连续超限时长（秒）" : "恢复观察时长（秒）")}</Label>
        <Input className="h-9 sm:h-8" id={"resource-" + key} type="number" min={key === "durationSeconds" ? 60 : 30} max={key === "durationSeconds" ? 3600 : 600} step={1} value={settings[key]} onChange={event => onChange({ [key]: Number(event.target.value) })} />
      </div>)}
    </div>
  </fieldset>;
}

type AlertHost = { id: number; name: string; isOnline?: boolean | null };
type AlertScope = Pick<ResourceAlertServiceInput, "hostScope" | "hostIds" | "excludeHostIds">;

export function ResourceAlertHostPicker({ hosts, scope, onChange, notify, onNotifyChange, disabled = false }: {
  hosts: AlertHost[];
  scope: AlertScope;
  onChange: (patch: Partial<AlertScope>) => void;
  notify: boolean;
  onNotifyChange: (notify: boolean) => void;
  disabled?: boolean;
}) {
  const selectedIds = scope.hostScope === "exclude" ? scope.excludeHostIds : scope.hostIds;
  const selectedSet = new Set(selectedIds);
  const availableHosts = hosts.filter(host => !selectedSet.has(host.id));
  const setSelectedIds = (ids: number[]) => onChange(scope.hostScope === "exclude" ? { excludeHostIds: ids } : { hostIds: ids });
  return <div className="min-w-0 space-y-3">
    <div className="flex min-w-0 flex-wrap items-end gap-2.5">
      <div className="min-w-[8rem] flex-1 space-y-1">
        <Label className="text-xs" htmlFor="resource-alert-scope">{t("选择主机")}</Label>
        <Select disabled={disabled} value={scope.hostScope} onValueChange={hostScope => onChange({ hostScope: hostScope as AlertScope["hostScope"] })}>
          <SelectTrigger id="resource-alert-scope" className="h-9 sm:h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("所有主机")}</SelectItem>
            <SelectItem value="exclude">{t("排除主机")}</SelectItem>
            <SelectItem value="specific">{t("特定主机")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="ml-auto flex h-9 shrink-0 items-center gap-3 sm:h-8">
        <Label htmlFor="resource-alert-notify" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {t("发送通知")}
          <HintSwitch id="resource-alert-notify" checked={notify} disabled={disabled} onCheckedChange={onNotifyChange} hint={t("仅向管理员发送通知；关闭后仍记录告警。")} />
        </Label>
      </div>
    </div>
    {scope.hostScope !== "all" && <div className="space-y-2 rounded-md border border-border/50 bg-muted/15 p-2.5">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Label className="text-xs" htmlFor="resource-alert-host">{scope.hostScope === "exclude" ? t("添加需要排除在外的主机") : t("选择需要运行服务的主机")}</Label>
          {selectedIds.length > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{selectedIds.length}{t(" 台")}</span>}
        </div>
        <Select value="" disabled={disabled} onValueChange={id => setSelectedIds([...selectedIds, Number(id)])}>
          <SelectTrigger id="resource-alert-host" className="h-9 sm:h-8 sm:w-52 sm:shrink-0">
            <SelectValue placeholder={availableHosts.length === 0 ? t("已全部添加") : scope.hostScope === "exclude" ? t("添加排除主机...") : t("添加运行主机...")} />
          </SelectTrigger>
          <SelectContent>{availableHosts.length === 0 ? <div className="px-2 py-4 text-center text-xs text-muted-foreground">{t("已全部添加")}</div> : availableHosts.map(host => <SelectItem key={host.id} value={String(host.id)} textValue={host.name}><HostStatusLabel host={host} label={host.name} /></SelectItem>)}</SelectContent>
        </Select>
      </div>
      {selectedIds.length === 0 ? <p className="text-xs text-muted-foreground">{t("从上方选择主机")}</p> : <div className="max-h-40 space-y-1 overflow-y-auto">
        {selectedIds.map((id, index) => {
          const host = hosts.find(item => item.id === id);
          return <div key={id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">{index + 1}</span>
            <HostStatusLabel host={host} label={host?.name ?? "#" + id} className="min-w-0 text-sm font-medium" labelClassName="truncate" />
            <Button type="button" variant="ghost" size="icon" disabled={disabled} className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={t("移除主机")} onClick={() => setSelectedIds(selectedIds.filter(item => item !== id))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>;
        })}
      </div>}
    </div>}
  </div>;
}

export default function HostResourceAlertSettings({ hosts, formId, onSaveStateChange, service, onSaved }: {
  hosts: AlertHost[];
  formId: string;
  onSaveStateChange: (state: ResourceAlertSaveState) => void;
  service?: ResourceAlertService | null;
  onSaved: () => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<ResourceAlertServiceInput>(() => service ? (({ id, ...input }) => input)(service) : { ...defaultResourceAlertService });
  const patchSettings = (value: Partial<ResourceAlertServiceInput>) => setDraft(previous => ({ ...previous, ...value }));
  const save = trpc.hosts.saveResourceAlertService.useMutation({
    onSuccess: () => {
      void utils.hosts.resourceAlertServices.invalidate();
      void utils.hosts.managementCounts.invalidate();
      void utils.operations.monitor.invalidate();
      toast.success(t("已保存"));
      onSaved();
    },
    onError: error => toast.error(error.message),
  });
  const ready = resourceAlertServiceSchema.safeParse(draft).success;
  useEffect(() => {
    onSaveStateChange({ ready, pending: save.isPending });
  }, [ready, save.isPending, onSaveStateChange]);
  useEffect(() => () => onSaveStateChange({ ready: false, pending: false }), [onSaveStateChange]);

  return <form id={formId} className="min-w-0 space-y-3" onSubmit={event => {
    event.preventDefault();
    if (ready && !save.isPending) save.mutate({ id: service?.id, service: draft });
  }}>
    <ResourceAlertFields settings={draft} disabled={save.isPending} onChange={patchSettings} />
    <ResourceAlertHostPicker hosts={hosts} scope={draft} disabled={save.isPending} onChange={patchSettings} notify={draft.notify} onNotifyChange={notify => patchSettings({ notify })} />
  </form>;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type {
  PluginResourceCondition,
  PluginResourceDataSourceDefinition,
  PluginResourceFieldDefinition,
  PluginResourceOperationDefinition,
  PluginResourceViewDefinition,
} from "@shared/pluginTypes";
import {
  Check,
  CircleAlert,
  Clipboard,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

type SourceSnapshot = {
  data?: unknown;
  loadedAt: number;
  error?: string;
};

type TaskMeta = {
  actionId: string;
  sourceId?: string;
};

type FormMode = "create" | "edit";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function valueAtPath(value: unknown, path?: string) {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function rowIdentity(row: any, view: PluginResourceViewDefinition) {
  return String(valueAtPath(row, view.rowKey || "id") ?? "");
}

function valuesEqual(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right)) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  return String(left ?? "") === String(right ?? "");
}

function conditionMatches(condition: PluginResourceCondition, form: Record<string, unknown>) {
  const actual = valueAtPath(form, condition.field);
  const expected = condition.value;
  switch (condition.operator || "eq") {
    case "neq": return !valuesEqual(actual, expected);
    case "in": return Array.isArray(expected) && expected.some((item) => valuesEqual(actual, item));
    case "not-in": return !Array.isArray(expected) || !expected.some((item) => valuesEqual(actual, item));
    case "truthy": return !!actual;
    case "falsy": return !actual;
    default: return valuesEqual(actual, expected);
  }
}

function conditionsMatch(conditions: PluginResourceCondition[] | undefined, form: Record<string, unknown>) {
  return !conditions?.length || conditions.every((condition) => conditionMatches(condition, form));
}

function fieldDefault(field: PluginResourceFieldDefinition) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "multi-select") return [];
  return "";
}

function buildForm(fields: PluginResourceFieldDefinition[], value?: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const form: Record<string, unknown> = {};
  for (const field of fields) {
    const incoming = valueAtPath(source, field.key);
    form[field.key] = incoming === undefined ? fieldDefault(field) : incoming;
  }
  return form;
}

function taskStatusLabel(status?: string) {
  if (status === "success") return "成功";
  if (status === "effective") return "已生效";
  if (status === "error") return "失败";
  if (status === "timeout") return "超时";
  if (status === "running") return "执行中";
  if (status === "offline") return "离线";
  if (status === "queued") return "等待中";
  return "未检测";
}

function taskStatusClass(status?: string) {
  if (status === "success" || status === "effective") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "error" || status === "timeout" || status === "offline") return "border-destructive/25 bg-destructive/10 text-destructive";
  if (status === "running") return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "queued") return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

function valueStatus(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "ok", "online", "active", "running", "success", "applied", "effective", "enabled"].includes(normalized)) return "effective";
  if (["false", "error", "offline", "inactive", "failed", "timeout", "disabled"].includes(normalized)) return "error";
  return "idle";
}

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "-";
    }
  }
  return String(value);
}

export function AgentResourceManager({
  plugin,
  view,
  usage,
  hosts,
}: {
  plugin: any;
  view: PluginResourceViewDefinition;
  usage: any;
  hosts: any[];
}) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const loadingKeysRef = useRef(new Set<string>());
  const snapshotsRef = useRef<Record<string, SourceSnapshot>>({});
  const [selectedHostId, setSelectedHostId] = useState(0);
  const [snapshots, setSnapshots] = useState<Record<string, SourceSnapshot>>({});
  const [busySources, setBusySources] = useState<string[]>([]);
  const [activeTasks, setActiveTasks] = useState<TaskMeta[]>([]);
  const [selectedRow, setSelectedRow] = useState<any | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [revealedValues, setRevealedValues] = useState<string[]>([]);

  const selectedHostIds = useMemo(() => new Set((usage?.enabled ? usage?.hostIds : []).map(Number)), [usage?.enabled, usage?.hostIds]);
  const resourceHosts = useMemo(
    () => hosts.filter((host) => selectedHostIds.has(Number(host.id))),
    [hosts, selectedHostIds],
  );
  const selectedHost = resourceHosts.find((host) => Number(host.id) === selectedHostId) || null;
  const canRevealSecrets = (plugin?.permissions || plugin?.manifest?.permissions || []).includes("secret:reveal");
  const resourceStatesQuery = trpc.plugins.agentResourceStates.useQuery(
    { pluginId: plugin?.pluginId || "", resourceViewId: view.id },
    {
      enabled: !!plugin?.pluginId && !!view.id,
      refetchInterval: activeTasks.length > 0 ? 1000 : 10000,
      refetchOnWindowFocus: false,
    },
  );
  const selectedState = ((resourceStatesQuery.data || []) as any[]).find((state) => Number(state.hostId) === selectedHostId);
  const reportedPluginVersion = String(
    valueAtPath(selectedState?.data, "pluginVersion")
      ?? valueAtPath(selectedState?.data, "items.0.pluginVersion")
      ?? "",
  ).trim();
  const pluginVersionMismatch = !!reportedPluginVersion && reportedPluginVersion !== String(plugin.version || "");
  const stateFailure = selectedState?.status === "error" || selectedState?.status === "timeout";

  const runActionMutation = trpc.plugins.runAction.useMutation();
  const runActionRef = useRef(runActionMutation.mutateAsync);
  const utilsRef = useRef(utils);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    runActionRef.current = runActionMutation.mutateAsync;
    utilsRef.current = utils;
  }, [runActionMutation.mutateAsync, utils]);

  useEffect(() => {
    if (resourceHosts.some((host) => Number(host.id) === selectedHostId)) return;
    const firstOnline = resourceHosts.find((host) => host.isOnline && host.agentPluginSupported && !host.pluginSyncPending);
    setSelectedHostId(Number(firstOnline?.id || resourceHosts[0]?.id || 0));
  }, [resourceHosts, selectedHostId]);

  const sourceCacheKey = useCallback((hostId: number, sourceId: string) => (
    `${plugin?.pluginId || "plugin"}:${view.id}:${hostId}:${sourceId}`
  ), [plugin?.pluginId, view.id]);

  const pollTask = useCallback(async (groupId: string, hostId: number, generation: number) => {
    const startedAt = Date.now();
    while (mountedRef.current && generation === generationRef.current && Date.now() - startedAt < 90_000) {
      const group = await utilsRef.current.plugins.agentActionStatus.fetch({ pluginId: plugin.pluginId, groupId });
      if (!group) throw new Error("插件任务状态已失效");
      if ((group as any).done) {
        const row = ((group as any).results || []).find((item: any) => Number(item.hostId) === hostId);
        if (!row) throw new Error("Agent 未返回该主机的任务结果");
        if (row.status !== "success") throw new Error(row.error || row.stderr || row.output || taskStatusLabel(row.status));
        return row.data;
      }
      await sleep(650);
    }
    throw new Error("等待 Agent 返回插件任务结果超时");
  }, [plugin.pluginId]);

  const executeAction = useCallback(async (
    actionId: string,
    input: Record<string, unknown>,
    meta: TaskMeta,
    hostId = selectedHostId,
    generation = generationRef.current,
  ) => {
    if (!hostId) throw new Error("请先选择 Agent");
    setActiveTasks((current) => [...current, meta]);
    try {
      const response: any = await runActionRef.current({
        pluginId: plugin.pluginId,
        actionId,
        input,
        hostIds: [hostId],
        resourceViewId: view.id,
      });
      const groupId = String(response?.result?.groupId || "");
      if (!groupId) throw new Error(response?.message || "插件操作没有返回任务编号");
      return await pollTask(groupId, hostId, generation);
    } finally {
      if (mountedRef.current) {
        setActiveTasks((current) => {
          const index = current.findIndex((item) => item === meta);
          return index < 0 ? current : current.filter((_item, itemIndex) => itemIndex !== index);
        });
        void utilsRef.current.plugins.agentResourceStates.invalidate({ pluginId: plugin.pluginId, resourceViewId: view.id });
      }
    }
  }, [plugin.pluginId, pollTask, selectedHostId, view.id]);

  const loadSource = useCallback(async (
    source: PluginResourceDataSourceDefinition,
    options: { force?: boolean; selection?: any; generation?: number } = {},
  ) => {
    const hostId = selectedHostId;
    if (!hostId) return undefined;
    const generation = options.generation ?? generationRef.current;
    const key = sourceCacheKey(hostId, source.id);
    const current = snapshotsRef.current[key];
    if (!options.force && current && source.cacheTtlMs && Date.now() - current.loadedAt < source.cacheTtlMs) return current.data;
    if (loadingKeysRef.current.has(key)) return current?.data;
    loadingKeysRef.current.add(key);
    setBusySources((items) => items.includes(source.id) ? items : [...items, source.id]);
    try {
      const selectionValue = options.selection
        ? valueAtPath(options.selection, source.selectionValuePath || view.rowKey || "id")
        : undefined;
      const input: Record<string, unknown> = {};
      if (source.selectionInputKey && selectionValue !== undefined) input[source.selectionInputKey] = selectionValue;
      input.resourceId = selectionValue ?? "";
      input.payload = { ...input };
      const raw = await executeAction(source.actionId, input, { actionId: source.actionId, sourceId: source.id }, hostId, generation);
      const data = valueAtPath(raw, source.resultPath);
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshots((items) => ({ ...items, [key]: { data, loadedAt: Date.now() } }));
      }
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshots((items) => ({ ...items, [key]: { loadedAt: Date.now(), error: message } }));
      }
      throw error;
    } finally {
      loadingKeysRef.current.delete(key);
      if (mountedRef.current) setBusySources((items) => items.filter((id) => id !== source.id));
    }
  }, [executeAction, selectedHostId, sourceCacheKey, view.rowKey]);

  const refreshSources = useCallback(async (sourceIds?: string[]) => {
    const wanted = sourceIds?.length ? new Set(sourceIds) : null;
    const sources = view.sources.filter((source) => !wanted || wanted.has(source.id));
    const results = await Promise.allSettled(sources.map((source) => loadSource(source, { force: true })));
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) toast.error(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason));
  }, [loadSource, view.sources]);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setSelectedRow(null);
    setRevealedValues([]);
    if (!selectedHostId || !selectedHost?.isOnline || !selectedHost?.agentPluginSupported || selectedHost?.pluginSyncPending) return;
    const automaticSources = view.sources.filter((source) => (
      source.triggers?.includes("onOpen") || source.triggers?.includes("onHostSelected")
    ));
    void Promise.allSettled(automaticSources.map((source) => loadSource(source, { force: true, generation }))).then((results) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) toast.error(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
    });
  }, [loadSource, selectedHost?.agentPluginSupported, selectedHost?.isOnline, selectedHost?.pluginSyncPending, selectedHostId, view.sources]);

  const listSource = view.sources.find((source) => source.id === view.listSourceId);
  const listSnapshot = listSource ? snapshots[sourceCacheKey(selectedHostId, listSource.id)] : undefined;
  const listValue = valueAtPath(listSnapshot?.data, listSource?.itemsPath);
  const rows = Array.isArray(listValue) ? listValue : Array.isArray(listSnapshot?.data) ? listSnapshot?.data : [];
  const listLoading = !!listSource && busySources.includes(listSource.id);
  const transportBlockedReason = !selectedHost
    ? "请先选择 Agent"
    : !selectedHost.isOnline
      ? "Agent 当前离线"
      : !selectedHost.agentPluginSupported
        ? "Agent 版本不支持动态插件任务"
        : selectedHost.pluginSyncPending
          ? "插件资源正在同步到 Agent"
          : plugin.status !== "enabled"
            ? "插件未启用"
            : "";
  const blockedReason = transportBlockedReason || (pluginVersionMismatch
    ? `Agent 插件版本 ${reportedPluginVersion} 与面板版本 ${plugin.version} 不一致，请等待同步或升级`
    : stateFailure
      ? "最近一次 Agent 插件操作失败，请先刷新状态"
      : "");
  const refreshDisabled = !!transportBlockedReason || activeTasks.length > 0;
  const actionsDisabled = !!blockedReason || activeTasks.length > 0;

  const conditionContext = useMemo(() => {
    const sourceValues: Record<string, unknown> = {};
    for (const source of view.sources) {
      sourceValues[source.id] = snapshots[sourceCacheKey(selectedHostId, source.id)]?.data;
    }
    return { ...form, source: sourceValues };
  }, [form, selectedHostId, snapshots, sourceCacheKey, view.sources]);

  const dynamicOptions = useCallback((field: PluginResourceFieldDefinition) => {
    const source = field.optionsSource;
    if (!source) return field.options || [];
    const snapshot = snapshots[sourceCacheKey(selectedHostId, source.sourceId)];
    const value = valueAtPath(snapshot?.data, source.path);
    if (!Array.isArray(value)) return field.options || [];
    return value.flatMap((item: any) => {
      if (item === null || item === undefined) return [];
      if (typeof item !== "object") return [{ value: String(item), label: String(item), disabled: false }];
      const optionValue = valueAtPath(item, source.valueKey || "value");
      if (optionValue === undefined || optionValue === null || optionValue === "") return [];
      return [{
        value: String(optionValue),
        label: String(valueAtPath(item, source.labelKey || "label") ?? optionValue),
        disabled: source.disabledKey ? !!valueAtPath(item, source.disabledKey) : false,
      }];
    });
  }, [selectedHostId, snapshots, sourceCacheKey]);

  const openCreate = () => {
    setSelectedRow(null);
    setFormMode("create");
    setForm(buildForm(view.fields || []));
    setFormOpen(true);
  };

  const openEdit = async (row: any) => {
    setSelectedRow(row);
    setFormMode("edit");
    let detail = row;
    const detailSource = view.sources.find((source) => source.id === view.detailSourceId);
    if (detailSource) {
      try {
        const loaded = await loadSource(detailSource, { force: true, selection: row });
        if (loaded && typeof loaded === "object") detail = { ...row, ...(loaded as Record<string, unknown>) };
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setForm(buildForm(view.fields || [], detail));
    setFormOpen(true);
  };

  const validateForm = () => {
    for (const field of view.fields || []) {
      if (!conditionsMatch(field.visibleWhen, conditionContext) || !field.required) continue;
      const value = form[field.key];
      const empty = Array.isArray(value) ? value.length === 0 : String(value ?? "").trim() === "";
      if (empty) {
        toast.error(`请填写${field.label}`);
        return false;
      }
    }
    return true;
  };

  const operationInput = (row?: any) => {
    const resourceId = row ? valueAtPath(row, view.rowKey || "id") : valueAtPath(form, view.rowKey || "id");
    const idInputKey = view.idInputKey || view.rowKey || "id";
    return {
      ...form,
      [idInputKey]: resourceId ?? "",
      [view.rowKey || "id"]: resourceId ?? "",
      resourceId: resourceId ?? "",
      payload: form,
      selected: row || selectedRow || {},
    };
  };

  const runOperation = async (operation: PluginResourceOperationDefinition, row?: any) => {
    if (operation.confirmRequired) {
      const accepted = await confirm({
        title: operation.label || "确认操作",
        description: operation.description || "确定执行这个插件操作吗？",
        confirmText: "执行",
      });
      if (!accepted) return false;
    }
    setSaving(true);
    try {
      await executeAction(operation.actionId, operationInput(row), { actionId: operation.actionId });
      toast.success(`${operation.label || "操作"}成功`);
      const refreshAfter = operation.refreshAfter?.length ? operation.refreshAfter : operation.refreshSources;
      await refreshSources(refreshAfter?.length ? refreshAfter : [view.listSourceId]);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveForm = async () => {
    if (!validateForm()) return;
    const operation = formMode === "create" ? view.operations?.create : view.operations?.update;
    if (!operation) return;
    if (await runOperation(operation, selectedRow)) setFormOpen(false);
  };

  const deleteRow = async (row: any) => {
    const operation = view.operations?.delete;
    if (!operation) return;
    const accepted = await confirm({
      title: operation.label || "删除资源",
      description: operation.description || `确定删除 ${rowIdentity(row, view) || "当前资源"} 吗？`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (!accepted) return;
    await runOperation({ ...operation, confirmRequired: false }, row);
  };

  const copyValue = async (value: unknown) => {
    await navigator.clipboard.writeText(displayValue(value));
    toast.success("已复制");
  };

  const renderField = (field: PluginResourceFieldDefinition) => {
    if (!conditionsMatch(field.visibleWhen, conditionContext)) return null;
    const disabled = saving || field.readOnly || conditionsMatch(field.disabledWhen, conditionContext) && !!field.disabledWhen?.length;
    const value = form[field.key];
    const setValue = (next: unknown) => setForm((current) => ({ ...current, [field.key]: next }));
    const options = dynamicOptions(field);
    const wide = field.type === "textarea" || field.type === "multi-select" || field.type === "boolean";
    return (
      <div key={field.key} className={cn("space-y-2", wide && "sm:col-span-2")}>
        {field.type !== "boolean" && <Label>{field.label}{field.required ? " *" : ""}</Label>}
        {field.type === "textarea" ? (
          <Textarea value={String(value ?? "")} disabled={disabled} placeholder={field.placeholder} className="min-h-24" onChange={(event) => setValue(event.target.value)} />
        ) : field.type === "boolean" ? (
          <div className="flex min-h-10 items-center justify-between gap-4 rounded-md border border-border/50 px-3 py-2">
            <div>
              <Label>{field.label}</Label>
              {field.description && <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>}
            </div>
            <Switch checked={value === true} disabled={disabled} onCheckedChange={setValue} />
          </div>
        ) : field.type === "select" ? (
          <Select value={String(value ?? "")} disabled={disabled} onValueChange={setValue}>
            <SelectTrigger><SelectValue placeholder={field.placeholder || "请选择"} /></SelectTrigger>
            <SelectContent>
              {options.map((option: any) => <SelectItem key={option.value} value={String(option.value)} disabled={option.disabled}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : field.type === "multi-select" ? (
          <div className="grid max-h-52 gap-2 overflow-auto rounded-md border border-border/50 p-2 sm:grid-cols-2">
            {options.map((option: any) => {
              const selected = Array.isArray(value) && value.map(String).includes(String(option.value));
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled || option.disabled}
                  className={cn("flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm", selected ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40")}
                  onClick={() => setValue(selected ? (value as unknown[]).filter((item) => String(item) !== String(option.value)) : [...(Array.isArray(value) ? value : []), option.value])}
                >
                  <span className="truncate">{option.label}</span>
                  {selected && <Check className="h-4 w-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        ) : (
          <Input
            type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
            value={String(value ?? "")}
            disabled={disabled}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            onChange={(event) => setValue(field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
          />
        )}
        {field.type !== "boolean" && field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-border/40 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <Label>管理节点</Label>
          </div>
          <Select value={selectedHostId ? String(selectedHostId) : ""} onValueChange={(value) => setSelectedHostId(Number(value))}>
            <SelectTrigger className="w-full lg:max-w-md"><SelectValue placeholder="选择 Agent" /></SelectTrigger>
            <SelectContent>
              {resourceHosts.map((host) => (
                <SelectItem key={host.id} value={String(host.id)}>
                  {host.name || `主机 ${host.id}`} · {host.isOnline ? "在线" : "离线"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={taskStatusClass(selectedHost?.isOnline ? selectedState?.status : "offline")}>
            {selectedHost?.isOnline ? taskStatusLabel(selectedState?.status) : "离线"}
          </Badge>
          <Button type="button" variant="outline" size="sm" title="刷新" disabled={refreshDisabled} onClick={() => refreshSources()}>
            {activeTasks.length || busySources.length ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          {view.operations?.create && (
            <Button type="button" size="sm" className="gap-2" disabled={actionsDisabled} onClick={openCreate}>
              <Plus className="h-4 w-4" />{view.operations.create.label || "新增"}
            </Button>
          )}
        </div>
      </div>

      {blockedReason && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{blockedReason}</span>
        </div>
      )}

      {selectedState?.error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{selectedState.error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border/50">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              {(view.columns || []).map((column) => <TableHead key={column.key} style={{ width: column.width }}>{column.label}</TableHead>)}
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: any, rowIndex: number) => {
              const identity = rowIdentity(row, view) || String(rowIndex);
              return (
                <TableRow key={identity}>
                  {(view.columns || []).map((column) => {
                    const value = valueAtPath(row, column.path || column.key);
                    const revealKey = `${selectedHostId}:${identity}:${column.key}`;
                    const revealed = revealedValues.includes(revealKey);
                    return (
                      <TableCell key={column.key} className="max-w-72">
                        {column.type === "boolean" ? (
                          <Switch checked={value === true} disabled aria-label={column.label} />
                        ) : column.type === "status" ? (
                          <Badge variant="outline" className={taskStatusClass(valueStatus(value))}>
                            {typeof value === "boolean" ? (value ? column.trueLabel || "是" : column.falseLabel || "否") : displayValue(value)}
                          </Badge>
                        ) : column.secret || column.type === "secret" ? (
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-xs">{revealed ? displayValue(value) : "••••••••"}</span>
                            {canRevealSecrets && (
                              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title={revealed ? "隐藏" : "显示"} onClick={() => setRevealedValues((items) => revealed ? items.filter((item) => item !== revealKey) : [...items, revealKey])}>
                                {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                            {revealed && column.copyable && <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" title="复制" onClick={() => copyValue(value)}><Clipboard className="h-3.5 w-3.5" /></Button>}
                          </div>
                        ) : (
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className={cn("truncate", column.type === "code" && "font-mono text-xs")} title={displayValue(value)}>{displayValue(value)}</span>
                            {column.copyable && <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" title="复制" onClick={() => copyValue(value)}><Clipboard className="h-3.5 w-3.5" /></Button>}
                          </div>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {view.operations?.update && <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" title="编辑" disabled={actionsDisabled} onClick={() => openEdit(row)}><Pencil className="h-4 w-4" /></Button>}
                      {(view.operations?.execute || []).map((operation) => (
                        <Button key={operation.actionId} type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" title={operation.description || operation.label} disabled={actionsDisabled} onClick={() => runOperation(operation, row)}>{operation.label || "执行"}</Button>
                      ))}
                      {view.operations?.delete && <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" title="删除" disabled={actionsDisabled} onClick={() => deleteRow(row)}><Trash2 className="h-4 w-4" /></Button>}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={(view.columns || []).length + 1} className="h-28 text-center text-muted-foreground">
                  {listLoading ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />正在读取 Agent 数据</span> : listSnapshot?.error || view.emptyText || "暂无数据"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => { if (!saving) setFormOpen(open); }}>
        <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-border/40 px-5 py-4 pr-12 text-left">
            <DialogTitle>{formMode === "create" ? (view.operations?.create?.label || "新增") : (view.operations?.update?.label || "编辑")}</DialogTitle>
            <DialogDescription>{view.description || `管理 ${view.title}`}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4 sm:grid-cols-2">
            {(view.fields || []).map(renderField)}
          </div>
          <DialogFooter className="border-t border-border/40 px-5 py-3">
            <Button type="button" variant="outline" disabled={saving} onClick={() => setFormOpen(false)}><X className="mr-2 h-4 w-4" />取消</Button>
            <Button type="button" disabled={saving} onClick={saveForm}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

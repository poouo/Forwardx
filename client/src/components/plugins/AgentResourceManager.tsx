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
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  failedResourceSnapshot,
  optimisticResourceData,
  pluginTaskFailureInfo,
  type ResourceOperationKind,
  type ResourceSourceSnapshot,
} from "./agentResourceState";

type TaskMeta = {
  key: string;
  actionId: string;
  sourceId?: string;
  kind: ResourceOperationKind;
  label?: string;
};

type TaskPhase = "queueing" | "waiting-agent" | "running" | "applying" | "refreshing" | "success" | "error" | "timeout";

type TaskState = TaskMeta & {
  hostId: number;
  phase: TaskPhase;
  status: "queued" | "running" | "success" | "error" | "timeout";
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  queueDurationMs?: number;
  agentDurationMs?: number;
  endToEndDurationMs?: number;
  error?: string;
  advice?: string;
  detail?: string;
  processError?: string;
};

class PluginActionError extends Error {
  readonly info: ReturnType<typeof pluginTaskFailureInfo>;
  readonly status: "error" | "timeout";
  readonly row: any;

  constructor(row: any) {
    const info = pluginTaskFailureInfo(row);
    super(info.message);
    this.name = "PluginActionError";
    this.info = info;
    this.status = row?.status === "timeout" ? "timeout" : "error";
    this.row = row;
  }
}

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
  if (status === "syncing") return "同步中";
  if (status === "unsupported") return "版本不支持";
  return "待读取";
}

function taskStatusClass(status?: string) {
  if (status === "success" || status === "effective") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "error" || status === "timeout" || status === "offline") return "border-destructive/25 bg-destructive/10 text-destructive";
  if (status === "running") return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "queued" || status === "syncing") return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

function taskPhaseLabel(phase?: TaskPhase) {
  if (phase === "queueing") return "排队中";
  if (phase === "waiting-agent") return "等待 Agent";
  if (phase === "running") return "执行中";
  if (phase === "applying") return "应用中";
  if (phase === "refreshing") return "刷新中";
  if (phase === "success") return "成功";
  if (phase === "timeout") return "超时";
  if (phase === "error") return "失败";
  return "";
}

function durationLabel(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function taskTimingLabel(task?: TaskState) {
  if (!task) return "";
  return [
    task.queueDurationMs !== undefined ? `排队 ${durationLabel(task.queueDurationMs)}` : "",
    task.agentDurationMs !== undefined ? `Agent ${durationLabel(task.agentDurationMs)}` : "",
    task.endToEndDurationMs !== undefined ? `总计 ${durationLabel(task.endToEndDurationMs)}` : "",
  ].filter(Boolean).join(" · ");
}

function notifyTaskError(error: unknown) {
  if (error instanceof PluginActionError) {
    const description = [
      error.info.advice ? `处理建议: ${error.info.advice}` : "",
      error.info.detail,
    ].filter(Boolean).join(" · ");
    toast.error(error.info.message, description ? { description } : undefined);
    return;
  }
  toast.error(error instanceof Error ? error.message : String(error));
}

function resourceHostStatus(host: any | null | undefined, state: any | null | undefined) {
  if (!host) return "idle";
  if (!host?.isOnline) return "offline";
  if (!host?.agentPluginSupported) return "unsupported";
  if (host?.pluginSyncPending) return "syncing";
  return String(state?.status || "idle");
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
  const snapshotsRef = useRef<Record<string, ResourceSourceSnapshot>>({});
  const [selectedHostId, setSelectedHostId] = useState(0);
  const [snapshots, setSnapshots] = useState<Record<string, ResourceSourceSnapshot>>({});
  const [busySources, setBusySources] = useState<string[]>([]);
  const [taskStates, setTaskStates] = useState<Record<string, TaskState>>({});
  const [selectedRow, setSelectedRow] = useState<any | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [revealedValues, setRevealedValues] = useState<string[]>([]);
  const [hostSearchQuery, setHostSearchQuery] = useState("");

  const selectedHostIds = useMemo(() => new Set((usage?.enabled ? usage?.hostIds : []).map(Number)), [usage?.enabled, usage?.hostIds]);
  const resourceHosts = useMemo(
    () => hosts.filter((host) => selectedHostIds.has(Number(host.id))),
    [hosts, selectedHostIds],
  );
  const selectedHost = resourceHosts.find((host) => Number(host.id) === selectedHostId) || null;
  const activeTasks = useMemo(
    () => Object.values(taskStates).filter((task) => task.status === "queued" || task.status === "running"),
    [taskStates],
  );
  const canRevealSecrets = (plugin?.permissions || plugin?.manifest?.permissions || []).includes("secret:reveal");
  const resourceStatesQuery = trpc.plugins.agentResourceStates.useQuery(
    { pluginId: plugin?.pluginId || "", resourceViewId: view.id },
    {
      enabled: !!plugin?.pluginId && !!view.id,
      refetchInterval: activeTasks.length > 0 ? 1000 : 10000,
      refetchOnWindowFocus: false,
    },
  );
  const resourceStates = (resourceStatesQuery.data || []) as any[];
  const resourceStateByHostId = useMemo(
    () => new Map(resourceStates.map((state) => [Number(state.hostId), state])),
    [resourceStates],
  );
  const selectedState = resourceStateByHostId.get(selectedHostId);
  const filteredResourceHosts = useMemo(() => {
    const query = hostSearchQuery.trim().toLowerCase();
    if (!query) return resourceHosts;
    return resourceHosts.filter((host) => [
      host.name,
      host.ip,
      host.ipv4,
      host.ipv6,
      host.hostname,
      host.remark,
    ].some((value) => String(value || "").toLowerCase().includes(query)));
  }, [hostSearchQuery, resourceHosts]);
  const reportedPluginVersion = String(
    valueAtPath(selectedState?.data, "pluginVersion")
      ?? valueAtPath(selectedState?.data, "items.0.pluginVersion")
      ?? "",
  ).trim();
  const pluginVersionMismatch = !!reportedPluginVersion && reportedPluginVersion !== String(plugin.version || "");
  const latestTaskState = useMemo(() => {
    const hostTasks = Object.values(taskStates)
      .filter((task) => task.hostId === selectedHostId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return hostTasks.find((task) => task.phase === "refreshing") || hostTasks[0];
  }, [selectedHostId, taskStates]);

  const runActionMutation = trpc.plugins.runAction.useMutation();
  const runActionRef = useRef(runActionMutation.mutateAsync);
  const utilsRef = useRef(utils);

  const patchTaskState = useCallback((key: string, patch: Partial<TaskState>) => {
    if (!mountedRef.current) return;
    setTaskStates((current) => {
      const existing = current[key];
      if (!existing) return current;
      return { ...current, [key]: { ...existing, ...patch, updatedAt: Date.now() } };
    });
  }, []);

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

  const pollTask = useCallback(async (
    groupId: string,
    hostId: number,
    generation: number,
    onProgress: (row: any) => void,
  ) => {
    const startedAt = Date.now();
    while (mountedRef.current && generation === generationRef.current && Date.now() - startedAt < 120_000) {
      const group = await utilsRef.current.client.plugins.agentActionStatus.query({
        pluginId: plugin.pluginId,
        groupId,
      });
      if (!group) throw new Error("插件任务状态已失效");
      const row = ((group as any).results || []).find((item: any) => Number(item.hostId) === hostId);
      if (row) {
        onProgress(row);
        if (row.status === "success") return row;
        if (row.status === "error" || row.status === "timeout") throw new PluginActionError(row);
      }
      await sleep(400);
    }
    if (!mountedRef.current || generation !== generationRef.current) throw new Error("插件任务已取消");
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
    const localStartedAt = Date.now();
    setTaskStates((current) => ({
      ...current,
      [meta.key]: {
        ...meta,
        hostId,
        phase: "queueing",
        status: "queued",
        startedAt: localStartedAt,
        updatedAt: localStartedAt,
      },
    }));
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
      patchTaskState(meta.key, { phase: "waiting-agent", status: "queued" });
      return await pollTask(groupId, hostId, generation, (row) => {
        const status = row.status === "success" ? "success" : row.status === "timeout" ? "timeout" : row.status === "error" ? "error" : row.status === "running" ? "running" : "queued";
        const phase: TaskPhase = status === "success"
          ? "success"
          : status === "timeout"
            ? "timeout"
            : status === "error"
              ? "error"
              : status === "running"
                ? (meta.kind === "read" || meta.kind === "execute" ? "running" : "applying")
                : "waiting-agent";
        patchTaskState(meta.key, {
          phase,
          status,
          finishedAt: status === "success" || status === "error" || status === "timeout" ? Date.now() : undefined,
          queueDurationMs: Number.isFinite(Number(row.queueDurationMs)) ? Number(row.queueDurationMs) : undefined,
          agentDurationMs: Number.isFinite(Number(row.agentDurationMs ?? row.durationMs)) ? Number(row.agentDurationMs ?? row.durationMs) : undefined,
          endToEndDurationMs: Number.isFinite(Number(row.endToEndDurationMs)) ? Number(row.endToEndDurationMs) : undefined,
        });
      });
    } catch (error) {
      const failure = error instanceof PluginActionError ? error.info : null;
      const status = error instanceof PluginActionError
        ? error.status
        : error instanceof Error && error.message.includes("超时")
          ? "timeout"
          : "error";
      patchTaskState(meta.key, {
        phase: status,
        status,
        finishedAt: Date.now(),
        endToEndDurationMs: error instanceof PluginActionError && Number.isFinite(Number(error.row?.endToEndDurationMs))
          ? Number(error.row.endToEndDurationMs)
          : Date.now() - localStartedAt,
        error: failure?.message || (error instanceof Error ? error.message : String(error)),
        advice: failure?.advice,
        detail: failure?.detail,
        processError: failure?.processError,
      });
      throw error;
    } finally {
      if (mountedRef.current) {
        void utilsRef.current.plugins.agentResourceStates.invalidate({ pluginId: plugin.pluginId, resourceViewId: view.id });
      }
    }
  }, [patchTaskState, plugin.pluginId, pollTask, selectedHostId, view.id]);

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
    setBusySources((items) => items.includes(key) ? items : [...items, key]);
    try {
      const selectionValue = options.selection
        ? valueAtPath(options.selection, source.selectionValuePath || view.rowKey || "id")
        : undefined;
      const input: Record<string, unknown> = {};
      if (source.selectionInputKey && selectionValue !== undefined) input[source.selectionInputKey] = selectionValue;
      input.resourceId = selectionValue ?? "";
      input.payload = { ...input };
      const taskResult = await executeAction(source.actionId, input, {
        key: `${hostId}:source:${source.id}`,
        actionId: source.actionId,
        sourceId: source.id,
        kind: "read",
        label: source.id,
      }, hostId, generation);
      const data = valueAtPath(taskResult?.data, source.resultPath);
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshots((items) => ({ ...items, [key]: { data, loadedAt: Date.now() } }));
      }
      return data;
    } catch (error) {
      const failure = error instanceof PluginActionError ? error.info : null;
      const message = failure?.message || (error instanceof Error ? error.message : String(error));
      if (mountedRef.current && generation === generationRef.current) {
        setSnapshots((items) => ({
          ...items,
          [key]: failedResourceSnapshot(items[key], {
            message,
            advice: failure?.advice || "",
            detail: failure?.detail || "",
          }),
        }));
      }
      throw error;
    } finally {
      loadingKeysRef.current.delete(key);
      if (mountedRef.current) setBusySources((items) => items.filter((item) => item !== key));
    }
  }, [executeAction, selectedHostId, sourceCacheKey, view.rowKey]);

  const refreshSources = useCallback(async (sourceIds?: string[]) => {
    const wanted = sourceIds?.length ? new Set(sourceIds) : null;
    const sources = view.sources.filter((source) => {
      if (wanted) return wanted.has(source.id) && (source.id !== view.detailSourceId || !!selectedRow);
      return source.id === view.listSourceId
        || source.triggers?.includes("onOpen")
        || source.triggers?.includes("onHostSelected");
    });
    const results = await Promise.allSettled(sources.map((source) => loadSource(source, {
      force: true,
      selection: source.id === view.detailSourceId ? selectedRow : undefined,
    })));
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) notifyTaskError(rejected.reason);
    return !rejected;
  }, [loadSource, selectedRow, view.detailSourceId, view.listSourceId, view.sources]);

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
      if (failed) notifyTaskError(failed.reason);
    });
  }, [loadSource, selectedHost?.agentPluginSupported, selectedHost?.isOnline, selectedHost?.pluginSyncPending, selectedHostId, view.sources]);

  const listSource = view.sources.find((source) => source.id === view.listSourceId);
  const listSnapshot = listSource ? snapshots[sourceCacheKey(selectedHostId, listSource.id)] : undefined;
  const listValue = valueAtPath(listSnapshot?.data, listSource?.itemsPath);
  const rows = Array.isArray(listValue) ? listValue : Array.isArray(listSnapshot?.data) ? listSnapshot?.data : [];
  const listLoading = !!listSource && busySources.includes(sourceCacheKey(selectedHostId, listSource.id));
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
    : "");
  const refreshDisabled = !!blockedReason || listLoading;
  const actionsDisabled = !!blockedReason;
  const listHasData = listSnapshot?.data !== undefined;
  const sourceWarnings = view.sources.flatMap((source) => {
    const snapshot = snapshots[sourceCacheKey(selectedHostId, source.id)];
    return snapshot?.error ? [{ source, snapshot }] : [];
  });

  const operationTaskMeta = useCallback((
    kind: Exclude<ResourceOperationKind, "read">,
    operation: PluginResourceOperationDefinition,
    row?: any,
  ): TaskMeta => {
    const resourceId = rowIdentity(row || selectedRow, view) || (kind === "create" ? "new" : "global");
    return {
      key: `${selectedHostId}:operation:${kind}:${operation.actionId}:${resourceId}`,
      actionId: operation.actionId,
      kind,
      label: operation.label,
    };
  }, [selectedHostId, selectedRow, view]);

  const operationBusy = useCallback((
    kind: Exclude<ResourceOperationKind, "read">,
    operation: PluginResourceOperationDefinition,
    row?: any,
  ) => {
    const state = taskStates[operationTaskMeta(kind, operation, row).key];
    return state?.status === "queued" || state?.status === "running";
  }, [operationTaskMeta, taskStates]);

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
        notifyTaskError(error);
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

  const runOperation = async (
    operation: PluginResourceOperationDefinition,
    row: any | undefined,
    kind: Exclude<ResourceOperationKind, "read">,
  ) => {
    if (operation.confirmRequired) {
      const accepted = await confirm({
        title: operation.label || "确认操作",
        description: operation.description || "确定执行这个插件操作吗？",
        confirmText: "执行",
      });
      if (!accepted) return false;
    }
    const meta = operationTaskMeta(kind, operation, row);
    const isFormOperation = kind === "create" || kind === "update";
    if (isFormOperation) setSaving(true);
    try {
      const taskResult = await executeAction(operation.actionId, operationInput(row), meta);
      if (kind === "create" || kind === "update" || kind === "delete") {
        const key = listSource ? sourceCacheKey(selectedHostId, listSource.id) : "";
        if (key) {
          setSnapshots((items) => {
            const snapshot = items[key];
            if (!snapshot) return items;
            return {
              ...items,
              [key]: {
                ...snapshot,
                data: optimisticResourceData({
                  data: snapshot.data,
                  itemsPath: listSource?.itemsPath,
                  rowKey: view.rowKey,
                  kind,
                  currentRow: row || selectedRow,
                  form,
                  resultData: taskResult?.data,
                }),
              },
            };
          });
        }
      }
      toast.success(`${operation.label || "操作"}成功`);
      const refreshAfter = operation.refreshAfter?.length ? operation.refreshAfter : operation.refreshSources;
      patchTaskState(meta.key, { phase: "refreshing", status: "success" });
      void refreshSources(refreshAfter?.length ? refreshAfter : [view.listSourceId]).then((refreshed) => {
        patchTaskState(meta.key, {
          phase: "success",
          status: "success",
          detail: refreshed ? undefined : "写入已成功，后台刷新失败，当前保留已有数据",
        });
      });
      return true;
    } catch (error) {
      notifyTaskError(error);
      return false;
    } finally {
      if (isFormOperation) setSaving(false);
    }
  };

  const saveForm = async () => {
    if (!validateForm()) return;
    const operation = formMode === "create" ? view.operations?.create : view.operations?.update;
    if (!operation) return;
    if (await runOperation(operation, selectedRow, formMode === "create" ? "create" : "update")) setFormOpen(false);
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
    await runOperation({ ...operation, confirmRequired: false }, row, "delete");
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
              const toggleOption = () => {
                const current = Array.isArray(value) ? value : [];
                if (selected) {
                  setValue(current.filter((item) => String(item) !== String(option.value)));
                  return;
                }
                if (option.exclusive) {
                  setValue([option.value]);
                  return;
                }
                const exclusiveValues = new Set(options.filter((item: any) => item.exclusive).map((item: any) => String(item.value)));
                setValue([...current.filter((item) => !exclusiveValues.has(String(item))), option.value]);
              };
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled || option.disabled}
                  className={cn("flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm", selected ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40")}
                  onClick={toggleOption}
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
      <div className="grid min-h-[30rem] overflow-hidden rounded-md border border-border/50 bg-background/45 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col border-r border-border/50 bg-muted/15 lg:flex">
          <div className="border-b border-border/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">主机</span>
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">{resourceHosts.length}</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={hostSearchQuery}
                onChange={(event) => setHostSearchQuery(event.target.value)}
                placeholder="搜索主机"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {filteredResourceHosts.map((host) => {
              const hostState = resourceStateByHostId.get(Number(host.id));
              const status = resourceHostStatus(host, hostState);
              const active = Number(host.id) === selectedHostId;
              return (
                <button
                  key={host.id}
                  type="button"
                  onClick={() => setSelectedHostId(Number(host.id))}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                    active ? "border-primary/35 bg-primary/10" : "border-transparent hover:border-border/50 hover:bg-muted/35",
                  )}
                >
                  <span className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    status === "success" || status === "effective" ? "bg-emerald-500" : status === "running" || status === "queued" || status === "syncing" ? "bg-amber-400" : status === "error" || status === "timeout" || status === "offline" ? "bg-destructive/75" : "bg-muted-foreground/35",
                  )} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{host.name || `主机 ${host.id}`}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{taskStatusLabel(status)}</span>
                  </span>
                </button>
              );
            })}
            {!filteredResourceHosts.length && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {resourceHosts.length ? "没有匹配的主机" : "尚未选择生效主机"}
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0">
          <div className="flex flex-col gap-3 border-b border-border/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="lg:hidden">
                <Label className="mb-2 block text-xs">管理节点</Label>
                <Select value={selectedHostId ? String(selectedHostId) : ""} onValueChange={(value) => setSelectedHostId(Number(value))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="选择 Agent" /></SelectTrigger>
                  <SelectContent>
                    {resourceHosts.map((host) => (
                      <SelectItem key={host.id} value={String(host.id)}>
                        {host.name || `主机 ${host.id}`} · {taskStatusLabel(resourceHostStatus(host, resourceStateByHostId.get(Number(host.id))))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="hidden min-w-0 lg:block">
                <p className="truncate text-sm font-semibold">{selectedHost?.name || "请选择主机"}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{view.title}</p>
              </div>
              {latestTaskState && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span className={cn(
                    latestTaskState.status === "error" || latestTaskState.status === "timeout" ? "text-destructive" : "",
                  )}>{taskPhaseLabel(latestTaskState.phase)}</span>
                  {taskTimingLabel(latestTaskState) && <span className="tabular-nums">{taskTimingLabel(latestTaskState)}</span>}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={taskStatusClass(resourceHostStatus(selectedHost, selectedState))}>
                {taskStatusLabel(resourceHostStatus(selectedHost, selectedState))}
              </Badge>
              <Button type="button" variant="outline" size="sm" title="刷新" disabled={refreshDisabled} onClick={() => refreshSources()}>
                {listLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
              {view.operations?.create && (
                <Button type="button" size="sm" className="gap-2" disabled={actionsDisabled || operationBusy("create", view.operations.create)} onClick={openCreate}>
                  <Plus className="h-4 w-4" />{view.operations.create.label || "新增"}
                </Button>
              )}
            </div>
          </div>

          {blockedReason && (
            <div className="m-3 flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{blockedReason}</span>
            </div>
          )}

          {sourceWarnings.length > 0 && (
            <div className="m-3 flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {listHasData ? "刷新失败，当前保留上次成功数据：" : "读取 Agent 数据失败："}
                {sourceWarnings[0].snapshot.error}
                {sourceWarnings.length > 1 ? `（另有 ${sourceWarnings.length - 1} 个数据源失败）` : ""}
                {sourceWarnings[0].snapshot.advice && <span className="mt-1 block text-xs">处理建议：{sourceWarnings[0].snapshot.advice}</span>}
                {sourceWarnings[0].snapshot.detail && <span className="mt-1 block text-xs opacity-80">{sourceWarnings[0].snapshot.detail}</span>}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2"
                disabled={!!blockedReason || busySources.includes(sourceCacheKey(selectedHostId, sourceWarnings[0].source.id))}
                onClick={() => refreshSources([sourceWarnings[0].source.id])}
              >
                {busySources.includes(sourceCacheKey(selectedHostId, sourceWarnings[0].source.id)) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span className="ml-1.5">重试</span>
              </Button>
            </div>
          )}

          {latestTaskState && latestTaskState.kind !== "read" && (latestTaskState.status === "error" || latestTaskState.status === "timeout") && (
            <div className="m-3 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">
                <span className="block">{latestTaskState.error || "插件操作执行失败"}</span>
                {latestTaskState.advice && <span className="mt-1 block text-xs">处理建议：{latestTaskState.advice}</span>}
                {latestTaskState.detail && <span className="mt-1 block text-xs opacity-80">{latestTaskState.detail}</span>}
              </span>
            </div>
          )}

          <div className="overflow-x-auto">
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
                      {view.operations?.update && <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" title="编辑" disabled={actionsDisabled || operationBusy("update", view.operations.update, row)} onClick={() => openEdit(row)}>{operationBusy("update", view.operations.update, row) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}</Button>}
                      {(view.operations?.execute || []).map((operation) => (
                        <Button key={operation.actionId} type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" title={operation.description || operation.label} disabled={actionsDisabled || operationBusy("execute", operation, row)} onClick={() => runOperation(operation, row, "execute")}>
                          {operationBusy("execute", operation, row) && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{operation.label || "执行"}
                        </Button>
                      ))}
                      {view.operations?.delete && <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" title="删除" disabled={actionsDisabled || operationBusy("delete", view.operations.delete, row)} onClick={() => deleteRow(row)}>{operationBusy("delete", view.operations.delete, row) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={(view.columns || []).length + 1} className="h-28 text-center text-muted-foreground">
                  {listLoading ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />正在读取 Agent 数据</span> : view.emptyText || "暂无数据"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
            </Table>
          </div>
        </section>
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

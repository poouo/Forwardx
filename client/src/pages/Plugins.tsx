import { useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { AgentResourceManager } from "@/components/plugins/AgentResourceManager";
import { PluginResultRenderer } from "@/components/plugins/PluginResultRenderer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { renderMixedHtml, textToHtml } from "@/lib/htmlContent";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  Github,
  Loader2,
  PackagePlus,
  Play,
  Puzzle,
  RefreshCw,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

type PluginRow = any;
type PluginSettingField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "password" | "number" | "boolean" | "select" | "url";
  description?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  options?: Array<{ label: string; value: string }>;
};

type PluginUsageDraft = {
  enabled: boolean;
  hostIds: number[];
  assetPaths: string[];
  operation: string;
  fieldValues: Record<string, unknown>;
  note: string;
};
type PluginUsageField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "boolean" | "select" | "multi-select";
  description?: string;
  placeholder?: string;
  defaultValue?: string | boolean | string[];
  options?: Array<{ label: string; value: string }>;
  required?: boolean;
};
type PluginSection = "usage" | "manage" | "store";

const pluginHostAssetSyncMaxBytes = 1024 * 1024;

const defaultPluginUsage: PluginUsageDraft = {
  enabled: false,
  hostIds: [],
  assetPaths: [],
  operation: "",
  fieldValues: {},
  note: "",
};

const PLUGIN_SECTIONS: SlidingTabItem<PluginSection>[] = [
  { value: "usage", label: "插件使用", icon: Puzzle },
  { value: "manage", label: "插件管理", icon: Boxes },
  { value: "store", label: "插件商店", icon: PackagePlus },
];

function pluginStatusLabel(status?: string) {
  if (status === "enabled") return "已启用";
  if (status === "error") return "异常";
  return "未启用";
}

function pluginStatusClass(status?: string) {
  const base = "shrink-0 whitespace-nowrap px-2 text-[11px] leading-none";
  if (status === "enabled") return `${base} border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`;
  if (status === "error") return `${base} border-destructive/25 bg-destructive/10 text-destructive`;
  return `${base} border-border/60 bg-muted/30 text-muted-foreground`;
}

function pluginSourceLabel(sourceType?: string) {
  if (sourceType === "upload") return "上传";
  if (sourceType === "local") return "本地";
  return "GitHub";
}

function formatBytes(bytes: number) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatTime(value?: string | Date | number | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function formatDateText(value?: string | Date | number | null) {
  if (!value) return "-";
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString();
}

function toggleNumberItem(values: number[], value: number) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function toggleStringItem(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function getPluginManifest(plugin?: PluginRow) {
  return plugin?.manifest || {};
}

function getPluginSettings(plugin?: PluginRow): Record<string, unknown> {
  const manifest = getPluginManifest(plugin);
  return manifest?.settingsValues && typeof manifest.settingsValues === "object" ? manifest.settingsValues : {};
}

function settingDefaultValue(field: PluginSettingField) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "number") return "";
  return "";
}

function normalizeSettingDraftValue(field: PluginSettingField, value: unknown) {
  if (field.type === "boolean") return value === true;
  if (field.type === "number") return value === undefined || value === null ? "" : String(value);
  return value === undefined || value === null ? "" : String(value);
}

function actionInputDefaultValue(field: PluginSettingField) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "select") return field.options?.[0]?.value || "";
  return "";
}

function buildActionInputDraft(action: any) {
  const fields = Array.isArray(action?.inputSchema) ? action.inputSchema as PluginSettingField[] : [];
  const draft: Record<string, unknown> = {};
  for (const field of fields) {
    draft[field.key] = normalizeSettingDraftValue(field, actionInputDefaultValue(field));
  }
  return draft;
}

function actionResultDisplayBody(result: any) {
  const payload = result?.result;
  if (!payload) return "";
  if (payload.body !== undefined) {
    try {
      return JSON.stringify(payload.body, null, 2);
    } catch {
      return String(payload.body);
    }
  }
  return String(payload.bodyText || "");
}

function actionResultTitle(result: any) {
  const payload = result?.result;
  if (payload?.type === "http.request") {
    return `${payload.method || "HTTP"} ${payload.status || "-"}${payload.durationMs !== undefined ? ` · ${payload.durationMs}ms` : ""}`;
  }
  if (payload?.type === "agent.request") {
    const body = payload?.body;
    return `Agent 操作 ${Number(body?.completed || 0)}/${Number(body?.total || 0)}`;
  }
  return result?.message || "动作结果";
}

function agentTaskStatusLabel(status?: string) {
  if (status === "success") return "成功";
  if (status === "partial") return "部分成功";
  if (status === "error") return "失败";
  if (status === "timeout") return "超时";
  if (status === "running") return "执行中";
  return "等待中";
}

function agentTaskStatusClass(status?: string) {
  if (status === "success") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "partial") return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "error" || status === "timeout") return "border-destructive/25 bg-destructive/10 text-destructive";
  if (status === "running") return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

function AgentActionResultPanel({
  result,
  onClear,
  resultSchema,
  canRevealSecrets,
}: {
  result: any;
  onClear: () => void;
  resultSchema?: any;
  canRevealSecrets: boolean;
}) {
  const body = result?.result?.body;
  if (!body) return null;
  const rows = Array.isArray(body.results) ? body.results : [];
  const message = String(body.error || body.message || "").trim();
  return (
    <div className="rounded-lg border border-border/40 bg-background/70 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-sm font-medium">{actionResultTitle(result)}</p>
          <Badge variant="outline" className={agentTaskStatusClass(body.status)}>{agentTaskStatusLabel(body.status)}</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onClear}>清除</Button>
      </div>
      {message && (
        <p className={cn("mb-3 text-xs", body.status === "error" || body.status === "timeout" ? "text-destructive" : "text-muted-foreground")}>{message}</p>
      )}
      <div className="space-y-2">
        {rows.map((row: any) => (
          <div key={row.taskId || row.hostId} className="rounded-md border border-border/40 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  row.status === "success" ? "bg-emerald-500" : row.status === "error" || row.status === "timeout" ? "bg-destructive" : row.status === "running" ? "bg-sky-500" : "bg-muted-foreground/40",
                )} />
                <p className="truncate text-sm font-medium">{row.hostName || `主机 ${row.hostId}`}</p>
              </div>
              <Badge variant="outline" className={agentTaskStatusClass(row.status)}>{agentTaskStatusLabel(row.status)}</Badge>
            </div>
            {row.data !== undefined && (
              <div className="mt-2">
                {resultSchema
                  ? <PluginResultRenderer data={row.data} schema={resultSchema} canRevealSecrets={canRevealSecrets} />
                  : <pre className="max-h-64 overflow-auto rounded-md bg-background/80 p-3 text-xs leading-5">{JSON.stringify(row.data, null, 2)}</pre>}
              </div>
            )}
            {!row.data && row.output && row.status !== "queued" && row.status !== "running" && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background/80 p-3 text-xs leading-5">{row.output}</pre>
            )}
            {(row.error || row.stderr) && (
              <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{row.error || row.stderr}</p>
            )}
            {(row.status === "queued" || row.status === "running") && (
              <p className="mt-2 text-xs text-muted-foreground">{row.output || "等待 Agent 返回结果..."}</p>
            )}
          </div>
        ))}
        {rows.length === 0 && !message && (
          <p className="text-xs text-muted-foreground">暂无主机返回结果。</p>
        )}
      </div>
    </div>
  );
}

function renderPluginPageHtml(content: string, type?: string) {
  if (type === "text") return { __html: textToHtml(content || "") };
  return { __html: renderMixedHtml(content || "") };
}

function buildStoreDetailMarkdown(item: any) {
  const explicit = String(item?.detailsMarkdown || item?.detailMarkdown || item?.longDescription || "").trim();
  if (explicit) return explicit;

  const lines: string[] = [];
  const description = String(item?.description || "").trim();
  if (description) lines.push(description);

  const features = Array.isArray(item?.features) ? item.features : [];
  if (features.length) {
    if (lines.length) lines.push("");
    for (const feature of features) {
      const title = String(feature?.title || "").trim();
      const detail = String(feature?.description || "").trim();
      if (!title && !detail) continue;
      lines.push(`- ${title ? `**${title}**` : "功能"}${detail ? `：${detail}` : ""}`);
    }
  }

  const changelog = String(item?.changelog || "").trim();
  if (changelog) {
    if (lines.length) lines.push("");
    lines.push(`更新说明：${changelog}`);
  }

  return lines.join("\n") || "这个插件暂未提供详细介绍。";
}

function PluginLogo({ logo, name, className }: { logo?: string; name?: string; className?: string }) {
  const label = String(name || "插件").trim() || "插件";
  if (logo) {
    return (
      <img
        src={logo}
        alt={label}
        className={cn("h-11 w-11 shrink-0 rounded-xl border border-border/40 bg-background object-cover", className)}
      />
    );
  }
  return (
    <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary", className)}>
      <Puzzle className="h-5 w-5" />
    </div>
  );
}

function PluginSettingInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PluginSettingField;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{field.label}</p>
          {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        </div>
        <Switch checked={value === true} onCheckedChange={onChange} disabled={disabled} />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="space-y-2">
        <Label>{field.label}</Label>
        <Select value={String(value || "")} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder || "请选择"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div className="space-y-2">
        <Label>{field.label}</Label>
        <Textarea
          value={String(value || "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          className="min-h-28 resize-y"
        />
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{field.label}</Label>
      <Input
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
        value={String(value || "")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        min={field.min}
        max={field.max}
        disabled={disabled}
      />
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}

function usageFieldDefaultValue(field: PluginUsageField) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "multi-select") return [];
  if (field.type === "select") return field.options?.[0]?.value || "";
  return "";
}

function normalizeUsageFieldDraftValue(field: PluginUsageField, value: unknown) {
  if (field.type === "boolean") return value === true;
  if (field.type === "multi-select") return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
  return value === undefined || value === null ? "" : String(value);
}

function PluginUsageFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PluginUsageField;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/60 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{field.label}</p>
          {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        </div>
        <Switch checked={value === true} onCheckedChange={onChange} disabled={disabled} />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="space-y-2">
        <Label>{field.label}</Label>
        <Select value={String(value || "")} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder || "请选择"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  if (field.type === "multi-select") {
    const selected = Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Label>{field.label}</Label>
            {field.description && <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>}
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">已选 {selected.length}</span>
        </div>
        <div className="grid max-h-56 gap-2 overflow-auto rounded-lg border border-border/40 bg-background/60 p-2 sm:grid-cols-2">
          {(field.options || []).map((option) => {
            const active = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange(toggleStringItem(selected, option.value))}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                  active ? "border-primary/40 bg-primary/5 text-primary" : "border-border/40 hover:bg-muted/50",
                )}
              >
                <span className="truncate">{option.label}</span>
                {active && <CheckCircle2 className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <div className="space-y-2">
        <Label>{field.label}</Label>
        <Textarea
          value={String(value || "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          className="min-h-28 resize-y"
        />
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{field.label}</Label>
      <Input
        value={String(value || "")}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
      />
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}

function chinaWhitelistSelectedCodes(value: unknown) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter((code) => code === "CN" || /^[0-9]{6}$/.test(code))));
}

function ChinaWhitelistRegionSelector({
  field,
  value,
  disabled,
  onChange,
}: {
  field: PluginUsageField;
  value: unknown;
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  const selected = chinaWhitelistSelectedCodes(value);
  const selectedProvinces = selected.filter((code) => code !== "CN");
  const hasNationalSelection = selected.includes("CN");
  const [provinceMode, setProvinceMode] = useState(selectedProvinces.length > 0);
  useEffect(() => {
    if (selectedProvinces.length > 0) {
      setProvinceMode(true);
    } else if (hasNationalSelection) {
      setProvinceMode(false);
    }
  }, [hasNationalSelection, selectedProvinces.length]);
  const provinces = (field.options || []).filter((option) => /^[0-9]{6}$/.test(option.value));

  return (
    <div className="space-y-3 rounded-lg border border-border/40 bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label>{field.label}</Label>
          {field.description && <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>}
        </div>
        <Badge variant="outline" className="shrink-0">
          {provinceMode ? `已选 ${selectedProvinces.length} 个省份` : "全国"}
        </Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setProvinceMode(false);
            onChange(["CN"]);
          }}
          className={cn(
            "flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
            !provinceMode ? "border-primary/45 bg-primary/10 text-primary" : "border-border/40 hover:bg-muted/50",
          )}
        >
          <span>
            <span className="block font-medium">全国</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">允许中国大陆 IPv4 地址</span>
          </span>
          {!provinceMode && <CheckCircle2 className="h-4 w-4 shrink-0" />}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setProvinceMode(true);
            onChange(selectedProvinces);
          }}
          className={cn(
            "flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
            provinceMode ? "border-primary/45 bg-primary/10 text-primary" : "border-border/40 hover:bg-muted/50",
          )}
        >
          <span>
            <span className="block font-medium">按省份</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">仅允许下方已选择的省份</span>
          </span>
          {provinceMode && <CheckCircle2 className="h-4 w-4 shrink-0" />}
        </button>
      </div>
      {provinceMode && (
        <div className="grid max-h-64 gap-1.5 overflow-auto rounded-md border border-border/40 p-2 sm:grid-cols-2 xl:grid-cols-3">
          {provinces.map((option) => {
            const active = selectedProvinces.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange(active
                  ? selectedProvinces.filter((code) => code !== option.value)
                  : [...selectedProvinces, option.value])}
                className={cn(
                  "flex min-w-0 items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                  active ? "border-primary/45 bg-primary/10 text-primary" : "border-border/40 hover:bg-muted/50",
                )}
              >
                <span className="truncate">{option.label}</span>
                {active && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
      {provinceMode && selectedProvinces.length === 0 && (
        <p className="text-xs text-destructive">请至少选择一个省份，或切换回全国模式。</p>
      )}
    </div>
  );
}

function ChinaWhitelistHostStatusSummary({
  hosts,
  selectedHostIds,
  statusByHostId,
  regionLabelByCode,
}: {
  hosts: any[];
  selectedHostIds: number[];
  statusByHostId: Map<number, any>;
  regionLabelByCode: Map<string, string>;
}) {
  const selectedHosts = hosts.filter((host) => selectedHostIds.includes(Number(host.id)));
  if (selectedHosts.length === 0) return null;
  const appliedCount = selectedHosts.filter((host) => statusByHostId.get(Number(host.id))?.data?.applied === true).length;
  const configuredCount = selectedHosts.filter((host) => statusByHostId.get(Number(host.id))?.data?.configured === true).length;

  return (
    <div className="border-b border-border/40 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm font-medium">Agent 规则状态</p>
        </div>
        <p className="text-xs text-muted-foreground">已读取 {statusByHostId.size}/{selectedHosts.length} 台</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">已配置 {configuredCount} 台，规则已挂载 {appliedCount} 台。</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {selectedHosts.map((host) => {
          const result = statusByHostId.get(Number(host.id));
          const data = result?.data;
          const regions = Array.isArray(data?.regions)
            ? data.regions.map((code: unknown) => regionLabelByCode.get(String(code)) || String(code)).join("、")
            : "";
          const failed = result && result.status !== "success";
          const stateLabel = data?.applied
            ? "规则已挂载"
            : data?.configured
              ? "已同步配置"
              : failed
                ? "读取失败"
                : "尚未读取";
          return (
            <div key={host.id} className="min-w-0 rounded-md border border-border/40 bg-background/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", host.isOnline ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                  <p className="truncate text-sm font-medium">{host.name || `主机 ${host.id}`}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {failed && <ShieldAlert className="h-3.5 w-3.5 text-destructive" />}
                  <Badge variant="outline" className={cn(
                    "text-[10px]",
                    data?.applied ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : failed ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-border/50 text-muted-foreground",
                  )}>
                    {stateLabel}
                  </Badge>
                </div>
              </div>
              {data ? (
                <p className="mt-1.5 truncate text-xs text-muted-foreground" title={regions || "未配置区域"}>
                  {data.backend === "none" ? "未检测到防火墙规则" : `${data.backend || "-"} · ${Number(data.ruleCount || 0)} 条 CIDR`}
                  {regions ? ` · ${regions}` : ""}
                  {data.serviceActive ? " · 已持久化" : ""}
                </p>
              ) : failed ? (
                <p className="mt-1.5 line-clamp-2 text-xs text-destructive">{result.error || result.stderr || result.output || "Agent 未返回状态"}</p>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">点击下方“读取主机状态”获取实际规则状态。</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Plugins() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: publicInfo } = trpc.system.publicInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: storeItems = [], isLoading: storeLoading } = trpc.plugins.store.useQuery(undefined, {
    enabled: publicInfo?.pluginsEnabled === true,
  });
  const { data: plugins = [], isLoading: pluginsLoading } = trpc.plugins.list.useQuery(undefined, {
    enabled: publicInfo?.pluginsEnabled === true,
  });
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [activeSection, setActiveSection] = useState<PluginSection>("usage");
  const [githubRepository, setGithubRepository] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubManifestPath, setGithubManifestPath] = useState("");
  const [customInstallOpen, setCustomInstallOpen] = useState(false);
  const [storeDetailItem, setStoreDetailItem] = useState<any | null>(null);
  const [uploadContent, setUploadContent] = useState("");
  const [uploadFileName, setUploadFileName] = useState("");
  const [settingDraft, setSettingDraft] = useState<Record<string, unknown>>({});
  const [usageDraft, setUsageDraft] = useState<PluginUsageDraft>(defaultPluginUsage);
  const [actionInputDialog, setActionInputDialog] = useState<any | null>(null);
  const [actionInputDraft, setActionInputDraft] = useState<Record<string, unknown>>({});
  const [actionResult, setActionResult] = useState<any | null>(null);
  const [agentActionGroupId, setAgentActionGroupId] = useState("");
  const [activePageId, setActivePageId] = useState("");
  const [activeAssetPath, setActiveAssetPath] = useState("");
  const [activeResourceViewId, setActiveResourceViewId] = useState("");

  const selectedPlugin = useMemo(
    () => plugins.find((plugin: PluginRow) => plugin.pluginId === selectedPluginId) || plugins[0],
    [plugins, selectedPluginId],
  );
  const selectedManifest = getPluginManifest(selectedPlugin);
  const settingFields = (selectedManifest.settingsSchema || []) as PluginSettingField[];
  const pluginPages = Array.isArray(selectedManifest.pages) ? selectedManifest.pages : [];
  const pluginActions = Array.isArray(selectedManifest.actions) ? selectedManifest.actions : [];
  const pluginUsageViews = Array.isArray(selectedManifest.usageViews) ? selectedManifest.usageViews : [];
  const pluginResourceViews = Array.isArray(selectedManifest.resourceSchemas)
    ? selectedManifest.resourceSchemas
    : Array.isArray(selectedManifest.resourceViews)
      ? selectedManifest.resourceViews
      : [];
  const hostAssetSyncUsageView = pluginUsageViews.find((view: any) => view?.type === "host-asset-sync");
  const hasUsageView = !!hostAssetSyncUsageView;
  const resourceActionIds = new Set(pluginResourceViews.flatMap((view: any) => [
    ...(view?.sources || []).map((source: any) => source?.actionId),
    view?.operations?.create?.actionId,
    view?.operations?.update?.actionId,
    view?.operations?.delete?.actionId,
    ...(view?.operations?.execute || []).map((operation: any) => operation?.actionId),
  ].filter(Boolean)));
  const usageAgentActions = pluginActions.filter((action: any) => action?.type === "agent.request" && !resourceActionIds.has(action.id));
  const managementPluginActions = hasUsageView
    ? pluginActions.filter((action: any) => action?.type !== "agent.request")
    : pluginActions;
  const usageFields = (hostAssetSyncUsageView?.fields || []) as PluginUsageField[];
  const isChinaRegionWhitelist = selectedPlugin?.pluginId === "china-region-whitelist";
  const chinaRegionField = isChinaRegionWhitelist ? usageFields.find((field) => field.key === "region-codes") : undefined;
  const renderedUsageFields = isChinaRegionWhitelist
    ? usageFields.filter((field) => field.key !== "region-codes")
    : usageFields;
  const chinaRegionLabelByCode = useMemo(() => new Map((chinaRegionField?.options || []).map((option) => [option.value, option.label])), [chinaRegionField?.options]);
  const usageOperationOptions = Array.isArray(hostAssetSyncUsageView?.operationSelector?.options)
    ? hostAssetSyncUsageView.operationSelector.options
    : [];
  const usageAssetMode = hostAssetSyncUsageView?.assetMode === "all-plugin-assets" ? "all-plugin-assets" : "selected-assets";
  const usageUsesAllAssets = usageAssetMode === "all-plugin-assets";
  const usageAssetSelectorHidden = usageUsesAllAssets || hostAssetSyncUsageView?.assetSelector?.hidden === true;

  const { data: assets = [], isLoading: assetsLoading } = trpc.plugins.assets.useQuery(
    { pluginId: selectedPlugin?.pluginId || "" },
    { enabled: !!selectedPlugin?.pluginId },
  );
  const { data: pluginUsage, isLoading: pluginUsageLoading } = trpc.plugins.usage.useQuery(
    { pluginId: selectedPlugin?.pluginId || "", usageViewId: hostAssetSyncUsageView?.id },
    { enabled: !!selectedPlugin?.pluginId && hasUsageView },
  );
  const savedUsage = (pluginUsage as any)?.usage;
  const savedUsageEnabled = savedUsage?.enabled === true;
  const savedUsageHostCount = Array.isArray(savedUsage?.hostIds) ? savedUsage.hostIds.length : 0;
  const agentActionStatusQuery = trpc.plugins.agentActionStatus.useQuery(
    { pluginId: selectedPlugin?.pluginId || "", groupId: agentActionGroupId },
    {
      enabled: !!selectedPlugin?.pluginId && !!agentActionGroupId,
      refetchInterval: 1000,
      refetchOnWindowFocus: false,
    },
  );
  const agentActionStatus = agentActionStatusQuery.data;
  const chinaWhitelistStatusByHostId = useMemo<Map<number, any>>(() => {
    const rows = actionResult?.result?.actionId === "read-agent-status" && Array.isArray(actionResult?.result?.body?.results)
      ? actionResult.result.body.results
      : [];
    const entries: Array<readonly [number, any]> = rows
      .map((row: any) => [Number(row?.hostId), row] as const);
    return new Map<number, any>(entries
      .filter(([hostId]: readonly [number, any]) => Number.isInteger(hostId) && hostId > 0));
  }, [actionResult]);

  const selectedAsset = assets.find((asset: any) => asset.path === activeAssetPath) || assets[0];
  const selectedPage = pluginPages.find((page: any) => page.id === activePageId) || pluginPages[0];
  const selectedPageAsset = selectedPage?.assetPath
    ? assets.find((asset: any) => asset.path === selectedPage.assetPath)
    : null;
  const selectedPageContent = selectedPageAsset?.content || selectedPage?.content || "";
  const activeResourceView = pluginResourceViews.find((view: any) => view.id === activeResourceViewId) || pluginResourceViews[0];
  const actionResultDefinition = pluginActions.find((action: any) => action.id === actionResult?.result?.actionId);
  const canRevealPluginSecrets = (selectedPlugin?.permissions || selectedManifest.permissions || []).includes("secret:reveal");

  const invalidatePluginQueries = async () => {
    await Promise.all([
      utils.plugins.list.invalidate(),
      utils.plugins.store.invalidate(),
      hasUsageView && selectedPlugin?.pluginId
        ? utils.plugins.usage.invalidate({ pluginId: selectedPlugin.pluginId, usageViewId: hostAssetSyncUsageView?.id })
        : Promise.resolve(),
      selectedPlugin?.pluginId ? utils.plugins.assets.invalidate({ pluginId: selectedPlugin.pluginId }) : Promise.resolve(),
    ]);
  };

  const installFromStore = trpc.plugins.installFromStore.useMutation({
    onSuccess: async (plugin) => {
      toast.success("插件已安装");
      setSelectedPluginId((plugin as any)?.pluginId || "");
      setStoreDetailItem(null);
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "安装失败"),
  });

  const installFromGithub = trpc.plugins.installFromGithub.useMutation({
    onSuccess: async (plugin) => {
      toast.success("插件已安装");
      setSelectedPluginId((plugin as any)?.pluginId || "");
      setGithubRepository("");
      setGithubManifestPath("");
      setCustomInstallOpen(false);
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "安装失败"),
  });

  const installFromUpload = trpc.plugins.installFromUpload.useMutation({
    onSuccess: async (plugin) => {
      toast.success("插件已安装");
      setSelectedPluginId((plugin as any)?.pluginId || "");
      setUploadContent("");
      setUploadFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setCustomInstallOpen(false);
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "上传失败"),
  });

  const setEnabledMutation = trpc.plugins.setEnabled.useMutation({
    onSuccess: async (plugin) => {
      toast.success((plugin as any)?.status === "enabled" ? "插件已启用" : "插件已停用");
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "操作失败"),
  });

  const uninstallMutation = trpc.plugins.uninstall.useMutation({
    onSuccess: async () => {
      toast.success("插件已卸载");
      setSelectedPluginId("");
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "卸载失败"),
  });

  const checkUpdateMutation = trpc.plugins.checkUpdate.useMutation({
    onSuccess: async (result) => {
      toast.success(result.hasUpdate ? `发现新版本 ${result.latestVersion}` : "当前已是最新");
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "检查更新失败"),
  });

  const updateFromGithubMutation = trpc.plugins.updateFromGithub.useMutation({
    onSuccess: async () => {
      toast.success("插件已更新");
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "更新失败"),
  });

  const saveSettingMutation = trpc.plugins.saveSetting.useMutation({
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const saveUsageMutation = trpc.plugins.saveUsage.useMutation({
    onSuccess: async () => {
      toast.success("使用配置已保存");
      setActionResult(null);
      setAgentActionGroupId("");
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const runActionMutation = trpc.plugins.runAction.useMutation({
    onSuccess: (result: any) => {
      setActionResult(result);
      const groupId = String(result?.result?.groupId || "");
      setAgentActionGroupId(groupId);
      if (result?.ok === false) {
        toast.error(result?.message || "动作执行未成功");
      } else if (groupId) {
        toast.success(result?.message || "任务已下发");
      } else {
        toast.success(result?.message || "动作已执行");
      }
      invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "执行失败"),
  });

  useEffect(() => {
    if (!plugins.length) {
      setSelectedPluginId("");
      return;
    }
    if (!selectedPluginId || !plugins.some((plugin: PluginRow) => plugin.pluginId === selectedPluginId)) {
      setSelectedPluginId(plugins[0].pluginId);
    }
  }, [plugins, selectedPluginId]);

  useEffect(() => {
    if (!selectedPlugin) {
      setSettingDraft({});
      setActionInputDialog(null);
      setActionInputDraft({});
      setActionResult(null);
      setAgentActionGroupId("");
      return;
    }
    const saved = getPluginSettings(selectedPlugin);
    const next: Record<string, unknown> = {};
    for (const field of settingFields) {
      next[field.key] = normalizeSettingDraftValue(
        field,
        saved[field.key] !== undefined ? saved[field.key] : settingDefaultValue(field),
      );
    }
    setSettingDraft(next);
    setActionInputDialog(null);
    setActionInputDraft({});
    setActionResult(null);
    setAgentActionGroupId("");
  }, [selectedPlugin?.pluginId, selectedPlugin?.manifestJson]);

  useEffect(() => {
    if (!pluginResourceViews.length) {
      setActiveResourceViewId("");
      return;
    }
    if (!pluginResourceViews.some((view: any) => view.id === activeResourceViewId)) {
      setActiveResourceViewId(pluginResourceViews[0].id);
    }
  }, [activeResourceViewId, pluginResourceViews]);

  useEffect(() => {
    if (!agentActionStatus) {
      if (agentActionGroupId && agentActionStatusQuery.isFetched) {
        setActionResult({
          ok: false,
          message: "插件任务状态已失效，请重新执行",
          result: {
            type: "agent.request",
            body: {
              status: "error",
              done: true,
              total: 0,
              completed: 0,
              results: [],
              error: "面板重启或任务结果超过保留时间，请重新读取主机状态。",
            },
          },
        });
        setAgentActionGroupId("");
      }
      return;
    }
    setActionResult({
      ok: agentActionStatus.status === "success" || agentActionStatus.status === "partial",
      message: agentActionStatus.done ? "Agent 操作已完成" : "Agent 操作执行中",
      result: {
        type: "agent.request",
        actionId: agentActionStatus.actionId,
        groupId: agentActionStatus.groupId,
        body: agentActionStatus,
      },
    });
    if (agentActionStatus.done) setAgentActionGroupId("");
  }, [agentActionGroupId, agentActionStatus, agentActionStatusQuery.isFetched]);

  useEffect(() => {
    if (!hasUsageView) {
      setUsageDraft(defaultPluginUsage);
      return;
    }
    const usage = (pluginUsage as any)?.usage;
    const savedFieldValues = usage?.fieldValues && typeof usage.fieldValues === "object" ? usage.fieldValues : {};
    const nextFieldValues: Record<string, unknown> = {};
    for (const field of usageFields) {
      nextFieldValues[field.key] = normalizeUsageFieldDraftValue(
        field,
        savedFieldValues[field.key] !== undefined ? savedFieldValues[field.key] : usageFieldDefaultValue(field),
      );
    }
    setUsageDraft({
      enabled: !!usage?.enabled,
      hostIds: Array.isArray(usage?.hostIds) ? usage.hostIds.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0) : [],
      assetPaths: Array.isArray(usage?.assetPaths) ? usage.assetPaths.map((item: unknown) => String(item || "")).filter(Boolean) : [],
      operation: String(usage?.operation || hostAssetSyncUsageView?.operationSelector?.defaultValue || usageOperationOptions[0]?.value || ""),
      fieldValues: nextFieldValues,
      note: String(usage?.note || ""),
    });
  }, [hasUsageView, (pluginUsage as any)?.usage?.updatedAt, selectedPlugin?.pluginId, hostAssetSyncUsageView?.id]);

  useEffect(() => {
    if (!selectedPage || pluginPages.some((page: any) => page.id === activePageId)) return;
    setActivePageId(selectedPage?.id || "");
  }, [activePageId, pluginPages, selectedPage?.id]);

  useEffect(() => {
    if (!selectedAsset || assets.some((asset: any) => asset.path === activeAssetPath)) return;
    setActiveAssetPath(selectedAsset?.path || "");
  }, [activeAssetPath, assets, selectedAsset?.path]);

  const installedIds = new Set(plugins.map((plugin: PluginRow) => plugin.pluginId));
  const isBusy = installFromStore.isPending
    || installFromGithub.isPending
    || installFromUpload.isPending
    || setEnabledMutation.isPending
    || uninstallMutation.isPending
    || checkUpdateMutation.isPending
    || updateFromGithubMutation.isPending
    || saveSettingMutation.isPending
    || saveUsageMutation.isPending
    || runActionMutation.isPending;

  const handleGithubInstall = () => {
    const repository = githubRepository.trim();
    if (!repository) {
      toast.error("请填写 GitHub 仓库地址");
      return;
    }
    installFromGithub.mutate({
      repository,
      branch: githubBranch.trim() || "main",
      manifestPath: githubManifestPath.trim() || undefined,
    });
  };

  const handleUploadInstall = () => {
    const content = uploadContent.trim();
    if (!content) {
      toast.error("请选择插件压缩包");
      return;
    }
    installFromUpload.mutate({
      content,
      fileName: uploadFileName || undefined,
      encoding: "base64",
    });
  };

  const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() || "" : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });

  const handleFileSelect = async (file?: File | null) => {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    const isArchive = lowerName.endsWith(".zip") || lowerName.endsWith(".tar.gz") || lowerName.endsWith(".tgz");
    if (!isArchive) {
      toast.error("请上传 .zip、.tar.gz 或 .tgz 插件包");
      setUploadFileName("");
      setUploadContent("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("插件压缩包不能超过 5MB");
      setUploadFileName("");
      setUploadContent("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploadFileName(file.name);
    setUploadContent(await fileToBase64(file));
    toast.success("插件压缩包已读取");
  };

  const handleSaveSettings = async () => {
    if (!selectedPlugin) return;
    if (!settingFields.length) return;
    try {
      await Promise.all(settingFields.map((field) => saveSettingMutation.mutateAsync({
        pluginId: selectedPlugin.pluginId,
        key: field.key,
        value: field.type === "number" && settingDraft[field.key] !== "" ? Number(settingDraft[field.key]) : settingDraft[field.key],
      })));
      toast.success("插件设置已保存");
      await invalidatePluginQueries();
    } catch {
      // 单项错误由 mutation onError 展示。
    }
  };

  const handleSaveUsage = () => {
    if (!selectedPlugin || !hostAssetSyncUsageView) return;
    if (usageDraft.enabled && usageDraft.hostIds.length === 0) {
      toast.error("请选择至少一台生效主机");
      return;
    }
    if (usageDraft.enabled && !usageUsesAllAssets && usageDraft.assetPaths.length === 0) {
      toast.error("请选择至少一个白名单文件");
      return;
    }
    if (usageDraft.enabled && !usageUsesAllAssets && selectedUsageAssetsSize > pluginHostAssetSyncMaxBytes) {
      toast.error(`同步文件总大小不能超过 ${formatBytes(pluginHostAssetSyncMaxBytes)}`);
      return;
    }
    if (usageDraft.enabled) {
      for (const field of usageFields) {
        if (!field.required) continue;
        const value = usageDraft.fieldValues[field.key];
        const empty = Array.isArray(value) ? value.length === 0 : String(value ?? "").trim() === "";
        if (empty) {
          toast.error(`请填写 ${field.label}`);
          return;
        }
      }
    }
    saveUsageMutation.mutate({
      pluginId: selectedPlugin.pluginId,
      usageViewId: hostAssetSyncUsageView.id,
      enabled: usageDraft.enabled,
      hostIds: usageDraft.hostIds,
      assetPaths: usageUsesAllAssets ? [] : usageDraft.assetPaths,
      operation: usageDraft.operation || usageOperationOptions[0]?.value || undefined,
      fieldValues: usageDraft.fieldValues,
      note: usageDraft.note,
    });
  };

  const handleUninstall = async (plugin: PluginRow) => {
    const confirmed = await confirmDialog({
      title: "卸载插件",
      description: `确定卸载 ${plugin.name || plugin.pluginId}？`,
      confirmText: "卸载",
      tone: "destructive",
    });
    if (confirmed) uninstallMutation.mutate({ pluginId: plugin.pluginId });
  };

  const executePluginAction = async (action: any, input?: Record<string, unknown>) => {
    if (!selectedPlugin) return false;
    if (action.confirmRequired) {
      const confirmed = await confirmDialog({
        title: action.label || "执行动作",
        description: action.description || "确定执行该插件动作？",
        confirmText: "执行",
      });
      if (!confirmed) return false;
    }
    try {
      await runActionMutation.mutateAsync({ pluginId: selectedPlugin.pluginId, actionId: action.id, input });
      return true;
    } catch {
      // Mutation onError shows the failure toast; keep the dialog open for quick retry.
      return false;
    }
  };

  const handleRunAction = async (action: any) => {
    const fields = Array.isArray(action?.inputSchema) ? action.inputSchema as PluginSettingField[] : [];
    if (fields.length > 0) {
      setActionResult(null);
      setAgentActionGroupId("");
      setActionInputDraft(buildActionInputDraft(action));
      setActionInputDialog(action);
      return;
    }
    await executePluginAction(action);
  };

  const handleSubmitActionInput = async () => {
    if (!actionInputDialog) return;
    const fields = Array.isArray(actionInputDialog.inputSchema) ? actionInputDialog.inputSchema as PluginSettingField[] : [];
    for (const field of fields) {
      if (!field.required) continue;
      const value = actionInputDraft[field.key];
      if (String(value ?? "").trim() === "") {
        toast.error(`请填写${field.label}`);
        return;
      }
    }
    const ok = await executePluginAction(actionInputDialog, actionInputDraft);
    if (ok) setActionInputDialog(null);
  };

  const handleDownloadAsset = (asset?: any) => {
    if (!asset) return;
    const blob = new Blob([String(asset.content || "")], {
      type: asset.contentType || "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = String(asset.path || "plugin-asset").split("/").pop() || "plugin-asset";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const usageHosts = ((pluginUsage as any)?.hosts || []) as any[];
  const usageAssets = ((pluginUsage as any)?.assets || []) as any[];
  const selectedUsageAssets = usageAssets.filter((asset) => usageDraft.assetPaths.includes(String(asset.path || "")));
  const selectedUsageAssetsSize = selectedUsageAssets.reduce((sum, asset) => sum + Number(asset.size || 0), 0);
  const usageSizeExceeded = !usageUsesAllAssets && selectedUsageAssetsSize > pluginHostAssetSyncMaxBytes;
  const renderUsagePanel = () => {
    if (!selectedPlugin) {
      return (
        <div className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          先从左侧选择一个插件。
        </div>
      );
    }
    if (!hasUsageView) {
      return (
        <div className="rounded-xl border border-dashed border-border/60 p-8 text-center">
          <div className="mx-auto mb-3 flex justify-center">
            <PluginLogo logo={selectedManifest.logo} name={selectedPlugin.name} />
          </div>
          <p className="font-medium">{selectedPlugin.name || selectedPlugin.pluginId}</p>
          <p className="mt-2 text-sm text-muted-foreground">这个插件暂未提供独立使用界面，可到“插件管理”查看说明、设置或动作。</p>
        </div>
      );
    }
    if (pluginUsageLoading) {
      return <DataSectionLoading label="正在加载使用配置" minHeight="min-h-[220px]" />;
    }
    return (
      <>
        <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-base font-medium">{hostAssetSyncUsageView?.title || "主机使用配置"}</p>
              {(hostAssetSyncUsageView?.description || hostAssetSyncUsageView?.targetDirectory) && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {hostAssetSyncUsageView?.description || `选中的文件会同步到目标主机的 ${hostAssetSyncUsageView?.targetDirectory}。`}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 rounded-full border border-border/40 bg-background/70 px-3 py-2">
              <span className="text-sm text-muted-foreground">{hostAssetSyncUsageView?.enableLabel || "启用"}</span>
              <Switch
                checked={usageDraft.enabled}
                onCheckedChange={(enabled) => setUsageDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </div>
          {selectedPlugin.status !== "enabled" && (
            <Alert className="mt-4 border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{hostAssetSyncUsageView?.disabledTitle || "插件未启用"}</AlertTitle>
              <AlertDescription>{hostAssetSyncUsageView?.disabledDescription || "可以先保存配置，启用插件后会在 Agent 心跳时同步到主机。"}</AlertDescription>
            </Alert>
          )}
        </div>

        {(isChinaRegionWhitelist || usageOperationOptions.length > 0 || renderedUsageFields.length > 0) && (
          <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
            {usageOperationOptions.length > 0 && (
              <div className="mb-4 space-y-2">
                <Label>{hostAssetSyncUsageView?.operationSelector?.label || "执行方式"}</Label>
                <Select
                  value={usageDraft.operation || usageOperationOptions[0]?.value || ""}
                  onValueChange={(operation) => setUsageDraft((current) => ({ ...current, operation }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {usageOperationOptions.map((option: any) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(hostAssetSyncUsageView?.operationSelector?.description || usageOperationOptions.find((option: any) => option.value === usageDraft.operation)?.description) && (
                  <p className="text-xs text-muted-foreground">
                    {usageOperationOptions.find((option: any) => option.value === usageDraft.operation)?.description || hostAssetSyncUsageView?.operationSelector?.description}
                  </p>
                )}
              </div>
            )}
            {isChinaRegionWhitelist && chinaRegionField && (
              <div className="mb-4">
                <ChinaWhitelistRegionSelector
                  field={chinaRegionField}
                  value={usageDraft.fieldValues[chinaRegionField.key]}
                  disabled={saveUsageMutation.isPending}
                  onChange={(value) => setUsageDraft((current) => ({
                    ...current,
                    fieldValues: { ...current.fieldValues, [chinaRegionField.key]: value },
                  }))}
                />
              </div>
            )}
            {renderedUsageFields.length > 0 && (
              <div className="grid gap-4 lg:grid-cols-2">
                {renderedUsageFields.map((field) => (
                  <PluginUsageFieldInput
                    key={field.key}
                    field={field}
                    value={usageDraft.fieldValues[field.key]}
                    disabled={saveUsageMutation.isPending}
                    onChange={(value) => setUsageDraft((current) => ({
                      ...current,
                      fieldValues: { ...current.fieldValues, [field.key]: value },
                    }))}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className={cn("grid gap-4", usageAssetSelectorHidden ? "xl:grid-cols-1" : "xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]")}>
          <div className="space-y-3 rounded-xl border border-border/40 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{hostAssetSyncUsageView?.hostSelector?.title || "生效主机"}</p>
                <p className="text-xs text-muted-foreground">
                  {hostAssetSyncUsageView?.hostSelector?.selectedLabel || "已选"} {usageDraft.hostIds.length} 台
                </p>
                {hostAssetSyncUsageView?.hostSelector?.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{hostAssetSyncUsageView.hostSelector.description}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setUsageDraft((current) => ({
                    ...current,
                    hostIds: usageHosts.map((host) => Number(host.id)).filter((id) => Number.isInteger(id) && id > 0),
                  }))}
                >
                  {hostAssetSyncUsageView?.hostSelector?.selectAllLabel || "全选"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setUsageDraft((current) => ({ ...current, hostIds: [] }))}
                >
                  {hostAssetSyncUsageView?.hostSelector?.clearLabel || "清空"}
                </Button>
              </div>
            </div>
            {isChinaRegionWhitelist && pluginResourceViews.length === 0 && (
              <ChinaWhitelistHostStatusSummary
                hosts={usageHosts}
                selectedHostIds={usageDraft.hostIds}
                statusByHostId={chinaWhitelistStatusByHostId}
                regionLabelByCode={chinaRegionLabelByCode}
              />
            )}
            <div className="max-h-72 space-y-2 overflow-auto pr-1">
              {usageHosts.length ? usageHosts.map((host) => {
                const hostId = Number(host.id);
                const active = usageDraft.hostIds.includes(hostId);
                return (
                  <button
                    key={host.id}
                    type="button"
                    onClick={() => setUsageDraft((current) => ({
                      ...current,
                      hostIds: toggleNumberItem(current.hostIds, hostId),
                    }))}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      active ? "border-primary/40 bg-primary/5" : "border-border/40 bg-background/60 hover:bg-muted/40",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", host.isOnline ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{host.name || `主机 ${host.id}`}</p>
                        <p className="truncate text-xs text-muted-foreground">{host.ip || "-"}</p>
                      </div>
                    </div>
                    {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              }) : (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  {hostAssetSyncUsageView?.hostSelector?.emptyText || "暂无可选主机"}
                </div>
              )}
            </div>
          </div>

          {!usageAssetSelectorHidden && <div className="space-y-3 rounded-xl border border-border/40 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{hostAssetSyncUsageView?.assetSelector?.title || "同步内容"}</p>
                <p className="text-xs text-muted-foreground">
                  {hostAssetSyncUsageView?.assetSelector?.selectedLabel || "已选"} {usageDraft.assetPaths.length} 个文件，
                  <span className={cn(usageSizeExceeded && "text-destructive")}>
                    {formatBytes(selectedUsageAssetsSize)}
                  </span>
                  / {formatBytes(pluginHostAssetSyncMaxBytes)}
                </p>
                {hostAssetSyncUsageView?.assetSelector?.description && (
                  <p className="mt-1 text-xs text-muted-foreground">{hostAssetSyncUsageView.assetSelector.description}</p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setUsageDraft((current) => ({ ...current, assetPaths: [] }))}
              >
                {hostAssetSyncUsageView?.assetSelector?.clearLabel || "清空"}
              </Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto pr-1">
              {usageAssets.length ? usageAssets.map((asset) => {
                const path = String(asset.path || "");
                const active = usageDraft.assetPaths.includes(path);
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => setUsageDraft((current) => ({
                      ...current,
                      assetPaths: toggleStringItem(current.assetPaths, path),
                    }))}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      active ? "border-primary/40 bg-primary/5" : "border-border/40 bg-background/60 hover:bg-muted/40",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{asset.label || path}</p>
                      {asset.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{asset.description}</p>}
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{path} · {formatBytes(asset.size || 0)}</p>
                    </div>
                    {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              }) : (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  {hostAssetSyncUsageView?.assetSelector?.emptyText || "还没有可同步文件，请先到“动作”里刷新插件资产"}
                </div>
              )}
            </div>
            {usageSizeExceeded && (
              <p className="text-xs text-destructive">
                当前选择超过 Agent 单次同步限制，请减少文件数量后保存。
              </p>
            )}
          </div>}
        </div>

        <div className="space-y-2">
          <Label>{hostAssetSyncUsageView?.noteField?.label || "备注"}</Label>
          <Textarea
            value={usageDraft.note}
            onChange={(event) => setUsageDraft((current) => ({ ...current, note: event.target.value }))}
            placeholder={hostAssetSyncUsageView?.noteField?.placeholder || "例如：说明这个配置会用在哪些主机或脚本里"}
            className="min-h-20"
          />
        </div>

        {usageAgentActions.length > 0 && (
          <div className="space-y-3 rounded-xl border border-border/40 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">主机操作</p>
                <p className="text-xs text-muted-foreground">从已保存的生效主机读取或执行插件声明的 Agent 操作。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {usageAgentActions.map((action: any) => (
                  <Button
                    key={action.id}
                    type="button"
                    variant="outline"
                    className="gap-2"
                    disabled={selectedPlugin.status !== "enabled" || !savedUsageEnabled || savedUsageHostCount === 0 || runActionMutation.isPending || !!agentActionGroupId}
                    onClick={() => handleRunAction(action)}
                  >
                    {runActionMutation.isPending || agentActionGroupId
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <RefreshCw className="h-4 w-4" />}
                    {action.label || "执行"}
                  </Button>
                ))}
              </div>
            </div>
            {actionResult?.result?.type === "agent.request" && (
              <AgentActionResultPanel
                result={actionResult}
                resultSchema={actionResultDefinition?.resultSchema}
                canRevealSecrets={canRevealPluginSecrets}
                onClear={() => {
                  setActionResult(null);
                  setAgentActionGroupId("");
                }}
              />
            )}
          </div>
        )}

        {pluginResourceViews.length > 0 && savedUsageEnabled && activeResourceView && (
          <div className="space-y-4 border-t border-border/40 pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">Agent 资源管理</p>
                <p className="text-xs text-muted-foreground">选择节点后实时读取并管理该 Agent 上的插件资源。</p>
              </div>
              {pluginResourceViews.length > 1 && (
                <Tabs value={activeResourceView.id} onValueChange={setActiveResourceViewId}>
                  <TabsList>
                    {pluginResourceViews.map((view: any) => <TabsTrigger key={view.id} value={view.id}>{view.title}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
              )}
            </div>
            <AgentResourceManager
              plugin={selectedPlugin}
              view={activeResourceView}
              usage={savedUsage}
              hosts={usageHosts}
            />
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-background/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            <p>{hostAssetSyncUsageView?.footer?.title || "当前方式：同步文件到主机本地目录。"}</p>
            <p className="mt-1">{hostAssetSyncUsageView?.footer?.description || "保存后，目标主机下次 Agent 心跳会收到更新。"}</p>
          </div>
          <Button
            className="gap-2"
            onClick={handleSaveUsage}
            disabled={saveUsageMutation.isPending || usageSizeExceeded}
          >
            {saveUsageMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Server className="h-4 w-4" />}
            {hostAssetSyncUsageView?.footer?.submitLabel || "保存使用配置"}
          </Button>
        </div>
      </>
    );
  };

  if (publicInfo?.pluginsEnabled !== true) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Puzzle className="h-5 w-5" />
              插件功能未开启
            </CardTitle>
            <CardDescription>请先在系统设置的管理菜单开关中开启“插件”。</CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">插件</h1>
            <p className="mt-1 text-sm text-muted-foreground">安装、更新和调试插件能力。</p>
          </div>
          <Button className="w-full gap-2 sm:w-auto" onClick={() => setCustomInstallOpen(true)}>
            <Upload className="h-4 w-4" />
            自定义安装
          </Button>
        </div>

        <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as PluginSection)} className="space-y-4">
          <SlidingTabsList items={PLUGIN_SECTIONS} activeValue={activeSection} ariaLabel="插件管理" minItemWidthRem={7.5} />
        </Tabs>

        {activeSection === "usage" && (
          <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.55fr)_minmax(0,1.45fr)]">
            <Card className="border-border/40 bg-card/60 backdrop-blur-md">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Puzzle className="h-4 w-4 text-primary" />
                  插件列表
                </CardTitle>
                <CardDescription>选择插件后在右侧使用它提供的功能。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {pluginsLoading ? (
                  <DataSectionLoading label="正在加载插件" minHeight="min-h-[160px]" />
                ) : plugins.length ? (
                  plugins.map((plugin: PluginRow) => {
                    const active = selectedPlugin?.pluginId === plugin.pluginId;
                    const manifest = getPluginManifest(plugin);
                    return (
                      <button
                        key={plugin.pluginId}
                        type="button"
                        onClick={() => setSelectedPluginId(plugin.pluginId)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                          active ? "border-primary/40 bg-primary/5" : "border-border/40 bg-muted/20 hover:bg-muted/35",
                        )}
                      >
                        <PluginLogo logo={manifest.logo} name={plugin.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium">{plugin.name || plugin.pluginId}</p>
                            <Badge variant="outline" className={pluginStatusClass(plugin.status)}>
                              {pluginStatusLabel(plugin.status)}
                            </Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{plugin.description || plugin.pluginId}</p>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                    还没有安装插件
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/40 bg-card/60 backdrop-blur-md">
              <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  {selectedPlugin && <PluginLogo logo={selectedManifest.logo} name={selectedPlugin.name} />}
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      {selectedPlugin?.name || "插件使用"}
                    </CardTitle>
                    <CardDescription>{selectedPlugin?.description || "安装插件后可在这里使用插件功能。"}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {renderUsagePanel()}
              </CardContent>
            </Card>
          </div>
        )}

        {activeSection === "store" && (
        <div className="grid gap-4">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PackagePlus className="h-4 w-4 text-primary" />
                插件商店
              </CardTitle>
              <CardDescription>查看插件详情，或直接一键安装。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {storeLoading ? (
                <DataSectionLoading label="正在加载商店" minHeight="min-h-[120px]" />
              ) : storeItems.length ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {storeItems.map((item: any) => {
                    const installed = installedIds.has(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setStoreDetailItem(item)}
                        className="group flex min-h-[17rem] flex-col rounded-2xl border border-border/40 bg-muted/20 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:bg-muted/30 hover:shadow-lg hover:shadow-primary/5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <PluginLogo logo={item.logo} name={item.name} />
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {item.official && <Badge className="bg-primary text-primary-foreground">官方</Badge>}
                            {installed && <Badge className="bg-emerald-500 text-white">已安装</Badge>}
                          </div>
                        </div>
                        <div className="mt-4 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-base font-semibold">{item.name}</p>
                            <Badge variant="outline">{item.category}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.author || "ForwardX"} · v{item.version || "0.0.0"} · {formatDateText(item.updatedAt)}
                          </p>
                          <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">{item.description}</p>
                          {Array.isArray(item.features) && item.features.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {item.features.slice(0, 3).map((feature: any) => (
                                <Badge key={feature.title} variant="outline" className="bg-background/60">
                                  {feature.title}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/40 pt-3">
                          <span className="text-xs text-muted-foreground">点击查看详情</span>
                          <Button
                            size="sm"
                            className="gap-2"
                            variant={installed ? "outline" : "default"}
                            onClick={(event) => {
                              event.stopPropagation();
                              installFromStore.mutate({ id: item.id });
                            }}
                            disabled={installFromStore.isPending}
                          >
                            {installFromStore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            {installed ? "重装" : "安装"}
                          </Button>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  暂无商店插件
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        )}

        <Dialog open={customInstallOpen} onOpenChange={setCustomInstallOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                自定义安装
              </DialogTitle>
              <DialogDescription>支持 GitHub 仓库或插件压缩包。</DialogDescription>
            </DialogHeader>
            <Tabs defaultValue="github" className="space-y-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="github">GitHub</TabsTrigger>
                <TabsTrigger value="upload">上传</TabsTrigger>
              </TabsList>
              <TabsContent value="github" className="space-y-4">
                <div className="space-y-2">
                  <Label>仓库地址</Label>
                  <Input
                    value={githubRepository}
                    onChange={(event) => setGithubRepository(event.target.value)}
                    placeholder="https://github.com/owner/repo"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>分支</Label>
                    <Input value={githubBranch} onChange={(event) => setGithubBranch(event.target.value)} placeholder="main" />
                  </div>
                  <div className="space-y-2">
                    <Label>Manifest 路径</Label>
                    <Input value={githubManifestPath} onChange={(event) => setGithubManifestPath(event.target.value)} placeholder="forwardx-plugin.json" />
                  </div>
                </div>
                <Button className="w-full gap-2" onClick={handleGithubInstall} disabled={installFromGithub.isPending}>
                  {installFromGithub.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                  从 GitHub 安装
                </Button>
              </TabsContent>
              <TabsContent value="upload" className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
                  className="hidden"
                  onChange={(event) => handleFileSelect(event.target.files?.[0])}
                />
                <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">上传插件压缩包</p>
                      <p className="mt-1 text-xs text-muted-foreground">支持 .zip、.tar.gz、.tgz，包内需包含 forwardx-plugin.json。</p>
                    </div>
                    <Button variant="outline" className="shrink-0 gap-2" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="h-4 w-4" />
                      选择插件包
                    </Button>
                  </div>
                  {uploadFileName && (
                    <div className="mt-4 rounded-lg border border-border/40 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                      已选择：{uploadFileName}
                    </div>
                  )}
                </div>
                <Button className="w-full gap-2" onClick={handleUploadInstall} disabled={installFromUpload.isPending || !uploadContent.trim()}>
                  {installFromUpload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  上传安装
                </Button>
              </TabsContent>
            </Tabs>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCustomInstallOpen(false)} disabled={installFromGithub.isPending || installFromUpload.isPending}>
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!storeDetailItem} onOpenChange={(open) => !open && setStoreDetailItem(null)}>
          <DialogContent className="sm:max-w-2xl">
            {storeDetailItem && (
              <>
                <DialogHeader>
                  <div className="flex min-w-0 items-start gap-3">
                    <PluginLogo logo={storeDetailItem.logo} name={storeDetailItem.name} />
                    <div className="min-w-0">
                      <DialogTitle className="flex flex-wrap items-center gap-2">
                        {storeDetailItem.name}
                        {storeDetailItem.official && <Badge className="bg-primary text-primary-foreground">官方</Badge>}
                        {installedIds.has(storeDetailItem.id) && <Badge className="bg-emerald-500 text-white">已安装</Badge>}
                      </DialogTitle>
                      <DialogDescription className="mt-1">
                        开发者：{storeDetailItem.author || "ForwardX"} · v{storeDetailItem.version || "0.0.0"} · 更新：{formatDateText(storeDetailItem.updatedAt)}
                      </DialogDescription>
                    </div>
                  </div>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
                    <div
                      className="prose prose-sm max-w-none text-sm leading-7 text-muted-foreground dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-code:rounded prose-code:bg-background/70 prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-strong:text-foreground"
                      dangerouslySetInnerHTML={renderPluginPageHtml(buildStoreDetailMarkdown(storeDetailItem), "markdown")}
                    />
                  </div>
                  {Array.isArray(storeDetailItem.tags) && storeDetailItem.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {storeDetailItem.tags.map((tag: string) => (
                        <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {storeDetailItem.repository && (
                    <a
                      href={storeDetailItem.repository}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <Github className="h-4 w-4" />
                      {storeDetailItem.repository}
                    </a>
                  )}
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={() => setStoreDetailItem(null)}>
                    关闭
                  </Button>
                  <Button
                    className="gap-2"
                    onClick={() => installFromStore.mutate({ id: storeDetailItem.id })}
                    disabled={installFromStore.isPending}
                  >
                    {installFromStore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {installedIds.has(storeDetailItem.id) ? "重新安装" : "安装插件"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

        {activeSection === "manage" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.2fr)]">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Puzzle className="h-4 w-4 text-primary" />
                已安装插件
              </CardTitle>
              <CardDescription>{plugins.length} 个插件</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pluginsLoading ? (
                <DataSectionLoading label="正在加载插件" minHeight="min-h-[160px]" />
              ) : plugins.length ? (
                plugins.map((plugin: PluginRow) => {
                  const active = selectedPlugin?.pluginId === plugin.pluginId;
                  return (
                    <button
                      key={plugin.pluginId}
                      type="button"
                      onClick={() => setSelectedPluginId(plugin.pluginId)}
                      className={cn(
                        "w-full rounded-xl border p-4 text-left transition-colors",
                        active ? "border-primary/40 bg-primary/5" : "border-border/40 bg-muted/20 hover:bg-muted/35",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate font-medium">{plugin.name || plugin.pluginId}</p>
                            <Badge variant="outline" className={pluginStatusClass(plugin.status)}>
                              {pluginStatusLabel(plugin.status)}
                            </Badge>
                          </div>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{plugin.description || plugin.pluginId}</p>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>v{plugin.version}</span>
                            <span>{pluginSourceLabel(plugin.sourceType)}</span>
                            <span>{formatTime(plugin.updatedAt)}</span>
                          </div>
                        </div>
                        {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  还没有安装插件
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            {selectedPlugin ? (
              <>
                <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <PluginLogo logo={selectedManifest.logo} name={selectedPlugin.name} />
                    <div className="min-w-0 space-y-1.5">
                      <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        <Boxes className="h-4 w-4 text-primary" />
                        {selectedPlugin.name}
                        <Badge variant="outline" className={pluginStatusClass(selectedPlugin.status)}>
                          {pluginStatusLabel(selectedPlugin.status)}
                        </Badge>
                      </CardTitle>
                      <CardDescription>{selectedPlugin.description || selectedPlugin.pluginId}</CardDescription>
                      <p className="text-xs text-muted-foreground">
                        开发者：{selectedManifest.author || selectedPlugin.author || "未知"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      disabled={isBusy}
                      onClick={() => setEnabledMutation.mutate({
                        pluginId: selectedPlugin.pluginId,
                        enabled: selectedPlugin.status !== "enabled",
                      })}
                    >
                      {selectedPlugin.status === "enabled" ? "停用" : "启用"}
                    </Button>
                    {selectedPlugin.sourceType === "github" && (
                      <>
                        <Button variant="outline" size="sm" className="gap-2" disabled={isBusy} onClick={() => checkUpdateMutation.mutate({ pluginId: selectedPlugin.pluginId })}>
                          <RefreshCw className={cn("h-4 w-4", checkUpdateMutation.isPending && "animate-spin")} />
                          检查
                        </Button>
                        <Button variant="outline" size="sm" className="gap-2" disabled={isBusy} onClick={() => updateFromGithubMutation.mutate({ pluginId: selectedPlugin.pluginId })}>
                          <Download className="h-4 w-4" />
                          更新
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" className="gap-2 text-destructive hover:text-destructive" disabled={isBusy} onClick={() => handleUninstall(selectedPlugin)}>
                      <Trash2 className="h-4 w-4" />
                      卸载
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="overview" className="space-y-4">
                    <TabsList className="grid w-full grid-cols-5">
                      <TabsTrigger value="overview">概览</TabsTrigger>
                      <TabsTrigger value="settings">设置</TabsTrigger>
                      <TabsTrigger value="pages">页面</TabsTrigger>
                      <TabsTrigger value="assets">资产</TabsTrigger>
                      <TabsTrigger value="actions">动作</TabsTrigger>
                    </TabsList>

                    <TabsContent value="overview" className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">插件 ID</p>
                          <p className="mt-1 truncate font-mono text-sm">{selectedPlugin.pluginId}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">版本</p>
                          <p className="mt-1 font-mono text-sm">v{selectedPlugin.version}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">来源</p>
                          <p className="mt-1 text-sm">{pluginSourceLabel(selectedPlugin.sourceType)}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">发布日期</p>
                          <p className="mt-1 text-sm">{formatDateText(selectedManifest.releaseDate)}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">更新日期</p>
                          <p className="mt-1 text-sm">{formatDateText(selectedManifest.updatedAt || selectedPlugin.updatedAt)}</p>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-xs text-muted-foreground">许可</p>
                          <p className="mt-1 text-sm">{selectedManifest.license || "-"}</p>
                        </div>
                      </div>
                      {Array.isArray(selectedManifest.features) && selectedManifest.features.length > 0 && (
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-sm font-medium">功能介绍</p>
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {selectedManifest.features.map((feature: any) => (
                              <div key={feature.title} className="rounded-lg border border-border/40 bg-background/60 p-3">
                                <p className="text-sm font-medium">{feature.title}</p>
                                {feature.description && <p className="mt-1 text-xs text-muted-foreground">{feature.description}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {Array.isArray(selectedManifest.tags) && selectedManifest.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedManifest.tags.map((tag: string) => (
                            <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {selectedManifest.changelog && (
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-sm font-medium">更新说明</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{selectedManifest.changelog}</p>
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-sm font-medium">权限</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(selectedPlugin.permissions || []).length
                              ? selectedPlugin.permissions.map((item: string) => <Badge key={item} variant="outline">{item}</Badge>)
                              : <span className="text-xs text-muted-foreground">无</span>}
                          </div>
                        </div>
                        <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                          <p className="text-sm font-medium">扩展点</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(selectedPlugin.extensionPoints || []).length
                              ? selectedPlugin.extensionPoints.map((item: string) => <Badge key={item} variant="outline">{item}</Badge>)
                              : <span className="text-xs text-muted-foreground">无</span>}
                          </div>
                        </div>
                      </div>
                      {selectedPlugin.repository && (
                        <Button variant="outline" asChild className="gap-2">
                          <a href={selectedPlugin.repository} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-4 w-4" />
                            打开仓库
                          </a>
                        </Button>
                      )}
                    </TabsContent>

                    <TabsContent value="settings" className="space-y-4">
                      {settingFields.length ? (
                        <>
                          <div className="grid gap-4 lg:grid-cols-2">
                            {settingFields.map((field) => (
                              <PluginSettingInput
                                key={field.key}
                                field={field}
                                value={settingDraft[field.key]}
                                disabled={saveSettingMutation.isPending}
                                onChange={(value) => setSettingDraft((current) => ({ ...current, [field.key]: value }))}
                              />
                            ))}
                          </div>
                          <div className="flex justify-end">
                            <Button className="gap-2" onClick={handleSaveSettings} disabled={saveSettingMutation.isPending}>
                              {saveSettingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Settings2 className="h-4 w-4" />}
                              保存设置
                            </Button>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                          这个插件没有设置项
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="pages" className="space-y-4">
                      {pluginPages.length ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            {pluginPages.map((page: any) => (
                              <Button
                                key={page.id}
                                variant={(selectedPage?.id || "") === page.id ? "default" : "outline"}
                                size="sm"
                                onClick={() => setActivePageId(page.id)}
                              >
                                {page.title}
                              </Button>
                            ))}
                          </div>
                          <div className="rounded-lg border border-border/40 bg-background/60 p-4">
                            <div className="mb-3">
                              <p className="font-medium">{selectedPage?.title}</p>
                              {selectedPage?.description && <p className="text-xs text-muted-foreground">{selectedPage.description}</p>}
                            </div>
                            <div
                              className="prose prose-sm max-w-none text-sm leading-6 dark:prose-invert"
                              dangerouslySetInnerHTML={renderPluginPageHtml(selectedPageContent, selectedPage?.contentType)}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                          这个插件没有页面
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="assets" className="space-y-4">
                      {assetsLoading ? (
                        <DataSectionLoading label="正在加载资产" minHeight="min-h-[160px]" />
                      ) : assets.length ? (
                        <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
                          <div className="space-y-2">
                            {assets.map((asset: any) => (
                              <button
                                key={asset.path}
                                type="button"
                                onClick={() => setActiveAssetPath(asset.path)}
                                className={cn(
                                  "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                                  (selectedAsset?.path || "") === asset.path
                                    ? "border-primary/40 bg-primary/5 text-primary"
                                    : "border-border/40 bg-muted/20 hover:bg-muted/35",
                                )}
                              >
                                <p className="truncate font-medium">{asset.path}</p>
                                <p className="text-xs text-muted-foreground">{formatBytes(asset.size)}</p>
                              </button>
                            ))}
                          </div>
                          <div className="min-w-0 rounded-lg border border-border/40 bg-muted/20 p-3">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="truncate font-mono text-sm">{selectedAsset?.path}</p>
                              <div className="flex shrink-0 items-center gap-2">
                                <Badge variant="outline">{formatBytes(selectedAsset?.size || 0)}</Badge>
                                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => handleDownloadAsset(selectedAsset)}>
                                  <Download className="h-3.5 w-3.5" />
                                  下载
                                </Button>
                              </div>
                            </div>
                            <pre className="max-h-96 overflow-auto rounded-md bg-background/80 p-3 text-xs leading-5">
                              {selectedAsset?.content || ""}
                            </pre>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                          这个插件没有资产
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="actions" className="space-y-3">
                      {managementPluginActions.length ? (
                        managementPluginActions.map((action: any) => (
                          <div key={action.id} className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{action.label}</p>
                              {action.description && <p className="text-xs text-muted-foreground">{action.description}</p>}
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <Badge variant="outline" className="font-mono text-[10px]">{action.type}</Badge>
                                {Array.isArray(action.inputSchema) && action.inputSchema.length > 0 && (
                                  <Badge variant="outline" className="text-[10px]">需要输入 {action.inputSchema.length} 项</Badge>
                                )}
                              </div>
                            </div>
                            <Button
                              className="gap-2"
                              variant="outline"
                              disabled={selectedPlugin.status !== "enabled" || runActionMutation.isPending}
                              onClick={() => handleRunAction(action)}
                            >
                              {runActionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                              执行
                            </Button>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                          这个插件没有动作
                        </div>
                      )}
                      {actionResult && (
                        <div className="rounded-lg border border-border/40 bg-background/80 p-3">
                          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{actionResultTitle(actionResult)}</p>
                              {actionResult?.result?.url && (
                                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{actionResult.result.url}</p>
                              )}
                            </div>
                            <Button type="button" variant="ghost" size="sm" className="h-8 self-start sm:self-auto" onClick={() => {
                              setActionResult(null);
                              setAgentActionGroupId("");
                            }}>
                              清除
                            </Button>
                          </div>
                          {actionResult?.result?.parseError && (
                            <p className="mb-2 text-xs text-amber-600 dark:text-amber-300">JSON 解析失败：{actionResult.result.parseError}</p>
                          )}
                          {actionResultDisplayBody(actionResult) ? (
                            <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-5">
                              {actionResultDisplayBody(actionResult)}
                            </pre>
                          ) : (
                            <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">没有响应内容</p>
                          )}
                        </div>
                      )}
                      {selectedPlugin.status !== "enabled" && managementPluginActions.length > 0 && (
                        <Alert className="border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>插件未启用</AlertTitle>
                          <AlertDescription>启用后可以执行插件动作。</AlertDescription>
                        </Alert>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </>
            ) : (
              <CardHeader>
                <CardTitle>选择插件</CardTitle>
                <CardDescription>安装或选择一个插件后可查看详情。</CardDescription>
              </CardHeader>
            )}
          </Card>
        </div>
        )}
      </div>
      <Dialog
        open={!!actionInputDialog}
        onOpenChange={(open) => {
          if (runActionMutation.isPending) return;
          if (!open) {
            setActionInputDialog(null);
            setActionInputDraft({});
          }
        }}
      >
        <DialogContent className="flex max-h-[calc(100svh-1.5rem)] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="px-4 pt-4 sm:px-6 sm:pt-6">
            <DialogTitle>{actionInputDialog?.label || "执行插件动作"}</DialogTitle>
            {actionInputDialog?.description && (
              <DialogDescription>{actionInputDialog.description}</DialogDescription>
            )}
          </DialogHeader>
          <div className="grid gap-4 overflow-y-auto px-4 py-2 sm:grid-cols-2 sm:px-6">
            {(Array.isArray(actionInputDialog?.inputSchema) ? actionInputDialog.inputSchema as PluginSettingField[] : []).map((field) => (
              <div key={field.key} className={field.type === "textarea" || field.type === "boolean" ? "sm:col-span-2" : ""}>
                <PluginSettingInput
                  field={field}
                  value={actionInputDraft[field.key]}
                  disabled={runActionMutation.isPending}
                  onChange={(value) => setActionInputDraft((current) => ({ ...current, [field.key]: value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2 border-t border-border/40 px-4 py-3 sm:px-6">
            <Button
              type="button"
              variant="outline"
              disabled={runActionMutation.isPending}
              onClick={() => {
                setActionInputDialog(null);
                setActionInputDraft({});
              }}
            >
              取消
            </Button>
            <Button type="button" className="gap-2" disabled={runActionMutation.isPending} onClick={handleSubmitActionInput}>
              {runActionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

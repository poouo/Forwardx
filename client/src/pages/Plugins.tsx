import { useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  FileCode2,
  Github,
  Loader2,
  PackagePlus,
  Play,
  Puzzle,
  RefreshCw,
  Server,
  Settings2,
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
  note: string;
};

const pluginHostAssetSyncMaxBytes = 1024 * 1024;

const defaultPluginUsage: PluginUsageDraft = {
  enabled: false,
  hostIds: [],
  assetPaths: [],
  note: "",
};

const defaultUploadExample = `{
  "manifest": {
    "id": "demo-tools",
    "name": "演示插件",
    "version": "0.1.0",
    "description": "一个声明式插件示例",
    "author": "ForwardX",
    "updatedAt": "2026-07-09",
    "features": [
      { "title": "说明页", "description": "在插件详情内展示 Markdown 页面。" },
      { "title": "设置项", "description": "提供可保存的插件配置。" }
    ],
    "tags": ["demo", "page"],
    "changelog": "初始演示版本。",
    "permissions": ["ui:page"],
    "extensionPoints": ["sidebar.page"],
    "settingsSchema": [
      {
        "key": "title",
        "label": "展示标题",
        "type": "text",
        "defaultValue": "Hello ForwardX"
      }
    ],
    "pages": [
      {
        "id": "home",
        "title": "说明页",
        "contentType": "markdown",
        "assetPath": "README.md"
      }
    ],
    "actions": [
      {
        "id": "ping",
        "label": "运行测试动作",
        "type": "noop"
      }
    ]
  },
  "assets": {
    "README.md": "# 演示插件\\n这是一个不会执行脚本的插件页面。"
  }
}`;

function pluginStatusLabel(status?: string) {
  if (status === "enabled") return "已启用";
  if (status === "error") return "异常";
  return "未启用";
}

function pluginStatusClass(status?: string) {
  if (status === "enabled") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "error") return "border-destructive/25 bg-destructive/10 text-destructive";
  return "border-border/60 bg-muted/30 text-muted-foreground";
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

function renderPluginPageHtml(content: string, type?: string) {
  if (type === "text") return { __html: textToHtml(content || "") };
  return { __html: renderMixedHtml(content || "") };
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
  const [githubRepository, setGithubRepository] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubManifestPath, setGithubManifestPath] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadEncoding, setUploadEncoding] = useState<"text" | "base64">("text");
  const [settingDraft, setSettingDraft] = useState<Record<string, unknown>>({});
  const [usageDraft, setUsageDraft] = useState<PluginUsageDraft>(defaultPluginUsage);
  const [activePageId, setActivePageId] = useState("");
  const [activeAssetPath, setActiveAssetPath] = useState("");

  const selectedPlugin = useMemo(
    () => plugins.find((plugin: PluginRow) => plugin.pluginId === selectedPluginId) || plugins[0],
    [plugins, selectedPluginId],
  );
  const selectedManifest = getPluginManifest(selectedPlugin);
  const settingFields = (selectedManifest.settingsSchema || []) as PluginSettingField[];
  const pluginPages = Array.isArray(selectedManifest.pages) ? selectedManifest.pages : [];
  const pluginActions = Array.isArray(selectedManifest.actions) ? selectedManifest.actions : [];
  const pluginUsageViews = Array.isArray(selectedManifest.usageViews) ? selectedManifest.usageViews : [];
  const hostAssetSyncUsageView = pluginUsageViews.find((view: any) => view?.type === "host-asset-sync");
  const hasUsageView = !!hostAssetSyncUsageView;

  const { data: assets = [], isLoading: assetsLoading } = trpc.plugins.assets.useQuery(
    { pluginId: selectedPlugin?.pluginId || "" },
    { enabled: !!selectedPlugin?.pluginId },
  );
  const { data: pluginUsage, isLoading: pluginUsageLoading } = trpc.plugins.usage.useQuery(
    { pluginId: selectedPlugin?.pluginId || "", usageViewId: hostAssetSyncUsageView?.id },
    { enabled: !!selectedPlugin?.pluginId && hasUsageView },
  );

  const selectedAsset = assets.find((asset: any) => asset.path === activeAssetPath) || assets[0];
  const selectedPage = pluginPages.find((page: any) => page.id === activePageId) || pluginPages[0];
  const selectedPageAsset = selectedPage?.assetPath
    ? assets.find((asset: any) => asset.path === selectedPage.assetPath)
    : null;
  const selectedPageContent = selectedPageAsset?.content || selectedPage?.content || "";

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
      setUploadEncoding("text");
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
      await invalidatePluginQueries();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });

  const runActionMutation = trpc.plugins.runAction.useMutation({
    onSuccess: (result: any) => {
      toast.success(result?.message || "动作已执行");
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
  }, [selectedPlugin?.pluginId, selectedPlugin?.manifestJson]);

  useEffect(() => {
    if (!hasUsageView) {
      setUsageDraft(defaultPluginUsage);
      return;
    }
    const usage = (pluginUsage as any)?.usage;
    setUsageDraft({
      enabled: !!usage?.enabled,
      hostIds: Array.isArray(usage?.hostIds) ? usage.hostIds.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0) : [],
      assetPaths: Array.isArray(usage?.assetPaths) ? usage.assetPaths.map((item: unknown) => String(item || "")).filter(Boolean) : [],
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
      toast.error("请粘贴或选择插件包");
      return;
    }
    installFromUpload.mutate({
      content,
      fileName: uploadFileName || undefined,
      encoding: uploadEncoding,
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
    if (file.size > (isArchive ? 5 * 1024 * 1024 : 1024 * 1024)) {
      toast.error(isArchive ? "插件压缩包不能超过 5MB" : "插件 JSON 不能超过 1MB");
      return;
    }
    setUploadFileName(file.name);
    if (isArchive) {
      setUploadEncoding("base64");
      setUploadContent(await fileToBase64(file));
      toast.success("插件压缩包已读取");
      return;
    }
    setUploadEncoding("text");
    setUploadContent(await file.text());
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
    if (usageDraft.enabled && usageDraft.assetPaths.length === 0) {
      toast.error("请选择至少一个白名单文件");
      return;
    }
    if (usageDraft.enabled && selectedUsageAssetsSize > pluginHostAssetSyncMaxBytes) {
      toast.error(`同步文件总大小不能超过 ${formatBytes(pluginHostAssetSyncMaxBytes)}`);
      return;
    }
    saveUsageMutation.mutate({
      pluginId: selectedPlugin.pluginId,
      usageViewId: hostAssetSyncUsageView.id,
      enabled: usageDraft.enabled,
      hostIds: usageDraft.hostIds,
      assetPaths: usageDraft.assetPaths,
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

  const handleRunAction = async (action: any) => {
    if (!selectedPlugin) return;
    if (action.confirmRequired) {
      const confirmed = await confirmDialog({
        title: action.label || "执行动作",
        description: action.description || "确定执行该插件动作？",
        confirmText: "执行",
      });
      if (!confirmed) return;
    }
    runActionMutation.mutate({ pluginId: selectedPlugin.pluginId, actionId: action.id });
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
  const usageSizeExceeded = selectedUsageAssetsSize > pluginHostAssetSyncMaxBytes;

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">插件</h1>
            <p className="text-sm text-muted-foreground">安装、更新和调试插件能力。</p>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PackagePlus className="h-4 w-4 text-primary" />
                插件商店
              </CardTitle>
              <CardDescription>从 GitHub 获取，一键安装。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {storeLoading ? (
                <DataSectionLoading label="正在加载商店" minHeight="min-h-[120px]" />
              ) : storeItems.length ? (
                storeItems.map((item: any) => {
                  const installed = installedIds.has(item.id);
                  return (
                    <div key={item.id} className="rounded-xl border border-border/40 bg-muted/20 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 gap-3">
                          <PluginLogo logo={item.logo} name={item.name} />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{item.name}</p>
                              {item.official && <Badge className="bg-primary text-primary-foreground">官方</Badge>}
                              <Badge variant="outline">{item.category}</Badge>
                              {installed && <Badge className="bg-emerald-500 text-white">已安装</Badge>}
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              开发者：{item.author || "ForwardX"} · v{item.version || "0.0.0"} · 更新：{formatDateText(item.updatedAt)}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                            {Array.isArray(item.features) && item.features.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.features.slice(0, 3).map((feature: any) => (
                                  <Badge key={feature.title} variant="outline" className="bg-background/60">
                                    {feature.title}
                                  </Badge>
                                ))}
                              </div>
                            )}
                            {Array.isArray(item.tags) && item.tags.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.tags.slice(0, 5).map((tag: string) => (
                                  <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                    #{tag}
                                  </span>
                                ))}
                              </div>
                            )}
                            <a
                              href={item.repository}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Github className="h-3.5 w-3.5" />
                              {item.repository}
                            </a>
                          </div>
                        </div>
                        <Button
                          className="w-full gap-2 sm:w-auto"
                          variant={installed ? "outline" : "default"}
                          onClick={() => installFromStore.mutate({ id: item.id })}
                          disabled={installFromStore.isPending}
                        >
                          {installFromStore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          {installed ? "重新安装" : "安装"}
                        </Button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  暂无商店插件
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="h-4 w-4 text-primary" />
                自定义安装
              </CardTitle>
              <CardDescription>支持 GitHub 仓库或 JSON 插件包。</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="github" className="space-y-4">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="github">GitHub</TabsTrigger>
                  <TabsTrigger value="upload">上传</TabsTrigger>
                </TabsList>
                <TabsContent value="github" className="space-y-3">
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
                <TabsContent value="upload" className="space-y-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json,.zip,.tar.gz,.tgz,application/zip,application/gzip"
                    className="hidden"
                    onChange={(event) => handleFileSelect(event.target.files?.[0])}
                  />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button variant="outline" className="gap-2" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="h-4 w-4" />
                      选择插件包
                    </Button>
                    <Button
                      variant="ghost"
                      className="gap-2"
                      onClick={() => {
                        setUploadEncoding("text");
                        setUploadFileName("");
                        setUploadContent(defaultUploadExample);
                      }}
                    >
                      <FileCode2 className="h-4 w-4" />
                      填入示例
                    </Button>
                  </div>
                  {uploadFileName && (
                    <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      已选择：{uploadFileName}
                    </div>
                  )}
                  <Textarea
                    value={uploadContent}
                    onChange={(event) => {
                      setUploadEncoding("text");
                      setUploadFileName("");
                      setUploadContent(event.target.value);
                    }}
                    placeholder="粘贴插件 JSON，或选择 .zip/.tar.gz 插件包"
                    className="min-h-56 font-mono text-xs leading-5"
                  />
                  <Button className="w-full gap-2" onClick={handleUploadInstall} disabled={installFromUpload.isPending}>
                    {installFromUpload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    上传安装
                  </Button>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

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
                    <TabsList className={cn("grid w-full", hasUsageView ? "grid-cols-6" : "grid-cols-5")}>
                      <TabsTrigger value="overview">概览</TabsTrigger>
                      {hasUsageView && <TabsTrigger value="usage">使用</TabsTrigger>}
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

                    {hasUsageView && (
                      <TabsContent value="usage" className="space-y-4">
                        {pluginUsageLoading ? (
                          <DataSectionLoading label="正在加载使用配置" minHeight="min-h-[220px]" />
                        ) : (
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

                            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
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

                              <div className="space-y-3 rounded-xl border border-border/40 bg-muted/20 p-4">
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
                              </div>
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
                        )}
                      </TabsContent>
                    )}

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
                      {pluginActions.length ? (
                        pluginActions.map((action: any) => (
                          <div key={action.id} className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{action.label}</p>
                              {action.description && <p className="text-xs text-muted-foreground">{action.description}</p>}
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
                      {selectedPlugin.status !== "enabled" && pluginActions.length > 0 && (
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
      </div>
    </DashboardLayout>
  );
}

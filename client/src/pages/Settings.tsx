import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { EmailSettingsContent } from "./EmailSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SlidingTabsList } from "@/components/ui/sliding-tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { pollingInterval } from "@/lib/polling";
import { trpc } from "@/lib/trpc";
import { getPanelChangelogUrl, PANEL_UPGRADE_REFRESH_DELAY_SECONDS } from "@/lib/panelUpgrade";
import { compressImageFile, imageDataUrlSize } from "@/lib/imageUpload";
import { applyPersonalizationTheme } from "@/lib/personalizationTheme";
import { cn } from "@/lib/utils";
import {
  FORWARD_PROTOCOL_LABELS,
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardProtocolSettings,
  type ForwardProtocolSettings,
} from "@shared/forwardTypes";
import {
  SIDEBAR_MENU_KEYS,
  SIDEBAR_MENU_LABELS,
  normalizeSidebarMenuSettings,
  type SidebarMenuKey,
  type SidebarMenuSettings,
} from "@shared/sidebarMenu";
import {
  Trash2,
  Key,
  Copy,
  CheckCircle2,
  Settings2,
  Download,
  Github,
  Mail,
  Send,
  Globe,
  ShieldCheck,
  Shield,
  ExternalLink,
  RefreshCw,
  Rocket,
  AlertTriangle,
  FileText,
  Eye,
  Cloud,
  UserPlus,
  Wifi,
  Database,
  Upload,
  Lock,
  MoveRight,
  Loader2,
  Palette,
  Image as ImageIcon,
  Monitor,
  PanelLeft,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useMemo, useRef, useState, useEffect } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { BRAND_LOGO_MAX_BYTES } from "@shared/avatar";
import {
  BUILTIN_WALLPAPERS,
  DEFAULT_PERSONALIZATION_BACKGROUND,
  PERSONALIZATION_THEME_PRESETS,
  clampBackgroundBlur,
  clampBackgroundOpacity,
  getPersonalizationThemePreset,
  normalizePersonalizationThemePresetId,
  type PersonalizationBackgroundConfig,
  type PersonalizationThemePresetId,
  type PersonalizationBackgroundImage,
  type PersonalizationBackgroundUrlType,
} from "@shared/personalization";

function getUpgradeProgress(job: any) {
  const status = job?.status || "idle";
  const isRollback = job?.mode === "rollback";
  const actionLabel = isRollback ? "回退" : "升级";
  const logs = Array.isArray(job?.logs) ? job.logs.join("\n") : "";
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const steps = [
    {
      label: `准备${actionLabel}`,
      done: status !== "idle" && matched([/开始升级/i, /开始回退/i, /Starting panel/i, /start/i]),
    },
    {
      label: "检查发布资产",
      done: matched([
        /Release assets/i,
        /not available yet/i,
        /still building/i,
        /发布资产/i,
        /构建完成/i,
        /Docker image/i,
        /panel bundle/i,
      ]),
    },
    {
      label: "下载或拉取资产",
      done: matched([
        /Downloading panel bundle/i,
        /Pulling image/i,
        /Downloaded newer image/i,
        /Image is up to date/i,
        /load metadata/i,
        /load build context/i,
        /transferring context/i,
        /pnpm install/i,
        /npm install/i,
        /Packages:/i,
        /node_modules/i,
        /downloaded/i,
        /Lockfile is up to date/i,
      ]),
    },
    {
      label: "安装并重启",
      done: matched([/Container .* (Creating|Created|Starting|Started)/i, /docker compose up/i, /systemctl restart/i, /已启动/i, /recreate/i]),
    },
  ];

  if (status === "success") {
    return { percent: 100, label: `${actionLabel}完成`, steps: steps.map((step) => ({ ...step, done: true, active: false })) };
  }
  if (status === "waiting_assets") {
    return { percent: 34, label: "等待 GitHub Actions 构建发布资产", steps: steps.map((step, index) => ({ ...step, done: index === 0, active: index === 1 })) };
  }
  if (status === "error") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    return { percent: Math.max(10, doneCount * 22), label: `${actionLabel}异常`, steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  if (status === "running") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    const activeStep = steps[activeIndex]?.label || "等待服务重启";
    return { percent: Math.min(92, Math.max(12, doneCount * 22 + 8)), label: activeStep, steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  return { percent: 0, label: `等待${actionLabel}`, steps: steps.map((step) => ({ ...step, active: false })) };
}

const panelLocalScriptUrl = "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh";
const panelDockerScriptUrl = "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh";
const panelLocalUpgradeCommand = `curl -fsSL ${panelLocalScriptUrl} | sudo bash -s -- upgrade`;
const panelDockerUpgradeCommand = `curl -fsSL ${panelDockerScriptUrl} | sudo bash -s -- upgrade`;
const defaultGithubAcceleratorUrl = "https://git.poouo.com";
type AiProvider = "deepseek" | "siliconflow" | "custom";
const aiProviderOptions: Array<{ value: AiProvider; label: string }> = [
  { value: "deepseek", label: "DeepSeek" },
  { value: "siliconflow", label: "SiliconFlow（聚合平台）" },
  { value: "custom", label: "自定义 OpenAI 兼容" },
];
const aiProviderDefaults: Record<AiProvider, { baseUrl: string; model: string }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
  },
  custom: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
};
type AiProviderServerConfig = {
  provider?: AiProvider;
  configured?: boolean;
  apiKeyMasked?: string;
  baseUrl?: string;
  model?: string;
};
type AiProviderLocalConfig = {
  configured: boolean;
  apiKeyMasked: string;
  apiKeyInput: string;
  baseUrl: string;
  model: string;
};
type AiProviderLocalConfigMap = Record<AiProvider, AiProviderLocalConfig>;

function createDefaultAiProviderConfig(provider: AiProvider): AiProviderLocalConfig {
  return {
    configured: false,
    apiKeyMasked: "",
    apiKeyInput: "",
    baseUrl: aiProviderDefaults[provider].baseUrl,
    model: aiProviderDefaults[provider].model,
  };
}

function createDefaultAiProviderConfigMap(): AiProviderLocalConfigMap {
  return {
    deepseek: createDefaultAiProviderConfig("deepseek"),
    siliconflow: createDefaultAiProviderConfig("siliconflow"),
    custom: createDefaultAiProviderConfig("custom"),
  };
}

function normalizeAiProviderValue(value: unknown): AiProvider {
  const raw = String(value || "").trim();
  return aiProviderOptions.some((item) => item.value === raw)
    ? (raw as AiProvider)
    : "deepseek";
}

function toLocalAiProviderConfig(provider: AiProvider, source?: AiProviderServerConfig): AiProviderLocalConfig {
  return {
    configured: !!source?.configured,
    apiKeyMasked: String(source?.apiKeyMasked || ""),
    apiKeyInput: "",
    baseUrl: String(source?.baseUrl || "").trim() || aiProviderDefaults[provider].baseUrl,
    model: String(source?.model || "").trim() || aiProviderDefaults[provider].model,
  };
}
type DdnsProvider = "disabled" | "cloudflare" | "webhook" | "huaweicloud" | "aliyun" | "tencentcloud";
const ddnsProviders: DdnsProvider[] = ["disabled", "cloudflare", "webhook", "huaweicloud", "aliyun", "tencentcloud"];
const docsBaseUrl = "https://poouo.github.io/Forwardx";
const ddnsProviderGuideAnchors: Record<DdnsProvider, string> = {
  disabled: "quick-setup",
  cloudflare: "cloudflare",
  webhook: "webhook",
  huaweicloud: "huaweicloud",
  aliyun: "aliyun",
  tencentcloud: "tencentcloud",
};

function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isDdnsProvider(value: unknown): value is DdnsProvider {
  return ddnsProviders.includes(value as DdnsProvider);
}

function ddnsProviderGuideUrl(provider: DdnsProvider) {
  return `${docsBaseUrl}/guide/ddns#${ddnsProviderGuideAnchors[provider] || "quick-setup"}`;
}

const manualPanelUpgradeCommands = [
  {
    label: "本地部署",
    command: panelLocalUpgradeCommand,
  },
  {
    label: "Docker 部署",
    command: panelDockerUpgradeCommand,
  },
];

function panelVersionCommand(command: string, targetVersion: string) {
  const target = String(targetVersion || "").trim().replace(/^v/i, "");
  if (!target) return command;
  const env = `FORWARDX_TARGET_VERSION=${target}`;
  return command
    .replace(/\|\s*sudo\s+bash\s+-s\s+--\s+upgrade/g, `| sudo env ${env} bash -s -- upgrade`)
    .replace(/\|\s*bash\s+-s\s+--\s+upgrade/g, `| env ${env} bash -s -- upgrade`)
    .replace(/^\/bin\/bash\s+/i, `${env} /bin/bash `);
}

const directForwardProtocolKeys = [...FORWARD_TYPES] as const;
const tunnelForwardProtocolKeys = TUNNEL_PROTOCOLS.filter((key) => key !== "nginx_tls");
const LOG_PAGE_SIZE = 200;
type PanelLogLevel = "all" | "info" | "warn" | "error" | "log";
type PanelLogSummary = Record<PanelLogLevel, number>;
const EMPTY_PANEL_LOG_SUMMARY: PanelLogSummary = { all: 0, info: 0, warn: 0, error: 0, log: 0 };

function normalizePanelLogSummary(summary?: Partial<PanelLogSummary> | null): PanelLogSummary {
  return {
    all: Number(summary?.all) || 0,
    info: Number(summary?.info) || 0,
    warn: Number(summary?.warn) || 0,
    error: Number(summary?.error) || 0,
    log: Number(summary?.log) || 0,
  };
}

function createDefaultHomepageHtml(themeId: PersonalizationThemePresetId) {
  const theme = getPersonalizationThemePreset(themeId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ForwardX</title>
  <style>
    :root {
      --fx-primary: ${theme.light.primary};
      --fx-primary-foreground: ${theme.light.primaryForeground};
      --fx-ring: ${theme.light.ring};
      --fx-chart-1: ${theme.light.chart1};
      --fx-chart-2: ${theme.light.chart2};
      --fx-chart-3: ${theme.light.chart3};
      --fx-chart-4: ${theme.light.chart4};
      --fx-bg: #f8fafc;
      --fx-ink: #0f172a;
      --fx-muted: #475569;
      --fx-border: rgba(15, 23, 42, .10);
      --fx-card: rgba(255, 255, 255, .76);
      --fx-card-soft: rgba(248, 250, 252, .72);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --fx-primary: ${theme.dark.primary};
        --fx-primary-foreground: ${theme.dark.primaryForeground};
        --fx-ring: ${theme.dark.ring};
        --fx-chart-1: ${theme.dark.chart1};
        --fx-chart-2: ${theme.dark.chart2};
        --fx-chart-3: ${theme.dark.chart3};
        --fx-chart-4: ${theme.dark.chart4};
        --fx-bg: #0b1020;
        --fx-ink: #f8fafc;
        --fx-muted: #a8b3c7;
        --fx-border: rgba(226, 232, 240, .14);
        --fx-card: rgba(15, 23, 42, .72);
        --fx-card-soft: rgba(15, 23, 42, .56);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--fx-ink);
      background:
        radial-gradient(circle at 16% -10%, color-mix(in oklch, var(--fx-chart-1) 20%, transparent) 0, transparent 34rem),
        radial-gradient(circle at 92% 0%, color-mix(in oklch, var(--fx-chart-2) 16%, transparent) 0, transparent 30rem),
        linear-gradient(135deg, color-mix(in oklch, var(--fx-bg) 94%, white 6%) 0%, var(--fx-bg) 52%, color-mix(in oklch, var(--fx-bg) 88%, var(--fx-chart-4) 12%) 100%);
    }
    .page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
    }
    .hero {
      width: min(1080px, 100%);
      display: grid;
      grid-template-columns: 1.1fr .9fr;
      gap: 36px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid color-mix(in oklch, var(--fx-primary) 28%, transparent);
      background: var(--fx-card);
      color: var(--fx-primary);
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--fx-primary);
    }
    h1 {
      margin: 18px 0 14px;
      font-size: clamp(42px, 7vw, 76px);
      line-height: .95;
      letter-spacing: 0;
    }
    p {
      max-width: 620px;
      color: var(--fx-muted);
      font-size: 17px;
      line-height: 1.8;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 26px;
    }
    .btn {
      display: inline-flex;
      min-height: 44px;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      padding: 0 18px;
      text-decoration: none;
      font-weight: 700;
    }
    .btn.primary {
      color: var(--fx-primary-foreground);
      background: var(--fx-primary);
      box-shadow: 0 14px 30px color-mix(in oklch, var(--fx-primary) 26%, transparent);
    }
    .btn.secondary {
      color: var(--fx-ink);
      border: 1px solid var(--fx-border);
      background: var(--fx-card);
    }
    .panel {
      border: 1px solid var(--fx-border);
      background: var(--fx-card);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 24px 80px color-mix(in oklch, var(--fx-primary) 14%, transparent);
      backdrop-filter: blur(18px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .item {
      border: 1px solid var(--fx-border);
      border-radius: 12px;
      padding: 16px;
      background: var(--fx-card-soft);
    }
    .item b {
      display: block;
      margin-bottom: 6px;
    }
    .item span {
      color: var(--fx-muted);
      font-size: 13px;
      line-height: 1.6;
    }
    @media (max-width: 820px) {
      .hero { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div>
        <span class="eyebrow"><span class="dot"></span>ForwardX 面板</span>
        <h1>高速稳定的端口转发服务</h1>
        <p>统一管理转发、隧道、套餐、流量和用户权限。</p>
        <div class="actions">
          <a class="btn primary" href="/login">进入面板</a>
          <a class="btn secondary" href="/login?mode=register">创建账号</a>
        </div>
      </div>
      <div class="panel">
        <div class="grid">
          <div class="item"><b>多节点</b><span>统一管理多台 Linux 主机和隧道。</span></div>
          <div class="item"><b>流量统计</b><span>按用户和规则记录转发用量。</span></div>
          <div class="item"><b>套餐订阅</b><span>支持余额、套餐和支付配置。</span></div>
          <div class="item"><b>Telegram</b><span>用户可通过机器人自助查询和管理。</span></div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function formatCountdown(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainSeconds = safeSeconds % 60;
  return `${minutes}:${remainSeconds.toString().padStart(2, "0")}`;
}

function getMigrationCodeCountdown(code: { expiresAt: number } | null, now: number) {
  if (!code) return 0;
  return Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
}

function downloadTextFile(filename: string, content: string, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const settingsTabs = ["system", "telegram", "email", "personalization", "backup", "logs"] as const;
type SettingsTab = typeof settingsTabs[number];
const settingsTabItems = [
  { value: "system", label: "系统配置", icon: Settings2 },
  { value: "telegram", label: "Telegram", icon: Send },
  { value: "email", label: "邮箱设置", icon: Mail },
  { value: "personalization", label: "个性化配置", icon: Palette },
  { value: "backup", label: "备份恢复", icon: Database },
  { value: "logs", label: "面板日志", icon: FileText },
] as const;
type DatabaseType = "sqlite" | "mysql" | "postgresql";
type BackupSummaryCache = {
  userCount: number;
  hostCount: number;
  ruleCount: number;
  tunnelCount: number;
  forwardGroupCount: number;
  hasExistingData: boolean;
  cachedAt?: number;
};
type BackupTaskProgress = {
  percent: number;
  step: string;
  detail: string;
  status: "running" | "success" | "error";
};

const backupSummaryCacheKey = "forwardx.settings.backupSummary";
const zeroBackupSummary: BackupSummaryCache = {
  userCount: 0,
  hostCount: 0,
  ruleCount: 0,
  tunnelCount: 0,
  forwardGroupCount: 0,
  hasExistingData: false,
};
function normalizeBackupSummaryCache(value: any): BackupSummaryCache {
  return {
    userCount: Math.max(0, Number(value?.userCount || 0)),
    hostCount: Math.max(0, Number(value?.hostCount || 0)),
    ruleCount: Math.max(0, Number(value?.ruleCount || 0)),
    tunnelCount: Math.max(0, Number(value?.tunnelCount || 0)),
    forwardGroupCount: Math.max(0, Number(value?.forwardGroupCount || 0)),
    hasExistingData: !!value?.hasExistingData,
    cachedAt: Number(value?.cachedAt || 0) || undefined,
  };
}

function readBackupSummaryCache(): BackupSummaryCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(backupSummaryCacheKey);
    if (!raw) return null;
    return normalizeBackupSummaryCache(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeBackupSummaryCache(summary: BackupSummaryCache) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(backupSummaryCacheKey, JSON.stringify({ ...summary, cachedAt: Date.now() }));
  } catch {
    // Local cache is only a display optimization.
  }
}

function BackupTaskProgressView({ progress }: { progress: BackupTaskProgress | null }) {
  if (!progress) return null;
  return (
    <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          {progress.status === "running"
            ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            : progress.status === "success"
              ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
              : <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />}
          <span className="truncate font-medium">{progress.step}</span>
        </div>
        <span className="shrink-0 tabular-nums">{progress.percent}%</span>
      </div>
      <Progress value={progress.percent} className="mt-3" />
      <p className="mt-2 text-xs text-muted-foreground">{progress.detail}</p>
    </div>
  );
}

function normalizePersonalizationBackgroundConfig(value: any): PersonalizationBackgroundConfig {
  const source = value && typeof value === "object" ? value : {};
  const normalizedSource = source.source === "builtin" || source.source === "upload" || source.source === "url" ? source.source : "none";
  return {
    ...DEFAULT_PERSONALIZATION_BACKGROUND,
    ...source,
    source: normalizedSource,
    opacity: clampBackgroundOpacity(source.opacity),
    blur: clampBackgroundBlur(source.blur),
    selectedId: source.selectedId ? String(source.selectedId) : null,
    url: String(source.url || ""),
    urlType: normalizedSource === "url" && source.urlType === "video" ? "video" : "image",
    images: Array.isArray(source.images) ? source.images : [],
  };
}

function formatBytes(bytes: number) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.max(0, value)} B`;
}

function createLocalId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isSettingsTab(tab: string | null): tab is SettingsTab {
  return !!tab && settingsTabs.includes(tab as SettingsTab);
}

function getSettingsTab(location: string): SettingsTab {
  const query = location.split("?")[1] || "";
  const tab = new URLSearchParams(query).get("tab");
  return isSettingsTab(tab) ? tab : "system";
}

function SettingsContent() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => getSettingsTab(location));

  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/");
    }
  }, [user, setLocation]);

  useEffect(() => {
    setActiveTab(getSettingsTab(location));
  }, [location]);

  const handleTabChange = (tab: string) => {
    if (!isSettingsTab(tab)) return;
    setActiveTab(tab);
    setLocation(tab === "system" ? "/settings" : `/settings?tab=${tab}`);
  };

  // 面板地址统一使用「系统配置」Tab 中配置的 panelPublicUrl；未配置时回退 window.location.origin
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const panelUrl = (systemSettings?.panelPublicUrl && systemSettings.panelPublicUrl.trim())
    || (typeof window !== "undefined" ? window.location.origin : "");

  const copyToClipboard = async (text: string) => {
    // 优先使用 Clipboard API（仅在 https 或 localhost 下可用）
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("已复制到剪贴板");
        return;
      } catch (err) {
        console.warn("[Clipboard] navigator.clipboard 失败，回退 execCommand:", err);
      }
    }

    // Fallback：HTTP / 非安全上下文 / 不支持 Clipboard API
    // 关键修复：Radix Dialog 会抢焦点，必须将 textarea 挂到当前活跃 dialog 内部才能 select 成功。
    let success = false;
    const host =
      (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) ||
      document.body;
    const textarea = document.createElement("textarea");
    try {
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      // 不能 display:none / left:-9999px，iOS 与部分浏览器会跳过选中
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      textarea.style.left = "0";
      textarea.style.top = "0";
      textarea.style.width = "1px";
      textarea.style.height = "1px";
      host.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      success = document.execCommand("copy");
    } catch (err) {
      console.error("[Clipboard] execCommand fallback 异常:", err);
      success = false;
    } finally {
      if (textarea.parentNode) {
        textarea.parentNode.removeChild(textarea);
      }
    }

    if (success) {
      toast.success("已复制到剪贴板");
      return;
    }

    // 最后兑底：弹 prompt 让用户手动 Ctrl+C，避免静默失败
    try {
      window.prompt("复制失败，请手动选中并复制 (Ctrl+C / Cmd+C)：", text);
      toast.warning("未能自动写入剪贴板，已弹出手动复制窗口");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  if (user?.role !== "admin") return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">系统设置</h1>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <SlidingTabsList items={settingsTabItems} activeValue={activeTab} ariaLabel="系统设置" minItemWidthRem={7.5} />

        {/* System Info Tab */}
        <TabsContent value="system" className="space-y-4">
          <SystemInfoSection />
        </TabsContent>

        {/* Telegram Bot Tab */}
        <TabsContent value="telegram" className="space-y-4">
          <TelegramBotSettingsCard />
          <DeepSeekSettingsCard />
        </TabsContent>

        {/* Email Settings Tab */}
        <TabsContent value="email" className="space-y-4">
          <EmailSettingsContent />
        </TabsContent>

        {/* Personalization Tab */}
        <TabsContent value="personalization" className="space-y-4">
          <PersonalizationSettingsSection />
        </TabsContent>

        {/* Backup and Restore Tab */}
        <TabsContent value="backup" className="space-y-4">
          <BackupRestoreSection panelUrl={panelUrl} />
        </TabsContent>

        {/* Panel Logs Tab */}
        <TabsContent value="logs" className="space-y-4">
          <PanelLogsSection />
        </TabsContent>
      </Tabs>

    </div>
  );
}

function PanelLogsSection() {
  const [panelLogLevel, setPanelLogLevel] = useState<PanelLogLevel>("all");
  const [exportLevel, setExportLevel] = useState<PanelLogLevel>("all");
  const [panelLogOffset, setPanelLogOffset] = useState(0);
  const panelLogSummaryRef = useRef<PanelLogSummary>(EMPTY_PANEL_LOG_SUMMARY);
  const { data: panelLogs, isLoading: panelLogsLoading, isFetching: panelLogsFetching, refetch: refetchPanelLogs } = trpc.system.panelLogs.useQuery({
    level: panelLogLevel,
    limit: LOG_PAGE_SIZE,
    offset: panelLogOffset,
  }, {
    placeholderData: (previousData) => previousData,
    refetchInterval: pollingInterval("log"),
  });
  const exportLogsMutation = trpc.system.exportPanelLogs.useMutation({
    onSuccess: (data) => {
      downloadTextFile(data.filename, data.content, data.mimeType || "text/plain;charset=utf-8");
      toast.success(`已导出 ${data.count} 条日志`);
    },
    onError: (err) => toast.error(err.message || "导出日志失败"),
  });
  const clearLogsMutation = trpc.system.clearPanelLogs.useMutation({
    onSuccess: async () => {
      toast.success("日志已清空");
      setPanelLogOffset(0);
      await refetchPanelLogs();
    },
    onError: (err) => toast.error(err.message || "清空日志失败"),
  });
  const logLevelClass = (level: string) => {
    if (level === "error") return "text-destructive";
    if (level === "warn") return "text-amber-600 dark:text-amber-400";
    if (level === "info") return "text-primary";
    return "text-muted-foreground";
  };
  const panelLogEntries = panelLogs?.logs || [];
  const resetPanelLogs = (level: PanelLogLevel) => {
    setPanelLogLevel(level);
    setPanelLogOffset(0);
  };
  const refreshPanelLogs = () => {
    if (panelLogOffset === 0) {
      refetchPanelLogs();
      return;
    }
    setPanelLogOffset(0);
  };
  const panelLogStart = panelLogEntries.length > 0 ? (panelLogs?.offset || 0) + 1 : 0;
  const panelLogEnd = (panelLogs?.offset || 0) + panelLogEntries.length;
  if (panelLogs?.summary) {
    panelLogSummaryRef.current = normalizePanelLogSummary(panelLogs.summary as Partial<PanelLogSummary>);
  }
  const summary = panelLogSummaryRef.current;
  const levelTabs = [
    { value: "all", label: "全部", count: summary.all || 0 },
    { value: "info", label: "Info", count: summary.info || 0 },
    { value: "warn", label: "Warn", count: summary.warn || 0 },
    { value: "error", label: "Error", count: summary.error || 0 },
    { value: "log", label: "Log", count: summary.log || 0 },
  ] as const;
  const logViewportClass = "h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-border/40 bg-muted/20 p-3 font-mono text-xs leading-relaxed";
  const logEmptyClass = "flex h-full items-center justify-center text-muted-foreground";
  return (
    <div className="flex flex-col gap-4">
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="h-4 w-4 text-primary" />
                面板日志
              </CardTitle>
              <CardDescription>最近 24 小时运行日志。</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <Select value={exportLevel} onValueChange={(value) => setExportLevel(value as typeof exportLevel)}>
                  <SelectTrigger className="h-9 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levelTabs.map((tab) => (
                      <SelectItem key={tab.value} value={tab.value}>{tab.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportLogsMutation.mutate({ level: exportLevel })}
                  disabled={exportLogsMutation.isPending}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  导出日志
                </Button>
              </div>
              <Button variant="outline" size="sm" onClick={refreshPanelLogs} disabled={panelLogsFetching}>刷新</Button>
              <Button variant="destructive" size="sm" onClick={() => clearLogsMutation.mutate()} disabled={clearLogsMutation.isPending}>清空日志</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={panelLogLevel} onValueChange={(v) => resetPanelLogs(v as typeof panelLogLevel)} className="space-y-3">
            <TabsList className="grid h-auto w-full grid-cols-2 bg-muted/50 sm:grid-cols-5">
              {levelTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="min-w-0 gap-1.5 text-xs">
                  {tab.label}
                  <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">{tab.count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {panelLogsLoading ? (
            <DataSectionLoading label="正在加载面板日志" minHeight="h-80" />
          ) : (
          <div className={logViewportClass}>
            {panelLogEntries.length === 0 ? (
              <div className={logEmptyClass}>暂无日志</div>
            ) : (
              <div className="space-y-1">
                {panelLogEntries.map((entry: any) => (
                  <div key={entry.id} className="grid gap-2 sm:grid-cols-[150px_56px_1fr]">
                    <span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                    <span className={logLevelClass(entry.level)}>{String(entry.level).toUpperCase()}</span>
                    <span className="whitespace-pre-wrap break-words text-foreground/90">{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
          <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              当前显示 {panelLogStart}-{panelLogEnd} / {panelLogs?.total || 0} 条
              {panelLogsFetching && !panelLogsLoading ? "，正在刷新" : ""}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPanelLogOffset(Math.max(0, panelLogOffset - LOG_PAGE_SIZE))}
                disabled={panelLogsFetching || panelLogOffset <= 0}
              >
                较新
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPanelLogOffset(panelLogs?.nextOffset || 0)}
                disabled={panelLogsFetching || !panelLogs?.hasMore}
              >
                更早
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BackupRestoreSection({ panelUrl }: { panelUrl: string }) {
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultSqlitePath = "/data/forwardx.db";
  const [migrationCode, setMigrationCode] = useState<{
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pendingRequest?: {
      id: string;
      targetPanelUrl: string;
      status: "pending" | "approved" | "rejected" | "used";
      createdAt: number;
      expiresAt: number;
      approvedAt?: number;
      rejectedAt?: number;
    } | null;
  } | null>(null);
  const [migrationCodeTick, setMigrationCodeTick] = useState(Date.now());
  const [backupPassword, setBackupPassword] = useState("");
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importFilename, setImportFilename] = useState("");
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [exportProgress, setExportProgress] = useState<BackupTaskProgress | null>(null);
  const [importProgress, setImportProgress] = useState<BackupTaskProgress | null>(null);
  const [onlineMigration, setOnlineMigration] = useState({
    oldPanelUrl: "",
    migrationCode: "",
    targetPanelUrl: panelUrl,
  });
  const [showOnlineConfirm, setShowOnlineConfirm] = useState(false);
  const [migrationJobId, setMigrationJobId] = useState<string | null>(null);
  const [reportedMigrationJobId, setReportedMigrationJobId] = useState<string | null>(null);
  const [databaseSwitchType, setDatabaseSwitchType] = useState<DatabaseType>("sqlite");
  const [databaseSwitchMysql, setDatabaseSwitchMysql] = useState({
    host: "127.0.0.1",
    port: 3306,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [databaseSwitchPostgresql, setDatabaseSwitchPostgresql] = useState({
    host: "127.0.0.1",
    port: 5432,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [databaseSwitchSqlitePath, setDatabaseSwitchSqlitePath] = useState(defaultSqlitePath);
  const [testedDatabaseSwitchKey, setTestedDatabaseSwitchKey] = useState("");
  const [databaseSwitchJobId, setDatabaseSwitchJobId] = useState<string | null>(null);
  const [reportedDatabaseSwitchJobId, setReportedDatabaseSwitchJobId] = useState<string | null>(null);
  const [showDatabaseSwitchConfirm, setShowDatabaseSwitchConfirm] = useState(false);
  const [cachedBackupSummary, setCachedBackupSummary] = useState<BackupSummaryCache | null>(() => readBackupSummaryCache());

  const { data: currentMigrationCode } = trpc.system.getMigrationCode.useQuery(undefined, {
    refetchInterval: pollingInterval("realtime"),
  });
  const { data: databaseSwitchStatus } = trpc.system.databaseSwitchStatus.useQuery(undefined, {
    refetchInterval: pollingInterval("normal"),
  });
  const { data: backupSummary, isLoading: backupSummaryLoading } = trpc.system.backupSummary.useQuery(undefined, {
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: migrationJob } = trpc.system.panelMigrationStatus.useQuery(
    { jobId: migrationJobId || "" },
    {
      enabled: !!migrationJobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "success" || status === "failed" ? false : 1200;
      },
    },
  );
  const { data: databaseSwitchJob } = trpc.system.databaseSwitchJob.useQuery(
    { jobId: databaseSwitchJobId || "" },
    {
      enabled: !!databaseSwitchJobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "success" || status === "failed" ? false : 1200;
      },
    },
  );

  const actualDefaultSqlitePath = databaseSwitchStatus?.defaultSqlitePath || defaultSqlitePath;
  const databaseSwitchConfig = useMemo(
    () =>
      databaseSwitchType === "mysql"
        ? { type: "mysql" as const, mysql: databaseSwitchMysql }
        : databaseSwitchType === "postgresql"
          ? { type: "postgresql" as const, postgresql: databaseSwitchPostgresql }
          : { type: "sqlite" as const, sqlite: { path: databaseSwitchSqlitePath || actualDefaultSqlitePath } },
    [actualDefaultSqlitePath, databaseSwitchMysql, databaseSwitchPostgresql, databaseSwitchSqlitePath, databaseSwitchType],
  );
  const databaseSwitchConfigKey = useMemo(() => JSON.stringify(databaseSwitchConfig), [databaseSwitchConfig]);
  const databaseSwitchExternal = databaseSwitchType === "postgresql" ? databaseSwitchPostgresql : databaseSwitchMysql;
  const setDatabaseSwitchExternal = databaseSwitchType === "postgresql" ? setDatabaseSwitchPostgresql : setDatabaseSwitchMysql;
  const databaseSwitchExternalDefaultPort = databaseSwitchType === "postgresql" ? 5432 : 3306;
  const isDatabaseSwitchTested = testedDatabaseSwitchKey === databaseSwitchConfigKey;
  const databaseSwitchRunning = databaseSwitchJob?.status === "pending" || databaseSwitchJob?.status === "running";

  useEffect(() => {
    setMigrationCode(currentMigrationCode || null);
  }, [currentMigrationCode]);

  useEffect(() => {
    if (!backupSummary) return;
    const nextSummary = normalizeBackupSummaryCache(backupSummary);
    setCachedBackupSummary(nextSummary);
    writeBackupSummaryCache(nextSummary);
  }, [backupSummary]);

  useEffect(() => {
    setOnlineMigration((current) => (
      current.targetPanelUrl ? current : { ...current, targetPanelUrl: panelUrl }
    ));
  }, [panelUrl]);

  useEffect(() => {
    if (!migrationCode) return;
    const timer = window.setInterval(() => setMigrationCodeTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [migrationCode?.code]);



  useEffect(() => {
    if (!migrationJob || reportedMigrationJobId === migrationJob.id) return;
    if (migrationJob?.status === "success") {
      toast.success(migrationJob.message || "在线迁移完成");
      utils.system.backupSummary.invalidate();
      setReportedMigrationJobId(migrationJob.id);
    }
    if (migrationJob?.status === "failed") {
      toast.error(migrationJob.error || "在线迁移失败");
      setReportedMigrationJobId(migrationJob.id);
    }
  }, [migrationJob, reportedMigrationJobId, utils.system.backupSummary]);

  useEffect(() => {
    const activeJob = databaseSwitchStatus?.activeJob;
    if (!databaseSwitchJobId && activeJob?.id) {
      setDatabaseSwitchJobId(activeJob.id);
    }
  }, [databaseSwitchJobId, databaseSwitchStatus?.activeJob]);

  useEffect(() => {
    if (!databaseSwitchStatus?.defaultSqlitePath) return;
    setDatabaseSwitchSqlitePath((current) => (
      !current || current === defaultSqlitePath ? databaseSwitchStatus.defaultSqlitePath : current
    ));
  }, [databaseSwitchStatus?.defaultSqlitePath]);

  useEffect(() => {
    if (!databaseSwitchJob || reportedDatabaseSwitchJobId === databaseSwitchJob.id) return;
    if (databaseSwitchJob.status === "success") {
      toast.success(databaseSwitchJob.message || "数据库切换完成");
      utils.system.backupSummary.invalidate();
      utils.system.databaseSwitchStatus.invalidate();
      setReportedDatabaseSwitchJobId(databaseSwitchJob.id);
      if (databaseSwitchJob.restartRequired) {
        window.setTimeout(() => window.location.reload(), 3000);
      }
    }
    if (databaseSwitchJob.status === "failed") {
      toast.error(databaseSwitchJob.error || "数据库切换失败");
      setReportedDatabaseSwitchJobId(databaseSwitchJob.id);
    }
  }, [databaseSwitchJob, reportedDatabaseSwitchJobId, utils.system.backupSummary, utils.system.databaseSwitchStatus]);

  const createMigrationCodeMutation = trpc.system.createMigrationCode.useMutation({
    onSuccess: (data) => {
      setMigrationCode(data);
      utils.system.getMigrationCode.invalidate();
      toast.success("迁移码已生成，5 分钟内有效");
    },
    onError: (err) => toast.error(err.message || "生成迁移码失败"),
  });

  const approveMigrationRequestMutation = trpc.system.approveMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已同意迁移请求，新面板将开始导入数据");
    },
    onError: (err) => toast.error(err.message || "同意迁移请求失败"),
  });

  const rejectMigrationRequestMutation = trpc.system.rejectMigrationRequest.useMutation({
    onSuccess: () => {
      utils.system.getMigrationCode.invalidate();
      toast.success("已拒绝迁移请求");
    },
    onError: (err) => toast.error(err.message || "拒绝迁移请求失败"),
  });

  const finishExportProgress = (next: BackupTaskProgress) => {
    setExportProgress(next);
    window.setTimeout(() => setExportProgress(null), 1800);
  };

  const finishImportProgress = (next: BackupTaskProgress) => {
    setImportProgress(next);
    window.setTimeout(() => setImportProgress(null), 2200);
  };

  const exportBackupMutation = trpc.system.exportPanelBackup.useMutation({
    onSuccess: (data) => {
      setExportProgress({
        percent: 92,
        step: "正在准备下载文件",
        detail: `备份文件 ${data.filename} 已生成，浏览器即将保存。`,
        status: "running",
      });
      downloadTextFile(data.filename, data.content, data.mimeType || "application/json;charset=utf-8");
      setBackupPassword("");
      setBackupPasswordConfirm("");
      finishExportProgress({
        percent: 100,
        step: "备份导出完成",
        detail: "加密备份文件已交给浏览器下载。",
        status: "success",
      });
      toast.success("加密备份已导出");
    },
    onError: (err) => {
      finishExportProgress({
        percent: 100,
        step: "备份导出失败",
        detail: err.message || "导出备份失败",
        status: "error",
      });
      toast.error(err.message || "导出备份失败");
    },
  });

  const importBackupMutation = trpc.system.importPanelBackup.useMutation({
    onSuccess: async (result) => {
      setImportProgress({
        percent: 88,
        step: "正在刷新面板数据",
        detail: "备份已导入，正在更新当前页面的数据概览。",
        status: "running",
      });
      setShowImportConfirm(false);
      setImportPassword("");
      setImportContent("");
      setImportFilename("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await utils.system.backupSummary.invalidate();
      finishImportProgress({
        percent: 100,
        step: result.mode === "incremental" ? "增量导入完成" : "备份恢复完成",
        detail: result.mode === "incremental" ? "当前面板数据已保留，备份数据已增量导入。" : "备份数据已恢复到当前面板。",
        status: "success",
      });
      toast.success(result.mode === "incremental" ? "增量导入完成，当前面板数据已保留" : "备份恢复完成");
    },
    onError: (err) => {
      finishImportProgress({
        percent: 100,
        step: "备份导入失败",
        detail: err.message || "导入备份失败",
        status: "error",
      });
      toast.error(err.message || "导入备份失败");
    },
  });

  useEffect(() => {
    if (!exportBackupMutation.isPending) return;
    const timer = window.setInterval(() => {
      setExportProgress((current) => {
        if (!current || current.status !== "running") return current;
        const nextPercent = Math.min(86, current.percent + (current.percent < 70 ? 3 : 1));
        return {
          percent: nextPercent,
          step: nextPercent >= 78 ? "等待服务器完成导出" : current.step,
          detail: nextPercent >= 78 ? "数据量较大时导出会多花一些时间，请保持当前页面打开。" : current.detail,
          status: "running",
        };
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [exportBackupMutation.isPending]);

  useEffect(() => {
    if (!importBackupMutation.isPending) return;
    const timer = window.setInterval(() => {
      setImportProgress((current) => {
        if (!current || current.status !== "running") return current;
        const nextPercent = Math.min(84, current.percent + (current.percent < 65 ? 3 : 1));
        return {
          percent: nextPercent,
          step: nextPercent >= 74 ? "等待服务器完成导入" : current.step,
          detail: nextPercent >= 74 ? "备份文件较大时恢复会多花一些时间，请不要关闭页面。" : current.detail,
          status: "running",
        };
      });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [importBackupMutation.isPending]);
  const startPanelMigrationMutation = trpc.system.startPanelMigration.useMutation({
    onSuccess: (job) => {
      setMigrationJobId(job.id);
      setReportedMigrationJobId(null);
      setShowOnlineConfirm(false);
      toast.success("在线迁移任务已开始");
    },
    onError: (err) => toast.error(err.message || "启动在线迁移失败"),
  });

  const testDatabaseSwitchMutation = trpc.system.testDatabaseSwitchTarget.useMutation({
    onSuccess: (_data, variables) => {
      setTestedDatabaseSwitchKey(JSON.stringify(variables));
      toast.success("目标数据库连接测试通过");
    },
    onError: (err) => {
      setTestedDatabaseSwitchKey("");
      toast.error(err.message || "目标数据库连接测试失败");
    },
  });

  const startDatabaseSwitchMutation = trpc.system.startDatabaseSwitch.useMutation({
    onSuccess: (job) => {
      setDatabaseSwitchJobId(job.id);
      setReportedDatabaseSwitchJobId(null);
      setShowDatabaseSwitchConfirm(false);
      toast.success("数据库迁移切换任务已开始");
    },
    onError: (err) => toast.error(err.message || "启动数据库切换失败"),
  });

  const copyMigrationCode = async (code: string) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = code;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textarea);
    }

    if (copied) toast.success("迁移码已复制");
    else toast.error("复制失败，请手动选中迁移码复制");
  };

  const migrationCountdown = getMigrationCodeCountdown(migrationCode, migrationCodeTick);
  const migrationRequest = migrationCode?.pendingRequest;
  const displayBackupSummary = backupSummary
    ? normalizeBackupSummaryCache(backupSummary)
    : cachedBackupSummary || zeroBackupSummary;
  const backupSummaryReady = !!backupSummary;
  const hasExistingData = !!displayBackupSummary.hasExistingData;

  const handleExportBackup = () => {
    if (backupPassword.length < 8) {
      toast.error("备份密码至少需要 8 位");
      return;
    }
    if (backupPassword !== backupPasswordConfirm) {
      toast.error("两次输入的备份密码不一致");
      return;
    }
    setExportProgress({
      percent: 12,
      step: "正在读取面板数据",
      detail: "正在整理用户、主机、规则、隧道和系统配置。",
      status: "running",
    });
    window.setTimeout(() => {
      setExportProgress((current) => current?.status === "running"
        ? { percent: 42, step: "正在裁剪低价值数据", detail: "正在跳过日志、历史探测和临时统计数据，减小备份体积。", status: "running" }
        : current);
    }, 700);
    window.setTimeout(() => {
      setExportProgress((current) => current?.status === "running"
        ? { percent: 68, step: "正在加密备份内容", detail: "备份文件会使用当前输入的密码加密保存。", status: "running" }
        : current);
    }, 1600);
    exportBackupMutation.mutate({ password: backupPassword });
  };

  const handleBackupFileChange = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error("备份文件过大");
      return;
    }
    const text = await file.text();
    setImportContent(text);
    setImportFilename(file.name);
  };

  const openImportConfirm = () => {
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再导入");
      return;
    }
    if (!importContent) {
      toast.error("请选择备份文件");
      return;
    }
    if (!importPassword) {
      toast.error("请输入备份密码");
      return;
    }
    setShowImportConfirm(true);
  };

  const confirmImportBackup = () => {
    setImportProgress({
      percent: 15,
      step: "正在读取备份文件",
      detail: importFilename ? `正在处理 ${importFilename}。` : "正在处理已选择的备份文件。",
      status: "running",
    });
    window.setTimeout(() => {
      setImportProgress((current) => current?.status === "running"
        ? { percent: 36, step: "正在解密备份内容", detail: "正在使用备份密码校验并解密文件。", status: "running" }
        : current);
    }, 700);
    window.setTimeout(() => {
      setImportProgress((current) => current?.status === "running"
        ? { percent: 62, step: "正在写入面板数据", detail: "正在恢复主机、规则、隧道和转发组数据。", status: "running" }
        : current);
    }, 1600);
    importBackupMutation.mutate({
      content: importContent,
      password: importPassword,
      targetPanelUrl: panelUrl || undefined,
      confirmed: true,
    });
  };

  const openOnlineConfirm = () => {
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再迁移");
      return;
    }
    if (!onlineMigration.oldPanelUrl.trim() || !onlineMigration.migrationCode.trim() || !onlineMigration.targetPanelUrl.trim()) {
      toast.error("请填写旧面板地址、迁移码和新面板访问地址");
      return;
    }
    setShowOnlineConfirm(true);
  };

  const handleTestDatabaseSwitch = () => {
    setTestedDatabaseSwitchKey("");
    testDatabaseSwitchMutation.mutate(databaseSwitchConfig);
  };

  const openDatabaseSwitchConfirm = () => {
    if (databaseSwitchStatus?.blockedReason) {
      toast.error(databaseSwitchStatus.blockedReason);
      return;
    }
    if (!backupSummaryReady) {
      toast.info("正在读取当前面板数据，请稍后再切换");
      return;
    }
    if (!isDatabaseSwitchTested) {
      toast.error("请先测试目标数据库连接，测试通过后才能开始切换");
      return;
    }
    if (databaseSwitchRunning || startDatabaseSwitchMutation.isPending) {
      toast.info("已有数据库切换任务正在执行");
      return;
    }
    setShowDatabaseSwitchConfirm(true);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "当前用户", value: displayBackupSummary.userCount },
          { label: "当前主机", value: displayBackupSummary.hostCount },
          { label: "当前规则", value: displayBackupSummary.ruleCount },
          { label: "当前隧道", value: displayBackupSummary.tunnelCount },
          { label: "转发组", value: displayBackupSummary.forwardGroupCount },
        ].map((item) => (
          <Card key={item.label} className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardContent className="min-h-[80px] p-4">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <div className="mt-1 flex h-7 items-center">
                <p className="text-xl font-semibold leading-7">{item.value ?? 0}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>
          {!backupSummaryReady && backupSummaryLoading
            ? "已展示缓存数据，正在后台刷新"
            : hasExistingData
              ? "当前面板已有业务数据，迁移将按增量方式执行"
              : "当前面板没有业务数据，可作为完整恢复执行"}
        </AlertTitle>
        <AlertDescription>
          {backupSummaryReady
            ? "增量迁移会保留新面板现有主机、用户、规则和订单数据，并把旧面板数据追加导入；重复的用户账号、主机 Token、订单号、兑换码会复用现有记录。"
            : "首次进入没有缓存时会先显示 0；接口返回真实数据后会自动更新并缓存，后续进入可直接展示上次统计。"}
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Key className="h-4 w-4 text-primary" />
              旧面板迁移码
            </CardTitle>
            <CardDescription>
              在旧面板生成迁移码，并审批新面板发起的在线迁移请求。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {migrationCode ? (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">迁移码</p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <code className="break-all font-mono text-lg font-semibold tracking-widest">{migrationCode.code}</code>
                  <Button variant="outline" size="sm" onClick={() => copyMigrationCode(migrationCode.code)}>
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    复制
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>有效至 {new Date(migrationCode.expiresAt).toLocaleTimeString()}</span>
                  <Badge variant={migrationCountdown > 0 ? "outline" : "secondary"}>
                    剩余 {formatCountdown(migrationCountdown)}
                  </Badge>
                </div>
                {migrationRequest?.status === "pending" && (
                  <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-300">收到新面板迁移请求</p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      目标面板：{migrationRequest.targetPanelUrl}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => approveMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        同意迁移
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rejectMigrationRequestMutation.mutate({ requestId: migrationRequest.id })}
                        disabled={approveMigrationRequestMutation.isPending || rejectMigrationRequestMutation.isPending}
                      >
                        拒绝
                      </Button>
                    </div>
                  </div>
                )}
                {migrationRequest?.status === "approved" && (
                  <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    已同意迁移请求，正在等待新面板拉取数据。
                  </div>
                )}
                {migrationRequest?.status === "rejected" && (
                  <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    已拒绝本次迁移请求。
                  </div>
                )}
              </div>
            ) : (
              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertTitle>一次性迁移码</AlertTitle>
                <AlertDescription>迁移码 5 分钟有效，使用后失效。</AlertDescription>
              </Alert>
            )}
            <Button onClick={() => createMigrationCodeMutation.mutate()} disabled={createMigrationCodeMutation.isPending}>
              生成迁移码
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MoveRight className="h-4 w-4 text-primary" />
              在线迁移接收
            </CardTitle>
            <CardDescription>
              拉取旧面板数据，并在新面板运行验证通过后完成接管。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>旧面板地址</Label>
                <Input
                  value={onlineMigration.oldPanelUrl}
                  onChange={(e) => setOnlineMigration({ ...onlineMigration, oldPanelUrl: e.target.value })}
                  placeholder="https://old.example.com"
                />
              </div>
              <div className="space-y-2">
                <Label>旧面板迁移码</Label>
                <Input
                  value={onlineMigration.migrationCode}
                  onChange={(e) => setOnlineMigration({ ...onlineMigration, migrationCode: e.target.value.toUpperCase() })}
                  placeholder="迁移码"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>新面板访问地址</Label>
              <Input
                value={onlineMigration.targetPanelUrl}
                onChange={(e) => setOnlineMigration({ ...onlineMigration, targetPanelUrl: e.target.value })}
                placeholder={panelUrl}
              />
            </div>
            {migrationJob && (
              <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{migrationJob.step}</span>
                  <span>{migrationJob.progress}%</span>
                </div>
                <Progress value={migrationJob.progress} className="mt-3" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {migrationJob.error || migrationJob.message || "验证完成前请保持新旧面板可访问。"}
                </p>
              </div>
            )}
            <Button className="gap-2" onClick={openOnlineConfirm} disabled={startPanelMigrationMutation.isPending}>
              <MoveRight className="h-4 w-4" />
              开始在线迁移
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" />
            数据库在线切换
          </CardTitle>
          <CardDescription>
            在 SQLite、MySQL、PostgreSQL 之间迁移当前面板数据，连接测试通过后才能开始。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["sqlite", "mysql", "postgresql"] as DatabaseType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setDatabaseSwitchType(type);
                  setTestedDatabaseSwitchKey("");
                }}
                className={`rounded-lg border p-3 text-left transition ${
                  databaseSwitchType === type
                    ? "border-primary/50 bg-primary/10"
                    : "border-border/50 bg-background/40 hover:border-primary/30"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">
                    {type === "sqlite" ? "SQLite" : type === "mysql" ? "MySQL" : "PostgreSQL"}
                  </span>
                  {databaseSwitchType === type && <CheckCircle2 className="h-4 w-4 text-primary" />}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {type === "sqlite" ? "本地数据文件" : type === "mysql" ? "外部 MySQL 数据库" : "外部 PostgreSQL 数据库"}
                </p>
              </button>
            ))}
          </div>

          <Alert className="border-primary/20 bg-primary/5 text-primary">
            <Database className="h-4 w-4" />
            <AlertTitle>数据库版本要求</AlertTitle>
            <AlertDescription>
              MySQL 需要 8.0.13 或以上版本；PostgreSQL 建议 12 或以上版本；SQLite 使用本地数据文件，无需额外准备数据库服务。
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 rounded-lg border border-border/40 bg-muted/20 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">
                  当前数据库：{databaseSwitchStatus?.currentType
                    ? databaseSwitchStatus.currentType === "sqlite"
                      ? "SQLite"
                      : databaseSwitchStatus.currentType === "mysql"
                        ? "MySQL"
                        : "PostgreSQL"
                    : "未识别"}
                </p>
                <p className="text-xs text-muted-foreground">
                  目标数据库需要为空库；迁移完成后面板会自动重启或刷新连接。
                </p>
              </div>
              <Badge variant={isDatabaseSwitchTested ? "default" : "outline"} className="w-fit">
                {isDatabaseSwitchTested ? "连接已测试" : "等待测试"}
              </Badge>
            </div>

            {databaseSwitchStatus?.blockedReason && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>当前环境暂不支持面板内切换</AlertTitle>
                <AlertDescription>{databaseSwitchStatus.blockedReason}</AlertDescription>
              </Alert>
            )}

            {databaseSwitchType === "sqlite" ? (
              <div className="space-y-2">
                <Label>SQLite 数据文件</Label>
                <Input
                  value={databaseSwitchSqlitePath}
                  onChange={(e) => {
                    setDatabaseSwitchSqlitePath(e.target.value);
                    setTestedDatabaseSwitchKey("");
                  }}
                  placeholder={actualDefaultSqlitePath}
                />
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                  <div className="space-y-2">
                    <Label>地址</Label>
                    <Input
                      value={databaseSwitchExternal.host}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, host: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>端口</Label>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={databaseSwitchExternal.port}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({
                          ...databaseSwitchExternal,
                          port: Number(e.target.value || databaseSwitchExternalDefaultPort),
                        });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>数据库名</Label>
                    <Input
                      value={databaseSwitchExternal.database}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, database: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>用户名</Label>
                    <Input
                      value={databaseSwitchExternal.user}
                      onChange={(e) => {
                        setDatabaseSwitchExternal({ ...databaseSwitchExternal, user: e.target.value });
                        setTestedDatabaseSwitchKey("");
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>密码</Label>
                  <Input
                    type="password"
                    value={databaseSwitchExternal.password}
                    onChange={(e) => {
                      setDatabaseSwitchExternal({ ...databaseSwitchExternal, password: e.target.value });
                      setTestedDatabaseSwitchKey("");
                    }}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 p-3">
                  <div>
                    <p className="text-sm font-medium">启用 SSL</p>
                    <p className="text-xs text-muted-foreground">远程数据库或云数据库可按需开启。</p>
                  </div>
                  <Switch
                    checked={databaseSwitchExternal.ssl}
                    onCheckedChange={(ssl) => {
                      setDatabaseSwitchExternal({ ...databaseSwitchExternal, ssl });
                      setTestedDatabaseSwitchKey("");
                    }}
                  />
                </div>
              </div>
            )}

            {databaseSwitchJob && (
              <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{databaseSwitchJob.step}</span>
                  <span>{databaseSwitchJob.progress}%</span>
                </div>
                <Progress value={databaseSwitchJob.progress} className="mt-3" />
                <p className="mt-2 text-xs text-muted-foreground">
                  {databaseSwitchJob.error || databaseSwitchJob.message || "数据库迁移切换正在执行，请不要重复提交。"}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={handleTestDatabaseSwitch}
                disabled={testDatabaseSwitchMutation.isPending || databaseSwitchRunning || !!databaseSwitchStatus?.blockedReason}
              >
                {testDatabaseSwitchMutation.isPending ? "测试中..." : "测试连接"}
              </Button>
              <Button
                className="gap-2"
                onClick={openDatabaseSwitchConfirm}
                disabled={!isDatabaseSwitchTested || databaseSwitchRunning || startDatabaseSwitchMutation.isPending || !!databaseSwitchStatus?.blockedReason}
              >
                <MoveRight className="h-4 w-4" />
                开始迁移切换
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-primary" />
              加密数据导出
            </CardTitle>
            <CardDescription>
              导出一份离线备份文件，文件内容会使用你设置的备份密码加密。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>备份密码</Label>
                <Input type="password" value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} placeholder="至少 8 位" />
              </div>
              <div className="space-y-2">
                <Label>确认备份密码</Label>
                <Input type="password" value={backupPasswordConfirm} onChange={(e) => setBackupPasswordConfirm(e.target.value)} />
              </div>
            </div>
            <Alert>
              <Lock className="h-4 w-4" />
              <AlertTitle>请妥善保存备份密码</AlertTitle>
              <AlertDescription>备份文件不保存明文数据，忘记密码将无法解密恢复。</AlertDescription>
            </Alert>
            <BackupTaskProgressView progress={exportProgress} />
            <Button className="gap-2" onClick={handleExportBackup} disabled={exportBackupMutation.isPending}>
              {exportBackupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exportBackupMutation.isPending ? "正在导出..." : "导出加密备份"}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-primary" />
              离线导入恢复
            </CardTitle>
            <CardDescription>
              旧面板离线时，可通过加密备份文件恢复并接管旧主机。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label>备份文件</Label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".fwxbak,application/json"
                onChange={(e) => handleBackupFileChange(e.target.files?.[0])}
              />
              {importFilename && <p className="text-xs text-muted-foreground">已选择：{importFilename}</p>}
            </div>
            <div className="space-y-2">
              <Label>备份密码</Label>
              <Input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} />
            </div>
            <BackupTaskProgressView progress={importProgress} />
            <Button className="gap-2" onClick={openImportConfirm} disabled={importBackupMutation.isPending}>
              {importBackupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {importBackupMutation.isPending ? "正在导入..." : "导入并恢复"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showImportConfirm} onOpenChange={setShowImportConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认导入备份
            </DialogTitle>
            <DialogDescription>
              导入后会接管备份内已有主机，旧面板的主机、规则、隧道和转发组会迁移到当前面板。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>{hasExistingData ? "将执行增量导入" : "将执行完整恢复"}</AlertTitle>
            <AlertDescription>
              {hasExistingData
                ? "当前面板已有数据会被保留，备份内数据会增量追加；重复数据会尽量复用现有记录。"
                : "当前面板没有业务数据，导入后会保留当前管理员账户，并以备份数据作为当前面板数据。"}
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowImportConfirm(false)} disabled={importBackupMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={confirmImportBackup}
              disabled={importBackupMutation.isPending}
            >
              {importBackupMutation.isPending ? "正在导入..." : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showOnlineConfirm} onOpenChange={setShowOnlineConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认在线迁移
            </DialogTitle>
            <DialogDescription>
              新面板将连接旧面板拉取数据，并在旧面板审批后执行迁移。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>{hasExistingData ? "将执行增量迁移" : "将执行完整迁移"}</AlertTitle>
            <AlertDescription>
              Agent 和原有转发恢复后才会完成接管；旧面板数据不会自动删除。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOnlineConfirm(false)} disabled={startPanelMigrationMutation.isPending}>
              取消
            </Button>
            <Button
              onClick={() => startPanelMigrationMutation.mutate({
                oldPanelUrl: onlineMigration.oldPanelUrl.trim(),
                migrationCode: onlineMigration.migrationCode.trim(),
                targetPanelUrl: onlineMigration.targetPanelUrl.trim(),
                confirmed: true,
              })}
              disabled={startPanelMigrationMutation.isPending}
            >
              确认迁移
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDatabaseSwitchConfirm} onOpenChange={setShowDatabaseSwitchConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认切换数据库
            </DialogTitle>
            <DialogDescription>
              面板会把当前数据迁移到目标数据库，完成后自动重启或刷新连接。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>请确认目标数据库为空库</AlertTitle>
            <AlertDescription>
              迁移会保留当前数据 ID；如果目标数据库已有业务数据，后端会阻止切换以避免覆盖或混合数据。
            </AlertDescription>
          </Alert>
          <Alert className="border-primary/20 bg-primary/5 text-primary">
            <Database className="h-4 w-4" />
            <AlertTitle>请确认数据库版本</AlertTitle>
            <AlertDescription>
              MySQL 需要 8.0.13 或以上版本；PostgreSQL 建议 12 或以上版本。
            </AlertDescription>
          </Alert>
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">当前数据库</span>
              <code>{databaseSwitchStatus?.currentType || "-"}</code>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-muted-foreground">目标数据库</span>
              <code>{databaseSwitchConfig.type}</code>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDatabaseSwitchConfirm(false)}
              disabled={startDatabaseSwitchMutation.isPending}
            >
              取消
            </Button>
            <Button
              onClick={() => startDatabaseSwitchMutation.mutate({
                target: databaseSwitchConfig,
                confirmed: true,
              })}
              disabled={startDatabaseSwitchMutation.isPending || !isDatabaseSwitchTested}
            >
              确认切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TelegramBotSettingsCard() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [telegramExpiryReminder, setTelegramExpiryReminder] = useState(false);
  const [telegramTrafficReminder, setTelegramTrafficReminder] = useState(false);
  const [telegramHostStatusNotify, setTelegramHostStatusNotify] = useState(false);
  const [telegramTrafficThreshold, setTelegramTrafficThreshold] = useState(20);
  const [showDeleteTelegramBot, setShowDeleteTelegramBot] = useState(false);

  useEffect(() => {
    if (settings) {
      setTelegramEnabled(!!settings.telegram?.enabled);
      const telegramReady = !!settings.telegram?.enabled && !!settings.telegram?.configured;
      setTelegramExpiryReminder(telegramReady && !!settings.telegram?.expiryReminder);
      setTelegramTrafficReminder(telegramReady && !!settings.telegram?.trafficReminder);
      setTelegramHostStatusNotify(telegramReady && !!settings.telegram?.hostStatusNotify);
      setTelegramTrafficThreshold(Number(settings.telegram?.trafficReminderThreshold || 20));
    }
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      toast.success("Telegram 机器人配置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });
  const testTelegramMutation = trpc.telegram.testSend.useMutation({
    onSuccess: () => toast.success("测试消息已发送，请查看已绑定的 Telegram"),
    onError: (err) => toast.error(err.message || "测试发送失败"),
  });

  const handleSaveTelegram = () => {
    const canSubmitToken = !settings?.telegram?.configured && settings?.telegram?.tokenSource !== "env";
    const nextToken = canSubmitToken ? telegramBotTokenInput.trim() : "";
    const hasTelegramToken = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env" || !!nextToken;
    const remindersReady = telegramEnabled && !!settings?.telegram?.configured;
    if (telegramEnabled && !hasTelegramToken) {
      toast.error("请先填写 Bot Token");
      return;
    }
    if ((telegramExpiryReminder || telegramTrafficReminder || telegramHostStatusNotify) && !remindersReady) {
      toast.error("请先保存并启用 Telegram 机器人后再开启提醒");
      return;
    }
    updateSettingsMutation.mutate({
      telegram: {
        enabled: telegramEnabled,
        botToken: nextToken || undefined,
        expiryReminder: remindersReady ? telegramExpiryReminder : false,
        trafficReminder: remindersReady ? telegramTrafficReminder : false,
        hostStatusNotify: remindersReady ? telegramHostStatusNotify : false,
        trafficReminderThreshold: telegramTrafficThreshold,
      },
    });
    setTelegramBotTokenInput("");
  };

  const handleClearTelegramToken = () => {
    updateSettingsMutation.mutate({
      telegram: {
        enabled: false,
        clearToken: true,
      },
    });
    setTelegramEnabled(false);
    setTelegramBotTokenInput("");
    setShowDeleteTelegramBot(false);
  };

  const tokenSourceLabel =
    settings?.telegram?.tokenSource === "env"
      ? "环境变量 TELEGRAM_BOT_TOKEN"
      : settings?.telegram?.tokenSource === "database"
        ? "数据库配置"
        : "未配置";

  const telegramTokenLocked = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env";
  const telegramTokenDisplayValue = telegramTokenLocked
    ? settings?.telegram?.tokenMasked || ""
    : telegramBotTokenInput;
  const hasTelegramTokenForEnable = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env" || !!telegramBotTokenInput.trim();
  const telegramRemindersReady = telegramEnabled && !!settings?.telegram?.configured;
  const telegramReminderHint = telegramRemindersReady ? null : "请先保存并启用 Telegram 机器人。";

  return (
    <>
    <Card className="border-primary/20 bg-primary/5 backdrop-blur-md">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-primary" />
              Telegram 机器人
            </CardTitle>
            <CardDescription className="mt-1">
              配置 Bot Token，启用绑定、提醒和快捷登录。
            </CardDescription>
          </div>
          <Badge variant={settings?.telegram?.configured ? "default" : "outline"} className="w-fit">
            {settings?.telegram?.configured ? "已配置" : "未配置"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <DataSectionLoading label="正在加载 Telegram 配置" minHeight="min-h-[120px]" />
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="space-y-2">
                <Label>Bot Token</Label>
                <Input
                  type="text"
                  placeholder={settings?.telegram?.tokenMasked || "从 @BotFather 获取，例如 123456:ABC..."}
                  value={telegramTokenDisplayValue}
                  onChange={(e) => {
                    if (!telegramTokenLocked) setTelegramBotTokenInput(e.target.value);
                  }}
                  readOnly={telegramTokenLocked}
                  disabled={settings?.telegram?.tokenSource === "env"}
                  onMouseDown={(e) => {
                    if (telegramTokenLocked) e.preventDefault();
                  }}
                  onSelect={(e) => {
                    if (telegramTokenLocked) e.currentTarget.setSelectionRange(0, 0);
                  }}
                  className={telegramTokenLocked ? "select-none font-mono" : "font-mono"}
                />
                <p className="text-xs text-muted-foreground">
                  来源：{tokenSourceLabel}
                </p>
              </div>
              <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">启用机器人</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {settings?.telegram?.botUsername ? `@${settings.telegram.botUsername}` : "保存 Token 后自动识别机器人"}
                    </p>
                  </div>
                  <Switch
                    checked={telegramEnabled}
                    onCheckedChange={(checked) => {
                      if (checked && !hasTelegramTokenForEnable) {
                        toast.error("请先填写 Bot Token");
                        return;
                      }
                      setTelegramEnabled(checked);
                    }}
                  />
                </div>
              </div>
            </div>
            <Alert>
              <Globe className="h-4 w-4" />
              <AlertTitle>快捷登录需要域名</AlertTitle>
              <AlertDescription>
                在系统配置填写公开地址，并在 @BotFather 绑定同一域名。
              </AlertDescription>
            </Alert>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">到期提醒</p>
                    <p className="mt-1 text-xs text-muted-foreground">{telegramReminderHint || "到期前 3 天提醒。"}</p>
                  </div>
                  <Switch
                    checked={telegramRemindersReady && telegramExpiryReminder}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramExpiryReminder}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">主机上线/离线通知</p>
                    <p className="mt-1 text-xs text-muted-foreground">{telegramReminderHint || "仅发送给已绑定 Telegram 的管理员。"}</p>
                  </div>
                  <Switch
                    checked={telegramRemindersReady && telegramHostStatusNotify}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramHostStatusNotify}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">流量提醒</p>
                    <p className="mt-1 text-xs text-muted-foreground">{telegramReminderHint || "低于阈值时提醒。"}</p>
                  </div>
                  <Switch
                    checked={telegramRemindersReady && telegramTrafficReminder}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramTrafficReminder}
                  />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">阈值</Label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={telegramTrafficThreshold}
                    onChange={(e) => setTelegramTrafficThreshold(Math.min(99, Math.max(1, Number(e.target.value) || 20)))}
                    className="h-8 w-24"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSaveTelegram} disabled={updateSettingsMutation.isPending}>
                保存 Telegram 配置
              </Button>
              <Button
                variant="outline"
                onClick={() => testTelegramMutation.mutate()}
                disabled={
                  testTelegramMutation.isPending ||
                  !settings?.telegram?.configured ||
                  !settings?.telegram?.enabled
                }
              >
                测试发送
              </Button>
              {settings?.telegram?.tokenSource === "database" && (
                <Button
                  variant="outline"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setShowDeleteTelegramBot(true)}
                  disabled={updateSettingsMutation.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除机器人
                </Button>
              )}
              {settings?.telegram?.botUsername && (
                <Button variant="ghost" asChild className="gap-2">
                  <a href={`https://t.me/${settings.telegram.botUsername}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    打开机器人
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>

    <Dialog open={showDeleteTelegramBot} onOpenChange={setShowDeleteTelegramBot}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            删除 Telegram 机器人
          </DialogTitle>
          <DialogDescription>
            删除当前 Bot Token。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
          <p className="text-xs text-muted-foreground">当前机器人</p>
          <p className="mt-1 font-medium">{settings?.telegram?.botUsername ? `@${settings.telegram.botUsername}` : "Telegram 机器人"}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{settings?.telegram?.tokenMasked || "-"}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDeleteTelegramBot(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={handleClearTelegramToken} disabled={updateSettingsMutation.isPending}>
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function DeepSeekSettingsCard() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const [deepseekProvider, setDeepseekProvider] = useState<AiProvider>("deepseek");
  const [deepseekEnabled, setDeepseekEnabled] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<AiProviderLocalConfigMap>(() => createDefaultAiProviderConfigMap());
  const [deepseekMaxTokens, setDeepseekMaxTokens] = useState(1024);
  const [deepseekTemperature, setDeepseekTemperature] = useState(0.2);
  const [deepseekTelegramUserManageEnabled, setDeepseekTelegramUserManageEnabled] = useState(true);
  const [deepseekTelegramAutoRecallEnabled, setDeepseekTelegramAutoRecallEnabled] = useState(false);
  const [deepseekTelegramAutoRecallSeconds, setDeepseekTelegramAutoRecallSeconds] = useState(60);
  const [showDeleteDeepSeekKey, setShowDeleteDeepSeekKey] = useState(false);
  const activeProviderConfig = providerConfigs[deepseekProvider] || createDefaultAiProviderConfig(deepseekProvider);
  const deepseekBaseUrl = activeProviderConfig.baseUrl;
  const deepseekModel = activeProviderConfig.model;
  const providerConfigured = !!activeProviderConfig.configured;
  const aiModelsQuery = trpc.system.listAiModels.useQuery(
    {
      provider: deepseekProvider,
      baseUrl: deepseekBaseUrl.trim() || undefined,
      chatOnly: true,
    },
    {
      enabled: providerConfigured,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );

  useEffect(() => {
    if (settings?.deepseek) {
      const provider = normalizeAiProviderValue(settings.deepseek.provider);
      const serverProviders = (settings.deepseek as any).providers || {};
      const activeServerConfig = settings.deepseek as AiProviderServerConfig;
      const deepseekServerConfig = (serverProviders.deepseek as AiProviderServerConfig | undefined)
        || (provider === "deepseek" ? activeServerConfig : undefined);
      const siliconflowServerConfig = (serverProviders.siliconflow as AiProviderServerConfig | undefined)
        || (provider === "siliconflow" ? activeServerConfig : undefined);
      const customServerConfig = (serverProviders.custom as AiProviderServerConfig | undefined)
        || (provider === "custom" ? activeServerConfig : undefined);
      setProviderConfigs({
        deepseek: toLocalAiProviderConfig("deepseek", deepseekServerConfig),
        siliconflow: toLocalAiProviderConfig("siliconflow", siliconflowServerConfig),
        custom: toLocalAiProviderConfig("custom", customServerConfig),
      });
      setDeepseekProvider(provider);
      setDeepseekEnabled(!!settings.deepseek.enabled);
      setDeepseekMaxTokens(Number(settings.deepseek.maxTokens || 1024));
      setDeepseekTemperature(Number(settings.deepseek.temperature ?? 0.2));
      setDeepseekTelegramUserManageEnabled(settings.deepseek.telegramUserManageEnabled !== false);
      setDeepseekTelegramAutoRecallEnabled(!!settings.deepseek.telegramAutoRecallEnabled);
      setDeepseekTelegramAutoRecallSeconds(Math.min(1200, Math.max(30, Number(settings.deepseek.telegramAutoRecallSeconds || 60))));
    }
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      utils.system.listAiModels.invalidate();
      setProviderConfigs((prev) => ({
        deepseek: { ...prev.deepseek, apiKeyInput: "" },
        siliconflow: { ...prev.siliconflow, apiKeyInput: "" },
        custom: { ...prev.custom, apiKeyInput: "" },
      }));
      toast.success("AI 配置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });

  const selectedModelMeta = useMemo(() => {
    const models = Array.isArray(aiModelsQuery.data?.models) ? aiModelsQuery.data.models : [];
    return models.find((item: any) => String(item?.id || "") === deepseekModel.trim()) || null;
  }, [aiModelsQuery.data?.models, deepseekModel]);

  const updateProviderConfig = (provider: AiProvider, patch: Partial<AiProviderLocalConfig>) => {
    setProviderConfigs((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] || createDefaultAiProviderConfig(provider)),
        ...patch,
      },
    }));
  };

  const updateActiveProviderConfig = (patch: Partial<AiProviderLocalConfig>) => {
    updateProviderConfig(deepseekProvider, patch);
  };

  const handleProviderChange = (value: string) => {
    const provider = normalizeAiProviderValue(value);
    setDeepseekProvider(provider);
  };

  const normalizeMaxTokens = () => {
    const value = Math.floor(Number(deepseekMaxTokens));
    if (!Number.isFinite(value)) return 1024;
    return Math.min(8192, Math.max(128, value));
  };

  const normalizeTemperature = () => {
    const value = Number(deepseekTemperature);
    if (!Number.isFinite(value)) return 0.2;
    return Math.min(2, Math.max(0, value));
  };

  const normalizeTelegramAutoRecallSeconds = () => {
    const value = Math.floor(Number(deepseekTelegramAutoRecallSeconds));
    if (!Number.isFinite(value)) return 60;
    return Math.min(1200, Math.max(30, value));
  };

  const handleSaveDeepSeek = () => {
    const nextApiKey = activeProviderConfig.apiKeyInput.trim();
    const hasApiKey = providerConfigured || !!nextApiKey;
    if (deepseekEnabled && !hasApiKey) {
      toast.error("请先填写 AI API Key");
      return;
    }
    const maxTokens = normalizeMaxTokens();
    const temperature = normalizeTemperature();
    const telegramAutoRecallSeconds = normalizeTelegramAutoRecallSeconds();
    updateSettingsMutation.mutate({
      deepseek: {
        provider: deepseekProvider,
        enabled: deepseekEnabled,
        apiKey: !providerConfigured && nextApiKey ? nextApiKey : undefined,
        baseUrl: deepseekBaseUrl.trim() || aiProviderDefaults[deepseekProvider].baseUrl,
        model: deepseekModel.trim() || aiProviderDefaults[deepseekProvider].model,
        maxTokens,
        temperature,
        telegramUserManageEnabled: deepseekTelegramUserManageEnabled,
        telegramAutoRecallEnabled: deepseekTelegramAutoRecallEnabled,
        telegramAutoRecallSeconds,
      },
    });
    setDeepseekMaxTokens(maxTokens);
    setDeepseekTemperature(temperature);
    setDeepseekTelegramAutoRecallSeconds(telegramAutoRecallSeconds);
  };

  const handleClearDeepSeekKey = () => {
    updateSettingsMutation.mutate({
      deepseek: {
        provider: deepseekProvider,
        enabled: false,
        clearApiKey: true,
      },
    });
    setDeepseekEnabled(false);
    updateActiveProviderConfig({ apiKeyInput: "" });
    setShowDeleteDeepSeekKey(false);
  };

  const deepseekKeyLocked = providerConfigured;
  const deepseekKeyDisplayValue = deepseekKeyLocked
    ? activeProviderConfig.apiKeyMasked || ""
    : activeProviderConfig.apiKeyInput;
  const hasDeepSeekKeyForEnable = providerConfigured || !!activeProviderConfig.apiKeyInput.trim();
  const activeProviderDefaults = aiProviderDefaults[deepseekProvider];
  const providerLabel = aiProviderOptions.find((item) => item.value === deepseekProvider)?.label || deepseekProvider;
  const models = Array.isArray(aiModelsQuery.data?.models) ? aiModelsQuery.data.models : [];
  const knownFreeCount = Number(aiModelsQuery.data?.freeCount || 0);
  const knownPaidCount = Number(aiModelsQuery.data?.paidCount || 0);
  const unknownFreeCount = Number(aiModelsQuery.data?.unknownCount || 0);

  return (
    <>
      <Card className="border-emerald-500/25 bg-emerald-500/5 backdrop-blur-md">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="h-4 w-4 text-emerald-500" />
                AI 助手模型
              </CardTitle>
              <CardDescription className="mt-1">
                支持 DeepSeek / SiliconFlow / 自定义 OpenAI 兼容接口，用于 Telegram AI 指令解析。
              </CardDescription>
            </div>
            <Badge variant={providerConfigured ? "default" : "outline"} className="w-fit">
              {providerConfigured ? "已配置" : "未配置"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <DataSectionLoading label="正在加载 AI 配置" minHeight="min-h-[120px]" />
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>提供商</Label>
                  <Select value={deepseekProvider} onValueChange={handleProviderChange}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="选择提供商" />
                    </SelectTrigger>
                    <SelectContent>
                      {aiProviderOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>启用 AI 助手</Label>
                  <div className="flex h-10 items-center justify-between rounded-md border border-border/40 bg-background/50 px-3">
                    <p className="min-w-0 flex-1 truncate pr-3 text-sm text-muted-foreground">
                      {providerConfigured
                        ? `${providerLabel} · ${deepseekModel}${selectedModelMeta?.isFree === true ? " · Free" : (selectedModelMeta?.isFree === false ? " · Paid" : "")}`
                        : "保存 API Key 后启用"}
                    </p>
                    <Switch
                      checked={deepseekEnabled}
                      onCheckedChange={(checked) => {
                        if (checked && !hasDeepSeekKeyForEnable) {
                          toast.error("请先填写 AI API Key");
                          return;
                        }
                        setDeepseekEnabled(checked);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-12">
                <div className="space-y-2 lg:col-span-5">
                  <Label>API Key</Label>
                  <Input
                    type="text"
                    placeholder={activeProviderConfig.apiKeyMasked || "从提供商控制台获取，例如 sk-..."}
                    value={deepseekKeyDisplayValue}
                    onChange={(e) => {
                      if (!deepseekKeyLocked) updateActiveProviderConfig({ apiKeyInput: e.target.value });
                    }}
                    readOnly={deepseekKeyLocked}
                    onMouseDown={(e) => {
                      if (deepseekKeyLocked) e.preventDefault();
                    }}
                    onSelect={(e) => {
                      if (deepseekKeyLocked) e.currentTarget.setSelectionRange(0, 0);
                    }}
                    className={deepseekKeyLocked ? "select-none font-mono" : "font-mono"}
                  />
                  <p className="text-xs text-muted-foreground">
                    按提供商分别保存 API Key，切换提供商时会自动带出对应配置。
                  </p>
                </div>
                <div className="space-y-2 lg:col-span-3">
                  <Label>接口地址</Label>
                  <Input
                    type="text"
                    value={deepseekBaseUrl}
                    onChange={(e) => updateActiveProviderConfig({ baseUrl: e.target.value })}
                    placeholder={activeProviderDefaults.baseUrl}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2 lg:col-span-4">
                  <Label>模型</Label>
                  <Input
                    type="text"
                    value={deepseekModel}
                    onChange={(e) => updateActiveProviderConfig({ model: e.target.value })}
                    placeholder={activeProviderDefaults.model}
                    className="font-mono"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border/40 bg-background/50 p-2.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">可用聊天模型（支持展示 Free 状态）</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => aiModelsQuery.refetch()}
                    disabled={!providerConfigured || aiModelsQuery.isFetching}
                  >
                    {aiModelsQuery.isFetching && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    刷新
                  </Button>
                </div>
                {!!providerConfigured && models.length > 0 && (
                  <Select
                    value={models.some((item: any) => String(item?.id || "") === deepseekModel) ? deepseekModel : undefined}
                    onValueChange={(value) => updateActiveProviderConfig({ model: value })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="从列表选择模型" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {models.map((item: any) => (
                        <SelectItem key={String(item?.id || "")} value={String(item?.id || "")}>
                          {String(item?.id || "")}
                          {item?.isFree === true ? " · 🆓free" : (item?.isFree === false ? " · 💳paid" : "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!!providerConfigured && models.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    共 {models.length} 个，Free {knownFreeCount} 个，付费 {knownPaidCount} 个，未知 {unknownFreeCount} 个。
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {providerConfigured
                      ? (aiModelsQuery.data?.error || "暂未获取到模型列表，可手动输入模型名称。")
                      : "保存 API Key 后可拉取模型列表。"}
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:max-w-[560px] sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>最大输出</Label>
                  <Input
                    type="number"
                    min={128}
                    max={8192}
                    value={deepseekMaxTokens}
                    onChange={(e) => setDeepseekMaxTokens(Math.min(8192, Math.max(128, Number(e.target.value) || 1024)))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>温度</Label>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={deepseekTemperature}
                    onChange={(e) => setDeepseekTemperature(Math.min(2, Math.max(0, Number(e.target.value) || 0)))}
                  />
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px]">
                <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">普通用户可用 AI 管理</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        关闭后普通用户不能使用 AI 对话执行管理操作。
                      </p>
                    </div>
                    <Switch
                      checked={deepseekTelegramUserManageEnabled}
                      onCheckedChange={setDeepseekTelegramUserManageEnabled}
                    />
                  </div>
                </div>
                <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">机器人信息自动撤回</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        仅对 AI 相关聊天内容生效，默认关闭。
                      </p>
                    </div>
                    <Switch
                      checked={deepseekTelegramAutoRecallEnabled}
                      onCheckedChange={setDeepseekTelegramAutoRecallEnabled}
                    />
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-border/40 bg-background/50 p-3">
                  <Label className="text-xs text-muted-foreground">撤回时间（秒）</Label>
                  <Input
                    type="number"
                    min={30}
                    max={1200}
                    value={deepseekTelegramAutoRecallSeconds}
                    onChange={(e) => setDeepseekTelegramAutoRecallSeconds(Math.min(1200, Math.max(30, Number(e.target.value) || 60)))}
                  />
                  <p className="text-xs text-muted-foreground">范围 30-1200 秒，默认 60 秒。</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSaveDeepSeek} disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  保存 AI 配置
                </Button>
                {providerConfigured && (
                  <Button
                    variant="outline"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setShowDeleteDeepSeekKey(true)}
                    disabled={updateSettingsMutation.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    删除 API Key
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDeleteDeepSeekKey} onOpenChange={setShowDeleteDeepSeekKey}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              删除 AI API Key
            </DialogTitle>
            <DialogDescription>
              删除后会同时关闭 AI 助手，需要重新填写 API Key 后才能启用。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
            <p className="text-xs text-muted-foreground">当前配置</p>
            <p className="mt-1 font-medium">{providerLabel}</p>
            <p className="mt-1 font-medium">{deepseekModel || activeProviderDefaults.model}</p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{activeProviderConfig.apiKeyMasked || "-"}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDeepSeekKey(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleClearDeepSeekKey} disabled={updateSettingsMutation.isPending}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
type SystemSettingsSaveKey =
  | "networkTest"
  | "panelUrl"
  | "registration"
  | "twoFactor"
  | "sessionPolicy"
  | "updateAutoCheck"
  | "ddns"
  | "hostMonitor"
  | "forwardProtocols"
  | "sidebarMenu"
  | "agentInstall";

function isValidWebPort(value: string | number) {
  const port = Math.floor(Number(value));
  return Number.isFinite(port) && port >= 1 && port <= 65535;
}

function normalizeTtl(value: string, fallback: number) {
  const ttl = Math.floor(Number(value));
  if (!Number.isFinite(ttl)) return fallback;
  return Math.min(86400, Math.max(60, ttl));
}

function normalizePublicHostMonitorPathInput(value: string) {
  return String(value || "dev")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

type PersonalizationSaveKey = "title" | "logo" | "theme" | "background" | "homepage";

const personalizationSaveMessages: Record<PersonalizationSaveKey, string> = {
  title: "网站标题已保存",
  logo: "Logo 已保存",
  theme: "默认配色已保存",
  background: "自定义背景已保存",
  homepage: "公开首页已保存",
};

const personalizationSaveErrorMessages: Record<PersonalizationSaveKey, string> = {
  title: "网站标题保存失败",
  logo: "Logo 保存失败",
  theme: "默认配色保存失败",
  background: "自定义背景保存失败",
  homepage: "公开首页保存失败",
};

function PersonalizationSettingsSection() {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const savingSectionRef = useRef<PersonalizationSaveKey | null>(null);
  const [siteTitleInput, setSiteTitleInput] = useState("ForwardX");
  const [siteLogoDataUrl, setSiteLogoDataUrl] = useState("");
  const [personalizationTheme, setPersonalizationTheme] = useState<PersonalizationThemePresetId>("ink");
  const [savedPersonalizationTheme, setSavedPersonalizationTheme] = useState<PersonalizationThemePresetId>("ink");
  const [homepageEnabled, setHomepageEnabled] = useState(true);
  const [homepageCustomEnabled, setHomepageCustomEnabled] = useState(false);
  const [homepageHtml, setHomepageHtml] = useState("");
  const [backgroundConfig, setBackgroundConfig] = useState<PersonalizationBackgroundConfig>(DEFAULT_PERSONALIZATION_BACKGROUND);
  const [backgroundSourceMode, setBackgroundSourceMode] = useState<Exclude<PersonalizationBackgroundConfig["source"], "none">>("builtin");
  const [backgroundUrlInput, setBackgroundUrlInput] = useState("");
  const [backgroundUrlType, setBackgroundUrlType] = useState<PersonalizationBackgroundUrlType>("image");
  const [savingSection, setSavingSection] = useState<PersonalizationSaveKey | null>(null);
  const [compressingLogo, setCompressingLogo] = useState(false);
  const [compressingBackground, setCompressingBackground] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const nextBackground = normalizePersonalizationBackgroundConfig(
      (settings as any).personalizationBackgroundConfig || settings.personalizationBackground,
    );
    setSiteTitleInput(settings.siteTitle || "ForwardX");
    setSiteLogoDataUrl(settings.siteLogoDataUrl || "");
    const nextTheme = normalizePersonalizationThemePresetId((settings as any).personalizationTheme);
    setPersonalizationTheme(nextTheme);
    setSavedPersonalizationTheme(nextTheme);
    setHomepageEnabled(settings.homepageEnabled ?? true);
    setHomepageCustomEnabled(!!settings.homepageCustomEnabled);
    setHomepageHtml(settings.homepageHtml || "");
    setBackgroundConfig(nextBackground);
    setBackgroundSourceMode(nextBackground.source === "none" ? "builtin" : nextBackground.source);
    setBackgroundUrlInput(nextBackground.url || "");
    setBackgroundUrlType(nextBackground.urlType || "image");
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: async () => {
      const key = savingSectionRef.current;
      if (key === "theme") {
        setSavedPersonalizationTheme(personalizationTheme);
        applyPersonalizationTheme(personalizationTheme);
      }
      await Promise.all([
        utils.system.getSettings.invalidate(),
        utils.system.publicInfo.invalidate(),
      ]);
      toast.success(key ? personalizationSaveMessages[key] : "个性化配置已保存");
    },
    onError: (err) => {
      const key = savingSectionRef.current;
      toast.error(err.message || (key ? personalizationSaveErrorMessages[key] : "保存失败"));
    },
    onSettled: () => {
      savingSectionRef.current = null;
      setSavingSection(null);
    },
  });

  const personalizationSaving = updateSettingsMutation.isPending;
  const isSavingPersonalization = (key: PersonalizationSaveKey) => savingSection === key && personalizationSaving;
  const themeDirty = personalizationTheme !== savedPersonalizationTheme;
  const savePersonalizationSection = (
    key: PersonalizationSaveKey,
    payload: Parameters<typeof updateSettingsMutation.mutate>[0],
  ) => {
    if (personalizationSaving) return;
    savingSectionRef.current = key;
    setSavingSection(key);
    updateSettingsMutation.mutate(payload);
  };

  const updateBackground = (patch: Partial<PersonalizationBackgroundConfig>) => {
    setBackgroundConfig((current) => normalizePersonalizationBackgroundConfig({ ...current, ...patch }));
    if (patch.source && patch.source !== "none") setBackgroundSourceMode(patch.source);
  };

  const selectedUploadedBackground = backgroundConfig.images.find((item) => item.id === backgroundConfig.selectedId) || null;
  const selectedBuiltinBackground = BUILTIN_WALLPAPERS.find((item) => item.id === backgroundConfig.selectedId) || null;
  const previewBackgroundUrl =
    backgroundConfig.source === "builtin"
      ? selectedBuiltinBackground?.url || ""
      : backgroundConfig.source === "upload"
        ? selectedUploadedBackground?.dataUrl || ""
        : backgroundConfig.source === "url"
          ? backgroundConfig.url
          : "";
  const previewIsVideo = backgroundConfig.source === "url" && backgroundConfig.urlType === "video";
  const opacityPercent = Math.round(clampBackgroundOpacity(backgroundConfig.opacity) * 100);
  const blurAmount = Math.round(clampBackgroundBlur(backgroundConfig.blur));
  const backgroundEnabled = backgroundConfig.source !== "none" && !!previewBackgroundUrl;
  const mobileBackgroundHint = previewIsVideo
    ? "移动端不会渲染视频背景，并会回退到默认背景，避免浏览器持续解码视频导致卡顿。"
    : "移动端会自动关闭背景虚化和缩放效果，只保留静态背景和不透明度，降低页面滚动卡顿。";
  const previewBackdropStyle = {
    filter: `blur(${blurAmount}px)`,
    transform: `scale(${1.04 + blurAmount / 280})`,
  };
  const backgroundSourceOptions = [
    { value: "builtin" as const, label: "内置壁纸", icon: ImageIcon },
    { value: "upload" as const, label: "上传图片", icon: Upload },
    { value: "url" as const, label: "外部链接", icon: Globe },
  ];

  const handleLogoUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCompressingLogo(true);
      const result = await compressImageFile(file, {
        maxBytes: BRAND_LOGO_MAX_BYTES,
        maxSide: 512,
        preferredType: file.type === "image/png" ? "image/png" : "image/webp",
        minQuality: 0.55,
      });
      setSiteLogoDataUrl(result.dataUrl);
      toast.success(`Logo 已处理为 ${formatBytes(result.size)}`);
    } catch (err: any) {
      toast.error(err?.message || "Logo 上传失败");
    } finally {
      setCompressingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleBackgroundUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCompressingBackground(true);
      const result = await compressImageFile(file, {
        maxBytes: 1.5 * 1024 * 1024,
        maxSide: 1920,
        preferredType: "image/jpeg",
        minQuality: 0.62,
      });
      const item: PersonalizationBackgroundImage = {
        id: createLocalId("wallpaper"),
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "上传背景",
        dataUrl: result.dataUrl,
        size: result.size,
        createdAt: Date.now(),
      };
      setBackgroundConfig((current) => {
        const images = [item, ...current.images].slice(0, 6);
        return normalizePersonalizationBackgroundConfig({
          ...current,
          source: "upload",
          selectedId: item.id,
          urlType: "image",
          images,
        });
      });
      setBackgroundSourceMode("upload");
      toast.success(`背景已处理为 ${formatBytes(result.size)}`);
    } catch (err: any) {
      toast.error(err?.message || "背景上传失败");
    } finally {
      setCompressingBackground(false);
      if (backgroundInputRef.current) backgroundInputRef.current.value = "";
    }
  };

  const handleDeleteUploadedBackground = (id: string) => {
    setBackgroundConfig((current) => {
      const images = current.images.filter((item) => item.id !== id);
      const selectedDeleted = current.source === "upload" && current.selectedId === id;
      return normalizePersonalizationBackgroundConfig({
        ...current,
        source: selectedDeleted ? "none" : current.source,
        selectedId: selectedDeleted ? null : current.selectedId,
        images,
      });
    });
  };

  const applyBackgroundUrl = () => {
    const url = backgroundUrlInput.trim();
    if (!url) {
      toast.error("请填写背景链接");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error("背景链接必须以 http:// 或 https:// 开头");
      return;
    }
    updateBackground({
      source: "url",
      url,
      urlType: backgroundUrlType,
      selectedId: null,
    });
  };

  const handlePreviewHomepage = () => {
    const previewId = createLocalId("homepage");
    const previewKey = `forwardx.homepage.preview.${previewId}`;
    try {
      window.localStorage.setItem(previewKey, homepageHtml);
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    } catch {
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    }
    window.open(`/homepage-preview?mode=draft&id=${encodeURIComponent(previewId)}`, "_blank", "noopener,noreferrer");
  };

  const handleUseHomepageTemplate = async () => {
    if (homepageHtml.trim()) {
      const confirmed = await confirmDialog({
        title: "覆盖首页内容",
        description: "当前编辑内容会被示例模板覆盖，确定继续吗？",
        confirmText: "覆盖",
      });
      if (!confirmed) return;
    }
    setHomepageHtml(createDefaultHomepageHtml(personalizationTheme));
  };

  const handleSaveTitle = () => {
    savePersonalizationSection("title", { siteTitle: siteTitleInput.trim().slice(0, 64) });
  };

  const handleSaveLogo = () => {
    if (siteLogoDataUrl && imageDataUrlSize(siteLogoDataUrl) > BRAND_LOGO_MAX_BYTES) {
      toast.error("Logo 超过 100KB，请重新上传");
      return;
    }
    savePersonalizationSection("logo", { siteLogoDataUrl });
  };

  const handleThemePresetSelect = (theme: PersonalizationThemePresetId) => {
    setPersonalizationTheme(theme);
  };

  const handleSaveThemePreset = () => {
    savePersonalizationSection("theme", { personalizationTheme });
  };

  const handleSaveBackground = () => {
    const nextBackground = normalizePersonalizationBackgroundConfig(backgroundConfig);
    if (nextBackground.source === "url") {
      if (!nextBackground.url.trim()) {
        toast.error("请先应用背景链接");
        return;
      }
      if (!/^https?:\/\//i.test(nextBackground.url.trim())) {
        toast.error("背景链接必须以 http:// 或 https:// 开头");
        return;
      }
    }
    savePersonalizationSection("background", { personalizationBackground: nextBackground });
  };

  const handleResetBackground = () => {
    setBackgroundConfig((current) =>
      normalizePersonalizationBackgroundConfig({
        ...DEFAULT_PERSONALIZATION_BACKGROUND,
        images: current.images,
      }),
    );
  };

  const handleSaveHomepage = () => {
    savePersonalizationSection("homepage", {
      homepageEnabled,
      homepageCustomEnabled,
      homepageHtml,
    });
  };

  if (isLoading) {
    return <DataSectionLoading label="正在加载个性化配置" minHeight="min-h-[220px]" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              网站标题
            </CardTitle>
            <CardDescription>
              配置后台显示的品牌名称。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={siteTitleInput}
                onChange={(event) => setSiteTitleInput(event.target.value.slice(0, 64))}
                placeholder="ForwardX"
                className="flex-1"
              />
              <Button type="button" onClick={handleSaveTitle} disabled={isSavingPersonalization("title")} className="gap-2">
                {isSavingPersonalization("title") && <Loader2 className="h-4 w-4 animate-spin" />}
                保存
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              用于侧边栏、浏览器标题和移动端顶部展示，最多 64 个字符。
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="h-4 w-4 text-primary" />
              Logo
            </CardTitle>
            <CardDescription>
              上传后会用于登录页、公开首页和侧边栏。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-muted/30">
                {siteLogoDataUrl ? (
                  <img src={siteLogoDataUrl} alt="Logo 预览" className="h-full w-full object-contain p-2" />
                ) : (
                  <>
                    <img src="/logo-light.png" alt="默认 Logo" className="h-full w-full object-contain p-2 dark:hidden" />
                    <img src="/logo-dark.png" alt="默认 Logo" className="hidden h-full w-full object-contain p-2 dark:block" />
                  </>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => handleLogoUpload(event.target.files?.[0])}
                  />
                  <Button type="button" variant="outline" onClick={() => logoInputRef.current?.click()} disabled={compressingLogo || isSavingPersonalization("logo")}>
                    {compressingLogo ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                    上传 Logo
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setSiteLogoDataUrl("")} disabled={!siteLogoDataUrl || compressingLogo || isSavingPersonalization("logo")}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    还原默认
                  </Button>
                  <Button type="button" onClick={handleSaveLogo} disabled={compressingLogo || isSavingPersonalization("logo")} className="gap-2">
                    {isSavingPersonalization("logo") && <Loader2 className="h-4 w-4 animate-spin" />}
                    保存 Logo
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  最大 100KB，超过后会在浏览器内自动压缩。
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              默认配色
            </CardTitle>
            <CardDescription>
              选择后保存，按钮、选中态、提示框、侧边栏主色和背景轻微渐变会同步变化。
            </CardDescription>
          </div>
          <Button
            type="button"
            onClick={handleSaveThemePreset}
            disabled={isSavingPersonalization("theme") || !themeDirty}
            className="w-full gap-2 sm:w-auto"
          >
            {isSavingPersonalization("theme") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存配色
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            {PERSONALIZATION_THEME_PRESETS.map((preset) => {
              const active = personalizationTheme === preset.id;
              const saving = isSavingPersonalization("theme") && active;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleThemePresetSelect(preset.id)}
                  disabled={isSavingPersonalization("theme")}
                  className={cn(
                    "group flex min-h-32 flex-col justify-between rounded-lg border bg-background/50 p-3 text-left text-foreground transition hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-70",
                    active ? "border-primary bg-primary/5 ring-2 ring-primary/15" : "border-border/40",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{preset.name}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {preset.description}
                      </p>
                    </div>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : active ? (
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                      ) : null}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    {preset.swatches.map((color) => (
                      <span
                        key={color}
                        className="h-7 w-7 rounded-full border border-background shadow-sm ring-1 ring-border/60"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" />
              自定义背景
            </CardTitle>
            <CardDescription>
              默认不使用背景，可选择内置、上传或链接背景。
            </CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" onClick={handleResetBackground} disabled={isSavingPersonalization("background")} className="w-full gap-2 sm:w-auto">
              <RefreshCw className="h-4 w-4" />
              恢复默认
            </Button>
            <Button type="button" onClick={handleSaveBackground} disabled={compressingBackground || isSavingPersonalization("background")} className="w-full gap-2 sm:w-auto">
              {isSavingPersonalization("background") && <Loader2 className="h-4 w-4 animate-spin" />}
              保存背景
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-4">
              <div className="relative min-h-52 overflow-hidden rounded-lg border border-border/40 bg-muted/30">
                {previewBackgroundUrl ? (
                  previewIsVideo ? (
                    <video
                      src={previewBackgroundUrl}
                      muted
                      loop
                      playsInline
                      autoPlay
                      className="absolute inset-0 h-full w-full object-cover opacity-70 transition-[filter,transform] duration-200"
                      style={previewBackdropStyle}
                    />
                  ) : (
                    <img
                      src={previewBackgroundUrl}
                      alt=""
                      aria-hidden="true"
                      loading="eager"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover opacity-70 transition-[filter,transform] duration-200"
                      style={previewBackdropStyle}
                    />
                  )
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
                    未启用背景
                  </div>
                )}
                {previewBackgroundUrl && (
                  <div
                    className="absolute inset-0 bg-background"
                    style={{ opacity: 1 - clampBackgroundOpacity(backgroundConfig.opacity) }}
                  />
                )}
                {previewBackgroundUrl && (
                  <div className="absolute right-3 top-3 flex aspect-video w-28 max-w-[38%] items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background/70 p-1 shadow-sm backdrop-blur sm:w-32">
                    {previewIsVideo ? (
                      <video
                        src={previewBackgroundUrl}
                        muted
                        loop
                        playsInline
                        autoPlay
                        className="h-full w-full rounded-[4px] object-contain"
                      />
                    ) : (
                      <img
                        src={previewBackgroundUrl}
                        alt="背景原图预览"
                        loading="eager"
                        decoding="async"
                        className="h-full w-full rounded-[4px] object-contain"
                      />
                    )}
                  </div>
                )}
                <div className="absolute bottom-3 left-3 rounded-md border border-border/50 bg-background/75 px-3 py-2 text-xs backdrop-blur">
                  {backgroundEnabled ? `不透明度 ${opacityPercent}% / 虚化 ${blurAmount}px` : "无背景"}
                </div>
              </div>

              {backgroundEnabled && (
                <div className="space-y-3">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                      <div className="space-y-2">
                        <Label>背景不透明度</Label>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={opacityPercent}
                          onChange={(event) => updateBackground({ opacity: Number(event.target.value) / 100 })}
                          className="w-full accent-primary"
                        />
                      </div>
                      <Input
                        value={String(opacityPercent)}
                        onChange={(event) => {
                          const value = Math.min(100, Math.max(0, Number(event.target.value.replace(/\D/g, "") || 0)));
                          updateBackground({ opacity: value / 100 });
                        }}
                        inputMode="numeric"
                        className="sm:mt-6"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                      <div className="space-y-2">
                        <Label>背景虚化程度</Label>
                        <input
                          type="range"
                          min={0}
                          max={32}
                          step={1}
                          value={blurAmount}
                          onChange={(event) => updateBackground({ blur: Number(event.target.value) })}
                          className="w-full accent-primary"
                        />
                      </div>
                      <Input
                        value={String(blurAmount)}
                        onChange={(event) => {
                          const value = Math.min(32, Math.max(0, Number(event.target.value.replace(/\D/g, "") || 0)));
                          updateBackground({ blur: value });
                        }}
                        inputMode="numeric"
                        className="sm:mt-6"
                      />
                    </div>
                  </div>
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    {mobileBackgroundHint}
                  </div>
                </div>
              )}

            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {backgroundSourceOptions.map((option) => {
                  const Icon = option.icon;
                  const active = backgroundSourceMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setBackgroundSourceMode(option.value)}
                      className={cn(
                        "flex min-h-10 items-center justify-center gap-2 rounded-lg border px-2 text-sm transition",
                        active ? "border-primary bg-primary/10 text-primary" : "border-border/40 bg-muted/20 hover:border-primary/50",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>

              {backgroundSourceMode === "builtin" && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">内置壁纸</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                    {BUILTIN_WALLPAPERS.map((item) => {
                      const active = backgroundConfig.source === "builtin" && backgroundConfig.selectedId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => updateBackground({ source: "builtin", selectedId: item.id, urlType: "image" })}
                          className={cn(
                            "group overflow-hidden rounded-lg border bg-muted/20 text-left transition",
                            active ? "border-primary ring-2 ring-primary/25" : "border-border/40 hover:border-primary/50",
                          )}
                        >
                          <img
                            src={item.url}
                            alt={item.name}
                            loading="lazy"
                            decoding="async"
                            className="aspect-[16/9] w-full bg-muted/40 object-contain transition-transform group-hover:scale-[1.02]"
                          />
                          <div className="px-3 py-2 text-xs font-medium">{item.name}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {backgroundSourceMode === "upload" && (
                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">上传背景</p>
                      <p className="text-xs text-muted-foreground">最多保留 6 张，单张最大 1.5MB，超过会自动压缩。</p>
                    </div>
                    <div>
                      <input
                        ref={backgroundInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => handleBackgroundUpload(event.target.files?.[0])}
                      />
                      <Button type="button" variant="outline" onClick={() => backgroundInputRef.current?.click()} disabled={compressingBackground || isSavingPersonalization("background")}>
                        {compressingBackground ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                        上传背景
                      </Button>
                    </div>
                  </div>
                  {backgroundConfig.images.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {backgroundConfig.images.map((item) => {
                        const active = backgroundConfig.source === "upload" && backgroundConfig.selectedId === item.id;
                        return (
                          <div
                            key={item.id}
                            className={cn(
                              "overflow-hidden rounded-lg border bg-muted/20",
                              active ? "border-primary ring-2 ring-primary/25" : "border-border/40",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => updateBackground({ source: "upload", selectedId: item.id, urlType: "image" })}
                              className="block w-full text-left"
                            >
                              <img src={item.dataUrl} alt={item.name} loading="lazy" decoding="async" className="aspect-[16/9] w-full bg-muted/40 object-contain" />
                            </button>
                            <div className="flex items-center justify-between gap-2 px-3 py-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium" title={item.name}>{item.name}</p>
                                <p className="text-[11px] text-muted-foreground">{formatBytes(item.size || imageDataUrlSize(item.dataUrl))}</p>
                              </div>
                              <Button type="button" variant="ghost" size="icon" onClick={() => handleDeleteUploadedBackground(item.id)} aria-label={`删除 ${item.name}`}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground">
                      还没有上传背景。
                    </div>
                  )}
                </div>
              )}

              {backgroundSourceMode === "url" && (
                <div className="space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium">自定义链接</p>
                    <Button variant="outline" size="sm" className="w-full gap-1.5 sm:w-auto" asChild>
                      <a href="https://c.7zz.cn/home?path=cloudreve%3A%2F%2FVaU6%40share" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                        动态 MP4 视频库
                      </a>
                    </Button>
                  </div>
                  <div className="grid gap-2 lg:grid-cols-[9rem_minmax(0,1fr)_auto]">
                    <Select value={backgroundUrlType} onValueChange={(value) => setBackgroundUrlType(value as PersonalizationBackgroundUrlType)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="image">图片链接</SelectItem>
                        <SelectItem value="video">视频链接</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={backgroundUrlInput}
                      onChange={(event) => setBackgroundUrlInput(event.target.value)}
                      placeholder="https://example.com/background.jpg"
                    />
                    <Button type="button" variant="outline" onClick={applyBackgroundUrl}>
                      应用链接
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    视频背景会静音循环播放，建议使用 HTTPS 链接；移动端不会展示视频背景。
                  </p>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              公开首页
            </CardTitle>
            <CardDescription>
              设置未登录时展示的首页。
            </CardDescription>
          </div>
          <Button type="button" onClick={handleSaveHomepage} disabled={isSavingPersonalization("homepage")} className="w-full gap-2 sm:w-auto">
            {isSavingPersonalization("homepage") && <Loader2 className="h-4 w-4 animate-spin" />}
            保存首页
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">启用公开首页</p>
                <p className="text-xs text-muted-foreground">关闭后直接进入登录页。</p>
              </div>
              <Switch checked={homepageEnabled} onCheckedChange={setHomepageEnabled} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">使用自定义 H5</p>
                <p className="text-xs text-muted-foreground">优先展示自定义页面。</p>
              </div>
              <Switch checked={homepageCustomEnabled} onCheckedChange={setHomepageCustomEnabled} />
            </div>
          </div>
          {homepageCustomEnabled && (
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label className="text-sm font-medium">首页 H5/HTML 代码</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    支持完整 HTML 或 body 内容。
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleUseHomepageTemplate}>
                    使用示例
                  </Button>
                  <Button variant="outline" size="sm" onClick={handlePreviewHomepage} className="gap-2">
                    <Eye className="h-4 w-4" />
                    预览
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/homepage-preview" target="_blank" rel="noopener noreferrer">
                      查看已保存
                    </a>
                  </Button>
                </div>
              </div>
              <Textarea
                value={homepageHtml}
                onChange={(e) => setHomepageHtml(e.target.value)}
                placeholder="粘贴你的首页 H5/HTML 代码"
                className="min-h-72 font-mono text-xs leading-5"
              />
              <p className="text-xs text-muted-foreground">
                {homepageHtml.length.toLocaleString()} / 60,000 字符
              </p>
            </div>
          )}
        </CardContent>
      </Card>


    </div>
  );
}

function SystemInfoSection() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const { data: upgradeStatus, refetch: refetchUpgradeStatus } = trpc.system.upgradeStatus.useQuery(
    undefined,
    { refetchInterval: pollingInterval("fast") }
  );
  const [panelUrlInput, setPanelUrlInput] = useState("");
  const [webPortInput, setWebPortInput] = useState("");
  const [panelSslEnabled, setPanelSslEnabled] = useState(false);
  const [panelSslMode, setPanelSslMode] = useState<"path" | "pem">("path");
  const [panelSslCertPath, setPanelSslCertPath] = useState("");
  const [panelSslKeyPath, setPanelSslKeyPath] = useState("");
  const [panelSslCertPem, setPanelSslCertPem] = useState("");
  const [panelSslKeyPem, setPanelSslKeyPem] = useState("");
  const [showWebPortConfirm, setShowWebPortConfirm] = useState(false);
  const [webPortCountdown, setWebPortCountdown] = useState(5);
  const [showPanelSslConfirm, setShowPanelSslConfirm] = useState(false);
  const [panelSslCountdown, setPanelSslCountdown] = useState(5);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [lookingGlassUserEnabled, setLookingGlassUserEnabled] = useState(true);
  const [forwardProtocols, setForwardProtocols] = useState<ForwardProtocolSettings>(() => normalizeForwardProtocolSettings());
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuSettings>(() => normalizeSidebarMenuSettings());
  const [githubAcceleratorEnabled, setGithubAcceleratorEnabled] = useState(false);
  const [githubAcceleratorUrlInput, setGithubAcceleratorUrlInput] = useState(defaultGithubAcceleratorUrl);
  const [agentPreferPanelInstall, setAgentPreferPanelInstall] = useState(false);
  const [ddnsEnabled, setDdnsEnabled] = useState(false);
  const [ddnsProvider, setDdnsProvider] = useState<DdnsProvider>("disabled");
  const [ddnsTtl, setDdnsTtl] = useState("600");
  const [ddnsCloudflareApiToken, setDdnsCloudflareApiToken] = useState("");
  const [ddnsHuaweiCloudAccessKeyId, setDdnsHuaweiCloudAccessKeyId] = useState("");
  const [ddnsHuaweiCloudSecretKey, setDdnsHuaweiCloudSecretKey] = useState("");
  const [ddnsHuaweiCloudRegion, setDdnsHuaweiCloudRegion] = useState("cn-north-4");
  const [ddnsHuaweiCloudEndpoint, setDdnsHuaweiCloudEndpoint] = useState("");
  const [ddnsHuaweiCloudZoneId, setDdnsHuaweiCloudZoneId] = useState("");
  const [ddnsHuaweiCloudLine, setDdnsHuaweiCloudLine] = useState("default_view");
  const [ddnsAliyunAccessKeyId, setDdnsAliyunAccessKeyId] = useState("");
  const [ddnsAliyunAccessKeySecret, setDdnsAliyunAccessKeySecret] = useState("");
  const [ddnsAliyunDomainName, setDdnsAliyunDomainName] = useState("");
  const [ddnsAliyunEndpoint, setDdnsAliyunEndpoint] = useState("https://alidns.aliyuncs.com");
  const [ddnsAliyunLine, setDdnsAliyunLine] = useState("default");
  const [ddnsTencentCloudSecretId, setDdnsTencentCloudSecretId] = useState("");
  const [ddnsTencentCloudSecretKey, setDdnsTencentCloudSecretKey] = useState("");
  const [ddnsTencentCloudDomainName, setDdnsTencentCloudDomainName] = useState("");
  const [ddnsTencentCloudRecordLine, setDdnsTencentCloudRecordLine] = useState("默认");
  const [ddnsTencentCloudRecordLineId, setDdnsTencentCloudRecordLineId] = useState("");
  const [ddnsWebhookUrl, setDdnsWebhookUrl] = useState("");
  const [ddnsWebhookMethod, setDdnsWebhookMethod] = useState<"POST" | "PUT" | "GET">("POST");
  const [ddnsWebhookHeaders, setDdnsWebhookHeaders] = useState("");
  const [publicHostMonitorEnabled, setPublicHostMonitorEnabled] = useState(false);
  const [publicHostMonitorPath, setPublicHostMonitorPath] = useState("dev");
  const [publicHostMonitorTitle, setPublicHostMonitorTitle] = useState("");
  const [allowMultiDeviceLogin, setAllowMultiDeviceLogin] = useState(false);
  const [updateAutoCheckEnabled, setUpdateAutoCheckEnabled] = useState(true);
  const [showForwardProtocolDialog, setShowForwardProtocolDialog] = useState(false);
  const [showSidebarMenuDialog, setShowSidebarMenuDialog] = useState(false);
  const [savingSetting, setSavingSetting] = useState<SystemSettingsSaveKey | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showRollbackDialog, setShowRollbackDialog] = useState(false);
  const [rollbackType, setRollbackType] = useState<"panel" | "agent">("panel");
  const [selectedRollbackVersion, setSelectedRollbackVersion] = useState("");
  const [showDockerUpgradeScript, setShowDockerUpgradeScript] = useState(false);
  const previousUpgradeStatus = useRef<string | null>(null);
  const shownDockerUpgradeVersion = useRef<string | null>(null);
  const lastPanelUpdateCheck = useRef(0);
  const rollbackVersionsQuery = trpc.system.rollbackVersions.useQuery(
    { force: false },
    { enabled: showRollbackDialog, refetchOnWindowFocus: false, retry: false }
  );

  useEffect(() => {
    if (settings) {
      setPanelUrlInput(settings.panelPublicUrl || "");
      setWebPortInput(String(settings.webPort || 3000));
      setPanelSslEnabled(!!settings.panelSsl?.enabled);
      setPanelSslMode(settings.panelSsl?.mode === "pem" ? "pem" : "path");
      setPanelSslCertPath(settings.panelSsl?.certPath || "");
      setPanelSslKeyPath(settings.panelSsl?.keyPath || "");
      setPanelSslCertPem(settings.panelSsl?.certPem || "");
      setPanelSslKeyPem(settings.panelSsl?.keyPem || "");
      setRegistrationEnabled(settings.registrationEnabled ?? true);
      setTwoFactorEnabled(!!settings.twoFactorEnabled);
      setLookingGlassUserEnabled(settings.lookingGlassUserEnabled ?? true);
      setAllowMultiDeviceLogin(!!settings.allowMultiDeviceLogin);
      setUpdateAutoCheckEnabled(settings.upgrade?.autoCheckEnabled !== false);
      setForwardProtocols(normalizeForwardProtocolSettings(settings.forwardProtocols));
      setSidebarMenu(normalizeSidebarMenuSettings({
        ...settings.sidebarMenu,
        plugins: settings.pluginsEnabled === true || settings.sidebarMenu?.plugins === true,
      }));
      setGithubAcceleratorEnabled(!!settings.githubAccelerator?.enabled);
      setGithubAcceleratorUrlInput(settings.githubAccelerator?.url || "");
      setAgentPreferPanelInstall(!!settings.agentPreferPanelInstall);
      setDdnsEnabled(!!settings.ddns?.enabled);
      setDdnsProvider(isDdnsProvider(settings.ddns?.provider) ? settings.ddns.provider : "disabled");
      const ddnsUnifiedTtl = String(settings.ddns?.ttl || settings.ddns?.huaweicloudTtl || settings.ddns?.aliyunTtl || settings.ddns?.tencentcloudTtl || 600);
      setDdnsTtl(ddnsUnifiedTtl);
      setDdnsHuaweiCloudAccessKeyId(settings.ddns?.huaweicloudAccessKeyId || "");
      setDdnsHuaweiCloudRegion(settings.ddns?.huaweicloudRegion || "cn-north-4");
      setDdnsHuaweiCloudEndpoint(settings.ddns?.huaweicloudEndpoint || "");
      setDdnsHuaweiCloudZoneId(settings.ddns?.huaweicloudZoneId || "");
      setDdnsHuaweiCloudLine(settings.ddns?.huaweicloudLine || "default_view");
      setDdnsAliyunAccessKeyId(settings.ddns?.aliyunAccessKeyId || "");
      setDdnsAliyunDomainName(settings.ddns?.aliyunDomainName || "");
      setDdnsAliyunEndpoint(settings.ddns?.aliyunEndpoint || "https://alidns.aliyuncs.com");
      setDdnsAliyunLine(settings.ddns?.aliyunLine || "default");
      setDdnsTencentCloudSecretId(settings.ddns?.tencentcloudSecretId || "");
      setDdnsTencentCloudDomainName(settings.ddns?.tencentcloudDomainName || "");
      setDdnsTencentCloudRecordLine(settings.ddns?.tencentcloudRecordLine || "默认");
      setDdnsTencentCloudRecordLineId(settings.ddns?.tencentcloudRecordLineId || "");
      setDdnsWebhookUrl(settings.ddns?.webhookUrl || "");
      setDdnsWebhookMethod((settings.ddns?.webhookMethod === "PUT" || settings.ddns?.webhookMethod === "GET") ? settings.ddns.webhookMethod : "POST");
      setDdnsWebhookHeaders(settings.ddns?.webhookHeaders || "");
      if (settings.publicHostMonitor) {
        setPublicHostMonitorEnabled(!!settings.publicHostMonitor.enabled);
        setPublicHostMonitorPath(settings.publicHostMonitor.path || "dev");
        setPublicHostMonitorTitle(settings.publicHostMonitor.title || "");
      }
    }
  }, [settings]);

  useEffect(() => {
    if (!showWebPortConfirm) return;
    setWebPortCountdown(5);
    const timer = window.setInterval(() => {
      setWebPortCountdown((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showWebPortConfirm]);

  useEffect(() => {
    if (!showPanelSslConfirm) return;
    setPanelSslCountdown(5);
    const timer = window.setInterval(() => {
      setPanelSslCountdown((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showPanelSslConfirm]);

  useEffect(() => {
    const status = upgradeStatus?.job?.status;
    if (!status || status === "idle") return;
    const previous = previousUpgradeStatus.current;
    const actionLabel = upgradeStatus?.job?.mode === "rollback" ? "回退" : "升级";
    if (previous === "running" && status === "success") {
      toast.success(`面板${actionLabel}成功，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`);
    }
    if (previous === "running" && status === "waiting_assets") {
      toast.info(upgradeStatus?.job?.error || "发布资产仍在构建中，请稍后重试");
    }
    if (previous === "running" && status === "error") {
      toast.error(upgradeStatus?.job?.error || `面板${actionLabel}失败`);
    }
    previousUpgradeStatus.current = status;
  }, [upgradeStatus?.job?.status, upgradeStatus?.job?.error]);

  useEffect(() => {
    if (!showRollbackDialog) return;
    const versions = rollbackType === "panel"
      ? (rollbackVersionsQuery.data?.panelVersions || []).map((item: any) => item.panelVersion)
      : (rollbackVersionsQuery.data?.agentVersions || []).map((item: any) => item.agentVersion);
    if (versions.length === 0) {
      setSelectedRollbackVersion("");
      return;
    }
    if (!selectedRollbackVersion || !versions.includes(selectedRollbackVersion)) {
      setSelectedRollbackVersion(versions[0]);
    }
  }, [
    rollbackType,
    rollbackVersionsQuery.data?.agentVersions,
    rollbackVersionsQuery.data?.panelVersions,
    selectedRollbackVersion,
    showRollbackDialog,
  ]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      toast.success("面板设置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
    onSettled: () => setSavingSetting(null),
  });

  const updateWebPortMutation = trpc.system.updateWebPort.useMutation({
    onSuccess: (result) => {
      utils.system.getSettings.invalidate();
      if (result.restartScheduled) {
        toast.success(`Web 端口已修改为 ${result.port}，服务正在重启`);
      } else {
        toast.info("Web 端口未变化");
      }
      setShowWebPortConfirm(false);
    },
    onError: (err) => toast.error(err.message || "修改 Web 端口失败"),
  });

  const updatePanelSslMutation = trpc.system.updatePanelSsl.useMutation({
    onSuccess: (result) => {
      utils.system.getSettings.invalidate();
      if (result.restartScheduled) {
        toast.success(result.enabled ? "面板 SSL 已开启，服务正在重启" : "面板 SSL 已关闭，服务正在重启");
      } else {
        toast.info("面板 SSL 配置未变化");
      }
      setShowPanelSslConfirm(false);
    },
    onError: (err) => toast.error(err.message || "保存面板 SSL 配置失败"),
  });

  const generatePanelSelfSignedMutation = trpc.system.generatePanelSelfSignedCertificate.useMutation({
    onSuccess: (result) => {
      setPanelSslMode("path");
      setPanelSslCertPath(result.certPath);
      setPanelSslKeyPath(result.keyPath);
      utils.system.getSettings.invalidate();
      toast.success("自签证书已生成并填入路径");
    },
    onError: (err) => toast.error(err.message || "生成自签证书失败"),
  });

  const saveSystemSettings = (
    key: SystemSettingsSaveKey,
    payload: Parameters<typeof updateSettingsMutation.mutate>[0],
    options?: Parameters<typeof updateSettingsMutation.mutate>[1],
  ) => {
    setSavingSetting(key);
    updateSettingsMutation.mutate(payload, options);
  };

  const isSavingSetting = (key: SystemSettingsSaveKey) => (
    savingSetting === key && updateSettingsMutation.isPending
  );
  const webPortManagement = settings?.webPortManagement;
  const webPortDisplay = Number(settings?.webPort || webPortManagement?.publicPort || 3000);
  const webContainerPort = Number(webPortManagement?.containerPort || webPortDisplay);
  const isDockerWebPort = !!webPortManagement?.docker;
  const webPortChangeDisabled = !settings?.webPortManagement?.enabled || updateWebPortMutation.isPending;
  const publicHostMonitorNormalizedPath = normalizePublicHostMonitorPathInput(publicHostMonitorPath) || "dev";
  const publicHostMonitorUrl = useMemo(() => {
    const base = (settings?.panelPublicUrl || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/+$/, "");
    return base ? `${base}/${publicHostMonitorNormalizedPath}` : `/${publicHostMonitorNormalizedPath}`;
  }, [publicHostMonitorNormalizedPath, settings?.panelPublicUrl]);

  const handleSavePanelUrl = () => {
    const v = panelUrlInput.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      toast.error("面板公开地址必须以 http:// 或 https:// 开头");
      return;
    }
    saveSystemSettings("panelUrl", { panelPublicUrl: v });
  };

  const handleSaveLookingGlass = () => {
    saveSystemSettings("networkTest", { lookingGlassUserEnabled }, {
      onSuccess: () => utils.system.publicInfo.invalidate(),
    });
  };

  const openWebPortConfirm = () => {
    if (!settings?.webPortManagement?.enabled) {
      toast.info(isDockerWebPort ? "Docker 部署的访问端口由宿主机端口映射管理，请在部署配置中修改。" : "当前环境不支持在后台修改 Web 端口。");
      return;
    }
    const port = Math.floor(Number(webPortInput));
    if (!isValidWebPort(webPortInput)) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    if (port === webPortDisplay) {
      toast.info("端口未变化");
      return;
    }
    setShowWebPortConfirm(true);
  };

  const confirmWebPortChange = () => {
    if (!isValidWebPort(webPortInput)) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    updateWebPortMutation.mutate({ port: Math.floor(Number(webPortInput)), confirmed: true });
  };

  const openPanelSslConfirm = () => {
    if (panelSslEnabled && (!panelSslCertPath.trim() || !panelSslKeyPath.trim())) {
      toast.error("开启面板 SSL 需要填写证书文件和私钥文件路径");
      return;
    }
    setShowPanelSslConfirm(true);
  };

  const confirmPanelSslChange = () => {
    if (panelSslEnabled && (!panelSslCertPath.trim() || !panelSslKeyPath.trim())) {
      toast.error("开启面板 SSL 需要填写证书文件和私钥文件路径");
      return;
    }
    updatePanelSslMutation.mutate({
      enabled: panelSslEnabled,
      certPath: panelSslCertPath.trim(),
      keyPath: panelSslKeyPath.trim(),
      confirmed: true,
    });
  };

  const validatePanelSslDraft = () => {
    if (!panelSslEnabled) return true;
    if (panelSslMode === "path") {
      if (!panelSslCertPath.trim() || !panelSslKeyPath.trim()) {
        toast.error("开启面板 SSL 需要填写证书文件和私钥文件路径");
        return false;
      }
      return true;
    }
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(panelSslCertPem.trim())) {
      toast.error("证书内容不是有效的 PEM 证书");
      return false;
    }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(panelSslKeyPem.trim())) {
      toast.error("私钥内容不是有效的 PEM 私钥");
      return false;
    }
    return true;
  };

  const openPanelSslConfirmV2 = () => {
    if (!validatePanelSslDraft()) return;
    setShowPanelSslConfirm(true);
  };

  const confirmPanelSslChangeV2 = () => {
    if (!validatePanelSslDraft()) return;
    updatePanelSslMutation.mutate({
      enabled: panelSslEnabled,
      mode: panelSslMode,
      certPath: panelSslCertPath.trim(),
      keyPath: panelSslKeyPath.trim(),
      certPem: panelSslCertPem.trim(),
      keyPem: panelSslKeyPem.trim(),
      confirmed: true,
    });
  };

  const handleGeneratePanelSelfSigned = () => {
    const hosts = [panelUrlInput].filter(Boolean);
    generatePanelSelfSignedMutation.mutate({ hosts, days: 825 });
  };

  const handleSaveRegistration = () => {
    saveSystemSettings("registration", { registrationEnabled });
  };

  const handleSaveTwoFactor = () => {
    saveSystemSettings("twoFactor", { twoFactorEnabled });
  };

  const handleSaveDdns = () => {
    const huaweicloudEndpoint = normalizeConfigUrl(ddnsHuaweiCloudEndpoint);
    const aliyunEndpoint = normalizeConfigUrl(ddnsAliyunEndpoint);
    if (huaweicloudEndpoint && !/^https?:\/\//i.test(huaweicloudEndpoint)) {
      toast.error("华为云 Endpoint 需要以 http:// 或 https:// 开头");
      return;
    }
    if (aliyunEndpoint && !/^https?:\/\//i.test(aliyunEndpoint)) {
      toast.error("阿里云 Endpoint 需要以 http:// 或 https:// 开头");
      return;
    }
    const ttl = normalizeTtl(ddnsTtl, Number(settings?.ddns?.ttl || 600));
    saveSystemSettings("ddns", {
      ddns: {
        enabled: ddnsEnabled,
        provider: ddnsProvider,
        ttl,
        cloudflareZoneId: "",
        cloudflareApiToken: ddnsCloudflareApiToken.trim() || undefined,
        huaweicloudAccessKeyId: ddnsHuaweiCloudAccessKeyId,
        huaweicloudSecretKey: ddnsHuaweiCloudSecretKey.trim() || undefined,
        huaweicloudRegion: ddnsHuaweiCloudRegion,
        huaweicloudEndpoint,
        huaweicloudZoneId: ddnsHuaweiCloudZoneId,
        huaweicloudTtl: ttl,
        huaweicloudLine: ddnsHuaweiCloudLine,
        aliyunAccessKeyId: ddnsAliyunAccessKeyId,
        aliyunAccessKeySecret: ddnsAliyunAccessKeySecret.trim() || undefined,
        aliyunDomainName: ddnsAliyunDomainName,
        aliyunEndpoint,
        aliyunTtl: ttl,
        aliyunLine: ddnsAliyunLine,
        tencentcloudSecretId: ddnsTencentCloudSecretId,
        tencentcloudSecretKey: ddnsTencentCloudSecretKey.trim() || undefined,
        tencentcloudDomainName: ddnsTencentCloudDomainName,
        tencentcloudTtl: ttl,
        tencentcloudRecordLine: ddnsTencentCloudRecordLine,
        tencentcloudRecordLineId: ddnsTencentCloudRecordLineId,
        webhookUrl: ddnsWebhookUrl,
        webhookMethod: ddnsWebhookMethod,
        webhookHeaders: ddnsWebhookHeaders,
      },
    }, {
      onSuccess: () => {
        setDdnsCloudflareApiToken("");
        setDdnsHuaweiCloudSecretKey("");
        setDdnsAliyunAccessKeySecret("");
        setDdnsTencentCloudSecretKey("");
      },
    });
  };

  const handleSavePublicHostMonitor = () => {
    const path = normalizePublicHostMonitorPathInput(publicHostMonitorPath) || "dev";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(path)) {
      toast.error("主机监控面板路径只能包含小写字母、数字、短横线或下划线，且不能超过 64 个字符");
      return;
    }
    saveSystemSettings("hostMonitor", {
      publicHostMonitor: {
        enabled: publicHostMonitorEnabled,
        path,
        title: publicHostMonitorTitle.trim(),
      },
    }, {
      onSuccess: () => {
        setPublicHostMonitorPath(path);
        setPublicHostMonitorTitle(publicHostMonitorTitle.trim());
        utils.system.getSettings.invalidate();
        utils.system.publicInfo.invalidate();
      },
    });
  };

  const handleSaveSessionPolicy = () => {
    saveSystemSettings("sessionPolicy", { allowMultiDeviceLogin });
  };

  const handleUpdateAutoCheckChange = (checked: boolean) => {
    setUpdateAutoCheckEnabled(checked);
    saveSystemSettings(
      "updateAutoCheck",
      { updateAutoCheckEnabled: checked },
      {
        onSuccess: () => {
          utils.system.getSettings.invalidate();
          utils.system.publicInfo.invalidate();
        },
      },
    );
  };

  const resetForwardProtocolDraft = () => {
    setForwardProtocols(normalizeForwardProtocolSettings(settings?.forwardProtocols));
  };

  const openForwardProtocolDialog = () => {
    resetForwardProtocolDraft();
    setShowForwardProtocolDialog(true);
  };

  const closeForwardProtocolDialog = () => {
    resetForwardProtocolDraft();
    setShowForwardProtocolDialog(false);
  };

  const handleSaveForwardProtocols = () => {
    saveSystemSettings(
      "forwardProtocols",
      { forwardProtocols },
      { onSuccess: () => setShowForwardProtocolDialog(false) },
    );
  };

  const resetSidebarMenuDraft = () => {
    setSidebarMenu(normalizeSidebarMenuSettings({
      ...settings?.sidebarMenu,
      plugins: settings?.pluginsEnabled === true,
    }));
  };

  const openSidebarMenuDialog = () => {
    resetSidebarMenuDraft();
    setShowSidebarMenuDialog(true);
  };

  const closeSidebarMenuDialog = () => {
    resetSidebarMenuDraft();
    setShowSidebarMenuDialog(false);
  };

  const handleSaveSidebarMenu = () => {
    const nextSidebarMenu = normalizeSidebarMenuSettings(sidebarMenu);
    saveSystemSettings(
      "sidebarMenu",
      { sidebarMenu: nextSidebarMenu, pluginsEnabled: nextSidebarMenu.plugins },
      {
        onSuccess: () => {
          setShowSidebarMenuDialog(false);
          utils.system.getSettings.invalidate();
          utils.system.publicInfo.invalidate();
        },
      },
    );
  };

  const handleSaveAgentInstall = () => {
    const acceleratorUrl = normalizeConfigUrl(githubAcceleratorUrlInput);
    if (acceleratorUrl && !/^https?:\/\//i.test(acceleratorUrl)) {
      toast.error("GitHub 加速地址必须以 http:// 或 https:// 开头");
      return;
    }
    saveSystemSettings("agentInstall", {
      githubAccelerator: {
        enabled: githubAcceleratorEnabled,
        url: acceleratorUrl,
      },
      agentPreferPanelInstall,
    });
  };

  const setForwardProtocolEnabled = (key: keyof ForwardProtocolSettings, enabled: boolean) => {
    setForwardProtocols((prev) => ({ ...prev, [key]: enabled }));
  };

  const setSidebarMenuEnabled = (key: SidebarMenuKey, enabled: boolean) => {
    setSidebarMenu((prev) => ({ ...prev, [key]: enabled }));
  };

  const copyTextToClipboard = async (text: string) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    if (copied) toast.success("已复制到剪贴板");
    else toast.error("复制失败，请手动复制");
  };

  const startUpgradeMutation = trpc.system.startUpgrade.useMutation({
    onSuccess: async (result) => {
      if (result?.pendingReason) {
        toast.info(result.pendingReason);
      } else {
        toast.success("升级任务已启动");
      }
      await refetchUpgradeStatus();
    },
    onError: (err) => toast.error(err.message || "启动升级失败"),
  });

  const startRollbackMutation = trpc.system.startVersionRollback.useMutation({
    onSuccess: async (result) => {
      if ((result as any)?.pendingReason) {
        toast.info((result as any).pendingReason);
      } else if ((result as any)?.type === "agent") {
        toast.success(`Agent 回退任务已下发 ${((result as any).requested || 0)} 台，实时推送 ${((result as any).pushed || 0)} 台`);
      } else {
        toast.success("面板回退任务已启动");
      }
      setShowRollbackDialog(false);
      await refetchUpgradeStatus();
      utils.hosts.list.invalidate();
    },
    onError: (err) => toast.error(err.message || "启动回退失败"),
  });

  const refreshRollbackVersions = async () => {
    await utils.system.rollbackVersions.fetch({ force: true });
    await rollbackVersionsQuery.refetch();
  };

  const openRollbackDialog = async () => {
    setRollbackType("panel");
    setSelectedRollbackVersion("");
    setShowRollbackDialog(true);
    try {
      await refreshRollbackVersions();
    } catch {
      // The dialog will render the query error.
    }
  };

  const handleCheckUpdate = async () => {
    const now = Date.now();
    const cooldownMs = 60 * 1000;
    const waitMs = cooldownMs - (now - lastPanelUpdateCheck.current);
    if (waitMs > 0) {
      toast.info(`请 ${Math.ceil(waitMs / 1000)} 秒后重试`);
      return;
    }
    try {
      setCheckingUpdate(true);
      lastPanelUpdateCheck.current = now;
      await utils.system.checkUpdate.fetch({ force: true });
      await refetchUpgradeStatus();
      toast.success("版本检查完成");
    } catch (err: any) {
      toast.error(err?.message || "检查更新失败");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateInfo = upgradeStatus?.update;
  const upgradeEnabled = !!upgradeStatus?.upgradeEnabled;
  const isDockerDeployment = !!upgradeStatus?.docker || !!settings?.upgrade?.docker;
  const upgradeChangelogUrl = getPanelChangelogUrl(updateInfo?.latestVersion || upgradeStatus?.currentVersion || settings?.version, updateInfo?.releaseUrl);
  const dockerPanelUpgradeCommand =
    upgradeStatus?.manualUpgradeCommand ||
    settings?.upgrade?.manualUpgradeCommand ||
    manualPanelUpgradeCommands[1].command;
  const canShowDockerUpgradeScript =
    isDockerDeployment &&
    !!updateInfo?.latestVersion &&
    (updateInfo.hasUpdate || (!!updateInfo.pendingReason && !updateInfo.error));
  const canStartPanelUpgrade =
    isDockerDeployment ? canShowDockerUpgradeScript : !!updateInfo?.hasUpdate;
  const rollbackPanelVersions = rollbackVersionsQuery.data?.panelVersions || [];
  const rollbackAgentVersions = rollbackVersionsQuery.data?.agentVersions || [];
  const selectedRollbackTarget = rollbackType === "panel"
    ? rollbackPanelVersions.find((item: any) => item.panelVersion === selectedRollbackVersion)
    : rollbackAgentVersions.find((item: any) => item.agentVersion === selectedRollbackVersion);
  const selectedRollbackPanelCommand = rollbackType === "panel" && selectedRollbackVersion
    ? panelVersionCommand(
        upgradeStatus?.manualUpgradeCommand || settings?.upgrade?.manualUpgradeCommand || manualPanelUpgradeCommands[isDockerDeployment ? 1 : 0].command,
        selectedRollbackVersion,
      )
    : "";
  const canRunPanelRollback = rollbackType !== "panel" || (!!upgradeEnabled && !isDockerDeployment);
  const androidApkDownloadUrl = settings?.androidApkDownloadUrl || "";
  const contactLinks = [
    {
      label: "GitHub 仓库",
      url: settings?.repoUrl || "#",
      icon: Github,
      iconClassName: "",
    },
    {
      label: "Telegram 双向消息机器人",
      url: settings?.telegramBotUrl || "#",
      icon: Send,
      iconClassName: "text-primary",
    },
    {
      label: "Telegram 群组",
      url: "https://t.me/ForwardX_panel",
      icon: UserPlus,
      iconClassName: "text-primary",
    },
    ...(androidApkDownloadUrl ? [{
      label: "Android APK 下载",
      url: androidApkDownloadUrl,
      icon: Download,
      iconClassName: "text-emerald-600",
    }] : []),
  ];
  const isUpgradeRunning = upgradeStatus?.job.status === "running";
  const upgradeProgress = getUpgradeProgress(upgradeStatus?.job);
  const upgradeErrorLogs = (upgradeStatus?.job?.logs || []).slice(-80).join("\n");
  const directProtocolEnabledCount = directForwardProtocolKeys.filter((key) => forwardProtocols[key]).length;
  const tunnelProtocolEnabledCount = tunnelForwardProtocolKeys.filter((key) => forwardProtocols[key]).length;
  const totalProtocolEnabledCount = directProtocolEnabledCount + tunnelProtocolEnabledCount;
  const totalProtocolCount = directForwardProtocolKeys.length + tunnelForwardProtocolKeys.length;
  const sidebarMenuEnabledCount = SIDEBAR_MENU_KEYS.filter((key) => sidebarMenu[key]).length;
  const panelSslSourceLabel = panelSslMode === "pem" ? "粘贴 PEM 内容" : "服务器文件路径";
  const panelSslPathActive = panelSslMode === "path";
  const panelSslPemActive = panelSslMode === "pem";
  const panelSslPathConfigured = !!panelSslCertPath.trim() && !!panelSslKeyPath.trim();
  const panelSslPemConfigured = !!panelSslCertPem.trim() && !!panelSslKeyPem.trim();

  useEffect(() => {
    if (!canShowDockerUpgradeScript || !updateInfo?.latestVersion) return;
    if (shownDockerUpgradeVersion.current === updateInfo.latestVersion) return;
    shownDockerUpgradeVersion.current = updateInfo.latestVersion;
    setShowDockerUpgradeScript(true);
  }, [canShowDockerUpgradeScript, updateInfo?.latestVersion]);

  if (isLoading) {
    return (
      <DataSectionLoading label="正在加载系统设置" minHeight="min-h-[220px]" />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="h-4 w-4 text-primary" />
              网络测试
            </CardTitle>
            <CardDescription>
              配置普通用户是否可见网络测试入口。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">普通用户可见网络测试</p>
                <p className="text-xs text-muted-foreground">
                  关闭后侧边栏入口和接口都会对普通用户禁用。
                </p>
              </div>
              <Switch className="shrink-0" checked={lookingGlassUserEnabled} onCheckedChange={setLookingGlassUserEnabled} />
            </div>
            <Button onClick={handleSaveLookingGlass} disabled={isSavingSetting("networkTest")}>
              保存
            </Button>
          </CardContent>
        </Card>
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" />
                转发协议总开关
              </CardTitle>
              <CardDescription>
                控制用户可用的转发协议。
              </CardDescription>
            </div>
            <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={openForwardProtocolDialog}>
              <Settings2 className="h-4 w-4" />
              管理协议开关
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">全部协议</p>
                <p className="mt-1 text-lg font-semibold">{totalProtocolEnabledCount} / {totalProtocolCount}</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">端口转发</p>
                <p className="mt-1 text-lg font-semibold">{directProtocolEnabledCount} / {directForwardProtocolKeys.length}</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">隧道协议</p>
                <p className="mt-1 text-lg font-semibold">{tunnelProtocolEnabledCount} / {tunnelForwardProtocolKeys.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {/* 面板公开访问地址 */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              面板公开访问地址
            </CardTitle>
            <CardDescription>
              Agent 安装和回调使用此地址。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="例如: https://forwardx.example.com 或 http://1.2.3.4:3000"
                value={panelUrlInput}
                onChange={(e) => setPanelUrlInput(e.target.value)}
                className="flex-1"
              />
              <Button
                onClick={handleSavePanelUrl}
                disabled={isSavingSetting("panelUrl")}
              >
                保存
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              留空使用当前访问地址。需以 http:// 或 https:// 开头。
            </p>
            <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-300">
              如果通过 HTTPS 反代、Cloudflare 或域名访问面板，请填写外部可访问的 https:// 域名。留空时面板只能根据请求头推断地址，Docker/反代环境可能生成 http://容器地址:端口，导致 Agent 通讯地址被覆盖后离线。
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wifi className="h-4 w-4 text-primary" />
              Web 服务监听端口
            </CardTitle>
            <CardDescription>
              {isDockerWebPort ? "Docker 部署的宿主机访问端口由端口映射管理，容器内固定监听 3000。" : "修改本地部署面板的 Web 访问端口。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                value={webPortInput}
                onChange={(e) => setWebPortInput(e.target.value.replace(/\D/g, "").slice(0, 5))}
                disabled={!settings?.webPortManagement?.enabled}
                className="flex-1"
              />
              <Button
                onClick={openWebPortConfirm}
                disabled={webPortChangeDisabled}
                variant={isDockerWebPort ? "outline" : "default"}
              >
                {isDockerWebPort ? "不可修改" : "修改端口"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isDockerWebPort
                ? `当前宿主机映射端口：${webPortDisplay}，容器内监听端口：${webContainerPort}。如需调整，请修改部署目录 .env 的 PORT 或 docker-compose.yml 端口映射后重启容器。`
                : `当前监听端口：${webPortDisplay}。修改后服务会重启，请使用新端口访问后台。`}
            </p>
            {!settings?.webPortManagement?.enabled && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{isDockerWebPort ? "Docker 部署端口由映射管理" : "当前环境不支持后台修改端口"}</AlertTitle>
                <AlertDescription>
                  {isDockerWebPort
                    ? "面板不会修改 Docker 端口映射，避免容器内监听端口和宿主机访问端口混用。升级脚本会尽量保留当前映射端口。"
                    : "请在服务环境变量或启动脚本中修改监听端口。"}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-4 w-4 text-primary" />
              面板 SSL 访问
            </CardTitle>
            <CardDescription>
              开启后当前 Web 端口将使用 HTTPS 访问。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">启用 HTTPS</p>
                <p className="text-xs text-muted-foreground">
                  当前协议：{settings?.panelSsl?.activeProtocol === "https" ? "HTTPS" : "HTTP"}，端口：{webPortDisplay}
                </p>
              </div>
              <Switch className="shrink-0" checked={panelSslEnabled} onCheckedChange={setPanelSslEnabled} />
            </div>
            <div className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="font-medium">当前证书来源：{panelSslSourceLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    文件路径和 PEM 内容可以同时保存，但保存并重启后只会使用当前选中的来源。
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="w-fit shrink-0 border-primary/30 bg-background/70 text-primary">
                {panelSslEnabled ? "HTTPS 将按此来源启动" : "启用后按此来源启动"}
              </Badge>
            </div>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className={`space-y-3 rounded-lg border p-3 transition-colors ${panelSslPathActive ? "border-primary/40 bg-primary/5 shadow-sm" : "border-border/40 bg-muted/10 opacity-80"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">服务器文件路径</p>
                      <Badge variant={panelSslPathActive ? "default" : "outline"} className="text-[10px]">
                        {panelSslPathActive ? "当前使用" : panelSslPathConfigured ? "已保存备用" : "未配置"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      读取服务器上的证书和私钥文件。{panelSslPathActive ? "当前保存后会使用这一组证书。" : "未选中时不会作为 HTTPS 证书生效。"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={panelSslPathActive ? "default" : "outline"}
                    onClick={() => setPanelSslMode("path")}
                    disabled={panelSslPathActive}
                  >
                    {panelSslPathActive ? "正在使用" : "使用此来源"}
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="panel-ssl-cert-path">证书文件路径</Label>
                <Input
                  id="panel-ssl-cert-path"
                  value={panelSslCertPath}
                  onChange={(e) => setPanelSslCertPath(e.target.value)}
                  placeholder="/data/certs/fullchain.pem"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="panel-ssl-key-path">私钥文件路径</Label>
                <Input
                  id="panel-ssl-key-path"
                  value={panelSslKeyPath}
                  onChange={(e) => setPanelSslKeyPath(e.target.value)}
                  placeholder="/data/certs/privkey.pem"
                />
              </div>
                </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPanelSslMode("path");
                  handleGeneratePanelSelfSigned();
                }}
                disabled={generatePanelSelfSignedMutation.isPending}
              >
                {generatePanelSelfSignedMutation.isPending ? "生成中..." : "生成自签证书"}
              </Button>
              </div>

              <div className={`space-y-3 rounded-lg border p-3 transition-colors ${panelSslPemActive ? "border-primary/40 bg-primary/5 shadow-sm" : "border-border/40 bg-muted/10 opacity-80"}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">粘贴 PEM 内容</p>
                      <Badge variant={panelSslPemActive ? "default" : "outline"} className="text-[10px]">
                        {panelSslPemActive ? "当前使用" : panelSslPemConfigured ? "已保存备用" : "未配置"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      直接保存证书和私钥 PEM 内容。{panelSslPemActive ? "当前保存后会使用这一组证书。" : "未选中时不会作为 HTTPS 证书生效。"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={panelSslPemActive ? "default" : "outline"}
                    onClick={() => setPanelSslMode("pem")}
                    disabled={panelSslPemActive}
                  >
                    {panelSslPemActive ? "正在使用" : "使用此来源"}
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="panel-ssl-cert-pem">证书 PEM</Label>
                  <Textarea
                    id="panel-ssl-cert-pem"
                    value={panelSslCertPem}
                    onChange={(e) => setPanelSslCertPem(e.target.value)}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    className="min-h-44 resize-y font-mono text-xs leading-5"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="panel-ssl-key-pem">私钥 PEM</Label>
                  <Textarea
                    id="panel-ssl-key-pem"
                    value={panelSslKeyPem}
                    onChange={(e) => setPanelSslKeyPem(e.target.value)}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="min-h-44 resize-y font-mono text-xs leading-5"
                  />
                </div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              默认关闭。保存时会校验证书和私钥，配置生效需要重启面板；端口不变。
            </p>
            <div className="flex justify-end">
              <Button onClick={openPanelSslConfirmV2} disabled={updatePanelSslMutation.isPending || generatePanelSelfSignedMutation.isPending}>
                保存 SSL 配置
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showWebPortConfirm} onOpenChange={setShowWebPortConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认修改 Web 端口
            </DialogTitle>
            <DialogDescription>
              即将把 Web 服务监听端口修改为 {webPortInput || "-"}，确认后服务会重启。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>请先确认安全组和防火墙已放行新端口</AlertTitle>
            <AlertDescription>
              如果新端口未放行，服务重启后可能无法通过浏览器访问后台。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWebPortConfirm(false)} disabled={updateWebPortMutation.isPending}>
              取消
            </Button>
            <Button onClick={confirmWebPortChange} disabled={webPortCountdown > 0 || updateWebPortMutation.isPending}>
              {webPortCountdown > 0 ? `确认修改（${webPortCountdown}s）` : "确认并重启"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPanelSslConfirm} onOpenChange={setShowPanelSslConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              确认修改面板 SSL
            </DialogTitle>
            <DialogDescription>
              确认后面板会重启，当前端口 {webPortDisplay} 将切换为 {panelSslEnabled ? "HTTPS" : "HTTP"} 访问。
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>请确认访问地址和证书文件已准备好</AlertTitle>
            <AlertDescription>
              开启 SSL 后请使用 https:// 访问当前端口；关闭后请改回 http:// 访问当前端口。
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPanelSslConfirm(false)} disabled={updatePanelSslMutation.isPending}>
              取消
            </Button>
            <Button onClick={confirmPanelSslChangeV2} disabled={panelSslCountdown > 0 || updatePanelSslMutation.isPending}>
              {panelSslCountdown > 0 ? `确认修改（${panelSslCountdown}s）` : "确认并重启"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserPlus className="h-4 w-4 text-primary" />
              用户注册
            </CardTitle>
            <CardDescription>
              控制新用户自助注册。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">开放注册</p>
                <p className="text-xs text-muted-foreground">
                  关闭后仅管理员可添加用户。
                </p>
              </div>
              <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveRegistration} disabled={isSavingSetting("registration")}>
                保存注册设置
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="h-4 w-4 text-primary" />
              双重验证
            </CardTitle>
            <CardDescription>
              账号可绑定 2FA 动态验证码。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">启用 2FA 软件支持</p>
                <p className="text-xs text-muted-foreground">
                  关闭后隐藏绑定入口。
                </p>
              </div>
              <Switch checked={twoFactorEnabled} onCheckedChange={setTwoFactorEnabled} />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveTwoFactor} disabled={isSavingSetting("twoFactor")}>
                保存双重验证设置
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4 text-primary" />
            DDNS 服务商
          </CardTitle>
          <CardDescription>
            转发组切换时同步更新域名。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">启用 DDNS</p>
                <p className="text-xs text-muted-foreground">关闭后不更新域名。</p>
              </div>
              <Switch className="shrink-0" checked={ddnsEnabled} onCheckedChange={setDdnsEnabled} />
            </div>
            <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">服务商</p>
                <p className="text-xs text-muted-foreground">选择用于同步域名的 DDNS 服务。</p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-56">
                <Select value={ddnsProvider} onValueChange={(v) => setDdnsProvider(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disabled">不使用</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare</SelectItem>
                    <SelectItem value="huaweicloud">华为云 DNS</SelectItem>
                    <SelectItem value="aliyun">阿里云 DNS</SelectItem>
                    <SelectItem value="tencentcloud">腾讯云 DNSPod</SelectItem>
                    <SelectItem value="webhook">自定义 Webhook</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="sm" className="justify-center gap-2" asChild>
                  <a href={ddnsProviderGuideUrl(ddnsProvider)} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                    查看配置教程
                  </a>
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>TTL</Label>
            <Input
              value={ddnsTtl}
              onChange={(e) => setDdnsTtl(e.target.value.replace(/\D/g, "").slice(0, 5))}
              placeholder="600"
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground">统一用于 DDNS 解析记录。Cloudflare、华为云、阿里云、腾讯云 DNSPod 在面板中按 60-86400 秒保存；Webhook 会在请求中透传 ttl。</p>
          </div>

          {ddnsProvider === "cloudflare" && (
            <div className="space-y-2">
              <div className="space-y-2">
                <Label>API Token</Label>
                <Input
                  value={ddnsCloudflareApiToken}
                  onChange={(e) => setDdnsCloudflareApiToken(e.target.value)}
                  placeholder={settings?.ddns?.cloudflareTokenMasked || "需要 Zone:Read + DNS:Edit 权限"}
                  type="password"
                />
                <p className="text-xs text-muted-foreground">Cloudflare 会根据 DDNS 域名自动识别 Zone，不需要手动填写 Zone ID；留空则保留已保存 Token。</p>
              </div>
            </div>
          )}

          {ddnsProvider === "huaweicloud" && (
            <div className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>Access Key ID</Label>
                  <Input value={ddnsHuaweiCloudAccessKeyId} onChange={(e) => setDdnsHuaweiCloudAccessKeyId(e.target.value)} placeholder="华为云 AK" />
                </div>
                <div className="space-y-2">
                  <Label>Secret Access Key</Label>
                  <Input
                    value={ddnsHuaweiCloudSecretKey}
                    onChange={(e) => setDdnsHuaweiCloudSecretKey(e.target.value)}
                    placeholder={settings?.ddns?.huaweicloudSecretKeyMasked || "留空保留已保存密钥"}
                    type="password"
                  />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>公网 Zone ID</Label>
                  <Input value={ddnsHuaweiCloudZoneId} onChange={(e) => setDdnsHuaweiCloudZoneId(e.target.value)} placeholder="公网域名 Zone ID" />
                </div>
                <div className="space-y-2">
                  <Label>区域</Label>
                  <Input value={ddnsHuaweiCloudRegion} onChange={(e) => setDdnsHuaweiCloudRegion(e.target.value)} placeholder="cn-north-4" />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>默认线路</Label>
                  <Input value={ddnsHuaweiCloudLine} onChange={(e) => setDdnsHuaweiCloudLine(e.target.value)} placeholder="default_view" />
                </div>
                <div className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input value={ddnsHuaweiCloudEndpoint} onChange={(e) => setDdnsHuaweiCloudEndpoint(e.target.value)} placeholder="留空使用区域默认 Endpoint" />
                </div>
              </div>
            </div>
          )}

          {ddnsProvider === "aliyun" && (
            <div className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>AccessKey ID</Label>
                  <Input value={ddnsAliyunAccessKeyId} onChange={(e) => setDdnsAliyunAccessKeyId(e.target.value)} placeholder="阿里云 AccessKey ID" />
                </div>
                <div className="space-y-2">
                  <Label>AccessKey Secret</Label>
                  <Input
                    value={ddnsAliyunAccessKeySecret}
                    onChange={(e) => setDdnsAliyunAccessKeySecret(e.target.value)}
                    placeholder={settings?.ddns?.aliyunAccessKeySecretMasked || "留空保留已保存密钥"}
                    type="password"
                  />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>主域名</Label>
                  <Input value={ddnsAliyunDomainName} onChange={(e) => setDdnsAliyunDomainName(e.target.value)} placeholder="example.com" />
                </div>
                <div className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input value={ddnsAliyunEndpoint} onChange={(e) => setDdnsAliyunEndpoint(e.target.value)} placeholder="https://alidns.aliyuncs.com" />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>默认线路</Label>
                  <Input value={ddnsAliyunLine} onChange={(e) => setDdnsAliyunLine(e.target.value)} placeholder="default" />
                </div>
              </div>
            </div>
          )}

          {ddnsProvider === "tencentcloud" && (
            <div className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>SecretId</Label>
                  <Input value={ddnsTencentCloudSecretId} onChange={(e) => setDdnsTencentCloudSecretId(e.target.value)} placeholder="腾讯云 SecretId" />
                </div>
                <div className="space-y-2">
                  <Label>SecretKey</Label>
                  <Input
                    value={ddnsTencentCloudSecretKey}
                    onChange={(e) => setDdnsTencentCloudSecretKey(e.target.value)}
                    placeholder={settings?.ddns?.tencentcloudSecretKeyMasked || "留空保留已保存密钥"}
                    type="password"
                  />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>主域名</Label>
                  <Input value={ddnsTencentCloudDomainName} onChange={(e) => setDdnsTencentCloudDomainName(e.target.value)} placeholder="example.com" />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label>默认线路名称</Label>
                  <Input value={ddnsTencentCloudRecordLine} onChange={(e) => setDdnsTencentCloudRecordLine(e.target.value)} placeholder="默认" />
                </div>
                <div className="space-y-2">
                  <Label>默认线路 ID</Label>
                  <Input value={ddnsTencentCloudRecordLineId} onChange={(e) => setDdnsTencentCloudRecordLineId(e.target.value)} placeholder="可留空" />
                </div>
              </div>
            </div>
          )}

          {ddnsProvider === "webhook" && (
            <div className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-[160px_minmax(0,1fr)]">
                <div className="space-y-2">
                  <Label>请求方法</Label>
                  <Select value={ddnsWebhookMethod} onValueChange={(v) => setDdnsWebhookMethod(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="GET">GET</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Webhook URL</Label>
                  <Input
                    value={ddnsWebhookUrl}
                    onChange={(e) => setDdnsWebhookUrl(e.target.value)}
                    placeholder="https://ddns.example.com/update?domain={{domain}}&value={{value}}"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>请求头</Label>
                <Textarea
                  value={ddnsWebhookHeaders}
                  onChange={(e) => setDdnsWebhookHeaders(e.target.value)}
                  placeholder='{"Authorization":"Bearer xxx"}'
                  className="min-h-20 font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">支持 JSON 或每行一个 Header。</p>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSaveDdns} disabled={isSavingSetting("ddns")}>
              {isSavingSetting("ddns") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("ddns") ? "保存中..." : "保存 DDNS 配置"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Monitor className="h-4 w-4 text-primary" />
            主机监控配置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">允许免登录查看主机监控</p>
            </div>
            <Switch className="shrink-0" checked={publicHostMonitorEnabled} onCheckedChange={setPublicHostMonitorEnabled} />
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
            <div className="space-y-2 lg:col-span-2">
              <Label>展示标题</Label>
              <Input
                value={publicHostMonitorTitle}
                onChange={(e) => setPublicHostMonitorTitle(e.target.value.slice(0, 80))}
                placeholder="留空默认使用站点标题 + 主机监控"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label>主机监控面板路径</Label>
              <Input
                value={publicHostMonitorPath}
                onChange={(e) => setPublicHostMonitorPath(e.target.value)}
                placeholder="dev"
              />
              <p className="text-xs text-muted-foreground">
                支持字母、数字、短横线和下划线。
              </p>
            </div>
            <div className="space-y-2">
              <Label>访问地址</Label>
              <div className="flex min-w-0 gap-2">
                <Input value={publicHostMonitorUrl} readOnly className="font-mono text-xs" />
                <Button type="button" variant="outline" size="icon" title="打开主机监控面板" asChild>
                  <a href={publicHostMonitorUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSavePublicHostMonitor} disabled={isSavingSetting("hostMonitor")}>
              {isSavingSetting("hostMonitor") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("hostMonitor") ? "保存中..." : "保存主机监控配置"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-primary" />
              登录会话配置
            </CardTitle>
            <CardDescription>
              控制同一账户在多台设备上的后台访问策略。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">允许多设备在线</p>
                <p className="text-xs text-muted-foreground">
                  开启后同一账户不再限制仅一个地方登录。
                </p>
              </div>
              <Switch className="shrink-0" checked={allowMultiDeviceLogin} onCheckedChange={setAllowMultiDeviceLogin} />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveSessionPolicy} disabled={isSavingSetting("sessionPolicy")}>
                {isSavingSetting("sessionPolicy") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isSavingSetting("sessionPolicy") ? "保存中..." : "保存登录会话配置"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <PanelLeft className="h-4 w-4 text-primary" />
                左侧导航栏菜单展示设置
              </CardTitle>
              <CardDescription>
                控制左侧导航栏常用入口是否展示。
              </CardDescription>
            </div>
            <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={openSidebarMenuDialog}>
              <Settings2 className="h-4 w-4" />
              管理菜单开关
            </Button>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">已开启菜单</p>
              <p className="mt-1 text-lg font-semibold">{sidebarMenuEnabledCount} / {SIDEBAR_MENU_KEYS.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>


      <Dialog
        open={showForwardProtocolDialog}
        onOpenChange={(open) => {
          if (open) {
            openForwardProtocolDialog();
          } else {
            closeForwardProtocolDialog();
          }
        }}
      >
        <DialogContent className="flex max-h-[calc(100svh-1.5rem)] w-[calc(100vw-0.75rem)] max-w-[42rem] flex-col gap-3 overflow-hidden p-3 sm:max-h-[92svh] sm:w-full sm:max-w-3xl sm:p-6">
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              转发协议总开关
            </DialogTitle>
            <DialogDescription>
              开启或关闭可用协议。
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 overflow-y-auto overscroll-contain px-1 pb-1">
            <div className="grid gap-3 min-[360px]:grid-cols-2">
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
                <div>
                  <p className="text-sm font-medium">端口转发</p>
                  <p className="text-xs text-muted-foreground">端口转发工具开关。</p>
                </div>
                <div className="flex flex-col gap-2">
                  {directForwardProtocolKeys.map((key) => (
                    <div
                      key={key}
                      className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                      <Switch className="shrink-0" checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
                <div>
                  <p className="text-sm font-medium">隧道协议</p>
                  <p className="text-xs text-muted-foreground">隧道模式开关。</p>
                </div>
                <div className="flex flex-col gap-2">
                  {tunnelForwardProtocolKeys.map((key) => (
                    <div
                      key={key}
                      className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                      <Switch className="shrink-0" checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t border-border/40 pt-3 sm:border-0 sm:pt-0">
            <Button variant="outline" onClick={closeForwardProtocolDialog}>
              取消
            </Button>
            <Button onClick={handleSaveForwardProtocols} disabled={isSavingSetting("forwardProtocols")}>
              保存协议开关
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showSidebarMenuDialog}
        onOpenChange={(open) => {
          if (open) {
            openSidebarMenuDialog();
          } else {
            closeSidebarMenuDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PanelLeft className="h-5 w-5 text-primary" />
              左侧导航栏菜单展示设置
            </DialogTitle>
            <DialogDescription>
              关闭后对应入口不再显示在左侧导航栏中，插件入口也在这里统一控制。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            {SIDEBAR_MENU_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2"
              >
                <span className="text-sm">{SIDEBAR_MENU_LABELS[key]}</span>
                <Switch checked={sidebarMenu[key]} onCheckedChange={(checked) => setSidebarMenuEnabled(key, checked)} />
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closeSidebarMenuDialog}>
              取消
            </Button>
            <Button onClick={handleSaveSidebarMenu} disabled={isSavingSetting("sidebarMenu")}>
              {isSavingSetting("sidebarMenu") && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSavingSetting("sidebarMenu") ? "保存中..." : "保存菜单开关"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 版本升级 */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <Rocket className="h-4 w-4 text-primary" />
                版本升级
              </CardTitle>
              <CardDescription>
                检查并升级 ForwardX。
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(220px,0.9fr)]">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">当前面板版本</p>
                <p className="mt-1 font-mono text-sm">v{upgradeStatus?.currentVersion || settings?.version}</p>
              </div>
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">当前 Agent 目标版本</p>
                <p className="mt-1 font-mono text-sm">v{upgradeStatus?.currentAgentVersion || settings?.agentVersion || "-"}</p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">自动检查更新</p>
                  <p className="text-xs text-muted-foreground">开启后定期检查面板和 Agent 更新。</p>
                </div>
                <Switch
                  className="shrink-0"
                  checked={updateAutoCheckEnabled}
                  disabled={isSavingSetting("updateAutoCheck")}
                  onCheckedChange={handleUpdateAutoCheckChange}
                />
              </div>
            </div>

          {updateInfo?.error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>检查更新失败</AlertTitle>
              <AlertDescription>{updateInfo.error}</AlertDescription>
            </Alert>
          )}

          {!upgradeEnabled && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{isDockerDeployment ? "Docker 部署请使用一键升级脚本" : "当前环境尚未启用一键升级"}</AlertTitle>
              <AlertDescription>
                {isDockerDeployment
                  ? "检查到新版本后可复制脚本到服务器执行，脚本会覆盖原有 ForwardX 容器。"
                  : <>配置 <code>FORWARDX_UPGRADE_COMMAND</code> 后可一键升级。</>}
              </AlertDescription>
            </Alert>
          )}

          {updateInfo?.hasUpdate && (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Rocket className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-primary">发现新版本 {updateInfo.latestVersion}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      来源：{updateInfo.source === "release" ? "GitHub Release" : updateInfo.source === "tag" ? "GitHub Tag" : updateInfo.source === "main" ? "main 分支" : "GitHub"}
                      {updateInfo.publishedAt ? `，发布时间：${new Date(updateInfo.publishedAt).toLocaleString()}` : ""}
                      {updateInfo.latestAgentVersion ? `，Agent 目标：v${updateInfo.latestAgentVersion}` : ""}
                    </p>
                  </div>
                </div>
                <Badge className="w-fit">可升级</Badge>
              </div>
            </div>
          )}

          {updateInfo?.pendingReason && !updateInfo.error && (!updateInfo.hasUpdate || updateInfo.deployable === false) && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>新版本正在准备中</AlertTitle>
              <AlertDescription>{updateInfo.pendingReason}</AlertDescription>
            </Alert>
          )}

          {updateInfo && !updateInfo.error && !updateInfo.pendingReason && !updateInfo.hasUpdate && (
            <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm text-muted-foreground">
              当前已是最新版本，上次检查时间：{new Date(updateInfo.checkedAt).toLocaleString()}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleCheckUpdate}
              disabled={checkingUpdate || isUpgradeRunning}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${checkingUpdate ? "forwardx-icon-spin" : ""}`} />
              检查更新
            </Button>
            <Button
              onClick={() => {
                if (!updateInfo?.latestVersion) {
                  toast.error("请先检查更新");
                  return;
                }
                if (isDockerDeployment) {
                  setShowDockerUpgradeScript(true);
                  return;
                }
                if (!upgradeEnabled) {
                  toast.error("未配置升级命令，无法自动升级");
                  return;
                }
                setShowUpgradeConfirm(true);
              }}
              disabled={!canStartPanelUpgrade || (!upgradeEnabled && !isDockerDeployment) || isUpgradeRunning || startUpgradeMutation.isPending}
              className="gap-2"
            >
              <Rocket className="h-4 w-4" />
              {isDockerDeployment ? "查看升级脚本" : "升级并重启"}
            </Button>
            <Button
              variant="outline"
              onClick={openRollbackDialog}
              disabled={isUpgradeRunning || startRollbackMutation.isPending}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              版本回退
            </Button>
            <Button variant="ghost" asChild className="gap-2">
              <a href={upgradeChangelogUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                升级日志
              </a>
            </Button>
          </div>

          {upgradeStatus?.job && upgradeStatus.job.status !== "idle" && (
            <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    upgradeStatus.job.status === "error"
                      ? "bg-destructive/10 text-destructive"
                      : upgradeStatus.job.status === "waiting_assets"
                        ? "bg-amber-500/10 text-amber-500"
                      : upgradeStatus.job.status === "success"
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-primary/10 text-primary"
                  }`}>
                    {upgradeStatus.job.status === "error" ? (
                      <AlertTriangle className="h-5 w-5" />
                    ) : upgradeStatus.job.status === "waiting_assets" ? (
                      <RefreshCw className="h-5 w-5" />
                    ) : upgradeStatus.job.status === "success" ? (
                      <CheckCircle2 className="h-5 w-5" />
                    ) : (
                      <Rocket className="h-5 w-5 animate-pulse" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">
                      {upgradeStatus.job.status === "success"
                        ? (upgradeStatus.job.mode === "rollback" ? "回退成功" : "升级成功")
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "发布资产构建中"
                        : upgradeStatus.job.status === "error"
                          ? (upgradeStatus.job.mode === "rollback" ? "回退出现异常" : "升级出现异常")
                          : (upgradeStatus.job.mode === "rollback" ? "正在回退" : "正在升级")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {upgradeStatus.job.status === "success"
                        ? `已完成 ${upgradeStatus.job.targetVersion || ""} ${upgradeStatus.job.mode === "rollback" ? "回退" : "升级"}，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "GitHub Actions 仍在生成面板安装包或镜像，请稍后重新检查更新"
                        : upgradeStatus.job.status === "error"
                          ? `${upgradeStatus.job.mode === "rollback" ? "回退" : "升级"}未完成，请查看下方异常信息`
                          : upgradeProgress.label}
                    </p>
                  </div>
                </div>
                <Badge variant={upgradeStatus.job.status === "error" ? "destructive" : "outline"} className={`w-fit ${upgradeStatus.job.status === "waiting_assets" ? "border-amber-500/30 text-amber-500" : ""}`}>
                  {upgradeStatus.job.targetVersion}
                </Badge>
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{upgradeProgress.label}</span>
                  <span>{upgradeProgress.percent}%</span>
                </div>
                <Progress value={upgradeProgress.percent} className="h-2" />
                <div className="grid gap-2 sm:grid-cols-4">
                  {upgradeProgress.steps.map((step) => (
                    <div
                      key={step.label}
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        step.done
                          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500"
                          : step.active
                            ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border/40 bg-background/40 text-muted-foreground"
                      }`}
                    >
                      {step.label}
                    </div>
                  ))}
                </div>
              </div>

              {upgradeStatus.job.status === "waiting_assets" && (
                <div className="mt-4 space-y-2">
                  {upgradeStatus.job.error && (
                    <Alert>
                      <RefreshCw className="h-4 w-4" />
                      <AlertTitle>等待发布资产</AlertTitle>
                      <AlertDescription>{upgradeStatus.job.error}</AlertDescription>
                    </Alert>
                  )}
                  <pre className="max-h-52 overflow-auto rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-muted-foreground">
                    {upgradeErrorLogs || "正在等待 GitHub Actions 构建发布资产"}
                  </pre>
                </div>
              )}

              {upgradeStatus.job.status === "error" && (
                <div className="mt-4 space-y-2">
                  {upgradeStatus.job.error && (
                    <p className="text-xs font-medium text-destructive">{upgradeStatus.job.error}</p>
                  )}
                  <pre className="max-h-64 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
                    {upgradeErrorLogs || "暂无异常日志"}
                  </pre>
                  <div className="rounded-lg border border-destructive/25 bg-background/80 p-3 text-xs">
                    <p className="font-medium text-destructive">自动版本任务失败时，可以在服务器执行对应的一键脚本手动处理：</p>
                    <div className="mt-2 space-y-2">
                      {manualPanelUpgradeCommands.map((item) => (
                        <div key={item.label} className="space-y-1">
                          <span className="text-muted-foreground">{item.label}</span>
                          <code className="block overflow-x-auto rounded border bg-muted/30 p-2 font-mono text-[11px] text-foreground">
                            {item.command}
                          </code>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4 text-primary" />
            GitHub 下载加速
          </CardTitle>
          <CardDescription>
            配置 Agent 安装和升级时访问 GitHub 的方式。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">启用 GitHub 加速地址</p>
                <p className="text-xs text-muted-foreground">
                  开启并填写地址后，GitHub 真实地址会拼接在加速地址后面。
                </p>
              </div>
              <Switch className="shrink-0" checked={githubAcceleratorEnabled} onCheckedChange={setGithubAcceleratorEnabled} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">优先连接面板安装 Agent</p>
                <p className="text-xs text-muted-foreground">
                  开启后先从面板拉取安装脚本和 Agent 程序，失败后回退 GitHub。
                </p>
              </div>
              <Switch className="shrink-0" checked={agentPreferPanelInstall} onCheckedChange={setAgentPreferPanelInstall} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>GitHub 加速地址</Label>
            <Input
              value={githubAcceleratorUrlInput}
              onChange={(e) => setGithubAcceleratorUrlInput(e.target.value)}
              placeholder={defaultGithubAcceleratorUrl}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              未填写或未开启时使用直连 GitHub。
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveAgentInstall} disabled={isSavingSetting("agentInstall")}>
              保存 Agent 安装配置
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>

      <Dialog open={showUpgradeConfirm} onOpenChange={setShowUpgradeConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              确认升级并重启
            </DialogTitle>
            <DialogDescription>
              即将升级到 {updateInfo?.latestVersion}。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/40 bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前版本</span>
              <code>v{upgradeStatus?.currentVersion || settings?.version}</code>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-muted-foreground">目标版本</span>
              <code>{updateInfo?.latestVersion}</code>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpgradeConfirm(false)}>
              取消
            </Button>
            <Button
              className="gap-2"
              disabled={startUpgradeMutation.isPending || isUpgradeRunning}
              onClick={() => {
                if (!updateInfo?.latestVersion) return;
                setShowUpgradeConfirm(false);
                startUpgradeMutation.mutate({ targetVersion: updateInfo.latestVersion });
              }}
            >
              <Rocket className="h-4 w-4" />
              确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRollbackDialog} onOpenChange={setShowRollbackDialog}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              版本回退
            </DialogTitle>
            <DialogDescription>
              选择最近 5 个以内的可回退版本。
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={rollbackType}
            onValueChange={(value) => {
              setRollbackType(value === "agent" ? "agent" : "panel");
              setSelectedRollbackVersion("");
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="panel">面板</TabsTrigger>
              <TabsTrigger value="agent">Agent</TabsTrigger>
            </TabsList>

            {rollbackVersionsQuery.data?.error && (
              <Alert variant="destructive" className="mt-4">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>获取版本失败</AlertTitle>
                <AlertDescription>{rollbackVersionsQuery.data.error}</AlertDescription>
              </Alert>
            )}

            <TabsContent value="panel" className="mt-4 space-y-4">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前面板版本</span>
                  <code>v{rollbackVersionsQuery.data?.currentPanelVersion || upgradeStatus?.currentVersion || settings?.version}</code>
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前兼容 Agent</span>
                  <code>v{rollbackVersionsQuery.data?.currentAgentVersion || settings?.agentVersion || "-"}</code>
                </div>
              </div>

              <div className="space-y-2">
                <Label>回退到面板版本</Label>
                <Select
                  value={rollbackType === "panel" ? selectedRollbackVersion : ""}
                  onValueChange={setSelectedRollbackVersion}
                  disabled={rollbackVersionsQuery.isLoading || rollbackPanelVersions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rollbackVersionsQuery.isLoading ? "正在获取 GitHub 版本..." : "选择面板版本"} />
                  </SelectTrigger>
                  <SelectContent>
                    {rollbackPanelVersions.map((item: any) => (
                      <SelectItem key={item.panelVersion} value={item.panelVersion}>
                        v{item.panelVersion}{item.compatibleAgentVersion ? ` / Agent v${item.compatibleAgentVersion}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {rollbackPanelVersions.length === 0 && !rollbackVersionsQuery.isLoading && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>暂无可回退面板版本</AlertTitle>
                  <AlertDescription>未从 GitHub Release 获取到低于当前版本的最近 5 个版本。</AlertDescription>
                </Alert>
              )}

              {selectedRollbackTarget && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  目标版本：v{(selectedRollbackTarget as any).panelVersion}
                  {(selectedRollbackTarget as any).publishedAt ? `，发布时间：${new Date((selectedRollbackTarget as any).publishedAt).toLocaleString()}` : ""}
                </div>
              )}

              {!canRunPanelRollback && selectedRollbackPanelCommand && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>当前环境请使用脚本回退</AlertTitle>
                  <AlertDescription>
                    后台未启用一键回退或当前为 Docker 部署，请在服务器执行下方命令。
                  </AlertDescription>
                </Alert>
              )}
              {!canRunPanelRollback && selectedRollbackPanelCommand && (
                <code className="block max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                  {selectedRollbackPanelCommand}
                </code>
              )}
            </TabsContent>

            <TabsContent value="agent" className="mt-4 space-y-4">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">当前面板内置 Agent</span>
                  <code>v{rollbackVersionsQuery.data?.currentAgentVersion || settings?.agentVersion || "-"}</code>
                </div>
              </div>

              <div className="space-y-2">
                <Label>回退到 Agent 版本</Label>
                <Select
                  value={rollbackType === "agent" ? selectedRollbackVersion : ""}
                  onValueChange={setSelectedRollbackVersion}
                  disabled={rollbackVersionsQuery.isLoading || rollbackAgentVersions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rollbackVersionsQuery.isLoading ? "正在获取 GitHub 版本..." : "选择 Agent 版本"} />
                  </SelectTrigger>
                  <SelectContent>
                    {rollbackAgentVersions.map((item: any) => (
                      <SelectItem key={`${item.agentVersion}:${item.panelVersion}`} value={item.agentVersion}>
                        Agent v{item.agentVersion} / Release v{item.panelVersion}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {rollbackAgentVersions.length === 0 && !rollbackVersionsQuery.isLoading && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>暂无可回退 Agent 版本</AlertTitle>
                  <AlertDescription>未从最近 5 个面板 Release 中获取到低于当前 Agent 的版本。</AlertDescription>
                </Alert>
              )}

              {selectedRollbackTarget && (
                <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                  将下发 Agent v{(selectedRollbackTarget as any).agentVersion}，资产来源 Release v{(selectedRollbackTarget as any).panelVersion}。
                </div>
              )}
            </TabsContent>
          </Tabs>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowRollbackDialog(false)}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => refreshRollbackVersions()}
              disabled={rollbackVersionsQuery.isFetching}
            >
              {rollbackVersionsQuery.isFetching ? "刷新中..." : "刷新版本"}
            </Button>
            <Button
              className="gap-2"
              disabled={
                rollbackVersionsQuery.isLoading ||
                !selectedRollbackVersion ||
                startRollbackMutation.isPending ||
                isUpgradeRunning
              }
              onClick={() => {
                if (!selectedRollbackVersion) return;
                if (rollbackType === "panel" && !canRunPanelRollback) {
                  copyTextToClipboard(selectedRollbackPanelCommand);
                  return;
                }
                startRollbackMutation.mutate({ type: rollbackType, targetVersion: selectedRollbackVersion });
              }}
            >
              <RefreshCw className={`h-4 w-4 ${startRollbackMutation.isPending ? "forwardx-icon-spin" : ""}`} />
              {rollbackType === "panel" && !canRunPanelRollback ? "复制回退脚本" : "确认回退"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDockerUpgradeScript} onOpenChange={setShowDockerUpgradeScript}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              Docker 一键升级脚本
            </DialogTitle>
            <DialogDescription>
              检测到新版本 {updateInfo?.latestVersion || ""}，请在服务器执行以下命令升级 Docker 部署。
            </DialogDescription>
          </DialogHeader>
          {updateInfo?.pendingReason && !updateInfo.error && updateInfo.deployable === false && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Docker 镜像可能仍在构建</AlertTitle>
              <AlertDescription>{updateInfo.pendingReason}</AlertDescription>
            </Alert>
          )}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>升级会重建原有 ForwardX 容器</AlertTitle>
            <AlertDescription>
              脚本会复用当前部署目录的 .env 配置，只重建容器，不删除 Docker 数据卷；原有数据库和 /data 数据会保留。
            </AlertDescription>
          </Alert>
          <code className="block max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {dockerPanelUpgradeCommand}
          </code>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDockerUpgradeScript(false)}>
              关闭
            </Button>
            <Button className="gap-2" onClick={() => copyTextToClipboard(dockerPanelUpgradeCommand)}>
              <Copy className="h-4 w-4" />
              复制脚本
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="border-border/40 bg-card/60 backdrop-blur-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-primary" />
            开源与联系
          </CardTitle>
          <CardDescription>
            项目地址与联系渠道。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {contactLinks.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.label}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center justify-between rounded-lg border border-border/40 p-3 transition-colors hover:bg-accent/40"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                      <Icon className={`h-4 w-4 ${item.iconClassName}`} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.label}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{item.url}</p>
                    </div>
                  </div>
                  <ExternalLink className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                </a>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground pt-2">
            <span>当前版本</span>
            <code className="font-mono">v{settings?.version}</code>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Android APP</span>
            <code className="font-mono">v{settings?.androidAppVersion}</code>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Settings() {
  return (
    <DashboardLayout>
      <SettingsContent />
    </DashboardLayout>
  );
}

import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { EmailSettingsContent } from "./EmailSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { getPanelChangelogUrl, PANEL_UPGRADE_REFRESH_DELAY_SECONDS } from "@/lib/panelUpgrade";
import {
  FORWARD_PROTOCOL_LABELS,
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardProtocolSettings,
  type ForwardProtocolSettings,
} from "@shared/forwardTypes";
import {
  Trash2,
  Key,
  Copy,
  Terminal,
  CheckCircle2,
  Settings2,
  FileCode,
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
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useMemo, useRef, useState, useEffect } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

function getUpgradeProgress(job: any) {
  const status = job?.status || "idle";
  const logs = Array.isArray(job?.logs) ? job.logs.join("\n") : "";
  const matched = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(logs));
  const steps = [
    {
      label: "准备升级",
      done: status !== "idle" && matched([/开始升级/i, /start/i]),
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
    return { percent: 100, label: "升级完成", steps: steps.map((step) => ({ ...step, done: true, active: false })) };
  }
  if (status === "waiting_assets") {
    return { percent: 34, label: "等待 GitHub Actions 构建发布资产", steps: steps.map((step, index) => ({ ...step, done: index === 0, active: index === 1 })) };
  }
  if (status === "error") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    return { percent: Math.max(10, doneCount * 22), label: "升级异常", steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  if (status === "running") {
    const doneCount = steps.filter((step) => step.done).length;
    const activeIndex = Math.min(doneCount, steps.length - 1);
    const activeStep = steps[activeIndex]?.label || "等待服务重启";
    return { percent: Math.min(92, Math.max(12, doneCount * 22 + 8)), label: activeStep, steps: steps.map((step, index) => ({ ...step, active: index === activeIndex && !step.done })) };
  }
  return { percent: 0, label: "等待升级", steps: steps.map((step) => ({ ...step, active: false })) };
}

const panelLocalScriptUrl = "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh";
const panelDockerScriptUrl = "https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh";
const panelLocalCommandPrefix = `curl -fsSL ${panelLocalScriptUrl} | sudo bash -s --`;
const panelDockerCommandPrefix = `curl -fsSL ${panelDockerScriptUrl} | sudo bash -s --`;
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
    model: "Qwen/Qwen3-8B",
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

function normalizeConfigUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isDdnsProvider(value: unknown): value is DdnsProvider {
  return ddnsProviders.includes(value as DdnsProvider);
}

const panelInstallGuideCommands = [
  {
    label: "本地部署",
    description: "适合直接在 Linux 主机上运行面板，脚本会下载 GitHub Release 中已构建好的面板程序包，安装运行依赖、写入 systemd 服务并启动面板。",
    directory: "/opt/forwardx-panel",
    service: "forwardx-panel",
    install: `${panelLocalCommandPrefix} install`,
    upgrade: `${panelLocalCommandPrefix} upgrade`,
    uninstall: `${panelLocalCommandPrefix} uninstall`,
    versionedUpgrade: `curl -fsSL ${panelLocalScriptUrl} | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade`,
    notes: ["默认 Web 端口为 3000，安装时可按提示修改。", "升级会保留 .env、data 目录、数据库配置和已有数据。", "如果面板程序包尚未上传到 Release，脚本会提示等待 GitHub Actions 构建完成。"],
  },
  {
    label: "Docker 部署",
    description: "适合使用 Docker Compose 管理面板，脚本会安装 Docker、拉取 GitHub Packages 预编译镜像并启动容器。",
    directory: "/opt/forwardx-docker",
    service: "forwardx-panel 容器",
    install: `${panelDockerCommandPrefix} install`,
    upgrade: `${panelDockerCommandPrefix} upgrade`,
    uninstall: `${panelDockerCommandPrefix} uninstall`,
    versionedUpgrade: `curl -fsSL ${panelDockerScriptUrl} | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade`,
    notes: ["默认映射 Web 端口为 3000，可通过 PORT 环境变量指定。", "升级会保留 .env、部署目录 data 数据和 Docker 数据卷。", "如果 latest 镜像尚未构建到目标版本，脚本会提示稍后重试并保留旧容器运行。"],
  },
] as const;

const manualPanelUpgradeCommands = [
  {
    label: "本地部署",
    command: panelInstallGuideCommands[0].upgrade,
  },
  {
    label: "Docker 部署",
    command: panelInstallGuideCommands[1].upgrade,
  },
];

const directForwardProtocolKeys = [...FORWARD_TYPES] as const;
const tunnelForwardProtocolKeys = [...TUNNEL_PROTOCOLS] as const;
const LOG_PAGE_SIZE = 200;
const settingsTabTriggerClass = "min-w-0 justify-center gap-1.5 px-2 text-xs sm:w-[7.5rem] sm:px-3 sm:text-sm [&>svg]:shrink-0";

const defaultHomepageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ForwardX</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #0f172a;
      background: linear-gradient(135deg, #f8fafc 0%, #ecfeff 48%, #fff7ed 100%);
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
      border: 1px solid rgba(16, 185, 129, .28);
      background: rgba(255, 255, 255, .72);
      color: #047857;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
    }
    h1 {
      margin: 18px 0 14px;
      font-size: clamp(42px, 7vw, 76px);
      line-height: .95;
      letter-spacing: 0;
    }
    p {
      max-width: 620px;
      color: #475569;
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
      color: white;
      background: #0f172a;
    }
    .btn.secondary {
      color: #0f172a;
      border: 1px solid rgba(15, 23, 42, .16);
      background: rgba(255, 255, 255, .7);
    }
    .panel {
      border: 1px solid rgba(15, 23, 42, .08);
      background: rgba(255, 255, 255, .76);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 24px 80px rgba(15, 23, 42, .12);
      backdrop-filter: blur(18px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .item {
      border: 1px solid rgba(15, 23, 42, .08);
      border-radius: 12px;
      padding: 16px;
      background: rgba(248, 250, 252, .72);
    }
    .item b {
      display: block;
      margin-bottom: 6px;
    }
    .item span {
      color: #64748b;
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

const settingsTabs = ["system", "telegram", "email", "backup", "install", "logs"] as const;
type SettingsTab = typeof settingsTabs[number];
type DatabaseType = "sqlite" | "mysql" | "postgresql";

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
        <div className="w-full sm:flex sm:justify-start">
          <div className="w-full sm:w-auto">
            <TabsList className="grid h-auto w-full grid-cols-2 justify-start gap-1 bg-muted/50 sm:inline-flex sm:w-auto sm:flex-wrap">
              <TabsTrigger value="system" className={settingsTabTriggerClass}>
                <Settings2 className="h-3.5 w-3.5" />
                系统配置
              </TabsTrigger>
              <TabsTrigger value="telegram" className={settingsTabTriggerClass}>
                <Send className="h-3.5 w-3.5" />
                Telegram
              </TabsTrigger>
              <TabsTrigger value="email" className={settingsTabTriggerClass}>
                <Mail className="h-3.5 w-3.5" />
                邮箱设置
              </TabsTrigger>
              <TabsTrigger value="backup" className={settingsTabTriggerClass}>
                <Database className="h-3.5 w-3.5" />
                备份恢复
              </TabsTrigger>
              <TabsTrigger value="install" className={settingsTabTriggerClass}>
                <Terminal className="h-3.5 w-3.5" />
                安装说明
              </TabsTrigger>
              <TabsTrigger value="logs" className={settingsTabTriggerClass}>
                <FileText className="h-3.5 w-3.5" />
                面板日志
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        {/* Install Guide Tab */}
        <TabsContent value="install" className="space-y-4">
          <Card className="border-border/40 bg-card/60 backdrop-blur-md">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCode className="h-4 w-4" />
                安装说明
              </CardTitle>
              <CardDescription>
                面板服务与 Agent 主机的部署说明。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/30 border border-border/40">
                <Settings2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <p>
                    <span className="font-medium">当前面板地址：</span>
                    <code className="ml-1 font-mono text-foreground">{panelUrl}</code>
                  </p>
                  <p className="text-muted-foreground">
                    首次部署完成后打开面板地址，按页面提示完成数据库初始化和管理员创建。
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-medium">面板部署流程</p>
                <div className="grid gap-3 sm:grid-cols-4">
                  {["选择本地部署或 Docker 部署", "在服务器用 root 权限执行安装命令", "打开面板完成初始化配置", "后续使用升级命令更新面板"].map((step, i) => (
                    <div key={i} className="flex gap-3 items-start">
                      <span className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <span className="text-sm text-muted-foreground">{step}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border/30 bg-muted/20 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-medium">Agent 部署流程</p>
                  <Badge variant="outline" className="w-fit text-[10px]">
                    脚本从主机管理获取
                  </Badge>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    "在主机管理 > Token 管理中添加主机",
                    "点击对应 Token 的安装命令按钮并复制命令",
                    "在被控 Linux 主机用 root 权限执行安装命令",
                    "回到主机管理确认 Agent 在线后创建转发",
                  ].map((step, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {i + 1}
                      </span>
                      <span className="text-sm text-muted-foreground">{step}</span>
                    </div>
                  ))}
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li>- Agent 安装命令与具体 Token 绑定，安装说明页不展示通用安装脚本。</li>
                  <li>- 安装、升级、卸载命令都可在主机管理的 Token 管理中通过对应 Token 的安装命令弹窗获取。</li>
                  <li>- 一个 Token 建议只用于一台被控主机；Token 泄露后请删除并重新创建。</li>
                </ul>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {panelInstallGuideCommands.map((guide) => (
                  <div key={guide.label} className="rounded-lg border border-border/30 bg-muted/20 p-4">
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{guide.label}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{guide.description}</p>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {guide.service}
                      </Badge>
                    </div>
                    <div className="mb-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                      <div className="rounded border border-border/30 bg-background/40 p-2">
                        <span className="block text-[10px] uppercase text-muted-foreground/70">默认目录</span>
                        <code className="mt-1 block font-mono text-foreground">{guide.directory}</code>
                      </div>
                      <div className="rounded border border-border/30 bg-background/40 p-2">
                        <span className="block text-[10px] uppercase text-muted-foreground/70">默认端口</span>
                        <code className="mt-1 block font-mono text-foreground">3000</code>
                      </div>
                    </div>
                    <div className="space-y-3">
                      {[
                        { label: "安装命令", icon: Download, command: guide.install },
                        { label: "升级命令", icon: RefreshCw, command: guide.upgrade },
                        { label: "卸载命令", icon: Trash2, command: guide.uninstall },
                      ].map((item) => {
                        const Icon = item.icon;
                        return (
                          <div key={item.label}>
                            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                              <Icon className="h-3 w-3" />
                              {item.label}
                            </p>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <code className="min-w-0 flex-1 rounded border bg-background/50 p-3 font-mono text-xs break-all">
                                {item.command}
                              </code>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="shrink-0 self-end sm:self-auto"
                                onClick={() => copyToClipboard(item.command)}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      <div>
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                          <Github className="h-3 w-3" />
                          指定版本升级
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <code className="min-w-0 flex-1 rounded border bg-background/50 p-3 font-mono text-xs break-all">
                            {guide.versionedUpgrade}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0 self-end sm:self-auto"
                            onClick={() => copyToClipboard(guide.versionedUpgrade)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                    <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
                      {guide.notes.map((note) => (
                        <li key={note}>- {note}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <p className="text-xs text-amber-400 font-medium mb-1">注意事项</p>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>- 安装和升级需要 root 权限。</li>
                  <li>- 本地部署会自动配置 systemd 服务；Docker 部署会使用 Docker Compose 启动容器。</li>
                  <li>- 本地部署可通过 FORWARDX_TARGET_VERSION 指定 tag 或版本号；Docker 部署统一拉取 latest 镜像并校验目标版本。</li>
                  <li>- 卸载命令只有输入 y 后才会删除部署目录或 Docker 数据卷，删除前请确认已经备份数据。</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

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
  const [panelLogLevel, setPanelLogLevel] = useState<"all" | "info" | "warn" | "error" | "log">("all");
  const [exportLevel, setExportLevel] = useState<"all" | "info" | "warn" | "error" | "log">("all");
  const [panelLogOffset, setPanelLogOffset] = useState(0);
  const { data: panelLogs, isLoading: panelLogsLoading, isFetching: panelLogsFetching, refetch: refetchPanelLogs } = trpc.system.panelLogs.useQuery({
    level: panelLogLevel,
    limit: LOG_PAGE_SIZE,
    offset: panelLogOffset,
  }, {
    refetchInterval: 10000,
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
    if (level === "info") return "text-sky-600 dark:text-sky-400";
    return "text-muted-foreground";
  };
  const panelLogEntries = panelLogs?.logs || [];
  const resetPanelLogs = (level: typeof panelLogLevel) => {
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
  const summary = (panelLogs?.summary || {}) as Record<"all" | "info" | "warn" | "error" | "log", number>;
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

  const { data: currentMigrationCode } = trpc.system.getMigrationCode.useQuery(undefined, {
    refetchInterval: 1000,
  });
  const { data: databaseSwitchStatus } = trpc.system.databaseSwitchStatus.useQuery(undefined, {
    refetchInterval: 15000,
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

  const exportBackupMutation = trpc.system.exportPanelBackup.useMutation({
    onSuccess: (data) => {
      downloadTextFile(data.filename, data.content, data.mimeType || "application/json;charset=utf-8");
      setBackupPassword("");
      setBackupPasswordConfirm("");
      toast.success("加密备份已导出");
    },
    onError: (err) => toast.error(err.message || "导出备份失败"),
  });

  const importBackupMutation = trpc.system.importPanelBackup.useMutation({
    onSuccess: async (result) => {
      setShowImportConfirm(false);
      setImportPassword("");
      setImportContent("");
      setImportFilename("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await utils.system.backupSummary.invalidate();
      toast.success(result.mode === "incremental" ? "增量导入完成，当前面板数据已保留" : "备份恢复完成");
    },
    onError: (err) => toast.error(err.message || "导入备份失败"),
  });

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
  const backupSummaryReady = !!backupSummary;
  const hasExistingData = !!backupSummary?.hasExistingData;

  const handleExportBackup = () => {
    if (backupPassword.length < 8) {
      toast.error("备份密码至少需要 8 位");
      return;
    }
    if (backupPassword !== backupPasswordConfirm) {
      toast.error("两次输入的备份密码不一致");
      return;
    }
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
          { label: "当前用户", value: backupSummary?.userCount },
          { label: "当前主机", value: backupSummary?.hostCount },
          { label: "当前规则", value: backupSummary?.ruleCount },
          { label: "当前隧道", value: backupSummary?.tunnelCount },
          { label: "转发组", value: backupSummary?.forwardGroupCount },
        ].map((item) => {
          const isValueLoading = backupSummaryLoading && !backupSummary;
          return (
            <Card key={item.label} className="border-border/40 bg-card/60 backdrop-blur-md">
              <CardContent className="min-h-[80px] p-4">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <div className="mt-1 flex h-7 items-center">
                  {isValueLoading ? (
                    <Skeleton className="h-6 w-12" />
                  ) : (
                    <p className="text-xl font-semibold leading-7">{item.value ?? 0}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>
          {!backupSummaryReady
            ? "正在检查当前面板数据"
            : hasExistingData
              ? "当前面板已有业务数据，迁移将按增量方式执行"
              : "当前面板没有业务数据，可作为完整恢复执行"}
        </AlertTitle>
        <AlertDescription>
          {backupSummaryReady
            ? "增量迁移会保留新面板现有主机、用户、规则和订单数据，并把旧面板数据追加导入；重复的用户账号、主机 Token、订单号、兑换码会复用现有记录。"
            : "加载完成后会根据当前面板是否已有业务数据，自动判断完整恢复或增量迁移。"}
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
              在新面板填写旧面板地址和迁移码，在线拉取旧面板数据。
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
                  {migrationJob.error || migrationJob.message || "在线迁移过程中请保持新旧面板可访问。"}
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

          <Alert className="border-sky-500/25 bg-sky-500/10 text-sky-800 dark:text-sky-200">
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
            <Button className="gap-2" onClick={handleExportBackup} disabled={exportBackupMutation.isPending}>
              <Download className="h-4 w-4" />
              导出加密备份
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
            <Button className="gap-2" onClick={openImportConfirm} disabled={importBackupMutation.isPending}>
              <Upload className="h-4 w-4" />
              导入并恢复
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
              onClick={() => importBackupMutation.mutate({
                content: importContent,
                password: importPassword,
                targetPanelUrl: panelUrl || undefined,
                confirmed: true,
              })}
              disabled={importBackupMutation.isPending}
            >
              确认导入
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
              在线迁移完成后旧面板会通知 Agent 切换到当前面板，旧面板随后会进入迁移失效状态。
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
          <Alert className="border-sky-500/25 bg-sky-500/10 text-sky-800 dark:text-sky-200">
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
    <Card className="border-sky-500/25 bg-sky-500/5 backdrop-blur-md">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-sky-500" />
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
            <div className="grid gap-3 lg:grid-cols-3">
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
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="space-y-2">
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
                    当前仅保存模型配置，后续 Telegram 自然语言指令会使用这里的配置。
                  </p>
                </div>
                <div className="rounded-lg border border-border/40 bg-background/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">启用 AI 助手</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {providerConfigured
                          ? `${providerLabel} · ${deepseekModel}${selectedModelMeta?.isFree === true ? " · Free" : (selectedModelMeta?.isFree === false ? " · Paid" : "")}`
                          : "保存 API Key 后启用"}
                      </p>
                    </div>
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

              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-2">
                  <Label>提供商</Label>
                  <Select value={deepseekProvider} onValueChange={handleProviderChange}>
                    <SelectTrigger>
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
                  <Label>接口地址</Label>
                  <Input
                    type="text"
                    value={deepseekBaseUrl}
                    onChange={(e) => updateActiveProviderConfig({ baseUrl: e.target.value })}
                    placeholder={activeProviderDefaults.baseUrl}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2 lg:col-span-2">
                  <Label>模型</Label>
                  <Input
                    type="text"
                    value={deepseekModel}
                    onChange={(e) => updateActiveProviderConfig({ model: e.target.value })}
                    placeholder={activeProviderDefaults.model}
                    className="font-mono"
                  />
                  <div className="rounded-lg border border-border/40 bg-background/50 p-2">
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
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder="从列表选择模型" />
                        </SelectTrigger>
                        <SelectContent className="max-h-72">
                          {models.map((item: any) => (
                            <SelectItem key={String(item?.id || "")} value={String(item?.id || "")}>
                              {String(item?.id || "")}
                              {item?.isFree === true ? " · 🆓free" : (item?.isFree === false ? " · 💳paid" : " · ?")}
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
                </div>
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
                        关闭后仅管理员可执行 AI 对话管理写操作（查询不受影响）。
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
  | "branding"
  | "panelUrl"
  | "registration"
  | "twoFactor"
  | "homepage"
  | "ddns"
  | "forwardProtocols"
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

function SystemInfoSection() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const { data: upgradeStatus, refetch: refetchUpgradeStatus } = trpc.system.upgradeStatus.useQuery(
    undefined,
    { refetchInterval: 5000 }
  );
  const [panelUrlInput, setPanelUrlInput] = useState("");
  const [siteTitleInput, setSiteTitleInput] = useState("ForwardX");
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
  const [homepageEnabled, setHomepageEnabled] = useState(true);
  const [homepageCustomEnabled, setHomepageCustomEnabled] = useState(false);
  const [homepageHtml, setHomepageHtml] = useState("");
  const [forwardProtocols, setForwardProtocols] = useState<ForwardProtocolSettings>(() => normalizeForwardProtocolSettings());
  const [githubAcceleratorEnabled, setGithubAcceleratorEnabled] = useState(false);
  const [githubAcceleratorUrlInput, setGithubAcceleratorUrlInput] = useState(defaultGithubAcceleratorUrl);
  const [agentPreferPanelInstall, setAgentPreferPanelInstall] = useState(false);
  const [ddnsEnabled, setDdnsEnabled] = useState(false);
  const [ddnsProvider, setDdnsProvider] = useState<DdnsProvider>("disabled");
  const [ddnsTtl, setDdnsTtl] = useState("600");
  const [ddnsCloudflareZoneId, setDdnsCloudflareZoneId] = useState("");
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
  const [showForwardProtocolDialog, setShowForwardProtocolDialog] = useState(false);
  const [savingSetting, setSavingSetting] = useState<SystemSettingsSaveKey | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showDockerUpgradeScript, setShowDockerUpgradeScript] = useState(false);
  const previousUpgradeStatus = useRef<string | null>(null);
  const shownDockerUpgradeVersion = useRef<string | null>(null);
  const lastPanelUpdateCheck = useRef(0);

  useEffect(() => {
    if (settings) {
      setPanelUrlInput(settings.panelPublicUrl || "");
      setSiteTitleInput(settings.siteTitle || "ForwardX");
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
      setHomepageEnabled(settings.homepageEnabled ?? true);
      setHomepageCustomEnabled(!!settings.homepageCustomEnabled);
      setHomepageHtml(settings.homepageHtml || "");
      setForwardProtocols(normalizeForwardProtocolSettings(settings.forwardProtocols));
      setGithubAcceleratorEnabled(!!settings.githubAccelerator?.enabled);
      setGithubAcceleratorUrlInput(settings.githubAccelerator?.url || "");
      setAgentPreferPanelInstall(!!settings.agentPreferPanelInstall);
      setDdnsEnabled(!!settings.ddns?.enabled);
      setDdnsProvider(isDdnsProvider(settings.ddns?.provider) ? settings.ddns.provider : "disabled");
      const ddnsUnifiedTtl = String(settings.ddns?.ttl || settings.ddns?.huaweicloudTtl || settings.ddns?.aliyunTtl || settings.ddns?.tencentcloudTtl || 600);
      setDdnsTtl(ddnsUnifiedTtl);
      setDdnsCloudflareZoneId(settings.ddns?.cloudflareZoneId || "");
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
    if (previous === "running" && status === "success") {
      toast.success(`面板升级成功，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`);
    }
    if (previous === "running" && status === "waiting_assets") {
      toast.info(upgradeStatus?.job?.error || "发布资产仍在构建中，请稍后重试");
    }
    if (previous === "running" && status === "error") {
      toast.error(upgradeStatus?.job?.error || "面板升级失败");
    }
    previousUpgradeStatus.current = status;
  }, [upgradeStatus?.job?.status, upgradeStatus?.job?.error]);

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

  const handleSavePanelUrl = () => {
    const v = panelUrlInput.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      toast.error("面板公开地址必须以 http:// 或 https:// 开头");
      return;
    }
    saveSystemSettings("panelUrl", { panelPublicUrl: v });
  };

  const handleSaveBranding = () => {
    saveSystemSettings("branding", {
      siteTitle: siteTitleInput.trim(),
      lookingGlassUserEnabled,
    }, {
      onSuccess: () => utils.system.publicInfo.invalidate(),
    });
  };

  const openWebPortConfirm = () => {
    const port = Math.floor(Number(webPortInput));
    if (!isValidWebPort(webPortInput)) {
      toast.error("端口必须是 1-65535 的数字");
      return;
    }
    if (port === Number(settings?.webPort || 3000)) {
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

  const handleSaveHomepage = () => {
    saveSystemSettings("homepage", { homepageEnabled, homepageCustomEnabled, homepageHtml });
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
        cloudflareZoneId: ddnsCloudflareZoneId,
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

  const handlePreviewHomepage = () => {
    const previewId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const previewKey = `forwardx.homepage.preview.${previewId}`;
    try {
      window.localStorage.setItem(previewKey, homepageHtml);
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    } catch {
      window.sessionStorage.setItem("forwardx.homepage.preview", homepageHtml);
    }
    window.open(`/homepage-preview?mode=draft&id=${encodeURIComponent(previewId)}`, "_blank", "noopener,noreferrer");
  };

  const handleUseHomepageTemplate = () => {
    if (homepageHtml.trim() && !window.confirm("当前编辑内容会被示例模板覆盖，确定继续吗？")) return;
    setHomepageHtml(defaultHomepageHtml);
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
      iconClassName: "text-sky-500",
    },
    {
      label: "Telegram 群组",
      url: "https://t.me/ForwardX_panel",
      icon: UserPlus,
      iconClassName: "text-blue-500",
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
                id="site-title"
                value={siteTitleInput}
                onChange={(e) => setSiteTitleInput(e.target.value.slice(0, 64))}
                placeholder="ForwardX"
                className="flex-1"
              />
              <Button
                onClick={handleSaveBranding}
                disabled={isSavingSetting("branding")}
              >
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
            <Button onClick={handleSaveBranding} disabled={isSavingSetting("branding")}>
              保存
            </Button>
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
              修改本地部署面板的 Web 访问端口。
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
                disabled={!settings?.webPortManagement?.enabled || updateWebPortMutation.isPending}
              >
                修改端口
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              当前监听端口：{settings?.webPort || 3000}。修改后服务会重启，请使用新端口访问后台。
            </p>
            {!settings?.webPortManagement?.enabled && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Docker 部署不支持后台修改端口</AlertTitle>
                <AlertDescription>
                  Docker 用户请自行配置端口映射；非 Docker 部署可在此修改监听端口。
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
                  当前协议：{settings?.panelSsl?.activeProtocol === "https" ? "HTTPS" : "HTTP"}，端口：{settings?.webPort || 3000}
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
              确认后面板会重启，当前端口 {settings?.webPort || 3000} 将切换为 {panelSslEnabled ? "HTTPS" : "HTTP"} 访问。
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
              <div className="w-full sm:w-56">
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
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Zone ID（可选）</Label>
                <Input value={ddnsCloudflareZoneId} onChange={(e) => setDdnsCloudflareZoneId(e.target.value)} placeholder="可留空，系统会自动识别 Zone" />
              </div>
              <div className="space-y-2">
                <Label>API Token</Label>
                <Input
                  value={ddnsCloudflareApiToken}
                  onChange={(e) => setDdnsCloudflareApiToken(e.target.value)}
                  placeholder={settings?.ddns?.cloudflareTokenMasked || "需要 Zone:Read + DNS:Edit 权限"}
                  type="password"
                />
                <p className="text-xs text-muted-foreground">留空则保留已保存 Token；未填写 Zone ID 时 Token 需具备 Zone:Read + DNS:Edit 权限。</p>
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
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              转发协议总开关
            </DialogTitle>
            <DialogDescription>
              开启或关闭可用协议。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
              <div>
                <p className="text-sm font-medium">端口转发</p>
                <p className="text-xs text-muted-foreground">端口转发工具开关。</p>
              </div>
              <div className="flex flex-col gap-2">
                {directForwardProtocolKeys.map((key) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                  >
                    <span className="text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                    <Switch checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
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
                    className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 px-3 py-2"
                  >
                    <span className="text-sm">{FORWARD_PROTOCOL_LABELS[key]}</span>
                    <Switch checked={forwardProtocols[key]} onCheckedChange={(checked) => setForwardProtocolEnabled(key, checked)} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={closeForwardProtocolDialog}>
              取消
            </Button>
            <Button onClick={handleSaveForwardProtocols} disabled={isSavingSetting("forwardProtocols")}>
              保存协议开关
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border/40 bg-card/60 backdrop-blur-md lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4 text-primary" />
              公开首页
            </CardTitle>
            <CardDescription>
              设置未登录时展示的首页。
            </CardDescription>
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
            <div className="flex justify-end">
              <Button variant="outline" onClick={handleSaveHomepage} disabled={isSavingSetting("homepage")}>
                保存首页设置
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 版本升级 */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="h-4 w-4 text-primary" />
              版本升级
            </CardTitle>
            <CardDescription>
              检查并升级 ForwardX。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">当前版本</p>
                <p className="mt-1 font-mono text-sm">v{upgradeStatus?.currentVersion || settings?.version}</p>
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
                        ? "升级成功"
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "发布资产构建中"
                        : upgradeStatus.job.status === "error"
                          ? "升级出现异常"
                          : "正在升级"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {upgradeStatus.job.status === "success"
                        ? `已完成 ${upgradeStatus.job.targetVersion || ""} 升级，${PANEL_UPGRADE_REFRESH_DELAY_SECONDS} 秒后自动刷新`
                        : upgradeStatus.job.status === "waiting_assets"
                          ? "GitHub Actions 仍在生成面板安装包或镜像，请稍后重新检查更新"
                        : upgradeStatus.job.status === "error"
                          ? "升级未完成，请查看下方异常信息"
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
                    <p className="font-medium text-destructive">自动升级失败时，可以在服务器执行对应的一键脚本手动升级：</p>
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

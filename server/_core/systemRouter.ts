import { router, publicProcedure, adminProcedure } from "./trpc";
import { z } from "zod";
import * as db from "../db";
import { ENV } from "../env";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { clearPanelLogs, formatPanelLogsForExport, getPanelLogPage } from "./panelLogger";
import { approveMigrationRequest, createMigrationCode, getCurrentMigrationCode, rejectMigrationRequest } from "../migrationCodes";
import {
  decryptMigrationSnapshotBackup,
  encryptMigrationSnapshot,
  exportMigrationSnapshot,
  getMigrationJob,
  getPanelDataSummary,
  importMigrationSnapshot,
  pruneMigrationSnapshotForPanelBackup,
  summarizeMigrationSnapshot,
  startPanelMigration as beginPanelMigration,
} from "../migration";
import { sendMail } from "../email";
import { refreshTelegramBotProfile, resetTelegramBotPolling, startTelegramBot } from "../telegramBot";
import { pushAgentRefresh, pushAgentUpgrade } from "../agentEvents";
import { AGENT_ASSET_NAMES } from "../agentAssets";
import { maskSecret } from "../ddns";
import type { DatabaseConfig } from "../dbRuntime";
import { defaultSqlitePath } from "../dbRuntime";
import {
  getDatabaseSwitchJob,
  getDatabaseSwitchStatus,
  startDatabaseSwitch,
  testDatabaseSwitchTarget,
} from "../databaseSwitch";
import {
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardProtocolSettings,
} from "../../shared/forwardTypes";
import {
  SIDEBAR_MENU_KEYS,
  normalizeSidebarMenuSettings,
} from "../../shared/sidebarMenu";
import { getAvatarDataUrlByteLength, isValidBrandLogoValue } from "../../shared/avatar";
import { generateSelfSignedPanelSslCertificate, readPanelSslSettings, validatePanelSslConfig } from "../panelSsl";
import {
  AGENT_VERSION,
  ANDROID_APK_RELEASE_VERSION,
  ANDROID_APP_VERSION,
  APP_VERSION,
  PANEL_AGENT_COMPATIBILITY,
  PANEL_AGENT_COMPATIBILITY_LIMIT,
} from "../../shared/versions";
import {
  DEFAULT_PERSONALIZATION_BACKGROUND,
  builtinWallpaperById,
  clampBackgroundBlur,
  clampBackgroundOpacity,
  isBuiltinWallpaperId,
  normalizePersonalizationThemePresetId,
  type PersonalizationBackgroundConfig,
} from "../../shared/personalization";

export {
  AGENT_VERSION,
  ANDROID_APK_RELEASE_VERSION,
  ANDROID_APP_VERSION,
  APP_VERSION,
} from "../../shared/versions";

/**
 * 系统级别 router：
 *   - health：健康检查
 *   - publicInfo：未登录可见的元信息（开源仓库地址、版本号）
 *   - settings：登录后只读访问/管理员可写的系统设置
 */

export const REPO_URL = "https://github.com/poouo/Forwardx";
/** Telegram 双向消息机器人：用户可通过此反馈问题、接收补充信息 */
export const TELEGRAM_BOT_URL = "https://t.me/miyin_private_bot";
const ANDROID_APK_DOWNLOAD_URL =
  `${REPO_URL}/releases/download/v${ANDROID_APK_RELEASE_VERSION}/forwardx-android-v${ANDROID_APP_VERSION}.apk`;
const UPDATE_CHECK_COOLDOWN_MS = 60 * 1000;
const UPGRADE_ASSETS_PENDING_EXIT_CODE = 12;
const MANUAL_LOCAL_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade";
const MANUAL_DOCKER_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade";
const DEFAULT_DOCKER_IMAGE = "ghcr.io/poouo/forwardx:latest";
const forwardProtocolSettingsSchema = z.object(
  Object.fromEntries(
    [...FORWARD_TYPES, ...TUNNEL_PROTOCOLS].map((key) => [key, z.boolean().optional()])
  ) as Record<(typeof FORWARD_TYPES[number] | typeof TUNNEL_PROTOCOLS[number]), z.ZodOptional<z.ZodBoolean>>
);
const sidebarMenuSettingsSchema = z.object(
  Object.fromEntries(
    SIDEBAR_MENU_KEYS.map((key) => [key, z.boolean().optional()])
  ) as Record<typeof SIDEBAR_MENU_KEYS[number], z.ZodOptional<z.ZodBoolean>>
);

function readSidebarMenuSettings(all: Record<string, string | undefined>) {
  const normalized = normalizeSidebarMenuSettings(
    parseSidebarMenuSettings(all.sidebarMenu),
  );
  normalized.plugins = all.pluginsEnabled === "true";
  return normalized;
}
const panelLogLevelSchema = z.enum(["all", "log", "info", "warn", "error"]);
const ddnsProviderSchema = z.enum(["disabled", "cloudflare", "webhook", "huaweicloud", "aliyun", "tencentcloud"]);
const RESERVED_PUBLIC_HOST_MONITOR_PATHS = new Set([
  "api",
  "setup",
  "login",
  "homepage-preview",
  "profile",
  "hosts",
  "rules",
  "looking-glass",
  "forward-groups",
  "tunnels",
  "users",
  "email-settings",
  "payments",
  "billing",
  "traffic-billing",
  "plans",
  "store",
  "subscriptions",
  "wallet",
  "announcements",
  "settings",
  "404",
]);

function normalizePublicHostMonitorPath(value: unknown) {
  const text = String(value || "dev")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return text || "dev";
}

function assertPublicHostMonitorPath(value: unknown) {
  const path = normalizePublicHostMonitorPath(value);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(path)) {
    throw new Error("主机监控面板路径只能包含小写字母、数字、短横线或下划线，且不能超过 64 个字符");
  }
  if (RESERVED_PUBLIC_HOST_MONITOR_PATHS.has(path)) {
    throw new Error("主机监控面板路径不能与系统内置路径冲突");
  }
  return path;
}

function normalizePublicHostMonitorTitle(value: unknown) {
  return String(value || "").trim().slice(0, 80);
}
const aiProviderSchema = z.enum(["deepseek", "siliconflow", "custom"]);
type AiProvider = z.infer<typeof aiProviderSchema>;
const DEFAULT_AI_PROVIDER: AiProvider = "deepseek";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
const DEFAULT_DEEPSEEK_MAX_TOKENS = 1024;
const DEFAULT_DEEPSEEK_TEMPERATURE = 0.2;
const logPageInputSchema = z.object({
  level: panelLogLevelSchema.default("all"),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});
const siteTitleSchema = z.string().trim().max(64);
const brandLogoSchema = z.string().max(150 * 1024);
const personalizationBackgroundImageMaxBytes = 3 * 1024 * 1024;
const personalizationBackgroundConfigMaxLength = 25 * 1024 * 1024;
const imageDataUrlRe = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const backgroundSourceSchema = z.enum(["none", "builtin", "upload", "url"]);
const backgroundUrlTypeSchema = z.enum(["image", "video"]);
const personalizationBackgroundSchema = z.object({
  source: backgroundSourceSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  blur: z.number().min(0).max(32).optional(),
  selectedId: z.string().max(80).optional().nullable(),
  url: z.string().max(1200).optional(),
  urlType: backgroundUrlTypeSchema.optional(),
  images: z.array(z.object({
    id: z.string().max(80),
    name: z.string().max(120).optional(),
    dataUrl: z.string().max(5 * 1024 * 1024),
    size: z.number().int().min(0).max(personalizationBackgroundImageMaxBytes).optional(),
    createdAt: z.number().int().min(0).optional(),
  })).max(6).optional(),
});
const githubAcceleratorUrlSchema = z.string().trim().max(256);
const mysqlDatabaseConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 MySQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  user: z.string().trim().min(1, "请输入 MySQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});
const postgresqlDatabaseConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 PostgreSQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  user: z.string().trim().min(1, "请输入 PostgreSQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});
const databaseConfigInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sqlite"), sqlite: z.object({ path: z.string().trim().min(1).default(defaultSqlitePath()) }) }),
  z.object({ type: z.literal("mysql"), mysql: mysqlDatabaseConfigInput }),
  z.object({ type: z.literal("postgresql"), postgresql: postgresqlDatabaseConfigInput }),
]);

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  source: "release" | "tag" | "main" | null;
  publishedAt: string | null;
  checkedAt: string;
  deployable?: boolean;
  artifactVersion?: string | null;
  pendingReason?: string | null;
  error?: string;
};

type GithubReleaseInfo = {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: Array<{ name?: string; state?: string; size?: number }>;
};

type VersionCompatibilityInfo = {
  panelVersion: string;
  agentVersion: string;
  releaseUrl: string | null;
  publishedAt: string | null;
};

type RollbackVersionInfo = {
  currentPanelVersion: string;
  currentAgentVersion: string;
  panelVersions: Array<{
    panelVersion: string;
    releaseUrl: string | null;
    publishedAt: string | null;
    compatibleAgentVersion: string | null;
  }>;
  agentVersions: Array<{
    agentVersion: string;
    panelVersion: string;
    releaseUrl: string | null;
    publishedAt: string | null;
  }>;
  compatibility: VersionCompatibilityInfo[];
  checkedAt: string;
  error?: string;
};

type DeploymentInfo = {
  docker: boolean;
  dockerSocket: boolean;
  manualUpgradeCommand: string;
};

type UpgradeJob = {
  status: "idle" | "running" | "success" | "error" | "waiting_assets";
  mode: "upgrade" | "rollback" | null;
  startedAt: string | null;
  finishedAt: string | null;
  targetVersion: string | null;
  logs: string[];
  error: string | null;
};

let lastUpdateInfo: UpdateInfo | null = null;
let updateCheckInFlight: Promise<UpdateInfo> | null = null;
let rollbackVersionInfo: RollbackVersionInfo | null = null;
let rollbackVersionCheckInFlight: Promise<RollbackVersionInfo> | null = null;
let upgradeJob: UpgradeJob = {
  status: "idle",
  mode: null,
  startedAt: null,
  finishedAt: null,
  targetVersion: null,
  logs: [],
  error: null,
};

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function isValidBackgroundImageDataUrl(value: string) {
  const text = String(value || "").trim();
  if (!text || text.length > 5 * 1024 * 1024) return false;
  if (!imageDataUrlRe.test(text)) return false;
  return getAvatarDataUrlByteLength(text) <= personalizationBackgroundImageMaxBytes;
}

function normalizeBackgroundUrl(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^https?:\/\//i.test(text)) throw new Error("背景链接必须以 http:// 或 https:// 开头");
  return text;
}

function normalizePersonalizationBackground(input: unknown): PersonalizationBackgroundConfig {
  const source = typeof input === "object" && input ? input as any : {};
  const images = Array.isArray(source.images)
    ? source.images
      .slice(0, 6)
      .map((item: any) => ({
        id: String(item?.id || "").trim().replace(/[^a-z0-9_-]/gi, "").slice(0, 80),
        name: String(item?.name || "上传背景").trim().slice(0, 120),
        dataUrl: String(item?.dataUrl || "").trim(),
        size: Number(item?.size || 0) || undefined,
        createdAt: Number(item?.createdAt || 0) || Date.now(),
      }))
      .filter((item: any) => item.id && isValidBackgroundImageDataUrl(item.dataUrl))
    : [];
  const rawSource = String(source.source || DEFAULT_PERSONALIZATION_BACKGROUND.source);
  const nextSource = rawSource === "builtin" || rawSource === "upload" || rawSource === "url" ? rawSource : "none";
  const selectedId = source.selectedId ? String(source.selectedId).trim().slice(0, 80) : null;
  let urlType: PersonalizationBackgroundConfig["urlType"] = source.urlType === "video" ? "video" : "image";
  const url = normalizeBackgroundUrl(source.url);

  let normalizedSource = nextSource;
  let normalizedSelectedId: string | null = selectedId;
  if (normalizedSource === "builtin") {
    if (!isBuiltinWallpaperId(selectedId)) {
      normalizedSource = "none";
      normalizedSelectedId = null;
    }
  } else if (normalizedSource === "upload") {
    if (!images.some((item: any) => item.id === selectedId)) {
      normalizedSource = "none";
      normalizedSelectedId = null;
    }
  } else if (normalizedSource === "url") {
    if (!url) normalizedSource = "none";
    normalizedSelectedId = null;
  } else {
    normalizedSelectedId = null;
  }
  if (normalizedSource !== "url") {
    urlType = "image";
  }

  return {
    source: normalizedSource as PersonalizationBackgroundConfig["source"],
    opacity: clampBackgroundOpacity(source.opacity),
    blur: clampBackgroundBlur(source.blur),
    selectedId: normalizedSelectedId,
    url,
    urlType,
    images,
  };
}

function readPersonalizationBackground(all: Record<string, string | null>) {
  const raw = String(all.personalizationBackground || "").trim();
  if (!raw) return DEFAULT_PERSONALIZATION_BACKGROUND;
  try {
    return normalizePersonalizationBackground(JSON.parse(raw));
  } catch {
    return DEFAULT_PERSONALIZATION_BACKGROUND;
  }
}

function resolvePersonalizationBackgroundUrl(config: PersonalizationBackgroundConfig) {
  if (config.source === "builtin") return builtinWallpaperById(config.selectedId)?.url || "";
  if (config.source === "upload") return config.images.find((item) => item.id === config.selectedId)?.dataUrl || "";
  if (config.source === "url") return config.url || "";
  return "";
}

function publicPersonalizationBackground(all: Record<string, string | null>) {
  const config = readPersonalizationBackground(all);
  const urlType = config.source === "url" && config.urlType === "video" ? "video" : "image";
  return {
    source: config.source,
    opacity: config.opacity,
    blur: config.blur,
    urlType,
    effectiveUrl: resolvePersonalizationBackgroundUrl(config),
  };
}

function compareVersions(a: string, b: string) {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function githubRepoParts(repoUrl: string) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error("GitHub 仓库地址格式不正确");
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

function githubApiBase(repoUrl: string) {
  const { owner, repo } = githubRepoParts(repoUrl);
  return `https://api.github.com/repos/${owner}/${repo}`;
}

function githubRawMainUrl(repoUrl: string, path: string) {
  const { owner, repo } = githubRepoParts(repoUrl);
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${path.replace(/^\/+/, "")}`;
}

function githubRawRefUrl(repoUrl: string, ref: string, path: string) {
  const { owner, repo } = githubRepoParts(repoUrl);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path.replace(/^\/+/, "")}`;
}

function panelBundleAssetUrl(version: string) {
  const normalized = normalizeVersion(version);
  return `${REPO_URL}/releases/download/v${normalized}/forwardx-panel-v${normalized}.tar.gz`;
}

function noCacheUrl(url: string) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_=${Date.now()}`;
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const res = await fetch(noCacheUrl(url), {
    cache: "no-store",
    headers: {
      "Accept": "application/vnd.github+json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": `ForwardX/${APP_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub API 请求失败：${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function fetchTextNoCache(url: string): Promise<string> {
  const res = await fetch(noCacheUrl(url), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": `ForwardX/${APP_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`HTTP 请求失败：${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchPanelBundleAssetStatus(version: string): Promise<{ ready: boolean; status: number; url: string }> {
  const url = panelBundleAssetUrl(version);
  const res = await fetch(noCacheUrl(url), {
    method: "HEAD",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": `ForwardX/${APP_VERSION}`,
    },
  });
  return { ready: res.ok, status: res.status, url };
}

function parseAgentVersionFromVersionsText(text: string) {
  const match = text.match(/AGENT_VERSION\s*=\s*["']v?([^"']+)["']/);
  return match?.[1] ? normalizeVersion(match[1]) : "";
}

function releaseSemver(release: GithubReleaseInfo) {
  const version = normalizeVersion(release.tag_name || "");
  return /^\d+\.\d+\.\d+$/.test(version) ? version : "";
}

async function fetchReleaseAgentVersion(panelVersion: string) {
  const normalized = normalizeVersion(panelVersion);
  const refs = [`v${normalized}`, normalized];
  for (const ref of refs) {
    try {
      const text = await fetchTextNoCache(githubRawRefUrl(REPO_URL, ref, "shared/versions.ts"));
      const agentVersion = parseAgentVersionFromVersionsText(text);
      if (agentVersion) return agentVersion;
    } catch {
      // Try the next tag format.
    }
  }
  return "";
}

function mergeCompatibilityRecords(records: VersionCompatibilityInfo[]) {
  const seen = new Set<string>();
  const output: VersionCompatibilityInfo[] = [];
  for (const record of records) {
    const panelVersion = normalizeVersion(record.panelVersion);
    const agentVersion = normalizeVersion(record.agentVersion);
    if (!panelVersion || !agentVersion) continue;
    const key = `${panelVersion}:${agentVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      panelVersion,
      agentVersion,
      releaseUrl: record.releaseUrl || `${REPO_URL}/releases/tag/v${panelVersion}`,
      publishedAt: record.publishedAt || null,
    });
    if (output.length >= PANEL_AGENT_COMPATIBILITY_LIMIT) break;
  }
  return output;
}

async function fetchRollbackVersionInfo(): Promise<RollbackVersionInfo> {
  const checkedAt = new Date().toISOString();
  const api = githubApiBase(REPO_URL);
  const releases = await fetchGithubJson<GithubReleaseInfo[]>(`${api}/releases?per_page=30`);
  const releaseVersions = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ release, panelVersion: releaseSemver(release) }))
    .filter((item) => !!item.panelVersion)
    .sort((a, b) => compareVersions(b.panelVersion, a.panelVersion));

  const rollbackPanelReleases = releaseVersions
    .filter((item) => compareVersions(item.panelVersion, APP_VERSION) < 0)
    .slice(0, PANEL_AGENT_COMPATIBILITY_LIMIT);

  const releaseCompatibility = await Promise.all(rollbackPanelReleases.map(async ({ release, panelVersion }) => {
    const agentVersion = await fetchReleaseAgentVersion(panelVersion);
    return {
      panelVersion,
      agentVersion,
      releaseUrl: release.html_url || `${REPO_URL}/releases/tag/v${panelVersion}`,
      publishedAt: release.published_at || null,
    };
  }));

  const builtinCompatibility = PANEL_AGENT_COMPATIBILITY.map((item) => ({
    panelVersion: normalizeVersion(item.panelVersion),
    agentVersion: normalizeVersion(item.agentVersion),
    releaseUrl: `${REPO_URL}/releases/tag/v${normalizeVersion(item.panelVersion)}`,
    publishedAt: null,
  }));
  const compatibility = mergeCompatibilityRecords([...releaseCompatibility, ...builtinCompatibility]);

  const panelVersions = rollbackPanelReleases.map(({ release, panelVersion }) => {
    const compatible = compatibility.find((item) => item.panelVersion === panelVersion);
    return {
      panelVersion,
      releaseUrl: release.html_url || `${REPO_URL}/releases/tag/v${panelVersion}`,
      publishedAt: release.published_at || null,
      compatibleAgentVersion: compatible?.agentVersion || null,
    };
  });

  const agentVersions: RollbackVersionInfo["agentVersions"] = [];
  const seenAgentVersions = new Set<string>();
  for (const item of compatibility) {
    if (!item.agentVersion || compareVersions(item.agentVersion, AGENT_VERSION) >= 0) continue;
    if (seenAgentVersions.has(item.agentVersion)) continue;
    seenAgentVersions.add(item.agentVersion);
    agentVersions.push({
      agentVersion: item.agentVersion,
      panelVersion: item.panelVersion,
      releaseUrl: item.releaseUrl,
      publishedAt: item.publishedAt,
    });
    if (agentVersions.length >= PANEL_AGENT_COMPATIBILITY_LIMIT) break;
  }

  return {
    currentPanelVersion: APP_VERSION,
    currentAgentVersion: AGENT_VERSION,
    panelVersions,
    agentVersions,
    compatibility,
    checkedAt,
  };
}

async function getRollbackVersionInfoCached(force = false): Promise<RollbackVersionInfo> {
  if (!force && rollbackVersionInfo) {
    const checkedAt = new Date(rollbackVersionInfo.checkedAt).getTime();
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < UPDATE_CHECK_COOLDOWN_MS) {
      return rollbackVersionInfo;
    }
  }
  if (!force && rollbackVersionCheckInFlight) return rollbackVersionCheckInFlight;
  const request = fetchRollbackVersionInfo()
    .then((info) => {
      rollbackVersionInfo = info;
      return info;
    });
  if (force) return request;
  rollbackVersionCheckInFlight = request.finally(() => {
    rollbackVersionCheckInFlight = null;
  });
  return rollbackVersionCheckInFlight;
}

async function fetchGithubReleaseByVersion(version: string) {
  const normalized = normalizeVersion(version);
  const api = githubApiBase(REPO_URL);
  return fetchGithubJson<GithubReleaseInfo>(`${api}/releases/tags/${encodeURIComponent(`v${normalized}`)}`);
}

async function assertAgentReleaseAssetsReadyForRollback(releaseVersion: string, agentVersion: string) {
  const release = await fetchGithubReleaseByVersion(releaseVersion);
  const assets = new Map((release.assets || []).map((asset) => [asset.name || "", asset]));
  const missing = AGENT_ASSET_NAMES.filter((name) => {
    const asset = assets.get(name);
    return !asset || asset.state !== "uploaded" || Number(asset.size || 0) <= 0;
  });
  if (missing.length > 0) {
    throw new Error(`Agent v${normalizeVersion(agentVersion)} 所需的 Release v${normalizeVersion(releaseVersion)} 资产还未构建完成：${missing.join(", ")}`);
  }
}

function dockerImageReference() {
  return String(process.env.FORWARDX_IMAGE || DEFAULT_DOCKER_IMAGE).trim() || DEFAULT_DOCKER_IMAGE;
}

function dockerImageReferenceForVersion(version: string) {
  const configuredImage = String(process.env.FORWARDX_IMAGE || "").trim();
  if (configuredImage) return configuredImage;
  const image = parseDockerImageReference(DEFAULT_DOCKER_IMAGE);
  return `${image.registry}/${image.repository}:v${normalizeVersion(version)}`;
}

function parseDockerImageReference(image: string) {
  const value = image.replace(/^https?:\/\//i, "").split("@")[0];
  const slashIndex = value.indexOf("/");
  const registry = slashIndex > 0 ? value.slice(0, slashIndex) : "ghcr.io";
  const rest = slashIndex > 0 ? value.slice(slashIndex + 1) : value;
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  return {
    registry,
    repository: hasTag ? rest.slice(0, lastColon) : rest,
    tag: hasTag ? rest.slice(lastColon + 1) : "latest",
  };
}

function parseBearerChallenge(header: string | null) {
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  return params.realm ? params : null;
}

async function fetchRegistryJson<T>(url: string, accept: string, scope: string): Promise<T> {
  const headers: Record<string, string> = {
    "Accept": accept,
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "User-Agent": `ForwardX/${APP_VERSION}`,
  };
  let res = await fetch(url, { cache: "no-store", headers });
  if (res.status === 401) {
    const challenge = parseBearerChallenge(res.headers.get("www-authenticate"));
    if (challenge?.realm) {
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      tokenUrl.searchParams.set("scope", challenge.scope || scope);
      const tokenRes = await fetch(tokenUrl, {
        cache: "no-store",
        headers: { "User-Agent": `ForwardX/${APP_VERSION}` },
      });
      if (!tokenRes.ok) throw new Error(`Docker 镜像令牌请求失败：${tokenRes.status} ${tokenRes.statusText}`);
      const tokenData = await tokenRes.json() as { token?: string; access_token?: string };
      const token = tokenData.token || tokenData.access_token;
      if (!token) throw new Error("Docker 镜像令牌为空");
      res = await fetch(url, {
        cache: "no-store",
        headers: { ...headers, Authorization: `Bearer ${token}` },
      });
    }
  }
  if (!res.ok) throw new Error(`Docker 镜像信息请求失败：${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function fetchDockerImageVersion(imageRef = dockerImageReference()): Promise<string | null> {
  const image = parseDockerImageReference(imageRef);
  const scope = `repository:${image.repository}:pull`;
  const base = `https://${image.registry}/v2/${image.repository}`;
  const manifestAccept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  const manifest = await fetchRegistryJson<any>(`${base}/manifests/${encodeURIComponent(image.tag)}`, manifestAccept, scope);
  let imageManifest = manifest;
  if (Array.isArray(manifest.manifests)) {
    const selected =
      manifest.manifests.find((item: any) => item?.platform?.os === "linux" && item?.platform?.architecture === "amd64") ||
      manifest.manifests.find((item: any) => item?.platform?.os === "linux") ||
      manifest.manifests[0];
    const digest = selected?.digest;
    if (!digest) throw new Error("Docker manifest list 中未找到可用镜像 digest");
    imageManifest = await fetchRegistryJson<any>(`${base}/manifests/${digest}`, manifestAccept, scope);
  }
  const configDigest = imageManifest?.config?.digest;
  if (!configDigest) throw new Error("Docker 镜像配置 digest 为空");
  const config = await fetchRegistryJson<any>(
    `${base}/blobs/${configDigest}`,
    "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json, application/json",
    scope,
  );
  const labels = config?.config?.Labels || config?.container_config?.Labels || {};
  const envList: string[] = Array.isArray(config?.config?.Env) ? config.config.Env : [];
  const envVersion = envList.find((item) => item.startsWith("FORWARDX_IMAGE_VERSION="))?.split("=").slice(1).join("=");
  const labelVersion =
    labels["org.opencontainers.image.version"] ||
    labels["org.forwardx.version"] ||
    labels["io.forwardx.version"];
  const version = normalizeVersion(labelVersion || envVersion || "");
  return version || null;
}

async function ensureUpdateDeployable(info: UpdateInfo): Promise<UpdateInfo> {
  if (!info.latestVersion || !info.hasUpdate) {
    return { ...info, deployable: info.hasUpdate || undefined };
  }
  const expected = normalizeVersion(info.latestVersion);
  if (!isDockerRuntime()) {
    try {
      const asset = await fetchPanelBundleAssetStatus(expected);
      if (asset.ready) {
        return { ...info, deployable: true, artifactVersion: `v${expected}`, pendingReason: null };
      }
      if (asset.status === 404) {
        return {
          ...info,
          hasUpdate: false,
          deployable: false,
          artifactVersion: null,
          pendingReason: `已发现新版本 v${expected}，但面板安装包 forwardx-panel-v${expected}.tar.gz 尚未上传到 GitHub Release，正在等待 GitHub Actions 构建完成。请稍后重新检查更新。`,
        };
      }
      return {
        ...info,
        hasUpdate: false,
        deployable: false,
        artifactVersion: null,
        pendingReason: `已发现新版本 v${expected}，但暂时无法确认面板安装包是否可下载（HTTP ${asset.status}）。请稍后重试。`,
      };
    } catch (error: any) {
      return {
        ...info,
        hasUpdate: false,
        deployable: false,
        artifactVersion: null,
        pendingReason: `已发现新版本 v${expected}，但暂时无法确认面板安装包是否构建完成：${error?.message || "未知错误"}`,
      };
    }
  }

  try {
    const imageRef = dockerImageReferenceForVersion(expected);
    const imageVersion = await fetchDockerImageVersion(imageRef);
    const artifactVersion = imageVersion ? `v${normalizeVersion(imageVersion)}` : null;
    if (imageVersion && compareVersions(imageVersion, expected) >= 0) {
      return { ...info, deployable: true, artifactVersion, pendingReason: null };
    }
    return {
      ...info,
      deployable: false,
      artifactVersion,
      pendingReason: `已发现新版本 v${expected}，但 Docker 镜像 ${imageRef}${artifactVersion ? ` 当前仍是 ${artifactVersion}` : " 尚未构建完成"}。可先复制一键升级脚本，若镜像未就绪脚本会提示稍后重试。`,
    };
  } catch (error: any) {
    return {
      ...info,
      deployable: false,
      artifactVersion: null,
      pendingReason: `已发现新版本 v${expected}，但暂时无法确认 Docker 镜像 ${dockerImageReferenceForVersion(expected)} 是否构建完成：${error?.message || "未知错误"}。可先复制一键升级脚本，若镜像未就绪脚本会提示稍后重试。`,
    };
  }
}

async function getPanelAssetsPendingReason(targetVersion: string, operationLabel = "升级"): Promise<string | null> {
  const expected = normalizeVersion(targetVersion);
  if (isDockerRuntime()) {
    try {
      const imageRef = dockerImageReferenceForVersion(expected);
      const imageVersion = await fetchDockerImageVersion(imageRef);
      if (imageVersion && compareVersions(imageVersion, expected) >= 0) return null;
      const artifactVersion = imageVersion ? `v${normalizeVersion(imageVersion)}` : null;
      return `目标${operationLabel}版本 v${expected} 的 Docker 镜像 ${imageRef}${artifactVersion ? ` 当前仍是 ${artifactVersion}` : " 尚未构建完成"}，请稍后重试。`;
    } catch (error: any) {
      return `暂时无法确认目标${operationLabel}版本 v${expected} 的 Docker 镜像 ${dockerImageReferenceForVersion(expected)} 是否构建完成：${error?.message || "未知错误"}`;
    }
  }

  try {
    const asset = await fetchPanelBundleAssetStatus(expected);
    if (asset.ready) return null;
    if (asset.status === 404) {
      return `目标${operationLabel}版本 v${expected} 的面板安装包 forwardx-panel-v${expected}.tar.gz 尚未上传到 GitHub Release，请稍后重试。`;
    }
    return `暂时无法确认目标${operationLabel}版本 v${expected} 的面板安装包是否可下载（HTTP ${asset.status}）。请稍后重试。`;
  } catch (error: any) {
    return `暂时无法确认目标${operationLabel}版本 v${expected} 的面板安装包是否构建完成：${error?.message || "未知错误"}`;
  }
}

async function getUpgradeAssetsPendingReason(targetVersion: string): Promise<string | null> {
  return getPanelAssetsPendingReason(targetVersion, "升级");
}

function makeUpdateInfo(
  latestVersion: string | null | undefined,
  source: UpdateInfo["source"],
  checkedAt: string,
  releaseUrl?: string | null,
  publishedAt?: string | null,
): UpdateInfo {
  return {
    currentVersion: APP_VERSION,
    latestVersion: latestVersion || null,
    hasUpdate: !!latestVersion && compareVersions(latestVersion, APP_VERSION) > 0,
    releaseUrl: releaseUrl || (latestVersion ? `${REPO_URL}/releases/tag/${latestVersion}` : null),
    source,
    publishedAt: publishedAt || null,
    checkedAt,
  };
}

async function fetchLatestUpdateInfo(): Promise<UpdateInfo> {
  const checkedAt = new Date().toISOString();
  const api = githubApiBase(REPO_URL);
  const candidates: UpdateInfo[] = [];
  const errors: string[] = [];

  try {
    const latest = await fetchGithubJson<{
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
      draft?: boolean;
    }>(`${api}/releases/latest`);
    candidates.push(makeUpdateInfo(latest.tag_name || null, "release", checkedAt, latest.html_url || null, latest.published_at || null));
  } catch (releaseError: any) {
    errors.push(releaseError?.message || "GitHub Release 检查失败");
  }

  try {
    const tags = await fetchGithubJson<Array<{ name?: string; commit?: { sha?: string } }>>(`${api}/tags?per_page=50`);
    const versionTags = tags
      .map((t) => t.name)
      .filter((name): name is string => !!name && /^v?\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => compareVersions(b, a));
    const tagVersion = versionTags[0] || null;
    if (tagVersion) candidates.push(makeUpdateInfo(tagVersion, "tag", checkedAt));
  } catch (tagError: any) {
    errors.push(tagError?.message || "GitHub Tag 检查失败");
  }

  try {
    const text = await fetchTextNoCache(githubRawMainUrl(REPO_URL, "shared/versions.ts"));
    const match = text.match(/APP_VERSION\s*=\s*["']v?([^"']+)["']/);
    const mainVersion = match?.[1] ? `v${normalizeVersion(match[1])}` : null;
    if (mainVersion) candidates.push(makeUpdateInfo(mainVersion, "main", checkedAt));
  } catch (mainError: any) {
    errors.push(mainError?.message || "main 分支版本检查失败");
  }

  const latest = candidates
    .filter((item) => !!item.latestVersion)
    .sort((a, b) => compareVersions(b.latestVersion || "0", a.latestVersion || "0"))[0];
  if (latest) return ensureUpdateDeployable(latest);

  return {
    currentVersion: APP_VERSION,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: null,
    source: null,
    publishedAt: null,
    checkedAt,
    error: errors[0] || "检查更新失败",
  };
}

async function getLatestUpdateInfoCached(force = false): Promise<UpdateInfo> {
  if (!force && lastUpdateInfo) {
    const checkedAt = new Date(lastUpdateInfo.checkedAt).getTime();
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < UPDATE_CHECK_COOLDOWN_MS) {
      return lastUpdateInfo;
    }
  }
  if (!force && updateCheckInFlight) {
    return updateCheckInFlight;
  }
  const request = fetchLatestUpdateInfo()
    .then((info) => {
      lastUpdateInfo = info;
      return info;
    });
  if (force) return request;
  updateCheckInFlight = request
    .finally(() => {
      updateCheckInFlight = null;
    });
  return updateCheckInFlight;
}

export async function checkPanelUpdateTask(force = false): Promise<UpdateInfo> {
  return getLatestUpdateInfoCached(!!force);
}

function appendUpgradeLog(line: string) {
  const text = line.trimEnd();
  if (!text) return;
  upgradeJob.logs.push(text);
  if (upgradeJob.logs.length > 300) {
    upgradeJob.logs = upgradeJob.logs.slice(-300);
  }
}

function normalizeUpgradeCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const missingLocalPanelUpgrade = trimmed.match(/^(?:\/bin\/bash|\/usr\/bin\/bash|bash)\s+(\S*install-panel-local\.sh)\s+upgrade\s*$/i);
  if (missingLocalPanelUpgrade) {
    const scriptPath = missingLocalPanelUpgrade[1].replace(/^['"]|['"]$/g, "");
    if (!fs.existsSync(scriptPath)) {
      return MANUAL_LOCAL_UPGRADE_COMMAND;
    }
  }
  if (/^(?:bash|sh|\/bin\/bash|\/usr\/bin\/bash|\/bin\/sh|\/usr\/bin\/sh)\s+/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:"[^"]+\.sh"|'[^']+\.sh'|\S+\.sh)(?:\s+.*)?$/i.test(trimmed)) {
    return `/bin/bash ${trimmed}`;
  }
  return trimmed;
}

function appendManualUpgradeHint() {
  appendUpgradeLog("[ForwardX] Automatic upgrade failed. Run a one-click script on the server to upgrade manually:");
  appendUpgradeLog(`[ForwardX] Local: ${MANUAL_LOCAL_UPGRADE_COMMAND}`);
  appendUpgradeLog(`[ForwardX] Docker: ${MANUAL_DOCKER_UPGRADE_COMMAND}`);
}

function setUpgradeWaitingForAssets(targetVersion: string, reason: string, mode: "upgrade" | "rollback" = "upgrade") {
  upgradeJob = {
    status: "waiting_assets",
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    targetVersion,
    logs: [
      `[ForwardX] Current version v${APP_VERSION}`,
      `[ForwardX] Selected target ${targetVersion}`,
      "[ForwardX] Release assets are still building on GitHub Actions.",
      `[ForwardX] ${reason}`,
    ],
    error: reason,
  };
}

export function getPanelUpgradeRuntimeStatus() {
  return {
    currentVersion: APP_VERSION,
    repoUrl: REPO_URL,
    update: lastUpdateInfo,
    job: upgradeJob,
    upgradeEnabled: !!ENV.upgradeCommand.trim(),
    ...getDeploymentInfo(),
  };
}

async function startPanelVersionTask(targetVersionInput: string | null | undefined, mode: "upgrade" | "rollback") {
  const command = normalizeUpgradeCommand(ENV.upgradeCommand);
  if (!command) {
    console.warn(`[Upgrade] ${mode} requested but FORWARDX_UPGRADE_COMMAND is not configured`);
    throw new Error(`未配置 FORWARDX_UPGRADE_COMMAND，当前环境只能检查版本，不能自动${mode === "rollback" ? "回退" : "升级"}`);
  }
  if (upgradeJob.status === "running") {
    console.warn(`[Upgrade] ${mode} requested while another version task is running`);
    throw new Error("已有版本任务正在执行");
  }

  const requestedVersion = String(targetVersionInput || "").trim();
  let targetVersion = requestedVersion;
  if (mode === "upgrade") {
    let update = await fetchLatestUpdateInfo();
    if (update.error && lastUpdateInfo) {
      update = lastUpdateInfo;
    }
    lastUpdateInfo = update;
    targetVersion =
      update.latestVersion && (!requestedVersion || compareVersions(update.latestVersion, requestedVersion) >= 0)
        ? update.latestVersion
        : requestedVersion;
    if (!targetVersion) throw new Error("No upgrade target version found");
    if (compareVersions(targetVersion, APP_VERSION) <= 0) {
      throw new Error("Already on the latest version");
    }
    if (update.latestVersion && compareVersions(update.latestVersion, APP_VERSION) > 0 && !update.hasUpdate) {
      const reason = update.pendingReason || "新版本发布资产尚未构建完成，请稍后重试。";
      setUpgradeWaitingForAssets(targetVersion, reason, mode);
      return { success: false, targetVersion, pendingReason: reason };
    }
  } else {
    targetVersion = normalizeVersion(targetVersion);
    if (!targetVersion) throw new Error("请选择要回退的版本");
    if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error("回退版本格式不正确");
    if (compareVersions(targetVersion, APP_VERSION) >= 0) {
      throw new Error("只能回退到低于当前面板的版本");
    }
    const rollbackInfo = await getRollbackVersionInfoCached();
    if (!rollbackInfo.panelVersions.some((item) => normalizeVersion(item.panelVersion) === targetVersion)) {
      throw new Error("目标版本不在最近 5 个可回退版本内，请重新获取版本列表");
    }
  }
  if (!targetVersion) throw new Error("No upgrade target version found");
  const pendingReason = await getPanelAssetsPendingReason(targetVersion, mode === "rollback" ? "回退" : "升级");
  if (pendingReason) {
    setUpgradeWaitingForAssets(targetVersion, pendingReason, mode);
    return { success: false, targetVersion, pendingReason };
  }
  const operationText = mode === "rollback" ? "回退" : "升级";
  console.info(`[Upgrade] Starting panel ${mode} current=v${APP_VERSION} target=${targetVersion}`);

  upgradeJob = {
    status: "running",
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    targetVersion,
    logs: [
      `[ForwardX] Current version v${APP_VERSION}`,
      `[ForwardX] Selected ${mode} target ${targetVersion}`,
      `[ForwardX] Starting panel ${operationText} to ${targetVersion}`,
    ],
    error: null,
  };
  const child = spawn(command, {
    shell: true,
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORWARDX_TARGET_VERSION: targetVersion,
      FORWARDX_CURRENT_VERSION: APP_VERSION,
      FORWARDX_REPO_URL: REPO_URL,
    },
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk) => appendUpgradeLog(String(chunk)));
  child.stderr?.on("data", (chunk) => appendUpgradeLog(String(chunk)));
  child.on("error", (err) => {
    upgradeJob.status = "error";
    upgradeJob.error = `${err.message}. Please run the one-click script manually.`;
    upgradeJob.finishedAt = new Date().toISOString();
    console.error(`[Upgrade] Failed to start upgrade command: ${err.message}`);
    appendUpgradeLog(`[ForwardX] Upgrade command failed to start: ${err.message}`);
    appendManualUpgradeHint();
  });
  child.on("close", (code) => {
    upgradeJob.finishedAt = new Date().toISOString();
    if (code === 0) {
      upgradeJob.status = "success";
      console.info(`[Upgrade] Panel ${mode} command completed target=${targetVersion}`);
      appendUpgradeLog(`[ForwardX] Panel ${operationText} command completed. The service may be restarting, refresh the page later.`);
    } else if (code === UPGRADE_ASSETS_PENDING_EXIT_CODE) {
      const reason = `v${normalizeVersion(targetVersion)} 的发布资产仍在 GitHub Actions 构建或上传中，请稍后重新检查更新。`;
      upgradeJob.status = "waiting_assets";
      upgradeJob.error = reason;
      console.warn(`[Upgrade] Panel upgrade assets pending target=${targetVersion} exitCode=${code}`);
      appendUpgradeLog(`[ForwardX] ${reason}`);
    } else {
      upgradeJob.status = "error";
      upgradeJob.error = `Upgrade command exited with code ${code}. Please run the one-click script manually.`;
      console.error(`[Upgrade] Panel upgrade failed target=${targetVersion} exitCode=${code}`);
      appendUpgradeLog(`[ForwardX] Upgrade failed, exit code: ${code}`);
      appendManualUpgradeHint();
    }
  });

  return { success: true, targetVersion };
}

export async function startPanelUpgradeTask(targetVersionInput?: string | null) {
  return startPanelVersionTask(targetVersionInput, "upgrade");
}

export async function startPanelRollbackTask(targetVersionInput: string) {
  return startPanelVersionTask(targetVersionInput, "rollback");
}

function getDeploymentInfo(): DeploymentInfo {
  const docker = isDockerRuntime();
  return {
    docker,
    dockerSocket: fs.existsSync("/var/run/docker.sock"),
    manualUpgradeCommand: docker ? MANUAL_DOCKER_UPGRADE_COMMAND : MANUAL_LOCAL_UPGRADE_COMMAND,
  };
}

function parseForwardProtocolSettings(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseSidebarMenuSettings(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePort(value: unknown) {
  const port = Math.floor(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1-65535 的数字");
  }
  return port;
}

function portManagementMode() {
  return ENV.portManagement.trim().toLowerCase();
}

function isDockerRuntime() {
  if (portManagementMode() === "docker") return true;
  if (fs.existsSync("/.dockerenv")) return true;
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods|libpod/i.test(cgroup);
  } catch {
    return false;
  }
}

function webPortConfigPath() {
  return ENV.portConfigPath.trim() || path.resolve(process.cwd(), ".env");
}

function canManageWebPort() {
  const mode = portManagementMode();
  if (mode === "docker") return false;
  if (isDockerRuntime()) return false;
  if (mode === "local") return process.platform !== "win32";
  return process.platform !== "win32";
}

function getPublicWebPort() {
  if (isDockerRuntime() && ENV.publicPort > 0) return ENV.publicPort;
  if (isDockerRuntime() && ENV.port === 3000) return 9810;
  return ENV.port;
}

function getWebPortManagement(options?: { publicView?: boolean }) {
  const docker = isDockerRuntime();
  const publicPort = getPublicWebPort();
  return {
    enabled: options?.publicView ? false : canManageWebPort(),
    docker,
    publicPort,
    containerPort: docker ? ENV.port : publicPort,
  };
}

function isTcpPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

async function updateEnvFileValue(filePath: string, key: string, value: string) {
  const text = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  const lines = text ? text.split(/\r?\n/) : [];
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) nextLines.push(`${key}=${value}`);
  await fs.promises.writeFile(filePath, `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join("\n")}\n`, "utf8");
}

function schedulePanelRestart(reason = "settings change") {
  setTimeout(() => {
    console.info(`[Settings] exiting process for service restart after ${reason}`);
    process.exit(0);
  }, 800);
}

function normalizeOptionalHttpUrl(value: string) {
  const trimmed = value.trim();
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("URL 必须以 http:// 或 https:// 开头");
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeDeepSeekNumber(value: string | null | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeAiProvider(value: unknown): AiProvider {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "siliconflow") return "siliconflow";
  if (raw === "custom") return "custom";
  return DEFAULT_AI_PROVIDER;
}

function normalizeAiApiKey(value: unknown) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  raw = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  raw = raw.replace(/^bearer\s+/i, "").trim();
  raw = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  return raw;
}

function getAiProviderDefaultBaseUrl(provider: AiProvider) {
  if (provider === "siliconflow") return DEFAULT_SILICONFLOW_BASE_URL;
  if (provider === "custom") return DEFAULT_DEEPSEEK_BASE_URL;
  return DEFAULT_DEEPSEEK_BASE_URL;
}

function getAiProviderDefaultModel(provider: AiProvider) {
  if (provider === "siliconflow") return DEFAULT_SILICONFLOW_MODEL;
  if (provider === "custom") return DEFAULT_DEEPSEEK_MODEL;
  return DEFAULT_DEEPSEEK_MODEL;
}

type AiProviderConfigView = {
  provider: AiProvider;
  configured: boolean;
  apiKeyMasked: string;
  baseUrl: string;
  model: string;
};

type AiProviderConfigRuntime = AiProviderConfigView & {
  apiKey: string;
};

const AI_PROVIDER_SETTING_KEYS: Record<AiProvider, { apiKey: string; baseUrl: string; model: string }> = {
  deepseek: {
    apiKey: "deepseekApiKeyDeepseek",
    baseUrl: "deepseekBaseUrlDeepseek",
    model: "deepseekModelDeepseek",
  },
  siliconflow: {
    apiKey: "deepseekApiKeySiliconflow",
    baseUrl: "deepseekBaseUrlSiliconflow",
    model: "deepseekModelSiliconflow",
  },
  custom: {
    apiKey: "deepseekApiKeyCustom",
    baseUrl: "deepseekBaseUrlCustom",
    model: "deepseekModelCustom",
  },
};

function getAiProviderSettingKeys(provider: AiProvider) {
  return AI_PROVIDER_SETTING_KEYS[provider];
}

function readAiProviderConfig(all: Record<string, string | null>, provider: AiProvider): AiProviderConfigRuntime {
  const providerKeys = getAiProviderSettingKeys(provider);
  const defaultBaseUrl = getAiProviderDefaultBaseUrl(provider);
  const defaultModel = getAiProviderDefaultModel(provider);
  const legacyApiKey = provider === DEFAULT_AI_PROVIDER ? normalizeAiApiKey(all.deepseekApiKey) : "";
  const legacyBaseUrl = provider === DEFAULT_AI_PROVIDER ? String(all.deepseekBaseUrl || "").trim() : "";
  const legacyModel = provider === DEFAULT_AI_PROVIDER ? String(all.deepseekModel || "").trim() : "";
  const apiKey = normalizeAiApiKey(all[providerKeys.apiKey]) || legacyApiKey;
  const baseUrl = String(all[providerKeys.baseUrl] || legacyBaseUrl || defaultBaseUrl).trim().replace(/\/+$/, "") || defaultBaseUrl;
  const model = String(all[providerKeys.model] || legacyModel || defaultModel).trim() || defaultModel;
  return {
    provider,
    apiKey,
    configured: !!apiKey,
    apiKeyMasked: maskSecret(apiKey),
    baseUrl,
    model,
  };
}

function buildAiProviderConfigMap(all: Record<string, string | null>): Record<AiProvider, AiProviderConfigRuntime> {
  return {
    deepseek: readAiProviderConfig(all, "deepseek"),
    siliconflow: readAiProviderConfig(all, "siliconflow"),
    custom: readAiProviderConfig(all, "custom"),
  };
}

function toAiProviderConfigView(config: AiProviderConfigRuntime): AiProviderConfigView {
  return {
    provider: config.provider,
    configured: config.configured,
    apiKeyMasked: config.apiKeyMasked,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

function buildAiModelsEndpoint(provider: AiProvider, baseUrl: string, chatOnly: boolean) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  const modelPath = /\/models$/i.test(normalized) ? normalized : `${normalized}/models`;
  if (provider === "siliconflow") {
    if (!chatOnly) return modelPath;
    return `${modelPath}${modelPath.includes("?") ? "&" : "?"}sub_type=chat`;
  }
  if (!chatOnly) return modelPath;
  return `${modelPath}${modelPath.includes("?") ? "&" : "?"}type=chat`;
}

function pickPathValue(input: unknown, pathKey: string): unknown {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : null;
  if (!source) return undefined;
  const pathSegments = pathKey.split(".").filter(Boolean);
  let current: unknown = source;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "y", "on", "free"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off", "paid"].includes(raw)) return false;
  return undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/[, ]/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function detectAiModelFree(raw: unknown): { isFree: boolean | null; reason: string } {
  const freeFlagPaths = [
    "isFree",
    "is_free",
    "free",
    "freeModel",
    "free_model",
    "isFreeTier",
    "is_free_tier",
    "billing.isFree",
    "billing.is_free",
    "pricing.isFree",
    "pricing.is_free",
  ];
  for (const pathKey of freeFlagPaths) {
    const parsed = normalizeOptionalBoolean(pickPathValue(raw, pathKey));
    if (parsed !== undefined) return { isFree: parsed, reason: pathKey };
  }

  const inputPricePaths = [
    "pricing.input",
    "pricing.prompt",
    "pricing.inputPrice",
    "pricing.input_price",
    "pricing.inputTokenPrice",
    "pricing.input_token_price",
    "price.input",
    "price.prompt",
    "price.inputPrice",
    "price.input_price",
    "inputPrice",
    "input_price",
    "promptPrice",
    "prompt_price",
  ];
  const outputPricePaths = [
    "pricing.output",
    "pricing.completion",
    "pricing.outputPrice",
    "pricing.output_price",
    "pricing.outputTokenPrice",
    "pricing.output_token_price",
    "price.output",
    "price.completion",
    "price.outputPrice",
    "price.output_price",
    "outputPrice",
    "output_price",
    "completionPrice",
    "completion_price",
  ];
  let inputPrice: number | undefined;
  let outputPrice: number | undefined;
  for (const pathKey of inputPricePaths) {
    const parsed = normalizeOptionalNumber(pickPathValue(raw, pathKey));
    if (parsed !== undefined) {
      inputPrice = parsed;
      break;
    }
  }
  for (const pathKey of outputPricePaths) {
    const parsed = normalizeOptionalNumber(pickPathValue(raw, pathKey));
    if (parsed !== undefined) {
      outputPrice = parsed;
      break;
    }
  }
  if (inputPrice !== undefined && outputPrice !== undefined) {
    return { isFree: inputPrice <= 0 && outputPrice <= 0, reason: "pricing" };
  }
  if ((inputPrice ?? 0) > 0 || (outputPrice ?? 0) > 0) {
    return { isFree: false, reason: "pricing" };
  }
  return { isFree: null, reason: "unknown" };
}

type NormalizedAiModelItem = {
  id: string;
  ownedBy: string;
  type: string;
  subType: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  isFree: boolean | null;
  freeReason: string;
};

function normalizeAiModelItem(raw: unknown): NormalizedAiModelItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || item.model || item.name || "").trim();
  if (!id) return null;
  const ownedBy = String(item.owned_by || item.ownedBy || item.owner || "").trim();
  const type = String(item.type || "").trim();
  const subType = String(item.sub_type || item.subType || "").trim();
  const contextLength = normalizeOptionalNumber(item.context_length ?? item.contextLength ?? item.max_context_length ?? item.maxContextLength);
  const maxOutputTokens = normalizeOptionalNumber(item.max_output_tokens ?? item.maxOutputTokens ?? item.max_tokens ?? item.maxTokens);
  const { isFree, reason } = detectAiModelFree(item);
  return {
    id,
    ownedBy,
    type,
    subType,
    contextLength: contextLength === undefined ? null : Math.floor(contextLength),
    maxOutputTokens: maxOutputTokens === undefined ? null : Math.floor(maxOutputTokens),
    isFree,
    freeReason: reason,
  };
}

function aiModelFreeSortRank(value: boolean | null) {
  if (value === true) return 0;
  if (value === null) return 1;
  return 2;
}

function databaseSettingsSummary(all: Record<string, string | null>, exposeDetails = true) {
  const type = all.databaseType || (all.postgresqlConfigured === "true" ? "postgresql" : all.mysqlConfigured === "true" ? "mysql" : "sqlite");
  const configured = all.databaseConfigured === "true" || all.mysqlConfigured === "true" || all.postgresqlConfigured === "true";
  if (!exposeDetails) {
    return {
      type: "sqlite",
      configured: false,
      mysqlHost: "",
      mysqlDatabase: "",
      postgresqlHost: "",
      postgresqlDatabase: "",
      sqlitePath: "",
    };
  }
  return {
    type,
    configured,
    mysqlHost: all.mysqlHost ?? "",
    mysqlDatabase: all.mysqlDatabase ?? "",
    postgresqlHost: all.postgresqlHost ?? "",
    postgresqlDatabase: all.postgresqlDatabase ?? "",
    sqlitePath: all.sqlitePath ?? "",
  };
}

function publicSystemSettings(all: Record<string, string | null>, activeProtocol: string) {
  const aiProvider = normalizeAiProvider(all.deepseekProvider);
  const aiProviderConfigs = buildAiProviderConfigMap(all);
  const aiActiveConfig = aiProviderConfigs[aiProvider];
  return {
    repoUrl: REPO_URL,
    telegramBotUrl: TELEGRAM_BOT_URL,
    version: APP_VERSION,
    androidAppVersion: ANDROID_APP_VERSION,
    androidApkDownloadUrl: ANDROID_APK_DOWNLOAD_URL,
    agentVersion: AGENT_VERSION,
    siteTitle: all.siteTitle || "ForwardX",
    siteLogoDataUrl: all.siteLogoDataUrl || "",
    personalizationTheme: normalizePersonalizationThemePresetId(all.personalizationTheme),
    personalizationBackground: publicPersonalizationBackground(all),
    panelPublicUrl: all.panelPublicUrl ?? "",
    panelSsl: {
      enabled: false,
      mode: "path" as const,
      certPath: "",
      keyPath: "",
      certPem: "",
      keyPem: "",
      activeProtocol,
    },
    webPort: getPublicWebPort(),
    webPortManagement: getWebPortManagement({ publicView: true }),
    registrationEnabled: all.registrationEnabled !== "false",
    twoFactorEnabled: all.twoFactorEnabled === "true",
    lookingGlassUserEnabled: all.lookingGlassUserEnabled !== "false",
    allowMultiDeviceLogin: all.allowMultiDeviceLogin === "true",
    pluginsEnabled: all.pluginsEnabled === "true",
    publicHostMonitor: {
      enabled: all.publicHostMonitorEnabled === "true",
      path: normalizePublicHostMonitorPath(all.publicHostMonitorPath),
      title: normalizePublicHostMonitorTitle(all.publicHostMonitorTitle),
    },
    homepageEnabled: all.homepageEnabled !== "false",
    homepageCustomEnabled: all.homepageCustomEnabled === "true",
    homepageHtml: all.homepageHtml ?? "",
    forwardProtocols: normalizeForwardProtocolSettings(
      parseForwardProtocolSettings(all.forwardProtocols),
    ),
    sidebarMenu: readSidebarMenuSettings(all),
    tunnelRuntimeDefault: all.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx",
    githubAccelerator: {
      enabled: all.githubAcceleratorEnabled === "true",
      url: all.githubAcceleratorUrl ?? "",
    },
    agentPreferPanelInstall: all.agentPreferPanelInstall === "true",
    database: databaseSettingsSummary(all, false),
    mysql: {
      configured: false,
      host: "",
      database: "",
    },
    postgresql: {
      configured: false,
      host: "",
      database: "",
    },
    email: {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      user: "",
      from: "",
      verifyRegistration: false,
      whitelistEnabled: false,
      whitelist: "",
      expiryReminder: false,
      trafficReminder: false,
      trafficReminderThreshold: 20,
    },
    ddns: {
      enabled: false,
      provider: "disabled",
      ttl: 600,
      cloudflareZoneId: "",
      cloudflareTokenMasked: "",
      huaweicloudAccessKeyId: "",
      huaweicloudSecretKeyMasked: "",
      huaweicloudRegion: "cn-north-4",
      huaweicloudEndpoint: "",
      huaweicloudZoneId: "",
      huaweicloudTtl: 600,
      huaweicloudLine: "default_view",
      aliyunAccessKeyId: "",
      aliyunAccessKeySecretMasked: "",
      aliyunDomainName: "",
      aliyunEndpoint: "https://alidns.aliyuncs.com",
      aliyunTtl: 600,
      aliyunLine: "default",
      tencentcloudSecretId: "",
      tencentcloudSecretKeyMasked: "",
      tencentcloudDomainName: "",
      tencentcloudTtl: 600,
      tencentcloudRecordLine: "默认",
      tencentcloudRecordLineId: "",
      webhookUrl: "",
      webhookMethod: "POST",
      webhookHeaders: "",
    },
    agentEncryption: "aes-256-ctr+hmac-sha256",
    upgrade: {
      enabled: false,
      docker: false,
      dockerSocket: false,
      commandConfigured: false,
      manualUpgradeCommand: "",
    },
    telegram: {
      enabled: false,
      configured: false,
      botUsername: "",
      tokenMasked: "",
      tokenSource: "none" as const,
      polling: false,
      expiryReminder: false,
      trafficReminder: false,
      trafficReminderThreshold: 20,
      hostStatusNotify: false,
    },
    deepseek: {
      provider: aiProvider,
      enabled: false,
      configured: false,
      apiKeyMasked: "",
      baseUrl: aiActiveConfig.baseUrl,
      model: aiActiveConfig.model,
      maxTokens: DEFAULT_DEEPSEEK_MAX_TOKENS,
      temperature: DEFAULT_DEEPSEEK_TEMPERATURE,
      telegramUserManageEnabled: true,
      telegramAutoRecallEnabled: false,
      telegramAutoRecallSeconds: 60,
    },
  };
}

export const systemRouter = router({
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  publicInfo: publicProcedure.query(() => {
    return db.getAllSettings().then((all) => ({
      repoUrl: REPO_URL,
      telegramBotUrl: TELEGRAM_BOT_URL,
      version: APP_VERSION,
      androidAppVersion: ANDROID_APP_VERSION,
      androidApkDownloadUrl: ANDROID_APK_DOWNLOAD_URL,
      agentVersion: AGENT_VERSION,
      siteTitle: all.siteTitle || "ForwardX",
      siteLogoDataUrl: all.siteLogoDataUrl || "",
      personalizationTheme: normalizePersonalizationThemePresetId(all.personalizationTheme),
      personalizationBackground: publicPersonalizationBackground(all),
      registrationEnabled: all.registrationEnabled !== "false",
      twoFactorEnabled: all.twoFactorEnabled === "true",
      lookingGlassUserEnabled: all.lookingGlassUserEnabled !== "false",
      allowMultiDeviceLogin: all.allowMultiDeviceLogin === "true",
      pluginsEnabled: all.pluginsEnabled === "true",
      publicHostMonitor: {
        enabled: all.publicHostMonitorEnabled === "true",
        path: normalizePublicHostMonitorPath(all.publicHostMonitorPath),
        title: normalizePublicHostMonitorTitle(all.publicHostMonitorTitle),
      },
      sidebarMenu: readSidebarMenuSettings(all),
    }));
  }),

  /** 获取系统设置（包含开源地址、版本、面板公开 URL 等元信息） */
  getSettings: publicProcedure.query(async ({ ctx }) => {
    const all = await db.getAllSettings();
    const aiProvider = normalizeAiProvider(all.deepseekProvider);
    const aiProviderConfigs = buildAiProviderConfigMap(all);
    const aiActiveConfig = aiProviderConfigs[aiProvider];
    const panelSsl = readPanelSslSettings(all);
    const activeProtocol = ctx.req.secure || ctx.req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const safeSettings = publicSystemSettings(all, activeProtocol);
    if (!ctx.user || ctx.user.role !== "admin") return safeSettings;
    return {
      ...safeSettings,
      panelSsl: {
        enabled: panelSsl.enabled,
        mode: panelSsl.mode,
        certPath: panelSsl.certPath,
        keyPath: panelSsl.keyPath,
        certPem: panelSsl.certPem,
        keyPem: panelSsl.keyPem,
        activeProtocol,
      },
      webPort: getPublicWebPort(),
      webPortManagement: getWebPortManagement(),
      registrationEnabled: all.registrationEnabled !== "false",
      twoFactorEnabled: all.twoFactorEnabled === "true",
      lookingGlassUserEnabled: all.lookingGlassUserEnabled !== "false",
      pluginsEnabled: all.pluginsEnabled === "true",
      personalizationBackgroundConfig: readPersonalizationBackground(all),
      homepageEnabled: all.homepageEnabled !== "false",
      homepageCustomEnabled: all.homepageCustomEnabled === "true",
      homepageHtml: all.homepageHtml ?? "",
      forwardProtocols: normalizeForwardProtocolSettings(
        parseForwardProtocolSettings(all.forwardProtocols),
      ),
      sidebarMenu: readSidebarMenuSettings(all),
      tunnelRuntimeDefault: all.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx",
      githubAccelerator: {
        enabled: all.githubAcceleratorEnabled === "true",
        url: all.githubAcceleratorUrl ?? "",
      },
      agentPreferPanelInstall: all.agentPreferPanelInstall === "true",
      database: databaseSettingsSummary(all),
      mysql: {
        configured: all.mysqlConfigured === "true",
        host: all.mysqlHost ?? "",
        database: all.mysqlDatabase ?? "",
      },
      postgresql: {
        configured: all.postgresqlConfigured === "true",
        host: all.postgresqlHost ?? "",
        database: all.postgresqlDatabase ?? "",
      },
      email: {
        enabled: all.emailEnabled === "true",
        host: all.emailHost ?? "",
        port: Number(all.emailPort || 587),
        secure: all.emailSecure === "true",
        user: all.emailUser ?? "",
        from: all.emailFrom ?? "",
        verifyRegistration: all.emailVerifyRegistration === "true",
        whitelistEnabled: all.emailWhitelistEnabled === "true",
        whitelist: all.emailWhitelist ?? "",
        expiryReminder: all.emailExpiryReminder === "true",
        trafficReminder: all.emailTrafficReminder === "true",
        trafficReminderThreshold: Number(all.emailTrafficReminderThreshold || 20),
      },
      ddns: {
        enabled: all.ddnsEnabled === "true",
        provider: all.ddnsProvider || "disabled",
        ttl: Number(all.ddnsTtl || all.ddnsHuaweiCloudTtl || all.ddnsAliyunTtl || all.ddnsTencentCloudTtl || 600),
        cloudflareZoneId: all.ddnsCloudflareZoneId ?? "",
        cloudflareTokenMasked: maskSecret(all.ddnsCloudflareApiToken),
        huaweicloudAccessKeyId: all.ddnsHuaweiCloudAccessKeyId ?? "",
        huaweicloudSecretKeyMasked: maskSecret(all.ddnsHuaweiCloudSecretKey),
        huaweicloudRegion: all.ddnsHuaweiCloudRegion ?? "cn-north-4",
        huaweicloudEndpoint: all.ddnsHuaweiCloudEndpoint ?? "",
        huaweicloudZoneId: all.ddnsHuaweiCloudZoneId ?? "",
        huaweicloudTtl: Number(all.ddnsHuaweiCloudTtl || all.ddnsTtl || 600),
        huaweicloudLine: all.ddnsHuaweiCloudLine ?? "default_view",
        aliyunAccessKeyId: all.ddnsAliyunAccessKeyId ?? "",
        aliyunAccessKeySecretMasked: maskSecret(all.ddnsAliyunAccessKeySecret),
        aliyunDomainName: all.ddnsAliyunDomainName ?? "",
        aliyunEndpoint: all.ddnsAliyunEndpoint ?? "https://alidns.aliyuncs.com",
        aliyunTtl: Number(all.ddnsAliyunTtl || all.ddnsTtl || 600),
        aliyunLine: all.ddnsAliyunLine ?? "default",
        tencentcloudSecretId: all.ddnsTencentCloudSecretId ?? "",
        tencentcloudSecretKeyMasked: maskSecret(all.ddnsTencentCloudSecretKey),
        tencentcloudDomainName: all.ddnsTencentCloudDomainName ?? "",
        tencentcloudTtl: Number(all.ddnsTencentCloudTtl || all.ddnsTtl || 600),
        tencentcloudRecordLine: all.ddnsTencentCloudRecordLine ?? "默认",
        tencentcloudRecordLineId: all.ddnsTencentCloudRecordLineId ?? "",
        webhookUrl: all.ddnsWebhookUrl ?? "",
        webhookMethod: all.ddnsWebhookMethod ?? "POST",
        webhookHeaders: all.ddnsWebhookHeaders ?? "",
      },
      agentEncryption: "aes-256-ctr+hmac-sha256", // 加密方案标识
      upgrade: {
        enabled: !!ENV.upgradeCommand.trim(),
        docker: getDeploymentInfo().docker,
        dockerSocket: getDeploymentInfo().dockerSocket,
        commandConfigured: !!ENV.upgradeCommand.trim(),
        manualUpgradeCommand: getDeploymentInfo().manualUpgradeCommand,
      },
      telegram: {
        enabled: all.telegramBotEnabled === "true" || (!!ENV.telegramBotToken.trim() && all.telegramBotEnabled !== "false"),
        configured: !!(ENV.telegramBotToken.trim() || String(all.telegramBotToken || "").trim()),
        botUsername: all.telegramBotUsername ?? "",
        tokenMasked: (() => {
          const token = ENV.telegramBotToken.trim() || String(all.telegramBotToken || "").trim();
          if (!token) return "";
          if (token.length <= 12) return `${token.slice(0, 4)}${"*".repeat(Math.max(4, token.length - 4))}`;
          return `${token.slice(0, 8)}${"*".repeat(Math.max(8, token.length - 12))}${token.slice(-4)}`;
        })(),
        tokenSource: ENV.telegramBotToken.trim() ? "env" : (all.telegramBotToken ? "database" : "none"),
        polling: ENV.telegramBotPolling,
        expiryReminder: all.telegramExpiryReminder === "true",
        trafficReminder: all.telegramTrafficReminder === "true",
        trafficReminderThreshold: Number(all.telegramTrafficReminderThreshold || 20),
        hostStatusNotify: all.telegramHostStatusNotify === "true",
      },
      deepseek: {
        provider: aiProvider,
        enabled: all.deepseekAiEnabled === "true",
        configured: aiActiveConfig.configured,
        apiKeyMasked: aiActiveConfig.apiKeyMasked,
        baseUrl: aiActiveConfig.baseUrl,
        model: aiActiveConfig.model,
        providers: {
          deepseek: toAiProviderConfigView(aiProviderConfigs.deepseek),
          siliconflow: toAiProviderConfigView(aiProviderConfigs.siliconflow),
          custom: toAiProviderConfigView(aiProviderConfigs.custom),
        },
        maxTokens: normalizeDeepSeekNumber(all.deepseekMaxTokens, DEFAULT_DEEPSEEK_MAX_TOKENS, 128, 8192),
        temperature: normalizeDeepSeekNumber(all.deepseekTemperature, DEFAULT_DEEPSEEK_TEMPERATURE, 0, 2),
        telegramUserManageEnabled: all.telegramAiUserManageEnabled !== "false",
        telegramAutoRecallEnabled: all.telegramAiAutoRecallEnabled === "true",
        telegramAutoRecallSeconds: normalizeDeepSeekNumber(all.telegramAiAutoRecallSeconds, 60, 30, 1200),
      },
    };
  }),

  listAiModels: adminProcedure
    .input(z.object({
      provider: aiProviderSchema.optional(),
      baseUrl: z.string().max(256).optional(),
      chatOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const all = await db.getAllSettings();
      const provider = normalizeAiProvider(input?.provider || all.deepseekProvider);
      const providerConfig = readAiProviderConfig(all, provider);
      const defaultBaseUrl = getAiProviderDefaultBaseUrl(provider);
      const baseUrl = (normalizeOptionalHttpUrl(input?.baseUrl || providerConfig.baseUrl || defaultBaseUrl) || defaultBaseUrl).replace(/\/+$/, "");
      const apiKey = providerConfig.apiKey;
      const checkedAt = new Date().toISOString();
      const chatOnly = input?.chatOnly !== false;

      if (!apiKey) {
        return {
          provider,
          baseUrl,
          endpoint: "",
          configured: false,
          checkedAt,
          error: "请先保存 AI API Key 后再获取模型列表。",
          models: [] as NormalizedAiModelItem[],
          freeCount: 0,
          paidCount: 0,
          unknownCount: 0,
        };
      }

      const endpoint = buildAiModelsEndpoint(provider, baseUrl, chatOnly);
      try {
        const resp = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        });
        if (!resp.ok) {
          const message = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status}${message ? `: ${message.slice(0, 120)}` : ""}`);
        }
        const payload = await resp.json().catch(() => null) as { data?: unknown };
        const models = (Array.isArray(payload?.data) ? payload.data : [])
          .map((item) => normalizeAiModelItem(item))
          .filter((item): item is NormalizedAiModelItem => !!item)
          .sort((a, b) => {
            const freeRank = aiModelFreeSortRank(a.isFree) - aiModelFreeSortRank(b.isFree);
            if (freeRank !== 0) return freeRank;
            return a.id.localeCompare(b.id, "en");
          });
        const freeCount = models.filter((item) => item.isFree === true).length;
        const paidCount = models.filter((item) => item.isFree === false).length;
        return {
          provider,
          baseUrl,
          endpoint,
          configured: true,
          checkedAt,
          error: "",
          models,
          freeCount,
          paidCount,
          unknownCount: Math.max(0, models.length - freeCount - paidCount),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AI] list models failed provider=${provider}: ${message}`);
        return {
          provider,
          baseUrl,
          endpoint,
          configured: true,
          checkedAt,
          error: `获取模型列表失败：${message}`,
          models: [] as NormalizedAiModelItem[],
          freeCount: 0,
          paidCount: 0,
          unknownCount: 0,
        };
      }
    }),

  /** 管理员更新系统设置 */
  updateSettings: adminProcedure
    .input(
      z.object({
        panelPublicUrl: z.string().max(256).optional(),
        siteTitle: siteTitleSchema.optional(),
        siteLogoDataUrl: brandLogoSchema.optional(),
        personalizationTheme: z.string().max(32).optional(),
        registrationEnabled: z.boolean().optional(),
        twoFactorEnabled: z.boolean().optional(),
        lookingGlassUserEnabled: z.boolean().optional(),
        allowMultiDeviceLogin: z.boolean().optional(),
        pluginsEnabled: z.boolean().optional(),
        publicHostMonitor: z.object({
          enabled: z.boolean().optional(),
          path: z.string().max(128).optional(),
          title: z.string().max(80).optional(),
        }).optional(),
        homepageEnabled: z.boolean().optional(),
        homepageCustomEnabled: z.boolean().optional(),
        homepageHtml: z.string().max(60000).optional(),
        personalizationBackground: personalizationBackgroundSchema.optional(),
        forwardProtocols: forwardProtocolSettingsSchema.optional(),
        sidebarMenu: sidebarMenuSettingsSchema.optional(),
        tunnelRuntimeDefault: z.enum(["forwardx", "gost"]).optional(),
        githubAccelerator: z.object({
          enabled: z.boolean().optional(),
          url: githubAcceleratorUrlSchema.optional(),
        }).optional(),
        agentPreferPanelInstall: z.boolean().optional(),
        email: z.object({
          enabled: z.boolean().optional(),
          host: z.string().max(256).optional(),
          port: z.number().int().min(1).max(65535).optional(),
          secure: z.boolean().optional(),
          user: z.string().max(256).optional(),
          password: z.string().max(512).optional(),
          from: z.string().max(320).optional(),
          verifyRegistration: z.boolean().optional(),
          whitelistEnabled: z.boolean().optional(),
          whitelist: z.string().max(1000).optional(),
          expiryReminder: z.boolean().optional(),
          trafficReminder: z.boolean().optional(),
          trafficReminderThreshold: z.number().int().min(1).max(99).optional(),
        }).optional(),
        telegram: z.object({
          enabled: z.boolean().optional(),
          botToken: z.string().max(256).optional(),
          clearToken: z.boolean().optional(),
          expiryReminder: z.boolean().optional(),
          trafficReminder: z.boolean().optional(),
          trafficReminderThreshold: z.number().int().min(1).max(99).optional(),
          hostStatusNotify: z.boolean().optional(),
        }).optional(),
        deepseek: z.object({
          provider: aiProviderSchema.optional(),
          enabled: z.boolean().optional(),
          apiKey: z.string().max(512).optional(),
          clearApiKey: z.boolean().optional(),
          baseUrl: z.string().max(256).optional(),
          model: z.string().max(128).optional(),
          maxTokens: z.number().int().min(128).max(8192).optional(),
          temperature: z.number().min(0).max(2).optional(),
          telegramUserManageEnabled: z.boolean().optional(),
          telegramAutoRecallEnabled: z.boolean().optional(),
          telegramAutoRecallSeconds: z.number().int().min(30).max(1200).optional(),
        }).optional(),
        ddns: z.object({
          enabled: z.boolean().optional(),
          provider: ddnsProviderSchema.optional(),
          ttl: z.number().int().min(60).max(86400).optional(),
          cloudflareZoneId: z.string().max(256).optional(),
          cloudflareApiToken: z.string().max(512).optional(),
          clearCloudflareApiToken: z.boolean().optional(),
          huaweicloudAccessKeyId: z.string().max(256).optional(),
          huaweicloudSecretKey: z.string().max(512).optional(),
          clearHuaweiCloudSecretKey: z.boolean().optional(),
          huaweicloudRegion: z.string().max(64).optional(),
          huaweicloudEndpoint: z.string().max(512).optional(),
          huaweicloudZoneId: z.string().max(256).optional(),
          huaweicloudTtl: z.number().int().min(60).max(86400).optional(),
          huaweicloudLine: z.string().max(128).optional(),
          aliyunAccessKeyId: z.string().max(256).optional(),
          aliyunAccessKeySecret: z.string().max(512).optional(),
          clearAliyunAccessKeySecret: z.boolean().optional(),
          aliyunDomainName: z.string().max(255).optional(),
          aliyunEndpoint: z.string().max(512).optional(),
          aliyunTtl: z.number().int().min(60).max(86400).optional(),
          aliyunLine: z.string().max(128).optional(),
          tencentcloudSecretId: z.string().max(256).optional(),
          tencentcloudSecretKey: z.string().max(512).optional(),
          clearTencentCloudSecretKey: z.boolean().optional(),
          tencentcloudDomainName: z.string().max(255).optional(),
          tencentcloudTtl: z.number().int().min(60).max(86400).optional(),
          tencentcloudRecordLine: z.string().max(128).optional(),
          tencentcloudRecordLineId: z.string().max(128).optional(),
          webhookUrl: z.string().max(1000).optional(),
          webhookMethod: z.enum(["POST", "PUT", "GET"]).optional(),
          webhookHeaders: z.string().max(2000).optional(),
        }).optional(),
      })
    )
    .mutation(async ({ input }) => {
      if (input.panelPublicUrl !== undefined) {
        const v = input.panelPublicUrl.trim();
        if (v && !/^https?:\/\//i.test(v)) {
          throw new Error("面板公开地址必须以 http:// 或 https:// 开头");
        }
        // 去除尾部斜杠
        const normalized = v.replace(/\/+$/, "");
        await db.setSetting("panelPublicUrl", normalized || null);
        console.info(`[Settings] panelPublicUrl ${normalized ? "updated" : "cleared"}`);
      }
      if (input.siteTitle !== undefined) {
        const title = input.siteTitle.trim();
        await db.setSetting("siteTitle", title || null);
        console.info(`[Settings] site title ${title ? "updated" : "cleared"}`);
      }
      if (input.siteLogoDataUrl !== undefined) {
        const logo = input.siteLogoDataUrl.trim();
        if (!isValidBrandLogoValue(logo)) {
          throw new Error("Logo 格式不支持或超过 100KB");
        }
        await db.setSetting("siteLogoDataUrl", logo || null);
        console.info(`[Settings] site logo ${logo ? "updated" : "cleared"}`);
      }
      if (input.personalizationTheme !== undefined) {
        const theme = normalizePersonalizationThemePresetId(input.personalizationTheme);
        await db.setSetting("personalizationTheme", theme);
        console.info(`[Settings] personalization theme updated theme=${theme}`);
      }
      if (input.registrationEnabled !== undefined) {
        await db.setSetting("registrationEnabled", input.registrationEnabled ? "true" : "false");
        console.info(`[Settings] public registration ${input.registrationEnabled ? "enabled" : "disabled"}`);
      }
      if (input.twoFactorEnabled !== undefined) {
        await db.setSetting("twoFactorEnabled", input.twoFactorEnabled ? "true" : "false");
        console.info(`[Settings] 2FA ${input.twoFactorEnabled ? "enabled" : "disabled"}`);
      }
      if (input.lookingGlassUserEnabled !== undefined) {
        await db.setSetting("lookingGlassUserEnabled", input.lookingGlassUserEnabled ? "true" : "false");
        console.info(`[Settings] network test for users ${input.lookingGlassUserEnabled ? "enabled" : "disabled"}`);
      }
      if (input.allowMultiDeviceLogin !== undefined) {
        await db.setSetting("allowMultiDeviceLogin", input.allowMultiDeviceLogin ? "true" : "false");
        console.info(`[Settings] multi-device login ${input.allowMultiDeviceLogin ? "enabled" : "disabled"}`);
      }
      if (input.pluginsEnabled !== undefined) {
        await db.setSetting("pluginsEnabled", input.pluginsEnabled ? "true" : "false");
        console.info(`[Settings] plugins ${input.pluginsEnabled ? "enabled" : "disabled"}`);
      }
      if (input.publicHostMonitor) {
        const next: Record<string, string | null> = {};
        if (input.publicHostMonitor.enabled !== undefined) {
          next.publicHostMonitorEnabled = input.publicHostMonitor.enabled ? "true" : "false";
        }
        if (input.publicHostMonitor.path !== undefined) {
          next.publicHostMonitorPath = assertPublicHostMonitorPath(input.publicHostMonitor.path);
        }
        if (input.publicHostMonitor.title !== undefined) {
          next.publicHostMonitorTitle = normalizePublicHostMonitorTitle(input.publicHostMonitor.title);
        }
        await db.setSettings(next);
        console.info("[Settings] public host monitor settings updated");
      }
      if (input.homepageEnabled !== undefined) {
        await db.setSetting("homepageEnabled", input.homepageEnabled ? "true" : "false");
        console.info(`[Settings] homepage ${input.homepageEnabled ? "enabled" : "disabled"}`);
      }
      if (input.homepageCustomEnabled !== undefined) {
        await db.setSetting("homepageCustomEnabled", input.homepageCustomEnabled ? "true" : "false");
        console.info(`[Settings] custom homepage ${input.homepageCustomEnabled ? "enabled" : "disabled"}`);
      }
      if (input.homepageHtml !== undefined) {
        await db.setSetting("homepageHtml", input.homepageHtml.trim() || null);
        console.info("[Settings] custom homepage html updated");
      }
      if (input.personalizationBackground !== undefined) {
        const background = normalizePersonalizationBackground(input.personalizationBackground);
        const encoded = JSON.stringify(background);
        if (encoded.length > personalizationBackgroundConfigMaxLength) {
          throw new Error("背景配置过大，请删除部分上传背景后再保存");
        }
        await db.setSetting("personalizationBackground", encoded);
        console.info(`[Settings] personalization background updated source=${background.source}`);
      }
      if (input.forwardProtocols !== undefined) {
        const normalized = normalizeForwardProtocolSettings(input.forwardProtocols);
        await db.setSetting("forwardProtocols", JSON.stringify(normalized));
        const hosts = await db.getHosts();
        for (const host of hosts as any[]) {
          pushAgentRefresh(host.id, "forward-protocol-settings-updated");
        }
        console.info("[Settings] forward protocol switches updated");
      }
      if (input.sidebarMenu !== undefined) {
        const normalized = normalizeSidebarMenuSettings(input.sidebarMenu);
        await db.setSetting("sidebarMenu", JSON.stringify(normalized));
        console.info("[Settings] sidebar menu switches updated");
      }
      if (input.tunnelRuntimeDefault !== undefined) {
        const runtime = input.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx";
        await db.setSetting("tunnelRuntimeDefault", runtime);
        console.info(`[Settings] tunnel runtime default set to ${runtime}`);
      }
      if (input.githubAccelerator) {
        const next: Record<string, string | null> = {};
        if (input.githubAccelerator.enabled !== undefined) {
          next.githubAcceleratorEnabled = input.githubAccelerator.enabled ? "true" : "false";
        }
        if (input.githubAccelerator.url !== undefined) {
          next.githubAcceleratorUrl = normalizeOptionalHttpUrl(input.githubAccelerator.url) || null;
        }
        await db.setSettings(next);
        console.info("[Settings] GitHub accelerator settings updated");
      }
      if (input.agentPreferPanelInstall !== undefined) {
        await db.setSetting("agentPreferPanelInstall", input.agentPreferPanelInstall ? "true" : "false");
        console.info(`[Settings] Agent panel-first install ${input.agentPreferPanelInstall ? "enabled" : "disabled"}`);
      }
      if (input.email) {
        const email = input.email;
        const next: Record<string, string | null> = {};
        if (email.enabled !== undefined) next.emailEnabled = email.enabled ? "true" : "false";
        if (email.host !== undefined) next.emailHost = email.host.trim() || null;
        if (email.port !== undefined) next.emailPort = String(email.port);
        if (email.secure !== undefined) next.emailSecure = email.secure ? "true" : "false";
        if (email.user !== undefined) next.emailUser = email.user.trim() || null;
        if (email.password !== undefined && email.password.trim()) next.emailPassword = email.password;
        if (email.from !== undefined) next.emailFrom = email.from.trim() || null;
        if (email.verifyRegistration !== undefined) next.emailVerifyRegistration = email.verifyRegistration ? "true" : "false";
        if (email.whitelistEnabled !== undefined) next.emailWhitelistEnabled = email.whitelistEnabled ? "true" : "false";
        if (email.whitelist !== undefined) next.emailWhitelist = email.whitelist.trim() || null;
        if (email.expiryReminder !== undefined) next.emailExpiryReminder = email.expiryReminder ? "true" : "false";
        if (email.trafficReminder !== undefined) next.emailTrafficReminder = email.trafficReminder ? "true" : "false";
        if (email.trafficReminderThreshold !== undefined) next.emailTrafficReminderThreshold = String(email.trafficReminderThreshold);
        await db.setSettings(next);
        console.info("[Settings] email settings updated");
      }
      if (input.telegram) {
        const next: Record<string, string | null> = {};
        const envToken = ENV.telegramBotToken.trim();
        const currentDbToken = String((await db.getSetting("telegramBotToken")) || "").trim();
        const currentEnabledSetting = await db.getSetting("telegramBotEnabled");
        const submittedToken = String(input.telegram.botToken || "").trim();
        const clearingToken = !!input.telegram.clearToken;
        const effectiveToken = envToken || (clearingToken ? "" : (submittedToken || currentDbToken));
        const nextEnabled = input.telegram.enabled !== undefined
          ? !!input.telegram.enabled
          : (currentEnabledSetting === "true" || (!!envToken && currentEnabledSetting !== "false"));
        const wantsReminder = !!input.telegram.expiryReminder || !!input.telegram.trafficReminder || !!input.telegram.hostStatusNotify;
        if (nextEnabled && !effectiveToken) {
          throw new Error("请先配置 Telegram Bot Token");
        }
        if (wantsReminder && (!nextEnabled || !effectiveToken)) {
          throw new Error("请先配置并启用 Telegram 机器人");
        }
        if (input.telegram.enabled !== undefined) next.telegramBotEnabled = input.telegram.enabled ? "true" : "false";
        if (input.telegram.expiryReminder !== undefined) next.telegramExpiryReminder = input.telegram.expiryReminder && nextEnabled && !!effectiveToken ? "true" : "false";
        if (input.telegram.trafficReminder !== undefined) next.telegramTrafficReminder = input.telegram.trafficReminder && nextEnabled && !!effectiveToken ? "true" : "false";
        if (input.telegram.trafficReminderThreshold !== undefined) next.telegramTrafficReminderThreshold = String(input.telegram.trafficReminderThreshold);
        if (input.telegram.hostStatusNotify !== undefined) next.telegramHostStatusNotify = input.telegram.hostStatusNotify && nextEnabled && !!effectiveToken ? "true" : "false";
        let tokenChanged = false;
        if (input.telegram.clearToken) {
          next.telegramBotToken = null;
          next.telegramBotUsername = null;
          if (!envToken) {
            next.telegramBotEnabled = "false";
            next.telegramExpiryReminder = "false";
            next.telegramTrafficReminder = "false";
            next.telegramHostStatusNotify = "false";
          }
          tokenChanged = true;
        }
        if (input.telegram.botToken !== undefined && input.telegram.botToken.trim()) {
          next.telegramBotToken = input.telegram.botToken.trim();
          next.telegramBotUsername = null;
          tokenChanged = true;
        }
        await db.setSettings(next);
        if (tokenChanged) resetTelegramBotPolling();
        if (next.telegramBotToken || input.telegram.enabled) {
          await refreshTelegramBotProfile().catch((error) => {
            console.warn(`[Telegram] getMe after settings update failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          startTelegramBot().catch((error) => {
            console.warn(`[Telegram] start after settings update failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        console.info("[Settings] telegram settings updated");
      }
      if (input.deepseek) {
        const deepseek = input.deepseek;
        const next: Record<string, string | null> = {};
        const allSettings = await db.getAllSettings();
        const currentProvider = normalizeAiProvider(allSettings.deepseekProvider);
        const nextProvider = deepseek.provider !== undefined
          ? normalizeAiProvider(deepseek.provider)
          : currentProvider;
        const providerKeys = getAiProviderSettingKeys(nextProvider);
        const providerConfig = readAiProviderConfig(allSettings, nextProvider);
        const providerDefaultBaseUrl = getAiProviderDefaultBaseUrl(nextProvider);
        const providerDefaultModel = getAiProviderDefaultModel(nextProvider);
        const submittedApiKey = normalizeAiApiKey(deepseek.apiKey);
        const clearingApiKey = !!deepseek.clearApiKey;
        const effectiveApiKey = clearingApiKey ? "" : (submittedApiKey || providerConfig.apiKey);
        const currentEnabledSetting = allSettings.deepseekAiEnabled;
        const nextEnabled = deepseek.enabled !== undefined ? !!deepseek.enabled : currentEnabledSetting === "true";

        if (nextEnabled && !effectiveApiKey) {
          throw new Error("请先配置 AI API Key");
        }
        if (deepseek.provider !== undefined) next.deepseekProvider = nextProvider;
        if (deepseek.enabled !== undefined) next.deepseekAiEnabled = deepseek.enabled ? "true" : "false";
        if (deepseek.baseUrl !== undefined) {
          const normalizedBaseUrl = normalizeOptionalHttpUrl(deepseek.baseUrl) || providerDefaultBaseUrl;
          next[providerKeys.baseUrl] = normalizedBaseUrl;
          if (nextProvider === DEFAULT_AI_PROVIDER) next.deepseekBaseUrl = normalizedBaseUrl;
        }
        if (deepseek.model !== undefined) {
          const normalizedModel = deepseek.model.trim() || providerDefaultModel;
          next[providerKeys.model] = normalizedModel;
          if (nextProvider === DEFAULT_AI_PROVIDER) next.deepseekModel = normalizedModel;
        }
        if (deepseek.maxTokens !== undefined) next.deepseekMaxTokens = String(deepseek.maxTokens);
        if (deepseek.temperature !== undefined) next.deepseekTemperature = String(deepseek.temperature);
        if (deepseek.telegramUserManageEnabled !== undefined) {
          next.telegramAiUserManageEnabled = deepseek.telegramUserManageEnabled ? "true" : "false";
        }
        if (deepseek.telegramAutoRecallEnabled !== undefined) next.telegramAiAutoRecallEnabled = deepseek.telegramAutoRecallEnabled ? "true" : "false";
        if (deepseek.telegramAutoRecallSeconds !== undefined) next.telegramAiAutoRecallSeconds = String(deepseek.telegramAutoRecallSeconds);
        if (deepseek.clearApiKey) {
          next[providerKeys.apiKey] = null;
          if (nextProvider === DEFAULT_AI_PROVIDER) next.deepseekApiKey = null;
          next.deepseekAiEnabled = "false";
        }
        if (submittedApiKey) {
          next[providerKeys.apiKey] = submittedApiKey;
          if (nextProvider === DEFAULT_AI_PROVIDER) next.deepseekApiKey = submittedApiKey;
        }
        await db.setSettings(next);
        console.info("[Settings] AI model settings updated");
      }
      if (input.ddns) {
        const next: Record<string, string | null> = {};
        if (input.ddns.enabled !== undefined) next.ddnsEnabled = input.ddns.enabled ? "true" : "false";
        if (input.ddns.provider !== undefined) next.ddnsProvider = input.ddns.provider;
        if (input.ddns.cloudflareZoneId !== undefined) next.ddnsCloudflareZoneId = input.ddns.cloudflareZoneId.trim() || null;
        if (input.ddns.clearCloudflareApiToken) next.ddnsCloudflareApiToken = null;
        if (input.ddns.cloudflareApiToken !== undefined && input.ddns.cloudflareApiToken.trim()) {
          next.ddnsCloudflareApiToken = input.ddns.cloudflareApiToken.trim();
        }
        if (input.ddns.huaweicloudAccessKeyId !== undefined) next.ddnsHuaweiCloudAccessKeyId = input.ddns.huaweicloudAccessKeyId.trim() || null;
        if (input.ddns.clearHuaweiCloudSecretKey) next.ddnsHuaweiCloudSecretKey = null;
        if (input.ddns.huaweicloudSecretKey !== undefined && input.ddns.huaweicloudSecretKey.trim()) {
          next.ddnsHuaweiCloudSecretKey = input.ddns.huaweicloudSecretKey.trim();
        }
        if (input.ddns.huaweicloudRegion !== undefined) next.ddnsHuaweiCloudRegion = input.ddns.huaweicloudRegion.trim() || null;
        if (input.ddns.huaweicloudEndpoint !== undefined) next.ddnsHuaweiCloudEndpoint = normalizeOptionalHttpUrl(input.ddns.huaweicloudEndpoint) || null;
        if (input.ddns.huaweicloudZoneId !== undefined) next.ddnsHuaweiCloudZoneId = input.ddns.huaweicloudZoneId.trim() || null;
        if (input.ddns.huaweicloudTtl !== undefined) next.ddnsHuaweiCloudTtl = String(input.ddns.huaweicloudTtl);
        if (input.ddns.huaweicloudLine !== undefined) next.ddnsHuaweiCloudLine = input.ddns.huaweicloudLine.trim() || null;
        if (input.ddns.aliyunAccessKeyId !== undefined) next.ddnsAliyunAccessKeyId = input.ddns.aliyunAccessKeyId.trim() || null;
        if (input.ddns.clearAliyunAccessKeySecret) next.ddnsAliyunAccessKeySecret = null;
        if (input.ddns.aliyunAccessKeySecret !== undefined && input.ddns.aliyunAccessKeySecret.trim()) {
          next.ddnsAliyunAccessKeySecret = input.ddns.aliyunAccessKeySecret.trim();
        }
        if (input.ddns.aliyunDomainName !== undefined) next.ddnsAliyunDomainName = input.ddns.aliyunDomainName.trim() || null;
        if (input.ddns.aliyunEndpoint !== undefined) next.ddnsAliyunEndpoint = normalizeOptionalHttpUrl(input.ddns.aliyunEndpoint) || null;
        if (input.ddns.aliyunTtl !== undefined) next.ddnsAliyunTtl = String(input.ddns.aliyunTtl);
        if (input.ddns.aliyunLine !== undefined) next.ddnsAliyunLine = input.ddns.aliyunLine.trim() || null;
        if (input.ddns.tencentcloudSecretId !== undefined) next.ddnsTencentCloudSecretId = input.ddns.tencentcloudSecretId.trim() || null;
        if (input.ddns.clearTencentCloudSecretKey) next.ddnsTencentCloudSecretKey = null;
        if (input.ddns.tencentcloudSecretKey !== undefined && input.ddns.tencentcloudSecretKey.trim()) {
          next.ddnsTencentCloudSecretKey = input.ddns.tencentcloudSecretKey.trim();
        }
        if (input.ddns.tencentcloudDomainName !== undefined) next.ddnsTencentCloudDomainName = input.ddns.tencentcloudDomainName.trim() || null;
        if (input.ddns.tencentcloudTtl !== undefined) next.ddnsTencentCloudTtl = String(input.ddns.tencentcloudTtl);
        if (input.ddns.tencentcloudRecordLine !== undefined) next.ddnsTencentCloudRecordLine = input.ddns.tencentcloudRecordLine.trim() || null;
        if (input.ddns.tencentcloudRecordLineId !== undefined) next.ddnsTencentCloudRecordLineId = input.ddns.tencentcloudRecordLineId.trim() || null;
        if (input.ddns.ttl !== undefined) {
          const ttl = String(input.ddns.ttl);
          next.ddnsTtl = ttl;
          next.ddnsHuaweiCloudTtl = ttl;
          next.ddnsAliyunTtl = ttl;
          next.ddnsTencentCloudTtl = ttl;
        }
        if (input.ddns.webhookUrl !== undefined) next.ddnsWebhookUrl = input.ddns.webhookUrl.trim() || null;
        if (input.ddns.webhookMethod !== undefined) next.ddnsWebhookMethod = input.ddns.webhookMethod;
        if (input.ddns.webhookHeaders !== undefined) next.ddnsWebhookHeaders = input.ddns.webhookHeaders.trim() || null;
        await db.setSettings(next);
        db.runForwardGroupFailoverSweep({ manual: true }).catch((error) => {
          console.warn(`[Settings] forward group DDNS refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        console.info("[Settings] ddns settings updated");
      }
      return { success: true };
    }),

  updateWebPort: adminProcedure
    .input(z.object({ port: z.number().int().min(1).max(65535), confirmed: z.literal(true) }))
    .mutation(async ({ input }) => {
      if (!canManageWebPort()) {
        if (isDockerRuntime()) {
          throw new Error("Docker 部署的 Web 端口由宿主机端口映射管理，面板内不支持修改。请调整部署目录 .env 的 PORT 或 docker-compose.yml 后重启容器。");
        }
        throw new Error("当前环境不支持在后台修改 Web 端口，请在服务环境变量或启动脚本中修改。");
      }
      const port = normalizePort(input.port);
      const currentPort = normalizePort(ENV.port || 9810);
      if (port === currentPort) return { success: true, port, restartScheduled: false };
      if (!(await isTcpPortAvailable(port))) {
        throw new Error(`端口 ${port} 已被占用，请更换端口`);
      }
      await updateEnvFileValue(webPortConfigPath(), "PORT", String(port));
      await db.setSetting("webPort", String(port));
      console.info(`[Settings] web port updated ${currentPort} -> ${port}; scheduling service restart`);
      schedulePanelRestart("web port change");
      return { success: true, port, restartScheduled: true };
    }),

  updatePanelSsl: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      mode: z.enum(["path", "pem"]).optional().default("path"),
      certPath: z.string().max(1024).optional().default(""),
      keyPath: z.string().max(1024).optional().default(""),
      certPem: z.string().max(20000).optional().default(""),
      keyPem: z.string().max(20000).optional().default(""),
      confirmed: z.literal(true),
    }))
    .mutation(async ({ input }) => {
      const next = {
        enabled: input.enabled,
        mode: input.mode,
        certPath: input.certPath.trim(),
        keyPath: input.keyPath.trim(),
        certPem: input.certPem.trim(),
        keyPem: input.keyPem.trim(),
      };
      if (next.enabled || (next.mode === "pem" && (next.certPem || next.keyPem))) {
        await validatePanelSslConfig({ ...next, enabled: true });
      }

      const all = await db.getAllSettings();
      const current = readPanelSslSettings(all);
      const changed = current.enabled !== next.enabled
        || current.mode !== next.mode
        || current.certPath !== next.certPath
        || current.keyPath !== next.keyPath
        || current.certPem !== next.certPem
        || current.keyPem !== next.keyPem;
      if (!changed) return { success: true, changed: false, restartScheduled: false, enabled: next.enabled };
      const restartRequired = current.enabled !== next.enabled
        || (next.enabled && (
          current.mode !== next.mode
          || current.certPath !== next.certPath
          || current.keyPath !== next.keyPath
          || current.certPem !== next.certPem
          || current.keyPem !== next.keyPem
        ));

      await db.setSettings({
        panelSslEnabled: next.enabled ? "true" : "false",
        panelSslMode: next.mode,
        panelSslCertPath: next.certPath || null,
        panelSslKeyPath: next.keyPath || null,
        panelSslCertPem: next.certPem || null,
        panelSslKeyPem: next.keyPem || null,
      });
      if (restartRequired) {
        console.info(`[Settings] panel SSL ${next.enabled ? "enabled" : "disabled"}; scheduling service restart`);
        schedulePanelRestart("panel SSL change");
      } else {
        console.info("[Settings] panel SSL file paths saved without restart");
      }
      return { success: true, changed: true, restartScheduled: restartRequired, enabled: next.enabled };
    }),

  generatePanelSelfSignedCertificate: adminProcedure
    .input(z.object({
      hosts: z.array(z.string().max(256)).max(20).optional().default([]),
      days: z.number().int().min(1).max(3650).optional().default(825),
    }).optional())
    .mutation(async ({ input }) => {
      const all = await db.getAllSettings();
      const hosts = [...(input?.hosts || [])];
      if (all.panelPublicUrl) hosts.push(all.panelPublicUrl);
      const generated = await generateSelfSignedPanelSslCertificate(hosts, input?.days || 825);
      await db.setSettings({
        panelSslMode: "path",
        panelSslCertPath: generated.certPath,
        panelSslKeyPath: generated.keyPath,
      });
      console.info(`[Settings] generated self-signed panel SSL certificate at ${generated.certPath}`);
      return { success: true, ...generated };
    }),

  createMigrationCode: adminProcedure.mutation(() => {
    return createMigrationCode();
  }),

  getMigrationCode: adminProcedure.query(() => {
    return getCurrentMigrationCode();
  }),

  approveMigrationRequest: adminProcedure
    .input(z.object({ requestId: z.string().min(1) }))
    .mutation(({ input }) => {
      const request = approveMigrationRequest(input.requestId);
      if (!request) throw new Error("迁移请求不存在、已过期或状态已变化");
      return { success: true, request };
    }),

  rejectMigrationRequest: adminProcedure
    .input(z.object({ requestId: z.string().min(1) }))
    .mutation(({ input }) => {
      const request = rejectMigrationRequest(input.requestId);
      if (!request) throw new Error("迁移请求不存在、已过期或状态已变化");
      return { success: true, request };
    }),

  backupSummary: adminProcedure.query(async () => {
    return getPanelDataSummary();
  }),

  exportPanelBackup: adminProcedure
    .input(z.object({
      password: z.string().min(8, "备份密码至少需要 8 位").max(256),
    }))
    .mutation(async ({ input }) => {
      const settings = await db.getAllSettings();
      const snapshot = await exportMigrationSnapshot(settings.panelPublicUrl || undefined);
      const backupSnapshot = pruneMigrationSnapshotForPanelBackup(snapshot);
      const backup = encryptMigrationSnapshot(backupSnapshot, input.password);
      const timestamp = new Date(snapshot.exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
      console.info(`[Backup] Exported encrypted panel backup users=${backupSnapshot.tables.users?.length || 0} hosts=${backupSnapshot.tables.hosts?.length || 0}`);
      return {
        filename: `forwardx-panel-backup-v${APP_VERSION}-${timestamp}.fwxbak`,
        mimeType: "application/json;charset=utf-8",
        content: JSON.stringify(backup, null, 2),
        summary: summarizeMigrationSnapshot(backupSnapshot),
      };
    }),

  importPanelBackup: adminProcedure
    .input(z.object({
      content: z.string().min(1, "请选择备份文件").max(50 * 1024 * 1024, "备份文件过大"),
      password: z.string().min(1, "请输入备份密码").max(256),
      targetPanelUrl: z.string().trim().max(256).optional(),
      confirmed: z.literal(true),
    }))
    .mutation(async ({ input }) => {
      const snapshot = decryptMigrationSnapshotBackup(input.content, input.password);
      const result = await importMigrationSnapshot(snapshot, {
        targetPanelUrl: input.targetPanelUrl || undefined,
      });
      console.info(`[Backup] Imported encrypted panel backup mode=${result.mode} hosts=${result.hostCount}`);
      return result;
    }),

  startPanelMigration: adminProcedure
    .input(z.object({
      oldPanelUrl: z.string().trim().min(1, "请输入旧面板地址").max(256),
      migrationCode: z.string().trim().min(1, "请输入旧面板迁移码").max(64),
      targetPanelUrl: z.string().trim().min(1, "请输入新面板访问地址").max(256),
      confirmed: z.literal(true),
    }))
    .mutation(({ input }) => {
      const job = beginPanelMigration({
        oldPanelUrl: input.oldPanelUrl,
        migrationCode: input.migrationCode,
        targetPanelUrl: input.targetPanelUrl,
      });
      return job;
    }),

  panelMigrationStatus: adminProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(({ input }) => getMigrationJob(input.jobId)),

  databaseSwitchStatus: adminProcedure.query(() => {
    return getDatabaseSwitchStatus();
  }),

  testDatabaseSwitchTarget: adminProcedure
    .input(databaseConfigInput)
    .mutation(async ({ input }) => {
      await testDatabaseSwitchTarget(input as DatabaseConfig);
      return { success: true };
    }),

  startDatabaseSwitch: adminProcedure
    .input(z.object({
      target: databaseConfigInput,
      confirmed: z.literal(true),
    }))
    .mutation(({ input }) => {
      return startDatabaseSwitch(input.target as DatabaseConfig);
    }),

  databaseSwitchJob: adminProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(({ input }) => getDatabaseSwitchJob(input.jobId)),

  sendTestEmail: adminProcedure
    .input(z.object({ to: z.string().email("请输入有效邮箱地址") }))
    .mutation(async ({ input }) => {
      await sendMail({
        to: input.to,
        subject: "ForwardX 邮箱测试",
        text: "这是一封 ForwardX 邮箱对接测试邮件。如果你收到此邮件，说明 SMTP 配置已生效。",
      });
      return { success: true };
    }),

  /** 检查 GitHub 是否有新版本 */
  checkUpdate: adminProcedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
    const force = !!input?.force;
    console.info(`[Update] Checking latest version${force ? " (force)" : ""}`);
    const info = await checkPanelUpdateTask(force);
    if (info.error) {
      console.warn(`[Update] Check failed: ${info.error}`);
    } else {
      console.info(`[Update] Current v${APP_VERSION}, latest ${info.latestVersion || "unknown"}${info.source ? ` source=${info.source}` : ""}`);
    }
    return info;
  }),

  /** 获取上次检查结果和升级任务状态 */
  upgradeStatus: adminProcedure.query(() => {
    return {
      currentVersion: APP_VERSION,
      repoUrl: REPO_URL,
      update: lastUpdateInfo,
      job: upgradeJob,
      upgradeEnabled: !!ENV.upgradeCommand.trim(),
      ...getDeploymentInfo(),
    };
  }),

  rollbackVersions: adminProcedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      try {
        return await getRollbackVersionInfoCached(!!input?.force);
      } catch (error: any) {
        return {
          currentPanelVersion: APP_VERSION,
          currentAgentVersion: AGENT_VERSION,
          panelVersions: [],
          agentVersions: [],
          compatibility: mergeCompatibilityRecords(PANEL_AGENT_COMPATIBILITY.map((item) => ({
            panelVersion: item.panelVersion,
            agentVersion: item.agentVersion,
            releaseUrl: `${REPO_URL}/releases/tag/v${normalizeVersion(item.panelVersion)}`,
            publishedAt: null,
          }))),
          checkedAt: new Date().toISOString(),
          error: error?.message || "获取可回退版本失败",
        };
      }
    }),

  /** 启动后台升级任务。实际命令由 FORWARDX_UPGRADE_COMMAND 提供。 */
  panelLogs: adminProcedure
    .input(logPageInputSchema.optional())
    .query(async ({ input }) => {
      const page = await getPanelLogPage({
        level: input?.level || "all",
        limit: input?.limit,
        offset: input?.offset,
      });
      return {
        ...page,
        checkedAt: new Date().toISOString(),
      };
    }),

  exportPanelLogs: adminProcedure
    .input(z.object({ level: panelLogLevelSchema.default("all") }).optional())
    .mutation(({ input }) => {
      const level = input?.level || "all";
      const exported = formatPanelLogsForExport(level, {
        "App Version": APP_VERSION,
        "Android App Version": ANDROID_APP_VERSION,
        "Agent Version": AGENT_VERSION,
        "Repository": REPO_URL,
      });
      const timestamp = exported.generatedAt.replace(/[:.]/g, "-");
      console.info(`[PanelLogs] Exported panel logs level=${level} count=${exported.count}`);
      return {
        filename: `forwardx-panel-logs-${level}-${timestamp}.txt`,
        mimeType: "text/plain;charset=utf-8",
        content: exported.content,
        count: exported.count,
      };
    }),

  clearPanelLogs: adminProcedure.mutation(() => {
    clearPanelLogs();
    console.info("[PanelLogs] Cleared panel logs");
    return { success: true };
  }),
  startVersionRollback: adminProcedure
    .input(z.object({
      type: z.enum(["panel", "agent"]),
      targetVersion: z.string().min(1).max(64),
    }))
    .mutation(async ({ input }) => {
      const targetVersion = normalizeVersion(input.targetVersion);
      if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error("回退版本格式不正确");
      const info = await getRollbackVersionInfoCached();
      if (input.type === "panel") {
        if (!info.panelVersions.some((item) => normalizeVersion(item.panelVersion) === targetVersion)) {
          throw new Error("目标面板版本不在最近 5 个可回退版本内");
        }
        return startPanelRollbackTask(targetVersion);
      }

      const target = info.agentVersions.find((item) => normalizeVersion(item.agentVersion) === targetVersion);
      if (!target) throw new Error("目标 Agent 版本不在最近 5 个可回退版本内");
      await assertAgentReleaseAssetsReadyForRollback(target.panelVersion, target.agentVersion);
      const hosts = await db.getHosts();
      const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
      const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
      let requested = 0;
      let pushed = 0;
      let skippedSame = 0;
      for (const host of hosts as any[]) {
        const hostId = Number(host?.id);
        if (!Number.isInteger(hostId) || hostId <= 0) continue;
        const currentAgentVersion = normalizeVersion(host.agentVersion);
        if (currentAgentVersion && currentAgentVersion === target.agentVersion) {
          skippedSame += 1;
          continue;
        }
        await db.requestHostAgentUpgrade(hostId, target.agentVersion, target.panelVersion);
        requested += 1;
        if (pushAgentUpgrade(hostId, target.agentVersion, panelUrl, target.panelVersion)) pushed += 1;
      }
      console.info(`[AgentRollback] targetAgent=v${target.agentVersion} release=v${target.panelVersion} requested=${requested} pushed=${pushed} skippedSame=${skippedSame}`);
      return {
        success: true,
        type: "agent" as const,
        targetVersion: target.agentVersion,
        releaseVersion: target.panelVersion,
        requested,
        pushed,
        skippedSame,
      };
    }),
  startUpgrade: adminProcedure
    .input(z.object({ targetVersion: z.string().min(1).max(64).optional() }).optional())
    .mutation(async ({ input }) => {
      return startPanelUpgradeTask(input?.targetVersion);
    }),
});

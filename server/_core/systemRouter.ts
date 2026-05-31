import { router, publicProcedure, adminProcedure } from "./trpc";
import { z } from "zod";
import * as db from "../db";
import { ENV } from "../env";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { clearPanelLogs, formatPanelLogsForExport, getFilteredPanelLogs, getPanelLogSummary } from "./panelLogger";
import { clearAgentLogs, getAgentLogSummary, getAgentLogs } from "../agentLogStore";
import { approveMigrationRequest, createMigrationCode, getCurrentMigrationCode, rejectMigrationRequest } from "../migrationCodes";
import { sendMail } from "../email";
import { refreshTelegramBotProfile, resetTelegramBotPolling, startTelegramBot } from "../telegramBot";
import { pushAgentRefresh } from "../agentEvents";
import { maskSecret } from "../ddns";
import {
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  normalizeForwardProtocolSettings,
} from "../../shared/forwardTypes";
import { isValidBrandLogoValue } from "../../shared/avatar";
import { AGENT_VERSION, ANDROID_APP_VERSION, APP_VERSION } from "../../shared/versions";

export { AGENT_VERSION, ANDROID_APP_VERSION, APP_VERSION } from "../../shared/versions";

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
  `${REPO_URL}/releases/download/v${APP_VERSION}/forwardx-android-v${ANDROID_APP_VERSION}.apk`;
const UPDATE_CHECK_COOLDOWN_MS = 60 * 1000;
const MANUAL_LOCAL_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade";
const MANUAL_DOCKER_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade";
const forwardProtocolSettingsSchema = z.object(
  Object.fromEntries(
    [...FORWARD_TYPES, ...TUNNEL_PROTOCOLS].map((key) => [key, z.boolean().optional()])
  ) as Record<(typeof FORWARD_TYPES[number] | typeof TUNNEL_PROTOCOLS[number]), z.ZodOptional<z.ZodBoolean>>
);
const panelLogLevelSchema = z.enum(["all", "log", "info", "warn", "error"]);
const siteTitleSchema = z.string().trim().max(64);
const brandLogoSchema = z.string().max(90 * 1024);

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  source: "release" | "tag" | "main" | null;
  publishedAt: string | null;
  checkedAt: string;
  error?: string;
};

type DeploymentInfo = {
  docker: boolean;
  dockerSocket: boolean;
  manualUpgradeCommand: string;
};

type UpgradeJob = {
  status: "idle" | "running" | "success" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  targetVersion: string | null;
  logs: string[];
  error: string | null;
};

let lastUpdateInfo: UpdateInfo | null = null;
let updateCheckInFlight: Promise<UpdateInfo> | null = null;
let upgradeJob: UpgradeJob = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  targetVersion: null,
  logs: [],
  error: null,
};

function normalizeVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
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
  if (latest) return latest;

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

function normalizePort(value: unknown) {
  const port = Math.floor(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1-65535 的数字");
  }
  return port;
}

function isDockerRuntime() {
  return fs.existsSync("/.dockerenv");
}

function webPortConfigPath() {
  return ENV.portConfigPath.trim() || path.resolve(process.cwd(), ".env");
}

function canManageWebPort() {
  return process.platform !== "win32" && !isDockerRuntime();
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

function schedulePanelRestart() {
  setTimeout(() => {
    console.info("[Settings] exiting process for systemd restart after web port change");
    process.exit(0);
  }, 800);
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
      registrationEnabled: all.registrationEnabled !== "false",
      twoFactorEnabled: all.twoFactorEnabled === "true",
    }));
  }),

  /** 获取系统设置（包含开源地址、版本、面板公开 URL 等元信息） */
  getSettings: publicProcedure.query(async () => {
    const all = await db.getAllSettings();
    return {
      repoUrl: REPO_URL,
      telegramBotUrl: TELEGRAM_BOT_URL,
      version: APP_VERSION,
      androidAppVersion: ANDROID_APP_VERSION,
      androidApkDownloadUrl: ANDROID_APK_DOWNLOAD_URL,
      agentVersion: AGENT_VERSION,
      siteTitle: all.siteTitle || "ForwardX",
      siteLogoDataUrl: all.siteLogoDataUrl || "",
      panelPublicUrl: all.panelPublicUrl ?? "",
      webPort: ENV.port,
      webPortManagement: {
        enabled: canManageWebPort(),
        docker: isDockerRuntime(),
      },
      registrationEnabled: all.registrationEnabled !== "false",
      twoFactorEnabled: all.twoFactorEnabled === "true",
      homepageEnabled: all.homepageEnabled !== "false",
      homepageCustomEnabled: all.homepageCustomEnabled === "true",
      homepageHtml: all.homepageHtml ?? "",
      forwardProtocols: normalizeForwardProtocolSettings(
        parseForwardProtocolSettings(all.forwardProtocols),
      ),
        tunnelRuntimeDefault: all.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx",
        agentLogUploadEnabled: all.agentLogUploadEnabled === "true",
      database: {
        type: all.databaseType || (all.mysqlConfigured === "true" ? "mysql" : "sqlite"),
        configured: Boolean(all.databaseConfigured || all.mysqlConfigured),
        mysqlHost: all.mysqlHost ?? "",
        mysqlDatabase: all.mysqlDatabase ?? "",
        sqlitePath: all.sqlitePath ?? "",
      },
      mysql: {
        configured: Boolean(all.mysqlConfigured ?? ""),
        host: all.mysqlHost ?? "",
        database: all.mysqlDatabase ?? "",
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
        cloudflareZoneId: all.ddnsCloudflareZoneId ?? "",
        cloudflareTokenMasked: maskSecret(all.ddnsCloudflareApiToken),
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
      },
    };
  }),

  /** 管理员更新系统设置 */
  updateSettings: adminProcedure
    .input(
      z.object({
        panelPublicUrl: z.string().max(256).optional(),
        siteTitle: siteTitleSchema.optional(),
        siteLogoDataUrl: brandLogoSchema.optional(),
        registrationEnabled: z.boolean().optional(),
        twoFactorEnabled: z.boolean().optional(),
        homepageEnabled: z.boolean().optional(),
        homepageCustomEnabled: z.boolean().optional(),
        homepageHtml: z.string().max(60000).optional(),
        forwardProtocols: forwardProtocolSettingsSchema.optional(),
        tunnelRuntimeDefault: z.enum(["forwardx", "gost"]).optional(),
        agentLogUploadEnabled: z.boolean().optional(),
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
        }).optional(),
        ddns: z.object({
          enabled: z.boolean().optional(),
          provider: z.enum(["disabled", "cloudflare", "webhook"]).optional(),
          cloudflareZoneId: z.string().max(256).optional(),
          cloudflareApiToken: z.string().max(512).optional(),
          clearCloudflareApiToken: z.boolean().optional(),
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
          throw new Error("Logo 格式不支持或超过 50K");
        }
        await db.setSetting("siteLogoDataUrl", logo || null);
        console.info(`[Settings] site logo ${logo ? "updated" : "cleared"}`);
      }
      if (input.registrationEnabled !== undefined) {
        await db.setSetting("registrationEnabled", input.registrationEnabled ? "true" : "false");
        console.info(`[Settings] public registration ${input.registrationEnabled ? "enabled" : "disabled"}`);
      }
      if (input.twoFactorEnabled !== undefined) {
        await db.setSetting("twoFactorEnabled", input.twoFactorEnabled ? "true" : "false");
        console.info(`[Settings] 2FA ${input.twoFactorEnabled ? "enabled" : "disabled"}`);
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
      if (input.forwardProtocols !== undefined) {
        const normalized = normalizeForwardProtocolSettings(input.forwardProtocols);
        await db.setSetting("forwardProtocols", JSON.stringify(normalized));
        const hosts = await db.getHosts();
        for (const host of hosts as any[]) {
          pushAgentRefresh(host.id, "forward-protocol-settings-updated");
        }
        console.info("[Settings] forward protocol switches updated");
      }
      if (input.tunnelRuntimeDefault !== undefined) {
        const runtime = input.tunnelRuntimeDefault === "gost" ? "gost" : "forwardx";
        await db.setSetting("tunnelRuntimeDefault", runtime);
        console.info(`[Settings] tunnel runtime default set to ${runtime}`);
      }
      if (input.agentLogUploadEnabled !== undefined) {
        await db.setSetting("agentLogUploadEnabled", input.agentLogUploadEnabled ? "true" : "false");
        const hosts = await db.getHosts();
        for (const host of hosts as any[]) pushAgentRefresh(host.id, "agent-log-upload-setting-updated");
        console.info(`[Settings] Agent log upload ${input.agentLogUploadEnabled ? "enabled" : "disabled"}`);
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
        if (input.telegram.enabled !== undefined) next.telegramBotEnabled = input.telegram.enabled ? "true" : "false";
        if (input.telegram.expiryReminder !== undefined) next.telegramExpiryReminder = input.telegram.expiryReminder ? "true" : "false";
        if (input.telegram.trafficReminder !== undefined) next.telegramTrafficReminder = input.telegram.trafficReminder ? "true" : "false";
        if (input.telegram.trafficReminderThreshold !== undefined) next.telegramTrafficReminderThreshold = String(input.telegram.trafficReminderThreshold);
        let tokenChanged = false;
        if (input.telegram.clearToken) {
          next.telegramBotToken = null;
          next.telegramBotUsername = null;
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
      if (input.ddns) {
        const next: Record<string, string | null> = {};
        if (input.ddns.enabled !== undefined) next.ddnsEnabled = input.ddns.enabled ? "true" : "false";
        if (input.ddns.provider !== undefined) next.ddnsProvider = input.ddns.provider;
        if (input.ddns.cloudflareZoneId !== undefined) next.ddnsCloudflareZoneId = input.ddns.cloudflareZoneId.trim() || null;
        if (input.ddns.clearCloudflareApiToken) next.ddnsCloudflareApiToken = null;
        if (input.ddns.cloudflareApiToken !== undefined && input.ddns.cloudflareApiToken.trim()) {
          next.ddnsCloudflareApiToken = input.ddns.cloudflareApiToken.trim();
        }
        if (input.ddns.webhookUrl !== undefined) next.ddnsWebhookUrl = input.ddns.webhookUrl.trim() || null;
        if (input.ddns.webhookMethod !== undefined) next.ddnsWebhookMethod = input.ddns.webhookMethod;
        if (input.ddns.webhookHeaders !== undefined) next.ddnsWebhookHeaders = input.ddns.webhookHeaders.trim() || null;
        await db.setSettings(next);
        console.info("[Settings] ddns settings updated");
      }
      return { success: true };
    }),

  updateWebPort: adminProcedure
    .input(z.object({ port: z.number().int().min(1).max(65535), confirmed: z.literal(true) }))
    .mutation(async ({ input }) => {
      if (!canManageWebPort()) {
        throw new Error("Docker 部署不支持在后台修改 Web 端口，请自行配置端口映射");
      }
      const port = normalizePort(input.port);
      const currentPort = normalizePort(ENV.port || 3000);
      if (port === currentPort) return { success: true, port, restartScheduled: false };
      if (!(await isTcpPortAvailable(port))) {
        throw new Error(`端口 ${port} 已被占用，请更换端口`);
      }
      await updateEnvFileValue(webPortConfigPath(), "PORT", String(port));
      await db.setSetting("webPort", String(port));
      console.info(`[Settings] web port updated ${currentPort} -> ${port}; scheduling service restart`);
      schedulePanelRestart();
      return { success: true, port, restartScheduled: true };
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
    const info = await getLatestUpdateInfoCached(force);
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

  /** 启动后台升级任务。实际命令由 FORWARDX_UPGRADE_COMMAND 提供。 */
  panelLogs: adminProcedure
    .input(z.object({ level: panelLogLevelSchema.default("all") }).optional())
    .query(({ input }) => {
      const level = input?.level || "all";
      return {
        logs: getFilteredPanelLogs(level),
        summary: getPanelLogSummary(),
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
  agentLogs: adminProcedure
    .input(z.object({
      hostId: z.number().nullable().optional(),
      level: panelLogLevelSchema.default("all"),
    }).optional())
    .query(({ input }) => ({
      logs: getAgentLogs({ hostId: input?.hostId, level: input?.level || "all" }),
      summary: getAgentLogSummary({ hostId: input?.hostId }),
      checkedAt: new Date().toISOString(),
    })),

  clearAgentLogs: adminProcedure
    .input(z.object({ hostId: z.number().nullable().optional() }).optional())
    .mutation(({ input }) => {
      clearAgentLogs(input?.hostId);
      console.info(`[AgentLogs] Cleared logs host=${input?.hostId || "all"}`);
      return { success: true };
    }),
  startUpgrade: adminProcedure
    .input(z.object({ targetVersion: z.string().min(1).max(64).optional() }).optional())
    .mutation(async ({ input }) => {
      const command = normalizeUpgradeCommand(ENV.upgradeCommand);
      if (!command) {
        console.warn("[Upgrade] Start requested but FORWARDX_UPGRADE_COMMAND is not configured");
        throw new Error("未配置 FORWARDX_UPGRADE_COMMAND，当前环境只能检查更新，不能自动升级");
      }
      if (upgradeJob.status === "running") {
        console.warn("[Upgrade] Start requested while another upgrade is running");
        throw new Error("已有升级任务正在执行");
      }

      let update = await fetchLatestUpdateInfo();
      if (update.error && lastUpdateInfo) {
        update = lastUpdateInfo;
      }
      lastUpdateInfo = update;
      const requestedVersion = input?.targetVersion;
      const targetVersion =
        update.latestVersion && (!requestedVersion || compareVersions(update.latestVersion, requestedVersion) >= 0)
          ? update.latestVersion
          : requestedVersion;
      if (!targetVersion) throw new Error("No upgrade target version found");
      if (compareVersions(targetVersion, APP_VERSION) <= 0) {
        throw new Error("Already on the latest version");
      }
      console.info(`[Upgrade] Starting panel upgrade current=v${APP_VERSION} target=${targetVersion}`);

      upgradeJob = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        targetVersion,
        logs: [
          `[ForwardX] Current version v${APP_VERSION}`,
          `[ForwardX] Selected latest upgrade target ${targetVersion}`,
          `[ForwardX] Starting upgrade to ${targetVersion}`,
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
          console.info(`[Upgrade] Panel upgrade command completed target=${targetVersion}`);
          appendUpgradeLog("[ForwardX] Upgrade command completed. The service may be restarting, refresh the page later.");
        } else {
          upgradeJob.status = "error";
          upgradeJob.error = `Upgrade command exited with code ${code}. Please run the one-click script manually.`;
          console.error(`[Upgrade] Panel upgrade failed target=${targetVersion} exitCode=${code}`);
          appendUpgradeLog(`[ForwardX] Upgrade failed, exit code: ${code}`);
          appendManualUpgradeHint();
        }
      });

      return { success: true, targetVersion };
    }),
});

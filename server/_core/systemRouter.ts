import { router, publicProcedure, adminProcedure } from "./trpc";
import { z } from "zod";
import * as db from "../db";
import { ENV } from "../env";
import { spawn } from "child_process";
import fs from "fs";
import { clearPanelLogs, getPanelLogs, getPanelLogSummary } from "./panelLogger";

/**
 * 系统级别 router：
 *   - health：健康检查
 *   - publicInfo：未登录可见的元信息（开源仓库地址、版本号）
 *   - settings：登录后只读访问/管理员可写的系统设置
 */

export const REPO_URL = "https://github.com/poouo/Forwardx";
/** Telegram 双向消息机器人：用户可通过此反馈问题、接收补充信息 */
export const TELEGRAM_BOT_URL = "https://t.me/miyin_private_bot";
export const APP_VERSION = "2.2.39";
export const AGENT_VERSION = "2.2.34";
const UPDATE_CHECK_COOLDOWN_MS = 60 * 1000;
const MANUAL_LOCAL_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade";
const MANUAL_DOCKER_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade";

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  source: "release" | "tag" | null;
  publishedAt: string | null;
  checkedAt: string;
  error?: string;
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

function githubApiBase(repoUrl: string) {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error("GitHub 仓库地址格式不正确");
  return `https://api.github.com/repos/${match[1]}/${match[2].replace(/\.git$/i, "")}`;
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": `ForwardX/${APP_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub API 请求失败：${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function fetchLatestUpdateInfo(): Promise<UpdateInfo> {
  const checkedAt = new Date().toISOString();
  const api = githubApiBase(REPO_URL);
  let releaseInfo: UpdateInfo | null = null;
  let releaseErrorMessage: string | null = null;

  try {
    const latest = await fetchGithubJson<{
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
      draft?: boolean;
    }>(`${api}/releases/latest`);
    const latestVersion = latest.tag_name || null;
    releaseInfo = {
      currentVersion: APP_VERSION,
      latestVersion,
      hasUpdate: !!latestVersion && compareVersions(latestVersion, APP_VERSION) > 0,
      releaseUrl: latest.html_url || `${REPO_URL}/releases/tag/${latestVersion}`,
      source: "release",
      publishedAt: latest.published_at || null,
      checkedAt,
    };
  } catch (releaseError: any) {
    releaseErrorMessage = releaseError?.message || null;
  }

  try {
    const tags = await fetchGithubJson<Array<{ name?: string; commit?: { sha?: string } }>>(`${api}/tags?per_page=50`);
    const versionTags = tags
      .map((t) => t.name)
      .filter((name): name is string => !!name && /^v?\d+\.\d+\.\d+/.test(name))
      .sort((a, b) => compareVersions(b, a));
    const tagVersion = versionTags[0] || null;
    if (tagVersion && (!releaseInfo?.latestVersion || compareVersions(tagVersion, releaseInfo.latestVersion) > 0)) {
      return {
        currentVersion: APP_VERSION,
        latestVersion: tagVersion,
        hasUpdate: compareVersions(tagVersion, APP_VERSION) > 0,
        releaseUrl: `${REPO_URL}/releases/tag/${tagVersion}`,
        source: "tag",
        publishedAt: null,
        checkedAt,
      };
    }
    if (releaseInfo) return releaseInfo;
  } catch (tagError: any) {
    if (releaseInfo) return releaseInfo;
    return {
      currentVersion: APP_VERSION,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: null,
      source: null,
      publishedAt: null,
      checkedAt,
      error: tagError?.message || releaseErrorMessage || "检查更新失败",
    };
  }

  return releaseInfo || {
    currentVersion: APP_VERSION,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: null,
    source: null,
    publishedAt: null,
    checkedAt,
    error: releaseErrorMessage || "检查更新失败",
  };
}

async function getLatestUpdateInfoCached(): Promise<UpdateInfo> {
  if (lastUpdateInfo) {
    const checkedAt = new Date(lastUpdateInfo.checkedAt).getTime();
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < UPDATE_CHECK_COOLDOWN_MS) {
      return lastUpdateInfo;
    }
  }
  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }
  updateCheckInFlight = fetchLatestUpdateInfo()
    .then((info) => {
      lastUpdateInfo = info;
      return info;
    })
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
export const systemRouter = router({
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  publicInfo: publicProcedure.query(() => {
    return {
      repoUrl: REPO_URL,
      telegramBotUrl: TELEGRAM_BOT_URL,
      version: APP_VERSION,
      agentVersion: AGENT_VERSION,
    };
  }),

  /** 获取系统设置（包含开源地址、版本、面板公开 URL 等元信息） */
  getSettings: publicProcedure.query(async () => {
    const all = await db.getAllSettings();
    return {
      repoUrl: REPO_URL,
      telegramBotUrl: TELEGRAM_BOT_URL,
      version: APP_VERSION,
      agentVersion: AGENT_VERSION,
      panelPublicUrl: all.panelPublicUrl ?? "",
      agentEncryption: "aes-256-ctr+hmac-sha256", // 加密方案标识
      upgrade: {
        enabled: !!ENV.upgradeCommand.trim(),
        docker: fs.existsSync("/.dockerenv") || fs.existsSync("/var/run/docker.sock"),
        dockerSocket: fs.existsSync("/var/run/docker.sock"),
        commandConfigured: !!ENV.upgradeCommand.trim(),
      },
    };
  }),

  /** 管理员更新系统设置 */
  updateSettings: adminProcedure
    .input(
      z.object({
        panelPublicUrl: z.string().max(256).optional(),
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
      return { success: true };
    }),

  /** 检查 GitHub 是否有新版本 */
  checkUpdate: adminProcedure.query(async () => {
    console.info("[Update] Checking latest version");
    const info = await getLatestUpdateInfoCached();
    if (info.error) {
      console.warn(`[Update] Check failed: ${info.error}`);
    } else {
      console.info(`[Update] Current v${APP_VERSION}, latest ${info.latestVersion || "unknown"}`);
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
      docker: fs.existsSync("/.dockerenv") || fs.existsSync("/var/run/docker.sock"),
      dockerSocket: fs.existsSync("/var/run/docker.sock"),
    };
  }),

  /** 启动后台升级任务。实际命令由 FORWARDX_UPGRADE_COMMAND 提供。 */
  panelLogs: adminProcedure
    .input(z.object({ level: z.enum(["all", "log", "info", "warn", "error"]).default("all") }).optional())
    .query(({ input }) => {
      const level = input?.level || "all";
      const logs = getPanelLogs();
      return {
        logs: level === "all" ? logs : logs.filter((entry) => entry.level === level),
        summary: getPanelLogSummary(),
        checkedAt: new Date().toISOString(),
      };
    }),

  clearPanelLogs: adminProcedure.mutation(() => {
    clearPanelLogs();
    console.info("[PanelLogs] Cleared panel logs");
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

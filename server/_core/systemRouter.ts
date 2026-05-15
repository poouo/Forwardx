import { router, publicProcedure, adminProcedure } from "./trpc";
import { z } from "zod";
import * as db from "../db";
import { ENV } from "../env";
import { spawn } from "child_process";
import fs from "fs";

/**
 * 系统级别 router：
 *   - health：健康检查
 *   - publicInfo：未登录可见的元信息（开源仓库地址、版本号）
 *   - settings：登录后只读访问/管理员可写的系统设置
 */

export const REPO_URL = "https://github.com/poouo/Forwardx";
/** Telegram 双向消息机器人：用户可通过此反馈问题、接收补充信息 */
export const TELEGRAM_BOT_URL = "https://t.me/miyin_private_bot";
export const APP_VERSION = "2.1.10";

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

  try {
    const latest = await fetchGithubJson<{
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
      draft?: boolean;
    }>(`${api}/releases/latest`);
    const latestVersion = latest.tag_name || null;
    return {
      currentVersion: APP_VERSION,
      latestVersion,
      hasUpdate: !!latestVersion && compareVersions(latestVersion, APP_VERSION) > 0,
      releaseUrl: latest.html_url || `${REPO_URL}/releases/tag/${latestVersion}`,
      source: "release",
      publishedAt: latest.published_at || null,
      checkedAt,
    };
  } catch (releaseError: any) {
    try {
      const tags = await fetchGithubJson<Array<{ name?: string; commit?: { sha?: string } }>>(`${api}/tags?per_page=20`);
      const versionTags = tags
        .map((t) => t.name)
        .filter((name): name is string => !!name && /^v?\d+\.\d+\.\d+/.test(name))
        .sort((a, b) => compareVersions(b, a));
      const latestVersion = versionTags[0] || null;
      return {
        currentVersion: APP_VERSION,
        latestVersion,
        hasUpdate: !!latestVersion && compareVersions(latestVersion, APP_VERSION) > 0,
        releaseUrl: latestVersion ? `${REPO_URL}/releases/tag/${latestVersion}` : REPO_URL,
        source: "tag",
        publishedAt: null,
        checkedAt,
      };
    } catch (tagError: any) {
      return {
        currentVersion: APP_VERSION,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        source: null,
        publishedAt: null,
        checkedAt,
        error: tagError?.message || releaseError?.message || "检查更新失败",
      };
    }
  }
}

function appendUpgradeLog(line: string) {
  const text = line.trimEnd();
  if (!text) return;
  upgradeJob.logs.push(text);
  if (upgradeJob.logs.length > 300) {
    upgradeJob.logs = upgradeJob.logs.slice(-300);
  }
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
    };
  }),

  /** 获取系统设置（包含开源地址、版本、面板公开 URL 等元信息） */
  getSettings: publicProcedure.query(async () => {
    const all = await db.getAllSettings();
    return {
      repoUrl: REPO_URL,
      telegramBotUrl: TELEGRAM_BOT_URL,
      version: APP_VERSION,
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
      }
      return { success: true };
    }),

  /** 检查 GitHub 是否有新版本 */
  checkUpdate: adminProcedure.query(async () => {
    lastUpdateInfo = await fetchLatestUpdateInfo();
    return lastUpdateInfo;
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
  startUpgrade: adminProcedure
    .input(z.object({ targetVersion: z.string().min(1).max(64).optional() }).optional())
    .mutation(async ({ input }) => {
      const command = ENV.upgradeCommand.trim();
      if (!command) {
        throw new Error("未配置 FORWARDX_UPGRADE_COMMAND，当前环境只能检查更新，不能自动升级");
      }
      if (upgradeJob.status === "running") {
        throw new Error("已有升级任务正在执行");
      }

      const update = lastUpdateInfo ?? await fetchLatestUpdateInfo();
      lastUpdateInfo = update;
      const targetVersion = input?.targetVersion || update.latestVersion;
      if (!targetVersion) throw new Error("未找到可升级的目标版本");

      upgradeJob = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        targetVersion,
        logs: [`[ForwardX] 开始升级到 ${targetVersion}`],
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
        upgradeJob.error = err.message;
        upgradeJob.finishedAt = new Date().toISOString();
        appendUpgradeLog(`[ForwardX] 升级命令启动失败：${err.message}`);
      });
      child.on("close", (code) => {
        upgradeJob.finishedAt = new Date().toISOString();
        if (code === 0) {
          upgradeJob.status = "success";
          appendUpgradeLog("[ForwardX] 升级命令已完成。如果运行在 Docker Compose 中，容器可能正在重建或重启。");
        } else {
          upgradeJob.status = "error";
          upgradeJob.error = `升级命令退出码：${code}`;
          appendUpgradeLog(`[ForwardX] 升级失败，退出码：${code}`);
        }
      });

      return { success: true, targetVersion };
    }),
});

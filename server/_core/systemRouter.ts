import { router, publicProcedure, adminProcedure } from "./trpc";
import { z } from "zod";
import * as db from "../db";

/**
 * 系统级别 router：
 *   - health：健康检查
 *   - publicInfo：未登录可见的元信息（开源仓库地址、版本号）
 *   - settings：登录后只读访问/管理员可写的系统设置
 */

export const REPO_URL = "https://github.com/poouo/Forwardx";
/** Telegram 双向消息机器人：用户可通过此反馈问题、接收补充信息 */
export const TELEGRAM_BOT_URL = "https://t.me/miyin_private_bot";
export const APP_VERSION = "2.1.4";

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
});

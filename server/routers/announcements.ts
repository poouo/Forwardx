import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { sendTelegramMessage } from "../telegramBot";
import { sanitizeHtml } from "../../shared/htmlSanitizer";
import { APP_VERSION } from "../../shared/versions";

const ANNOUNCEMENT_TYPES = ["normal", "popup", "upgrade_popup"] as const;

const announcementInput = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(60000),
  type: z.enum(ANNOUNCEMENT_TYPES).default("normal"),
  targetVersion: z.string().trim().max(64).optional().nullable(),
  telegramPush: z.boolean().optional().default(false),
});

function normalizeAnnouncementVersion(version: string | null | undefined) {
  return String(version || "").trim().replace(/^v/i, "");
}

function resolveUpgradeAnnouncementVersion(inputVersion: string | null | undefined) {
  const normalizedVersion = normalizeAnnouncementVersion(inputVersion);
  if (!normalizedVersion) throw new Error("升级公告需要填写目标版本");
  if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) throw new Error("升级公告版本格式不正确");
  return normalizedVersion;
}

function sanitizeAnnouncementContent(content: string) {
  return sanitizeHtml(content);
}

function escapeTelegramHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function announcementTelegramText(title: string, content: string) {
  const plain = String(content || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>~-]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = plain.length > 3200 ? `${plain.slice(0, 3200)}...` : plain;
  return [
    "<b>ForwardX 新公告</b>",
    "",
    `<b>${escapeTelegramHtml(title)}</b>`,
    "",
    escapeTelegramHtml(body || "请登录面板查看公告详情。"),
    "",
    "可在个人资料中关闭公告 Telegram 推送。",
  ].join("\n");
}

async function pushAnnouncementToTelegram(title: string, content: string) {
  const subscribers = await db.getTelegramAnnouncementSubscribers();
  if (subscribers.length === 0) return { requested: true, sent: 0, failed: 0, total: 0 };
  const text = announcementTelegramText(title, content);
  let sent = 0;
  let failed = 0;
  for (const user of subscribers as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Announcement] Telegram push failed user=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { requested: true, sent, failed, total: subscribers.length };
}

export const announcementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listUserAnnouncements({ includeUpgradePopups: ctx.user.role === "admin" });
  }),

  popup: protectedProcedure.query(async ({ ctx }) => {
    return db.getUnreadPopupAnnouncement(ctx.user.id);
  }),

  upgradePopup: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") return null;
    return db.getUnreadUpgradeAnnouncement(ctx.user.id, APP_VERSION);
  }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await db.dismissAnnouncement(ctx.user.id, input.id);
      return { success: true };
    }),

  create: adminProcedure
    .input(announcementInput)
    .mutation(async ({ input, ctx }) => {
      const content = sanitizeAnnouncementContent(input.content);
      const targetVersion = input.type === "upgrade_popup" ? resolveUpgradeAnnouncementVersion(input.targetVersion) : null;
      const result = await db.createAnnouncement({
        title: input.title,
        content,
        type: input.type,
        targetVersion,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        createdByUserId: ctx.user.id,
      } as any);
      appendPanelLog("info", `[Announcement] created type=${input.type} user=${ctx.user.id}`);
      const telegramPush = input.telegramPush
        ? await pushAnnouncementToTelegram(input.title, content)
        : { requested: false, sent: 0, failed: 0, total: 0 };
      if (input.telegramPush) appendPanelLog("info", `[Announcement] telegram push sent=${telegramPush.sent} failed=${telegramPush.failed} total=${telegramPush.total}`);
      return { list: result, telegramPush };
    }),

  update: adminProcedure
    .input(announcementInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const content = sanitizeAnnouncementContent(input.content);
      const targetVersion = input.type === "upgrade_popup" ? resolveUpgradeAnnouncementVersion(input.targetVersion) : null;
      const result = await db.updateAnnouncement(input.id, {
        title: input.title,
        content,
        type: input.type,
        targetVersion,
        isActive: true,
        startsAt: null,
        expiresAt: null,
      } as any);
      appendPanelLog("info", `[Announcement] updated id=${input.id}`);
      const telegramPush = input.telegramPush
        ? await pushAnnouncementToTelegram(input.title, content)
        : { requested: false, sent: 0, failed: 0, total: 0 };
      if (input.telegramPush) appendPanelLog("info", `[Announcement] telegram push id=${input.id} sent=${telegramPush.sent} failed=${telegramPush.failed} total=${telegramPush.total}`);
      return { announcement: result, telegramPush };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteAnnouncement(input.id);
      appendPanelLog("info", `[Announcement] deleted id=${input.id}`);
      return { success: true };
    }),
});

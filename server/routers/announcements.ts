import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { pushAnnouncement } from "../announcementPublishing";
import { sanitizeHtml } from "../../shared/htmlSanitizer";
import { APP_VERSION } from "../../shared/versions";
import { developerAnnouncementReadKey, developerAnnouncementReadKeySchema } from "../../shared/developerAnnouncements";
import { getUnreadDeveloperAnnouncement, dismissDeveloperAnnouncement } from "../developerAnnouncements";

const ANNOUNCEMENT_TYPES = ["normal", "popup", "upgrade_popup"] as const;

const announcementInput = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(60000),
  type: z.enum(ANNOUNCEMENT_TYPES).default("normal"),
  targetVersion: z.string().trim().max(64).optional().nullable(),
  publishAt: z.string().datetime({ offset: true })
    .transform((value) => new Date(value))
    .refine((value) => Number.isFinite(value.getTime()))
    .nullish(),
  telegramPush: z.boolean().optional(),
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

export const announcementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listUserAnnouncements(ctx.user.role === "admin");
  }),

  popup: protectedProcedure.query(async ({ ctx }) => {
    return (await db.getUnreadPopupAnnouncement(ctx.user.id)) ?? null;
  }),

  upgradePopup: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "admin") return null;
    const developer = await getUnreadDeveloperAnnouncement(ctx.user.id, APP_VERSION);
    if (developer) return {
      id: developerAnnouncementReadKey(developer), source: "developer" as const,
      title: developer.title["zh-CN"], englishTitle: developer.title.en,
      content: sanitizeAnnouncementContent(developer.content["zh-CN"]), englishContent: sanitizeAnnouncementContent(developer.content.en),
      targetVersion: developer.fixedVersion ?? null,
      releaseUrl: developer.fixedVersion ? `https://github.com/poouo/Forwardx/releases/tag/v${developer.fixedVersion}` : null,
    };
    const local = await db.getUnreadUpgradeAnnouncement(ctx.user.id, APP_VERSION);
    return local ? { ...local, source: "local" as const, englishTitle: null, englishContent: null, releaseUrl: null } : null;
  }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.union([z.number().int().positive(), developerAnnouncementReadKeySchema]) }))
    .mutation(async ({ input, ctx }) => {
      if (typeof input.id === "string") {
        if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
        await dismissDeveloperAnnouncement(ctx.user.id, input.id);
      } else await db.dismissAnnouncement(ctx.user.id, input.id);
      return { success: true };
    }),

  create: adminProcedure
    .input(announcementInput)
    .mutation(async ({ input, ctx }) => {
      const content = sanitizeAnnouncementContent(input.content);
      const targetVersion = input.type === "upgrade_popup" ? resolveUpgradeAnnouncementVersion(input.targetVersion) : null;
      const announcement = await db.createAnnouncement({
        title: input.title,
        content,
        type: input.type,
        targetVersion,
        scheduledAt: input.publishAt ?? null,
        pushOnPublish: Boolean(input.publishAt && input.telegramPush),
        createdByUserId: ctx.user.id,
      });
      appendPanelLog("info", `[Announcement] created id=${announcement.id} user=${ctx.user.id}`);
      const telegramPush = await pushAnnouncement(announcement, Boolean(announcement.publishedAt && input.telegramPush));
      return { announcement, telegramPush };
    }),

  update: adminProcedure
    .input(announcementInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const content = sanitizeAnnouncementContent(input.content);
      const targetVersion = input.type === "upgrade_popup" ? resolveUpgradeAnnouncementVersion(input.targetVersion) : null;
      const { announcement, shouldPush } = await db.updateAnnouncement(input.id, {
        title: input.title,
        content,
        type: input.type,
        targetVersion,
        scheduledAt: input.publishAt,
        pushOnPublish: input.telegramPush,
      });
      appendPanelLog("info", `[Announcement] updated id=${input.id}`);
      const telegramPush = await pushAnnouncement(announcement, shouldPush);
      return { announcement, telegramPush };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteAnnouncement(input.id);
      appendPanelLog("info", `[Announcement] deleted id=${input.id}`);
      return { success: true };
    }),
});

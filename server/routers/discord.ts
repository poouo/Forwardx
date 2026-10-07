import crypto from "node:crypto";
import { z } from "zod";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getUserById } from "../repositories/userRepository";
import { getDb } from "../dbRuntime";
import { users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getNotificationSettings } from "../notificationSettings";
import { createDiscordCode, consumeDiscordLoginCode, unbindDiscordAccount } from "../discordAccounts";
import { sendDiscordMessage, refreshDiscordBotProfile, discordConnectionStatus } from "../discordBot";
import { issueTelegramSession } from "./telegram";
import { authRateLimitState, recordTwoFactorFailure, clearAuthAccountFailures } from "../authRateLimit";

export const discordRouter = router({
  loginStatus: publicProcedure.query(async () => {
    const settings = await getNotificationSettings("discord");
    return { enabled: settings.active, botId: settings.botId };
  }),
  status: protectedProcedure.query(async ({ ctx }) => {
    const settings = await getNotificationSettings("discord");
    const user = await getUserById(ctx.user.id);
    const expiresAt = user?.discordBindCodeExpiresAt ? new Date(user.discordBindCodeExpiresAt) : null;
    return { selected: (await getNotificationSettings()).channel === "discord", enabled: settings.active, configured: settings.configured, botId: settings.botId, botUsername: settings.botUsername,
      ...discordConnectionStatus(), bound: !!user?.discordId, announcementSubscribed: !!user?.discordAnnouncementSubscribed,
      account: user?.discordId ? { id: user.discordId, username: user.discordUsername, linkedAt: user.discordLinkedAt } : null,
      pendingBind: !user?.discordId && expiresAt && expiresAt.getTime() > Date.now() ? { code: user.discordBindCode!, expiresAt } : null };
  }),
  createBindCode: protectedProcedure.mutation(async ({ ctx }) => {
    if (!(await getNotificationSettings("discord")).active) throw new Error("管理员尚未启用 Discord 通知渠道");
    const user = await getUserById(ctx.user.id);
    if (user?.discordId) throw new Error("请先解除当前 Discord 绑定");
    const code = `DC-${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 300_000);
    await createDiscordCode(ctx.user.id, code, expiresAt, "Bind");
    return { code, expiresAt };
  }),
  unbind: protectedProcedure.mutation(async ({ ctx }) => { await unbindDiscordAccount(ctx.user.id); return { success: true }; }),
  subscribe: protectedProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.update(users).set({ discordAnnouncementSubscribed: input.enabled }).where(eq(users.id, ctx.user.id));
    return { success: true };
  }),
  testSend: adminProcedure.mutation(async ({ ctx }) => {
    const user = await getUserById(ctx.user.id);
    if (!user?.discordId) throw new Error("当前管理员尚未绑定 Discord");
    await sendDiscordMessage(user.discordId, "ForwardX Discord 测试消息\n通知渠道连接正常。");
    return { success: true };
  }),
  refreshProfile: adminProcedure.mutation(() => refreshDiscordBotProfile()),
  login: publicProcedure.input(z.object({ code: z.string().regex(/^[A-Fa-f0-9]{32}$/), mobile: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    if (!(await getNotificationSettings("discord")).active) throw new Error("Discord 通知渠道未启用");
    const ip = String(ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown");
    if (authRateLimitState(ip, "discord-login").limited) throw new Error("操作过于频繁，请稍后重试");
    const user = await consumeDiscordLoginCode(input.code.toUpperCase());
    if (!user) { recordTwoFactorFailure(ip, "discord-login"); throw new Error("Discord 登录码无效或已过期"); }
    clearAuthAccountFailures(ip, "discord-login");
    return issueTelegramSession(ctx, user, input.mobile ? "mobile" : "browser", input.mobile);
  }),
});

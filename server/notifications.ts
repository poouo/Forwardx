import { and, eq, sql } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { getNotificationSettings, notificationChannel, notificationSettings } from "./notificationSettings";
import { getAllSettings } from "./repositories/settingsRepository";

export async function isNotificationReady() { return (await getNotificationSettings()).active; }
export function isNotificationReadyFromSettings(settings: Record<string, string | null>) { return notificationSettings(settings).active; }
export async function notificationRecipients(kind: "admin" | "announcement") {
  const settings = await getAllSettings();
  if (!notificationSettings(settings).active) return [];
  const channel = notificationChannel(settings);
  const db = await getDb();
  if (!db) return [];
  const identity = channel === "discord" ? users.discordId : users.telegramId;
  const subscribed = channel === "discord" ? users.discordAnnouncementSubscribed : users.telegramAnnouncementSubscribed;
  return db.select({ id: users.id, name: users.name, username: users.username, telegramId: users.telegramId, discordId: users.discordId,
    notificationId: identity }).from(users).where(and(eq(users.accountEnabled, true), sql`${identity} IS NOT NULL`,
    kind === "admin" ? eq(users.role, "admin") : eq(subscribed, true)));
}
export const getNotificationAdminRecipients = () => notificationRecipients("admin");
export const getNotificationAnnouncementSubscribers = () => notificationRecipients("announcement");
export function notificationRecipientId(user: any, channel: "telegram" | "discord") { return String(user?.[channel === "discord" ? "discordId" : "telegramId"] || ""); }
export async function sendUserNotification(user: any, text: string) {
  if (user?.accountEnabled === false) return;
  const settings = await getNotificationSettings();
  if (!settings.active) throw new Error("通知渠道未启用或未配置");
  const id = notificationRecipientId(user, settings.channel);
  if (!id) throw new Error(`用户尚未绑定 ${settings.channel === "discord" ? "Discord" : "Telegram"}`);
  if (settings.channel === "discord") return (await import("./discordBot")).sendDiscordMessage(id, text);
  return (await import("./telegramBot")).sendTelegramMessage(id, text);
}

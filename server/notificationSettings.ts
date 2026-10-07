import { ENV } from "./env";
import { getAllSettings } from "./repositories/settingsRepository";

export type NotificationChannel = "telegram" | "discord";
export function notificationChannel(settings: Record<string, string | null | undefined>): NotificationChannel {
  return settings.notificationChannel === "discord" ? "discord" : "telegram";
}
export function notificationSettings(settings: Record<string, string | null | undefined>, channel = notificationChannel(settings)) {
  const envToken = channel === "telegram" ? ENV.telegramBotToken.trim() : String(process.env.DISCORD_BOT_TOKEN || "").trim();
  const dbToken = String(settings[`${channel}BotToken`] || "").trim();
  const token = envToken || dbToken;
  const enabled = settings[`${channel}BotEnabled`] === "true" || (!!envToken && settings[`${channel}BotEnabled`] !== "false");
  const threshold = Number(settings[`${channel}TrafficReminderThreshold`] || 20);
  return {
    channel, token, enabled, configured: !!token,
    active: notificationChannel(settings) === channel && enabled && !!token,
    botUsername: String(settings[`${channel}BotUsername`] || ""),
    botId: String(settings[`${channel}BotId`] || ""),
    tokenSource: envToken ? "env" as const : dbToken ? "database" as const : "none" as const,
    tokenMasked: token ? `${token.slice(0, 4)}${"*".repeat(12)}` : "",
    panelPublicUrl: String(settings.panelPublicUrl || "").trim().replace(/\/+$/, ""),
    expiryReminder: settings[`${channel}ExpiryReminder`] === "true",
    trafficReminder: settings[`${channel}TrafficReminder`] === "true",
    trafficReminderThreshold: Number.isFinite(threshold) ? Math.min(99, Math.max(1, threshold)) : 20,
    hostStatusNotify: settings[`${channel}HostStatusNotify`] === "true",
  };
}
export async function getNotificationSettings(channel?: NotificationChannel) {
  return notificationSettings(await getAllSettings(), channel);
}
export function publicNotificationSettings(settings: Record<string, string | null | undefined>, channel: NotificationChannel) {
  const { token: _token, ...safe } = notificationSettings(settings, channel);
  return safe;
}

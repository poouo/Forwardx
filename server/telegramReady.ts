import { ENV } from "./env";
import { getAllSettings } from "./repositories/settingsRepository";

export function isTelegramBotReadyFromSettings(settings: Record<string, string | null>) {
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

export async function isTelegramBotReady() {
  return isTelegramBotReadyFromSettings(await getAllSettings());
}

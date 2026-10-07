import { getAllSettings } from "./repositories/settingsRepository";
import { notificationSettings } from "./notificationSettings";

export function isTelegramBotReadyFromSettings(settings: Record<string, string | null>) {
  // Legacy resource flag names remain compatible; readiness follows the
  // selected notification provider, not a hard-coded Telegram transport.
  return notificationSettings(settings).active;
}

export async function isTelegramBotReady() {
  return isTelegramBotReadyFromSettings(await getAllSettings());
}

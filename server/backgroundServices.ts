import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegramBot";
import { startDiscordBot } from "./discordBot";
import { isDevPanelMode } from "./devPanel";
import { seamlessBackgroundPaused } from "./seamlessMigrationState";

let backgroundServicesStarted = false;

export function startBackgroundServices() {
  if (seamlessBackgroundPaused()) return false;
  if (backgroundServicesStarted) return false;
  if (isDevPanelMode()) {
    backgroundServicesStarted = true;
    console.info("[DevPanel] Background scheduler and Telegram bot are disabled in local development panel mode");
    return true;
  }
  backgroundServicesStarted = true;
  startScheduler();
  startTelegramBot().catch((error) => {
    console.warn(`[Telegram] Failed to start bot: ${error instanceof Error ? error.message : String(error)}`);
  });
  startDiscordBot().catch((error) => console.warn(`[Discord] Failed to start bot: ${error instanceof Error ? error.message : "unknown error"}`));
  return true;
}

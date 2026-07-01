import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegramBot";
import { isDevPanelMode } from "./devPanel";

let backgroundServicesStarted = false;

export function startBackgroundServices() {
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
  return true;
}

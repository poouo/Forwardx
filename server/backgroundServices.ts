import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegramBot";

let backgroundServicesStarted = false;

export function startBackgroundServices() {
  if (backgroundServicesStarted) return false;
  backgroundServicesStarted = true;
  startScheduler();
  startTelegramBot().catch((error) => {
    console.warn(`[Telegram] Failed to start bot: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

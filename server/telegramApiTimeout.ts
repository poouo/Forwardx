export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
export const TELEGRAM_API_LONG_POLL_TIMEOUT_MS = 40_000;

export class TelegramApiTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Telegram API ${method} timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    this.name = "TelegramApiTimeoutError";
  }
}

export function telegramApiTimeoutMs(method: string) {
  return method === "getUpdates"
    ? TELEGRAM_API_LONG_POLL_TIMEOUT_MS
    : TELEGRAM_API_REQUEST_TIMEOUT_MS;
}

export async function withTelegramApiTimeout<T>(
  method: string,
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = telegramApiTimeoutMs(method),
) {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, boundedTimeoutMs);

  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) throw new TelegramApiTimeoutError(method, boundedTimeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

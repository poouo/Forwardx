const DEFAULT_WIDGET_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WIDGET_REPLAY_ENTRIES = 10_000;

const consumedWidgetLogins = new Map<string, number>();

function normalizeReplayKey(value: string) {
  return String(value || "").trim().toLowerCase();
}

function pruneConsumedWidgetLogins(now = Date.now()) {
  for (const [key, expiresAt] of consumedWidgetLogins.entries()) {
    if (!expiresAt || expiresAt <= now) consumedWidgetLogins.delete(key);
  }
  if (consumedWidgetLogins.size <= MAX_WIDGET_REPLAY_ENTRIES) return;
  const staleCount = consumedWidgetLogins.size - MAX_WIDGET_REPLAY_ENTRIES;
  let removed = 0;
  for (const key of consumedWidgetLogins.keys()) {
    consumedWidgetLogins.delete(key);
    removed += 1;
    if (removed >= staleCount) break;
  }
}

/** Atomically consume a Telegram Login Widget proof for the replay window. */
export function consumeTelegramWidgetLoginOnce(
  replayKey: string,
  ttlMs = DEFAULT_WIDGET_REPLAY_TTL_MS,
) {
  const normalized = normalizeReplayKey(replayKey);
  if (!normalized) return false;
  const now = Date.now();
  pruneConsumedWidgetLogins(now);
  if (consumedWidgetLogins.has(normalized)) return false;
  const boundedTtl = Math.max(1_000, Math.min(DEFAULT_WIDGET_REPLAY_TTL_MS, Number(ttlMs) || DEFAULT_WIDGET_REPLAY_TTL_MS));
  consumedWidgetLogins.set(normalized, now + boundedTtl);
  return true;
}

/** Test-only reset hook. */
export function clearTelegramWidgetLoginReplayForTests() {
  consumedWidgetLogins.clear();
}


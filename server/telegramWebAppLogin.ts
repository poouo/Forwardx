type TelegramWebAppLoginChallenge = {
  expiresAt: number;
  expectedTelegramId: string | null;
};

export type TelegramWebAppChallengeConsumeResult = "ok" | "invalid" | "expired" | "mismatch";

const DEFAULT_WEBAPP_CHALLENGE_TTL_MS = 3 * 60 * 1000;
const MAX_WEBAPP_CHALLENGE_CACHE_SIZE = 10_000;
const challenges = new Map<string, TelegramWebAppLoginChallenge>();

function normalizeToken(value: string) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTelegramId(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return /^\d{3,32}$/.test(normalized) ? normalized : "";
}

function isValidToken(value: string) {
  return /^[a-f0-9]{32,128}$/.test(value);
}

function randomToken() {
  return `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

function pruneExpiredChallenges(now = Date.now()) {
  for (const [token, challenge] of challenges) {
    if (!challenge || challenge.expiresAt <= now) {
      challenges.delete(token);
    }
  }
  if (challenges.size <= MAX_WEBAPP_CHALLENGE_CACHE_SIZE) return;
  const staleCount = challenges.size - MAX_WEBAPP_CHALLENGE_CACHE_SIZE;
  let removed = 0;
  for (const token of challenges.keys()) {
    challenges.delete(token);
    removed += 1;
    if (removed >= staleCount) break;
  }
}

export function createTelegramWebAppLoginChallenge(options: { telegramId?: string | number | null; ttlMs?: number } = {}) {
  pruneExpiredChallenges();
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(30_000, Number(options.ttlMs)) : DEFAULT_WEBAPP_CHALLENGE_TTL_MS;
  const expectedTelegramId = normalizeTelegramId(options.telegramId ?? null) || null;
  let token = randomToken();
  while (challenges.has(token)) token = randomToken();
  challenges.set(token, {
    expiresAt: Date.now() + ttlMs,
    expectedTelegramId,
  });
  return token;
}

export function consumeTelegramWebAppLoginChallenge(tokenRaw: string, telegramIdRaw: string | number | null | undefined): TelegramWebAppChallengeConsumeResult {
  const token = normalizeToken(tokenRaw);
  const telegramId = normalizeTelegramId(telegramIdRaw);
  if (!token || !isValidToken(token) || !telegramId) return "invalid";
  pruneExpiredChallenges();
  const challenge = challenges.get(token);
  if (!challenge) return "invalid";
  if (challenge.expiresAt <= Date.now()) {
    challenges.delete(token);
    return "expired";
  }
  if (challenge.expectedTelegramId && challenge.expectedTelegramId !== telegramId) {
    return "mismatch";
  }
  challenges.delete(token);
  return "ok";
}

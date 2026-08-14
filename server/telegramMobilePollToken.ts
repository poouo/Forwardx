import { createHmac, timingSafeEqual } from "crypto";
import { ENV } from "./env";

const MOBILE_POLL_TOKEN_PREFIX = "telegram-mobile:";

/**
 * Derive a poll token from the mobile login code without putting the token in
 * the Telegram deep link. Possession of the deep-link code alone is therefore
 * insufficient to poll the panel for a session.
 */
export function createTelegramMobilePollToken(code: string) {
  const normalized = String(code || "").trim().toUpperCase();
  return createHmac("sha256", ENV.cookieSecret)
    .update(MOBILE_POLL_TOKEN_PREFIX)
    .update(normalized)
    .digest("base64url");
}

export function verifyTelegramMobilePollToken(code: string, token: string) {
  const expected = createTelegramMobilePollToken(code);
  const actualText = String(token || "").trim();
  if (!actualText || actualText.length !== expected.length) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actualText, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

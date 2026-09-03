import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_API_LONG_POLL_TIMEOUT_MS,
  TELEGRAM_API_REQUEST_TIMEOUT_MS,
  TelegramApiTimeoutError,
  telegramApiTimeoutMs,
  withTelegramApiTimeout,
} from "./telegramApiTimeout";

test("Telegram long polling keeps a longer client deadline than regular API calls", () => {
  assert.equal(telegramApiTimeoutMs("sendMessage"), TELEGRAM_API_REQUEST_TIMEOUT_MS);
  assert.equal(telegramApiTimeoutMs("getUpdates"), TELEGRAM_API_LONG_POLL_TIMEOUT_MS);
  assert.ok(TELEGRAM_API_LONG_POLL_TIMEOUT_MS > 25_000);
  assert.ok(TELEGRAM_API_LONG_POLL_TIMEOUT_MS > TELEGRAM_API_REQUEST_TIMEOUT_MS);
});

test("Telegram API timeout aborts the request and reports a distinct error", async () => {
  let aborted = false;
  await assert.rejects(
    withTelegramApiTimeout("sendMessage", (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }), 10),
    (error: unknown) => error instanceof TelegramApiTimeoutError
      && /sendMessage/.test(error.message),
  );
  assert.equal(aborted, true);
});

test("Telegram API timeout preserves errors raised before the deadline", async () => {
  const expected = new Error("network unavailable");
  await assert.rejects(
    withTelegramApiTimeout("sendMessage", async () => {
      throw expected;
    }, 100),
    (error: unknown) => error === expected,
  );
});

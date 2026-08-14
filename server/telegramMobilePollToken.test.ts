import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramMobilePollToken, verifyTelegramMobilePollToken } from "./telegramMobilePollToken";

test("Telegram mobile poll token is bound to the login code", () => {
  const code = "APPABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const token = createTelegramMobilePollToken(code);

  assert.equal(token.length, 43);
  assert.equal(verifyTelegramMobilePollToken(code, token), true);
  assert.equal(verifyTelegramMobilePollToken(code.toLowerCase(), token), true);
  assert.equal(verifyTelegramMobilePollToken(`${code}X`, token), false);
  assert.equal(verifyTelegramMobilePollToken(code, `${token.slice(0, -1)}x`), false);
  assert.equal(verifyTelegramMobilePollToken(code, ""), false);
});

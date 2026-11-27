import assert from "node:assert/strict";
import test from "node:test";
import { getTelegramWebAppLaunchData } from "./telegramWebApp";

test("Telegram WebApp keeps the signed launch data intact when decoding the URL fragment", () => {
  const initData = new URLSearchParams({
    user: JSON.stringify({ id: 123456789, first_name: "张 + & ?" }),
    auth_date: "1795737600",
    hash: "a".repeat(64),
  }).toString();
  const launch = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: "9.6" });

  assert.equal(getTelegramWebAppLaunchData(`#${launch}`), initData);
  assert.equal(getTelegramWebAppLaunchData(`#anchor?${launch}`), initData);
  assert.equal(getTelegramWebAppLaunchData("#tgWebAppVersion=9.6&tgWebAppData="), "");
  assert.equal(getTelegramWebAppLaunchData("#tgWebAppDataUnsafe=user"), "");
  assert.equal(getTelegramWebAppLaunchData("#anchor"), "");
});

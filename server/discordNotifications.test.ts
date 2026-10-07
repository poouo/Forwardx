import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { notificationChannel, notificationSettings, publicNotificationSettings } from "./notificationSettings";
import { discordComponents, discordText, admitDiscordEvent } from "./discordBot";
import { validateDiscordBotToken } from "./discordCredentials";
import { stripSessionSensitiveFields } from "./session";
import { isDiscordSnowflake } from "./discordIdentity";

test("Discord IDs retain precision and accept early accounts within the uint64 range", () => {
  for (const id of ["1000000000000000", "123456789012345678", "18446744073709551615"]) assert.equal(isDiscordSnowflake(id), true);
  for (const id of ["0", "0123", "18446744073709551616", "user", 123456789012345678]) assert.equal(isDiscordSnowflake(id), false);
});

test("notification default, mutual exclusion and secret redaction", () => {
  assert.equal(notificationChannel({}), "telegram");
  const settings = { telegramBotEnabled: "true", telegramBotToken: "tg-secret", discordBotEnabled: "true", discordBotToken: "dc-secret" };
  assert.equal(notificationSettings(settings, "telegram").active, true);
  assert.equal(notificationSettings(settings, "discord").active, false);
  const switched = { ...settings, notificationChannel: "discord" };
  assert.equal(notificationSettings(switched, "telegram").active, false);
  assert.equal(notificationSettings(switched, "discord").active, true);
  assert.equal("token" in publicNotificationSettings(switched, "discord"), false);
  const user = stripSessionSensitiveFields({ id: 1, discordId: "123456789012345678", discordBindCode: "secret", discordLoginCode: "secret", telegramLoginCode: "secret", password: "secret" });
  assert.deepEqual(user, { id: 1, discordId: "123456789012345678" });
});

test("Discord rendering preserves user data and adapts safe buttons", () => {
  assert.equal(discordText("<b>Telegram TG</b> &lt;name&gt; &amp;"), "Telegram TG <name> &");
  const components = discordComponents({ inline_keyboard: [[{ text: "动作", callback_data: "fx:menu" }, { text: "网站", web_app: { url: "https://example.test" } }, { text: "无效", url: "javascript:alert(1)" }]] });
  assert.equal(components.length, 1);
  assert.equal(components[0].components.length, 2);
  assert.equal(components[0].components[1].style, 5);
  assert.throws(() => discordComponents({ inline_keyboard: [Array.from({ length: 26 }, (_, i) => ({ text: String(i), callback_data: `fx:${i}` }))] }), /25/);
});

test("Discord event admission deduplicates, limits actors and expires entries", () => {
  const now = Date.now();
  for (let i = 0; i < 30; i++) assert.equal(admitDiscordEvent(`test-${i}`, "actor-a", now), true);
  assert.equal(admitDiscordEvent("test-0", "actor-b", now), false);
  assert.equal(admitDiscordEvent("test-extra", "actor-a", now), false);
  assert.equal(admitDiscordEvent("test-extra", "actor-a", now + 61_000), true);
  assert.equal(admitDiscordEvent("test-0", "actor-b", now + 301_000), true);
});

test("Discord credentials validate bot identities without disclosing tokens", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, options) => {
      assert.equal((options?.headers as any).Authorization, "Bot credential-secret");
      assert.ok(options?.signal);
      return Response.json({ bot: true, id: "123456789012345678", username: "test" });
    }) as typeof fetch;
    assert.deepEqual(await validateDiscordBotToken("credential-secret"), { id: "123456789012345678", username: "test" });
    globalThis.fetch = (async () => Response.json({ bot: false, id: "123456789012345678" })) as typeof fetch;
    await assert.rejects(validateDiscordBotToken("credential-secret"), /Bot Token/);
    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as typeof fetch;
    await assert.rejects(validateDiscordBotToken("credential-secret"), /401/);
  } finally { globalThis.fetch = original; }
});

test("Discord real SQLite bindings, shared commands, notifications and single-use login are isolated from TG", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-discord-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/discordNotifications.fixture.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "discord.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "", JWT_SECRET: "discord-test-secret-32-characters-only" },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

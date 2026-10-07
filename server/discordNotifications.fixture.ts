import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { setSettings, getAllSettings } from "./repositories/settingsRepository";
import { getUserById } from "./repositories/userRepository";
import { bindDiscordAccount, consumeDiscordLoginCode, createDiscordCode, getDiscordUser, unbindDiscordAccount } from "./discordAccounts";
import { processDiscordBotUpdate } from "./telegramBot";
import { handleDiscordGatewayDispatch, discordBotApi, discordRequest, stopDiscordBot, startDiscordBot, discordConnectionStatus } from "./discordBot";
import { notificationRecipients, sendUserNotification } from "./notifications";
import { systemRouter } from "./_core/systemRouter";
import { discordRouter } from "./routers/discord";

async function run() {
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  // Exercise an existing database upgrade, not only a clean schema creation.
  await runtime.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL)');
  await ensureDatabaseSchema();
  const insert = (columns: string[], values: unknown[]) => runtime.executeRaw(`INSERT INTO users (${columns.map((key) => '"' + key + '"').join(",")}) VALUES (${values.map(() => "?").join(",")})`, values);
  for (const [id, role] of [[1, "admin"], [2, "user"], [3, "admin"]] as const) {
    await insert(["id", "username", "password", "name", "role", "accountEnabled", "telegramId", "telegramLoginCode", "telegramAnnouncementSubscribed"], [id, `test-${id}`, "test-only-password", `TG name ${id}`, role, id === 3 ? 0 : 1, String(1000 + id), `TG-CODE-${id}`, 1]);
  }
  await setSettings({ notificationChannel: "discord", discordBotEnabled: "true", discordBotToken: "dc-test-token", discordBotId: "999999999999999999", panelPublicUrl: "https://panel.example.test", telegramBotEnabled: "true", telegramBotToken: "tg-test-token" });
  const actor = "123456789012345678";
  const admin = "123456789012345679";
  const chat = "234567890123456789";
  const expires = new Date(Date.now() + 300_000);
  await createDiscordCode(1, "DC-ADMIN", expires, "Bind");
  await bindDiscordAccount(1, { id: admin, username: "admin" }, "DC-ADMIN");
  await createDiscordCode(2, "DC-USER", expires, "Bind");
  const replies: { method: string; body: any }[] = [];
  const api = async (method: string, body?: Record<string, unknown>) => {
    replies.push({ method, body }); return { message_id: "345678901234567890" };
  };
  const message = async (text: string, fromId = actor) => processDiscordBotUpdate({ update_id: 0, message: { message_id: "345678901234567891", chat: { id: chat, type: "private" }, from: { id: fromId, username: "test" }, text } }, api);
  await message("/bind DC-USER");
  const bound = await getDiscordUser("discordId", actor);
  assert.equal(bound?.id, 2);
  assert.equal(bound?.telegramId, "1002");
  assert.equal(bound?.telegramLoginCode, "TG-CODE-2");
  assert.equal(bound?.discordBindCode, null);
  await assert.rejects(bindDiscordAccount(2, { id: actor }, "DC-USER"), /绑定码/);
  await createDiscordCode(1, "DC-CONFLICT", expires, "Bind");
  await assert.rejects(bindDiscordAccount(1, { id: actor }, "DC-CONFLICT"), /已绑定/);
  await createDiscordCode(3, "DC-DISABLED", expires, "Bind");
  await assert.rejects(bindDiscordAccount(3, { id: "123456789012345680" }, "DC-DISABLED"), /绑定码/);
  for (const command of ["/menu", "/usage", "/rules", "/login", "/webapp"]) await message(command);
  assert.ok(replies.some((item) => String(item.body?.text).includes("/login?discord=")));
  assert.equal((await getUserById(2))?.telegramLoginCode, "TG-CODE-2");
  const beforeAdminCommand = replies.length;
  await message("/users");
  assert.equal(replies.length, beforeAdminCommand + 1);
  assert.ok(!String(replies.at(-1)?.body.text).includes("test-1"), "non-admin cannot enumerate users");
  await message("/users", admin);
  assert.ok(String(replies.at(-1)?.body.text).includes("TG name 1"));
  await processDiscordBotUpdate({ update_id: 0, callback_query: { id: "callback", from: { id: actor }, message: { message_id: "345678901234567890", chat: { id: chat, type: "private" } }, data: "fx:app-login:APPABCDEFGHIJKLMNOPQRST" } }, api);
  assert.equal((await getUserById(2))?.telegramLoginCode, "TG-CODE-2");
  let code = (await getUserById(2))?.discordLoginCode!;
  const consumed = await Promise.all([consumeDiscordLoginCode(code), consumeDiscordLoginCode(code)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  await createDiscordCode(2, "EXPIRED", new Date(Date.now() - 1), "Login");
  assert.equal(await consumeDiscordLoginCode("EXPIRED"), null);
  await runtime.executeRaw('UPDATE users SET "discordAnnouncementSubscribed" = 1 WHERE id = 2');
  assert.deepEqual((await notificationRecipients("admin")).map((item: any) => item.notificationId), [admin]);
  assert.deepEqual((await notificationRecipients("announcement")).map((item: any) => item.notificationId), [actor]);

  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: any }[] = [];
  let retry = true;
  globalThis.fetch = (async (url, options) => {
    const req = { url: String(url), method: options?.method || "GET", body: options?.body ? JSON.parse(String(options.body)) : null };
    requests.push(req);
    if (req.url.endsWith("/retry") && retry) { retry = false; return Response.json({ retry_after: 0.001 }, { status: 429 }); }
    return Response.json({ id: chat, bot: true, username: "test" });
  }) as typeof fetch;
  try {
    await sendUserNotification(bound, "<b>notice</b>");
    assert.ok(requests.every((item) => item.url.startsWith("https://discord.com/api/v10/")));
    const notice = requests.find((item) => item.url.endsWith("/messages"))!;
    assert.deepEqual(notice.body.allowed_mentions, { parse: [] });
    assert.equal(notice.body.content, "notice");
    const sent = await discordBotApi("sendMessage", { chat_id: chat, text: "x".repeat(4001), reply_markup: { inline_keyboard: [[{ text: "确认", callback_data: "fx:menu" }]] } });
    assert.equal(sent.message_ids.length, 3);
    const chunks = requests.filter((item) => item.url.endsWith("/messages")).slice(-3);
    assert.equal(chunks.map((item) => item.body.content).join(""), "x".repeat(4001));
    assert.ok(chunks.every((item) => item.body.content.length <= 1900));
    assert.equal(chunks[0].body.components.length, 0);
    assert.equal(chunks[2].body.components.length, 1);
    await discordRequest("/retry");
    assert.equal(requests.filter((item) => item.url.endsWith("/retry")).length, 2);
    const before = requests.length;
    await handleDiscordGatewayDispatch("MESSAGE_CREATE", { id: "111111111111111111", channel_id: chat, guild_id: "guild", author: { id: actor }, content: "/users" });
    await handleDiscordGatewayDispatch("MESSAGE_CREATE", { id: "111111111111111112", channel_id: chat, author: { id: actor, bot: true }, content: "/users" });
    await handleDiscordGatewayDispatch("INTERACTION_CREATE", { id: "111111111111111113", channel_id: chat, application_id: "wrong-bot", user: { id: actor } });
    assert.equal(requests.length, before);

    const originalSocket = globalThis.WebSocket;
    const sockets: FakeGateway[] = [];
    class FakeGateway extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      sent: any[] = [];
      constructor(public url: string) { super(); sockets.push(this); }
      send(value: string) { this.sent.push(JSON.parse(value)); }
      dispatch(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
      close() { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
    }
    globalThis.WebSocket = FakeGateway as any;
    try {
      await startDiscordBot();
      assert.equal(sockets.length, 1);
      assert.ok(sockets[0].url.startsWith("wss://gateway.discord.gg/"));
      sockets[0].dispatch({ op: 10, d: { heartbeat_interval: 10_000 } });
      assert.equal(sockets[0].sent[0].op, 2);
      assert.equal(sockets[0].sent[0].d.intents, 4096);
      sockets[0].dispatch({ op: 0, t: "READY", s: 1, d: { session_id: "test-session" } });
      assert.equal(discordConnectionStatus().connected, true);
      sockets[0].dispatch({ op: 1 });
      assert.deepEqual(sockets[0].sent.at(-1), { op: 1, d: 1 });
      await setSettings({ notificationChannel: "telegram" });
      await startDiscordBot();
      assert.equal(discordConnectionStatus().connected, false);
      assert.equal(sockets[0].readyState, 3);
      assert.equal(sockets.length, 1, "inactive provider cannot open another Gateway");
      await setSettings({ notificationChannel: "discord" });
    } finally { stopDiscordBot(); globalThis.WebSocket = originalSocket; }

    // Validation failure must preserve the previous working settings.
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const caller = systemRouter.createCaller({ user: { id: 1, role: "admin" } as any, req: { headers: {} } as any, res: {} as any, authSession: null, authFailureReason: null });
    await assert.rejects(caller.updateSettings({ discord: { enabled: true, botToken: "invalid-token" } }), /401/);
    assert.equal((await getAllSettings()).discordBotToken, "dc-test-token");
  } finally { globalThis.fetch = originalFetch; }

  await message("/login");
  code = (await getUserById(2))!.discordLoginCode!;
  const cookies: unknown[] = [];
  const login = discordRouter.createCaller({ user: null, req: { headers: {}, ip: "127.0.0.1", protocol: "https", socket: {} } as any, res: { cookie: (...args: any[]) => cookies.push(args) } as any, authSession: null, authFailureReason: null });
  const result = await login.login({ code });
  assert.equal(result.id, 2);
  assert.equal(cookies.length, 1);
  assert.equal("discordLoginCode" in result, false);
  await assert.rejects(login.login({ code }), /无效/);
  await createDiscordCode(2, "UNUSED", expires, "Login");
  await unbindDiscordAccount(2);
  assert.equal(await consumeDiscordLoginCode("UNUSED"), null);
  assert.equal((await getUserById(2))?.telegramId, "1002");
  assert.equal((await getUserById(2))?.discordAnnouncementSubscribed, false);
  await setSettings({ notificationChannel: "telegram" });
  const count = replies.length;
  await message("/usage");
  assert.equal(replies.length, count, "inactive Discord must not process queued commands");
  assert.deepEqual((await notificationRecipients("admin")).map((item: any) => item.notificationId), ["1001"]);
  await assert.rejects(discordRequest("/users/@me"), /未启用/);
}

run().finally(async () => { stopDiscordBot(); await runtime.closeDatabase(); }).catch((error) => { console.error(error); process.exitCode = 1; });

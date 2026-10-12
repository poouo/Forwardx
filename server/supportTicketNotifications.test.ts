import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ticket-notifications-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "notifications.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.DISCORD_BOT_TOKEN = "";
let runtime: typeof import("./dbRuntime");
let settings: typeof import("./repositories/settingsRepository");
let users: typeof import("./repositories/userRepository");
let auth: typeof import("./routers/auth").authRouter;
let system: typeof import("./_core/systemRouter").systemRouter;
let support: typeof import("./repositories/supportTicketRepository");
let notify: typeof import("./supportTicketNotifications").notifySupportTicket;
const context = (user: any) => ({ user, req: { headers: {}, socket: {} }, res: { clearCookie() {} }, authSession: null, authFailureReason: null }) as any;
const admin = { id: 1, role: "admin", username: "staff" };
const customer = { id: 2, role: "user", username: "customer" };

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0, "lastSignedIn" INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO users (id, username, password) VALUES (1, 'staff', 'unused')");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  settings = await import("./repositories/settingsRepository");
  users = await import("./repositories/userRepository");
  auth = (await import("./routers/auth")).authRouter;
  system = (await import("./_core/systemRouter")).systemRouter;
  support = await import("./repositories/supportTicketRepository");
  notify = (await import("./supportTicketNotifications")).notifySupportTicket;
  await runtime.executeRaw('UPDATE users SET role = ?, "telegramId" = ?, "discordId" = ? WHERE id = 1', ["admin", "1001", "123456789012345671"]);
  for (const [id, role] of [[2, "user"], [3, "admin"], [4, "admin"], [5, "admin"]]) {
    await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "unused", role,
      accountEnabled: id !== 4, telegramId: String(1000 + Number(id)),
      discordId: id === 5 ? null : `12345678901234567${id}`,
      supportTicketNotificationSubscribed: id !== 3 });
  }
  await settings.setSettings({ sidebarMenu: JSON.stringify({ tickets: true }), notificationChannel: "telegram",
    telegramBotEnabled: "true", telegramBotToken: "test-tg-token", discordBotEnabled: "true", discordBotToken: "test-dc-token" });
});

after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("upgrade defaults are enabled; only admins can change the master switch and users edit only themselves", async () => {
  assert.equal((await users.getUserById(1))?.supportTicketNotificationSubscribed, true);
  const staff = system.createCaller(context(admin));
  const own = auth.createCaller(context(customer));
  assert.equal((await staff.getSettings()).supportTicketNotificationsEnabled, true);
  const initial = await own.notificationPreferences();
  assert.equal(initial.supportTicketNotificationSubscribed, true);
  assert.equal(initial.supportTicketNotificationsEnabled, true);
  assert.equal(initial.channel, "telegram");
  assert.equal("token" in initial, false);
  await assert.rejects(auth.createCaller(context(null)).notificationPreferences(), { code: "UNAUTHORIZED" });
  await assert.rejects(system.createCaller(context(customer)).updateSettings({ supportTicketNotificationsEnabled: false }), { code: "FORBIDDEN" });
  await staff.updateSettings({ supportTicketNotificationsEnabled: false });
  await own.updateProfile({ supportTicketNotificationSubscribed: false, userId: 1 } as any);
  assert.equal((await users.getUserById(1))?.supportTicketNotificationSubscribed, true);
  assert.equal((await own.notificationPreferences()).supportTicketNotificationSubscribed, false);
  await own.updateProfile({ supportTicketNotificationSubscribed: true });
  assert.equal((await own.notificationPreferences()).supportTicketNotificationsEnabled, false);
  await staff.updateSettings({ supportTicketNotificationsEnabled: true });
  assert.equal((await own.notificationPreferences()).supportTicketNotificationSubscribed, true);
  await own.updateProfile({ telegramAnnouncementSubscribed: false, discordAnnouncementSubscribed: true });
  assert.equal((await own.notificationPreferences()).announcementSubscribed, false);
  await settings.setSetting("notificationChannel", "discord");
  assert.equal((await own.notificationPreferences()).announcementSubscribed, true);
});

test("both channels enforce master and recipient preferences while preserving ticket operations", async () => {
  const requests: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    return Response.json({ ok: true, result: { message_id: 1 }, id: "234567890123456789" });
  }) as typeof fetch;
  try {
    const ticket = await support.createSupportTicket(customer, { title: "A <private> issue", category: "technical", priority: "normal", content: "Help", attachments: [] });
    for (const channel of ["telegram", "discord"] as const) {
      await settings.setSettings({ notificationChannel: channel, supportTicketNotificationsEnabled: "true" });
      requests.length = 0;
      await notify(customer, ticket.id, true);
      if (channel === "telegram") {
        assert.deepEqual(requests.map((r) => r.body.chat_id).sort(), ["1001", "1005"]);
        assert.ok(requests[0].body.text.includes("A &lt;private&gt; issue"));
      } else {
        assert.equal(requests.length, 2, "one DM and one message, not TG-only, opted-out or disabled admins");
        assert.equal(requests[0].body.recipient_id, "123456789012345671");
        assert.ok(requests.every((r) => r.url.startsWith("https://discord.com/")));
      }
      requests.length = 0;
      await users.updateUserProfile(1, { supportTicketNotificationSubscribed: false });
      if (channel === "telegram") await users.updateUserProfile(5, { supportTicketNotificationSubscribed: false });
      await notify(customer, ticket.id, true);
      assert.equal(requests.length, 0);
      await users.updateUserProfile(1, { supportTicketNotificationSubscribed: true });
      await users.updateUserProfile(5, { supportTicketNotificationSubscribed: true });
      await notify(admin, ticket.id);
      assert.ok(requests.length > 0, "admin reply notifies the customer");
      requests.length = 0;
      await users.updateUserProfile(2, { supportTicketNotificationSubscribed: false });
      await notify(admin, ticket.id);
      assert.equal(requests.length, 0);
      await users.updateUserProfile(2, { supportTicketNotificationSubscribed: true });
      await settings.setSetting("supportTicketNotificationsEnabled", "false");
      await notify(customer, ticket.id, true);
      await notify(admin, ticket.id);
      assert.equal(requests.length, 0, "master switch suppresses both directions");
      const { sendUserNotification } = await import("./notifications");
      await sendUserNotification(await users.getUserById(2), "Unrelated notification");
      assert.ok(requests.length > 0, "ticket master switch must not disable other notification types");
      requests.length = 0;
      assert.ok(await support.getSupportTicket(customer, ticket.id));
      assert.equal((await users.getUserById(2))?.supportTicketNotificationSubscribed, true);
    }
    const current = await support.getSupportTicket(customer, ticket.id);
    // Advance only this fixture's reply timestamp past the normal anti-spam window.
    await runtime.executeRaw('UPDATE support_ticket_messages SET "createdAt" = 1 WHERE "ticketId" = ?', [ticket.id]);
    await support.replySupportTicket(customer, { id: ticket.id, version: current.version, content: "Still usable", attachments: [], internal: false });
    await settings.setSetting("supportTicketNotificationsEnabled", "true");
    requests.length = 0;
    const noteVersion = (await support.getSupportTicket(admin, ticket.id)).version;
    const supportRouter = (await import("./routers/supportTickets")).supportTicketsRouter;
    await supportRouter.createCaller(context(admin)).reply({ id: ticket.id, version: noteVersion, content: "Staff only", internal: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, "internal notes never notify anyone");
    // No bot/channel means no network work even if both preferences are enabled.
    await settings.setSettings({ supportTicketNotificationsEnabled: "true", discordBotEnabled: "false" });
    requests.length = 0;
    await notify(customer, ticket.id, true);
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

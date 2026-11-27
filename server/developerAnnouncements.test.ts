import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEVELOPER_ANNOUNCEMENT_INTERVAL_MS as INTERVAL, developerAnnouncementFeedSchema, developerAnnouncementReadKey,
  eligibleDeveloperAnnouncements, type DeveloperAnnouncement } from "../shared/developerAnnouncements";

// Never use the developer's database or perform real GitHub requests.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-developer-announcements-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "panel.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.JWT_SECRET = "developer-announcements-isolated-test-secret";
const { createDeveloperAnnouncementCache, readDeveloperAnnouncementFeed, getUnreadDeveloperAnnouncement, DEVELOPER_ANNOUNCEMENT_URL } = await import("./developerAnnouncements");
const runtime = await import("./dbRuntime");
before(async () => {
  await runtime.connectDatabase();
  await (await import("./dbSchema")).ensureDatabaseSchema();
});
after(async () => { await runtime.closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }); });
const sample = (values: Partial<DeveloperAnnouncement> = {}): DeveloperAnnouncement => ({
  id: "network-fix", revision: 1, publishedAt: "2026-10-01T00:00:00Z",
  title: { "zh-CN": "更新提醒", en: "Update notice" }, content: { "zh-CN": "请检查新版修复。", en: "Please check the latest fixes." }, ...values,
});
const response = (announcements = [sample()]) => Response.json({ version: 1, announcements });

test("feed version targeting works before upgrading, across versions and by notice revision", () => {
  const now = Date.parse("2026-10-28T00:00:00Z");
  const item = sample({ minVersion: "2.3.280", maxVersion: "2.3.299", fixedVersion: "2.3.294" });
  for (const installed of ["2.3.280", "2.3.292", "2.3.293", "v2.3.293"]) assert.equal(eligibleDeveloperAnnouncements([item], installed, now).length, 1);
  for (const installed of ["2.3.279", "2.3.294", "2.3.300", "broken"]) assert.equal(eligibleDeveloperAnnouncements([item], installed, now).length, 0);
  assert.equal(eligibleDeveloperAnnouncements([sample()], "9.0.0", now).length, 1, "general notices also reach newer versions");
  assert.equal(eligibleDeveloperAnnouncements([sample({ publishedAt: "2027-01-01T00:00:00Z" }), sample({ expiresAt: "2026-10-27T00:00:00Z" })], "2.3.292", now).length, 0);
  assert.notEqual(developerAnnouncementReadKey(item), developerAnnouncementReadKey({ ...item, revision: 2 }));
  assert.deepEqual(eligibleDeveloperAnnouncements([sample({ id: "old" }), sample({ id: "new", publishedAt: "2026-10-02T00:00:00Z" })], "2.3.292", now).map(row => row.id), ["new", "old"]);
});

test("repository feed and schema are bounded, bilingual and reject ambiguous entries", () => {
  assert.equal(developerAnnouncementFeedSchema.safeParse(JSON.parse(fs.readFileSync("announcements/developer.json", "utf8"))).success, true);
  for (const bad of [
    { version: 2, announcements: [] }, { version: 1, announcements: [sample(), sample()] },
    { version: 1, announcements: [sample({ revision: 0 })] }, { version: 1, announcements: [sample({ title: { "zh-CN": "中文" } as any })] },
    { version: 1, announcements: [sample({ minVersion: "3.0.0", maxVersion: "2.0.0" })] },
    { version: 1, announcements: [sample({ content: { "zh-CN": "x".repeat(12001), en: "text" } })] },
    { version: 1, announcements: [sample({ id: "../untrusted" })] },
    { version: 1, announcements: Array.from({ length: 101 }, (_, index) => sample({ id: `n-${index}` })) },
  ]) assert.equal(developerAnnouncementFeedSchema.safeParse(bad).success, false);
});

test("30-minute shared refresh coalesces browsers and never returns mutable cache objects", async () => {
  let now = 1000, calls = 0;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const cache = createDeveloperAnnouncementCache({ now: () => now, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, DEVELOPER_ANNOUNCEMENT_URL);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    await gate; return response();
  } });
  const waiting = Array.from({ length: 30 }, () => cache.get());
  assert.equal(calls, 1); unblock();
  const results = await Promise.all(waiting);
  results[0][0].title.en = "modified";
  assert.equal(results[1][0].title.en, "Update notice");
  assert.equal((await cache.get())[0].title.en, "Update notice");
  now += INTERVAL - 1; await cache.get(); assert.equal(calls, 1);
  now++; await cache.get(); assert.equal(calls, 2);
});

test("elapsed time alone never fetches announcements; a later visit refreshes once", async () => {
  let now = 1000, calls = 0;
  const cache = createDeveloperAnnouncementCache({ now: () => now, fetcher: async () => { calls++; return response(); } });
  assert.equal(calls, 0, "starting the panel does not fetch GitHub");
  now += INTERVAL * 4;
  assert.equal(calls, 0, "no visits means no initial request");
  await cache.get(); assert.equal(calls, 1);
  now += INTERVAL - 1;
  await cache.get(); assert.equal(calls, 1);
  now += INTERVAL * 10;
  await Promise.resolve(); assert.equal(calls, 1, "idle panels do not refresh expired cache");
  await Promise.all(Array.from({ length: 20 }, () => cache.get()));
  assert.equal(calls, 2);
});

test("GitHub outages retain a bounded-age cache, back off and honor successful withdrawals", async () => {
  let now = 1000, fail = false, removed = false, calls = 0, warnings = 0;
  const cache = createDeveloperAnnouncementCache({ now: () => now, warn: () => warnings++, fetcher: async () => {
    calls++; if (fail) throw new Error("connection unavailable"); return response(removed ? [] : [sample()]);
  } });
  assert.equal((await cache.get()).length, 1);
  now += INTERVAL; fail = true;
  assert.equal((await cache.get()).length, 1);
  for (let i = 0; i < 20; i++) await cache.get();
  assert.equal(calls, 2); assert.equal(warnings, 1);
  now += 24 * 60 * 60_000; assert.deepEqual(await cache.get(), []);
  now += INTERVAL; fail = false; removed = true; assert.deepEqual(await cache.get(), []);
  assert.equal(warnings, 2);
});

test("proxy failure falls back to direct GitHub and invalid responses never poison valid cache", async () => {
  let now = 0, invalid = false;
  const urls: string[] = [];
  const cache = createDeveloperAnnouncementCache({ now: () => now, warn: () => {}, accelerator: async () => ({ enabled: true, url: "https://proxy.example" }),
    fetcher: async url => { urls.push(String(url)); if (String(url).startsWith("https://proxy.example")) return new Response("proxy down", { status: 502 });
      return invalid ? new Response("<html>bad gateway</html>") : response(); } });
  assert.equal((await cache.get()).length, 1);
  assert.deepEqual(urls, [`https://proxy.example/${DEVELOPER_ANNOUNCEMENT_URL}`, DEVELOPER_ANNOUNCEMENT_URL]);
  invalid = true; now += INTERVAL;
  assert.equal((await cache.get()).length, 1);
});

test("feed reads bound headers and streamed bodies and reject non-JSON/error payloads", async () => {
  for (const bad of [new Response("{}", { status: 404 }), new Response("{}", { headers: { "content-length": "131073" } }), new Response("x".repeat(131073)), new Response("<html>error</html>"), Response.json({ version: 9 })]) {
    await assert.rejects(readDeveloperAnnouncementFeed(bad));
  }
  assert.equal((await readDeveloperAnnouncementFeed(response())).length, 1);
});

test("existing popup route lazily reads remote notices, persists per-admin reads and keeps local popups compatible", async () => {
  const { announcementsRouter } = await import("./routers/announcements");
  const repository = await import("./repositories/announcementRepository");
  const settings = await import("./repositories/settingsRepository");
  const { APP_VERSION } = await import("../shared/versions");
  for (const id of [1, 2, 3]) await runtime.executeRaw('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)', [id, `announcer-${id}`, "unused", id === 3 ? "user" : "admin"]);
  const caller = (id: number | null) => announcementsRouter.createCaller({ user: id ? { id, role: id === 3 ? "user" : "admin" } : null, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  await repository.createAnnouncement({ title: "local", content: "local body", type: "upgrade_popup", targetVersion: APP_VERSION } as any);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response([sample({ fixedVersion: "3.0.0", content: { "zh-CN": "<script>alert(1)</script>请更新", en: '<img src=x onerror="alert(1)">Update' } })]); };
  try {
    await assert.rejects(caller(null).upgradePopup(), { code: "UNAUTHORIZED" });
    assert.equal(await caller(3).upgradePopup(), null); assert.equal(calls, 0);
    const first = await caller(1).upgradePopup();
    assert.equal(first?.source, "developer"); assert.equal(first?.id, "developer:network-fix:1");
    assert.equal(first?.releaseUrl, "https://github.com/poouo/Forwardx/releases/tag/v3.0.0");
    assert.doesNotMatch(first?.content || "", /<script/i); assert.doesNotMatch(first?.englishContent || "", /onerror/i);
    assert.ok(await getUnreadDeveloperAnnouncement(1, "2.3.291"));
    assert.equal(await getUnreadDeveloperAnnouncement(1, "3.0.0"), null);
    await assert.rejects(caller(3).dismiss({ id: first!.id }), { code: "FORBIDDEN" });
    await caller(1).dismiss({ id: first!.id });
    assert.equal(await getUnreadDeveloperAnnouncement(1, "2.3.291"), null);
    assert.equal((await caller(1).upgradePopup())?.source, "local");
    assert.equal((await caller(2).upgradePopup())?.source, "developer");
    assert.equal(calls, 1, "all versions/admins share the remote cache");
    const local = await caller(1).upgradePopup();
    await caller(1).dismiss({ id: local!.id });
    assert.equal(await caller(1).upgradePopup(), null);
    const markers = JSON.parse((await settings.getSetting("developer-announcements-read:1"))!);
    assert.deepEqual(markers, ["developer:network-fix:1"]);
    await caller(1).dismiss({ id: "developer:network-fix:2" });
    assert.equal(JSON.parse((await settings.getSetting("developer-announcements-read:1"))!).length, 2);
    await assert.rejects(caller(1).dismiss({ id: "../invalid" }), { code: "BAD_REQUEST" });
  } finally { globalThis.fetch = originalFetch; }
});

test("panel announcements publish immediately or on schedule and retain their publication time on edit", async (t) => {
  const { announcementsRouter } = await import("./routers/announcements");
  const { publishDueAnnouncements } = await import("./repositories/announcementRepository");
  const { runScheduledAnnouncementPublishing } = await import("./announcementPublishing");
  const request = { req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null };
  const admin = announcementsRouter.createCaller({ ...request, user: { id: 1, role: "admin" } } as any);
  const user = announcementsRouter.createCaller({ ...request, user: { id: 3, role: "user" } } as any);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  t.mock.timers.enable({ apis: ["Date"], now });
  const inOneMinute = new Date(now.getTime() + 60_000);
  const inTwoMinutes = new Date(now.getTime() + 120_000);

  const legacy = await runtime.insertAndGetId("announcements", { title: "Legacy", content: "Legacy body", startsAt: inTwoMinutes, createdAt: now });
  assert.equal((await user.list()).find((item) => item.id === legacy)?.createdAt.getTime(), now.getTime());
  const { announcement: current } = await admin.create({ title: "Current popup", content: "Popup body", type: "popup" });
  assert.equal(current.publishedAt?.getTime(), now.getTime());
  const payload = { title: "Scheduled popup", content: "Scheduled body", type: "popup" as const, publishAt: inOneMinute.toISOString() };
  await assert.rejects(user.create(payload), { code: "FORBIDDEN" });
  await assert.rejects(admin.create({ ...payload, publishAt: "2030-01-01T09:00:00+99:00" }), { code: "BAD_REQUEST" });
  await assert.rejects(admin.create({ ...payload, publishAt: now.toISOString() }), /定时发布时间必须晚于当前时间/);
  const { announcement: scheduled, telegramPush } = await admin.create({ ...payload, telegramPush: true });
  const { announcement: later } = await admin.create({ ...payload, title: "Later popup", publishAt: inTwoMinutes.toISOString() });
  assert.ok(scheduled.pushOnPublish);
  assert.equal(telegramPush.requested, false);
  assert.equal(scheduled.publishedAt, null);
  assert.equal((await user.popup())?.id, current.id);
  assert.ok((await admin.list()).some((item) => item.id === scheduled.id));
  assert.ok(!(await user.list()).some((item) => item.id === scheduled.id));
  await runScheduledAnnouncementPublishing();
  assert.equal((await user.popup())?.id, current.id);

  const { announcement: editedSchedule } = await admin.update({ ...payload, id: scheduled.id, title: "Edited schedule" });
  assert.ok(editedSchedule.pushOnPublish);
  assert.equal(editedSchedule.editedAt, null);

  await runtime.closeDatabase();
  t.mock.timers.setTime(inOneMinute.getTime() + 2_000);
  await runtime.connectDatabase();
  const sweeps = await Promise.all([publishDueAnnouncements(), publishDueAnnouncements()]);
  assert.deepEqual(sweeps.flat().map((item) => item.id), [scheduled.id]);
  assert.ok(sweeps.flat()[0].pushOnPublish);
  const publishedPopup = await user.popup();
  assert.equal(publishedPopup?.id, scheduled.id);
  assert.equal(publishedPopup?.publishedAt?.getTime(), Date.now());
  assert.ok(!publishedPopup?.pushOnPublish);
  assert.ok(!(await user.list()).some((item) => item.id === current.id || item.id === later.id));

  t.mock.timers.setTime(Date.now() + 5_000);
  await assert.rejects(admin.update({ ...payload, id: scheduled.id }), /发布时间不能更改/);
  const edited = await admin.update({ id: scheduled.id, type: "popup", title: "Edited once published", content: "New content" });
  assert.equal(edited.announcement.publishedAt?.getTime(), publishedPopup?.publishedAt?.getTime());
  assert.equal(edited.announcement.editedAt?.getTime(), Date.now());
  assert.equal((await user.popup())?.content, "New content");
  assert.equal((await user.list()).find((item) => item.id === scheduled.id)?.editedAt?.getTime(), Date.now());

  const manual = await admin.update({ ...payload, id: later.id, publishAt: null });
  assert.equal(manual.announcement.publishedAt?.getTime(), Date.now());
  assert.equal(manual.announcement.editedAt, null);
  assert.equal((await user.popup())?.id, later.id);
  const { announcement: cancelled } = await admin.create({ ...payload, publishAt: inTwoMinutes.toISOString() });
  await admin.delete({ id: cancelled.id });
  t.mock.timers.setTime(inTwoMinutes.getTime());
  await runScheduledAnnouncementPublishing();
  assert.equal((await user.popup())?.id, later.id);
  assert.ok(!(await admin.list()).some((item) => item.id === cancelled.id));
});

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { operationsDay } from "../shared/operations";
import { OPERATIONS_REPORT_TIME_PATTERN, parseOperationsReportConfig } from "../shared/operationsDailyReport";
import { deliverOperationsDailyReport, formatOperationsDailyReport, type DailyReportDependencies } from "./operationsDailyReport";

const at = (value: string) => Date.parse(`${value}+08:00`) / 1000;
const midnight = at("2026-10-23T00:00:00");
const overview = {
  trend: [{ bytesIn: "1024", bytesOut: "2048" }], rules: [{ id: 1, name: "<b>规则</b>\n新行", bytesIn: 1024, bytesOut: 2048 }],
  hosts: [], resources: [], users: [{ id: 2, name: "用户", bytesIn: 1024, bytesOut: 2048 }],
  current: [{ isOnline: true, count: "2" }, { isOnline: 0, count: "1" }], since: null, events: [],
  availability: [{ hostId: 1, name: "离线主机", incidents: "2", offlineSeconds: "120" }],
};
const finance = {
  receipts: [
    { currency: "CNY", amountCents: 1000, count: 1, orderType: "balance", provider: "alipay", paymentType: "alipay" },
    { currency: "CNY", amountCents: 500, count: 1, orderType: "plan", provider: "wechat", paymentType: "wechat" },
    { currency: "USD", amountCents: 200, count: 1, orderType: "plan", provider: "stripe", paymentType: "card" },
  ], balances: [], orders: [], subscriptions: [], activeSubscriptions: 0,
};
function fixture() {
  let stored: string | null = null;
  const calls: { id: number; text: string; channel: string }[] = [];
  const ranges: number[][] = [];
  const config = { enabled: true, time: "00:00", enabledAt: midnight - 60 };
  let failId = 0, queries = 0, recipientQueries = 0;
  const users = [{ id: 1, telegramId: "100", discordId: "200" }, { id: 2, telegramId: "101", discordId: "201" }];
  const warnings: string[] = [];
  const deps: DailyReportDependencies = {
    config: async () => ({ ...config }), load: async () => stored,
    save: async value => { stored = value; },
    recipients: async () => { recipientQueries++; return { channel: "telegram", users }; },
    overview: async (start, end) => { queries++; ranges.push([start, end]); return overview; },
    finance: async () => finance,
    send: async (user, text, channel) => { if (user.id === failId) throw new Error("secret provider details"); calls.push({ id: user.id, text, channel }); },
    warn: value => warnings.push(value),
  };
  return { deps, config, users, calls, ranges, warnings, fail: (id: number) => { failId = id; }, queries: () => queries, recipientQueries: () => recipientQueries, state: () => JSON.parse(stored || "null") };
}

test("report settings default off at midnight and validate 24-hour times", () => {
  for (const value of [null, "", "broken", "null", "[]"]) assert.deepEqual(parseOperationsReportConfig(value), { enabled: false, time: "00:00", enabledAt: 0 });
  assert.deepEqual(parseOperationsReportConfig('{"enabled":true,"time":"23:59","enabledAt":42}'), { enabled: true, time: "23:59", enabledAt: 42 });
  assert.deepEqual(parseOperationsReportConfig('{"enabled":"true","time":"24:00","enabledAt":-1}'), { enabled: false, time: "00:00", enabledAt: 0 });
  for (const value of ["0:00", "24:00", "00:60", "12:00:00", "12:01\n"]) assert.equal(OPERATIONS_REPORT_TIME_PATTERN.test(value), false);
});

test("disabled, not-yet-due and newly enabled after today's time do no aggregation", async () => {
  const f = fixture();
  f.config.enabled = false;
  await deliverOperationsDailyReport(f.deps, midnight);
  f.config.enabled = true;
  await deliverOperationsDailyReport(f.deps, midnight - 1);
  f.config.enabledAt = midnight + 60;
  await deliverOperationsDailyReport(f.deps, midnight + 120);
  assert.equal(f.queries(), 0);
  assert.equal(f.recipientQueries(), 0);
});

test("Beijing midnight reports yesterday and persists dedup across fresh runners", async () => {
  const f = fixture();
  await deliverOperationsDailyReport(f.deps, midnight + 10);
  assert.deepEqual(f.ranges, [[midnight - 86400, midnight]]);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].text, /2026-10-22/);
  assert.match(f.calls[0].text, /&lt;b&gt;规则&lt;\/b&gt; 新行/);
  assert.equal(f.state().complete, true);
  await deliverOperationsDailyReport({ ...f.deps }, midnight + 3600);
  assert.equal(f.calls.length, 2);
  assert.equal(f.queries(), 1);
  assert.equal(JSON.stringify(f.state()).includes("100"), false, "store destination hashes, not notification identities");
  await deliverOperationsDailyReport(f.deps, midnight + 86400);
  assert.equal(f.calls.length, 4);
});

test("custom send time respects UTC+8 and late restart catches up only the latest report", async () => {
  const f = fixture();
  f.config.time = "08:30";
  await deliverOperationsDailyReport(f.deps, at("2026-10-23T08:29:59"));
  assert.equal(f.calls.length, 0);
  await deliverOperationsDailyReport(f.deps, at("2026-10-26T14:00:00"));
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].text, /2026-10-25/);
  assert.equal(f.ranges[0][1], operationsDay(at("2026-10-26T14:00:00")));
});

test("partial failures retry only failed destinations after five minutes", async () => {
  const f = fixture();
  f.fail(2);
  await deliverOperationsDailyReport(f.deps, midnight);
  assert.deepEqual(f.calls.map(row => row.id), [1]);
  assert.equal(f.state().complete, false);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /secret/);
  f.fail(0);
  await deliverOperationsDailyReport(f.deps, midnight + 299);
  assert.equal(f.calls.length, 1);
  await deliverOperationsDailyReport({ ...f.deps }, midnight + 300);
  assert.deepEqual(f.calls.map(row => row.id), [1, 2]);
  assert.equal(f.state().complete, true);
});

test("unconfigured channels/no bound admins do no aggregation and can recover", async () => {
  const f = fixture();
  const users = f.users.splice(0);
  await deliverOperationsDailyReport(f.deps, midnight);
  assert.equal(f.queries(), 0);
  assert.equal(f.state().complete, false);
  f.users.push(...users);
  await deliverOperationsDailyReport(f.deps, midnight + 300);
  assert.equal(f.calls.length, 2);
});

test("disabling while preparing the report aborts delivery", async () => {
  const f = fixture();
  const getOverview = f.deps.overview;
  f.deps.overview = async (start, end) => { f.config.enabled = false; return getOverview(start, end); };
  await deliverOperationsDailyReport(f.deps, midnight);
  assert.equal(f.calls.length, 0);
});

test("duplicate destinations get a single report", async () => {
  const f = fixture();
  f.users[1].telegramId = f.users[0].telegramId;
  await deliverOperationsDailyReport(f.deps, midnight);
  assert.equal(f.calls.length, 1);
});

test("database state read/write failures abort instead of sending untracked reports", async () => {
  const f = fixture();
  await assert.rejects(deliverOperationsDailyReport({ ...f.deps, load: async () => { throw new Error("read failed"); } }, midnight), /read failed/);
  await assert.rejects(deliverOperationsDailyReport({ ...f.deps, save: async () => { throw new Error("write failed"); } }, midnight), /write failed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.queries(), 0);
});

test("Discord uses its own destination, with escaped user-controlled text", async () => {
  const f = fixture();
  f.deps.recipients = async () => ({ channel: "discord", users: f.users });
  await deliverOperationsDailyReport(f.deps, midnight);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].channel, "discord");
  assert.doesNotMatch(f.calls[0].text, /<b>/);
});

test("report totals use actual traffic and keep receipt currencies separate", () => {
  const text = formatOperationsDailyReport("2026-10-22", overview, finance);
  assert.match(text, /实际流量：3.00 KB/);
  assert.match(text, /发送时在线主机：2\/3/);
  assert.match(text, /CNY 15.00 \/ USD 2.00/);
  assert.match(text, /2.0 分钟 \/ 2 次/);
  assert.ok(text.length < 1900);
});

test("report settings persist and API rejects guests, ordinary users and invalid times", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-daily-report-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
      import assert from "node:assert/strict";
      const runtime = await import("./server/dbRuntime.ts");
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await (await import("./server/dbSchema.ts")).ensureDatabaseSchema();
      const { operationsRouter } = await import("./server/routers/operations.ts");
      const { getSetting } = await import("./server/repositories/settingsRepository.ts");
      const ctx = user => ({ user, req: { headers: {} }, res: { clearCookie() {} }, authSession: null, authFailureReason: null });
      try {
        for (const user of [null, { id: 2, role: "user", accountEnabled: true }]) {
          const caller = operationsRouter.createCaller(ctx(user));
          const code = user ? "FORBIDDEN" : "UNAUTHORIZED";
          await assert.rejects(caller.reportSettings(), error => error.code === code);
          await assert.rejects(caller.saveReportSettings({ enabled: true, time: "00:00" }), error => error.code === code);
        }
        const admin = operationsRouter.createCaller(ctx({ id: 1, role: "admin", accountEnabled: true }));
        const defaults = await admin.reportSettings();
        assert.equal(defaults.enabled, false);
        assert.equal(defaults.time, "00:00");
        assert.equal(defaults.notificationReady, false);
        for (const time of ["24:00", "08:60", "0:00", ""]) {
          await assert.rejects(admin.saveReportSettings({ enabled: true, time }), error => error.code === "BAD_REQUEST");
        }
        await admin.saveReportSettings({ enabled: true, time: "08:30" });
        const saved = JSON.parse(await getSetting("operationsDailyReport"));
        assert.equal(saved.time, "08:30");
        assert.ok(saved.enabledAt > 0);
        assert.equal((await admin.reportSettings()).enabled, true);
        await admin.saveReportSettings({ enabled: false, time: "08:30" });
        assert.equal((await admin.reportSettings()).enabled, false);
      } finally { await runtime.closeDatabase(); }
    `], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") }, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

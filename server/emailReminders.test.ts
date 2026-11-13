import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminCopyRecipients } from "./email";
import {
  buildAdminReminderDigest,
  resolveAdminCopyRecipients,
  runEmailReminderSweep,
  type EmailReminderConfig,
  type EmailReminderDeps,
  type ReminderUser,
} from "./emailReminders";

const NOW = Date.parse("2026-11-13T04:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

const baseConfig: EmailReminderConfig = {
  enabled: true,
  expiryReminder: true,
  trafficReminder: true,
  trafficReminderThreshold: 20,
  adminCopy: true,
  adminCopyTo: "",
};

const users: ReminderUser[] = [
  { id: 1, username: "root", role: "admin", email: "root@example.com" },
  { id: 2, username: "alice", role: "user", email: "alice@example.com", expiresAt: new Date(NOW + 2.5 * DAY_MS) },
  { id: 3, username: "bob", role: "user", email: "", trafficLimit: 100 * GB, trafficUsed: 90 * GB },
  { id: 4, username: "carol", role: "user", email: "carol@example.com", trafficLimit: 100 * GB, trafficUsed: 50 * GB },
  { id: 5, username: "dave", role: "user", email: "dave@example.com", accountEnabled: false, expiresAt: new Date(NOW + DAY_MS) },
];

function harness(config: Partial<EmailReminderConfig> = {}, options: { failTo?: (to: string) => unknown; list?: ReminderUser[] } = {}) {
  const markers = new Map<string, string>();
  const sent: Array<{ to: string; subject: string; text?: string }> = [];
  const errors: string[] = [];
  const deps: EmailReminderDeps = {
    getConfig: async () => ({ ...baseConfig, ...config }),
    listUsers: async () => options.list ?? users,
    getMarkers: async (keys) => Object.fromEntries(keys.map((key) => [key, markers.get(key) ?? null])),
    setMarkers: async (keys) => { for (const key of keys) markers.set(key, "sent"); },
    sendMail: async (payload) => {
      const failure = options.failTo?.(payload.to);
      if (failure) throw failure;
      sent.push(payload);
    },
    now: () => NOW,
    logError: (message) => { errors.push(message); },
  };
  return { deps, markers, sent, errors };
}

test("admin copy recipients accept common separators and reject malformed addresses", () => {
  assert.deepEqual(parseAdminCopyRecipients("a@x.com, b@x.com；A@x.com\nc@x.com"), { valid: ["a@x.com", "b@x.com", "c@x.com"], invalid: [] });
  assert.deepEqual(parseAdminCopyRecipients("a@x.com, nope").invalid, ["nope"]);
  assert.deepEqual(parseAdminCopyRecipients("").valid, []);
});

test("admin copy falls back to enabled admin accounts when no address is configured", () => {
  assert.deepEqual(resolveAdminCopyRecipients("", users), ["root@example.com"]);
  assert.deepEqual(resolveAdminCopyRecipients("ops@example.com", users), ["ops@example.com"]);
  assert.deepEqual(resolveAdminCopyRecipients("", [{ id: 9, role: "admin", email: "off@example.com", accountEnabled: false }]), []);
});

test("sweep reminds users once a day and sends admins one digest", async () => {
  const { deps, sent, markers } = harness();
  const first = await runEmailReminderSweep(deps);
  assert.deepEqual(first, { userSent: 1, userFailed: 0, adminEntries: 2, adminSent: true, aborted: false });
  assert.deepEqual(sent.map((mail) => mail.to), ["alice@example.com", "root@example.com"]);
  assert.match(sent[0].text || "", /将在 3 天内到期/);
  const digest = sent[1];
  assert.equal(digest.subject, "ForwardX 用户提醒：1 位即将到期，1 位流量不足");
  assert.match(digest.text || "", /alice <alice@example\.com>：3 天内到期/);
  assert.match(digest.text || "", /bob：剩余约 10%［未填写邮箱，未通知本人］/);
  assert.doesNotMatch(digest.text || "", /carol|dave/);
  assert.ok(markers.has("emailReminder:expiry:3:2:2026-11-13"));

  const second = await runEmailReminderSweep(deps);
  assert.deepEqual(second, { userSent: 0, userFailed: 0, adminEntries: 0, adminSent: false, aborted: false });
  assert.equal(sent.length, 2);
});

test("users without an email are ignored unless admin copy is on", async () => {
  const { deps, sent } = harness({ adminCopy: false });
  const result = await runEmailReminderSweep(deps);
  assert.equal(result.adminEntries, 0);
  assert.deepEqual(sent.map((mail) => mail.to), ["alice@example.com"]);
});

test("a rejected recipient does not block other users and is flagged to admins", async () => {
  const list: ReminderUser[] = [
    { id: 1, username: "root", role: "admin", email: "root@example.com" },
    ...[11, 12, 13, 14].map((id) => ({ id, username: `bad${id}`, email: `bad${id}@example.com`, expiresAt: new Date(NOW + DAY_MS) })),
    { id: 20, username: "erin", email: "erin@example.com", expiresAt: new Date(NOW + DAY_MS) },
  ];
  const rejected = Object.assign(new Error("recipient rejected"), { cause: { code: "EENVELOPE" } });
  const { deps, sent, markers } = harness({}, { list, failTo: (to) => (to.startsWith("bad") ? rejected : null) });
  const result = await runEmailReminderSweep(deps);
  assert.equal(result.userFailed, 4);
  assert.equal(result.userSent, 1);
  assert.equal(result.aborted, false);
  assert.match(sent.at(-1)?.text || "", /bad11 <bad11@example\.com>：1 天内到期.*［通知本人失败］/);
  assert.ok(!markers.has("emailReminder:expiry:1:11:2026-11-13"));
});

test("repeated SMTP failures stop the sweep so it can retry later", async () => {
  const list: ReminderUser[] = [1, 2, 3, 4, 5].map((id) => ({ id, username: `u${id}`, email: `u${id}@example.com`, expiresAt: new Date(NOW + DAY_MS) }));
  let attempts = 0;
  const { deps, sent, markers } = harness({}, { list, failTo: () => { attempts++; return new Error("SMTP 连接超时"); } });
  const result = await runEmailReminderSweep(deps);
  assert.equal(result.aborted, true);
  assert.equal(attempts, 3);
  assert.equal(sent.length, 0);
  assert.equal(markers.size, 0);
});

test("a failed admin digest is retried on the next sweep without re-sending user mail", async () => {
  let adminDown = true;
  const { deps, sent } = harness({ adminCopyTo: "ops@example.com" }, { failTo: (to) => (to === "ops@example.com" && adminDown ? new Error("down") : null) });
  const first = await runEmailReminderSweep(deps);
  assert.equal(first.adminSent, false);
  adminDown = false;
  const second = await runEmailReminderSweep(deps);
  assert.deepEqual(second, { userSent: 0, userFailed: 0, adminEntries: 2, adminSent: true, aborted: false });
  assert.deepEqual(sent.map((mail) => mail.to), ["alice@example.com", "ops@example.com"]);
});

test("a plan that just expired reads as expired in both mails", async () => {
  const list: ReminderUser[] = [{ id: 7, username: "zed", email: "zed@example.com", expiresAt: new Date(NOW - 60_000) }];
  const { deps, sent } = harness({ adminCopyTo: "ops@example.com" }, { list });
  await runEmailReminderSweep(deps);
  assert.match(sent[0].text || "", /套餐已到期/);
  assert.match(sent[1].text || "", /zed <zed@example\.com>：已到期/);
  assert.equal(buildAdminReminderDigest([{ kind: "traffic", user: list[0], outcome: "sent", leftPercent: 5 }]).subject, "ForwardX 用户提醒：1 位流量不足");
});

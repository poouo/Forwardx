import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";
import {
  createPasswordRecoveryService, issuePasswordRecoveryToken, passwordRecoveryLink,
  readPasswordRecoveryToken, recoveryDestination, verifyPasswordRecoveryToken,
} from "./passwordRecovery";
import { PASSWORD_RECOVERY_INVALID_MESSAGE, PASSWORD_RECOVERY_REQUEST_MESSAGE } from "../shared/passwordRecovery";

const user = { id: 7, username: "alice", password: "hashed-old-password", accountEnabled: true, email: "Alice@example.com", emailVerified: true, telegramId: "12345678" };
const secret = "test-password-recovery-key-not-for-production";
const start = 1_800_000_000_000;
const invalid = (error: unknown) => error instanceof Error && error.message === PASSWORD_RECOVERY_INVALID_MESSAGE;

test("recovery accepts only previously verified email or a private Telegram binding", () => {
  assert.equal(recoveryDestination(user, "email"), "alice@example.com");
  assert.equal(recoveryDestination(user, "telegram"), user.telegramId);
  for (const patch of [{ emailVerified: false }, { email: "invalid" }, { email: null }, { accountEnabled: false }]) {
    assert.equal(recoveryDestination({ ...user, ...patch }, "email"), "");
    assert.throws(() => issuePasswordRecoveryToken({ ...user, ...patch }, "email", secret), invalid);
  }
  for (const telegramId of [null, "", "-100123", "@someone", "0", "01234", "1".repeat(21)]) {
    assert.equal(recoveryDestination({ ...user, telegramId }, "telegram"), "");
  }
});

test("recovery credentials are purpose-, account-, binding-, password- and expiry-bound", () => {
  for (const channel of ["email", "telegram"] as const) {
    const token = issuePasswordRecoveryToken(user, channel, secret, start);
    assert.deepEqual(readPasswordRecoveryToken(token), { userId: user.id, channel });
    // Opening/previewing the link does not consume it.
    assert.equal(verifyPasswordRecoveryToken(token, user, secret, start), channel);
    assert.equal(verifyPasswordRecoveryToken(token, user, secret, start + 899_000), channel);
    assert.throws(() => verifyPasswordRecoveryToken(token, user, secret, start + 900_000), invalid);
    for (const patch of [{ id: 8 }, { password: "new-password-hash" }, { accountEnabled: false }, channel === "email" ? { email: "new@example.com" } : { telegramId: "98765" }]) {
      assert.throws(() => verifyPasswordRecoveryToken(token, { ...user, ...patch }, secret, start), invalid);
    }
    assert.throws(() => verifyPasswordRecoveryToken(token, user, "wrong-secret", start), invalid);
    const parts = token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    assert.throws(() => verifyPasswordRecoveryToken(parts.join("."), user, secret, start), invalid);
    const payload = jwt.decode(token) as jwt.JwtPayload;
    const wrongAlgorithm = jwt.sign(payload, secret, { algorithm: "HS384" });
    assert.throws(() => verifyPasswordRecoveryToken(wrongAlgorithm, user, secret, start), invalid);
  }
  for (const token of ["", "bad", "x".repeat(2049), jwt.sign({ sub: "7", channel: "email", purpose: "login" }, secret)]) {
    assert.throws(() => readPasswordRecoveryToken(token), invalid);
  }
});

test("reset links use configured origin and a fragment, never query-string credentials", () => {
  assert.equal(passwordRecoveryLink("https://panel.example.com/", "abc.def"), "https://panel.example.com/login#password-reset=abc.def");
  assert.equal(passwordRecoveryLink("https://panel.example.com/sub/", "a+b"), "https://panel.example.com/sub/login#password-reset=a%2Bb");
  for (const url of ["", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/?url=evil", "https://example.com/#x"]) {
    assert.throws(() => passwordRecoveryLink(url, "token"));
  }
});

function harness() {
  let clock = start;
  let current: typeof user | undefined = { ...user };
  let options = { email: true, telegram: true, panelUrl: "https://panel.example.com" };
  const work: Array<() => Promise<void>> = [];
  const deliveries: Array<{ destination: string; channel: string; link: string }> = [];
  const consumed: string[] = [];
  const service = createPasswordRecoveryService({
    findUser: async (identifier) => identifier === "missing" ? undefined : current,
    getUser: async () => current,
    options: async () => options,
    send: async (recipient, channel, link) => { deliveries.push({ destination: recoveryDestination(recipient, channel), channel, link }); },
    consume: async (snapshot, _channel, password) => {
      if (!current || current.password !== snapshot.password) return false;
      current = { ...current, password: `hashed:${password}` };
      consumed.push(password);
      return true;
    },
    schedule: (task) => work.push(task), secret: () => secret, now: () => clock,
  });
  return { service, deliveries, consumed, work,
    setUser: (next: typeof current) => { current = next; },
    setOptions: (next: typeof options) => { options = next; },
    advance: (ms: number) => { clock += ms; },
    drain: async () => { while (work.length) await work.shift()!(); },
  };
}

test("unknown, disabled, unverified and unbound accounts return identical non-enumerating responses", async () => {
  for (const patch of [undefined, { ...user, emailVerified: false }, { ...user, accountEnabled: false }, { ...user, email: "" }]) {
    const h = harness();
    h.setUser(patch);
    assert.deepEqual(h.service.request("alice", "email", "192.0.2.1"), { success: true, message: PASSWORD_RECOVERY_REQUEST_MESSAGE });
    assert.equal(h.deliveries.length, 0);
    await h.drain();
    assert.equal(h.deliveries.length, 0);
  }
  const h = harness();
  h.service.request("missing", "telegram", "192.0.2.1");
  await h.drain();
  assert.equal(h.deliveries.length, 0);
});

test("delivery is deferred, goes only to existing bindings, and respects canonical account cooldown", async () => {
  const h = harness();
  h.service.request("alice", "email", "192.0.2.1");
  assert.equal(h.deliveries.length, 0);
  await h.drain();
  assert.equal(h.deliveries[0].destination, "alice@example.com");
  assert.match(h.deliveries[0].link, /^https:\/\/panel\.example\.com\/login#password-reset=/);
  // Switching username/email aliases, IP or channel must not bypass cooldown.
  h.service.request("alice@example.com", "telegram", "192.0.2.2");
  await h.drain();
  assert.equal(h.deliveries.length, 1);
  h.advance(60_001);
  h.service.request("alice", "telegram", "192.0.2.2");
  await h.drain();
  assert.equal(h.deliveries[1].destination, user.telegramId);
  const token = new URL(h.deliveries[1].link).hash.slice("#password-reset=".length);
  assert.equal(verifyPasswordRecoveryToken(token, user, secret, start + 60_001), "telegram");
});

test("no delivery when the chosen channel or trusted public URL is unavailable", async () => {
  for (const options of [
    { email: false, telegram: false, panelUrl: "https://panel.example.com" },
    { email: true, telegram: true, panelUrl: "" },
  ]) {
    const h = harness(); h.setOptions(options);
    for (const channel of ["email", "telegram"] as const) h.service.request("alice", channel, "192.0.2.1");
    await h.drain();
    assert.equal(h.deliveries.length, 0);
  }
});

test("anonymous request and reset attempts are rate limited before expensive work", async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) h.service.request("missing", "email", "192.0.2.1");
  assert.throws(() => h.service.request("alice", "email", "192.0.2.1"), { code: "TOO_MANY_REQUESTS" });
  h.advance(30 * 60_000);
  assert.doesNotThrow(() => h.service.request("missing", "email", "192.0.2.1"));
  for (let i = 0; i < 30; i++) await assert.rejects(h.service.reset("bad", "new-password", "192.0.2.1"), invalid);
  await assert.rejects(h.service.reset("bad", "new-password", "192.0.2.1"), { code: "TOO_MANY_REQUESTS" });
  assert.equal(h.consumed.length, 0);
});

test("reset validates proof and password, consumes once, and invalidates other outstanding links", async () => {
  const h = harness();
  const email = issuePasswordRecoveryToken(user, "email", secret, start);
  const telegram = issuePasswordRecoveryToken(user, "telegram", secret, start);
  for (const password of ["short", "x".repeat(129)]) await assert.rejects(h.service.reset(email, password, "192.0.2.1"), { code: "BAD_REQUEST" });
  const results = await Promise.allSettled([
    h.service.reset(email, "password-one", "192.0.2.1"),
    h.service.reset(telegram, "password-two", "192.0.2.1"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(h.consumed.length, 1);
  await assert.rejects(h.service.reset(email, "another-password", "192.0.2.1"), invalid);
  await assert.rejects(h.service.reset(telegram, "another-password", "192.0.2.1"), invalid);
});

test("database reset atomically changes the password, revokes sessions and rolls back if revocation fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-password-recovery-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const users = await import(url("server/repositories/userRepository.ts"));
    const sessions = await import(url("server/repositories/sessionRepository.ts"));
    const password = await import(url("server/password.ts"));
    const recovery = await import(url("server/passwordRecovery.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, email, emailVerified, accountEnabled, telegramId, twoFactorEnabled, twoFactorSecret, telegramLoginCode, discordLoginCode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, "alice", password.hashPassword("old-password"), "alice@example.com", 1, 1, "12345", 1, "keep-secret", "tg-code", "discord-code"]);
      for (const kind of ["browser", "mobile", "telegram"]) {
        await sessions.createAuthSession({ userId: 1, sid: kind, kind, expiresAt: new Date(Date.now() + 60_000) });
        await users.setUserSessionToken(1, kind, "lease:" + kind);
      }
      const original = await users.getUserById(1);
      const token = recovery.issuePasswordRecoveryToken(original, "email", "test-secret");
      const concurrent = await Promise.all([
        users.resetUserPasswordFromRecovery(original, "email", "new-password"),
        users.resetUserPasswordFromRecovery(original, "telegram", "new-password"),
      ]);
      assert.deepEqual(concurrent.sort(), [false, true]);
      let current = await users.getUserById(1);
      assert.equal(password.verifyPassword("new-password", current.password), true);
      assert.equal(password.verifyPassword("old-password", current.password), false);
      assert.throws(() => recovery.verifyPasswordRecoveryToken(token, current, "test-secret"));
      assert.equal(current.twoFactorEnabled, true);
      assert.equal(current.twoFactorSecret, "keep-secret");
      for (const key of ["browserSessionToken", "mobileSessionToken", "telegramSessionToken", "telegramLoginCode", "discordLoginCode"]) assert.equal(current[key], null);
      const rows = await runtime.queryRaw('SELECT revokedAt, revokeReason FROM auth_sessions WHERE userId = 1');
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => row.revokedAt && row.revokeReason === "password_recovery"));
      // Same normalized address retains verification; different address loses it.
      await users.updateUserProfile(1, { email: " ALICE@example.com " });
      assert.equal((await users.getUserById(1)).emailVerified, true);
      const beforeBindingChange = await users.getUserById(1);
      await users.updateUserProfile(1, { email: "new@example.com" });
      current = await users.getUserById(1);
      assert.equal(current.emailVerified, false);
      assert.equal(current.emailVerifiedAt, null);
      assert.equal(await users.resetUserPasswordFromRecovery(beforeBindingChange, "email", "not-allowed"), false);
      // Disabling the account between proof verification and CAS must reject.
      await users.setUserAccountEnabled(1, false);
      assert.equal(await users.resetUserPasswordFromRecovery(current, "telegram", "not-allowed"), false);
      await users.setUserAccountEnabled(1, true);
      current = await users.getUserById(1);
      await sessions.createAuthSession({ userId: 1, sid: "fresh", kind: "browser", expiresAt: new Date(Date.now() + 60_000) });
      await runtime.executeRaw("CREATE TRIGGER fail_recovery_revoke BEFORE UPDATE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END");
      await assert.rejects(users.resetUserPasswordFromRecovery(current, "telegram", "must-rollback"), /test revocation failure/);
      assert.equal((await users.getUserById(1)).password, current.password);
      assert.equal((await runtime.queryRaw("SELECT revokedAt FROM auth_sessions WHERE sid = ?", ["fresh"]))[0].revokedAt, null);
      await runtime.executeRaw("DROP TRIGGER fail_recovery_revoke");
      // Exercise the actual public RPC path without a logged-in session.
      const { authRouter } = await import(url("server/routers/auth.ts"));
      const { databaseHealth } = await import(url("server/databaseHealthState.ts"));
      const challenges = await import(url("server/twoFactorChallenges.ts"));
      const setups = await import(url("server/twoFactorSetupChallenges.ts"));
      const { ENV } = await import(url("server/env.ts"));
      databaseHealth.healthy();
      let cleared = 0;
      const caller = authRouter.createCaller({ user: null, req: { headers: {}, ip: "192.0.2.9" }, res: { setHeader() {}, clearCookie() { cleared++; } } });
      assert.deepEqual(await caller.passwordRecoveryOptions(), { email: false, telegram: false });
      await assert.rejects(caller.resetPasswordWithToken({ token: "bad", newPassword: "newest-password" }), /重置链接无效/);
      await assert.rejects(caller.resetPasswordWithToken({ token: "bad", newPassword: "short" }), { code: "BAD_REQUEST" });
      assert.equal(cleared, 0);
      const challenge = challenges.createTwoFactorChallenge({ userId: 1, username: "alice", passwordHash: current.password });
      const setup = setups.createTwoFactorSetupChallenge({ userId: 1, secret: "pending-secret" });
      const publicToken = recovery.issuePasswordRecoveryToken(current, "telegram", ENV.cookieSecret);
      assert.deepEqual(await caller.resetPasswordWithToken({ token: publicToken, newPassword: "newest-password" }), { success: true });
      assert.equal(cleared, 1);
      assert.equal(challenges.getTwoFactorChallenge(challenge.challengeId), null);
      assert.equal(setups.getTwoFactorSetupChallenge(setup.setupId, 1), null);
      await assert.rejects(caller.resetPasswordWithToken({ token: publicToken, newPassword: "reuse-password" }), /重置链接无效/);
      current = await users.getUserById(1);
      assert.equal(password.verifyPassword("newest-password", current.password), true);
      assert.equal(current.twoFactorEnabled, true);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") },
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

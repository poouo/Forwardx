import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { User } from "../drizzle/schema";
import { createUserImpersonationService } from "./userImpersonation";
import { encodeSessionLease } from "./session";
import { IMPERSONATION_EXPIRED, IMPERSONATION_PREFIX } from "../shared/userImpersonation";

const secret = "test-only-user-entry-secret";
const invalid = (error: unknown) => error instanceof Error && error.message === IMPERSONATION_EXPIRED;
function harness() {
  let clock = 1_800_000_000_000;
  let multi = false;
  const admin = { id: 1, username: "admin", password: "hashed-admin", role: "admin", accountEnabled: true, browserSessionToken: null } as User;
  const target = { id: 2, username: "user", password: "hashed-user", role: "user", accountEnabled: true, browserSessionToken: "unchanged-user-lease" } as User;
  const users = new Map([[1, admin], [2, target]]);
  const sessions = new Set(["1:browser:parent", "2:browser:user-login"]);
  const created: any[] = [];
  const service = createUserImpersonationService({
    secret, now: () => clock, getUser: async id => users.get(id),
    getIdentity: async (id, sid, kind) => {
      const user = users.get(id);
      return user ? { user, session: sessions.has(`${id}:${kind}:${sid}`) ? {} : null } : undefined;
    },
    createSession: async input => { created.push(input); sessions.add(`${input.userId}:${input.kind}:${input.sid}`); },
    allowMultiple: async () => multi,
  });
  return { service, admin, target, sessions, created, users, advance: (ms: number) => { clock += ms; }, allowMulti: () => { multi = true; } };
}

test("entry creates only an isolated admin capability and leaves both login leases untouched", async () => {
  const h = harness();
  const originalAdmin = { ...h.admin }, originalTarget = { ...h.target };
  const { token, expiresAt } = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  assert.equal(expiresAt, 1_800_003_600_000);
  assert.ok(token.startsWith(IMPERSONATION_PREFIX));
  const resolved = await h.service.resolve(token);
  assert.equal(resolved.user, h.target);
  assert.equal(resolved.impersonation.actorId, h.admin.id);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].userId, h.admin.id);
  assert.deepEqual(h.admin, originalAdmin);
  assert.deepEqual(h.target, originalTarget);
  assert.ok(h.sessions.has("2:browser:user-login"));
  assert.ok(h.sessions.has("1:browser:parent"));
});

test("anonymous, ordinary users, disabled accounts and administrator targets cannot issue entry tokens", async () => {
  const h = harness();
  await assert.rejects(h.service.issue(h.admin, null, 2));
  await assert.rejects(h.service.issue(h.target, { sid: "user-login", kind: "browser" }, 1));
  await assert.rejects(h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 1));
  await assert.rejects(h.service.issue(h.admin, { sid: "missing", kind: "browser" }, 2));
  await assert.rejects(h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 999));
  h.target.accountEnabled = false;
  await assert.rejects(h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2));
  assert.equal(h.created.length, 0);
});

test("revocation, password changes, disabled/deleted accounts and role changes invalidate entry immediately", async () => {
  const changes: ((h: ReturnType<typeof harness>, grantSid: string) => void)[] = [
    h => h.sessions.delete("1:browser:parent"),
    (h, sid) => h.sessions.delete(`1:browser:${sid}`),
    h => { h.admin.password = "changed-admin"; },
    h => { h.target.password = "changed-user"; },
    h => { h.admin.accountEnabled = false; },
    h => { h.target.accountEnabled = false; },
    h => { h.admin.role = "user"; },
    h => { h.target.role = "admin"; },
    h => { h.users.delete(1); },
    h => { h.users.delete(2); },
  ];
  for (const change of changes) {
    const h = harness();
    const { token } = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
    const { impersonation } = await h.service.resolve(token);
    change(h, impersonation.grantSid);
    await assert.rejects(h.service.resolve(token), invalid);
  }
});

test("expired, forged, wrong-purpose and ordinary login tokens are rejected", async () => {
  const h = harness();
  const { token } = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  assert.throws(() => jwt.verify(token.slice(IMPERSONATION_PREFIX.length), secret));
  for (const bad of ["", "fxi.bad", "fxi." + "x".repeat(4096), jwt.sign({ userId: 2 }, secret),
    IMPERSONATION_PREFIX + jwt.sign(jwt.decode(token.slice(4)) as object, secret),
    token.slice(0, -10) + "AAAAAAAAAA"]) await assert.rejects(h.service.resolve(bad), invalid);
  h.advance(3_600_000);
  await assert.rejects(h.service.resolve(token), invalid);
});

test("replaced single-device administrator sessions invalidate entry; multi-device sessions remain supported", async () => {
  const h = harness();
  const { token } = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  h.admin.browserSessionToken = encodeSessionLease("different-session", 1_800_000_000_000);
  await assert.rejects(h.service.resolve(token), invalid);
  h.allowMulti();
  assert.equal((await h.service.resolve(token)).user.id, 2);
});

test("logout revokes only that entry grant, not another window or either real login", async () => {
  const h = harness();
  const first = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  const second = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  const grant = (await h.service.resolve(first.token)).impersonation.grantSid;
  h.sessions.delete(`1:browser:${grant}`);
  await assert.rejects(h.service.resolve(first.token), invalid);
  assert.equal((await h.service.resolve(second.token)).user.id, 2);
  assert.ok(h.sessions.has("1:browser:parent"));
  assert.ok(h.sessions.has("2:browser:user-login"));
});

test("database failures are propagated, not treated as invalid credentials", async () => {
  const h = harness();
  const { token } = await h.service.issue(h.admin, { sid: "parent", kind: "browser" }, 2);
  const failure = new Error("Database busy");
  const broken = createUserImpersonationService({
    secret, getUser: async () => { throw failure; }, getIdentity: async () => { throw failure; },
    createSession: async () => {}, allowMultiple: async () => false,
  });
  await assert.rejects(broken.resolve(token), error => error === failure);
});

test("server integration is fail-closed before dev fallback and logout never clears real login Cookies", () => {
  const context = readFileSync("server/_core/context.ts", "utf8");
  assert.ok(context.indexOf("session.token.startsWith(IMPERSONATION_PREFIX)") < context.indexOf("if (isDevPanelMode())"));
  assert.match(context, /authSession: null/);
  const auth = readFileSync("server/routers/auth.ts", "utf8");
  const logout = auth.slice(auth.indexOf("logout: publicProcedure"), auth.indexOf("changePassword: protectedProcedure"));
  const delegatedLogout = logout.slice(logout.indexOf("if (ctx.impersonation)"), logout.indexOf("const cookieOptions"));
  assert.match(delegatedLogout, /revokeAuthSession\(ctx.impersonation.actorId, ctx.impersonation.grantSid/);
  assert.doesNotMatch(delegatedLogout, /clearCookie|clearUserSessionToken/);
  const users = readFileSync("server/routers/users.ts", "utf8");
  assert.match(users, /enterUserBackend: adminProcedure/);
});

test("real SQLite/RPC flow enforces user scope, administrator audit identity and isolated revocation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-user-entry-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import jwt from "jsonwebtoken";
    const load = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await load("server/dbRuntime.ts");
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
      await (await load("server/dbSchema.ts")).ensureDatabaseSchema();
      const users = await load("server/repositories/userRepository.ts");
      const sessions = await load("server/repositories/sessionRepository.ts");
      const { ENV } = await load("server/env.ts");
      const { COOKIE_NAME } = await load("shared/const.ts");
      const { createContext } = await load("server/_core/context.ts");
      const { usersRouter } = await load("server/routers/users.ts");
      const { authRouter } = await load("server/routers/auth.ts");
      const { ruleTasksRouter, queuedRuleTasks } = await load("server/routers/rules.tasks.ts");
      const { router, protectedProcedure, adminProcedure } = await load("server/_core/trpc.ts");
      const { currentConfigAuditContext } = await load("server/configAudit.ts");
      for (const [id, username, role] of [[1, "admin", "admin"], [2, "alice", "user"], [3, "bob", "user"]]) {
        await runtime.insertAndGetId("users", { id, username, password: "test-hash-" + id, role, accountEnabled: true });
        await sessions.createAuthSession({ userId: id, sid: "original-" + id, kind: "browser", expiresAt: new Date(Date.now() + 600000) });
      }
      await runtime.insertAndGetId("hosts", { id: 1, name: "test-entry", ip: "198.51.100.10", userId: 1 });
      for (const [id, userId] of [[21, 2], [22, 3]]) {
        await runtime.insertAndGetId("forward_rules", { id, userId, hostId: 1, name: "test-rule", forwardType: "iptables", protocol: "tcp",
          sourcePort: 15000 + id, targetIp: "203.0.113.10", targetPort: 443, isEnabled: false, disabledByUser: true, isRunning: false });
      }
      const finish = async id => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const task = queuedRuleTasks.get(2, id);
          if (task?.finishedAt) return task;
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        throw Error("queued entry task did not finish");
      };
      const api = router({ users: usersRouter, auth: authRouter, rules: ruleTasksRouter,
        scope: protectedProcedure.mutation(({ctx}) => ({ userId: ctx.user.id, audit: currentConfigAuditContext() })),
        adminOnly: adminProcedure.query(() => "secret"),
      });
      const cookie = jwt.sign({ userId: 1, sid: "original-1", kind: "browser" }, ENV.cookieSecret, { expiresIn: 600 });
      const cookies = { [COOKIE_NAME]: cookie };
      const effects = { clear: 0, cookie: 0 };
      const res = { setHeader() {}, clearCookie() { effects.clear++; }, cookie() { effects.cookie++; } };
      const makeContext = (bearer) => createContext({ req: { headers: bearer ? { authorization: "Bearer " + bearer } : {}, cookies, ip: "192.0.2.1" }, res, info: {} });
      const adminContext = await makeContext();
      const admin = api.createCaller(adminContext);
      const beforeAdmin = await users.getUserById(1), beforeTarget = await users.getUserById(2);
      const beforeTargetSessions = await runtime.queryRaw("SELECT * FROM auth_sessions WHERE userId = 2");
      const first = await admin.users.enterUserBackend({ userId: 2 });
      const second = await admin.users.enterUserBackend({ userId: 2 });
      const delegatedContext = await makeContext(first.token);
      assert.equal(delegatedContext.user.id, 2);
      assert.equal(delegatedContext.authSession, null);
      assert.equal(delegatedContext.impersonation.actorId, 1);
      const delegated = api.createCaller(delegatedContext);
      const me = await delegated.auth.me();
      assert.equal(me.id, 2);
      assert.equal(me.impersonation.actorName, "admin");
      assert.equal(me.password, undefined);
      const scope = await delegated.scope();
      assert.equal(scope.userId, 2);
      assert.equal(scope.audit.actorUserId, 1);
      assert.equal(scope.audit.source, "panel:impersonation");
      const batch = await delegated.rules.enqueueTask({ requestId: "entry-scope-test", title: "entry rules", actions: [
        { operation: "restart", input: { id: 21 }, conflictStrategy: "error" },
        { operation: "restart", input: { id: 22 }, conflictStrategy: "error" },
      ] });
      const batchResult = await finish(batch.task.id);
      assert.deepEqual([batchResult.skipped, batchResult.failed], [1, 1], JSON.stringify(batchResult));
      assert.match(batchResult.results[1].error, /无权/);
      assert.doesNotMatch(JSON.stringify(batchResult), /credentialProof|grantSid|parentSid|fxi\./);
      await assert.rejects(delegated.users.enterUserBackend({ userId: 3 }), { code: "FORBIDDEN" });
      await assert.rejects(delegated.adminOnly(), { code: "FORBIDDEN" });
      await assert.rejects(delegated.auth.changePassword({ oldPassword: "anything", newPassword: "something-new" }), { code: "FORBIDDEN" });
      await assert.rejects(api.createCaller({ ...delegatedContext, user: { ...delegatedContext.user, role: "admin" } }).adminOnly(), { code: "FORBIDDEN" });
      await assert.rejects(api.createCaller({ ...adminContext, user: null }).users.enterUserBackend({ userId: 2 }), { code: "UNAUTHORIZED" });
      await assert.rejects(api.createCaller({ ...adminContext, user: beforeTarget }).users.enterUserBackend({ userId: 3 }), { code: "FORBIDDEN" });
      await assert.rejects(admin.users.enterUserBackend({ userId: 1 }), { code: "FORBIDDEN" });
      assert.deepEqual(await users.getUserById(1), beforeAdmin);
      assert.deepEqual(await users.getUserById(2), beforeTarget);
      assert.deepEqual(await runtime.queryRaw("SELECT * FROM auth_sessions WHERE userId = 2"), beforeTargetSessions);
      const revokedBatch = await delegated.rules.enqueueTask({ requestId: "entry-revoke-test", title: "revoked entry rules", actions: [
        { operation: "restart", input: { id: 21 }, conflictStrategy: "error" },
        { operation: "restart", input: { id: 21 }, conflictStrategy: "error" },
      ] });
      assert.deepEqual(await delegated.auth.logout(), { success: true });
      const revokedResult = await finish(revokedBatch.task.id);
      assert.deepEqual([revokedResult.failed, revokedResult.cancelled], [1, 1], JSON.stringify(revokedResult));
      assert.match(revokedResult.results[0].error, /代入已结束/);
      assert.deepEqual(effects, { clear: 0, cookie: 0 });
      await assert.rejects(makeContext(first.token), { code: "UNAUTHORIZED" });
      assert.equal((await makeContext(second.token)).user.id, 2);
      assert.ok(await sessions.getActiveAuthSession(1, "original-1", "browser"));
      assert.ok(await sessions.getActiveAuthSession(2, "original-2", "browser"));
      await sessions.revokeAuthSession(1, "original-1", "browser");
      await assert.rejects(makeContext(second.token), { code: "UNAUTHORIZED" });
      // Even local dev mode must not mask an invalid delegated credential.
      process.env.FORWARDX_DEV_PANEL = "1";
      await assert.rejects(makeContext("fxi.invalid"), { code: "UNAUTHORIZED" });
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_ENV: "test", FORWARDX_DEV_PANEL: "0", DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "entry.db"),
        DATABASE_CONFIG_PATH: path.join(directory, "database.json"), JWT_SECRET: secret, FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

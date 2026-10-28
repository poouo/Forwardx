import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-management-permissions-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "permissions.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.JWT_SECRET = "isolated-management-permission-test-secret";
let runtime: typeof import("./dbRuntime");
let hosts: typeof import("./routers/hosts").hostsRouter;
let tokens: typeof import("./routers/agentTokens").agentTokensRouter;
let tunnels: typeof import("./routers/tunnels").tunnelsRouter;
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
const context = (role: "admin" | "user" | null, id = role === "admin" ? 1 : 2) => ({
  user: role ? { id, role, accountEnabled: true, canAddRules: false } : null,
  req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null,
}) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  for (const [id, role] of [[1, "admin"], [2, "user"], [3, "admin"]] as const) {
    await runtime.insertAndGetId("users", { id, username: `permissions-${id}`, password: "unused", role, accountEnabled: id !== 3, canAddRules: false });
  }
  hosts = (await import("./routers/hosts")).hostsRouter;
  tokens = (await import("./routers/agentTokens")).agentTokensRouter;
  tunnels = (await import("./routers/tunnels")).tunnelsRouter;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("ordinary users cannot mint infrastructure or recover tokens, even when they own legacy resources", async () => {
  await runtime.insertAndGetId("hosts", { id: 10, name: "legacy-user-host", ip: "192.0.2.10", userId: 2, agentToken: "legacy-host-secret" });
  await runtime.insertAndGetId("agent_tokens", { id: 10, token: "legacy-user-secret", userId: 2 });
  await runtime.insertAndGetId("tunnels", { id: 10, name: "legacy-user-tunnel", userId: 2, entryHostId: 10, exitHostId: 10, listenPort: 21000 });
  const userHosts = hosts.createCaller(context("user"));
  const userTokens = tokens.createCaller(context("user"));
  const userTunnels = tunnels.createCaller(context("user"));
  const beforeRows = await runtime.queryRaw("SELECT id, name FROM hosts ORDER BY id");
  const attempts = [
    () => userHosts.create({ name: "unauthorized", ip: "192.0.2.20" }),
    () => userHosts.update({ id: 10, name: "forged" }),
    () => userHosts.prepareDelete({ id: 10 }), () => userHosts.deleteImpact({ id: 10 }), () => userHosts.delete({ id: 10 }),
    () => userTokens.list(), () => userTokens.create({ description: "forged" }),
    () => userTokens.getInstallToken({ id: 10 }), () => userTokens.getInstallToken({ token: "legacy-user-secret" }),
    () => userTokens.update({ id: 10, description: "forged" }), () => userTokens.reorder({ ids: [10] }), () => userTokens.delete({ id: 10 }),
    () => userTunnels.create({ name: "forged", entryHostId: 10, exitHostId: 10, listenPort: 22000 }),
    () => userTunnels.update({ id: 10, name: "forged" }), () => userTunnels.deleteImpact({ id: 10 }), () => userTunnels.delete({ id: 10 }),
  ];
  for (const attempt of attempts) await assert.rejects(attempt, { code: "FORBIDDEN" });
  assert.deepEqual(await runtime.queryRaw("SELECT id, name FROM hosts ORDER BY id"), beforeRows);
  assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM agent_tokens"))[0].count, 1);
  assert.equal((await runtime.queryRaw<any>("SELECT name FROM tunnels WHERE id=10"))[0].name, "legacy-user-tunnel");
  const visible = await userHosts.getById({ id: 10 });
  assert.equal(visible?.name, "legacy-user-host");
  assert.equal((visible as any).agentToken, undefined, "read access never discloses the Agent credential");
});

test("administrators retain management access; anonymous and disabled sessions cannot create resources", async () => {
  const created = await hosts.createCaller(context("admin")).create({ name: "admin-host", ip: "192.0.2.11" });
  assert.ok(created.id > 0 && created.agentToken.length === 32);
  await hosts.createCaller(context("admin")).update({ id: created.id, name: "admin-renamed" });
  const token = await tokens.createCaller(context("admin")).create({ description: "admin-token" });
  assert.equal((await tokens.createCaller(context("admin")).getInstallToken({ id: token.id })).token, token.token);
  for (const ctx of [context(null), { ...context("admin"), user: { id: 3, role: "admin", accountEnabled: false }, res: { clearCookie() {} } }]) {
    await assert.rejects(() => hosts.createCaller(ctx).create({ name: "forged", ip: "192.0.2.12" }), { code: "UNAUTHORIZED" });
    await assert.rejects(() => tokens.createCaller(ctx).create({}), { code: "UNAUTHORIZED" });
  }
});

test("old ordinary-user tokens cannot register or recreate a host; administrator Agent registration still works", async () => {
  const { agentRouter } = await import("./agentRoutes");
  const { encryptPayload, decryptPayload } = await import("./agentCrypto");
  const { panelCryptoNowMs } = await import("./panelClock");
  const app = express(); app.use(express.json()); app.use(agentRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  for (const [token, userId, expected] of [["legacy-user-secret", 2, 401], ["disabled-admin-secret", 3, 401], ["valid-admin-secret", 1, 200]] as const) {
    if (userId !== 2) await runtime.insertAndGetId("agent_tokens", { token, userId });
    (await import("./repositories/tokenRepository")).invalidateAgentAuthTokenCandidates();
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/register`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(encryptPayload({ token, ip: "192.0.2.22" }, token, { timestampMs: panelCryptoNowMs() })),
    });
    const raw = await response.json();
    const body = expected === 200 ? decryptPayload(raw, token) : raw;
    assert.equal(response.status, expected, JSON.stringify(body));
    const rows = await runtime.queryRaw("SELECT id FROM hosts WHERE agentToken = ?", [token]);
    assert.equal(rows.length, expected === 200 ? 1 : 0);
  }
});

test("all Agent auth lanes reject untrusted credentials and revocation invalidates a warm cache", async () => {
  const { encryptPayload, agentTokenFingerprint, signAgentAuthProof } = await import("./agentCrypto");
  const { panelCryptoNowMs } = await import("./panelClock");
  const auth = await import("./repositories/tokenRepository");
  const users = await import("./repositories/userRepository");
  const port = (server!.address() as { port: number }).port;
  for (const token of ["legacy-user-secret", "legacy-host-secret", "attacker-chosen-secret"]) {
    assert.equal(await auth.isKnownAgentAuthToken(token), false);
    for (const mode of ["raw", "signed", "no-header", "sync"] as const) {
      const route = mode === "sync" ? "/api/sync" : "/api/agent/heartbeat";
      const envelope = encryptPayload(mode === "sync" ? { path: "/api/agent/heartbeat", payload: {} } : {}, token, { timestampMs: panelCryptoNowMs() });
      const body = JSON.stringify(envelope);
      const ts = panelCryptoNowMs(), nonce = "0123456789abcdef";
      const credential = mode === "signed" ? `v1.${agentTokenFingerprint(token)}.${ts}.${nonce}.${signAgentAuthProof({ token, method: "POST", path: route, ts, nonce, bodyText: body })}` : token;
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST", headers: { "content-type": "application/json", ...(mode !== "no-header" ? { authorization: `Bearer ${credential}` } : {}) }, body,
      });
      assert.equal(response.status, 401, `${mode} must reject an untrusted credential`);
      await response.arrayBuffer();
    }
    const events = await fetch(`http://127.0.0.1:${port}/api/agent/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(events.status, 401); await events.arrayBuffer();
  }
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), true);
  await users.updateUserRole(1, "user");
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), false);
  await users.updateUserRole(1, "admin");
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), true);
  await users.setUserAccountEnabled(1, false);
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), false);
  await users.setUserAccountEnabled(1, true);
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), true);
  const token = (await auth.getAgentTokenByToken("valid-admin-secret"))!;
  await auth.deleteAgentToken(token.id);
  assert.equal(await auth.isKnownAgentAuthToken("valid-admin-secret"), false);
});

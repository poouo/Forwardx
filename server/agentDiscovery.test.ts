import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-discovery-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "discovery.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let discovery: typeof import("./agentDiscovery");
let tokens: typeof import("./routers/agentTokens").agentTokensRouter;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base: string;
const ctx = (role = "admin") => ({ user: { id: 1, role, accountEnabled: true }, req: { headers: {}, socket: {} }, res: {} }) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "unused", role: "admin", accountEnabled: true });
  discovery = await import("./agentDiscovery");
  tokens = (await import("./routers/agentTokens")).agentTokensRouter;
  const app = express();
  app.use(express.json());
  app.use((await import("./agentRoutes")).agentRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function register(token: string, installationId: string) {
  const { encryptPayload, decryptPayload } = await import("./agentCrypto");
  const response = await fetch(base + "/api/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encryptPayload({ path: "/api/agent/register", installationId,
      payload: { token, ip: "192.0.2.15", ipv4: "192.0.2.15", agentVersion: "2.2.213" } }, token)),
  });
  const body = decryptPayload(await response.json(), token, { validateTimestamp: false }) as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("one shared command gives different machines independent credentials and registers without precreated hosts", async () => {
  const config = await tokens.createCaller(ctx()).configureDiscovery({});
  assert.equal(config.enabled, true);
  assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM hosts"))[0].count, 0);
  const first = await discovery.enrollDiscoveredAgent(config.key, "1".repeat(64), "host-one");
  const second = await discovery.enrollDiscoveredAgent(config.key, "2".repeat(64), "host-two");
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.token, config.key);
  assert.deepEqual(await tokens.createCaller(ctx()).list(), [], "pending reservations must not appear as machines");
  const management = await import("./repositories/hostRepository");
  assert.equal((await management.getHostManagementCounts()).tokens, 0);
  // Preparing the installer is not the server's first online event.
  await runtime.executeRaw('UPDATE agent_tokens SET createdAt = ? WHERE token = ?', [1_600_000_000, first.token]);
  assert.equal((await (await import("./repositories/tokenRepository")).getAgentTokenByToken(first.token))!.firstOnlineAt, null);
  const a = await register(first.token, "a".repeat(64));
  const b = await register(second.token, "b".repeat(64));
  assert.notEqual(a.hostId, b.hostId);
  const items = await tokens.createCaller(ctx()).list();
  assert.deepEqual(items.map((item: any) => item.host.name).sort(), ["host-one", "host-two"]);
  assert.ok(items.every((item: any) => item.host.isOnline === true));
  assert.equal((await management.getHostManagementCounts()).tokens, 2);
  const firstOnlineAt = items.find((item: any) => item.host.id === a.hostId).firstOnlineAt;
  assert.ok(firstOnlineAt instanceof Date && firstOnlineAt.getTime() > Date.now() - 60_000);
  await (await import("./repositories/tokenRepository")).markAgentTokenUsed(first.token, a.hostId, new Date(firstOnlineAt.getTime() + 60_000));
  assert.equal((await tokens.createCaller(ctx()).list()).find((item: any) => item.host.id === a.hostId).firstOnlineAt.getTime(), firstOnlineAt.getTime(), "later online updates cannot overwrite the original timestamp");
  const recovery = await tokens.createCaller(ctx()).getInstallToken({ id: items.find((item: any) => item.host.id === a.hostId).id });
  assert.equal(recovery.token, first.token);
  await runtime.insertAndGetId("forward_rules", { hostId: a.hostId, name: "restored-rule", forwardType: "realm",
    protocol: "tcp", sourcePort: 23100, targetIp: "198.51.100.1", targetPort: 443, userId: 1, isEnabled: true, isRunning: true });
  const restored = await register(recovery.token, "c".repeat(64));
  assert.equal(restored.hostId, a.hostId, "dedicated command must restore the original host");
  assert.equal((await tokens.createCaller(ctx()).list()).find((item: any) => item.host.id === a.hostId).firstOnlineAt.getTime(), firstOnlineAt.getTime(), "recovery must preserve the first online time");
  assert.equal((await register(first.token, "a".repeat(64))).agentSuperseded, true);
  assert.equal((await register(second.token, "b".repeat(64))).hostId, b.hostId);
  assert.equal((await runtime.queryRaw<any>("SELECT hostId FROM forward_rules WHERE name = ?", ["restored-rule"]))[0].hostId, a.hostId);
});

test("lost responses and concurrent retries allocate only one independent Token", async () => {
  const config = await discovery.configureAgentDiscovery(1);
  const replies = await Promise.all(Array.from({ length: 8 }, () => discovery.enrollDiscoveredAgent(config.key, "3".repeat(64), "retry-host")));
  assert.equal(new Set(replies.map((item) => item.token)).size, 1);
  assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM agent_tokens WHERE discoveryRegistrationId = ?", ["3".repeat(64)]))[0].count, 1);
  assert.deepEqual(await discovery.enrollDiscoveredAgent(config.key, "3".repeat(64), "retry-host"), replies[0]);
});

test("disabling and rotating discovery rejects old enrollment but preserves installed Agent recovery", async () => {
  const original = await discovery.configureAgentDiscovery(1);
  const installed = await discovery.enrollDiscoveredAgent(original.key, "4".repeat(64), "keep-running");
  const host = await register(installed.token, "d".repeat(64));
  await discovery.configureAgentDiscovery(1, { enabled: false });
  await assert.rejects(discovery.enrollDiscoveredAgent(original.key, "5".repeat(64), "blocked"), { code: "FORBIDDEN" });
  assert.equal((await discovery.configureAgentDiscovery(1)).enabled, false, "opening the command dialog must not re-enable enrollment");
  assert.equal((await register(installed.token, "e".repeat(64))).hostId, host.hostId);
  const rotated = await discovery.configureAgentDiscovery(1, { rotate: true, enabled: true });
  assert.notEqual(original.key, rotated.key);
  await assert.rejects(discovery.enrollDiscoveredAgent(original.key, "5".repeat(64), "blocked"), { code: "FORBIDDEN" });
  assert.equal((await register(installed.token, "f".repeat(64))).hostId, host.hostId);
  await assert.rejects(discovery.enrollDiscoveredAgent(rotated.key, "invalid", "bad"), { code: "BAD_REQUEST" });
  const { isKnownAgentAuthToken } = await import("./repositories/tokenRepository");
  assert.equal(await isKnownAgentAuthToken(rotated.key), false, "discovery key is never an Agent communication credential");
  await assert.rejects(tokens.createCaller(ctx("user")).configureDiscovery({}), { code: "FORBIDDEN" });
});

test("public enrollment API validates keys and identities and serves no secret in its installer", async () => {
  const config = await discovery.configureAgentDiscovery(1);
  const request = (key: string, registrationId: string) => fetch(base + "/api/agent/discover", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ registrationId, hostname: "http-agent" }),
  });
  assert.equal((await request("wrong", "6".repeat(64))).status, 403);
  assert.equal((await request(config.key, "invalid")).status, 400);
  const response = await request(config.key, "6".repeat(64));
  assert.equal(response.status, 200);
  assert.match((await response.json()).token, /^[a-f0-9]{64}$/);
  const script = await (await fetch(base + "/api/agent/discovery.sh")).text();
  assert.ok(script.startsWith("#!/bin/bash\nPANEL_URL_DEFAULT="));
  assert.equal(script.includes(config.key), false);
  await runtime.executeRaw('UPDATE users SET accountEnabled = ? WHERE id = ?', [false, 1]);
  await assert.rejects(discovery.enrollDiscoveredAgent(config.key, "7".repeat(64), "blocked-owner"), { code: "FORBIDDEN" });
  await runtime.executeRaw('UPDATE users SET accountEnabled = ? WHERE id = ?', [true, 1]);
});

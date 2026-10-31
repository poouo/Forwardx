import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { normalizeAgentPanelUrl, hostAgentPanelUrlOverride } from "../shared/agentPanelUrl";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-panel-url-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "test.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.FORWARDX_SEAMLESS_MIGRATION_STATE_PATH = path.join(directory, "migration.json");
let runtime: typeof import("./dbRuntime");
let hosts: typeof import("./repositories/hostRepository");
let router: typeof import("./routers/hosts").hostsRouter;
let urls: typeof import("./agentPanelUrl");
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
const context = (role: "admin" | "user") => ({ user: { id: role === "admin" ? 1 : 2, role, username: role }, req: { headers: {}, socket: {} }, res: {}, authSession: null }) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, "userId" INTEGER NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId) VALUES (1,'legacy','192.0.2.1',1)");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  for (const [id, role] of [[1, "admin"], [2, "user"]] as const) {
    await runtime.insertAndGetId("users", { id, username: role, password: "unused", role });
  }
  await (await import("./repositories/settingsRepository")).setSetting("panelPublicUrl", "https://global.example.com");
  hosts = await import("./repositories/hostRepository");
  router = (await import("./routers/hosts")).hostsRouter;
  urls = await import("./agentPanelUrl");
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Agent panel URLs support custom ports, IPv6 and prefixes without accepting credentials or script syntax", () => {
  for (const [input, expected] of [
    [" https://panel.example.com:8443/ ", "https://panel.example.com:8443"],
    ["http://[2001:db8::1]:8080/forwardx/", "http://[2001:db8::1]:8080/forwardx"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ]) assert.equal(normalizeAgentPanelUrl(input), expected);
  for (const input of ["", "ftp://example.com", "https://u:p@example.com", "https://example.com/?secret=1", "https://example.com/#a", "https://example.com/$(id)", "https://example.com/a\nb", "https://example.com:99999", "not a URL"]) {
    assert.equal(normalizeAgentPanelUrl(input), "", input);
  }
  for (const enabled of [false, 0, "0", "false", null, undefined]) assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: enabled, agentPanelUrl: "https://custom.example.com" }), "");
  for (const enabled of [true, 1, "1", "true"]) assert.equal(hostAgentPanelUrlOverride({ agentPanelUrlEnabled: enabled, agentPanelUrl: "https://custom.example.com/" }), "https://custom.example.com");
});

test("legacy hosts default to global; saving, partial updates, disabling and clearing preserve expected routing", async () => {
  const admin = router.createCaller(context("admin"));
  const legacy = (await hosts.getHostById(1))!;
  assert.equal(legacy.agentPanelUrlEnabled, false);
  assert.equal(legacy.agentPanelUrl, null);
  assert.equal(await urls.resolveAgentAdvertisedPanelUrl(legacy), "https://global.example.com");
  await admin.update({ id: 1, agentPanelUrlEnabled: true, agentPanelUrl: "https://custom.example.com:8443/" });
  await admin.update({ id: 1, name: "renamed" });
  const saved = (await hosts.getHostById(1))!;
  assert.equal(saved.agentPanelUrl, "https://custom.example.com:8443");
  assert.equal(await urls.resolveAgentAdvertisedPanelUrl(saved), saved.agentPanelUrl);
  const other = await admin.create({ name: "unchanged", ip: "192.0.2.2" });
  assert.equal(await urls.resolveAgentAdvertisedPanelUrl(await hosts.getHostById(other.id)), "https://global.example.com");
  await admin.update({ id: 1, agentPanelUrlEnabled: false });
  assert.equal((await hosts.getHostById(1))?.agentPanelUrl, saved.agentPanelUrl, "off keeps the saved URL");
  assert.equal(await urls.resolveAgentAdvertisedPanelUrl(await hosts.getHostById(1)), "https://global.example.com");
  await admin.update({ id: 1, agentPanelUrl: null });
  assert.equal((await hosts.getHostById(1))?.agentPanelUrl, null);
  await assert.rejects(admin.update({ id: 1, agentPanelUrlEnabled: true }), /请填写/);
  await assert.rejects(admin.create({ name: "invalid", ip: "192.0.2.3", agentPanelUrlEnabled: true }), /请填写/);
  await assert.rejects(admin.update({ id: 1, agentPanelUrl: "https://user:pass@example.com" }));
  await assert.rejects(router.createCaller(context("user")).update({ id: 1, agentPanelUrl: "https://attacker.example.com" }), { code: "FORBIDDEN" });
});

test("bound installation tokens select the same per-host URL", async () => {
  const admin = router.createCaller(context("admin"));
  await admin.update({ id: 1, agentPanelUrlEnabled: true, agentPanelUrl: "https://install.example.com:8443" });
  await hosts.updateHost(1, { agentToken: "host-install-token" });
  const id = await runtime.insertAndGetId("agent_tokens", { token: "host-install-token", userId: 1, hostId: 1 });
  const tokens = (await import("./routers/agentTokens")).agentTokensRouter.createCaller(context("admin"));
  assert.equal((await tokens.getInstallToken({ id })).agentPanelUrl, "https://install.example.com:8443");
  await hosts.updateHost(1, { agentToken: "rotated-host-token" });
  assert.equal((await tokens.getInstallToken({ id })).agentPanelUrl, "https://install.example.com:8443", "bound host identity must survive host credential rotation");
  await hosts.updateHost(1, { agentToken: "host-install-token" });
  await admin.update({ id: 1, agentPanelUrlEnabled: false });
  assert.equal((await tokens.getInstallToken({ id })).agentPanelUrl, "");
});

test("full and busy heartbeats send host override and switch back to global when disabled", async () => {
  const app = express();
  app.use(express.json());
  const heartbeat = express.Router();
  heartbeat.use((req: any, _res, next) => { req.agentToken = "host-install-token"; next(); });
  (await import("./agentHeartbeatRoute")).registerAgentHeartbeatRoute(heartbeat);
  app.use(heartbeat);
  server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const base = `http://127.0.0.1:${(server!.address() as any).port}`;
  for (const enabled of [true, false]) {
    await router.createCaller(context("admin")).update({ id: 1, agentPanelUrlEnabled: enabled });
    for (const busy of [true, false]) {
      const response = await fetch(`${base}/api/agent/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ busy, agentVersion: "2.2.207" }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).panelUrl, enabled ? "https://install.example.com:8443" : "https://global.example.com");
    }
  }
});

test("all upgrade/rollback entrypoints use the host-aware resolver; stable responses do not reuse a stale URL", () => {
  for (const file of ["server/routers/hosts.ts", "server/telegramBot.ts", "server/_core/systemRouter.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /resolveAgentAdvertisedPanelUrl\((?:host|currentHost)\)/, file);
  }
  const heartbeat = fs.readFileSync("server/agentHeartbeatRoute.ts", "utf8");
  assert.doesNotMatch(heartbeat, /panelUrl: stablePlan\.panelUrl/);
  assert.doesNotMatch(heartbeat, /resolveAgentAdvertisedPanelUrl\(\)/);
});

test("request fallback remains available and explicit migration routing retains precedence", async () => {
  const req = { path: "/api/agent/install.sh", headers: { host: "fallback.example.com:8080" }, protocol: "http", get: () => "fallback.example.com:8080" } as any;
  const host = { agentPanelUrlEnabled: true, agentPanelUrl: "https://custom.example.com:8443" };
  assert.equal(await urls.resolvePanelUrl(req, host), host.agentPanelUrl);
  assert.equal(await urls.resolveAgentAdvertisedPanelUrl({ ...host, agentPanelUrl: "invalid" }), "https://global.example.com");
  const migration = await import("./seamlessMigrationState");
  try {
    migration.persistSeamlessMigrationState({ version: 1, id: "test-url-migration", role: "target", phase: "verifying", sourceUrl: "https://source.example.com", targetUrl: "https://target.example.com", tokenHash: "a".repeat(64), startedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    assert.equal(await urls.resolveAgentAdvertisedPanelUrl(host), "https://source.example.com");
    assert.equal(await urls.resolvePanelUrl(req, host), "https://source.example.com");
  } finally { migration.persistSeamlessMigrationState(null); }
  const settings = await import("./repositories/settingsRepository");
  try {
    await settings.setSetting("panelPublicUrl", "");
    assert.equal(await urls.resolvePanelUrl(req, { agentPanelUrlEnabled: false }), "http://fallback.example.com:8080");
    assert.equal(await urls.resolveAgentAdvertisedPanelUrl({ agentPanelUrlEnabled: false }), "", "no configured URL must not fabricate a switch");
  } finally { await settings.setSetting("panelPublicUrl", "https://global.example.com"); }
});

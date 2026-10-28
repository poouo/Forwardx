import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-traffic-shutdown-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "shutdown.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let hosts: typeof import("./repositories/hostRepository");
let metrics: typeof import("./repositories/metricsRepository");
let policy: typeof import("./hostTrafficShutdown");
let router: typeof import("./routers/hosts").hostsRouter;
const context = (id: number, role: "admin" | "user") => ({ user: { id, role, username: `user-${id}` }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;
const now = Math.floor(Date.now() / 1000);

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, userId INTEGER NOT NULL, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO hosts (id,name,ip,userId) VALUES (1,'legacy','192.0.2.1',1)");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  hosts = await import("./repositories/hostRepository");
  metrics = await import("./repositories/metricsRepository");
  policy = await import("./hostTrafficShutdown");
  router = (await import("./routers/hosts")).hostsRouter;
  for (const [id, role] of [[1, "admin"], [2, "user"]] as const) {
    await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", role });
  }
});
after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function prepare(overrides: Record<string, unknown> = {}) {
  await hosts.updateHost(1, { trafficLimit: 1000, trafficMeasureMode: "outbound", trafficShutdownEnabled: true, trafficShutdownThresholdPercent: 90, trafficShutdownTriggered: false, ...overrides });
  await runtime.executeRaw('INSERT INTO host_traffic_counters (hostId,bytesIn,bytesOut,lastReportedAt) VALUES (1,200,900,?) ON CONFLICT(hostId) DO UPDATE SET bytesIn=200,bytesOut=900,lastReportedAt=excluded.lastReportedAt', [now]);
}

test("legacy hosts and new hosts default to shutdown disabled with a 100% threshold", async () => {
  const legacy = (await hosts.getHostById(1))!;
  assert.equal(legacy.trafficShutdownEnabled, false);
  assert.equal(legacy.trafficShutdownThresholdPercent, 100);
  assert.equal(legacy.trafficShutdownTriggered, false);
  const created = await router.createCaller(context(1, "admin")).create({ name: "default", ip: "192.0.2.2" });
  assert.equal((await hosts.getHostById(created.id))?.trafficShutdownEnabled, false);
});

test("only administrators may enable shutdown; allowance and threshold are validated", async () => {
  const admin = router.createCaller(context(1, "admin"));
  const customer = router.createCaller(context(2, "user"));
  await assert.rejects(admin.create({ name: "invalid", ip: "192.0.2.3", trafficShutdownEnabled: true }), /套餐流量/);
  await assert.rejects(admin.update({ id: 1, trafficShutdownEnabled: true, trafficLimit: 0 }), /套餐流量/);
  await assert.rejects(admin.update({ id: 1, trafficShutdownThresholdPercent: 101 }));
  await assert.rejects(admin.update({ id: 1, trafficShutdownThresholdPercent: 0 }));
  await assert.rejects(customer.create({ name: "owned", ip: "192.0.2.4", trafficLimit: 1000, trafficShutdownEnabled: true, trafficShutdownThresholdPercent: 5 }), { code: "FORBIDDEN" });
  const owned = await admin.create({ name: "owned", ip: "192.0.2.4", trafficLimit: 1000 });
  assert.equal((await hosts.getHostById(owned.id))?.trafficShutdownEnabled, false);
  await assert.rejects(customer.update({ id: owned.id, trafficShutdownEnabled: true }), { code: "FORBIDDEN" });
  assert.equal((await hosts.getHostById(owned.id))?.trafficShutdownEnabled, false);
  await admin.update({ id: owned.id, trafficLimit: 1000, trafficShutdownEnabled: true, trafficShutdownThresholdPercent: 80 });
  await assert.rejects(customer.update({ id: owned.id, trafficShutdownEnabled: false, trafficShutdownThresholdPercent: 1, name: "renamed" }), { code: "FORBIDDEN" });
  const saved = (await hosts.getHostById(owned.id))!;
  assert.equal(saved.trafficShutdownEnabled, true);
  assert.equal(saved.trafficShutdownThresholdPercent, 80);
  await assert.rejects(router.createCaller(context(3, "user")).update({ id: owned.id, trafficShutdownEnabled: true }), { code: "FORBIDDEN" });
});

test("threshold uses the selected measurement mode and requires fresh real samples", async () => {
  for (const [mode, threshold, expected] of [["outbound", 91, false], ["outbound", 90, true], ["both", 100, true], ["max", 91, false], ["max", 90, true]] as const) {
    await prepare({ trafficMeasureMode: mode, trafficShutdownThresholdPercent: threshold });
    assert.equal(await policy.claimHostTrafficShutdown(1, now), expected, mode);
  }
  for (const stamp of [null, now - 121, now + 31]) {
    await prepare();
    await runtime.executeRaw('UPDATE host_traffic_counters SET lastReportedAt=? WHERE hostId=1', [stamp]);
    assert.equal(await policy.claimHostTrafficShutdown(1, now), false);
  }
  for (const overrides of [{ trafficShutdownEnabled: false }, { trafficLimit: 0 }, { trafficShutdownThresholdPercent: 101 }, { trafficShutdownTriggered: true }]) {
    await prepare(overrides);
    assert.equal(await policy.claimHostTrafficShutdown(1, now), false);
  }
  assert.equal(await policy.claimHostTrafficShutdown(-1, now), false);
  assert.equal(await policy.claimHostTrafficShutdown(999999, now), false);
});

test("concurrent claims authorize exactly once and the latch survives reconnects", async () => {
  await prepare();
  const results = await Promise.all(Array.from({ length: 8 }, () => policy.claimHostTrafficShutdown(1, now)));
  assert.equal(results.filter(Boolean).length, 1);
  await runtime.closeDatabase();
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  assert.equal(await policy.claimHostTrafficShutdown(1, now), false);
  assert.equal((await hosts.getHostById(1))?.trafficShutdownTriggered, true);
});

test("reset atomically rearms the next traffic cycle; usage corrections do not rearm", async () => {
  await prepare();
  assert.equal(await policy.claimHostTrafficShutdown(1, now), true);
  await metrics.correctHostTraffic(1, 950, "outbound");
  assert.equal(await policy.claimHostTrafficShutdown(1, now), false);
  await assert.rejects(runtime.withDatabaseTransaction(async () => { await metrics.resetHostTraffic(1); throw new Error("rollback"); }), /rollback/);
  assert.equal((await hosts.getHostById(1))?.trafficShutdownTriggered, true);
  await metrics.resetHostTraffic(1);
  assert.equal((await hosts.getHostById(1))?.trafficShutdownTriggered, false);
  assert.equal(await policy.claimHostTrafficShutdown(1, now), false, "a stale instruction cannot shut down a reset host");
  await metrics.correctHostTraffic(1, 900, "outbound");
  assert.equal(await policy.claimHostTrafficShutdown(1, now), true);
});

test("saving an unchanged switch preserves the latch; disabling and saving rearms it", async () => {
  await prepare();
  await policy.claimHostTrafficShutdown(1, now);
  const admin = router.createCaller(context(1, "admin"));
  await admin.update({ id: 1, trafficShutdownEnabled: true, trafficShutdownThresholdPercent: 80 });
  assert.equal(await policy.claimHostTrafficShutdown(1, now), false);
  await admin.update({ id: 1, trafficShutdownEnabled: false });
  assert.equal(await policy.claimHostTrafficShutdown(1, now), false, "a stale instruction cannot override the disabled switch");
  await admin.update({ id: 1, trafficShutdownEnabled: true });
  assert.equal(await policy.claimHostTrafficShutdown(1, now), true);
});

test("both heartbeat lanes advertise and handle the shutdown check before early returns", () => {
  const agent = fs.readFileSync("agent/main.go", "utf8");
  for (const [start, end] of [["func heartbeat(cfg", "func heartbeatKeepalive("], ["func heartbeatKeepalive(", "func heartbeatPresence("]]) {
    const lane = agent.slice(agent.indexOf(start), agent.indexOf(end));
    assert.match(lane, /handleTrafficShutdownCheck\(cfg, resp.TrafficShutdownCheck\)/);
  }
  assert.match(agent, /fields\["trafficShutdownSupported"\] = trafficShutdownSupported\(\)/);
  const routes = fs.readFileSync("server/agentRoutes.ts", "utf8");
  assert.match(routes, /registerAgentTrafficShutdownRoutes\(agentApiRouter\)/);
  const source = fs.readFileSync("server/agentHeartbeatRoute.ts", "utf8");
  assert.equal((source.match(/trafficShutdownCheck[, }]/g) || []).length >= 3, true);
});

test("HTTP shutdown claims use the authenticated host, not request IDs; old Agents are not instructed", async () => {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.json());
  // Encryption/auth proof transport is tested separately; route tests provide
  // the resolved credential in the same field as the production middleware.
  app.use((req, _res, next) => { (req as any).agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
  policy.registerAgentTrafficShutdownRoutes(app);
  (await import("./agentHeartbeatRoute")).registerAgentHeartbeatRoute(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const request = (url: string, token: string, body = {}) => fetch(base + url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
  try {
    await prepare({ agentToken: "shutdown-test-token" });
    assert.equal((await request("/api/agent/traffic-shutdown-claim", "invalid-token")).status, 401);
    const body = { agentVersion: "2.2.199", busy: true, forceReconcile: true };
    const legacy = await request("/api/agent/heartbeat", "shutdown-test-token", body);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).trafficShutdownCheck, false);
    const supported = await request("/api/agent/heartbeat", "shutdown-test-token", { ...body, trafficShutdownSupported: true });
    assert.equal(supported.status, 200);
    assert.equal((await supported.json()).trafficShutdownCheck, true);
    const claimed = await request("/api/agent/traffic-shutdown-claim", "shutdown-test-token", { hostId: 999999 });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).allowed, true);
    assert.equal((await hosts.getHostById(1))?.trafficShutdownTriggered, true);
    const replay = await request("/api/agent/traffic-shutdown-claim", "shutdown-test-token");
    assert.equal((await replay.json()).allowed, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

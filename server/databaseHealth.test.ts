import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseHealthTracker, databaseHealth, describeDatabaseError } from "./databaseHealthState";
import { startDatabaseHealthMonitor, probeDatabase } from "./databaseHealthMonitor";
import { databaseRequestErrorHandler, databaseUnavailableApiGuard, registerDatabaseHealthRoutes } from "./databaseHealthRoutes";
import { createContext } from "./_core/context";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { createNonOverlappingScheduledTask } from "./scheduledTask";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../shared/databaseHealth";
import net from "node:net";

const refused = Object.assign(new Error("connect ECONNREFUSED postgres://admin:secret@private-db:5432/db SQL password=secret"), { code: "ECONNREFUSED" });
const config = { type: "postgresql" as const, postgresql: { host: "127.0.0.1", port: 5432, user: "test", password: "secret", database: "test" } };

test("database errors are classified through driver wrappers without disclosing secrets", () => {
  const cases = [
    ["ECONNREFUSED", /拒绝/], ["ENOTFOUND", /解析/], ["ETIMEDOUT", /超时/],
    ["57P01", /中断/], ["28P01", /认证/], ["53300", /上限/], ["SQLITE_FULL", /存储/],
    ["CERT_HAS_EXPIRED", /证书/],
  ] as const;
  for (const [code, message] of cases) {
    const reason = describeDatabaseError(new Error("SQL params secret", { cause: Object.assign(new Error("sensitive"), { code }) }));
    assert.ok(reason);
    assert.match(reason.message, message);
    assert.doesNotMatch(JSON.stringify(reason), /secret|sensitive|SQL params/);
  }
  assert.equal(describeDatabaseError(Object.assign(new Error("duplicate"), { code: "23505" })), null);
  assert.equal(describeDatabaseError(Object.assign(new Error("invalid SQL"), { code: "42601" })), null);
  assert.equal(describeDatabaseError(new Error("bad password")), null);
  const cyclic: any = new Error("cycle"); cyclic.cause = cyclic;
  assert.equal(describeDatabaseError(cyclic), null);
  assert.deepEqual(describeDatabaseError(new AggregateError([refused])), describeDatabaseError(refused));
});

test("health logs are bounded, startup is distinct from setup, and recovery clears errors", () => {
  const logs: string[] = [];
  const tracker = new DatabaseHealthTracker((message) => logs.push(message));
  tracker.configure("postgresql");
  tracker.healthy();
  for (let i = 0; i < 100; i++) tracker.unavailable(refused);
  assert.equal(logs.length, 1);
  assert.equal(tracker.snapshot().state, "unavailable");
  assert.ok(tracker.snapshot().unavailableSince);
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /secret|private-db|admin/);
  tracker.healthy();
  assert.equal(logs.length, 2);
  assert.equal(tracker.snapshot().reason, null);
  tracker.unavailable(new Error("SQL contains a secret"), true);
  assert.equal(tracker.snapshot().reason?.code, "INITIALIZATION_FAILED");
  tracker.notConfigured();
  assert.equal(tracker.snapshot().state, "not_configured");
});

test("monitor is single-flight and runtime recovery does not rerun schema migrations", async () => {
  let release!: () => void;
  let fail = true;
  let probes = 0;
  let initializations = 0;
  const monitor = startDatabaseHealthMonitor({
    initialized: true, readConfig: () => config, intervalMs: 100_000,
    initialize: async () => { initializations++; return { ready: true }; }, onReady() {},
    probe: async () => { probes++; await new Promise<void>((resolve) => { release = resolve; }); if (fail) throw refused; },
  });
  try {
    databaseHealth.healthy();
    const first = monitor.check();
    await Promise.all(Array.from({ length: 20 }, () => monitor.check()));
    assert.equal(probes, 1);
    release(); await first;
    assert.equal(databaseHealth.snapshot().state, "unavailable");
    fail = false;
    const recovery = monitor.check(); release(); await recovery;
    assert.equal(databaseHealth.snapshot().state, "healthy");
    assert.equal(initializations, 0);
  } finally { monitor.stop(); databaseHealth.healthy(); }
});

test("a failed connection at boot initializes and starts background work once after recovery", async () => {
  let ready = 0;
  let initialized = 0;
  databaseHealth.unavailable(refused, true);
  const monitor = startDatabaseHealthMonitor({ initialized: false, readConfig: () => config, intervalMs: 100_000, probe: async () => {}, initialize: async () => { initialized++; return { ready: true }; }, onReady: () => { ready++; } });
  try {
    await monitor.check(); await monitor.check();
    assert.equal(initialized, 1); assert.equal(ready, 1);
    assert.equal(databaseHealth.snapshot().state, "healthy");
  } finally { monitor.stop(); databaseHealth.healthy(); }
});

test("startup schema failures do not trigger recurring migration attempts", async () => {
  let initialized = 0;
  databaseHealth.unavailable(new Error("schema SQL secret"), true);
  const monitor = startDatabaseHealthMonitor({ initialized: false, readConfig: () => config, intervalMs: 100_000, probe: async () => {}, initialize: async () => { initialized++; return { ready: true }; }, onReady() {} });
  try {
    await monitor.check(); await monitor.check();
    assert.equal(initialized, 0);
    assert.equal(databaseHealth.snapshot().state, "unavailable");
  } finally { monitor.stop(); databaseHealth.healthy(); }
});

test("Web and diagnostic endpoints survive DB failure, business requests return 503", async () => {
  const app = express();
  registerDatabaseHealthRoutes(app);
  app.use(databaseUnavailableApiGuard);
  app.get("/api/test", (_req, res, next) => next(refused));
  app.use(databaseRequestErrorHandler);
  app.get("/", (_req, res) => res.type("html").send("<html>ForwardX Web</html>"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    databaseHealth.healthy();
    const first = await fetch(`${base}/api/test`);
    assert.equal(first.status, 503);
    assert.equal(first.headers.get("retry-after"), "15");
    assert.doesNotMatch(await first.text(), /secret|private-db/);
    const diagnostic = await fetch(`${base}/api/database-health`);
    assert.equal(diagnostic.status, 200);
    assert.match(diagnostic.headers.get("cache-control") || "", /no-store/);
    assert.equal((await diagnostic.json()).reason.code, "ECONNREFUSED");
    assert.equal((await fetch(`${base}/`)).status, 200);
    databaseHealth.healthy();
    assert.equal((await (await fetch(`${base}/api/database-health`)).json()).state, "healthy");
  } finally { databaseHealth.healthy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("DB outages preserve session cookies and fail closed without granting administrator access", async () => {
  databaseHealth.unavailable(refused);
  let cleared = false;
  const req: any = { headers: {}, cookies: { app_session_id: "existing-cookie" } };
  const res: any = { clearCookie() { cleared = true; } };
  try {
    await assert.rejects(() => createContext({ req, res, info: {} as any }), (error: any) => error.code === "SERVICE_UNAVAILABLE" && error.message === DATABASE_UNAVAILABLE_MESSAGE);
    assert.equal(cleared, false);
    const api = router({ read: publicProcedure.query(() => "private"), admin: adminProcedure.query(() => "private admin") });
    const caller = api.createCaller({ req, res, user: null, authSession: null, authFailureReason: null });
    await assert.rejects(() => caller.read(), (error: any) => error.code === "SERVICE_UNAVAILABLE");
    await assert.rejects(() => caller.admin(), (error: any) => error.code === "SERVICE_UNAVAILABLE");
    databaseHealth.healthy();
    await assert.rejects(() => caller.admin(), (error: any) => error.code === "UNAUTHORIZED");
    assert.equal(await caller.read(), "private");
  } finally { databaseHealth.healthy(); }
});

test("business SQL errors are not mistaken for a database outage", async () => {
  databaseHealth.healthy();
  const api = router({ query: publicProcedure.query(() => { throw Object.assign(new Error("unique constraint"), { code: "23505" }); }) });
  const caller = api.createCaller({ req: { headers: {} } as any, res: {} as any, user: null, authSession: null, authFailureReason: null });
  await assert.rejects(() => caller.query(), /unique constraint/);
  assert.equal(databaseHealth.snapshot().state, "healthy");
});

test("testing another database or an external API does not mark the main database unavailable", async () => {
  databaseHealth.healthy();
  const api = router({ testConnection: publicProcedure.query(() => { throw refused; }) });
  const caller = api.createCaller({ req: { headers: {} } as any, res: {} as any, user: null, authSession: null, authFailureReason: null });
  await assert.rejects(() => caller.testConnection(), /ECONNREFUSED/);
  assert.equal(databaseHealth.snapshot().state, "healthy");
});

test("scheduler tasks can pause during an outage and resume without overlapping", async () => {
  let runs = 0;
  let available = false;
  const task = createNonOverlappingScheduledTask("database test", async () => { runs++; }, { shouldRun: () => available });
  assert.equal(await task(), false); assert.equal(runs, 0);
  available = true;
  assert.equal(await task(), true); assert.equal(runs, 1);
});

test("connection retries are single-flight and idle PostgreSQL errors never escape the pool", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import pg from "pg";
    import { sql } from "drizzle-orm";
    const runtime = await import("./server/dbRuntime.ts");
    const { databaseHealth } = await import("./server/databaseHealthState.ts");
    const config = { type: "postgresql", postgresql: { host: "127.0.0.1", port: 5432, user: "test", password: "secret", database: "test" } };
    const original = pg.Pool.prototype.query;
    let probes = 0;
    let release;
    pg.Pool.prototype.query = async () => { probes++; await new Promise((resolve) => { release = resolve; }); return { rows: [{ "?column?": 1 }] }; };
    try {
      databaseHealth.healthy();
      const connections = Array.from({ length: 20 }, () => runtime.connectDatabase(config));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(probes, 1);
      release();
      const dbs = await Promise.all(connections);
      assert.ok(dbs.every((db) => db === dbs[0]));
      const pool = runtime.getPostgresPool(); assert.ok(pool);
      assert.doesNotThrow(() => pool.emit("error", Object.assign(new Error("administrator stopped database"), { code: "57P01" })));
      assert.equal(databaseHealth.snapshot().state, "unavailable");
      databaseHealth.healthy();
      pg.Pool.prototype.query = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
      await assert.rejects(() => dbs[0].execute(sql.raw("SELECT 1")));
      assert.equal(databaseHealth.snapshot().state, "unavailable", "direct Drizzle queries must record actual DB failures");
    } finally { pg.Pool.prototype.query = original; await runtime.closeDatabase(); }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000, env: { ...process.env, DATABASE_TYPE: "postgresql" } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("a diagnostic probe has a bounded timeout when PostgreSQL accepts TCP but never responds", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const started = Date.now();
  try {
    await assert.rejects(() => probeDatabase({ ...config, postgresql: { ...config.postgresql, port: address.port } }));
    assert.ok(Date.now() - started < 6000);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("real panel startup with PostgreSQL down still serves Web diagnostics and survives Agent requests", { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-db-outage-"));
  const reservations = [net.createServer(), net.createServer()];
  for (const server of reservations) { server.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve)); }
  const ports = reservations.map((server) => { const address = server.address(); assert.ok(address && typeof address === "object"); return address.port; });
  for (const server of reservations) await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, NODE_ENV: "production", FORWARDX_DEV_PANEL: "1", FORWARDX_DEV_SERVER_HOST: "127.0.0.1", PORT: String(ports[0]), DATABASE_TYPE: "postgresql", POSTGRES_URL: `postgresql://test:outage-test-secret@127.0.0.1:${ports[1]}/test`, DATABASE_CONFIG_PATH: path.join(directory, "database.json"), MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"), SQLITE_PATH: path.join(directory, "unused.db"), JWT_SECRET: "forwardx-database-outage-test-cookie-secret", PANEL_SSL_ENABLED: "false" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-80_000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-80_000); });
  const base = `http://127.0.0.1:${ports[0]}`;
  try {
    let status: any = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, output);
      try { status = await (await fetch(`${base}/api/database-health`, { signal: AbortSignal.timeout(500) })).json(); } catch {}
      if (status) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status?.state, "unavailable", output);
    assert.equal(status.reason.code, "ECONNREFUSED");
    assert.doesNotMatch(JSON.stringify(status), /outage-test-secret|postgresql:\/\/|127\.0\.0\.1/);
    // The source server shares the built frontend directory used in production.
    const web = await fetch(`${base}/`);
    assert.equal(web.status, 200, output);
    const html = await web.text();
    assert.match(html, /<html/);
    const script = html.match(/src="([^" ]+\.js)"/);
    assert.ok(script, "built page must reference its JavaScript bundle");
    const asset = await fetch(`${base}${script[1]}`);
    assert.equal(asset.status, 200, "the failure page bundle must not query the database");
    await asset.arrayBuffer();
    for (const endpoint of ["/api/agent/heartbeat", "/api/sync", "/api/stream"]) {
      assert.equal((await fetch(`${base}${endpoint}`, { method: endpoint === "/api/stream" ? "GET" : "POST" })).status, 503);
    }
    const auth = await fetch(`${base}/api/trpc/auth.me`, { headers: { Cookie: "app_session_id=existing-cookie" } });
    assert.equal(auth.status, 503);
    assert.equal(auth.headers.get("set-cookie"), null);
    assert.match(await auth.text(), /数据库暂时不可用/);
    assert.equal((await fetch(`${base}/api/database-health`)).status, 200);
    assert.equal(child.exitCode, null, output);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited; clearTimeout(timer);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseHealthTracker, databaseHealth, describeDatabaseError } from "./databaseHealthState";
import { startDatabaseHealthMonitor, probeDatabase, databaseHealthMonitorSettings } from "./databaseHealthMonitor";
import { databaseRequestErrorHandler, databaseUnavailableApiGuard, registerDatabaseHealthRoutes } from "./databaseHealthRoutes";
import { createContext } from "./_core/context";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { createNonOverlappingScheduledTask } from "./scheduledTask";
import { DATABASE_UNAVAILABLE_MESSAGE, SERVICE_BUSY_MESSAGE } from "../shared/databaseHealth";
import net from "node:net";
import { DatabaseLeaseClosedError, DatabaseNetworkTimeoutError, isDatabaseGuardRequestError, isDatabaseNetworkTimeoutError } from "./databaseNetworkGuard";
import { reportDatabaseErrors } from "./dbRuntime";

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

test("MySQL host authorization errors are explicit through codes, errno and message-only wrappers", () => {
  const sensitive = "Host '172.27.0.2' is not allowed to connect to this MySQL server password=private-secret SQL=private-query";
  const errors = [
    Object.assign(new Error(sensitive), {code:"ER_HOST_NOT_PRIVILEGED"}),
    {errno:1130,sqlMessage:sensitive},
    new Error(sensitive),
    new Error("Failed query: private-query", {cause:{errno:1130,message:sensitive}}),
    new AggregateError([{code:"ER_HOST_NOT_PRIVILEGED",message:sensitive}]),
  ];
  for (const error of errors) {
    const tracker = new DatabaseHealthTracker(() => {});
    tracker.configure("mysql");
    tracker.unavailable(error, true);
    assert.equal(tracker.snapshot().reason?.code, "ER_HOST_NOT_PRIVILEGED");
    assert.match(tracker.snapshot().reason!.message, /不允许.*主机连接/);
    assert.match(tracker.snapshot().reason!.suggestion, /Host.*Docker/);
    assert.equal(tracker.canRetryInitialization(), true);
    assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /172\.27|private-secret|private-query/);
  }
  assert.equal(describeDatabaseError({code:"ER_HOST_IS_BLOCKED"})?.code,"ER_HOST_IS_BLOCKED");
  assert.match(describeDatabaseError({errno:1045})!.message,/认证失败/);
  assert.match(describeDatabaseError({errno:1044})!.message,/无权访问/);
  assert.equal(describeDatabaseError({code:"private-secret",message:"connection terminated unexpectedly"})?.code,"CONNECTION_LOST");
});

test("upgrade errors have actionable safe summaries only during initialization", () => {
  const cases = [
    ["ER_TABLEACCESS_DENIED_ERROR",/权限/], ["42501",/权限/],
    ["ER_BAD_FIELD_ERROR",/缺失/], ["42P01",/缺失/],
    ["ER_PARSE_ERROR",/SQL/], ["42601",/SQL/],
    ["ER_TOO_LONG_KEY",/大小/], ["ER_TOO_BIG_ROWSIZE",/大小/],
    ["ER_DUP_ENTRY",/重复/], ["23505",/重复/],
    ["ER_RECORD_FILE_FULL",/空间/], ["53100",/空间/],
    ["ER_LOCK_WAIT_TIMEOUT",/锁/], ["40P01",/锁/],
  ] as const;
  for (const [code, message] of cases) {
    const error = new Error("SQL private-query password=private-secret", {cause:{code}});
    assert.equal(describeDatabaseError(error),null,"ordinary business SQL errors must not take the panel offline");
    const reason = describeDatabaseError(error,true);
    assert.ok(reason);
    assert.equal(reason.code,code);
    assert.match(reason.message,message);
    assert.match(reason.suggestion,/重启面板/);
    assert.doesNotMatch(JSON.stringify(reason),/private-query|private-secret/);
  }
  const tracker = new DatabaseHealthTracker(() => {});
  tracker.unavailable({errno:1142},true);
  assert.equal(tracker.canRetryInitialization(),false);
  const initialReason = tracker.snapshot().reason;
  tracker.unavailable(refused,true);
  assert.deepEqual(tracker.snapshot().reason,initialReason,"network probes retain the original migration failure");
  tracker.healthy();
  assert.equal(tracker.canRetryInitialization(),true);
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
    initialized: true, readConfig: () => config, intervalMs: 100_000, failureThreshold: 1,
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

test("transient probe failures require confirmation and a successful check resets the streak", async () => {
  let fail = true;
  const warnings: string[] = [];
  const monitor = startDatabaseHealthMonitor({ initialized: true, readConfig: () => config, intervalMs: 100_000,
    initialize: async () => { throw new Error("must not migrate"); }, onReady() {},
    probe: async () => { if (fail) throw { code: "ETIMEDOUT", message: "secret SQL" }; },
    logger: { warn: message => warnings.push(message) },
  });
  try {
    databaseHealth.healthy();
    await monitor.check(); await monitor.check();
    assert.equal(databaseHealth.snapshot().state, "healthy");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failures=1\/3.*eventLoopUtilization=/);
    assert.doesNotMatch(warnings[0], /secret|SQL/);
    fail = false; await monitor.check();
    fail = true; await monitor.check(); await monitor.check();
    assert.equal(databaseHealth.snapshot().state, "healthy", "a success must break the failure streak");
    await monitor.check();
    assert.equal(databaseHealth.snapshot().state, "unavailable");
    fail = false; await monitor.check();
    assert.equal(databaseHealth.snapshot().state, "healthy");
  } finally { monitor.stop(); databaseHealth.healthy(); }
});

test("business query timeouts fail their request without immediately taking the whole panel offline", () => {
  const tracker = new DatabaseHealthTracker(() => {});
  tracker.healthy();
  assert.equal(tracker.unavailable({ code: "ETIMEDOUT" }), true);
  assert.equal(tracker.snapshot().state, "healthy");
  tracker.unavailable({ code: "ETIMEDOUT" }, false, true);
  assert.equal(tracker.snapshot().state, "unavailable", "confirmed probe failures still take the database offline");
  tracker.healthy();
  tracker.unavailable({ code: "ETIMEDOUT" }, true);
  assert.equal(tracker.snapshot().state, "unavailable", "startup cannot proceed on a failed connection");
});

test("local closed leases cannot poison DB health, but real disconnects and startup failures still do", () => {
  const local = new DatabaseLeaseClosedError();
  const wrapped = new Error("Failed query: private-query params=private-secret", { cause: local });
  const aggregate = new AggregateError([wrapped]);
  for (const error of [local, wrapped, aggregate]) {
    const tracker = new DatabaseHealthTracker(() => {});
    tracker.configure("mysql"); tracker.healthy();
    assert.equal(isDatabaseGuardRequestError(error), true);
    assert.equal(describeDatabaseError(error), null);
    assert.equal(tracker.unavailable(error), false);
    assert.equal(tracker.snapshot().state, "healthy");
    tracker.unavailable(error, true);
    assert.equal(tracker.snapshot().state, "unavailable", "failed initialization must never be reported ready");
  }
  for (const code of ["PROTOCOL_CONNECTION_LOST", "ECONNREFUSED", "ER_ACCESS_DENIED_ERROR", "57P01"]) {
    const tracker = new DatabaseHealthTracker(() => {}); tracker.healthy();
    const driverError = { code, message: "sensitive-driver-details" };
    assert.equal(isDatabaseGuardRequestError(driverError), false);
    tracker.unavailable(new AggregateError([local, driverError]));
    assert.equal(tracker.snapshot().state, "unavailable");
    assert.equal(tracker.snapshot().reason?.code, code);
  }
  assert.equal(isDatabaseGuardRequestError({ code: "DATABASE_LEASE_CLOSED" }), false, "only trusted local error instances qualify");
  const cyclic: any = {}; cyclic.cause = cyclic;
  assert.equal(isDatabaseGuardRequestError(cyclic), false);
});

test("authentication, storage and TLS probe failures are immediate, never hidden by debounce", async () => {
  for (const code of ["28P01", "SQLITE_CORRUPT", "CERT_HAS_EXPIRED"]) {
    databaseHealth.healthy();
    const monitor = startDatabaseHealthMonitor({ initialized: true, readConfig: () => config, intervalMs: 100_000,
      initialize: async () => ({ ready: true }), onReady() {}, probe: async () => { throw { code }; } });
    try { await monitor.check(); assert.equal(databaseHealth.snapshot().reason?.code, code); }
    finally { monitor.stop(); databaseHealth.healthy(); }
  }
});

test("stopping the health monitor ignores a late probe failure", async () => {
  let reject!: (error: unknown) => void;
  databaseHealth.healthy();
  const monitor = startDatabaseHealthMonitor({ initialized: true, readConfig: () => config, intervalMs: 100_000,
    initialize: async () => ({ ready: true }), onReady() {},
    probe: () => new Promise<void>((_resolve, fail) => { reject = fail; }) });
  try {
    const pending = monitor.check();
    monitor.stop();
    reject({ code: "28P01" });
    await pending;
    assert.equal(databaseHealth.snapshot().state, "healthy");
  } finally { monitor.stop(); databaseHealth.healthy(); }
});

test("health monitor configuration uses bounded defaults and ignores malformed values", () => {
  assert.deepEqual(databaseHealthMonitorSettings({}), { intervalMs: 15000, timeoutMs: 6000, failureThreshold: 3 });
  assert.deepEqual(databaseHealthMonitorSettings({ FORWARDX_DB_HEALTH_INTERVAL_MS: "30000", FORWARDX_DB_HEALTH_TIMEOUT_MS: "10000", FORWARDX_DB_HEALTH_FAILURE_THRESHOLD: "4" }),
    { intervalMs: 30000, timeoutMs: 10000, failureThreshold: 4 });
  assert.deepEqual(databaseHealthMonitorSettings({ FORWARDX_DB_HEALTH_INTERVAL_MS: "bad", FORWARDX_DB_HEALTH_TIMEOUT_MS: "", FORWARDX_DB_HEALTH_FAILURE_THRESHOLD: "Infinity" }),
    { intervalMs: 15000, timeoutMs: 6000, failureThreshold: 3 });
  assert.deepEqual(databaseHealthMonitorSettings({ FORWARDX_DB_HEALTH_INTERVAL_MS: " ", FORWARDX_DB_HEALTH_TIMEOUT_MS: "\t", FORWARDX_DB_HEALTH_FAILURE_THRESHOLD: " " }),
    { intervalMs: 15000, timeoutMs: 6000, failureThreshold: 3 });
  assert.deepEqual(databaseHealthMonitorSettings({ FORWARDX_DB_HEALTH_INTERVAL_MS: "1", FORWARDX_DB_HEALTH_TIMEOUT_MS: "9999999", FORWARDX_DB_HEALTH_FAILURE_THRESHOLD: "0" }),
    { intervalMs: 5000, timeoutMs: 60000, failureThreshold: 1 });
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

test("specific migration failures remain blocked across network loss and restored probes", async () => {
  let initializations = 0;
  let failProbe = true;
  databaseHealth.healthy();
  databaseHealth.unavailable({code:"ER_TABLEACCESS_DENIED_ERROR"},true);
  const monitor = startDatabaseHealthMonitor({
    initialized:false,readConfig:() => config,intervalMs:100_000,
    probe:async () => {if (failProbe) throw refused;},
    initialize:async () => {initializations++;return {ready:true};},onReady() {},
  });
  try {
    await monitor.check();
    failProbe = false;
    await monitor.check();await monitor.check();
    assert.equal(initializations,0);
    assert.equal(databaseHealth.snapshot().reason?.code,"ER_TABLEACCESS_DENIED_ERROR");
    assert.equal(databaseHealth.snapshot().restartRequired,true);
  } finally {monitor.stop();databaseHealth.healthy();}
});

test("corrected MySQL host authorization initializes once after a successful connection probe", async () => {
  let initializations = 0;
  let ready = 0;
  databaseHealth.healthy();
  databaseHealth.unavailable({code:"ER_HOST_NOT_PRIVILEGED"},true);
  const monitor = startDatabaseHealthMonitor({initialized:false,readConfig:() => config,intervalMs:100_000,probe:async () => {},initialize:async () => {initializations++;return {ready:true};},onReady:() => {ready++;}});
  try {
    await monitor.check();await monitor.check();
    assert.equal(initializations,1);assert.equal(ready,1);
    assert.equal(databaseHealth.snapshot().state,"healthy");
  } finally {monitor.stop();databaseHealth.healthy();}
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

test("one timed-out HTTP query returns 503 without blocking unrelated requests or clearing cookies", async () => {
  const app = express();
  registerDatabaseHealthRoutes(app);
  app.use(databaseUnavailableApiGuard);
  app.get("/api/slow", (_req, _res, next) => next({ code: "ETIMEDOUT" }));
  app.get("/api/ok", (_req, res) => res.json({ ok: true }));
  app.use(databaseRequestErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    databaseHealth.healthy();
    const failed = await fetch(`${base}/api/slow`, { headers: { Cookie: "app_session_id=existing-cookie" } });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("set-cookie"), null);
    await failed.text();
    assert.equal((await (await fetch(`${base}/api/database-health`)).json()).state, "healthy");
    const okay = await fetch(`${base}/api/ok`);
    assert.equal(okay.status, 200);
    assert.deepEqual(await okay.json(), { ok: true });
  } finally {
    databaseHealth.healthy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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

test("reporting a closed lease fails only that tRPC request with a safe response", async () => {
  databaseHealth.healthy();
  const api = router({
    failed: publicProcedure.mutation(() => reportDatabaseErrors(async () => {
      throw new Error("Failed query: private-query params=private-secret", { cause: new DatabaseLeaseClosedError() });
    })),
    okay: publicProcedure.query(() => "still available"),
    admin: adminProcedure.query(() => "private"),
  });
  const caller = api.createCaller({ req: { headers: {} } as any, res: {} as any, user: null, authSession: null, authFailureReason: null });
  try {
    await assert.rejects(() => caller.failed(), (error: any) => {
      assert.equal(error.code, "SERVICE_UNAVAILABLE");
      assert.equal(error.message, SERVICE_BUSY_MESSAGE);
      assert.doesNotMatch(error.message, /private-query|private-secret/);
      return true;
    });
    assert.equal(databaseHealth.snapshot().state, "healthy");
    assert.equal(await caller.okay(), "still available");
    await assert.rejects(() => caller.admin(), (error: any) => error.code === "UNAUTHORIZED");
  } finally { databaseHealth.healthy(); }
});

test("a local lease error over HTTP preserves cookies and leaves other APIs available", async () => {
  const app = express();
  registerDatabaseHealthRoutes(app);
  app.use(databaseUnavailableApiGuard);
  app.get("/api/expired", (_req, _res, next) => next(new Error("private-query", { cause: new DatabaseLeaseClosedError() })));
  app.get("/api/okay", (_req, res) => res.json({ ok: true }));
  app.use(databaseRequestErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    databaseHealth.healthy();
    const failed = await fetch(`${base}/api/expired`, { headers: { Cookie: "app_session_id=existing-cookie" } });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("set-cookie"), null);
    assert.deepEqual(await failed.json(), { error: SERVICE_BUSY_MESSAGE, code: "SERVICE_UNAVAILABLE" });
    assert.equal((await (await fetch(`${base}/api/database-health`)).json()).state, "healthy");
    assert.equal((await fetch(`${base}/api/okay`)).status, 200);
  } finally {
    databaseHealth.healthy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a database query deadline stays a safe tRPC 503 even while global health remains healthy", async () => {
  databaseHealth.healthy();
  const timeout = new DatabaseNetworkTimeoutError("query");
  const api = router({ query: publicProcedure.query(() => {
    throw new Error("Failed query: SQL private-query params=private-secret", { cause: timeout });
  }) });
  const caller = api.createCaller({ req: { headers: {} } as any, res: {} as any, user: null, authSession: null, authFailureReason: null });
  await assert.rejects(() => caller.query(), (error: any) => {
    assert.equal(error.code, "SERVICE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /private-query|private-secret/);
    return true;
  });
  assert.equal(databaseHealth.snapshot().state, "healthy");
  assert.equal(isDatabaseNetworkTimeoutError(new AggregateError([timeout])), true);
  assert.equal(isDatabaseNetworkTimeoutError({ code: "ETIMEDOUT" }), false, "external API timeouts are not database-operation deadlines");
  const cyclic: any = {}; cyclic.cause = cyclic;
  assert.equal(isDatabaseNetworkTimeoutError(cyclic), false);
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
    const original = pg.Pool.prototype.connect;
    let probes = 0;
    let release;
    let query = async () => { probes++; await new Promise((resolve) => { release = resolve; }); return { rows: [{ "?column?": 1 }] }; };
    pg.Pool.prototype.connect = async () => ({ query: (...args) => query(...args), release() {} });
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
      query = async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); };
      await assert.rejects(() => dbs[0].execute(sql.raw("SELECT 1")));
      assert.equal(databaseHealth.snapshot().state, "unavailable", "direct Drizzle queries must record actual DB failures");
    } finally { pg.Pool.prototype.connect = original; await runtime.closeDatabase(); }
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
    await assert.rejects(() => probeDatabase({ ...config, postgresql: { ...config.postgresql, port: address.port } }, { timeoutMs: 250 }));
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

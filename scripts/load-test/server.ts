/** Isolated benchmark entry. Only the local summary worker is allowed; no bots, probes or Agents. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import inspector from "node:inspector";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

const directory = process.env.FORWARDX_BENCH_DIR!;
if (!directory || !process.send || process.env.FORWARDX_DEV_PANEL !== "0"
  || path.dirname(path.resolve(directory)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
  || !path.basename(directory).startsWith("forwardx-load-test-")
  || path.resolve(process.env.SQLITE_PATH!) !== path.join(directory, "fixture.db")) {
  throw new Error("Benchmark must be launched by scripts/load-test.mjs with an isolated database");
}
// No benchmark request is allowed to use the internet (including geolocation).
globalThis.fetch = (async () => { throw new Error("Outbound fetch disabled in benchmark"); }) as typeof fetch;
// Import production modules only after the isolation checks: importing ENV can
// otherwise create a persistent secret in a developer's normal data directory.
const { connectDatabase, closeDatabase, withSqliteExclusive } = await import("../../server/dbRuntime");
const { ensureDatabaseSchema } = await import("../../server/dbSchema");
const { appRouter } = await import("../../server/routers");
const { createContext } = await import("../../server/_core/context");
const { registerAgentHeartbeatRoute } = await import("../../server/agentHeartbeatRoute");
const { AGENT_VERSION } = await import("../../shared/versions");
const userCount = Number(process.env.FORWARDX_BENCH_USERS || 500);
const hostCount = 50;
const rulesPerUser = 20;
const now = Math.floor(Date.now() / 1000);
await connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
await ensureDatabaseSchema();
const tokens: string[] = [];
await withSqliteExclusive((sqlite) => {
  const insert = (table: string, columns: string[]) => sqlite.prepare(
    `INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const user = insert("users", ["id", "username", "password", "name", "role", "canAddRules", "manualCanAddRules", "balanceCents", "browserSessionToken"]);
  const session = insert("auth_sessions", ["sid", "userId", "kind", "expiresAt", "lastSeenAt"]);
  const host = insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "geoCountryCode", "geoUpdatedAt", "agentToken", "agentVersion", "hostStatusNotifyEnabled"]);
  const permission = insert("user_host_permissions", ["userId", "hostId"]);
  const rule = insert("forward_rules", ["id", "hostId", "userId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "isEnabled"]);
  const traffic = insert("traffic_stats", ["ruleId", "hostId", "bytesIn", "bytesOut", "recordedAt"]);
  const bucket = insert("traffic_stat_buckets", ["bucketStart", "bucketMinutes", "ruleId", "hostId", "userId", "bytesIn", "bytesOut"]);
  const counter = insert("forward_rule_traffic_counters", ["ruleId", "hostId", "userId", "bytesIn", "bytesOut"]);
  const userCounter = insert("user_traffic_counters", ["userId", "bytesIn", "bytesOut"]);
  const balance = insert("balance_transactions", ["userId", "type", "amountCents", "balanceAfterCents", "description", "createdAt"]);
  sqlite.transaction(() => {
    for (let h = 1; h <= hostCount; h++) host.run(h, `Bench host ${h}`, `192.0.2.${h}`, `192.0.2.${h}`, 1, 0, now, "ZZ", now, `benchmark-agent-${h}`, AGENT_VERSION, 0);
    for (let u = 1; u <= userCount + 1; u++) {
      const sid = `benchmark-session-${u}`;
      user.run(u, `bench-${u}@example.invalid`, "not-a-login-password", `Bench user ${u}`, u === 1 ? "admin" : "user", 1, 1, 10000, JSON.stringify({ sid, activeAt: Date.now() }));
      session.run(sid, u, "browser", now + 86400, now);
      tokens.push(jwt.sign({ userId: u, sid, kind: "browser" }, process.env.JWT_SECRET!, { expiresIn: "1d" }));
      if (u === 1) continue;
      const h = (u - 2) % hostCount + 1;
      permission.run(u, h);
      userCounter.run(u, 24000000, 48000000);
      for (let r = 0; r < rulesPerUser; r++) {
        const id = (u - 2) * rulesPerUser + r + 1;
        rule.run(id, h, u, `Bench rule ${id}`, "iptables", "tcp", 10000 + Math.floor((u - 2) / hostCount) * rulesPerUser + r, "198.51.100.10", 443, 0);
        counter.run(id, h, u, 1200000, 2400000);
        for (let hour = 0; hour < 24; hour++) {
          const at = Math.floor(now / 3600) * 3600 - hour * 3600;
          traffic.run(id, h, 50000, 100000, at);
          bucket.run(at, 30, id, h, u, 50000, 100000);
        }
      }
      for (let b = 0; b < 40; b++) balance.run(u, "admin_recharge", 100, 10000, `Synthetic credit ${b}`, now - b * 86400);
    }
  })();
  // Production indexes/statistics and the production summary backfill, not mock queries.
  sqlite.exec("ANALYZE");
});
await (await import("../../server/repositories/settingsRepository")).setSetting("trafficStatBucketsBackfilled", "v3");
const { databaseHealth } = await import("../../server/databaseHealthState");
databaseHealth.healthy();
const stopSummaries = (await import("../../server/dashboardSummaryRefresh")).startDashboardSummaryRefresh();
const { dashboardSummaries, operationsSummaries } = await import("../../server/backgroundSummaryCache");
const { displayQueries } = await import("../../server/displayQueryCache");

type SqlStat = { sql: string; calls: number; ms: number; maxMs: number; args: any[]; endpoints: Record<string, number> };
const requests = new AsyncLocalStorage<string>();
let sqlStats = new Map<string, SqlStat>();
let instrument = process.env.FORWARDX_BENCH_SQL !== "0";
let originalPrepare: any;
let database: any;
await withSqliteExclusive((sqlite) => {
  database = sqlite;
  originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    const start = performance.now();
    const statement = originalPrepare(sql);
    const prepareMs = performance.now() - start;
    for (const method of ["all", "get", "run"] as const) {
      const original = statement[method].bind(statement);
      statement[method] = (...args: any[]) => {
        if (!instrument) return original(...args);
        const started = performance.now();
        try { return original(...args); }
        finally {
          const ms = performance.now() - started + prepareMs;
          const key = sql.replace(/\s+/g, " ").trim();
          const row = sqlStats.get(key) || { sql, calls: 0, ms: 0, maxMs: 0, args, endpoints: {} };
          row.calls++; row.ms += ms; row.maxMs = Math.max(row.maxMs, ms);
          const endpoint = requests.getStore() || "background";
          row.endpoints[endpoint] = (row.endpoints[endpoint] || 0) + 1;
          sqlStats.set(key, row);
        }
      };
    }
    return statement;
  }) as any;
});
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let cpuStart = process.cpuUsage();
let wallStart = performance.now();
let eluStart = performance.eventLoopUtilization();
let peakRss = 0;
const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
const profile = new inspector.Session();
profile.connect();
const post = (method: string) => new Promise<any>((resolve, reject) => profile.post(method as any, (error, result) => error ? reject(error) : resolve(result)));
const snapshot = () => {
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const memory = process.memoryUsage();
  const rows = [...sqlStats.values()].sort((a, b) => b.ms - a.ms);
  return {
    wallMs, cpuOneCorePercent: (cpu.user + cpu.system) / (wallMs * 10),
    rssMiB: memory.rss / 1048576, peakRssMiB: peakRss / 1048576, heapMiB: memory.heapUsed / 1048576,
    eventLoopUtilization: performance.eventLoopUtilization(eluStart).utilization,
    loopP95Ms: loop.percentile(95) / 1e6, loopP99Ms: loop.percentile(99) / 1e6, loopMaxMs: loop.max / 1e6,
    sqlCalls: rows.reduce((sum, row) => sum + row.calls, 0), sqlMs: rows.reduce((sum, row) => sum + row.ms, 0),
    sqlKeys: sqlStats.size, summaryCache: { dashboard: dashboardSummaries.size(), operations: operationsSummaries.size() },
    displayCache: displayQueries.stats(),
    sql: rows.slice(0, 20).map(({ args, ...row }) => {
      let plan: unknown = null;
      if (/^\s*select\b/i.test(row.sql)) {
        try { plan = originalPrepare(`EXPLAIN QUERY PLAN ${row.sql}`).all(...args); } catch { /* diagnostic only */ }
      }
      return { ...row, plan };
    }),
  };
};
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use((req, _res, next) => requests.run(req.path, next));
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
// Exercises the real heartbeat planner and DB writes, NOT encrypted transport.
// This harness-only route must never be used as an actual Agent API entry.
app.use((req, _res, next) => { (req as any).agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
registerAgentHeartbeatRoute(app);
const server = app.listen({ port: 0, host: "127.0.0.1", backlog: Number(process.env.FORWARDX_BENCH_BACKLOG || 511) }, () => {
  const address = server.address() as { port: number };
  process.send!({ type: "ready", port: address.port, tokens, agentVersion: AGENT_VERSION, fixture: {
    users: userCount, hosts: hostCount, rules: userCount * rulesPerUser,
    trafficRows: userCount * rulesPerUser * 24, bucketRows: userCount * rulesPerUser * 24, ledgerRows: userCount * 40,
  } });
});
process.on("message", async (message: any) => {
  try {
    if (message.type === "reset") {
      sqlStats = new Map(); loop.reset(); cpuStart = process.cpuUsage(); wallStart = performance.now();
      eluStart = performance.eventLoopUtilization(); peakRss = process.memoryUsage().rss;
    } else if (message.type === "stats") {
      process.send!({ id: message.id, value: snapshot() }); return;
    } else if (message.type === "profileStart") { await post("Profiler.enable"); await post("Profiler.start"); }
    else if (message.type === "profileStop") {
      const result = await post("Profiler.stop");
      fs.writeFileSync(path.join(directory, "server.cpuprofile"), JSON.stringify(result.profile));
    } else if (message.type === "verifyWrite") {
      const row = originalPrepare('SELECT name FROM forward_rules WHERE id = ?').get(message.ruleId);
      process.send!({ id: message.id, value: row?.name }); return;
    } else if (message.type === "memoryAfterGc") {
      if (typeof globalThis.gc !== "function") throw new Error("Launch with --gc-check");
      await new Promise<void>((resolve) => setImmediate(resolve));
      globalThis.gc();
      await new Promise<void>((resolve) => setImmediate(resolve));
      globalThis.gc();
      const memory = process.memoryUsage();
      process.send!({ id: message.id, value: { heapMiB: memory.heapUsed / 1048576, rssMiB: memory.rss / 1048576, summaryCache: dashboardSummaries.size() } }); return;
    } else if (message.type === "stop") {
      stopSummaries(); clearInterval(rssSampler); loop.disable(); profile.disconnect();
      server.close(); await closeDatabase(); process.exit(0);
    }
    process.send!({ id: message.id, value: true });
  } catch (error) { process.send!({ id: message.id, error: String(error) }); }
});

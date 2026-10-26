/** Test-only real HTTP server. No production scheduler, bots, external probes or shell execution. */
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
import { rulesForHost, serviceDefinitions } from "./agent-workload.mjs";

const directory = process.env.FORWARDX_AGENT_BENCH_DIR!;
const kind = process.env.DATABASE_TYPE || "sqlite";
const databaseName = process.env.MYSQL_DATABASE || process.env.POSTGRES_DATABASE || "";
if (process.env.FORWARDX_AGENT_BENCH !== "isolated" || !process.send
  || path.dirname(path.resolve(directory || ".")) !== path.resolve(os.tmpdir())
  || !path.basename(directory || "").startsWith("forwardx-agent-load-")
  || (kind === "sqlite" ? path.resolve(process.env.SQLITE_PATH!) !== path.join(directory, "fixture.db")
    : !/^forwardx_agent_bench_[a-z0-9_]+$/.test(databaseName))) {
  throw Error("Refusing benchmark outside its dedicated temporary database");
}
globalThis.fetch = (async () => { throw Error("Outbound fetch disabled in Agent benchmark"); }) as typeof fetch;
const fixture = JSON.parse(process.env.FORWARDX_AGENT_BENCH_FIXTURE!);
const runtime = await import("../../server/dbRuntime");
const schema = await import("../../server/dbSchema");
await runtime.connectDatabase();
await schema.ensureDatabaseSchema();
// Never clear an existing database: every scenario must start from a new DB.
if (Number((await runtime.queryRaw<any>(`SELECT COUNT(*) AS n FROM ${runtime.quoteDbIdentifier("users")}`))[0].n)) {
  throw Error("Benchmark requires an empty, newly created database");
}
const q = runtime.quoteDbIdentifier;
async function insert(table: string, columns: string[], rows: any[][]) {
  for (let offset = 0; offset < rows.length; offset += 200) {
    const batch = rows.slice(offset, offset + 200);
    await runtime.executeRaw(`INSERT INTO ${q(table)} (${columns.map(q).join(",")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`, batch.flat());
  }
}
async function advanceFixtureSequence(table: string) {
  // PostgreSQL explicit fixture IDs do not advance identity sequences, unlike
  // MySQL/SQLite. Keep later real router inserts clear of the seeded IDs.
  if (kind !== "postgresql") return;
  await runtime.queryRaw(`SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE(MAX(${q("id")}), 1), MAX(${q("id")}) IS NOT NULL) FROM ${q(table)}`, [table]);
}
const now = Math.floor(Date.now() / 1000);
const tokens: string[] = [];
const hostIp = (id: number) => `192.0.${Math.floor(id / 250) + 2}.${id % 250 + 1}`;
const owner = (hostId: number, index: number) => 2 + ((hostId - 1) * fixture.rulesPerHost + index) % fixture.users;
console.log(`[AgentBench] seeding ${JSON.stringify(fixture)} database=${kind}`);
await runtime.withDatabaseTransaction(async () => {
  const users = [], sessions = [];
  for (let id = 1; id <= fixture.users + 1; id++) {
    const sid = `agent-bench-session-${id}`;
    users.push([id, `agent-bench-${id}@example.invalid`, "unusable-hash", `Bench user ${id}`, id === 1 ? "admin" : "user", true, true, 100000000, JSON.stringify({ sid, activeAt: Date.now() })]);
    sessions.push([sid, id, "browser", now + 86400, now]);
    tokens.push(jwt.sign({ userId: id, sid, kind: "browser" }, process.env.JWT_SECRET!, { expiresIn: "1d" }));
  }
  await insert("users", ["id", "username", "password", "name", "role", "canAddRules", "manualCanAddRules", "balanceCents", "browserSessionToken"], users);
  await insert("auth_sessions", ["sid", "userId", "kind", "expiresAt", "lastSeenAt"], sessions);
  const hosts = [];
  const { AGENT_VERSION } = await import("../../shared/versions");
  for (let id = 1; id <= fixture.hosts; id++) hosts.push([id, `Bench host ${id}`, hostIp(id), hostIp(id), 1, true, now, "ZZ", now, `agent-bench-token-${id}`, AGENT_VERSION, false, "slave", "AgentBench CPU", 2147483648]);
  await insert("hosts", ["id", "name", "ip", "ipv4", "userId", "isOnline", "lastHeartbeat", "geoCountryCode", "geoUpdatedAt", "agentToken", "agentVersion", "hostStatusNotifyEnabled", "hostType", "cpuInfo", "memoryTotal"], hosts);
  const permissions = [], rules = [], counters = [];
  for (let id = 1; id <= fixture.hosts; id++) {
    const allowed = new Set<number>();
    for (const [index, rule] of rulesForHost(id, fixture.rulesPerHost).entries()) {
      const userId = owner(id, index); allowed.add(userId);
      rules.push([rule.id, id, userId, `Bench rule ${rule.id}`, "realm", "tcp", rule.port, rule.targetIp, rule.targetPort, true, true]);
      counters.push([rule.id, id, userId, 1200000, 2400000]);
    }
    for (const userId of allowed) permissions.push([userId, id]);
  }
  await insert("user_host_permissions", ["userId", "hostId"], permissions);
  await insert("forward_rules", ["id", "hostId", "userId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "isEnabled", "isRunning"], rules);
  await insert("forward_rule_traffic_counters", ["ruleId", "hostId", "userId", "bytesIn", "bytesOut"], counters);
  const services = serviceDefinitions(fixture.services).map((service: any) => [service.serviceId, `Bench ${service.method} ${service.serviceId}`, service.method,
    service.targetIp, service.targetPort || null, service.method === "url" ? service.targetUrl : null, 5, 200, "all", "[]", "[]", 30, true, 1]);
  await insert("host_probe_services", ["id", "name", "method", "targetIp", "targetPort", "targetUrl", "timeoutSeconds", "expectedStatus", "hostScope", "hostIds", "excludeHostIds", "intervalSeconds", "isEnabled", "userId"], services);
});
// Seed nonempty retention windows so live queries do not benchmark empty tables.
await runtime.withDatabaseTransaction(async () => {
  for (let id = 1; id <= fixture.hosts; id++) {
    const metricRows = Array.from({ length: fixture.metricSamples }, (_, n) => [id, 10, 25, 536870912, n * 1000000, n * 2000000, now - n * 60]);
    await insert("host_metrics", ["hostId", "cpuUsage", "memoryUsage", "memoryUsed", "networkIn", "networkOut", "recordedAt"], metricRows);
    for (const rule of rulesForHost(id, fixture.rulesPerHost)) {
      const userId = owner(id, (rule.id - 1) % fixture.rulesPerHost);
      const history = Array.from({ length: fixture.trafficSamples }, (_, n) => [rule.id, id, 50000, 100000, now - n * 3600]);
      await insert("traffic_stats", ["ruleId", "hostId", "bytesIn", "bytesOut", "recordedAt"], history);
      await insert("traffic_stat_buckets", ["ruleId", "hostId", "userId", "bucketStart", "bucketMinutes", "bytesIn", "bytesOut"], history.map(row => [rule.id, id, userId, Math.floor(Number(row[4]) / 1800) * 1800, 30, 50000, 100000]));
    }
    const serviceRows = [];
    for (let serviceId = 1; serviceId <= fixture.services; serviceId++) {
      for (let n = 0; n < fixture.serviceSamples; n++) serviceRows.push([serviceId, id, 15, false, 3, 3, now - n * 10800]);
    }
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "recordedAt"], serviceRows);
  }
});
const settings = await import("../../server/repositories/settingsRepository");
for (const table of ["users", "hosts", "forward_rules", "host_probe_services"]) await advanceFixtureSequence(table);
await settings.setSettings({ trafficStatBucketsBackfilled: "v3", "traffic-billing-rule-usage-v1": "1", operationsSourceAnalytics: "false", panelPublicUrl: "http://127.0.0.1", telegramEnabled: "false", emailEnabled: "false" });
await runtime.refreshDatabasePoolSettings();
if (kind === "sqlite") await runtime.withSqliteExclusive(db => db.exec("ANALYZE"));
const { databaseHealth } = await import("../../server/databaseHealthState");
databaseHealth.healthy();
const { appRouter } = await import("../../server/routers");
const { createContext } = await import("../../server/_core/context");
const { registerAgentHeartbeatRoute } = await import("../../server/agentHeartbeatRoute");
const { registerAgentReportRoutes } = await import("../../server/agentReportRoutes");
const { agentEncryptionMiddleware } = await import("../../server/agentEncryptionMiddleware");
const { AGENT_VERSION } = await import("../../shared/versions");
const stopSummaries = (await import("../../server/dashboardSummaryRefresh")).startDashboardSummaryRefresh();
const requests = new AsyncLocalStorage<string>();
type SqlStat = { sql: string; calls: number; ms: number; maxMs: number; errors: number; endpoints: Record<string, number> };
let sqlStats = new Map<string, SqlStat>();
let activeSql = 0, peakSql = 0, sqlErrors = 0;
const record = (sql: string, started: number, endpoint: string, failed = false) => {
  const key = sql.replace(/\s+/g, " ").trim().replace(/\([^()]*\?[^()]*\)(?:,\s*\([^()]*\?[^()]*\))+/g, "(BATCH)");
  const row = sqlStats.get(key) || { sql: key, calls: 0, ms: 0, maxMs: 0, errors: 0, endpoints: {} };
  const elapsed = performance.now() - started;
  row.calls++; row.ms += elapsed; row.maxMs = Math.max(row.maxMs, elapsed); row.errors += Number(failed);
  row.endpoints[endpoint] = (row.endpoints[endpoint] || 0) + 1;
  if (sqlStats.size < 2000 || sqlStats.has(key)) sqlStats.set(key, row);
};
const wrapped = new WeakSet<object>();
const sqlNesting = new AsyncLocalStorage<boolean>();
const wrapClient = (client: any) => {
  if (wrapped.has(client)) return client;
  wrapped.add(client);
  for (const method of ["query", "execute"]) {
    if (typeof client[method] !== "function") continue;
    const original = client[method].bind(client);
    client[method] = (...args: any[]) => {
      if (sqlNesting.getStore()) return original(...args);
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.sql || args[0]?.text || "";
      const endpoint = requests.getStore() || "background", started = performance.now();
      activeSql++; peakSql = Math.max(peakSql, activeSql);
      const finish = (error?: any) => { activeSql--; if (error) sqlErrors++; record(sql, started, endpoint, !!error); };
      if (typeof args.at(-1) === "function") {
        const callback = args.at(-1);
        args[args.length - 1] = (...values: any[]) => { finish(values[0]); callback(...values); };
        try { return sqlNesting.run(true, () => original(...args)); } catch (error) { finish(error); throw error; }
      }
      try {
        return Promise.resolve(sqlNesting.run(true, () => original(...args))).then(value => { finish(); return value; }, error => { finish(error); throw error; });
      } catch (error) { finish(error); throw error; }
    };
  }
  return client;
};
if (kind === "sqlite") {
  await runtime.withSqliteExclusive((db: any) => {
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      for (const method of ["run", "get", "all"]) {
        const original = statement[method].bind(statement);
        statement[method] = (...args: any[]) => {
          peakSql = Math.max(peakSql, 1);
          const started = performance.now(), endpoint = requests.getStore() || "background";
          try { const value = original(...args); record(sql, started, endpoint); return value; }
          catch (error) { sqlErrors++; record(sql, started, endpoint, true); throw error; }
        };
      }
      return statement;
    };
  });
} else if (kind === "mysql") {
  const pool: any = runtime.getPool();
  wrapClient(pool);
  const original = pool.getConnection.bind(pool);
  pool.getConnection = async () => wrapClient(await original());
} else {
  const pool: any = runtime.getPostgresPool();
  wrapClient(pool);
  // Do not wrap pg's callback-style internal connect path used by pool.query.
  const original = pool.connect.bind(pool);
  pool.connect = (...args: any[]) => args.length ? original(...args) : original().then(wrapClient);
}
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
let cpuStart = process.cpuUsage(), wallStart = performance.now(), eluStart = performance.eventLoopUtilization();
let peakRss = process.memoryUsage().rss, maxPoolWaiting = 0;
const samplePool = () => {
  if (kind === "mysql") {
    const raw = (runtime.getPool() as any)?.pool;
    return { total: raw?._allConnections?.length || 0, idle: raw?._freeConnections?.length || 0, waiting: raw?._connectionQueue?.length || 0 };
  }
  const pool: any = runtime.getPostgresPool();
  return { total: pool?.totalCount || 0, idle: pool?.idleCount || 0, waiting: pool?.waitingCount || 0 };
};
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); maxPoolWaiting = Math.max(maxPoolWaiting, samplePool().waiting); }, 100);
const profile = new inspector.Session(); profile.connect();
const profiler = (method: string) => new Promise<any>((resolve, reject) => profile.post(method as any, (error, value) => error ? reject(error) : resolve(value)));
const app = express();
app.use(express.json({ limit: "10mb" })); app.use(cookieParser());
app.use((req, _res, next) => requests.run(req.path, next));
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
app.use("/api/agent", agentEncryptionMiddleware);
registerAgentHeartbeatRoute(app); registerAgentReportRoutes(app);
const server = app.listen(0, "127.0.0.1", () => process.send!({ type: "ready", port: (server.address() as any).port, tokens, agentVersion: AGENT_VERSION, fixture }));
process.on("message", async (message: any) => {
  try {
    let value: any = true;
    if (message.type === "reset") {
      sqlStats = new Map(); sqlErrors = 0; peakSql = activeSql; loop.reset(); cpuStart = process.cpuUsage(); wallStart = performance.now(); eluStart = performance.eventLoopUtilization(); peakRss = process.memoryUsage().rss; maxPoolWaiting = 0;
    } else if (message.type === "stats") {
      const elapsed = performance.now() - wallStart, cpu = process.cpuUsage(cpuStart), memory = process.memoryUsage();
      const rows = [...sqlStats.values()].sort((a, b) => b.ms - a.ms);
      value = { elapsedMs: elapsed, cpuOneCorePercent: (cpu.user + cpu.system) / (elapsed * 10), rssMiB: memory.rss / 1048576, peakRssMiB: peakRss / 1048576,
        heapMiB: memory.heapUsed / 1048576, loopP95Ms: loop.percentile(95) / 1e6, loopP99Ms: loop.percentile(99) / 1e6, loopMaxMs: loop.max / 1e6,
        elu: performance.eventLoopUtilization(eluStart).utilization, sqlCalls: rows.reduce((sum, row) => sum + row.calls, 0), sqlMs: rows.reduce((sum, row) => sum + row.ms, 0),
        sqlErrors, peakSql, maxPoolWaiting, pool: samplePool(), sql: rows.slice(0, 25) };
    } else if (message.type === "verify") {
      value = {};
      for (const table of ["traffic_stats", "host_metrics", "host_probe_service_stats", "operations_traffic_daily"]) value[table] = Number((await runtime.queryRaw<any>(`SELECT COUNT(*) AS n FROM ${q(table)}`))[0].n);
      value.traffic = (await runtime.queryRaw<any>(`SELECT SUM(${q("bytesIn")}) AS incoming, SUM(${q("bytesOut")}) AS outgoing FROM ${q("forward_rule_traffic_counters")}`))[0];
    } else if (message.type === "prepareOperations") {
      const count = Math.min(Number(message.operators), fixture.users);
      if (!Number.isInteger(count) || count < 1) throw Error("Invalid operator count");
      await runtime.withDatabaseTransaction(async () => {
        for (let operator = 0; operator < count; operator++) {
          const userId = operator + 2, hostId = Math.floor(operator / fixture.rulesPerHost) + 1, groupId = 10000 + userId;
          await insert("forward_groups", ["id", "name", "groupMode", "forwardType", "targetIp", "userId"], [[groupId, `Operation group ${userId}`, "port", "realm", "198.51.100.30", 1]]);
          await insert("forward_group_members", ["groupId", "memberType", "hostId"], [[groupId, "host", hostId]]);
          await insert("user_forward_group_permissions", ["userId", "forwardGroupId"], [[userId, groupId]]);
        }
      });
      await advanceFixtureSequence("forward_groups");
      (await import("../../server/linkAccessView")).clearLinkAccessScopeCache();
    } else if (message.type === "verifyOperations") {
      let ownershipErrors = 0, deletionErrors = 0;
      const records = message.records as Array<{ id: number; userId: number; hostId: number; deleted: boolean }>;
      for (let offset = 0; offset < records.length; offset += 64) {
        const batch = records.slice(offset, offset + 64);
        const rows = await runtime.queryRaw<any>(`SELECT ${["id", "userId", "hostId", "pendingDelete", "isEnabled"].map(q).join(",")} FROM ${q("forward_rules")} WHERE ${q("id")} IN (${batch.map(() => "?").join(",")})`, batch.map(row => row.id));
        const byId = new Map(rows.map(row => [Number(row.id), row]));
        for (const record of batch) {
          const row = byId.get(record.id);
          if (row && (Number(row.userId) !== record.userId || Number(row.hostId) !== record.hostId)) ownershipErrors++;
          if (!row && !record.deleted) ownershipErrors++;
          if (record.deleted && row && (!row.pendingDelete || row.isEnabled)) deletionErrors++;
        }
      }
      const collisions = await runtime.queryRaw<any>(`SELECT ${q("hostId")},${q("sourcePort")} FROM ${q("forward_rules")} WHERE ${q("pendingDelete")} = ? AND ${q("isForwardGroupTemplate")} = ? GROUP BY ${q("hostId")},${q("sourcePort")} HAVING COUNT(*) > 1`, [false, false]);
      value = { ownershipErrors, deletionErrors, portCollisions: collisions.length, checked: records.length };
    } else if (message.type === "profileStart") { await profiler("Profiler.enable"); await profiler("Profiler.start"); }
    else if (message.type === "profileStop") { const data = await profiler("Profiler.stop"); fs.writeFileSync(path.join(directory, `${message.name}.cpuprofile`), JSON.stringify(data.profile)); }
    else if (message.type === "stop") {
      stopSummaries(); clearInterval(sampler); loop.disable(); profile.disconnect(); server.closeAllConnections(); server.close(); await runtime.closeDatabase(); process.send!({ id: message.id, value }); process.exit(0);
    }
    process.send!({ id: message.id, value });
  } catch (error) { process.send!({ id: message.id, error: String(error) }); }
});

// Usage: node scripts/load-test.mjs [--quick] [--no-sql] [--output=dist/load-test/result.json]
// Optional diagnostics: --stages=paced-100,paced-200 --backlog=4096 --users=500
// Creates its own temporary SQLite DB. No .env or external jobs; local summary refresh only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import http from "node:http";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import superjson from "superjson";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--quick");
const fixtureUsers = Number(process.argv.find((arg) => arg.startsWith("--users="))?.slice(8) || 500);
if (!Number.isInteger(fixtureUsers) || fixtureUsers < 10 || fixtureUsers > 5000) throw new Error("Invalid --users (10..5000)");
const gcCheck = process.argv.includes("--gc-check");
const selectedStages = process.argv.find((arg) => arg.startsWith("--stages="))?.slice(9).split(",");
const backlog = Number(process.argv.find((arg) => arg.startsWith("--backlog="))?.slice(10) || 511);
if (!Number.isInteger(backlog) || backlog < 1 || backlog > 65535) throw new Error("Invalid --backlog");
const maxSockets = Number(process.argv.find((arg) => arg.startsWith("--connections="))?.slice(14) || 2048);
if (!Number.isInteger(maxSockets) || maxSockets < 1 || maxSockets > 2048) throw new Error("Invalid --connections");
const outputOption = process.argv.find((arg) => arg.startsWith("--output="));
const output = path.resolve(root, outputOption?.slice(9) || "dist/load-test/result.json");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-load-test-"));
const bundle = path.join(root, "dist/load-test/server.mjs");
fs.mkdirSync(path.dirname(output), { recursive: true });
const hardware = { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGiB: os.totalmem() / 1073741824, platform: `${os.platform()} ${os.release()}`, node: process.version };
await build({ entryPoints: [path.join(root, "scripts/load-test/server.ts")], outfile: bundle, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", alias: { "@shared": path.join(root, "shared") }, banner: { js: `import {createRequire as __benchRequire} from 'node:module'; import {fileURLToPath as __benchUrl} from 'node:url'; import {dirname as __benchDir} from 'node:path'; const require=__benchRequire(import.meta.url); const __filename=__benchUrl(import.meta.url); const __dirname=__benchDir(__filename);` } });
const jwtSecret = (await import("node:crypto")).randomBytes(48).toString("hex");
// Allowlist environment: never inherit DB URLs, notification credentials or dev-panel flags.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|appdata|localappdata|userprofile|comspec|pathext|number_of_processors)$/i.test(key)));
Object.assign(env, { NODE_ENV: "production", DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "fixture.db"), DATABASE_CONFIG_PATH: path.join(directory, "database.json"), MYSQL_CONFIG_PATH: path.join(directory, "mysql.json"), JWT_SECRET: jwtSecret, FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(directory, "logs"), FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"), FORWARDX_BENCH_DIR: directory, FORWARDX_BENCH_SQL: process.argv.includes("--no-sql") ? "0" : "1", TELEGRAM_BOT_POLLING: "false" });
env.FORWARDX_BENCH_BACKLOG = String(backlog);
env.FORWARDX_BENCH_USERS = String(fixtureUsers);
const log = fs.openSync(path.join(directory, "server.log"), "w");
const child = spawn(process.execPath, [...(gcCheck ? ["--expose-gc"] : []), bundle], { cwd: root, env, stdio: ["ignore", log, log, "ipc"], windowsHide: true });
fs.closeSync(log);
const pending = new Map(); let sequence = 0;
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
child.on("message", (message) => {
  if (message.type === "ready") readyResolve(message);
  else { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(new Error(message.error)); else waiter?.resolve(message.value); }
});
child.on("exit", (code) => { readyReject(new Error(`Benchmark server exited ${code}; see ${directory}/server.log`)); for (const waiter of pending.values()) waiter.reject(new Error(`Server exited ${code}`)); pending.clear(); });
function control(type, fields = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Control timeout: ${type}`)); }, 60000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (err) => { clearTimeout(timeout); reject(err); } });
    child.send({ type, id, ...fields });
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Persistent, bounded pool; its queue time is included in measured latency.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  httpAgent.destroy(); child.kill(); process.exit(signal === "SIGINT" ? 130 : 143);
});
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { agent: httpAgent, method: options.method || "GET", headers: options.headers }, (res) => {
      const buffers = [];
      res.on("data", (chunk) => buffers.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(buffers).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error("HTTP request timed out")));
    req.on("error", reject);
    req.end(options.body);
  });
}
const describeError = (error) => `${error?.message || error}${error?.code ? ` code=${error.code}` : ""}${error?.cause ? ` cause=${JSON.stringify({ message: error.cause.message, code: error.cause.code })}` : ""}`;
const quantile = (values, percentile) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)] : 0;
const durationMs = quick ? 5000 : 20000;
const stages = [];
let base, tokens, fixture, agentVersion;
const endpoints = [
  ["dashboard.stats", undefined], ["dashboard.trafficTotals", undefined],
  ["dashboard.trafficSeries", { hours: 24, bucketMinutes: 60 }],
  ["dashboard.trafficBreakdown", { hours: 24, limit: 30 }],
  ["dashboard.userTraffic", undefined], ["billing.me", undefined],
  ["trafficBilling.status", undefined], ["plans.mySubscriptions", undefined],
  ["rules.listPage", { page: 1, pageSize: 12 }],
  ["rules.listSummary", {}], ["billing.ledgerPage", { page: 1, pageSize: 20 }],
  ["hosts.listPage", { page: 1, pageSize: 12 }],
];
async function request(userId, name, input, mutation = false) {
  const json = JSON.stringify(superjson.serialize(input));
  const res = await httpRequest(`${base}/api/trpc/${name}${mutation ? "" : `?input=${encodeURIComponent(json)}`}`, {
    method: mutation ? "POST" : "GET", headers: { authorization: `Bearer ${tokens[userId - 1]}`, ...(mutation ? { "content-type": "application/json" } : {}) },
    ...(mutation ? { body: json } : {}),
  });
  const text = res.text;
  const body = JSON.parse(text);
  if (res.status !== 200 || body.error || !body.result) throw new Error(`${name}: HTTP ${res.status} ${body.error?.json?.message || text.slice(0, 160)}`);
  return superjson.deserialize(body.result.data);
}
async function runStage(name, concurrency, kind, options = {}) {
  if (selectedStages && !selectedStages.includes(name)) return;
  await control("reset");
  if (options.profile) await control("profileStart");
  const samples = new Map(); const failures = [];
  let count = 0, failed = 0, operations = 0;
  const agentSamples = []; const agentFailures = [];
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const generatorCpu = process.cpuUsage();
  const started = performance.now(), deadline = started + durationMs;
  async function hit(userId, endpoint, mutation = false) {
    const t = performance.now();
    let okay = true;
    try { await request(userId, endpoint[0], endpoint[1], mutation); }
    catch (error) { okay = false; failed++; if (failures.length < 5) failures.push(describeError(error)); }
    const values = samples.get(endpoint[0]) || []; values.push({ ms: performance.now() - t, okay, at: t - started }); samples.set(endpoint[0], values); count++;
  }
  const agents = options.agents ? Promise.all(Array.from({ length: fixture.hosts }, async (_, index) => {
    await sleep(index * 10000 / fixture.hosts);
    while (performance.now() < deadline) {
      const t = performance.now();
      try {
        const response = await httpRequest(`${base}/api/agent/heartbeat`, { method: "POST", headers: { authorization: `Bearer benchmark-agent-${index + 1}`, "content-type": "application/json" }, body: JSON.stringify({ agentVersion, localState: { rules: [], tunnels: [], services: [] } }) });
        const body = JSON.parse(response.text);
        if (response.status !== 200 || body.error) throw new Error(JSON.stringify(body));
        agentSamples.push(performance.now() - t);
      } catch (error) { agentFailures.push(describeError(error)); }
      await sleep(Math.min(10000, Math.max(0, deadline - performance.now())));
    }
  })) : Promise.resolve();
  await Promise.all([agents, ...Array.from({ length: concurrency }, async (_, worker) => {
    let cycle = 0;
    if (kind === "paced") await sleep(worker * 1000 / concurrency);
    while (performance.now() < deadline) {
      const userId = kind === "paced" || kind === "write" ? worker + 2 : (operations++ % fixture.users) + 2;
      if (kind === "write") {
        await hit(userId, ["rules.update", { id: (userId - 2) * 20 + 1, name: `Bench edited ${worker}-${cycle}` }], true);
      } else if (kind === "paced") {
        // One screen every 2s: dashboard (8 requests), rules (2), billing (1), hosts (1).
        const page = cycle % 4;
        await Promise.all((page === 0 ? endpoints.slice(0, 8) : page === 1 ? endpoints.slice(8, 10) : page === 2 ? endpoints.slice(10, 11) : endpoints.slice(11)).map((endpoint) => hit(userId, endpoint)));
      } else {
        await hit(userId, endpoints[(worker + cycle) % endpoints.length]);
      }
      cycle++;
      if (kind === "paced" || options.pace) await sleep(Math.min(kind === "paced" ? 2000 : 1000, Math.max(0, deadline - performance.now())));
    }
  })]);
  const elapsedMs = performance.now() - started;
  const stats = await control("stats");
  if (options.profile) await control("profileStop");
  const generatorUsage = process.cpuUsage(generatorCpu);
  loop.disable();
  const summarize = (values) => {
    const sorted = values.map((row) => row.ms).sort((a, b) => a - b);
    return { requests: values.length, p50: quantile(sorted, .50), p95: quantile(sorted, .95), p99: quantile(sorted, .99), max: sorted.at(-1) || 0, errors: values.filter((row) => !row.okay).length };
  };
  const values = [...samples.values()].flat();
  agentSamples.sort((a, b) => a - b);
  const stage = { name, concurrency, kind, elapsedMs, rps: count / (elapsedMs / 1000), ...summarize(values), first5s: summarize(values.filter((row) => row.at < 5000)), last5s: summarize(values.filter((row) => row.at >= durationMs - 5000)), endpoints: Object.fromEntries([...samples].map(([key, rows]) => [key, summarize(rows)])), server: stats, generator: { cpuOneCorePercent: (generatorUsage.user + generatorUsage.system) / (elapsedMs * 10), loopP99Ms: loop.percentile(99) / 1e6 }, failures, agents: { requests: agentSamples.length + agentFailures.length, errors: agentFailures.length, p95: quantile(agentSamples, .95), failures: agentFailures.slice(0, 5) } };
  stages.push(stage);
  console.log(`${name}: ${count} req, ${stage.rps.toFixed(1)} rps, p50=${stage.p50.toFixed(0)}ms p95=${stage.p95.toFixed(0)}ms p99=${stage.p99.toFixed(0)}ms errors=${failed}; server CPU=${stats.cpuOneCorePercent.toFixed(0)}% loopP99=${stats.loopP99Ms.toFixed(0)}ms SQL=${stats.sqlCalls}`);
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), hardware, fixture, durationMs, sqlInstrumentation: env.FORWARDX_BENCH_SQL === "1", listenBacklog: backlog, httpPoolMaxSockets: maxSockets, directory, stages }, null, 2));
  await sleep(1000);
}
try {
  console.log(`Preparing isolated fixture in ${directory} ...`);
  const timeout = setTimeout(() => readyReject(new Error(`Startup timed out; see ${directory}/server.log`)), 90000);
  try { ({ port: base, tokens, fixture, agentVersion } = await ready); } finally { clearTimeout(timeout); }
  base = `http://127.0.0.1:${base}`;
  console.log(JSON.stringify({ hardware, fixture }));
  // Semantic smoke checks, not only HTTP 200; real JWT/session/ACL are active.
  const assert = (await import("node:assert/strict")).default;
  for (const endpoint of endpoints) await request(2, ...endpoint);
  const page = await request(2, "rules.listPage", { page: 1, pageSize: 12 });
  assert.equal(page.totalItems, 20); assert.equal(page.items.length, 12);
  assert.ok(page.items.every((row) => row.userId === 2));
  const other = await request(3, "rules.listPage", { page: 1, pageSize: 12 });
  assert.ok(other.items.every((row) => row.userId === 3));
  const adminOwn = await request(1, "rules.listPage", { page: 1, pageSize: 12 });
  assert.equal(adminOwn.totalItems, 0, "admin default is own rules, not everyone's");
  const adminAll = await request(1, "rules.listPage", { page: 1, pageSize: 12, scope: "all" });
  assert.equal(adminAll.totalItems, fixture.rules);
  const adminStats = await request(1, "dashboard.stats");
  assert.equal(adminStats.totalRules, 0, "admin home summary remains self-scoped");
  await assert.rejects(request(2, "rules.update", { id: 21, name: "Forbidden" }, true));
  await request(2, "rules.listPage", { page: 1, pageSize: 100 });
  await request(2, "rules.update", { id: 1, name: "Bench verified write" }, true);
  assert.equal(await control("verifyWrite", { ruleId: 1 }), "Bench verified write");
  const updatedPage = await request(2, "rules.listPage", { page: 1, pageSize: 100 });
  assert.equal(updatedPage.items.find((row) => row.id === 1)?.name, "Bench verified write", "writes invalidate cached list data immediately");
  console.log("Smoke checks passed: session auth, user isolation, admin self/all scope, foreign-write denial, persisted update.");
  for (const count of quick ? [10] : [10, 50, 100, 200]) {
    if (count <= fixtureUsers) await runStage(`paced-${count}`, count, "paced");
  }
  const agentViewers = Math.min(quick ? 10 : 100, fixtureUsers);
  await runStage(`paced-${agentViewers}-with-50-agents`, agentViewers, "paced", { agents: true });
  for (const count of quick ? [10] : [10, 50, 100]) await runStage(`saturated-${count}`, count, "saturated");
  if (!quick) await runStage("saturated-100-profile", 100, "saturated", { profile: true });
  await runStage("writes-10", 10, "write", { pace: true });
  await runStage("read-recovery-10", 10, "paced");
  if (stages.length === 0) throw new Error("No matching benchmark stages selected");
  const verified = await control("verifyWrite", { ruleId: 1 });
  if (stages.some((stage) => stage.kind === "write")) assert.match(verified, /^Bench edited 0-/);
  else assert.equal(verified, "Bench verified write");
  if (gcCheck) {
    const memoryAfterGc = await control("memoryAfterGc");
    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    fs.writeFileSync(output, JSON.stringify({ ...result, memoryAfterGc }, null, 2));
    console.log(`Post-run GC diagnostic (not during timed stages): ${JSON.stringify(memoryAfterGc)}`);
  }
  console.log(`Result: ${output}\nTemporary DB/log/CPU profile retained: ${directory}`);
} finally {
  httpAgent.destroy();
  if (child.connected) { child.send({ type: "stop" }); await Promise.race([once(child, "exit"), sleep(5000)]); }
  if (child.exitCode === null) child.kill();
}

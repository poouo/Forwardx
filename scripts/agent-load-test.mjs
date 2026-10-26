// Isolated Agent/panel benchmark. No .env, real hosts, outbound probes or production scheduler.
// node scripts/agent-load-test.mjs --scenarios=few-dense,many-medium,many-scale --seconds=60
// --quick reduces seeded history only. --db-config=<isolated DB config> supports MySQL/PostgreSQL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { build } from "esbuild";
import superjson from "superjson";
import assert from "node:assert/strict";
import { agentScenarios, rulesForHost, runtimeStateForRules, serviceDefinitions, serviceResult, encryptedAgentRequest, decryptedAgentResponse } from "./load-test/agent-workload.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const seconds = Number(option("seconds", "60"));
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 1800) throw Error("Invalid seconds (3..1800)");
const names = option("scenarios", Object.keys(agentScenarios).join(",")).split(",");
if (names.some(name => !agentScenarios[name])) throw Error("Unknown scenario");
const stages = option("stages", "steady,live,churn,reconcile").split(",");
if (stages.some(name => !["steady", "live", "churn", "reconcile", "operations"].includes(name))) throw Error("Unknown stage");
const quick = process.argv.includes("--quick");
const batchPages = process.argv.includes("--batch-pages");
const requestedViewers = Number(option("viewers", "50"));
if (!Number.isInteger(requestedViewers) || requestedViewers < 0 || requestedViewers > 500) throw Error("Invalid viewers (0..500)");
const requestedOperators = Number(option("operators", String(requestedViewers)));
if (!Number.isInteger(requestedOperators) || requestedOperators < 1 || requestedOperators > 500) throw Error("Invalid operators (1..500)");
const output = path.resolve(root, option("output", "dist/load-test/agent-result.json"));
const bundle = path.resolve(root, option("server-bundle", "dist/load-test/agent-server.mjs"));
const dbConfig = option("db-config", "") ? JSON.parse(fs.readFileSync(option("db-config", ""), "utf8")) : { type: "sqlite" };
if (!["sqlite", "mysql", "postgresql"].includes(dbConfig.type)) throw Error("Unsupported benchmark database");
if (dbConfig.type !== "sqlite" && names.length !== 1) throw Error("Use a separate new external database for each scenario");
const dbName = dbConfig[dbConfig.type]?.database;
if (dbConfig.type !== "sqlite" && !/^forwardx_agent_bench_[a-z0-9_]+$/.test(dbName || "")) throw Error("External DB must be a dedicated forwardx_agent_bench_* database");
fs.mkdirSync(path.dirname(output), { recursive: true });
if (!option("server-bundle", "")) await build({ entryPoints: [path.join(root, "scripts/load-test/agent-server.ts")], outfile: bundle, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", alias: { "@shared": path.join(root, "shared") }, banner: { js: `import {createRequire as __benchRequire} from 'node:module'; import {fileURLToPath as __benchUrl} from 'node:url'; import {dirname as __benchDir} from 'node:path'; const require=__benchRequire(import.meta.url); const __filename=__benchUrl(import.meta.url); const __dirname=__benchDir(__filename);` } });
const hardware = { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGiB: os.totalmem() / 1073741824, platform: `${os.platform()} ${os.release()}`, node: process.version };
const results = { fixtureProtocol: 2, generatedAt: new Date().toISOString(), hardware, database: dbConfig.type, seconds, quick, batchPages, scenarios: [] };
const persist = () => fs.writeFileSync(output, JSON.stringify(results, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (sorted, q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] || 0;
const summarize = rows => {
  const sorted = rows.map(row => row.ms).sort((a, b) => a - b);
  return { requests: rows.length, errors: rows.filter(row => row.error).length, p50Ms: percentile(sorted, .5), p95Ms: percentile(sorted, .95), p99Ms: percentile(sorted, .99), maxMs: sorted.at(-1) || 0 };
};

for (const name of names) {
  const fixture = { ...agentScenarios[name], metricSamples: quick ? 20 : 720, trafficSamples: quick ? 2 : 24, serviceSamples: quick ? 10 : 240 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-load-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|tmpdir|appdata|localappdata|userprofile|comspec|pathext|number_of_processors)$/i.test(key)));
  const configPath = path.join(directory, "database.json");
  const config = dbConfig.type === "sqlite" ? { type: "sqlite", sqlite: { path: path.join(directory, "fixture.db") } } : dbConfig;
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  Object.assign(env, { NODE_ENV: "production", DATABASE_TYPE: config.type, SQLITE_PATH: path.join(directory, "fixture.db"), DATABASE_CONFIG_PATH: configPath, MYSQL_CONFIG_PATH: path.join(directory, "unused.json"), JWT_SECRET: crypto.randomBytes(48).toString("hex"), FORWARDX_DEV_PANEL: "0", FORWARDX_LOG_DIR: path.join(directory, "logs"), FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"), FORWARDX_AGENT_BENCH: "isolated", FORWARDX_AGENT_BENCH_DIR: directory, FORWARDX_AGENT_BENCH_FIXTURE: JSON.stringify(fixture), TELEGRAM_BOT_POLLING: "false" });
  if (config.type === "mysql") env.MYSQL_DATABASE = dbName;
  if (config.type === "postgresql") env.POSTGRES_DATABASE = dbName;
  const log = fs.openSync(path.join(directory, "server.log"), "w");
  const child = spawn(process.execPath, [bundle], { cwd: root, env, stdio: ["ignore", log, log, "ipc"], windowsHide: true }); fs.closeSync(log);
  const interrupt = () => { child.kill(); process.exit(130); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  // Retire idle sockets before Node's default 5s server timeout to avoid the
  // load generator reusing a socket at the exact moment the server closes it.
  const pool = new http.Agent({ keepAlive: true, timeout: 4000, maxSockets: 256, maxFreeSockets: 256 });
  const pending = new Map(); let seq = 0, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.on("message", message => { if (message.type === "ready") resolveReady(message); else { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter?.reject(Error(message.error)); else waiter?.resolve(message.value); } });
  child.on("exit", code => { const error = Error(`Server exited ${code}: ${directory}/server.log`); rejectReady(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
  function control(type, fields = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`IPC timeout ${type}`)); }, 120000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); child.send({ id, type, ...fields });
    });
  }
  async function httpRequest(route, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}${route}`, { agent: pool, method: options.method || "GET", headers: options.headers }, res => {
        const buffers = []; res.on("data", chunk => buffers.push(chunk)); res.on("error", reject);
        res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(buffers).toString("utf8")) }); } catch (error) { reject(error); } });
      }); req.setTimeout(30000, () => req.destroy(Error("Request timed out"))); req.on("error", reject); req.end(options.body);
    });
  }
  let base, tokens, agentVersion;
  const states = Array.from({ length: fixture.hosts }, () => ({}));
  const hostRules = Array.from({ length: fixture.hosts }, (_, n) => rulesForHost(n + 1, fixture.rulesPerHost));
  const localStates = hostRules.map(runtimeStateForRules);
  const emptyHeartbeatOutcomes = () => ({ requests: 0, coalesced: 0, fastResponses: 0, requestedLocalState: 0, applyActions: 0, fullStateSections: 0 });
  let heartbeatOutcomes = emptyHeartbeatOutcomes();
  const services = serviceDefinitions(fixture.services);
  let reportSeq = 0;
  const runId = crypto.randomUUID();
  async function agent(hostId, route, payload) {
    const token = `agent-bench-token-${hostId}`, signed = encryptedAgentRequest(token, `/api/agent/${route}`, payload);
    const response = await httpRequest(`/api/agent/${route}`, { method: "POST", body: signed.body, headers: { authorization: signed.authorization, "content-type": "application/json" } });
    const value = decryptedAgentResponse(token, response.body);
    if (response.status !== 200 || value?.error || value?.success === false) throw Error(`${route}: HTTP ${response.status} ${JSON.stringify(value).slice(0, 300)}`);
    return value;
  }
  async function query(userId, route, input, mutation = false) {
    const body = JSON.stringify(superjson.serialize(input));
    const response = await httpRequest(`/api/trpc/${route}${mutation ? "" : `?input=${encodeURIComponent(body)}`}`, { method: mutation ? "POST" : "GET", headers: { authorization: `Bearer ${tokens[userId - 1]}`, "content-type": "application/json" }, ...(mutation ? { body } : {}) });
    if (response.status !== 200 || !response.body.result) throw Error(`${route}: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`);
    return superjson.deserialize(response.body.result.data);
  }
  async function queryBatch(userId, entries) {
    const input = JSON.stringify(Object.fromEntries(entries.map((entry, index) => [index, superjson.serialize(entry[1])])));
    const routes = entries.map(entry => entry[0]).join(",");
    const response = await httpRequest(`/api/trpc/${routes}?batch=1&input=${encodeURIComponent(input)}`, { headers: { authorization: `Bearer ${tokens[userId - 1]}` } });
    if (response.status !== 200 || !Array.isArray(response.body) || response.body.length !== entries.length || response.body.some(row => !row.result)) throw Error(`pageBatch: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 250)}`);
    return response.body.map(row => superjson.deserialize(row.result.data));
  }
  const operationPorts = new Set(), operationRecords = [];
  let operationStats;
  async function operationQuery(userId, route, input, mutation = false, expectDenied = false) {
    const started = performance.now(); let error;
    try {
      const value = await query(userId, route, input, mutation);
      if (expectDenied) throw Error("Authorization failure: another user's mutation succeeded");
      return value;
    } catch (failure) {
      // Only the actual ownership denial is expected; a busy/SQL failure is not.
      if (expectDenied && /FORBIDDEN|无权|只能.*自己/.test(failure.message)) { operationStats.denied++; return; }
      error = String(failure.message); throw failure;
    } finally {
      const key = expectDenied ? "ownership.denied" : route;
      const rows = operationStats.rows.get(key) || [];
      rows.push({ ms: performance.now() - started, ...(error ? { error } : {}) }); operationStats.rows.set(key, rows);
    }
  }
  async function operationWorkflow(userId, cycle) {
    operationStats.started++;
    const hostId = Math.floor((userId - 2) / fixture.rulesPerHost) + 1;
    const name = `Concurrent-${runId.slice(0, 8)}-${userId}-${cycle}`;
    const created = await operationQuery(userId, "rules.create", { hostId, forwardGroupId: 10000 + userId, name, forwardType: "realm", protocol: "tcp", sourcePort: 0, targetIp: "198.51.100.30", targetPort: 443, isEnabled: false }, true);
    assert.ok(created.id > 0 && created.sourcePort > 0);
    const key = `${hostId}:${created.sourcePort}`;
    assert.equal(operationPorts.has(key), false, "concurrent port allocation collided"); operationPorts.add(key);
    operationRecords.push({ id: created.id, userId, hostId, deleted: false });
    const record = operationRecords.at(-1);
    const owned = await operationQuery(userId, "rules.getById", { id: created.id });
    assert.equal(Number(owned.userId), userId);
    const foreignId = userId === fixture.users + 1 ? 2 : userId + 1;
    assert.equal(await operationQuery(foreignId, "rules.getById", { id: created.id }), null);
    await operationQuery(foreignId, "rules.update", { id: created.id, name: "forbidden" }, true, true);
    await operationQuery(userId, "rules.update", { id: created.id, name: `${name}-edited`, targetPort: 444 }, true);
    await operationQuery(userId, "rules.toggle", { id: created.id, isEnabled: true }, true);
    await operationQuery(userId, "rules.restart", { id: created.id }, true);
    await operationQuery(userId, "rules.toggle", { id: created.id, isEnabled: false }, true);
    const updated = await operationQuery(userId, "rules.getById", { id: created.id });
    assert.equal(updated.name, `${name}-edited`); assert.equal(updated.targetPort, 444); assert.equal(Boolean(updated.isEnabled), false);
    await operationQuery(userId, "rules.delete", { id: created.id }, true);
    record.deleted = true;
    const page = await operationQuery(userId, "rules.listPage", { page: 1, pageSize: 24, search: name });
    assert.equal(page.items.some(rule => Number(rule.id) === Number(created.id)), false, "deleted rule leaked through display cache");
    operationStats.completed++;
  }
  function metrics(hostId) {
    const elapsed = Math.floor(performance.now());
    return { agentVersion, m: [15, 25, 536870912, 2147483648, 0, 0, 0, elapsed * 1000 + hostId, elapsed * 2000 + hostId, 10, 2147483648, 21474836480, 36000 + Math.floor(elapsed / 1000)], loadAverage: [0.2, 0.3, 0.4] };
  }
  async function heartbeat(hostId, initial = false, force = false) {
    const state = states[hostId - 1];
    const local = localStates[hostId - 1];
    const value = await agent(hostId, "heartbeat", { ...metrics(hostId), ...state, localStateSignature: local.signature, ...(initial || state.requestLocalState ? { localState: local.value } : {}), ...(force ? { forceReconcile: true } : {}) });
    heartbeatOutcomes.requests++;
    heartbeatOutcomes.coalesced += Number(!!value.reconciliationCoalesced);
    heartbeatOutcomes.fastResponses += Number(!value.reconciliationCoalesced && !Object.hasOwn(value, "stateSignatures"));
    heartbeatOutcomes.requestedLocalState += Number(!!value.requestLocalState);
    heartbeatOutcomes.applyActions += [...(value.actions || []), ...(value.desiredState?.actions || [])].filter(action => action.op === "apply").length;
    heartbeatOutcomes.fullStateSections += Number(Object.hasOwn(value, "runningRules"));
    if (value.stateSignatures) state.stateSignatures = value.stateSignatures;
    state.requestLocalState = !!value.requestLocalState;
    if (value.desiredState) Object.assign(state, { agentLastReceivedRevision: value.desiredState.configRevision, agentLastAppliedRevision: value.desiredState.configRevision, agentLastReceivedHash: value.desiredState.configHash, agentLastAppliedHash: value.desiredState.configHash });
    return value;
  }
  const traffic = (hostId, frozenId) => agent(hostId, "traffic", { reportId: frozenId || `${runId}-${++reportSeq}`, reportProducerId: `bench-${runId}-${hostId}`, stats: hostRules[hostId - 1].map(rule => ({ ruleId: rule.id, bytesIn: 1000, bytesOut: 2000, connections: 2 })) });
  const probeGate = new Map();
  const probe = async (hostId, cycle, churn = false) => {
    const at = performance.now(), updates = [];
    const selected = hostRules[hostId - 1].flatMap(rule => {
      const failed = churn && (rule.id + cycle) % 17 === 0, previous = probeGate.get(rule.id);
      if (previous && previous.failed === failed && at - previous.at < 300000) return [];
      updates.push([rule.id, { failed, at }]);
      return [{ ruleId: rule.id, method: "tcping", targetIp: rule.targetIp, targetPort: rule.targetPort, latencyMs: failed ? null : 15, isTimeout: failed, probeCount: 3, probeSuccesses: failed ? 0 : 3 }];
    });
    const result = await agent(hostId, "tcping", { results: selected, services: services.map(service => serviceResult(service, hostId, cycle, churn)) });
    for (const [id, state] of updates) probeGate.set(id, state);
    return result;
  };
  const scenario = { name, fixture, directory, stages: [] }; results.scenarios.push(scenario);
  console.log(`Preparing ${name} ${config.type}: ${directory}`);
  try {
    const timer = setTimeout(() => rejectReady(Error(`Startup timeout: ${directory}/server.log`)), 600000);
    try { const value = await ready; base = `http://127.0.0.1:${value.port}`; tokens = value.tokens; agentVersion = value.agentVersion; } finally { clearTimeout(timer); }
    const admin = await query(1, "rules.listPage", { page: 1, pageSize: 12, scope: "all" });
    assert.equal(admin.totalItems, fixture.hosts * fixture.rulesPerHost);
    const own = await query(2, "rules.listPage", { page: 1, pageSize: 12 });
    assert.ok(own.items.length > 0 && own.items.every(rule => rule.userId === 2));
    const before = await control("verify");
    for (let offset = 0; offset < fixture.hosts; offset += 4) await Promise.all(Array.from({ length: Math.min(4, fixture.hosts - offset) }, (_, n) => heartbeat(offset + n + 1, true)));
    // First upload supplies runtime state; the second acknowledges section and
    // desired-state hashes so the real stable-plan fast path can be cached.
    for (let offset = 0; offset < fixture.hosts; offset += 4) await Promise.all(Array.from({ length: Math.min(4, fixture.hosts - offset) }, (_, n) => heartbeat(offset + n + 1, false, true)));
    assert.equal(heartbeatOutcomes.applyActions, 0, "healthy reported listeners must not be replanned as missing");
    const probeHost = await heartbeat(1, false, true);
    assert.equal(probeHost.requestLocalState, false);
    const smokeReportId = `${runId}-smoke`;
    await traffic(1, smokeReportId);
    assert.equal((await traffic(1, smokeReportId)).duplicate, true, "retrying a frozen batch must not double-count traffic");
    await probe(1, 0); await agent(1, "heartbeat", { ...metrics(1), busy: true });
    const after = await control("verify");
    assert.equal(Number(after.traffic.incoming) - Number(before.traffic.incoming), fixture.rulesPerHost * 1000);
    assert.equal(after.host_probe_service_stats - before.host_probe_service_stats, fixture.services, "all TCP/ICMP/URL service reports must be accepted");
    assert.ok(after.host_metrics > before.host_metrics, "metrics must persist");
    scenario.smoke = { before, after, adminRules: admin.totalItems, userRules: own.totalItems, heartbeatOutcomes: { ...heartbeatOutcomes } };
    console.log(`${name}: semantic checks passed, running stages...`);
    for (const stageName of stages) {
      const live = stageName !== "steady", churn = stageName === "churn", reconcile = stageName === "reconcile";
      const operations = stageName === "operations";
      const viewers = live ? Math.min(operations ? requestedOperators : requestedViewers, fixture.users) : 0;
      operationStats = { started: 0, completed: 0, denied: 0, rows: new Map() };
      if (operations) await control("prepareOperations", { operators: viewers });
      const watched = Array.from({ length: Math.min(fixture.hosts, 24) }, (_, n) => n + 1);
      const tasks = [];
      const add = (key, period, offset, run) => tasks.push({ key, period, next: offset, run, busy: false, skipped: 0 });
      for (let id = 1; id <= fixture.hosts; id++) {
        add("agent.presence", 5000, id * 5000 / fixture.hosts, () => agent(id, "presence", {}));
        // Fixed one-minute full-heartbeat workload, separate from watched
        // metrics. This is an interface stress model, not the Agent scheduler.
        add("agent.full", 60000, id * 60000 / fixture.hosts, () => heartbeat(id));
        add("agent.traffic", live && id <= watched.length ? 10000 : 30000, id * (live && id <= watched.length ? 10000 : 30000) / fixture.hosts, () => traffic(id));
        // Agent gates unchanged rule probes at 5min; service results bypass that gate.
        add("agent.probes", 30000, id * 30000 / fixture.hosts, cycle => probe(id, cycle, churn));
        if (live && id <= watched.length) add("agent.metrics", 3000, id * 3000 / watched.length, () => agent(id, "heartbeat", { ...metrics(id), busy: true }));
        if (reconcile) add("agent.forced-reconcile", 600000, id * Math.min(10000, seconds * 500) / fixture.hosts, () => heartbeat(id, true, true));
      }
      if (live) {
        add("page.watchMetrics", 2000, 0, () => query(1, "hosts.watchMetrics", { hostIds: watched }, true));
        for (const [route, input] of [["hosts.listPage", { page: 1, pageSize: 12 }], ["hosts.latestMetricsSummary", { hostIds: watched }], ["hosts.trafficSummary", { hostIds: watched }]]) add(`page.${route}`, 2000, 200, () => query(1, route, input));
        add("page.services", 10000, 500, () => query(1, "hosts.probeServiceSeries", { serviceIds: services.map(s => s.serviceId), hostId: 1, hours: 24 }));
        for (let viewer = 0; viewer < viewers; viewer++) {
          const userId = viewer + 2;
          const entries = [["rules.listPage", { page: 1, pageSize: 24 }], ["rules.listSummary", {}], ["dashboard.stats", undefined]];
          if (batchPages) add("page.userBatch", 2000, viewer * 2000 / viewers, () => queryBatch(userId, entries));
          else for (const [route, input] of entries) add(`page.${route}`, 2000, viewer * 2000 / viewers, () => query(userId, route, input));
          if (operations) add("operations.workflow", 15000, viewer * 15000 / viewers, cycle => operationWorkflow(userId, cycle));
        }
      }
      await control("reset"); await control("profileStart");
      heartbeatOutcomes = emptyHeartbeatOutcomes();
      const rows = new Map(), failures = [], inflight = new Set();
      const generatorLoop = monitorEventLoopDelay({ resolution: 10 }); generatorLoop.enable();
      const generatorCpu = process.cpuUsage();
      const started = performance.now(), durationMs = seconds * 1000;
      let missed = 0, peakInflight = 0, maxScheduleLagMs = 0;
      while (performance.now() - started < durationMs) {
        const elapsed = performance.now() - started;
        for (const task of tasks) {
          if (elapsed < task.next) continue;
          const due = task.next, cycle = Math.floor(due / task.period);
          task.next += task.period;
          if (elapsed >= task.next) { const skip = Math.floor((elapsed - task.next) / task.period) + 1; missed += skip; task.next += skip * task.period; }
          maxScheduleLagMs = Math.max(maxScheduleLagMs, elapsed - due);
          if (task.busy || inflight.size >= 512) { task.skipped++; missed++; continue; }
          task.busy = true;
          const begin = performance.now();
          const promise = Promise.resolve().then(() => task.run(cycle)).then(() => ({ ms: performance.now() - begin }), error => {
            if (failures.length < 10) failures.push(`${task.key}: ${error.message}`);
            return { ms: performance.now() - begin, error: String(error.message) };
          }).then(row => { const values = rows.get(task.key) || []; values.push(row); rows.set(task.key, values); }).finally(() => { task.busy = false; inflight.delete(promise); });
          inflight.add(promise); peakInflight = Math.max(peakInflight, inflight.size);
        }
        await sleep(5);
      }
      await Promise.all(inflight);
      const elapsedMs = performance.now() - started, cpu = process.cpuUsage(generatorCpu);
      const server = await control("stats"); await control("profileStop", { name: stageName }); generatorLoop.disable();
      if (!operations) assert.equal(heartbeatOutcomes.applyActions, 0, "fixture drift caused false rule reinstallation");
      const requestRows = new Map([...rows].filter(([key]) => key !== "operations.workflow"));
      if (operations) for (const [key, values] of operationStats.rows) requestRows.set(`operation.${key}`, values);
      const stage = { name: stageName, viewers, watchedHosts: live ? watched.length : 0, elapsedMs, ...summarize([...requestRows.values()].flat()), missed, peakInflight, maxScheduleLagMs, heartbeatOutcomes: { ...heartbeatOutcomes }, endpoints: Object.fromEntries([...requestRows].map(([key, values]) => [key, summarize(values)])), failures, server,
        generator: { cpuOneCorePercent: (cpu.user + cpu.system) / (elapsedMs * 10), loopP99Ms: generatorLoop.percentile(99) / 1e6 } };
      stage.rps = stage.requests / (elapsedMs / 1000); scenario.stages.push(stage); persist();
      if (operations) {
        stage.operations = { started: operationStats.started, completed: operationStats.completed, denied: operationStats.denied, workflow: summarize(rows.get("operations.workflow") || []),
          endpoints: Object.fromEntries([...operationStats.rows].map(([key, values]) => [key, summarize(values)])), records: operationRecords };
        stage.operationVerification = await control("verifyOperations", { records: operationRecords });
        assert.equal(stage.operationVerification.ownershipErrors, 0);
        assert.equal(stage.operationVerification.deletionErrors, 0);
        assert.equal(stage.operationVerification.portCollisions, 0);
        persist();
      }
      console.log(`${name}/${stageName}: ${stage.requests} req ${stage.rps.toFixed(1)} rps p95=${stage.p95Ms.toFixed(1)}ms p99=${stage.p99Ms.toFixed(1)}ms errors=${stage.errors} missed=${missed} CPU=${server.cpuOneCorePercent.toFixed(1)}% loopP99=${server.loopP99Ms.toFixed(1)}ms SQL=${server.sqlCalls} waiting=${server.maxPoolWaiting}`);
      await sleep(1000);
    }
    scenario.finalVerification = await control("verify");
    const session = await query(2, "auth.me", undefined);
    assert.equal(session?.id, 2, "load must not revoke a valid login session");
    scenario.sessionValidAfterLoad = true;
    persist();
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    pool.destroy();
    if (child.connected) await control("stop").catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
console.log(`Saved ${output}; isolated fixture directories are retained for query-plan diagnosis.`);

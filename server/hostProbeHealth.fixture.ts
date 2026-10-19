import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { hostsRouter } from "./routers/hosts";
import { hostChinaHealthSchema, ipSwitchHookSchema } from "../shared/hostChinaHealth";
import { observeProbeHealth, getProbeHealthViews, saveProbeHealth, validateIpSwitchClaim, acknowledgeIpSwitch } from "./hostProbeHealth";
import { hostIngressAddress } from "./hostAddressRuntime";
import express from "express";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";
import { encryptPayload, decryptPayload } from "./agentCrypto";
import { panelCryptoNowMs } from "./panelClock";
import { recordIpSwitchAgentCapability, hasQueuedIpSwitchAgentTasks, takeIpSwitchAgentTasks } from "./agentIpSwitchTasks";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let http: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  await ensureDatabaseSchema();
  for (const id of [1, 2]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", name: `User ${id}`, role: id === 1 ? "admin" : "user" });
  for (const id of [1, 2, 3, 4, 5]) await runtime.insertAndGetId("hosts", { id, name: `Host ${id}`, ip: "1.1.1.1", agentToken: `test-token-${id}`, userId: 2 });
  const caller = (id: number, role: string) => hostsRouter.createCaller({ user: { id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const admin = caller(1, "admin"), user = caller(2, "user");
  const hook = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/api/changeip?token=private-provider-secret", successMode: "http" });
  const health = hostChinaHealthSchema.parse({ enabled: true, autoSwitch: true, notify: false, failureThreshold: 2, failureSeconds: 30, cooldownSeconds: 300, maxSwitchesPerDay: 2, hook });
  const serviceInput = { name: "China probe", method: "tcping" as const, targetIp: "223.5.5.5", targetPort: 443, hostScope: "specific" as const, hostIds: [1], intervalSeconds: 15, health };
  await assert.rejects(user.createProbeService(serviceInput), (error: any) => error.code === "FORBIDDEN");
  const { id } = await admin.createProbeService(serviceInput);
  const service = (await db.getHostProbeServiceById(id))!;
  const [stored] = await runtime.queryRaw<any>("SELECT * FROM host_probe_health WHERE serviceId = ?", [id]);
  assert.ok(stored.hookCiphertext.startsWith("v1:")); assert.doesNotMatch(JSON.stringify(stored), /private-provider-secret|10\.0\.0\.1/);
  const view = (await admin.probeServices()).find((item: any) => item.id === id)!.health;
  assert.equal(view.hookConfigured, true); assert.doesNotMatch(JSON.stringify(view), /private-provider-secret|hookCiphertext|10\.0\.0\.1/);
  assert.deepEqual(await user.probeServices(), []);
  // An unrelated update (e.g. pause) must preserve saved provider credentials.
  await admin.updateProbeService({ ...serviceInput, id, health: undefined });
  assert.equal((await runtime.queryRaw<any>("SELECT hookCiphertext FROM host_probe_health WHERE serviceId = ?", [id]))[0].hookCiphertext, stored.hookCiphertext);
  await assert.rejects(admin.createProbeService({ ...serviceInput, hostIds: [1, 2] }), /一台特定/);
  await assert.rejects(admin.createProbeService({ ...serviceInput, targetIp: "localhost" }), /固定公网 IP/);
  const base = Math.floor(Date.now() / 1000), host = (await db.getHostById(1))!;
  let calls = 0, notices = 0, ready = false;
  const deps = { ready: () => ready, notify: async () => { notices++; }, request: async (_hook: any, context: any) => {
    calls++;
    assert.equal(await validateIpSwitchClaim(1, id, context.incidentId, hostIngressAddress(host)), true);
    assert.equal(await validateIpSwitchClaim(2, id, context.incidentId, hostIngressAddress(host)), false);
    assert.equal(await validateIpSwitchClaim(1, id, context.incidentId, "8.8.8.8"), false);
    return { taskId: context.incidentId, outcome: "accepted" as const, reason: "ok" as const };
  }};
  const report = { serviceId: id, targetIp: "223.5.5.5", targetPort: 443, method: "tcping", probeCount: 3, probeSuccesses: 0 };
  await observeProbeHealth({ ...host, id: 2 }, [report], base, deps);
  await observeProbeHealth(host, [{ ...report, targetIp: "8.8.8.8" }, { ...report, method: "ping" }], base, deps);
  await observeProbeHealth(host, [{ ...report, probeSuccesses: -1 }], base, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state, null);
  for (const offset of [0, 15, 30]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state.phase, "unhealthy"); assert.equal(calls, 0);
  ready = true;
  // No human reply or approval: a capable Agent immediately receives the action.
  await observeProbeHealth(host, [report], base + 45, deps);
  assert.equal(calls, 1); assert.equal((await getProbeHealthViews([id])).get(id).lastAction.status, "accepted");
  await observeProbeHealth(host, [report, report], base + 60, deps); assert.equal(calls, 1);
  for (const offset of [75, 90]) await observeProbeHealth(host, [{ ...report, probeSuccesses: 3 }], base + offset, deps);
  assert.equal((await getProbeHealthViews([id])).get(id).state.phase, "healthy");
  for (const offset of [105, 120, 135]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 1); // Host cooldown applies across incidents.
  // A monitoring gap may not immediately trigger a previously deferred action.
  await observeProbeHealth(host, [report], base + 400, deps); assert.equal(calls, 1);
  for (const offset of [415, 430]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 2);
  for (const offset of [445, 460]) await observeProbeHealth(host, [{ ...report, probeSuccesses: 3 }], base + offset, deps);
  for (const offset of [900, 915, 930]) await observeProbeHealth(host, [report], base + offset, deps);
  assert.equal(calls, 2); // Daily cap, including earlier accepted calls.
  assert.ok(notices > 0);

  // Unknown result survives database reload/settings edits and blocks future paid calls.
  const second = await admin.createProbeService({ ...serviceInput, name: "Uncertain", hostIds: [2] });
  const host2 = (await db.getHostById(2))!, report2 = { ...report, serviceId: second.id };
  let uncertainCalls = 0;
  const uncertainDeps = { ...deps, request: async () => { uncertainCalls++; throw new Error("private-provider-secret"); } };
  for (const offset of [0, 15, 30]) await observeProbeHealth(host2, [report2], base + offset, uncertainDeps);
  assert.equal((await getProbeHealthViews([second.id])).get(second.id).lastAction.status, "uncertain");
  await admin.updateProbeService({ ...serviceInput, hostIds: [2], id: second.id, health: { ...health, hook: undefined } });
  for (const offset of [500, 515, 530]) await observeProbeHealth(host2, [report2], base + offset, uncertainDeps);
  assert.equal(uncertainCalls, 1);
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET createdAt = ? WHERE serviceId = ?", [base - 500, second.id]);
  await acknowledgeIpSwitch(second.id);
  assert.equal((await getProbeHealthViews([second.id])).get(second.id).lastAction.acknowledged, true);

  // Provider success followed by runtime sync failure must not be shown as fully synced.
  const third = await admin.createProbeService({ ...serviceInput, hostIds: [3], health: { ...health, hook: { ...hook, ipPath: "ip", updateAddress: "entry" } } });
  const host3 = (await db.getHostById(3))!, report3 = { ...report, serviceId: third.id };
  for (const offset of [0, 15, 30]) await observeProbeHealth(host3, [report3], base + offset, { ...deps,
    request: async (_hook, context) => ({ taskId: context.incidentId, outcome: "accepted", reason: "ok", newIp: "8.8.4.4" }),
    refresh: async () => { throw new Error("runtime_sync_failed"); },
  });
  assert.equal((await getProbeHealthViews([third.id])).get(third.id).lastAction.status, "sync_failed");

  const fourth = await admin.createProbeService({ ...serviceInput, hostIds: [4], intervalSeconds: 300, health: { ...health, autoSwitch: false } });
  await runtime.executeRaw("UPDATE host_probe_health SET state = ? WHERE serviceId = ?", [JSON.stringify({ phase: "healthy", lastSeen: base - 500 }), fourth.id]);
  assert.equal((await getProbeHealthViews([fourth.id])).get(fourth.id).state.stale, false);
  await saveProbeHealth({ ...service, id }, null);
  assert.equal((await getProbeHealthViews([id])).has(id), false);
  await admin.deleteProbeService({ id: second.id });
  assert.equal((await getProbeHealthViews([second.id])).has(second.id), false);
  assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM host_ip_switch_attempts WHERE serviceId = ?", [second.id]))[0].count, 1);
  const replacement = await admin.createProbeService({ ...serviceInput, hostIds: [2] });
  await runtime.executeRaw("UPDATE host_ip_switch_attempts SET acknowledged = 0 WHERE serviceId = ?", [second.id]);
  assert.equal((await getProbeHealthViews([replacement.id])).get(replacement.id).blockedAction.status, "uncertain");
  await acknowledgeIpSwitch(replacement.id);
  assert.equal((await getProbeHealthViews([replacement.id])).get(replacement.id).blockedAction, null);

  // Real encrypted HTTP result routes, and disabling a service while a task is queued.
  const app = express(); app.use(express.json()); app.use("/api/agent", agentEncryptionMiddleware);
  registerAgentReportRoutes(app);
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => http!.once("listening", resolve));
  const address = http.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
  const agentPost = async (hostId: number, path: string, payload: unknown) => {
    const token = `test-token-${hostId}`;
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(encryptPayload(payload, token, { timestampMs: panelCryptoNowMs() })) });
    assert.equal(response.status, 200);
    return decryptPayload(await response.json(), token);
  };
  assert.equal((await fetch(url + "/api/agent/ip-switch-result", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const fifth = await admin.createProbeService({ ...serviceInput, hostIds: [5] });
  const host5 = (await db.getHostById(5))!, report5 = { ...report, serviceId: fifth.id };
  recordIpSwitchAgentCapability(5, true);
  for (const offset of [0, 15]) await observeProbeHealth(host5, [report5], base + offset, { notify: async () => {} });
  const waiting = observeProbeHealth(host5, [report5], base + 30, { notify: async () => {} });
  const deadline = Date.now() + 3000;
  while (!hasQueuedIpSwitchAgentTasks(5) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const [task] = takeIpSwitchAgentTasks(5); assert.ok(task);
  assert.deepEqual(await agentPost(2, "/api/agent/ip-switch-claim", { taskId: task.taskId }), { allowed: false });
  await admin.updateProbeService({ ...serviceInput, hostIds: [5], id: fifth.id, isEnabled: false, health: undefined });
  assert.deepEqual(await agentPost(5, "/api/agent/ip-switch-claim", { taskId: task.taskId }), { allowed: false });
  assert.deepEqual(await agentPost(2, "/api/agent/ip-switch-result", { result: { taskId: task.taskId, outcome: "not_executed", reason: "claim_denied" } }), { success: false });
  assert.deepEqual(await agentPost(5, "/api/agent/ip-switch-result", { result: { taskId: task.taskId, outcome: "not_executed", reason: "claim_denied" } }), { success: true });
  await waiting;
  assert.equal((await getProbeHealthViews([fifth.id])).get(fifth.id).lastAction.status, "not_executed");
} finally {
  if (http) { http.closeIdleConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  await runtime.closeDatabase();
}

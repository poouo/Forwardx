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
import { getAllSettings, setSettings } from "./repositories/settingsRepository";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let http: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  await ensureDatabaseSchema();
  for (const id of [1, 2]) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", name: `User ${id}`, role: id === 1 ? "admin" : "user" });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await runtime.insertAndGetId("hosts", { id, name: `Host ${id}`, ip: "1.1.1.1", agentToken: `test-token-${id}`, userId: 1 });
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
  assert.equal((await getProbeHealthViews([id])).get(id).state.actionBlockedReason, "agent_unavailable");
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

  // Definite non-execution used to latch actionAttempted for the whole incident.
  // Retry only after the configured provider interval, using a new durable ID.
  const retryService = await admin.createProbeService({ ...serviceInput, name: "Retry after non-execution", hostIds: [6] });
  const host6 = (await db.getHostById(6))!, report6 = { ...report, serviceId: retryService.id };
  let retryCalls = 0;
  const taskIds = new Set<string>();
  const retryDeps = { ...deps, request: async (_hook: any, context: any) => {
    retryCalls++; assert.ok(!taskIds.has(context.incidentId)); taskIds.add(context.incidentId);
    return { taskId: context.incidentId, outcome: retryCalls === 1 ? "not_executed" as const : "accepted" as const, reason: retryCalls === 1 ? "expired" as const : "ok" as const };
  }};
  for (const offset of [0, 15, 30]) await observeProbeHealth(host6, [report6], base + offset, retryDeps);
  const retryView = (await getProbeHealthViews([retryService.id])).get(retryService.id);
  assert.equal(retryView.lastAction.status, "not_executed"); assert.equal(retryView.lastAction.reason, "expired");
  assert.equal(retryView.state.actionAttempted, false); assert.equal(retryView.nextSwitchAt, base + 330);
  for (const offset of [45, 300, 315]) await observeProbeHealth(host6, [report6], base + offset, retryDeps);
  assert.equal(retryCalls, 1);
  assert.equal((await getProbeHealthViews([retryService.id])).get(retryService.id).state.actionBlockedReason, "cooldown");
  await observeProbeHealth(host6, [report6], base + 330, retryDeps);
  assert.equal(retryCalls, 2);
  for (const offset of [345, 1000, 1015, 1030]) await observeProbeHealth(host6, [report6], base + offset, retryDeps);
  assert.equal(retryCalls, 2, "accepted calls never retry within the same unresolved incident");

  // The original merchant interval remains host-wide after a shorter service
  // is added or settings are edited. Read durable history, not an in-memory timer.
  const longInterval = await admin.createProbeService({ ...serviceInput, hostIds: [7], health: { ...health, cooldownSeconds: 3600 } });
  const host7 = (await db.getHostById(7))!;
  let intervalCalls = 0;
  const intervalDeps = { ...deps, request: async (_hook: any, context: any) => {
    intervalCalls++; return { taskId: context.incidentId, outcome: "accepted" as const, reason: "ok" as const };
  }};
  for (const offset of [0, 15, 30]) await observeProbeHealth(host7, [{ ...report, serviceId: longInterval.id }], base + offset, intervalDeps);
  const shortInterval = await admin.createProbeService({ ...serviceInput, hostIds: [7] });
  for (const offset of [400, 415, 430]) await observeProbeHealth(host7, [{ ...report, serviceId: shortInterval.id }], base + offset, intervalDeps);
  assert.equal(intervalCalls, 1);
  assert.equal((await getProbeHealthViews([shortInterval.id])).get(shortInterval.id).nextSwitchAt, base + 3630);
  await admin.updateProbeService({ ...serviceInput, id: shortInterval.id, hostIds: [7], health: { ...health, hook: undefined } });
  for (const offset of [500, 515, 530]) await observeProbeHealth(host7, [{ ...report, serviceId: shortInterval.id }], base + offset, intervalDeps);
  assert.equal(intervalCalls, 1);
  for (const offset of [3600, 3615, 3630]) await observeProbeHealth(host7, [{ ...report, serviceId: shortInterval.id }], base + offset, intervalDeps);
  assert.equal(intervalCalls, 2);

  // Persist only fixed, safe diagnostic fields, never raw provider responses.
  const rejected = await admin.createProbeService({ ...serviceInput, hostIds: [8] });
  const host8 = (await db.getHostById(8))!;
  for (const offset of [0, 15, 30]) await observeProbeHealth(host8, [{ ...report, serviceId: rejected.id }], base + offset, { ...deps,
    request: async (_hook, context) => ({ taskId: context.incidentId, outcome: "uncertain", reason: "http_status", httpStatus: 429 }),
  });
  const rejectedView = (await getProbeHealthViews([rejected.id])).get(rejected.id);
  assert.equal(rejectedView.lastAction.status, "uncertain"); assert.equal(rejectedView.lastAction.reason, "http_status");
  assert.equal(rejectedView.lastAction.httpStatus, 429); assert.ok(rejectedView.blockedAction);

  // Invalid saved ciphertext fails before dispatch, not as an ambiguous paid call.
  const corrupt = await admin.createProbeService({ ...serviceInput, hostIds: [9] });
  await runtime.executeRaw("UPDATE host_probe_health SET hookCiphertext = ? WHERE serviceId = ?", ["invalid-saved-ciphertext", corrupt.id]);
  const host9 = (await db.getHostById(9))!;
  let corruptCalls = 0;
  for (const offset of [0, 15, 30]) await observeProbeHealth(host9, [{ ...report, serviceId: corrupt.id }], base + offset, {
    ...deps, request: async () => { corruptCalls++; throw new Error("must not dispatch"); },
  });
  const corruptView = (await getProbeHealthViews([corrupt.id])).get(corrupt.id);
  assert.equal(corruptCalls, 0);
  assert.equal(corruptView.lastAction.status, "not_executed");
  assert.equal(corruptView.lastAction.reason, "invalid_request");
  assert.equal(corruptView.state.actionAttempted, false);
  assert.equal(corruptView.blockedAction, null);

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

  // Real recipient selection/delivery: only enabled, bound administrators,
  // never a legacy selected user, a non-admin creator, or the host's owner.
  for (const row of [
    { id: 21, username: "health-admin", role: "admin", accountEnabled: true, telegramId: "1021" },
    { id: 22, username: "disabled-admin", role: "admin", accountEnabled: false, telegramId: "1022" },
    { id: 23, username: "unbound-admin", role: "admin", accountEnabled: true },
  ]) await runtime.insertAndGetId("users", { password: "fixture-only", ...row });
  await runtime.executeRaw("UPDATE users SET telegramId = ? WHERE id = ?", ["1001", 1]);
  await runtime.executeRaw("UPDATE users SET telegramId = ? WHERE id = ?", ["1002", 2]);
  await runtime.insertAndGetId("hosts", { id: 10, name: "User-owned host", ip: "1.1.1.1", agentToken: "test-token-10", userId: 2 });
  const { notify: _notify, ...notificationHealth } = health;
  const notificationService = await admin.createProbeService({ ...serviceInput, hostIds: [10], health: { ...notificationHealth, autoSwitch: false, notifyUserId: 99999 } });
  assert.equal((await getProbeHealthViews([notificationService.id])).get(notificationService.id).notify, true);
  assert.equal((await getProbeHealthViews([notificationService.id])).get(notificationService.id).notifyUserId, null);
  const [notificationRow] = await runtime.queryRaw<any>("SELECT config FROM host_probe_health WHERE serviceId = ?", [notificationService.id]);
  assert.equal(JSON.parse(notificationRow.config).notifyUserId, null);
  await runtime.executeRaw("UPDATE host_probe_services SET userId = ? WHERE id = ?", [2, notificationService.id]);
  await runtime.executeRaw("UPDATE host_probe_health SET config = ? WHERE serviceId = ?", [JSON.stringify({ ...JSON.parse(notificationRow.config), notifyUserId: 2 }), notificationService.id]);
  assert.equal((await getProbeHealthViews([notificationService.id])).get(notificationService.id).notifyUserId, null);
  const originalSettings = await getAllSettings(), originalFetch = globalThis.fetch;
  const sentTo: string[] = [];
  let failFirstAdmin = false;
  try {
    await setSettings({ notificationChannel: "telegram", telegramBotEnabled: "true", telegramBotToken: "health-test-token" });
    globalThis.fetch = (async (input, options) => {
      assert.equal(String(input), "https://api.telegram.org/bothealth-test-token/sendMessage");
      const body = JSON.parse(String(options?.body));
      sentTo.push(String(body.chat_id));
      assert.match(body.text, /国内健康检测/);
      return Response.json(failFirstAdmin && String(body.chat_id) === "1001" ? { ok: false, description: "test delivery failure" } : { ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    const notificationHost = (await db.getHostById(10))!, notificationReport = { ...report, serviceId: notificationService.id };
    for (const offset of [0, 15, 30]) await observeProbeHealth(notificationHost, [notificationReport], base + offset);
    assert.deepEqual([...sentTo].sort(), ["1001", "1021"]);
    sentTo.length = 0; failFirstAdmin = true;
    for (const offset of [45, 60]) await observeProbeHealth(notificationHost, [{ ...notificationReport, probeSuccesses: 3 }], base + offset);
    assert.deepEqual([...sentTo].sort(), ["1001", "1021"], "one administrator's delivery failure does not block others");
    sentTo.length = 0;
    await admin.updateProbeService({ ...serviceInput, id: notificationService.id, hostIds: [10], health: { ...notificationHealth, autoSwitch: false, notify: false } });
    for (const offset of [75, 90, 105]) await observeProbeHealth(notificationHost, [notificationReport], base + offset);
    assert.deepEqual(sentTo, [], "the notification switch still disables delivery");
    assert.equal((await getProbeHealthViews([notificationService.id])).get(notificationService.id).state.phase, "unhealthy");
  } finally {
    globalThis.fetch = originalFetch;
    await setSettings(Object.fromEntries(["notificationChannel", "telegramBotEnabled", "telegramBotToken"].map(key => [key, originalSettings[key] ?? null])));
  }
} finally {
  if (http) { http.closeIdleConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  await runtime.closeDatabase();
}

import assert from "node:assert/strict";
import express from "express";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { operationsDay } from "../shared/operations";
import { queryTraffic, queryUsers } from "./ai/analytics";
import { queryPanelCall } from "./ai/panelTools";
import { readPanelResources } from "./ai/resources";
import { createMcpToken, listMcpTokens } from "./mcpTokens";
import { mcpHttpRouter } from "./mcpRoutes";
import { observeHostResources, saveMonitorSettings, monitorOverview, getMonitorSettings, getResourceAlertPolicy, saveResourceAlertPolicy, getResourceAlertServices, saveResourceAlertService, toggleResourceAlertService, deleteResourceAlertService } from "./operationsMonitor";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { hostsRouter } from "./routers/hosts";
import { hostChinaHealthSchema } from "../shared/hostChinaHealth";
import { setSetting } from "./repositories/settingsRepository";
import { diagnoseNetwork } from "./networkDiagnostics";
import { mcpRouter } from "./routers/mcp";
import { getUserById } from "./db";
import type { TrpcContext } from "./_core/context";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let http: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  await ensureDatabaseSchema();
  const now = Math.floor(Date.now() / 1000), day = operationsDay(now);
  for (let id = 1; id <= 45; id++) await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "private-password", name: `用户 ${id}`, role: id === 1 ? "admin" : "user", accountEnabled: id !== 5, expiresAt: id === 6 ? now - 100 : null });
  await runtime.insertAndGetId("hosts", { id: 1, name: "主机 A", ip: "192.0.2.1", userId: 1, agentToken: "private-agent-token" });
  for (const [id, bytes] of [[2, 100], [3, 500], [4, 300], [2, 150]]) await runtime.insertAndGetId("operations_traffic_daily", { dayStart: day, ruleId: 10 + bytes, hostId: 1, userId: id, logicalRuleId: 10, resourceKey: "host:1", ruleName: "规则 A", hostName: "主机 A", resourceName: "主机 A", bytesIn: bytes, bytesOut: bytes });
  const counts = await queryUsers({}, true);
  assert.equal(counts.total, 45); assert.equal(counts.users, 44); assert.equal(counts.disabled, 1); assert.equal(counts.expired, 1);
  const search = await queryUsers({ limit: 3 });
  assert.ok("items" in search && "hasMore" in search);
  assert.equal(search.items.length, 3); assert.equal(search.total, 45); assert.equal(search.hasMore, true);
  assert.doesNotMatch(JSON.stringify(search), /private-password/);
  const top = await queryTraffic({ id: 1, role: "admin" }, { limit: 3 });
  assert.deepEqual(top.items.map(row => Number(row.id)), [3, 4, 2]);
  assert.deepEqual(top.items.map(row => row.totalBytes), [1000, 600, 500]);
  assert.equal((await queryTraffic({ id: 1, role: "admin" }, { scope: "self" })).total, 0);
  assert.equal((await queryTraffic({ id: 2, role: "user" }, {})).items.length, 1);
  await assert.rejects(queryTraffic({ id: 2, role: "user" }, { userId: 3 }), /无权/);
  await assert.rejects(queryPanelCall(2, "users.summary", {}, readPanelResources), /管理员/);
  assert.equal((await queryPanelCall(1, "users.summary", {}, readPanelResources)).result.total, 45);
  await assert.rejects(diagnoseNetwork({ id: 2, role: "user" }, { hostId: 1 }), /无权/);
  const diagnostic = await diagnoseNetwork({ id: 1, role: "admin" }, { hostId: 1 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-agent-token|private-password/);
  assert.ok(diagnostic.checks.some(check => check.status === "unknown"));
  await saveMonitorSettings(1, { enabled: true, notify: false, cpu: 90, memory: 90, disk: 90, durationSeconds: 60, recoverySeconds: 30 });
  for (const offset of [0, 30, 60, 90]) await observeHostResources({ id: 1, name: "主机 A" }, { cpu: 95 }, now + offset);
  assert.equal((await monitorOverview()).events.length, 1);
  assert.equal((await monitorOverview()).active.length, 1);
  for (const offset of [120, 150]) await observeHostResources({ id: 1, name: "主机 A" }, { cpu: 80 }, now + offset);
  assert.equal((await monitorOverview()).events.length, 2);
  assert.equal((await monitorOverview()).active.length, 0);
  // Per-host settings must not change another host's thresholds, pending state or history.
  await runtime.insertAndGetId("hosts", { id: 2, name: "主机 B", ip: "192.0.2.2", userId: 2, agentToken: "second-private-token" });
  assert.equal((await getMonitorSettings(2)).enabled, false);
  assert.equal((await getMonitorSettings(1)).enabled, true);
  await saveMonitorSettings(2, { enabled: true, notify: false, cpu: 80, memory: 0, disk: 0, durationSeconds: 60, recoverySeconds: 30, notifyUserId: 2 });
  await observeHostResources({ id: 2 }, { cpu: 85, memory: 100 }, now);
  await saveMonitorSettings(1, { enabled: false });
  assert.equal((await runtime.queryRaw<any>("SELECT * FROM operations_alert_state WHERE hostId = 2"))[0]?.phase, "pending");
  assert.equal((await getMonitorSettings(2)).cpu, 80);
  for (const offset of [30, 60]) await observeHostResources({ id: 2 }, { cpu: 85, memory: 100 }, now + offset);
  let monitor = await monitorOverview();
  assert.equal(monitor.active.length, 1);
  assert.equal(monitor.active[0].hostId, 2);
  assert.equal(monitor.events.length, 3); // notify=false still records events; memory=0 never alerts.
  await saveMonitorSettings(2, { enabled: false, notify: false });
  assert.equal((await monitorOverview()).active.length, 0);
  assert.equal((await monitorOverview()).events.length, 3);

  const hostCaller = (id: number, role: string) => hostsRouter.createCaller({ user: { id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  await assert.rejects(hostCaller(2, "user").resourceAlertSettings({ hostId: 2 }), (error: any) => error.code === "FORBIDDEN");
  await assert.rejects(hostCaller(2, "user").saveResourceAlertSettings({ hostId: 2, settings: { enabled: true } } as any), (error: any) => error.code === "FORBIDDEN");
  assert.equal((await hostCaller(1, "admin").resourceAlertSettings({ hostId: 2 })).enabled, false);
  await assert.rejects(hostCaller(1, "admin").resourceAlertSettings({ hostId: 99999 }), (error: any) => error.code === "NOT_FOUND");
  assert.equal((await saveMonitorSettings(1, { notifyUserId: 99999 })).notifyUserId, null);

  // Scoped policies are administrator-only, persisted, and apply to future hosts.
  await assert.rejects(hostCaller(2, "user").resourceAlertPolicy(), (error: any) => error.code === "FORBIDDEN");
  await assert.rejects(hostCaller(2, "user").saveResourceAlertPolicy({ hostScope: "all", settings: { enabled: true } } as any), (error: any) => error.code === "FORBIDDEN");
  assert.equal((await getResourceAlertPolicy()).settings.enabled, false);
  const scopedSettings = { enabled: true, notify: false, cpu: 80, memory: 0, disk: 0, durationSeconds: 60, recoverySeconds: 30, notifyUserId: 2 };
  await hostCaller(1, "admin").saveResourceAlertPolicy({ hostScope: "all", settings: scopedSettings } as any);
  assert.equal((await getResourceAlertPolicy()).settings.notifyUserId, null);
  assert.equal((await getMonitorSettings(1)).enabled, true);
  assert.equal((await getMonitorSettings(2)).enabled, true);
  await runtime.insertAndGetId("hosts", { id: 3, name: "主机 C", ip: "192.0.2.3", userId: 1 });
  assert.equal((await getMonitorSettings(3)).enabled, true, "all hosts includes new hosts without another save");
  assert.ok((await runtime.queryRaw<any>("SELECT value FROM system_settings WHERE key = ?", ["hostResourceAlertPolicy"]))[0]?.value);

  await saveResourceAlertPolicy({ hostScope: "exclude", excludeHostIds: [1], settings: scopedSettings });
  assert.equal((await getMonitorSettings(1)).enabled, false, "exclusion overrides a previously enabled per-host configuration");
  assert.equal((await getMonitorSettings(2)).enabled, true);
  assert.equal((await getMonitorSettings(3)).enabled, true);
  for (const offset of [300, 330, 360]) {
    await observeHostResources({ id: 1 }, { cpu: 95 }, now + offset);
    await observeHostResources({ id: 2 }, { cpu: 95 }, now + offset);
  }
  monitor = await monitorOverview();
  assert.equal(monitor.active.length, 1);
  assert.equal(monitor.active[0].hostId, 2);
  const historyCount = monitor.events.length;
  await saveResourceAlertPolicy({ hostScope: "specific", hostIds: [1, 3, 3], settings: scopedSettings });
  assert.deepEqual((await hostCaller(1, "admin").resourceAlertPolicy()).hostIds, [1, 3]);
  assert.equal((await getMonitorSettings(2)).enabled, false);
  assert.equal((await getMonitorSettings(3)).enabled, true);
  assert.equal((await monitorOverview()).active.length, 0, "scope changes reset active state");
  assert.equal((await monitorOverview()).events.length, historyCount, "scope changes retain history");
  await runtime.insertAndGetId("hosts", { id: 4, name: "主机 D", ip: "192.0.2.4", userId: 1 });
  assert.equal((await getMonitorSettings(4)).enabled, false, "specific selection does not include new hosts");
  await assert.rejects(hostCaller(1, "admin").saveResourceAlertPolicy({ hostScope: "specific", hostIds: [99999], settings: scopedSettings } as any), (error: any) => error.code === "NOT_FOUND");
  await assert.rejects(hostCaller(1, "admin").saveResourceAlertPolicy({ hostScope: "specific", hostIds: [], settings: scopedSettings } as any), (error: any) => error.code === "BAD_REQUEST");
  assert.deepEqual((await getResourceAlertPolicy()).hostIds, [1, 3], "invalid saves do not modify the policy");

  // An already queued observation cannot repopulate state after a policy save.
  let releaseObservation!: () => void;
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve; });
  const held = withKeyedTaskLock("host-resource-alert:1", () => observationGate);
  const queued = observeHostResources({ id: 1 }, { cpu: 95 }, now + 400);
  let saved = false;
  const replacing = saveResourceAlertPolicy({ hostScope: "exclude", excludeHostIds: [1], settings: scopedSettings }).then(value => { saved = true; return value; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(saved, false, "policy save waits for the old observation before clearing state");
  } finally { releaseObservation(); }
  await Promise.all([held, queued, replacing]);
  assert.equal((await getMonitorSettings(1)).enabled, false);
  assert.equal((await runtime.queryRaw<any>("SELECT * FROM operations_alert_state")).length, 0);
  assert.equal((await getMonitorSettings(4)).enabled, true, "excluded selection includes later hosts");
  await saveResourceAlertPolicy({ hostScope: "all", settings: { enabled: false } });
  assert.equal((await getMonitorSettings(3)).enabled, false);

  await setSetting("hostResourceAlertPolicy", "invalid-json");
  assert.equal((await getMonitorSettings(3)).enabled, false, "invalid policy fails closed");
  await saveResourceAlertPolicy({ hostScope: "all", settings: { enabled: false } });

  // Single-metric services preserve legacy settings, then observe independently per service and host.
  for (const method of ["resourceAlertServices", "saveResourceAlertService", "toggleResourceAlertService", "deleteResourceAlertService"] as const) {
    const input: any = method === "resourceAlertServices" ? undefined : method === "saveResourceAlertService" ? { service: { name: "CPU", metric: "cpu" } } : { id: "legacy-cpu", enabled: true };
    await assert.rejects((hostCaller(2, "user")[method] as any)(input), (error: any) => error.code === "FORBIDDEN");
  }
  await saveResourceAlertPolicy({ hostScope: "specific", hostIds: [1], settings: { ...scopedSettings, memory: 85, disk: 0 } });
  const converted = await getResourceAlertServices();
  assert.deepEqual(converted.map(service => service.metric), ["cpu", "memory"]);
  assert.equal(converted[0].threshold, 80);
  assert.deepEqual(converted[0].hostIds, [1]);
  assert.equal((await runtime.queryRaw("SELECT * FROM system_settings WHERE key = ?", ["hostResourceAlertServices"])).length, 0, "reading legacy services does not mutate storage");
  const diskService = await hostCaller(1, "admin").saveResourceAlertService({ service: { name: "Disk alert", metric: "disk", threshold: 90, notify: false, durationSeconds: 60, recoverySeconds: 30, hostScope: "exclude", excludeHostIds: [2] } } as any);
  assert.equal((await getResourceAlertServices()).length, 3);
  assert.equal((await runtime.queryRaw("SELECT * FROM operations_alert_state")).length, 0, "legacy active states do not duplicate converted services");
  const beforeServiceEvents = (await monitorOverview()).total;
  for (const offset of [600, 630, 660]) {
    await observeHostResources({ id: 1, name: "主机 A" }, { cpu: 95, memory: 90, disk: 96 }, now + offset);
    await observeHostResources({ id: 2 }, { cpu: 95, memory: 90, disk: 96 }, now + offset);
  }
  monitor = await monitorOverview();
  assert.equal(monitor.active.length, 3);
  assert.equal(monitor.total, beforeServiceEvents + 3);
  assert.ok(monitor.active.every(row => row.hostId === 1));
  assert.ok(monitor.events.some(row => row.serviceName === "Disk alert" && row.metric === "disk"));
  const [slow, high] = await Promise.all([
    saveResourceAlertService({ name: "Slow CPU", metric: "cpu", threshold: 80, durationSeconds: 120, recoverySeconds: 30, notify: false, hostScope: "specific", hostIds: [1] }),
    saveResourceAlertService({ name: "High CPU", metric: "cpu", threshold: 99, durationSeconds: 60, recoverySeconds: 30, notify: false, hostScope: "specific", hostIds: [1] }),
  ]);
  assert.equal((await getResourceAlertServices()).length, 5, "concurrent additions do not overwrite each other");
  for (const offset of [690, 720]) await observeHostResources({ id: 1 }, { cpu: 95, memory: 90, disk: 96 }, now + offset);
  const slowSince = (await runtime.queryRaw<any>("SELECT * FROM resource_alert_service_state WHERE serviceId = ?", [slow.id]))[0].since;
  await saveResourceAlertService({ ...(({ id, ...input }) => input)(high), threshold: 85 }, high.id);
  assert.equal((await runtime.queryRaw<any>("SELECT * FROM resource_alert_service_state WHERE serviceId = ?", [slow.id]))[0].since, slowSince, "editing one service preserves another service's pending window");
  for (const offset of [750, 780, 810]) await observeHostResources({ id: 1 }, { cpu: 95, memory: 90, disk: 96 }, now + offset);
  assert.equal((await monitorOverview()).active.length, 5, "multiple CPU services do not share state or prevent each other from triggering");
  await toggleResourceAlertService(converted[0].id, false);
  assert.equal((await monitorOverview()).active.length, 4);
  for (const offset of [840, 870]) await observeHostResources({ id: 1 }, { cpu: 95, memory: 60, disk: 96 }, now + offset);
  assert.equal((await monitorOverview()).active.length, 3);
  assert.ok((await monitorOverview()).events.some(row => row.serviceId === converted[1].id && row.type === "recovered"));
  const retainedEvents = (await monitorOverview()).total;
  await deleteResourceAlertService(diskService.id);
  assert.equal((await monitorOverview()).active.length, 2);
  assert.equal((await monitorOverview()).total, retainedEvents, "deleting a service preserves its named historical events");
  await assert.rejects(saveResourceAlertService({ name: "Invalid", metric: "cpu", hostScope: "specific", hostIds: [9999] }), /主机不存在/);
  await assert.rejects(saveResourceAlertService({ name: "Missing", metric: "cpu" }, "nonexistent"), /服务不存在/);
  // Drain observations before disable/delete, including an observation already waiting on a host lock.
  let releaseServiceObservation!: () => void;
  const heldService = withKeyedTaskLock("host-resource-alert:1", () => new Promise<void>(resolve => { releaseServiceObservation = resolve; }));
  const queuedService = observeHostResources({ id: 1 }, { cpu: 95 }, now + 900);
  let serviceSaved = false;
  const disabling = toggleResourceAlertService(slow.id, false).then(() => { serviceSaved = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(serviceSaved, false);
  } finally { releaseServiceObservation(); }
  await Promise.all([heldService, queuedService, disabling]);
  assert.equal((await runtime.queryRaw("SELECT * FROM resource_alert_service_state WHERE serviceId = ?", [slow.id])).length, 0);
  for (const service of await getResourceAlertServices()) await deleteResourceAlertService(service.id);
  assert.deepEqual(await getResourceAlertServices(), []);
  await observeHostResources({ id: 1 }, { cpu: 100, memory: 100, disk: 100 }, now + 930);
  assert.equal((await monitorOverview()).active.length, 0, "empty service list never revives the old enabled policy");
  await setSetting("hostResourceAlertServices", "invalid-json");
  assert.deepEqual(await getResourceAlertServices(), [], "invalid services fail closed");
  await setSetting("hostResourceAlertServices", "[]");

  // Dashboard status/history includes IP changes without exposing any merchant configuration.
  const serviceId = await runtime.insertAndGetId("host_probe_services", { name: "国内探测", userId: 1, targetIp: "223.5.5.5", hostScope: "specific", hostIds: "[2]" });
  await runtime.insertAndGetId("host_probe_health", { serviceId, hostId: 2, config: JSON.stringify(hostChinaHealthSchema.parse({ enabled: true, notify: false })), hookCiphertext: "private-provider-credentials", state: JSON.stringify({ phase: "unhealthy", failures: 5, successes: 0, failureSince: now, lastSeen: now, incidentId: "incident", actionAttempted: true }), updatedAt: now });
  for (let id = 0; id < 25; id++) await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 2, serviceId, incidentId: `switch-${id}`, status: id === 24 ? "accepted" : "succeeded", newIp: "192.0.2.20", createdAt: now });
  await runtime.insertAndGetId("host_ip_switch_attempts", { hostId: 2, serviceId, incidentId: "expired-switch", status: "succeeded", createdAt: now - 31 * 86400 });
  monitor = await monitorOverview();
  assert.equal(monitor.health[0].state.phase, "unhealthy");
  assert.equal(monitor.ipTotal, 25);
  assert.equal(monitor.ipEvents.length, 20);
  assert.equal(monitor.ipEvents[0].status, "accepted");
  assert.equal((await monitorOverview(0, 1)).ipEvents.length, 5);
  assert.doesNotMatch(JSON.stringify(monitor), /private-provider|hookCiphertext|second-private-token|resourceAlertConfig/);
  const callerFor = async (userId: number) => mcpRouter.createCaller({
    user: await getUserById(userId), authSession: null, authFailureReason: null,
    req: { headers: {}, socket: {}, protocol: "https", get: () => undefined },
    res: { clearCookie: () => undefined },
  } as unknown as TrpcContext);
  const userCaller = await callerFor(2);
  const forbidden = (error: any) => error.code === "FORBIDDEN";
  await assert.rejects(userCaller.tokens(), forbidden);
  await assert.rejects(userCaller.createToken({ name: "not-allowed", days: 7 }), forbidden);
  await assert.rejects(userCaller.revokeToken({ id: 1 }), forbidden);
  const adminCaller = await callerFor(1);
  const adminToken = await adminCaller.createToken({ name: "external-client", days: 7 });
  // Simulate an ordinary user's token issued before MCP became admin-only.
  const userToken = await createMcpToken(2, "legacy-user-client", 30);
  assert.doesNotMatch(JSON.stringify(await listMcpTokens(1)), /tokenHash|fxm_[a-f0-9]{64}/);
  const stored = await runtime.queryRaw<any>("SELECT * FROM external_mcp_tokens WHERE id = ?", [adminToken.id]);
  assert.notEqual(stored[0].tokenHash, adminToken.token); assert.equal(stored[0].tokenHash.length, 64);
  const app = express(); app.use(mcpHttpRouter); app.use(express.json({ limit: "10mb" }));
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => http!.once("listening", resolve));
  const address = http.address() as { port: number }, url = `http://127.0.0.1:${address.port}/mcp`;
  const call = (token: string, method: string, params: any = {}, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await call(adminToken.token, "tools/list", {}, { Authorization: adminToken.token })).status, 401);
  assert.equal((await call(adminToken.token, "tools/list", {}, { Origin: "not a valid origin" })).status, 403);
  assert.equal((await call(adminToken.token, "tools/call", { name: "users.summary", arguments: { keyword: "x".repeat(66000) } })).status, 413);
  assert.equal((await call(adminToken.token, "initialize", { protocolVersion: "2025-06-18" })).status, 200);
  assert.equal((await call(userToken.token, "initialize")).status, 403);
  assert.equal((await call(userToken.token, "tools/list")).status, 403);
  assert.equal((await call(userToken.token, "tools/call", { name: "traffic.rank" })).status, 403);
  const list = await (await call(adminToken.token, "tools/list")).json() as any;
  assert.ok(list.result.tools.some((tool: any) => tool.name === "traffic.rank"));
  assert.ok(list.result.tools.some((tool: any) => tool.name === "users.summary"));
  const response = await (await call(adminToken.token, "tools/call", { name: "users.summary", arguments: {} })).json() as any;
  assert.equal(JSON.parse(response.result.content[0].text).result.total, 45);
  assert.equal((await (await call(adminToken.token, "tools/call", { name: "settings.set", arguments: { key: "pluginsEnabled", value: false } })).json() as any).result.isError, true);
  await runtime.executeRaw("UPDATE users SET role = 'user' WHERE id = 1");
  assert.equal((await call(adminToken.token, "tools/list")).status, 403);
  await runtime.executeRaw("UPDATE users SET role = 'admin' WHERE id = 1");
  assert.equal((await call(adminToken.token, "tools/list")).status, 200);
  await setSetting("panelPublicUrl", "https://panel.example.com");
  assert.equal((await call(adminToken.token, "tools/list", {}, { Origin: "https://evil.example" })).status, 403);
  await adminCaller.revokeToken({ id: adminToken.id });
  assert.equal((await call(adminToken.token, "tools/list")).status, 401);
  const expiredToken = await createMcpToken(1, "expired-client", 7);
  await runtime.executeRaw('UPDATE external_mcp_tokens SET "expiresAt" = ? WHERE id = ?', [now - 1, expiredToken.id]);
  assert.equal((await call(expiredToken.token, "tools/list")).status, 401);
  await runtime.executeRaw('UPDATE users SET "accountEnabled" = 0 WHERE id = 2');
  assert.equal((await call(userToken.token, "tools/list")).status, 401);
} finally {
  if (http) { http.closeIdleConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  await runtime.closeDatabase();
}

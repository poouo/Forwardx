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
import { observeHostResources, saveMonitorSettings, monitorOverview, getMonitorSettings } from "./operationsMonitor";
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
  await assert.rejects(saveMonitorSettings(1, { notifyUserId: 99999 }), /通知用户不存在/);

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

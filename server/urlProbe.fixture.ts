import assert from "node:assert/strict";
import express from "express";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { hostsRouter } from "./routers/hosts";
import { registerAgentReportRoutes } from "./agentReportRoutes";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";
import { encryptPayload } from "./agentCrypto";
import { panelCryptoNowMs } from "./panelClock";
import { urlProbeKey } from "./urlProbe";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let http: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  // Reproduce an existing database rather than only testing a clean install.
  await runtime.executeRaw(`CREATE TABLE host_probe_services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, method VARCHAR(16) NOT NULL DEFAULT 'tcping', targetIp TEXT NOT NULL, targetPort INTEGER, hostScope VARCHAR(16) NOT NULL DEFAULT 'all', hostIds TEXT, excludeHostIds TEXT, intervalSeconds INTEGER NOT NULL DEFAULT 30, isEnabled INTEGER NOT NULL DEFAULT 1, sortOrder INTEGER NOT NULL DEFAULT 0, userId INTEGER NOT NULL, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)`);
  await runtime.executeRaw("INSERT INTO host_probe_services (id, name, targetIp, targetPort, userId, isEnabled) VALUES (91, 'Legacy TCP', '1.1.1.1', 443, 1, 0)");
  await ensureDatabaseSchema();
  const legacy = (await db.getHostProbeServiceById(91))!;
  assert.equal(legacy.method, "tcping"); assert.equal(legacy.timeoutSeconds, 5); assert.equal(legacy.expectedStatus, 200); assert.equal(legacy.targetUrl, null);
  for (const id of [1, 2]) {
    await runtime.insertAndGetId("users", { id, username: `user-${id}`, password: "test", role: id === 1 ? "admin" : "user" });
    await runtime.insertAndGetId("hosts", { id, name: `Host ${id}`, ip: "1.1.1.1", agentToken: `url-token-${id}`, userId: 1 });
  }
  const caller = (id: number, role: string) => hostsRouter.createCaller({ user: { id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const admin = caller(1, "admin"), user = caller(2, "user");
  const input = { name: "URL Check", method: "url" as const, targetUrl: "https://example.com/health?x=1&y=2", expectedStatus: 204, timeoutSeconds: 3, hostScope: "specific" as const, hostIds: [1] };
  await assert.rejects(user.createProbeService(input), (error: any) => error.code === "FORBIDDEN");
  for (const change of [{ targetUrl: "ftp://example.com" }, { targetUrl: "https://user:pass@example.com" }, { targetUrl: null }, { expectedStatus: 0 }, { timeoutSeconds: 31 }]) await assert.rejects(admin.createProbeService({ ...input, ...change } as any));
  await assert.rejects(admin.createProbeService({ ...input, health: { enabled: true } }), /仅支持 Ping/);
  const { id } = await admin.createProbeService(input);
  let service = (await db.getHostProbeServiceById(id))!;
  assert.equal(service.method, "url"); assert.equal(service.targetIp, "example.com"); assert.equal(service.targetUrl, input.targetUrl);
  assert.equal(service.timeoutSeconds, 3); assert.equal(service.expectedStatus, 204);
  assert.deepEqual(await user.probeServices(), []);
  const [task] = (await db.getHostProbeTasksForHost(1)).filter((task: any) => task.serviceId === id);
  assert.equal(task.targetPort, 0); // Old Agents skip this instead of testing only TCP.
  assert.equal(task.probeKey, urlProbeKey(task));
  assert.equal((await db.getHostProbeTasksForHost(2)).some((task: any) => task.serviceId === id), false);
  const app = express(); app.use(express.json()); app.use("/api/agent", agentEncryptionMiddleware); registerAgentReportRoutes(app);
  http = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => http!.once("listening", resolve));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const report = { serviceId: id, method: "url", targetIp: "example.com", probeKey: task.probeKey, latencyMs: 21, isTimeout: false, probeCount: 1, probeSuccesses: 1 };
  const post = async (payload: any, hostId = 1) => {
    const token = `url-token-${hostId}`;
    const response = await fetch(base + "/api/agent/tcping", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(encryptPayload({ services: [payload] }, token, { timestampMs: panelCryptoNowMs() })) });
    assert.equal(response.status, 200, await response.text());
  };
  const count = async () => (await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM host_probe_service_stats WHERE serviceId = ?", [id]))[0].count;
  await post({ ...report, method: "tcping" }); assert.equal(await count(), 0);
  await post(report, 2); assert.equal(await count(), 0);
  await post(report); assert.equal(await count(), 1);
  const latest = (await db.getLatestHostProbeServiceStats([id], 1)).get(id)!;
  assert.equal(latest.latencyMs, 21); assert.equal(latest.probeSuccesses, 1);
  await admin.updateProbeService({ ...input, id, targetUrl: "https://example.com/other", expectedStatus: 200 });
  await post(report); assert.equal(await count(), 1); // Old URL request completed after edit.
  const [updatedTask] = (await db.getHostProbeTasksForHost(1)).filter((task: any) => task.serviceId === id);
  await post({ ...report, probeKey: updatedTask.probeKey, latencyMs: 0, isTimeout: true, probeSuccesses: 0 });
  assert.equal(await count(), 2);
  assert.equal((await db.getLatestHostProbeServiceStats([id], 1)).get(id)!.isTimeout, true);
  await admin.updateProbeService({ ...input, id, isEnabled: false });
  assert.equal((await db.getHostProbeTasksForHost(1)).some((task: any) => task.serviceId === id), false);
  await admin.updateProbeService({ ...input, id, isEnabled: true });
  service = (await db.getHostProbeServiceById(id))!; assert.equal(service.targetUrl, input.targetUrl);
  await admin.deleteProbeService({ id }); assert.equal(await count(), 0); assert.equal(await db.getHostProbeServiceById(id), null);
} finally {
  if (http) { http.closeIdleConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
  await runtime.closeDatabase();
}

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { plansRouter } from "./routers/plans";
import { registerAgentReportRoutes } from "./agentReportRoutes";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
let server: http.Server | undefined;
try {
  // Upgrade an actual legacy table and retain its historical accounting mode.
  await runtime.executeRaw("CREATE TABLE subscription_plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, trafficLimit INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)");
  await runtime.executeRaw("INSERT INTO subscription_plans (id, name) VALUES (100, 'Legacy plan')");
  await ensureDatabaseSchema();
  assert.equal((await db.getSubscriptionPlanById(100))!.trafficMode, "both");
  await ensureDatabaseSchema();
  await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "test", role: "admin" });
  await runtime.insertAndGetId("users", { id: 2, username: "subscriber", password: "test", role: "user", balanceCents: 10000 });
  await runtime.insertAndGetId("hosts", { id: 1, userId: 1, name: "Entry", ip: "203.0.113.1", agentToken: "plan-mode-test-token", portRangeStart: 10000, portRangeEnd: 50000 });
  const admin = plansRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const plan = await admin.create({ name: "Outbound", priceCents: 0, hostIds: [1], portCount: 1, trafficLimit: 100000, trafficMode: "outbound" });
  const twoWayPlan = await admin.create({ name: "Two-way", priceCents: 0, hostIds: [1], portCount: 1, trafficLimit: 100000 });
  assert.equal(plan!.trafficMode, "outbound"); assert.equal(twoWayPlan!.trafficMode, "both");
  await assert.rejects(admin.create({ name: "Invalid", priceCents: 0, hostIds: [1], trafficMode: "invalid" as any }));
  const oneWaySub = await admin.assign({ userId: 2, planId: plan!.id });
  const twoWaySub = await admin.assign({ userId: 2, planId: twoWayPlan!.id });
  assert.equal((await db.getActiveUserSubscriptions(2)).find(sub => sub.id === oneWaySub.subscriptionId)!.trafficMode, "outbound");
  const createRule = (id: number, port: number, extra = {}) => runtime.insertAndGetId("forward_rules", {
    id, userId: 2, hostId: 1, sourcePort: port, name: `Rule ${id}`, targetIp: "198.51.100.1", targetPort: 443, protocol: "tcp", forwardType: "gost", ...extra,
  });
  await createRule(1, oneWaySub.portRangeStart);
  await createRule(2, twoWaySub.portRangeStart);
  await createRule(3, 50001); // A manual rule outside all assigned plan ranges.
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.agentToken = "plan-mode-test-token"; next(); });
  registerAgentReportRoutes(app);
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const post = async (reportId: string, ruleId: number, bytesIn = 100, bytesOut = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/traffic`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportId, reportProducerId: "plan-mode-producer", stats: [{ ruleId, bytesIn, bytesOut, connections: 1 }] }) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const used = async () => Number((await db.getUserById(2))!.trafficUsed);
  const assertDelta = async (reportId: string, ruleId: number, expected: number, bytesIn = 100, bytesOut = 200) => {
    const before = await used(); await post(reportId, ruleId, bytesIn, bytesOut); assert.equal(await used(), before + expected, reportId);
  };
  await assertDelta("outbound", 1, 200);
  assert.equal((await post("outbound", 1)).duplicate, true);
  assert.equal(await used(), 200);
  await assertDelta("outbound-upload-only", 1, 0, 100, 0);
  await assertDelta("both", 2, 300);
  await assertDelta("manual", 3, 300);
  assert.deepEqual(await runtime.queryRaw("SELECT bytesIn, bytesOut FROM traffic_stats WHERE ruleId = 1 ORDER BY id"), [{ bytesIn: 100, bytesOut: 200 }, { bytesIn: 100, bytesOut: 0 }]);

  await admin.updateFields({ id: plan!.id, trafficMode: "both", syncExistingSubscribers: false });
  await assertDelta("frozen-snapshot", 1, 200);
  await admin.updateFields({ id: plan!.id, trafficMode: "both", syncExistingSubscribers: true });
  await assertDelta("synced-snapshot", 1, 300);
  await admin.updateFields({ id: plan!.id, trafficMode: "outbound", syncExistingSubscribers: true });
  await assertDelta("changed-back", 1, 200);
  const [snapshotRow] = await runtime.queryRaw<any>("SELECT planSnapshot FROM user_subscriptions WHERE id = ?", [oneWaySub.subscriptionId]);
  const oldSnapshot = JSON.parse(snapshotRow.planSnapshot); delete oldSnapshot.trafficMode;
  await runtime.executeRaw("UPDATE user_subscriptions SET planSnapshot = ? WHERE id = ?", [JSON.stringify(oldSnapshot), oneWaySub.subscriptionId]);
  await assertDelta("legacy-snapshot-default", 1, 300);
  await runtime.executeRaw("UPDATE user_subscriptions SET planSnapshot = NULL WHERE id = ?", [oneWaySub.subscriptionId]);
  await assertDelta("legacy-live-plan", 1, 200);
  await runtime.executeRaw("UPDATE user_subscriptions SET expiresAt = ? WHERE id = ?", [1, oneWaySub.subscriptionId]);
  await assertDelta("expired-no-discount", 1, 300);
  await runtime.executeRaw("UPDATE user_subscriptions SET expiresAt = NULL, status = 'cancelled' WHERE id = ?", [oneWaySub.subscriptionId]);
  await assertDelta("cancelled-no-discount", 1, 300);

  // Physical group children inherit the logical rule's owner and port.
  await runtime.insertAndGetId("forward_groups", { id: 20, userId: 1, name: "Port group", groupMode: "port", targetIp: "0.0.0.0", trafficMultiplier: 200 });
  await runtime.insertAndGetId("forward_group_members", { id: 21, groupId: 20, memberType: "host", hostId: 1 });
  await createRule(20, 42000, { forwardGroupId: 20, isForwardGroupTemplate: true });
  await createRule(21, 43000, { userId: 1, forwardGroupId: 20, forwardGroupRuleId: 20, forwardGroupMemberId: 21 });
  await runtime.insertAndGetId("user_subscriptions", { userId: 2, planId: plan!.id, portRangeStart: 42000, portRangeEnd: 42000,
    planSnapshot: JSON.stringify({ trafficMode: "outbound", forwardGroupIds: [20] }) });
  await assertDelta("group-logical-port-and-multiplier", 21, 400);
  assert.equal((await db.getUserById(1))!.trafficUsed, 0);

  // Standalone pay-as-you-go products retain their own two-way accounting.
  await db.setSetting("trafficBillingEnabled", "true");
  await runtime.insertAndGetId("traffic_billing_configs", { resourceType: "host", resourceId: 1, enabled: true, requiresPermission: false, pricePerGbCents: 1 });
  const beforeMetered = await used();
  await post("metered-unchanged", 2);
  assert.equal(await used(), beforeMetered);
  assert.equal(Number((await runtime.queryRaw<any>("SELECT totalBytes FROM traffic_billing_usage WHERE userId = 2"))[0].totalBytes), 300);
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  await runtime.closeDatabase();
}

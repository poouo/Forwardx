import assert from "node:assert/strict";
import * as runtime from "./dbRuntime";
import * as db from "./db";
import { ensureDatabaseSchema } from "./dbSchema";
import { plansRouter } from "./routers/plans";
import { portsRulesRouter } from "./routers/rules.ports";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
try {
  await ensureDatabaseSchema();
  for (let id = 1; id <= 5; id++) await runtime.insertAndGetId("users", {
    id, username: `ports-user-${id}`, password: "test", role: id === 1 ? "admin" : "user", balanceCents: 10000,
  });
  for (const id of [1, 2]) await runtime.insertAndGetId("hosts", {
    id, userId: 1, name: `Entry ${id}`, ip: `203.0.113.${id}`, portRangeStart: 10000, portRangeEnd: 20000,
  });
  const admin = plansRouter.createCaller({ user: { id: 1, role: "admin" }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  const unlimited = await admin.create({ name: "Unlimited", priceCents: 0, hostIds: [1], portCount: 0, trafficMode: "outbound" });
  const finite = await admin.create({ name: "Finite", priceCents: 0, hostIds: [2], portCount: 2 });
  const large = await admin.create({ name: "Large", priceCents: 0, hostIds: [1], portCount: 2048 });
  assert.equal(unlimited!.portCount, 0);
  await assert.rejects(admin.create({ name: "Negative", priceCents: 0, hostIds: [1], portCount: -1 }));
  await assert.rejects(admin.create({ name: "Fractional", priceCents: 0, hostIds: [1], portCount: 1.5 }));
  await assert.rejects(admin.create({ name: "Impossible", priceCents: 0, hostIds: [1], portCount: 65536 }));

  // Buying unlimited never consumes or reserves the complete port pool.
  const bought = await db.purchasePlanWithBalance(2, unlimited!.id);
  const another = await admin.assign({ userId: 3, planId: unlimited!.id });
  assert.equal(bought.portRangeStart, null);
  assert.equal(bought.portRangeEnd, null);
  assert.equal(another.portRangeStart, null);
  assert.equal((await db.getUserById(2))!.maxPorts, 0);
  assert.deepEqual(await db.findAvailableSubscriptionPortBlock(2, [1], []), { start: 10000, end: 10001 });
  const largeSub = await admin.assign({ userId: 4, planId: large!.id });
  assert.equal(largeSub.portRangeEnd! - largeSub.portRangeStart! + 1, 2048);
  const finiteSub = await admin.assign({ userId: 2, planId: finite!.id });
  const finiteRange = await db.getUserPlanPortRange(2, 2);
  assert.deepEqual(finiteRange!.ranges, [{ start: finiteSub.portRangeStart, end: finiteSub.portRangeEnd }]);
  assert.equal(db.isPortAllowedByUserPlanRange(19000, finiteRange), false, "another resource's unlimited plan cannot broaden this finite plan");
  assert.deepEqual((await db.getUserPlanPortRange(2, 1))!.ranges, [{ start: 1, end: 65535 }]);
  const modes = await db.getPlanTrafficModesForRules([{ id: 101, userId: 2, hostId: 1, sourcePort: 19000 }]);
  assert.equal(modes.get(101), "outbound", "unlimited ports still match the correct traffic mode");

  const user = portsRulesRouter.createCaller({ user: { id: 2, role: "user", accountEnabled: true }, req: { headers: {} }, res: {}, authSession: null, authFailureReason: null } as any);
  assert.deepEqual(await user.effectivePortPolicy({ hostId: 1 }), { rangeText: "10000-20000" });
  assert.deepEqual(await user.checkPort({ hostId: 1, sourcePort: 19000, protocol: "tcp" }), { used: false });
  assert.equal((await user.checkPort({ hostId: 1, sourcePort: 9999, protocol: "tcp" })).used, true, "host restrictions remain enforced");
  await runtime.insertAndGetId("forward_rules", { userId: 2, hostId: 1, name: "Busy", sourcePort: 19000, targetIp: "198.51.100.1", targetPort: 443, protocol: "tcp", forwardType: "gost" });
  assert.equal((await user.checkPort({ hostId: 1, sourcePort: 19000, protocol: "tcp" })).used, true, "unlimited never bypasses listener conflicts");

  // Renewal keeps unlimited ports; turning sync off freezes old rights.
  const renewed = await db.purchasePlanWithBalance(2, unlimited!.id, undefined, bought.subscriptionId);
  assert.equal(renewed.portRangeStart, null);
  await admin.updateFields({ id: unlimited!.id, portCount: 3, syncExistingSubscribers: false });
  assert.equal((await db.getActiveUserSubscriptions(2)).find(sub => sub.id === bought.subscriptionId)!.portCount, 0);
  assert.deepEqual((await db.getUserPlanPortRange(2, 1))!.ranges, [{ start: 1, end: 65535 }]);
  // Explicit renewal takes the latest finite plan and obtains a real block.
  const limitedRenewal = await db.purchasePlanWithBalance(2, unlimited!.id, undefined, bought.subscriptionId);
  assert.equal(limitedRenewal.portRangeEnd! - limitedRenewal.portRangeStart! + 1, 3);
  await admin.updateFields({ id: unlimited!.id, portCount: 3, syncExistingSubscribers: true });
  assert.equal((await db.getUserSubscriptionById(another.subscriptionId))!.portRangeStart! > 0, true);
  // Synchronized finite -> unlimited releases reservations and expands rights.
  await admin.updateFields({ id: unlimited!.id, portCount: 0, syncExistingSubscribers: true });
  assert.equal((await db.getUserSubscriptionById(bought.subscriptionId))!.portRangeStart, null);
  assert.equal((await db.getUserSubscriptionById(another.subscriptionId))!.portRangeEnd, null);
  assert.deepEqual((await db.getUserPlanPortRange(2, 1))!.ranges, [{ start: 1, end: 65535 }]);

  // A cancelled unlimited subscription no longer broadens a finite one.
  const sameHostFinite = await admin.assign({ userId: 2, planId: large!.id });
  assert.deepEqual((await db.getUserPlanPortRange(2, 1))!.ranges, [{ start: 1, end: 65535 }]);
  await db.cancelUserSubscription(bought.subscriptionId);
  assert.deepEqual((await db.getUserPlanPortRange(2, 1))!.ranges, [{ start: sameHostFinite.portRangeStart, end: sameHostFinite.portRangeEnd }]);
  assert.deepEqual((await db.getUserPlanPortRange(2, 2))!.ranges, finiteRange!.ranges);
  const renewedAgain = await db.purchasePlanWithBalance(3, unlimited!.id);
  assert.equal(renewedAgain.portRangeStart, null);

  // Entry-group/forward-group resources use the same unlimited policy.
  await runtime.insertAndGetId("forward_groups", { id: 10, userId: 1, name: "Group", groupMode: "port", targetIp: "0.0.0.0" });
  await runtime.insertAndGetId("forward_group_members", { groupId: 10, memberType: "host", hostId: 1 });
  const groupPlan = await admin.create({ name: "Group unlimited", priceCents: 0, forwardGroupIds: [10], portCount: 0 });
  await admin.assign({ userId: 5, planId: groupPlan!.id });
  assert.deepEqual((await db.getUserForwardGroupPlanPortRange(5, 10))!.ranges, [{ start: 1, end: 65535 }]);
  assert.equal(await db.getUserForwardGroupPlanPortRange(5, 11), null);

  // A failed unlimited -> finite conversion keeps that user's old rights.
  await admin.updateFields({ id: groupPlan!.id, portCount: 65535, syncExistingSubscribers: false });
  await assert.rejects(db.syncPlanSubscribers(groupPlan!.id), /套餐可用端口不足/);
  assert.equal((await db.getActiveUserSubscriptions(5))[0].portCount, 0);
  assert.deepEqual((await db.getUserForwardGroupPlanPortRange(5, 10))!.ranges, [{ start: 1, end: 65535 }]);
} finally {
  await runtime.closeDatabase();
}

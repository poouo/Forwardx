import assert from "node:assert/strict";
import type { ForwardRule } from "../drizzle/schema";
import * as runtime from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import * as db from "./db";
import { rulesRouter } from "./routers/rules";
import { applyRuleLimitsForRuntime, reconcileRuleLimits, recordRuleQuotaTraffic } from "./ruleLimits";
import { shouldAccountForwardRuleTraffic } from "./agentReportRoutes";
import { parsePanelCall } from "./ai/panelTools";
import { gateForwardRulesForRuntime } from "./linkAccessView";

await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
try {
  await ensureDatabaseSchema();
  // Simulate the pre-feature table, then migrate a live legacy rule in place.
  for (const column of ["rateLimitMbps", "trafficLimit", "trafficMode", "expiresAt", "ruleLimitReason", "quotaUsedIn", "quotaUsedOut", "adminManaged"]) {
    await runtime.executeRaw(`ALTER TABLE forward_rules DROP COLUMN "${column}"`);
  }
  await runtime.executeRaw(`INSERT INTO forward_rules (id,"hostId",name,"sourcePort","targetIp","targetPort","userId") VALUES (99,1,'legacy',23999,'192.0.2.99',443,1)`);
  await ensureDatabaseSchema();
  const legacy: any = await db.getForwardRuleById(99);
  assert.equal(legacy.isEnabled, true); assert.equal(legacy.rateLimitMbps, 0);
  assert.equal(legacy.trafficLimit, 0); assert.equal(legacy.trafficMode, "both"); assert.equal(legacy.expiresAt, null);
  assert.equal(legacy.adminManaged, false);
  await runtime.executeRaw(`INSERT INTO users (id,username,password,name,role,"accountEnabled","canAddRules","manualCanAddRules","maxRules","maxPorts") VALUES (1,'admin','unused','Admin','admin',1,1,1,100,100),(2,'user','unused','User','user',1,1,1,100,100)`);
  await runtime.executeRaw(`INSERT INTO hosts (id,name,ip,"userId","agentVersion","isOnline","lastHeartbeat") VALUES (1,'entry','192.0.2.1',1,'2.2.190',1,?),(2,'exit','192.0.2.2',1,'2.2.190',1,?)`, [Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)]);
  await db.setUserHostPermissions(2, [1, 2]);
  await db.setSetting("trafficBillingEnabled", "true");
  await runtime.executeRaw(`UPDATE users SET "balanceCents"=1000`);
  await runtime.executeRaw(`INSERT INTO traffic_billing_configs (id,"resourceType","resourceId",enabled,"requiresPermission","pricePerGbCents",multiplier) VALUES (1,'host',1,1,0,1,100)`);
  const caller = (id: number, role: "admin" | "user") => rulesRouter.createCaller({ user: { id, role }, req: { headers: {} }, res: {} } as any);
  const admin = caller(1, "admin"); const customer = caller(2, "user");
  const base = { hostId: 1, name: "limited", forwardType: "iptables" as const, protocol: "both" as const, sourcePort: 24001, targetIp: "192.0.2.99", targetPort: 443 };
  const createdAt = new Date(Date.now() - 86400000);
  const expiresAt = new Date(Date.now() + 86400000);
  const { id } = await admin.create({ ...base, userId: 2, rateLimitMbps: 12, trafficLimit: 1000, trafficMode: "max", createdAt, expiresAt });
  let saved: any = await db.getForwardRuleById(id);
  assert.equal(saved.userId, 2); assert.equal(saved.rateLimitMbps, 12); assert.equal(saved.trafficLimit, 1000);
  assert.equal(saved.trafficMode, "max"); assert.ok(Math.abs(saved.createdAt.getTime() - createdAt.getTime()) < 1000);
  assert.ok(Math.abs(saved.expiresAt.getTime() - expiresAt.getTime()) < 1000);
  const normal = await admin.create({ ...base, sourcePort: 24002 });
  const defaults: any = await db.getForwardRuleById(normal.id);
  assert.equal(defaults.trafficLimit, 0); assert.equal(defaults.rateLimitMbps, 0); assert.equal(defaults.expiresAt, null);
  assert.equal((await applyRuleLimitsForRuntime([defaults]))[0].isEnabled, true);
  await assert.rejects(customer.create({ ...base, sourcePort: 24003, trafficLimit: 1 }), /仅管理员/);
  await assert.rejects(customer.update({ id, rateLimitMbps: 0 }), /仅管理员/);
  assert.throws(() => parsePanelCall({ role: "user" }, "rules.update", { id, expiresAt: null }, "write"), /仅管理员/);
  await assert.rejects(admin.update({ id, expiresAt: new Date(createdAt.getTime() - 1000) }), /到期时间/);
  assert.equal((await db.getForwardRuleById(id))!.trafficLimit, 1000);
  const stat = (bytesIn: number, bytesOut: number, ruleId = id, hostId = 1) => ({ stat: { ruleId, hostId, bytesIn, bytesOut, connections: 1 }, userId: 2 });
  const recordTraffic = async (items: db.TrafficStatBatchItem[]) => runtime.withDatabaseTransaction(async () => {
    await db.insertTrafficStatsBatch(items);
    const contexts: any[] = await db.getForwardRuleTrafficContextsByIds(items.map(item => item.stat.ruleId));
    const byId = new Map(contexts.map(context => [Number(context.rule.id), context]));
    const accepted = items.filter(item => {
      const context = byId.get(item.stat.ruleId);
      return context && shouldAccountForwardRuleTraffic(context.rule, context.group);
    });
    await recordRuleQuotaTraffic(accepted, byId);
  });
  await recordTraffic([stat(600, 500)]);
  await reconcileRuleLimits([id]);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null); // max of totals, not their sum
  await admin.update({ id, trafficMode: "both" });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "traffic_limit");
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.isEnabled, true); // preserve user's switch
  assert.equal((await applyRuleLimitsForRuntime([saved]))[0].isEnabled, false);
  assert.equal((await applyRuleLimitsForRuntime([defaults]))[0].isEnabled, true);
  assert.equal((await customer.getById({ id }))!.trafficLimit, 1000);
  await assert.rejects(customer.update({ id, name: "still limited" }), /仅可查看/);
  await assert.rejects(customer.toggle({ id, isEnabled: false }), /仅可查看/);
  await assert.rejects(customer.delete({ id }), /仅可查看/);
  await assert.rejects(customer.reorder({ category: "local", ids: [id] }), /仅可查看/);
  assert.equal((await db.getForwardRuleById(id))!.trafficLimit, 1000);
  await assert.rejects(customer.resetTraffic({ scope: "rule", ruleId: id }), /仅可查看/);
  await admin.update({ id, trafficMode: "outbound", expiresAt: null, createdAt: new Date(Date.now() - 2 * 86400000) });
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, null); assert.equal(saved.expiresAt, null);
  await recordTraffic([stat(0, 500)]);
  await reconcileRuleLimits([id]);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, "traffic_limit"); // exact boundary
  await admin.resetTraffic({ scope: "rule", ruleId: id });
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  await admin.update({ id, expiresAt: new Date(Date.now() - 60_000) });
  await reconcileRuleLimits();
  saved = await db.getForwardRuleById(id);
  assert.equal(saved.ruleLimitReason, "expired");
  await admin.update({ id, expiresAt: null, trafficLimit: 0, rateLimitMbps: 0 });
  assert.equal((await db.getForwardRuleById(id))!.adminManaged, true);
  await assert.rejects(customer.update({ id, name: "cleared limits" }), /仅可查看/);
  assert.equal((await db.getForwardRuleById(id))!.ruleLimitReason, null);
  // A hidden old Agent cannot silently accept a per-rule speed configuration.
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.186' WHERE id=1`);
  await assert.rejects(admin.update({ id, rateLimitMbps: 1 }), /升级 Agent/);
  assert.equal((await db.getForwardRuleById(id))!.rateLimitMbps, 0);
  await runtime.executeRaw(`UPDATE hosts SET "agentVersion"='2.2.190' WHERE id=1`);
  // Managed members inherit the parent policy at runtime; traffic rolls up once.
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId") VALUES (10,'group','host','failover','','0.0.0.0',1)`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled") VALUES (101,10,'host',1,0,1),(102,10,'host',2,1,1)`);
  await db.setUserForwardGroupPermissions(2, [10]);
  const template = await admin.create({ ...base, userId: 2, hostId: undefined, sourcePort: 24100, forwardGroupId: 10, rateLimitMbps: 10, trafficLimit: 1000, trafficMode: "max" });
  const children = await db.getForwardGroupChildRulesForTemplate(template.id);
  assert.equal(children.length, 2);
  let gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => child.rateLimitMbps === 10 && child.isEnabled));
  await recordTraffic([stat(600, 50, children[0].id, 1), stat(500, 60, children[1].id, 2)]);
  await reconcileRuleLimits([template.id]);
  assert.equal((await db.getForwardRuleById(template.id))!.ruleLimitReason, "traffic_limit");
  gated = await applyRuleLimitsForRuntime(children);
  assert.ok(gated.every((child: any) => !child.isEnabled && child.ruleLimitReason === "traffic_limit"));
  await admin.update({ id: template.id, trafficLimit: 2000 });
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => child.isEnabled));
  await admin.update({ id: template.id, expiresAt: new Date(Date.now() + 60_000) });
  // Runtime expiry is checked fresh even before the scheduler stores its reason.
  const expiredPolicy: any = await db.getForwardRuleById(template.id);
  await db.updateForwardRule(template.id, { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 86400000) });
  assert.equal(expiredPolicy.ruleLimitReason, null);
  assert.ok((await applyRuleLimitsForRuntime(children)).every((child: any) => !child.isEnabled));
  // Chain hops see the same bytes; only the first hop may consume the quota.
  await runtime.executeRaw(`INSERT INTO forward_groups (id,name,"groupType","groupMode",domain,"targetIp","userId", "forwardType") VALUES (11,'chain','host','chain','','0.0.0.0',1,'gost')`);
  await runtime.executeRaw(`INSERT INTO forward_group_members (id,"groupId","memberType","hostId",priority,"isEnabled") VALUES (201,11,'host',1,0,1),(202,11,'host',2,1,1)`);
  await db.setUserForwardGroupPermissions(2, [10, 11]);
  const chain = await admin.create({ ...base, userId: 2, hostId: undefined, sourcePort: 24200, forwardGroupId: 11, rateLimitMbps: 8, trafficLimit: 1000, trafficMode: "max" });
  const chainChildren: any[] = await db.getForwardGroupChildRulesForTemplate(chain.id);
  assert.equal(chainChildren.length, 2);
  const first = chainChildren.find(child => Number(child.hostId) === 1)!;
  const last = chainChildren.find(child => Number(child.hostId) === 2)!;
  await recordTraffic([stat(600, 10, first.id, 1), stat(600, 10, last.id, 2)]);
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, null);
  await recordTraffic([stat(400, 10, first.id, 1)]);
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, "traffic_limit");
  assert.ok((await applyRuleLimitsForRuntime(chainChildren)).every((child: any) => !child.isEnabled));
  // Replacing all managed members must not reset a logical rule's quota.
  await db.updateForwardRule(first.id, { pendingDelete: true });
  await db.updateForwardRule(last.id, { pendingDelete: true });
  await reconcileRuleLimits([chain.id]);
  assert.equal((await db.getForwardRuleById(chain.id))!.ruleLimitReason, "traffic_limit");
  assert.equal((await db.getForwardRuleById(chain.id))!.quotaUsedIn, 1000);
  // Plain admin-created customer rules stay read-only even without any limits.
  const managed = await admin.create({ ...base, userId: 2, sourcePort: 24300 });
  assert.equal((await customer.getById({ id: managed.id }))!.adminManaged, true);
  await recordTraffic([stat(123, 456, managed.id)]);
  const managedRow = (await customer.getById({ id: managed.id }))!;
  assert.equal(managedRow.quotaUsedIn, 123); assert.equal(managedRow.quotaUsedOut, 456);
  await assert.rejects(customer.toggle({ id: managed.id, isEnabled: false }), /仅可查看/);
  await assert.rejects(customer.resetTraffic({ scope: "rule", ruleId: managed.id }), /仅可查看/);
  const ordinary = await customer.create({ ...base, name: "self-service", sourcePort: 24301 });
  assert.equal((await customer.getById({ id: ordinary.id }))!.adminManaged, false);
  await customer.update({ id: ordinary.id, name: "self-service edited" });
  await customer.toggle({ id: ordinary.id, isEnabled: false });
  // Reject a mixed explicit reset/reorder before writing any of the selected rows.
  await assert.rejects(customer.resetTraffic({ scope: "all", ruleIds: [ordinary.id, managed.id] }), /仅可查看/);
  await assert.rejects(customer.reorder({ category: "local", ids: [ordinary.id, managed.id] }), /仅可查看/);
  await customer.resetTraffic({ scope: "all" }); // excludes managed rules
  assert.equal((await customer.getById({ id: managed.id }))!.quotaUsedOut, 456);
  const batch = await customer.deleteBatch({ ids: [ordinary.id, managed.id] });
  assert.deepEqual(batch.deletedIds, [ordinary.id]);
  assert.equal(batch.failures[0].id, managed.id);
  assert.match(batch.failures[0].error, /仅可查看/);
  assert.equal((await customer.getById({ id: managed.id }))!.pendingDelete, false);
  await admin.toggle({ id: managed.id, isEnabled: false });
  await admin.delete({ id: managed.id });
  // Administrators may share their own rules without creating a subaccount.
  // Administrative permissions never exempt a rule from its own quota/expiry.
  const self = await admin.create({ ...base, sourcePort: 24400, trafficLimit: 1000, trafficMode: "both", rateLimitMbps: 5, createdAt });
  const explicitSelf = await admin.create({ ...base, userId: 1, sourcePort: 24401, trafficLimit: 500, trafficMode: "outbound" });
  assert.equal((await admin.getById({ id: self.id }))!.userId, 1);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.userId, 1);
  assert.equal((await admin.getById({ id: self.id }))!.adminManaged, true);
  await recordTraffic([{ ...stat(600, 500, self.id), userId: 1 }]);
  await reconcileRuleLimits([self.id]);
  let selfRule = (await admin.getById({ id: self.id }))!;
  assert.equal(selfRule.quotaUsedIn, 600); assert.equal(selfRule.quotaUsedOut, 500);
  assert.equal(selfRule.ruleLimitReason, "traffic_limit");
  assert.equal(selfRule.isEnabled, true);
  let runtimeRules = await gateForwardRulesForRuntime([selfRule, (await admin.getById({ id: explicitSelf.id }))!]);
  assert.equal(runtimeRules[0].isEnabled, false, "admin access cannot bypass the rule quota");
  assert.equal(runtimeRules[1].isEnabled, true, "one capped rule must not disable unrelated admin rules");
  await admin.toggle({ id: self.id, isEnabled: true });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, false);
  await admin.resetTraffic({ scope: "rule", ruleId: self.id });
  selfRule = (await admin.getById({ id: self.id }))!;
  assert.equal(selfRule.quotaUsedIn, 0); assert.equal(selfRule.quotaUsedOut, 0);
  assert.equal((await gateForwardRulesForRuntime([selfRule]))[0].isEnabled, true);
  await admin.update({ id: self.id, trafficLimit: 2000, expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, false);
  await admin.update({ id: self.id, expiresAt: null });
  assert.equal((await gateForwardRulesForRuntime([(await admin.getById({ id: self.id }))!]))[0].isEnabled, true);
  await recordTraffic([{ ...stat(1000, 499, explicitSelf.id), userId: 1 }]);
  await reconcileRuleLimits([explicitSelf.id]);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.ruleLimitReason, null);
  await recordTraffic([{ ...stat(0, 1, explicitSelf.id), userId: 1 }]);
  await reconcileRuleLimits([explicitSelf.id]);
  assert.equal((await admin.getById({ id: explicitSelf.id }))!.ruleLimitReason, "traffic_limit");
  // Own-account group rules use the same logical quota across their members.
  const ownGroup = await admin.create({ ...base, userId: 1, hostId: undefined, forwardGroupId: 10, sourcePort: 24402, trafficLimit: 500, trafficMode: "max", rateLimitMbps: 5 });
  const ownChildren: ForwardRule[] = await db.getForwardGroupChildRulesForTemplate(ownGroup.id);
  assert.equal(ownChildren.length, 2);
  assert.ok(ownChildren.every(child => child.userId === 1));
  await recordTraffic(ownChildren.map(child => ({ ...stat(250, 10, child.id, child.hostId), userId: 1 })));
  await reconcileRuleLimits([ownGroup.id]);
  runtimeRules = await gateForwardRulesForRuntime(ownChildren);
  assert.ok(runtimeRules.every(child => !child.isEnabled && child.ruleLimitReason === "traffic_limit" && child.rateLimitMbps === 5));
  await admin.update({ id: ownGroup.id, trafficLimit: 600 });
  assert.ok((await gateForwardRulesForRuntime(ownChildren)).every(child => child.isEnabled));
} finally { await runtime.closeDatabase(); }

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productStock, productStockText } from "../shared/productStock";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-product-stock-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "stock.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let billing: typeof import("./repositories/billingRepository");
let rules: typeof import("./repositories/forwardRuleRepository");
let stock: typeof import("./repositories/productStockRepository");

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  // Upgrade real legacy tables with no stock columns.
  await runtime.executeRaw("CREATE TABLE subscription_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)");
  await runtime.executeRaw("INSERT INTO subscription_plans (id, name) VALUES (1, 'stock-plan'), (2, 'no-ports')");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  billing = await import("./repositories/billingRepository");
  rules = await import("./repositories/forwardRuleRepository");
  stock = await import("./repositories/productStockRepository");
  for (let id = 1; id <= 4; id++) {
    await runtime.insertAndGetId("users", { id, username: `stock-${id}`, password: "unused", role: id === 1 ? "admin" : "user", balanceCents: 1000 });
  }
  for (const id of [1, 2]) await runtime.insertAndGetId("hosts", { id, name: `stock-host-${id}`, ip: "127.0.0.1", userId: 1, portRangeStart: 20000, portRangeEnd: id === 1 ? 30000 : 20000 });
  await runtime.executeRaw("UPDATE subscription_plans SET portCount = 2, priceCents = 100");
  await runtime.insertAndGetId("subscription_plan_hosts", { planId: 1, hostId: 1 });
  await runtime.insertAndGetId("subscription_plan_hosts", { planId: 2, hostId: 2 });
  await runtime.insertAndGetId("tunnels", { id: 1, name: "stock-tunnel", entryHostId: 1, exitHostId: 2, listenPort: 15000, userId: 1 });
  await runtime.insertAndGetId("forward_groups", { id: 1, name: "stock-group", targetIp: "127.0.0.1", userId: 1 });
  await (await import("./repositories/settingsRepository")).setSetting("trafficBillingEnabled", "true");
  await (await import("./repositories/settingsRepository")).setSetting("storeEnabled", "true");
});

beforeEach(async () => {
  for (const table of ["forward_rules", "user_subscriptions", "payment_orders", "balance_transactions", "traffic_billing_configs"]) await runtime.executeRaw(`DELETE FROM ${table}`);
  await runtime.executeRaw("UPDATE users SET balanceCents = 1000");
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 0, stockUsed = 0");
});

after(async () => {
  await runtime?.closeDatabase();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});

const planStock = async () => (await runtime.queryRaw<{ stockUsed: number; stockLimit: number }>("SELECT stockUsed, stockLimit FROM subscription_plans WHERE id = 1"))[0];
const order = (outTradeNo: string, userId = 2, subscriptionId?: number) => billing.createPaymentOrder({ outTradeNo, userId, provider: "stripe", paymentType: "stripe", subject: "stock", amountCents: 100, planId: 1, orderType: "plan", subscriptionId });
const rule = (overrides: Record<string, unknown> = {}) => rules.createForwardRule({ name: "stock", hostId: 1, userId: 2, forwardType: "realm", protocol: "both", sourcePort: 22000, targetIp: "127.0.0.1", targetPort: 80, ...overrides } as any);
const config = (resourceType = "host", resourceId = 1, stockLimit = 1, maxRulesPerUser = 0) => runtime.insertAndGetId("traffic_billing_configs", { resourceType, resourceId, stockLimit, maxRulesPerUser, enabled: true });

async function race(operation: string, userIds = [2, 3]) {
  const children = userIds.map(userId => {
    const child = spawn(process.execPath, ["--import", "tsx", "server/productStock.test.worker.ts"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    child.stdout!.on("data", data => { output += data; });
    child.stderr!.on("data", data => { output += data; });
    let readyResolve!: () => void;
    let resultResolve!: (value: any) => void;
    const ready = new Promise<void>(resolve => { readyResolve = resolve; });
    const result = new Promise<any>(resolve => { resultResolve = resolve; });
    child.on("message", (message: any) => {
      if (message.ready) readyResolve();
      else resultResolve(message);
    });
    const exit = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker ${code}: ${output}`)));
    });
    return { child, ready, result, exit, userId };
  });
  const timer = setTimeout(() => children.forEach(({ child }) => child.kill()), 30_000);
  try {
    // Start after BOTH independent DB connections are ready.
    await Promise.race([Promise.all(children.map(item => item.ready)), Promise.all(children.map(item => item.exit)).then(() => { throw new Error("workers exited before ready"); })]);
    children.forEach(({ child, userId }) => child.send({ operation, userId }));
    await Promise.all(children.map(item => item.exit));
    return await Promise.all(children.map(item => item.result));
  } finally { clearTimeout(timer); children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); }); }
}

test("unlimited stock uses infinity; exhaustion never becomes unlimited", () => {
  assert.equal(productStockText({ stockLimit: 0, stockUsed: 100 }), "∞");
  assert.equal(productStockText({ stockLimit: 1, stockUsed: 1 }), "0");
  assert.equal(productStock({ stockLimit: 1, stockUsed: 2 }).soldOut, true);
  assert.equal(productStockText({ stockLimit: 5, stockUsed: 2 }), "3");
});

for (const operation of ["balance", "order"]) test(`two independent processes compete for one plan (${operation})`, async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 1");
  const results = await race(operation);
  assert.equal(results.filter(item => item.ok).length, 1, JSON.stringify(results));
  assert.match(results.find(item => !item.ok).error, /库存/);
  assert.equal((await planStock()).stockUsed, 1);
  if (operation === "balance") {
    assert.equal((await runtime.queryRaw<{ n: number }>("SELECT COUNT(*) AS n FROM user_subscriptions"))[0].n, 1);
    assert.equal((await runtime.queryRaw<{ n: number }>("SELECT SUM(balanceCents) AS n FROM users WHERE id IN (2,3)"))[0].n, 1900, "loser is not charged");
  } else assert.equal((await runtime.queryRaw<{ n: number }>("SELECT COUNT(*) AS n FROM payment_orders"))[0].n, 1);
});

test("unpaid close releases exactly once, and cannot close a paid order", async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 1");
  for (const status of ["expired", "failed", "cancelled"] as const) {
    await order(status);
    assert.equal((await planStock()).stockUsed, 1);
    await assert.rejects(() => order(`${status}-loser`, 3), /库存/);
    await Promise.all([billing.updatePaymentOrder(status, { status }), billing.updatePaymentOrder(status, { status })]);
    assert.equal((await planStock()).stockUsed, 0);
    assert.equal((await billing.getPaymentOrderByOutTradeNo(status))?.stockReserved, false);
  }
  await order("paid");
  await billing.markPaymentOrderPaid("paid", { tradeNo: "t" });
  await billing.updatePaymentOrder("paid", { status: "expired" });
  assert.equal((await billing.getPaymentOrderByOutTradeNo("paid"))?.status, "paid");
  assert.equal((await planStock()).stockUsed, 1);
});

test("paid fulfillment and duplicate callbacks consume no extra stock; renewals use none", async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 1");
  await order("paid");
  await billing.markPaymentOrderPaid("paid", { tradeNo: "t" });
  const first = await billing.applySubscriptionToUser(2, 1, "payment", "paid");
  const duplicate = await billing.applySubscriptionToUser(2, 1, "payment", "paid");
  assert.equal(duplicate.subscriptionId, first.subscriptionId);
  assert.equal((await planStock()).stockUsed, 1);
  const renewed = await billing.purchasePlanWithBalance(2, 1, undefined, first.subscriptionId);
  assert.equal(renewed.subscriptionId, first.subscriptionId);
  assert.equal((await planStock()).stockUsed, 1);
  const renewalOrder = await order("renewal", 2, first.subscriptionId);
  assert.equal(renewalOrder?.stockReserved, false);
  await billing.markPaymentOrderPaid("renewal", { tradeNo: "renewal-t" });
  await billing.applySubscriptionToUser(2, 1, "payment", "renewal", undefined, null, first.subscriptionId);
  assert.equal((await planStock()).stockUsed, 1);
});

test("closed late-paid orders cannot oversell, and remain visibly paid for reconciliation", async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 1");
  await order("late");
  await billing.updatePaymentOrder("late", { status: "expired" });
  await billing.purchasePlanWithBalance(3, 1);
  await billing.markPaymentOrderPaid("late", { tradeNo: "late-t" }, true);
  await assert.rejects(() => billing.applySubscriptionToUser(2, 1, "payment", "late"), /库存/);
  assert.equal((await billing.getPaymentOrderByOutTradeNo("late"))?.status, "paid");
  assert.equal((await planStock()).stockUsed, 1);
  assert.equal(await billing.getUserSubscriptionByPaymentOrderNo("late"), undefined);
});

test("late payment reacquires released stock when available", async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 1");
  await order("recover");
  await billing.updatePaymentOrder("recover", { status: "cancelled" });
  await billing.markPaymentOrderPaid("recover", { tradeNo: "recovered" }, true);
  await billing.applySubscriptionToUser(2, 1, "payment", "recover");
  assert.equal((await planStock()).stockUsed, 1);
  assert.equal((await billing.getPaymentOrderByOutTradeNo("recover"))?.stockReserved, true);
});

test("allocation failure rolls back stock, balance and ledger writes", async () => {
  await runtime.executeRaw("UPDATE subscription_plans SET stockLimit = 1 WHERE id = 2");
  await assert.rejects(() => billing.purchasePlanWithBalance(2, 2), /端口不足/);
  assert.equal((await runtime.queryRaw<{ stockUsed: number }>("SELECT stockUsed FROM subscription_plans WHERE id = 2"))[0].stockUsed, 0);
  assert.equal((await runtime.queryRaw<{ balanceCents: number }>("SELECT balanceCents FROM users WHERE id = 2"))[0].balanceCents, 1000);
  assert.equal((await runtime.queryRaw<{ n: number }>("SELECT COUNT(*) AS n FROM balance_transactions"))[0].n, 0);
});

test("independent processes cannot oversell one metered user slot", async () => {
  const id = await config();
  const results = await race("rule");
  assert.equal(results.filter(item => item.ok).length, 1, JSON.stringify(results));
  assert.match(results.find(item => !item.ok).error, /库存/);
  assert.equal((await stock.getTrafficStockUsage()).get(id), 1);
});

test("metered stock counts users, ignores children, releases after last deletion and checks moves", async () => {
  const firstConfig = await config("host", 1, 1, 3);
  const secondConfig = await config("host", 2);
  const first = await rule();
  await rule({ forwardGroupRuleId: first, forwardGroupMemberId: 1 });
  await rule({ forwardGroupRuleId: first, forwardGroupMemberId: 2 });
  assert.equal((await stock.getTrafficStockUsage()).get(firstConfig), 1);
  const extra = await rule();
  const last = await rule();
  await assert.rejects(() => rule(), /单用户规则上限/);
  await assert.rejects(() => rule({ userId: 3 }), /库存/);
  await rules.updateForwardRule(first, { hostId: 1, targetPort: 81 });
  const second = await rule({ hostId: 2, userId: 3 });
  await assert.rejects(() => rules.updateForwardRule(first, { hostId: 2 }), /库存/);
  assert.equal((await rules.getForwardRuleById(first))?.hostId, 1);
  await rules.deleteForwardRule(second);
  await rules.updateForwardRule(first, { hostId: 2 });
  assert.equal((await stock.getTrafficStockUsage()).get(firstConfig), 1, "other rules by the same user still reserve one unit");
  assert.equal((await stock.getTrafficStockUsage()).get(secondConfig), 1);
  await rules.deleteForwardRule(extra);
  assert.equal((await stock.getTrafficStockUsage()).get(firstConfig), 1);
  await rules.deleteForwardRule(last);
  assert.equal((await stock.getTrafficStockUsage()).get(firstConfig), undefined);
  await rule({ userId: 3 });
  await assert.rejects(() => rules.updateForwardRule(last, { pendingDelete: false }), /库存/);
});

test("independent same-user creates enforce rule limits even with unlimited inventory", async () => {
  const id = await config("host", 1, 0, 2);
  await rule();
  const results = await race("rule", [2, 2]);
  assert.equal(results.filter(item => item.ok).length, 1, JSON.stringify(results));
  assert.match(results.find(item => !item.ok).error, /单用户规则上限/);
  assert.equal((await stock.getTrafficStockUsage()).get(id), 1);
  assert.equal((await stock.getTrafficRuleUsageForUser(2)).get(id), 2);
  await rule({ userId: 3 });
  assert.equal((await stock.getTrafficStockUsage()).get(id), 2);
});

test("zero per-user rule limit allows more rules without taking extra user inventory", async () => {
  const id = await config();
  for (let index = 0; index < 5; index++) await rule();
  assert.equal((await stock.getTrafficStockUsage()).get(id), 1);
  assert.equal((await stock.getTrafficRuleUsageForUser(2)).get(id), 5);
  await assert.rejects(() => rule({ userId: 3 }), /库存/);
});

test("ownership changes and soft-delete recovery also enforce user capacity", async () => {
  await config("host", 1, 2, 1);
  const first = await rule();
  const second = await rule({ userId: 3 });
  await assert.rejects(() => rules.updateForwardRule(first, { userId: 3 }), /单用户规则上限/);
  await rules.deleteForwardRule(second);
  await rules.updateForwardRule(first, { userId: 3 });
  await assert.rejects(() => rules.updateForwardRule(second, { pendingDelete: false }), /单用户规则上限/);
});

test("group > tunnel > host stock precedence matches billing and only counts the logical root", async () => {
  const host = await config();
  const tunnel = await config("tunnel", 1);
  const group = await config("forward_group", 1);
  const root = await rule({ forwardGroupId: 1, tunnelId: 1, isForwardGroupTemplate: true });
  await rule({ forwardGroupId: 1, tunnelId: 1, forwardGroupRuleId: root, forwardGroupMemberId: 1 });
  assert.deepEqual([...await stock.getTrafficStockUsage()], [[group, 1]]);
  await assert.rejects(() => rule({ forwardGroupId: 1, userId: 3 }), /库存/);
  await rule({ tunnelId: 1 });
  await rule();
  const usage = await stock.getTrafficStockUsage();
  for (const id of [host, tunnel, group]) assert.equal(usage.get(id), 1);
});

const context = (id: number, role: string) => ({
  user: { id, role } as any, req: { headers: {}, path: "/api/trpc", protocol: "https", get: () => "panel.test", socket: {} } as any,
  res: {} as any, authSession: null, authFailureReason: null,
});

test("stock configuration persists, validates limits, keeps sold-out goods visible and isolates personal usage", async () => {
  const traffic = (await import("./routers/trafficBilling")).trafficBillingRouter;
  const admin = traffic.createCaller(context(1, "admin"));
  const id = await config("host", 1, 1, 3);
  const input = { id, resourceType: "host" as const, resourceId: 1, enabled: true, requiresPermission: false, pricePerGbMilliCents: 1000 };
  await admin.saveConfig({ ...input, stockLimit: 2, maxRulesPerUser: 4 });
  await admin.saveConfig(input); // status edits must not reset quota fields.
  const stored = (await admin.configs()).configs.find((item: any) => item.id === id);
  assert.equal(stored?.stockLimit, 2);
  assert.equal(stored?.maxRulesPerUser, 4);
  for (const invalid of [-1, 1.5, 1_000_000_001]) {
    await assert.rejects(() => admin.saveConfig({ ...input, stockLimit: invalid }), { code: "BAD_REQUEST" });
    await assert.rejects(() => admin.saveConfig({ ...input, maxRulesPerUser: invalid }), { code: "BAD_REQUEST" });
  }
  await assert.rejects(() => traffic.createCaller(context(2, "user")).saveConfig({ ...input, stockLimit: 100 }), { code: "FORBIDDEN" });
  await admin.saveConfig({ ...input, stockLimit: 1, maxRulesPerUser: 3 });
  await rule();
  await rule();
  const mine = (await traffic.createCaller(context(2, "user")).storeResources()).configs.find((item: any) => item.id === id);
  const other = (await traffic.createCaller(context(3, "user")).storeResources()).configs.find((item: any) => item.id === id);
  assert.ok(mine && other, "sold-out products remain visible");
  assert.equal(mine.stockUsed, 1);
  assert.equal(mine.currentUserRuleCount, 2);
  assert.equal(other.currentUserRuleCount, 0);
  assert.equal(other.stockUsed, 1);
  const plans = (await import("./routers/plans")).plansRouter;
  const planAdmin = plans.createCaller(context(1, "admin"));
  await planAdmin.updateFields({ id: 1, syncExistingSubscribers: false, stockLimit: 1 });
  await planAdmin.updateFields({ id: 1, syncExistingSubscribers: false, name: "renamed" });
  assert.equal((await planStock()).stockLimit, 1);
  await assert.rejects(() => planAdmin.updateFields({ id: 1, syncExistingSubscribers: false, stockLimit: -1 }), { code: "BAD_REQUEST" });
  await order("sold-out");
  const visible = (await plans.createCaller(context(2, "user")).storeList()).find(plan => plan.id === 1);
  assert.ok(visible);
  assert.equal(productStock(visible).soldOut, true);
  await (await import("./dbSchema")).ensureDatabaseSchema();
  assert.equal((await planStock()).stockUsed, 1, "schema upgrades preserve occupied stock");
});

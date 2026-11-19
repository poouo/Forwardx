import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { trafficAddonPurchaseTotals } from "../shared/trafficAddonPurchase";

test("traffic add-on quotes reject invalid quantities and unsafe integer totals", () => {
  assert.deepEqual(trafficAddonPurchaseTotals(1000, 25, 3), {
    quantity: 3, unitTrafficBytes: 1000, unitPriceCents: 25, trafficBytes: 3000, priceCents: 75,
  });
  assert.equal(trafficAddonPurchaseTotals(1000, 0, 100).priceCents, 0);
  for (const quantity of [0, -1, 1.5, 101, NaN, Infinity]) {
    assert.throws(() => trafficAddonPurchaseTotals(1000, 25, quantity), /购买数量/);
  }
  for (const [bytes, cents] of [[Number.MAX_SAFE_INTEGER, 1], [1, Number.MAX_SAFE_INTEGER], [0, 1], [1, -1]]) {
    assert.throws(() => trafficAddonPurchaseTotals(bytes, cents, 2), /有效范围/);
  }
});

test("multi-pack purchases atomically charge total price and grant current-cycle traffic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-addon-purchase-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const { billingRouter } = await import(url("server/routers/billing.ts"));
    const now = Date.now();
    let cycleEnd = new Date(Math.floor((now + 20 * 86400000) / 1000) * 1000);
    const snapshot = JSON.stringify({ name: "Addon plan", portCount: 1, trafficLimit: 1000,
      rateLimitMbps: 0, maxRules: 20, maxConnections: 2000, maxIPs: 10, hostIds: [1], tunnelIds: [], forwardGroupIds: [] });
    const count = async table => Number((await runtime.queryRaw('SELECT COUNT(*) AS n FROM ' + table))[0].n);
    const state = async () => ({ balance: await billing.getUserBalance(1), addons: await count("user_traffic_addons"),
      ledger: await count("balance_transactions"), traffic: await billing.getActiveUserTrafficAddonBytes(1) });
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.insertAndGetId("users", { id: 1, username: "addon-user", password: "x", role: "user", balanceCents: 1000, manualCanAddRules: true });
      await runtime.insertAndGetId("users", { id: 2, username: "other-user", password: "x", role: "user" });
      await runtime.insertAndGetId("hosts", { id: 1, name: "addon-host", ip: "127.0.0.1", userId: 1, portRangeStart: 10000, portRangeEnd: 10100 });
      await runtime.insertAndGetId("subscription_plans", { id: 1, name: "Addon plan", durationDays: 30, portCount: 1, trafficLimit: 1000 });
      await runtime.insertAndGetId("subscription_plan_hosts", { planId: 1, hostId: 1 });
      await runtime.insertAndGetId("user_subscriptions", { id: 11, userId: 1, planId: 1, status: "active", source: "balance", planSnapshot: snapshot,
        portRangeStart: 10000, portRangeEnd: 10000, startedAt: new Date(now - 86400000), expiresAt: new Date(now + 30 * 86400000), nextTrafficResetAt: cycleEnd });
      await runtime.insertAndGetId("subscription_plan_traffic_addons", { id: 201, planId: 1, trafficBytes: 250, priceCents: 25, isActive: true });
      await billing.syncUserSubscriptionEntitlements(1);
      const subscriptionExpiresAt = new Date((await billing.getUserSubscriptionById(11)).expiresAt).getTime();
      const result = await billing.purchaseTrafficAddonWithBalance(1, 201, 11, 3);
      const subscriptionAfter = await billing.getUserSubscriptionById(11);
      cycleEnd = new Date(subscriptionAfter.nextTrafficResetAt || subscriptionAfter.expiresAt);
      assert.equal(new Date(subscriptionAfter.expiresAt).getTime(), subscriptionExpiresAt, "add-ons never extend the subscription");
      assert.equal(result.quantity, 3);
      assert.equal(result.trafficBytes, 750);
      assert.equal(result.priceCents, 75);
      assert.equal(result.unitTrafficBytes, 250);
      assert.equal(result.unitPriceCents, 25);
      assert.equal(result.expiresAt.getTime(), cycleEnd.getTime());
      assert.equal(result.trafficLimit, 1750);
      assert.deepEqual(await state(), { balance: 925, addons: 1, ledger: 1, traffic: 750 });
      const [addon] = await runtime.queryRaw('SELECT * FROM user_traffic_addons');
      const [ledger] = await runtime.queryRaw('SELECT * FROM balance_transactions');
      assert.equal(Number(addon.trafficBytes), 750);
      assert.equal(Number(addon.priceCents), 75);
      assert.equal(Number(ledger.amountCents), -75);
      assert.equal(ledger.type, "traffic_addon_purchase");
      assert.match(addon.description, /× 3/);
      const caller = billingRouter.createCaller({ user: { id: 1, username: "addon-user", role: "user" }, req: { headers: {}, socket: {} }, res: {} });
      assert.equal((await caller.purchaseTrafficAddonWithBalance({ addonId: 201, subscriptionId: 11 })).quantity, 1, "legacy callers default to one pack");
      let before = await state();
      for (const quantity of [0, -1, 1.5, 101, NaN]) {
        await assert.rejects(() => billing.purchaseTrafficAddonWithBalance(1, 201, 11, quantity), /购买数量/);
        await assert.rejects(() => caller.purchaseTrafficAddonWithBalance({ addonId: 201, quantity }));
      }
      await assert.rejects(() => billing.purchaseTrafficAddonWithBalance(2, 201, 11, 3), /没有可购买/);
      assert.deepEqual(await state(), before);
      await runtime.executeRaw('UPDATE users SET balanceCents = 50 WHERE id = 1');
      before = await state();
      await assert.rejects(() => billing.purchaseTrafficAddonWithBalance(1, 201, 11, 3), /余额不足/);
      assert.deepEqual(await state(), before, "enough for one pack is not enough for three");
      const concurrent = await Promise.allSettled([
        billing.purchaseTrafficAddonWithBalance(1, 201, 11, 2), billing.purchaseTrafficAddonWithBalance(1, 201, 11, 2),
      ]);
      assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
      assert.equal(await billing.getUserBalance(1), 0);
      await runtime.executeRaw('UPDATE users SET balanceCents = 100 WHERE id = 1');
      before = await state();
      await runtime.executeRaw("CREATE TRIGGER fail_addon BEFORE INSERT ON user_traffic_addons BEGIN SELECT RAISE(ABORT, 'forced addon failure'); END");
      await assert.rejects(() => billing.purchaseTrafficAddonWithBalance(1, 201, 11, 3), /forced addon failure/);
      assert.deepEqual(await state(), before, "grant failure rolls back balance and ledger");
      await runtime.executeRaw('DROP TRIGGER fail_addon');
      await runtime.executeRaw('UPDATE subscription_plan_traffic_addons SET priceCents = 0 WHERE id = 201');
      const free = await billing.purchaseTrafficAddonWithBalance(1, 201, 11, 4);
      assert.equal(free.trafficBytes, 1000);
      assert.equal(await count("balance_transactions"), before.ledger, "free packs create no debit ledger");
      assert.equal(await billing.getUserBalance(1), 100);
      await runtime.executeRaw('UPDATE subscription_plan_traffic_addons SET trafficBytes = ? WHERE id = 201', [Number.MAX_SAFE_INTEGER]);
      before = await state();
      await assert.rejects(() => billing.purchaseTrafficAddonWithBalance(1, 201, 11, 2), /有效范围/);
      assert.deepEqual(await state(), before);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "addon.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

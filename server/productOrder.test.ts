import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-product-order-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let plans: typeof import("./routers/plans").plansRouter;
let billing: typeof import("./routers/trafficBilling").trafficBillingRouter;
const context = (role: string | null = "admin") => ({
  user: role ? { id: 1, role } as any : null,
  req: { headers: {}, path: "/api/trpc", protocol: "https", get: () => "panel.test", socket: {} } as any,
  res: {} as any, authSession: null, authFailureReason: null,
});

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  // Simulate an existing installation without the newly introduced column.
  await runtime.executeRaw('CREATE TABLE traffic_billing_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, resourceType TEXT NOT NULL, resourceId INTEGER NOT NULL, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)');
  await runtime.executeRaw("INSERT INTO traffic_billing_configs (resourceType, resourceId, updatedAt) VALUES ('host', 1, 100), ('host', 2, 200), ('host', 3, 200), ('host', 4, 300)");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  plans = (await import("./routers/plans")).plansRouter;
  billing = (await import("./routers/trafficBilling")).trafficBillingRouter;
  await runtime.insertAndGetId("users", { id: 1, username: "sort-admin", password: "unused", role: "admin" });
  for (let id = 1; id <= 4; id++) {
    await runtime.insertAndGetId("hosts", { id, name: `host-${id}`, ip: "127.0.0.1", userId: 1 });
  }
  for (let id = 1; id <= 14; id++) {
    await runtime.insertAndGetId("subscription_plans", { id, name: `plan-${id}`, createdAt: 100, isActive: true, isStoreVisible: id !== 13 });
  }
  const settings = await import("./repositories/settingsRepository");
  await settings.setSetting("storeEnabled", "true");
  await settings.setSetting("trafficBillingEnabled", "true");
});

after(async () => {
  await runtime?.closeDatabase();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});

const idsOf = (items: { id: number }[]) => items.map(item => Number(item.id));
const snapshot = async (table: string) => (await runtime.queryRaw<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`))
  .map(({ sortOrder, ...item }) => item);

test("plan page sorting preserves other pages, store filtering and all non-order fields", async () => {
  const caller = plans.createCaller(context());
  const original = idsOf(await caller.list());
  assert.deepEqual(original, Array.from({ length: 14 }, (_, index) => 14 - index));
  const before = await snapshot("subscription_plans");
  const page = await caller.listPage({ page: 2, pageSize: 12 });
  await caller.reorder({ ids: idsOf(page.items).reverse(), startIndex: 12 });
  const expected = [...original.slice(0, 12), ...original.slice(12).reverse()];
  assert.deepEqual(idsOf(await caller.list()), expected);
  assert.deepEqual(idsOf((await caller.listPage({ page: 1, pageSize: 12 })).items), expected.slice(0, 12));
  assert.deepEqual(idsOf(await caller.options()), expected);
  assert.deepEqual(idsOf(await plans.createCaller(context("user")).storeList()), expected.filter(id => id !== 13));
  assert.deepEqual(await snapshot("subscription_plans"), before);
  await caller.reorder({ ids: [expected[2], expected[0], expected[1]], startIndex: 0 });
  assert.deepEqual(idsOf(await caller.list()), [expected[2], expected[0], expected[1], ...expected.slice(3)]);
});

test("metered configuration upgrades retain old order and sorting persists without changing billing or authorization", async () => {
  const caller = billing.createCaller(context());
  assert.deepEqual(idsOf((await caller.configs()).configs), [4, 3, 2, 1]);
  await runtime.executeRaw('UPDATE traffic_billing_configs SET requiresPermission = 1 WHERE id = 2');
  await runtime.executeRaw('UPDATE traffic_billing_configs SET enabled = 0 WHERE id = 3');
  const before = await snapshot("traffic_billing_configs");
  await caller.reorder({ ids: [1, 2, 3, 4] });
  assert.deepEqual(idsOf((await caller.configs()).configs), [1, 2, 3, 4]);
  assert.deepEqual(idsOf((await billing.createCaller(context("user")).storeResources()).configs), [1, 4]);
  assert.deepEqual(await snapshot("traffic_billing_configs"), before);
  await (await import("./dbSchema")).ensureDatabaseSchema();
  assert.deepEqual(idsOf((await caller.configs()).configs), [1, 2, 3, 4]);
});

test("invalid order inputs and unauthorized callers cannot write either product list", async () => {
  for (const router of [plans, billing]) {
    const caller = router.createCaller(context());
    const table = router === plans ? "subscription_plans" : "traffic_billing_configs";
    const before = await runtime.queryRaw(`SELECT * FROM ${table} ORDER BY id`);
    for (const input of [{ ids: [] }, { ids: [1, 1] }, { ids: [1, 99999] }, { ids: [-1] }, { ids: [1], startIndex: -1 }]) {
      await assert.rejects(() => caller.reorder(input), { code: "BAD_REQUEST" });
    }
    await assert.rejects(() => router.createCaller(context("user")).reorder({ ids: [1] }), { code: "FORBIDDEN" });
    await assert.rejects(() => router.createCaller(context(null)).reorder({ ids: [1] }), { code: "UNAUTHORIZED" });
    assert.deepEqual(await runtime.queryRaw(`SELECT * FROM ${table} ORDER BY id`), before);
  }
});

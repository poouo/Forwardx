import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "../shared/planDescription";

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

test("metered plan names survive schema upgrades, editing and store queries without renaming resources", async () => {
  const caller = billing.createCaller(context());
  const initial = (await caller.configs()).configs.find((item: { id: number }) => item.id === 1)!;
  assert.equal(initial.name, "", "old installations receive an empty optional product name");
  assert.equal(initial.resourceName, "host-1");
  const input = { id: 1, resourceType: "host" as const, resourceId: 1, enabled: true, requiresPermission: false, pricePerGbMilliCents: 1000 };
  const saved = await caller.saveConfig({ ...input, name: "  香港精品按量  " });
  assert.equal(saved.name, "香港精品按量");
  const listed = (await caller.configs()).configs.find((item: { id: number }) => item.id === 1)!;
  assert.equal(listed.name, "香港精品按量");
  assert.equal(listed.resourceName, "host-1");
  assert.equal((await billing.createCaller(context("user")).storeResources()).configs.find((item: { id: number }) => item.id === 1)?.name, "香港精品按量");
  await (await import("./dbSchema")).ensureDatabaseSchema();
  assert.equal((await caller.configs()).configs.find((item: { id: number }) => item.id === 1)?.name, "香港精品按量");
  // Toggling a configuration without sending a name must not erase it.
  await caller.saveConfig({ ...input, enabled: false });
  assert.equal((await caller.configs()).configs.find((item: { id: number }) => item.id === 1)?.name, "香港精品按量");
  await assert.rejects(() => caller.saveConfig({ ...input, name: "x".repeat(256) }), { code: "BAD_REQUEST" });
  await assert.rejects(() => billing.createCaller(context("user")).saveConfig({ ...input, name: "unauthorized" }), { code: "FORBIDDEN" });
  await caller.saveConfig({ ...input, name: "   " });
  const cleared = (await caller.configs()).configs.find((item: { id: number }) => item.id === 1)!;
  assert.equal(cleared.name, "");
  assert.equal(cleared.resourceName, "host-1");
  // Exercise both creation and resource-key upserts, not just edit-by-id.
  await runtime.insertAndGetId("hosts", { id: 5, name: "host-5", ip: "127.0.0.5", userId: 1 });
  const created = await caller.saveConfig({ ...input, id: undefined, resourceId: 5, name: "新按量套餐" });
  assert.equal(created.name, "新按量套餐");
  const updated = await caller.saveConfig({ ...input, id: undefined, resourceId: 5, name: "更新后的套餐" });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "更新后的套餐");
});

test("metered descriptions accept the shared rich-content limit and retain billing settings", async () => {
  const caller = billing.createCaller(context());
  const input = { id: 1, resourceType: "host" as const, resourceId: 1, enabled: true, requiresPermission: false, pricePerGbMilliCents: 180000 };
  const content = "## 按量介绍\n\n- **线路**：精品线路\n\n" + "中".repeat(600);
  await caller.saveConfig({ ...input, description: content });
  const findConfig = async () => (await caller.configs()).configs.find((item: { id: number }) => item.id === 1)!;
  assert.equal((await findConfig()).description, content);
  assert.equal((await billing.createCaller(context("user")).storeResources()).configs.find((item: { id: number }) => item.id === 1)?.description, content);
  const boundary = "中".repeat(PLAN_DESCRIPTION_MAX_LENGTH);
  await caller.saveConfig({ ...input, description: boundary });
  assert.equal((await findConfig()).description, boundary);
  await assert.rejects(() => caller.saveConfig({ ...input, description: boundary + "中" }), { code: "BAD_REQUEST" });
  assert.equal((await findConfig()).description, boundary, "rejected writes do not change saved content");
  await caller.saveConfig({ ...input, description: "   " });
  const cleared = await findConfig();
  assert.equal(cleared.description, null);
  assert.equal(cleared.pricePerGbMilliCents, input.pricePerGbMilliCents);
  assert.equal(cleared.enabled, true);
  assert.equal(cleared.requiresPermission, false);
});

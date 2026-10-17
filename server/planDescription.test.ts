import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "../shared/planDescription";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plan-description-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let router: typeof import("./routers/plans").plansRouter;
let billing: typeof import("./repositories/billingRepository");

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  router = (await import("./routers/plans")).plansRouter;
  billing = await import("./repositories/billingRepository");
  await runtime.insertAndGetId("users", { id: 1, username: "plan-admin", password: "unused", role: "admin" });
  await runtime.insertAndGetId("hosts", { id: 1, name: "plan-host", ip: "127.0.0.1", userId: 1 });
  await (await import("./repositories/settingsRepository")).setSetting("storeEnabled", "true");
});
after(async () => {
  await runtime?.closeDatabase();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});
const caller = (role = "admin") => router.createCaller({
  user: { id: 1, role } as any,
  req: { headers: {}, path: "/api/trpc", protocol: "https", get: () => "panel.test", socket: {} } as any,
  res: {} as any, authSession: null, authFailureReason: null,
});

test("rich plan descriptions over the previous 500-character limit persist through create, update and store APIs", async () => {
  const description = "## 套餐介绍\n\n" + "- **服务特色**：示例文字\n".repeat(100);
  assert.ok(description.length > 500);
  const created = await caller().create({ name: "Rich plan", priceCents: 1800, description, hostIds: [1] });
  const plan = await billing.getSubscriptionPlanById(created.id);
  assert.equal(plan?.description, description);
  const updated = "<div><h3>服务介绍</h3><p>" + "新的服务说明。".repeat(100) + "</p></div>";
  await caller().updateFields({ id: created.id, description: updated, syncExistingSubscribers: false });
  const saved = await billing.getSubscriptionPlanById(created.id);
  assert.equal(saved?.description, updated);
  assert.equal(Number(saved?.priceCents), 1800);
  const store = (await caller("user").storeList()) as Array<{ id: number; description?: string | null }>;
  assert.equal(store.find(item => Number(item.id) === Number(created.id))?.description, updated);
});

test("description limits apply consistently and users cannot edit plan descriptions", async () => {
  const created = await caller().create({ name: "Boundary plan", priceCents: 0, description: "中".repeat(PLAN_DESCRIPTION_MAX_LENGTH), hostIds: [1] });
  assert.equal((await billing.getSubscriptionPlanById(created.id))?.description?.length, PLAN_DESCRIPTION_MAX_LENGTH);
  await assert.rejects(() => caller().create({ name: "Too long", priceCents: 0, description: "x".repeat(PLAN_DESCRIPTION_MAX_LENGTH + 1), hostIds: [1] }), { code: "BAD_REQUEST" });
  await assert.rejects(() => caller().updateFields({ id: created.id, description: "x".repeat(PLAN_DESCRIPTION_MAX_LENGTH + 1), syncExistingSubscribers: false }), { code: "BAD_REQUEST" });
  await assert.rejects(() => caller("user").updateFields({ id: created.id, description: "forged", syncExistingSubscribers: false }), { code: "FORBIDDEN" });
  assert.equal((await billing.getSubscriptionPlanById(created.id))?.description, "中".repeat(PLAN_DESCRIPTION_MAX_LENGTH));
});

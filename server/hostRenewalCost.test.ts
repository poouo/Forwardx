import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("host lists expose renewal prices to administrators and handle legacy rows, edits and clearing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-renewal-cost-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.SQLITE_PATH = path.join(directory, "test.db");
  process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
  process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
  const runtime = await import("./dbRuntime");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, "userId" INTEGER NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0)');
    await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'legacy', '127.0.0.1', 2)");
    await (await import("./dbSchema")).ensureDatabaseSchema();
    for (const [id, role] of [[1, "admin"], [2, "user"]] as const) {
      await runtime.insertAndGetId("users", { id, username: role, password: "unused", role });
    }
    const { hostsRouter } = await import("./routers/hosts");
    const caller = (id: number, role: "admin" | "user") => hostsRouter.createCaller({
      user: { id, role, username: role }, req: { headers: {}, socket: {} }, res: {}, authSession: null,
    } as any);
    const admin = caller(1, "admin");
    const viewer = caller(2, "user");
    const page = { page: 1, pageSize: 20 };
    const legacy = (await admin.listPage(page)).items.find(host => host.id === 1);
    assert.equal(legacy?.renewalCostCents, null);
    assert.equal(legacy?.renewalCurrency, null);

    const created = await admin.create({ name: "Euro host", ip: "127.0.0.2", renewalCost: { amountCents: 550, currency: "EUR" } });
    await admin.update({ id: 1, renewalCost: { amountCents: 1234, currency: "USD" } });
    await admin.update({ id: 1, name: "renamed" });
    const rows = (await admin.listPage(page)).items;
    assert.deepEqual(rows.map(host => [host.id, host.renewalCostCents, host.renewalCurrency]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [1, 1234, "USD"], [created.id, 550, "EUR"],
    ]);

    for (const host of [
      (await viewer.list()).find(host => host.id === 1),
      (await viewer.listPage(page)).items.find(host => host.id === 1),
      await viewer.getById({ id: 1 }),
    ]) {
      assert.ok(host);
      assert.equal(Object.hasOwn(host, "renewalCostCents"), false);
      assert.equal(Object.hasOwn(host, "renewalCurrency"), false);
    }
    await assert.rejects(viewer.update({ id: 1, renewalCost: null }), { code: "FORBIDDEN" });
    await assert.rejects(admin.update({ id: 1, renewalCost: { amountCents: -1, currency: "USD" } }), { code: "BAD_REQUEST" });
    await admin.update({ id: 1, renewalCost: { amountCents: 0, currency: "JPY" } });
    assert.equal((await admin.list()).find(host => host.id === 1)?.renewalCostCents, 0);
    await admin.update({ id: 1, renewalCost: null });
    const cleared = (await admin.listPage(page)).items.find(host => host.id === 1);
    assert.equal(cleared?.renewalCostCents, null);
    assert.equal(cleared?.renewalCurrency, null);
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

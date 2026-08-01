import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("payment callbacks cannot reactivate closed orders", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-payment-state-"));
  const databasePath = path.join(directory, "payment.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const billing = await import(moduleUrl("server/repositories/billingRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)',
        [1, "payment-test", "x", "Payment Test", "user"],
      );
      const statuses = ["failed", "expired", "cancelled"];
      for (const [index, status] of statuses.entries()) {
        await runtime.executeRaw(
          'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [index + 1, "FWX-CLOSED-" + status, 1, "stripe", "stripe", status, "test", 100, "CNY"],
        );
        const result = await billing.markPaymentOrderPaid("FWX-CLOSED-" + status, {
          tradeNo: "late-trade-" + status,
          rawNotify: "late-notify",
          amountCents: 100,
          currency: "CNY",
        });
        assert.equal(result?.status, status);
        const [row] = await runtime.queryRaw('SELECT "status", "paidAt", "tradeNo" FROM "payment_orders" WHERE "outTradeNo" = ?', ["FWX-CLOSED-" + status]);
        assert.equal(row.status, status);
        assert.equal(row.paidAt, null);
        assert.equal(row.tradeNo, null);
      }

      await runtime.executeRaw(
        'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [10, "FWX-PENDING", 1, "stripe", "stripe", "pending", "test", 100, "CNY"],
      );
      const claimed = await billing.markPaymentOrderPaid("FWX-PENDING", {
        tradeNo: "paid-trade",
        rawNotify: "paid-notify",
        amountCents: 100,
        currency: "CNY",
      });
      assert.equal(claimed?.status, "paid");
      const [pendingRow] = await runtime.queryRaw('SELECT "status", "paidAt", "tradeNo" FROM "payment_orders" WHERE "outTradeNo" = ?', ["FWX-PENDING"]);
      assert.equal(pendingRow.status, "paid");
      assert.ok(pendingRow.paidAt);
      assert.equal(pendingRow.tradeNo, "paid-trade");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

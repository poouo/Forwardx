import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin order deletion releases reservations, hides paginated/exported rows and preserves verified recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-order-deletion-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const billing = await import(url("server/repositories/billingRepository.ts"));
    const { billingRouter } = await import(url("server/routers/billing.ts"));
    try {
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await schema.ensureDatabaseSchema();
      // Simulate upgrading an existing database, then check idempotent schema repair.
      await runtime.executeRaw('ALTER TABLE payment_orders DROP COLUMN adminDismissedAt');
      await schema.ensureDatabaseSchema();
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, role) VALUES (1, ?, ?, ?)', ["admin", "x", "admin"]);
      const context = {user:{id:1,username:"admin",role:"admin"},req:{headers:{},socket:{remoteAddress:"127.0.0.1"}},res:{}};
      const admin = billingRouter.createCaller(context);
      const user = billingRouter.createCaller({...context,user:{...context.user,role:"user"}});
      const guest = billingRouter.createCaller({...context,user:null});
      async function insertOrder(outTradeNo, status, orderType = "plan", paidAt = null) {
        await runtime.executeRaw('INSERT INTO payment_orders (outTradeNo,userId,provider,paymentType,status,subject,amountCents,orderType,paidAt) VALUES (?,1,?,?,?,?,100,?,?)',
          [outTradeNo,"stripe","stripe",status,"Deletion test",orderType,paidAt]);
      }
      await insertOrder("PENDING", "pending");
      await runtime.executeRaw('INSERT INTO subscription_plans (id,name,stockLimit,stockUsed) VALUES (1,?,1,1)', ["Reserved"]);
      await runtime.executeRaw('INSERT INTO discount_codes (id,code,discountType,discountValue,usedCount) VALUES (1,?,?,10,1)', ["RESERVED", "amount"]);
      await runtime.executeRaw('UPDATE payment_orders SET planId=1,stockReserved=1,discountCodeId=1,discountConsumed=1 WHERE outTradeNo=?', ["PENDING"]);
      await assert.rejects(user.deletePaymentOrder({outTradeNo:"PENDING"}), e => e.code === "FORBIDDEN");
      await assert.rejects(guest.deletePaymentOrder({outTradeNo:"PENDING"}), e => e.code === "UNAUTHORIZED");
      assert.equal((await billing.getPaymentOrderByOutTradeNo("PENDING")).status, "pending");
      assert.deepEqual(await admin.deletePaymentOrder({outTradeNo:"PENDING"}), {success:true});
      await admin.deletePaymentOrder({outTradeNo:"PENDING"});
      const dismissed = await billing.getPaymentOrderByOutTradeNo("PENDING");
      assert.equal(dismissed.status,"cancelled");
      assert.ok(dismissed.adminDismissedAt);
      assert.equal(dismissed.stockReserved,false);
      assert.equal(dismissed.discountConsumed,false);
      assert.equal(Number((await runtime.queryRaw('SELECT stockUsed FROM subscription_plans WHERE id=1'))[0].stockUsed),0);
      assert.equal(Number((await runtime.queryRaw('SELECT usedCount FROM discount_codes WHERE id=1'))[0].usedCount),0);
      assert.deepEqual(await billing.listPaymentOrders(),[]);
      for (const options of [{isAdmin:true},{isAdmin:false,viewerUserId:1}]) {
        assert.equal((await billing.listBillingLedgerPage({...options,page:1,pageSize:20})).totalItems,0);
        assert.deepEqual(await billing.listBillingLedger(options),[]);
        const exported=[];
        for await (const batch of billing.iterateBillingLedgerExport(options)) exported.push(...batch);
        assert.deepEqual(exported,[]);
      }
      assert.equal((await billing.getPaymentOrderStats()).totalOrders,0);
      // Ordinary late transitions cannot reactivate a cancelled order.
      assert.equal((await billing.markPaymentOrderPaid("PENDING",{tradeNo:"late"})).status,"cancelled");
      // The verified payment path restores visibility so receipts remain accountable.
      await billing.markPaymentOrderPaid("PENDING",{tradeNo:"verified"},true);
      assert.equal((await billing.getPaymentOrderByOutTradeNo("PENDING")).adminDismissedAt,null);
      assert.equal((await billing.listBillingLedgerPage({isAdmin:true,page:1,pageSize:20})).totalItems,1);
      for (const status of ["paid","processing","completed"]) {
        await insertOrder("REAL-"+status,status,"balance",123);
        await assert.rejects(admin.deletePaymentOrder({outTradeNo:"REAL-"+status}),/仅支持删除/);
      }
      for (const status of ["paid","processing"]) {
        await insertOrder("TEST-"+status,status,"test",123);
        await assert.rejects(admin.deletePaymentOrder({outTradeNo:"TEST-"+status}),/支付处理中/);
      }
      await insertOrder("TEST-COMPLETED","completed","test",123);
      await admin.deletePaymentOrder({outTradeNo:"TEST-COMPLETED"});
      assert.equal((await billing.getPaymentOrderByOutTradeNo("TEST-COMPLETED")).status,"completed");
      for (const status of ["expired","cancelled","failed"]) {
        await insertOrder("CLOSED-"+status,status);
        await admin.deletePaymentOrder({outTradeNo:"CLOSED-"+status});
      }
      await assert.rejects(admin.deletePaymentOrder({outTradeNo:"missing"}),/订单不存在/);
      const adminRows = await billing.listBillingLedger({isAdmin:true});
      assert.ok(adminRows.every(row => row.kind !== "payment" || !row.canDelete));
      const userRows = await billing.listBillingLedger({viewerUserId:1,isAdmin:false});
      assert.ok(userRows.every(row => !row.canDelete));
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "payment.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

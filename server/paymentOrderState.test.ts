import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("payment settings validate keys before saving and failed gateway orders return safe errors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-payment-keys-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import crypto from "node:crypto";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = file => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const { paymentRouter } = await import(url("server/payment.ts"));
    const { PAYMENT_ERRORS } = await import(url("shared/paymentErrors.ts"));
    const { getPanelLogs } = await import(url("server/_core/panelLogger.ts"));
    try {
      await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, name, role) VALUES (1, ?, ?, ?, ?)',
        ["payment-key-test", "x", "Payment Test", "admin"]);
      await db.setSetting("panelPublicUrl", "https://panel.example.test");
      const context = {user:{id:1,username:"payment-key-test",role:"admin"}, req:{headers:{},socket:{remoteAddress:"127.0.0.1"}}, res:{}};
      const admin = paymentRouter.createCaller(context);
      const base = await admin.getConfig();
      const pair = crypto.generateKeyPairSync("rsa", {modulusLength:2048});
      const privateKey = pair.privateKey.export({format:"der",type:"pkcs1"}).toString("base64");
      const publicKey = pair.publicKey.export({format:"der",type:"spki"}).toString("base64");
      const config = {...base,enabled:true,maxPendingOrders:0,routes:{...base.routes,alipay:"alipay"},
        alipay:{...base.alipay,enabled:true,appId:"test-app",privateKey,publicKey}};
      await assert.rejects(admin.updateConfig({...config,alipay:{...config.alipay,privateKey:"invalid"}}),
        error => error.code === "BAD_REQUEST" && error.message === PAYMENT_ERRORS.alipayPrivateKey);
      assert.equal(await db.getSetting("paymentConfig"), null);
      const saved = await admin.updateConfig(config);
      assert.equal(saved.alipay.privateKey, "");
      assert.equal(saved.alipay.hasPrivateKey, true);
      // Blank form fields must preserve existing keys, not clear them.
      await admin.updateConfig({...config,alipay:{...config.alipay,privateKey:"",publicKey:""}});
      const validConfig = await db.getSetting("paymentConfig");
      assert.equal(JSON.parse(validConfig).alipay.privateKey, privateKey);
      await assert.rejects(admin.updateConfig({...config,alipay:{...config.alipay,publicKey:privateKey}}),
        error => error.code === "BAD_REQUEST" && error.message === PAYMENT_ERRORS.alipayPublicKey);
      assert.equal(await db.getSetting("paymentConfig"), validConfig);
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        requests++;
        const params = Object.fromEntries(options.body.entries());
        const content = Object.keys(params).filter(key => key !== "sign" && params[key] !== "")
          .sort().map(key => key + "=" + params[key]).join("&");
        assert.equal(crypto.verify("RSA-SHA256", Buffer.from(content), pair.publicKey, Buffer.from(params.sign,"base64")), true);
        return new Response(JSON.stringify({alipay_trade_precreate_response:{code:"10000",qr_code:"https://qr.example.test/pay"}}),
          {status:200,headers:{"Content-Type":"application/json"}});
      };
      const order = await admin.createOrder({amount:1,paymentType:"alipay"});
      assert.equal(order.status, "pending");
      assert.equal(requests, 1);
      const legacyConfig = JSON.parse(validConfig);
      legacyConfig.alipay.privateKey = "invalid legacy key";
      await db.setSetting("paymentConfig", JSON.stringify(legacyConfig));
      const user = paymentRouter.createCaller({...context,user:{...context.user,role:"user"}});
      await assert.rejects(user.createOrder({amount:1,paymentType:"alipay"}), error => {
        assert.equal(error.message, PAYMENT_ERRORS.alipayPrivateKey);
        assert.doesNotMatch(error.message, /DECODER|unsupported|invalid legacy key/);
        return true;
      });
      assert.equal(requests, 1, "bad keys must fail before contacting the gateway");
      await db.setSetting("paymentConfig", validConfig);
      globalThis.fetch = async () => { throw new Error("mock gateway internal failure"); };
      await assert.rejects(user.createOrder({amount:1,paymentType:"alipay"}),
        error => error.message === PAYMENT_ERRORS.unavailable);
      const rows = await runtime.queryRaw('SELECT status FROM payment_orders ORDER BY id');
      assert.deepEqual(rows.map(row => row.status), ["pending", "failed", "failed"]);
      const logs = await getPanelLogs();
      assert.ok(logs.some(row => row.message.includes("order create failed") && row.message.includes("provider=alipay")
        && row.message.includes("outTradeNo=") && row.message.includes("mock gateway internal failure")));
      assert.equal(logs.some(row => row.message.includes(privateKey)), false, "private keys must not appear in logs");
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"payment.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, {recursive:true,force:true});
  }
});

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

      await runtime.executeRaw(
        'INSERT INTO "subscription_plans" ("id", "name", "durationDays", "portCount", "trafficLimit") VALUES (?, ?, ?, ?, ?)',
        [100, "Pending payment plan", 30, 1, 1000],
      );
      await runtime.executeRaw(
        'INSERT INTO "payment_orders" ("id", "outTradeNo", "userId", "provider", "paymentType", "status", "subject", "amountCents", "currency", "planId") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [20, "FWX-PLAN-PENDING", 1, "stripe", "stripe", "pending", "plan", 100, "CNY", 100],
      );
      await assert.rejects(
        () => billing.deleteSubscriptionPlan(100),
        /待支付或待发放订单/,
      );
      let [plan] = await runtime.queryRaw('SELECT "id" FROM "subscription_plans" WHERE "id" = ?', [100]);
      assert.equal(Number(plan.id), 100);

      await runtime.executeRaw('UPDATE "payment_orders" SET "status" = ? WHERE "outTradeNo" = ?', ["cancelled", "FWX-PLAN-PENDING"]);
      await billing.deleteSubscriptionPlan(100);
      [plan] = await runtime.queryRaw('SELECT "id" FROM "subscription_plans" WHERE "id" = ?', [100]);
      assert.equal(plan, undefined);
      await assert.rejects(
        () => billing.createPaymentOrder({
          outTradeNo: "FWX-DELETED-PLAN",
          userId: 1,
          provider: "stripe",
          paymentType: "stripe",
          status: "pending",
          subject: "deleted plan",
          amountCents: 100,
          currency: "CNY",
          planId: 100,
        }),
        /套餐已删除/,
      );
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

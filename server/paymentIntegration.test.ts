import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Every scenario gets its own database, log directory, credentials and mocked
// providers. Only the local callback server receives real HTTP requests.
const setup = String.raw`
  import assert from "node:assert/strict";
  import crypto from "node:crypto";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  import express from "express";
  const moduleUrl = file => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(moduleUrl("server/dbRuntime.ts"));
  const schema = await import(moduleUrl("server/dbSchema.ts"));
  const db = await import(moduleUrl("server/db.ts"));
  const payment = await import(moduleUrl("server/payment.ts"));
  const originalFetch = globalThis.fetch;
  await runtime.connectDatabase({type:"sqlite",sqlite:{path:process.env.FORWARDX_TEST_DB}});
  await schema.ensureDatabaseSchema();
  await schema.ensureDatabaseSchema(); // additive schema changes are idempotent
  await runtime.executeRaw('INSERT INTO users (id, username, password, name, role) VALUES (1, ?, ?, ?, ?)', ["payment-test", "x", "Payment Test", "admin"]);
  await db.setSetting("panelPublicUrl", "https://panel.example.test");
  const context = {user:{id:1,username:"payment-test",role:"admin"},req:{headers:{},socket:{remoteAddress:"::ffff:192.0.2.5"}},res:{}};
  const admin = payment.paymentRouter.createCaller(context);
  const otherUser = payment.paymentRouter.createCaller({...context,user:{id:2,username:"other",role:"user"}});
  const base = await admin.getConfig();
  const pair = crypto.generateKeyPairSync("rsa", {modulusLength:2048});
  const privateKey = pair.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const publicKey = pair.publicKey.export({type:"spki",format:"pem"}).toString();
  const config = {...base,enabled:true,maxPendingOrders:0,routes:{alipay:"alipay",wxpay:"wxpay"},
    alipay:{...base.alipay,enabled:true,appId:"ali-app",privateKey,publicKey},
    wxpay:{...base.wxpay,enabled:true,appId:"wx-app",mchId:"mch-1",privateKey,publicKey,apiV3Key:"12345678901234567890123456789012",certSerial:"cert-1",publicKeyId:"PUB_KEY_ID_1"}};
  const app = express();
  app.use(payment.paymentCallbackRouter);
  const server = await new Promise(resolve => { const s = app.listen(0,"127.0.0.1",() => resolve(s)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const sign = text => crypto.sign("RSA-SHA256",Buffer.from(text),pair.privateKey).toString("base64");
  const aliResponse = (method, payload, valid = true) => {
    const raw = JSON.stringify(payload);
    return new Response('{"' + method.replaceAll(".","_") + '_response":' + raw + ',"sign":' + JSON.stringify(valid ? sign(raw) : "bad") + '}', {status:200});
  };
  const wxResponse = (payload, valid = true) => {
    const raw = JSON.stringify(payload), timestamp = String(Math.floor(Date.now()/1000)), nonce = "response-nonce";
    return new Response(raw,{status:200,headers:{"wechatpay-serial":"PUB_KEY_ID_1","wechatpay-timestamp":timestamp,"wechatpay-nonce":nonce,"wechatpay-signature":valid ? sign(timestamp + "\n" + nonce + "\n" + raw + "\n") : "bad"}});
  };
  const postAli = async (number, fields = {}) => {
    const params = {app_id:"ali-app",out_trade_no:number,trade_no:"TRADE-"+number,trade_status:"TRADE_SUCCESS",total_amount:"1.00",sign_type:"RSA2",...fields};
    const content = Object.keys(params).filter(k => k !== "sign_type" && k !== "sign" && params[k] !== "").sort().map(k => k+"="+params[k]).join("&");
    params.sign = sign(content);
    return originalFetch(origin + "/api/payment/webhook/alipay",{method:"POST",body:new URLSearchParams(params)});
  };
  const postWx = async (number, fields = {}) => {
    const transaction = {appid:"wx-app",mchid:"mch-1",out_trade_no:number,transaction_id:"WX-"+number,trade_state:"SUCCESS",amount:{total:100,currency:"CNY"},...fields};
    const nonce = "0123456789ab", associated_data = "transaction";
    const cipher = crypto.createCipheriv("aes-256-gcm",Buffer.from(config.wxpay.apiV3Key),Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associated_data));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction),"utf8"),cipher.final(),cipher.getAuthTag()]).toString("base64");
    const raw = JSON.stringify({event_type:"TRANSACTION.SUCCESS",resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,nonce,associated_data}});
    const timestamp = String(Math.floor(Date.now()/1000)), headerNonce = "notify-nonce";
    return originalFetch(origin + "/api/payment/webhook/wxpay",{method:"POST",body:raw,headers:{"wechatpay-serial":"PUB_KEY_ID_1","wechatpay-timestamp":timestamp,"wechatpay-nonce":headerNonce,"wechatpay-signature":sign(timestamp+"\n"+headerNonce+"\n"+raw+"\n")}});
  };
  const createLocal = (number, fields = {}) => db.createPaymentOrder({outTradeNo:number,userId:1,provider:"alipay",paymentType:"alipay",status:"pending",subject:"test",amountCents:100,currency:"CNY",orderType:"balance",expiresAt:new Date(Date.now()+60_000),...fields});
  const balance = async () => Number((await runtime.queryRaw("SELECT balanceCents FROM users WHERE id = 1"))[0].balanceCents);
`;

function scenario(code: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-payment-integration-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", setup + "\ntry {\n" + code + String.raw`
      } finally {
        globalThis.fetch = originalFetch;
        await new Promise(resolve => server.close(resolve));
        await runtime.closeDatabase();
      }
    `], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
      env: {...process.env,DATABASE_TYPE:"sqlite",FORWARDX_TEST_DB:path.join(directory,"payment.db"),FORWARDX_LOG_DIR:path.join(directory,"logs")},
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, {recursive:true,force:true}); }
}

test("EasyPay signs the complete API request and configuration validation rejects unusable WeChat modes", () => scenario(String.raw`
  const easy = {...base,enabled:true,maxPendingOrders:0,easypay:{...base.easypay,enabled:true,mode:"api",apiBase:"https://easy.example.test",pid:"pid-1",pkey:"secret"}};
  await admin.updateConfig(easy);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url,"https://easy.example.test/mapi.php");
    const params = Object.fromEntries(options.body.entries());
    assert.equal(params.clientip,"192.0.2.5");
    const content = Object.keys(params).filter(k=>!['sign','sign_type'].includes(k)&&params[k]!=="").sort().map(k=>k+"="+params[k]).join("&")+"secret";
    assert.equal(params.sign,crypto.createHash("md5").update(content).digest("hex"));
    return new Response(JSON.stringify({code:1,trade_no:"EP-1",payurl:"/pay/1",qrcode:"/qr/1"}),{status:200});
  };
  const order = await admin.createOrder({amount:1,paymentType:"alipay"});
  assert.equal(order.payUrl,"https://easy.example.test/pay/1");
  assert.equal(order.qrCode,"https://easy.example.test/qr/1");
  assert.equal(calls,1);
  await assert.rejects(admin.updateConfig({...config,wxpay:{...config.wxpay,apiV3Key:"short"}}), /32 字节/);
  await assert.rejects(admin.updateConfig({...config,wxpay:{...config.wxpay,apiV3Key:"中".repeat(32)}}), /32 字节/);
  await assert.rejects(admin.updateConfig({...config,wxpay:{...config.wxpay,publicKey:""}}), /配置不完整/);
  await assert.rejects(admin.updateConfig({...config,wxpay:{...config.wxpay,mode:"jsapi"}}), /不支持微信 JSAPI/);
  await admin.updateConfig(config);
  const legacy = {...config,wxpay:{...config.wxpay,mode:"jsapi"}};
  await db.setSetting("paymentConfig",JSON.stringify(legacy));
  assert.equal((await admin.availableMethods()).some(method=>method.value==="wxpay"),false);
  await assert.rejects(admin.createOrder({amount:1,paymentType:"wxpay"}),/不支持微信 JSAPI/);
`));

test("verified delayed callbacks recover closed orders exactly once and reject wrong amounts, apps and merchants", () => scenario(String.raw`
  await admin.updateConfig(config);
  for (const status of ["pending","expired","cancelled","failed"]) {
    const number = "LATE-"+status;
    await createLocal(number,{status,expiresAt:new Date(Date.now()-60_000)});
    const results = await Promise.all([postAli(number),postAli(number)]);
    for (const response of results) assert.equal(response.status,200,await response.text());
    assert.equal((await db.getPaymentOrderByOutTradeNo(number)).status,"completed");
    assert.equal((await runtime.queryRaw("SELECT id FROM balance_transactions WHERE paymentOrderNo = ?",[number])).length,1);
  }
  assert.equal(await balance(),400);
  await createLocal("WRONG-AMOUNT");
  assert.notEqual((await postAli("WRONG-AMOUNT",{total_amount:"0.01"})).status,200);
  assert.equal((await db.getPaymentOrderByOutTradeNo("WRONG-AMOUNT")).status,"pending");
  await createLocal("WRONG-APP");
  assert.notEqual((await postAli("WRONG-APP",{app_id:"other-app"})).status,200);
  await createLocal("OLD-MERCHANT",{merchantIdentity:JSON.stringify({appId:"old-app",gateway:config.alipay.gateway})});
  assert.notEqual((await postAli("OLD-MERCHANT")).status,200);
  await createLocal("TOO-LATE",{status:"expired",expiresAt:new Date(Date.now()-8*86400_000)});
  assert.notEqual((await postAli("TOO-LATE")).status,200);
  assert.equal((await db.getPaymentOrderByOutTradeNo("TOO-LATE")).status,"expired");
  assert.notEqual((await postAli("LATE-pending",{total_amount:"2.00"})).status,200,"duplicates still validate amount");
  assert.notEqual((await postAli("LATE-pending",{trade_no:"OTHER-TRADE"})).status,200,"duplicates still validate trade identity");
  await createLocal("WX-LATE",{provider:"wxpay",paymentType:"wxpay",status:"expired"});
  assert.equal((await postWx("WX-LATE")).status,204);
  assert.equal((await postWx("WX-LATE")).status,204);
  await createLocal("WX-WRONG-MERCHANT",{provider:"wxpay",paymentType:"wxpay"});
  assert.notEqual((await postWx("WX-WRONG-MERCHANT",{mchid:"other-mch"})).status,204);
  await createLocal("WX-WRONG-CURRENCY",{provider:"wxpay",paymentType:"wxpay"});
  assert.notEqual((await postWx("WX-WRONG-CURRENCY",{amount:{total:100,currency:"USD"}})).status,204);
  assert.equal(await balance(),500);
  const latest = await db.getPaymentOrderByOutTradeNo("LATE-pending");
  await db.setPaymentOrderCheckout("LATE-pending",{tradeNo:"placeholder",payUrl:"https://pay.test",qrCode:null});
  assert.equal((await db.getPaymentOrderByOutTradeNo("LATE-pending")).tradeNo,latest.tradeNo,"create response cannot overwrite verified trade number");
`));

test("active queries verify provider signatures, enforce ownership/throttling and recover missing callbacks", () => scenario(String.raw`
  await admin.updateConfig(config);
  let calls = 0, valid = true, paid = true;
  globalThis.fetch = async (url, options) => {
    calls++;
    const params = Object.fromEntries(options.body.entries());
    const content = Object.keys(params).filter(k=>k!=="sign"&&params[k]!=="").sort().map(k=>k+"="+params[k]).join("&");
    assert.ok(crypto.verify("RSA-SHA256",Buffer.from(content),pair.publicKey,Buffer.from(params.sign,"base64")));
    const number = JSON.parse(params.biz_content).out_trade_no;
    return aliResponse(params.method,{code:"10000",out_trade_no:number,trade_no:"QUERY-"+number,trade_status:paid ? "TRADE_SUCCESS" : "WAIT_BUYER_PAY",total_amount:"1.00"},valid);
  };
  await createLocal("QUERY-OWNER");
  assert.equal(await otherUser.queryOrder({outTradeNo:"QUERY-OWNER"}),null);
  assert.equal(calls,0);
  const result = await admin.queryOrder({outTradeNo:"QUERY-OWNER"});
  assert.equal(result.status,"completed");
  assert.equal(await balance(),100);
  await admin.queryOrder({outTradeNo:"QUERY-OWNER"});
  assert.equal(calls,1);
  valid = false;
  await createLocal("QUERY-BAD-SIGN");
  const rejected = await admin.queryOrder({outTradeNo:"QUERY-BAD-SIGN"});
  assert.equal(rejected.status,"pending");
  assert.equal(rejected.reconciliationFailed,true);
  assert.ok((await db.getPaymentOrderByOutTradeNo("QUERY-BAD-SIGN")).failureReason);
  await admin.queryOrder({outTradeNo:"QUERY-BAD-SIGN"});
  assert.equal(calls,2,"polling must not hammer the gateway after a failure");
  valid = true;
  paid = false;
  await runtime.executeRaw("UPDATE payment_orders SET lastPaymentCheckAt = ? WHERE outTradeNo = ?",[Math.floor(Date.now()/1000)-31,"QUERY-BAD-SIGN"]);
  const recoveredQuery = await admin.queryOrder({outTradeNo:"QUERY-BAD-SIGN"});
  assert.equal(recoveredQuery.status,"pending");
  assert.equal(recoveredQuery.reconciliationFailed,false,"clear stale query errors once verification succeeds");
  paid = true;
  await createLocal("QUERY-BACKGROUND",{status:"expired"});
  await payment.reconcilePendingPaymentOrders();
  assert.equal((await db.getPaymentOrderByOutTradeNo("QUERY-BACKGROUND")).status,"completed");
  assert.equal(await balance(),200);
  await createLocal("QUERY-MERCHANT-CHANGED",{merchantIdentity:JSON.stringify({appId:"old",gateway:config.alipay.gateway})});
  const before = calls;
  await admin.queryOrder({outTradeNo:"QUERY-MERCHANT-CHANGED"});
  assert.equal(calls,before,"never query an old order against a different merchant");
  await createLocal("PAID-CRASH",{status:"paid",paidAt:new Date(),tradeNo:"paid"});
  await payment.recoverStaleProcessingPaymentOrders();
  assert.equal((await db.getPaymentOrderByOutTradeNo("PAID-CRASH")).status,"completed");
  assert.equal(await balance(),300);
  globalThis.fetch = async url => {
    assert.match(String(url),/\/v3\/pay\/transactions\/out-trade-no\/WX-QUERY\?mchid=mch-1/);
    return wxResponse({appid:"wx-app",mchid:"mch-1",out_trade_no:"WX-QUERY",transaction_id:"wx-query-trade",trade_state:"SUCCESS",amount:{total:100,currency:"CNY"}});
  };
  await createLocal("WX-QUERY",{provider:"wxpay",paymentType:"wxpay"});
  assert.equal((await admin.queryOrder({outTradeNo:"WX-QUERY"})).status,"completed");
  assert.equal(await balance(),400);
`));

test("WeChat create verifies signed raw responses and refuses unsigned QR links", () => scenario(String.raw`
  await admin.updateConfig(config);
  let valid = true;
  globalThis.fetch = async (url, options) => {
    assert.equal(url,"https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    assert.equal(options.headers["Wechatpay-Serial"],"PUB_KEY_ID_1");
    const payload = JSON.parse(options.body);
    assert.equal(payload.appid,"wx-app");
    assert.equal(payload.mchid,"mch-1");
    return wxResponse({code_url:"weixin://wxpay/bizpayurl?pr=mock"},valid);
  };
  const order = await admin.createOrder({amount:1,paymentType:"wxpay"});
  assert.equal(order.qrCode,"weixin://wxpay/bizpayurl?pr=mock");
  valid = false;
  await assert.rejects(admin.createOrder({amount:1,paymentType:"wxpay"}));
  const orders = await db.listPaymentOrders();
  assert.equal(orders.find(item=>item.status==="failed").failureReason.includes("创建支付订单失败"),true);
`));

test("EasyPay active queries and GET/POST notifications verify merchant identity even after payments are disabled", () => scenario(String.raw`
  const easy = {...base,enabled:true,maxPendingOrders:0,easypay:{...base.easypay,enabled:true,apiBase:"https://easy.example.test",pid:"pid-1",pkey:"never-log-this-key"}};
  await admin.updateConfig(easy);
  const notify = async (number, fields = {}, method = "POST") => {
    const params = {pid:"pid-1",out_trade_no:number,trade_no:"EP-"+number,trade_status:"TRADE_SUCCESS",money:"1.00",...fields};
    const content = Object.keys(params).filter(k=>k!=="sign"&&k!=="sign_type"&&params[k]!=="").sort().map(k=>k+"="+params[k]).join("&")+easy.easypay.pkey;
    params.sign = crypto.createHash("md5").update(content).digest("hex");
    const query = new URLSearchParams(params);
    return originalFetch(origin+"/api/payment/webhook/easypay"+(method==="GET"?"?"+query:""),{method,...(method==="POST"?{body:query}:{})});
  };
  const local = (number, fields = {}) => createLocal(number,{provider:"easypay",paymentType:"alipay",...fields});
  await local("EP-QUERY");
  globalThis.fetch = async url => {
    const request = new URL(url);
    assert.equal(request.pathname,"/api.php");
    assert.equal(request.searchParams.get("act"),"order");
    assert.equal(request.searchParams.get("key"),easy.easypay.pkey);
    const number = request.searchParams.get("out_trade_no");
    return new Response(JSON.stringify({code:1,pid:"pid-1",out_trade_no:number,trade_no:"EP-QUERY-"+number,money:"1.00",status:number === "EP-MISSING-PID" ? 0 : 1}));
  };
  assert.equal((await admin.queryOrder({outTradeNo:"EP-QUERY"})).status,"completed");
  await db.setSetting("paymentConfig",JSON.stringify({...easy,enabled:false,easypay:{...easy.easypay,enabled:false}}));
  await local("EP-DISABLED-GET",{status:"expired"});
  assert.equal((await notify("EP-DISABLED-GET",{},"GET")).status,200);
  await local("EP-DISABLED-POST");
  assert.equal((await notify("EP-DISABLED-POST")).status,200);
  await local("EP-MISSING-PID");
  assert.equal((await notify("EP-MISSING-PID",{pid:""})).status,400);
  await local("EP-DISABLED-QUERY");
  await payment.reconcilePendingPaymentOrders();
  assert.equal((await db.getPaymentOrderByOutTradeNo("EP-DISABLED-QUERY")).status,"completed");
  await local("EP-FAILED-QUERY");
  globalThis.fetch = async url => { throw new Error(String(url)); };
  assert.equal((await admin.queryOrder({outTradeNo:"EP-FAILED-QUERY"})).status,"pending");
  const {getPanelLogs} = await import(moduleUrl("server/_core/panelLogger.ts"));
  assert.equal((await getPanelLogs()).some(log=>log.message.includes(easy.easypay.pkey)),false,"query URLs and secrets must not be logged");
  assert.equal(await balance(),400);
`));

test("fast verified callbacks win races with both successful and failed create responses", () => scenario(String.raw`
  await admin.updateConfig(config);
  let failResponse = false;
  globalThis.fetch = async (_url, options) => {
    const params = Object.fromEntries(options.body.entries());
    const number = JSON.parse(params.biz_content).out_trade_no;
    assert.equal((await postAli(number)).status,200);
    if (failResponse) throw new Error("response lost after payment");
    return aliResponse(params.method,{code:"10000",qr_code:"https://qr.test/pay"});
  };
  const first = await admin.createOrder({amount:1,paymentType:"alipay"});
  assert.equal(first.status,"completed");
  assert.equal(first.tradeNo,"TRADE-"+first.outTradeNo);
  failResponse = true;
  const second = await admin.createOrder({amount:1,paymentType:"alipay"});
  assert.equal(second.status,"completed");
  assert.equal(second.failureReason,null);
  assert.equal(await balance(),200);
`));

test("failed fulfillment retains confirmed payment and diagnostics until a safe retry completes", () => scenario(String.raw`
  await admin.updateConfig(config);
  await createLocal("ORPHAN-PLAN",{orderType:"plan",planId:null});
  assert.equal((await postAli("ORPHAN-PLAN")).status,500);
  const failed = await db.getPaymentOrderByOutTradeNo("ORPHAN-PLAN");
  assert.equal(failed.status,"processing");
  assert.ok(failed.paidAt);
  assert.match(failed.failureReason,/已收款/);
  assert.equal(await balance(),0);
  // Simulate administrator correction of the orphaned purpose and an expired
  // processing lease; recovery must fulfill once and clear the diagnostic.
  await db.updatePaymentOrder("ORPHAN-PLAN",{orderType:"balance"});
  await runtime.executeRaw("UPDATE payment_orders SET updatedAt = ? WHERE outTradeNo = ?",[Math.floor(Date.now()/1000)-660,"ORPHAN-PLAN"]);
  await payment.recoverStaleProcessingPaymentOrders();
  assert.equal((await db.getPaymentOrderByOutTradeNo("ORPHAN-PLAN")).status,"completed");
  assert.equal((await db.getPaymentOrderByOutTradeNo("ORPHAN-PLAN")).failureReason,null);
  assert.equal((await postAli("ORPHAN-PLAN")).status,200);
  assert.equal(await balance(),100);
`));

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

for (const algorithm of ["md5", "hmac-sha256"] as const) test(`GM Pay ${algorithm} config, checkout and authenticated callbacks credit exactly once`, () => scenario(`const algorithm = ${JSON.stringify(algorithm)};` + String.raw`
  const gm = {...base,enabled:true,maxPendingOrders:0,gmpay:{...base.gmpay,enabled:true,apiBase:"https://gm.example.test",pid:"1000",secretKey:"gm-secret-never-log",signatureAlgorithm:algorithm}};
  const legacy = {...gm,gmpay:{...gm.gmpay}};
  delete legacy.gmpay.signatureAlgorithm;
  await db.setSetting("paymentConfig",JSON.stringify(legacy));
  assert.equal((await admin.getConfig()).gmpay.signatureAlgorithm,"md5");
  const saved = await admin.updateConfig(gm);
  assert.equal(saved.gmpay.signatureAlgorithm,algorithm);
  assert.equal(saved.gmpay.secretKey,"");
  assert.equal(saved.gmpay.hasSecretKey,true);
  // Older clients omitting the new field must not reset a saved v2 selection.
  await admin.updateConfig({...legacy,gmpay:{...legacy.gmpay,secretKey:""}});
  assert.equal((await admin.getConfig()).gmpay.signatureAlgorithm,algorithm);
  assert.equal((await payment.getPaymentConfig()).gmpay.secretKey,gm.gmpay.secretKey);
  await assert.rejects(admin.updateConfig({...gm,gmpay:{...gm.gmpay,signatureAlgorithm:"auto-downgrade"}}));
  await assert.rejects(otherUser.updateConfig(gm));
  const signature = (params, mode = algorithm, secret = gm.gmpay.secretKey) => {
    const canonical = Object.keys(params).filter(k=>k!=="signature"&&params[k]!==""&&params[k]!=null).sort().map(k=>k+"="+params[k]).join("&");
    return mode === "md5" ? crypto.createHash("md5").update(canonical+secret).digest("hex") : crypto.createHmac("sha256",secret).update(canonical).digest("hex");
  };
  let creates = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url,"https://gm.example.test/payments/gmpay/v1/order/create-transaction");
    const params = Object.fromEntries(options.body.entries());
    assert.equal(params.signature,signature(params));
    assert.equal(params.pid,"1000");
    assert.equal(params.amount,"1.00");
    assert.equal(params.notify_url,"https://panel.example.test/api/payment/webhook/gmpay");
    creates++;
    return new Response(JSON.stringify({status_code:200,data:{trade_id:"GM-"+params.order_id,order_id:params.order_id,amount:1,actual_amount:0.14,token:"USDT",payment_url:"/pay/checkout-counter/"+params.order_id}}));
  };
  const order = await admin.createOrder({amount:1,paymentType:"usdt"});
  assert.equal(creates,1);
  assert.equal(order.status,"pending");
  assert.equal(order.payUrl,"https://gm.example.test/pay/checkout-counter/"+order.outTradeNo);
  const payload = {pid:"1000",trade_id:order.tradeNo,order_id:order.outTradeNo,amount:1,actual_amount:0.14,receive_address:"TAddress",token:"USDT",block_transaction_id:"tx-id",status:2};
  const post = fields => originalFetch(origin+"/api/payment/webhook/gmpay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(fields)});
  const valid = {...payload,signature:signature(payload)};
  assert.equal((await post({...valid,signature:signature(payload,algorithm === "md5" ? "hmac-sha256" : "md5")})).status,400);
  assert.equal((await post({...valid,signature:signature(payload,algorithm,"wrong-key")})).status,400);
  assert.equal((await post({...valid,amount:100})).status,400);
  for (const fields of [{pid:"other"},{token:"BTC"},{amount:2},{trade_id:"wrong-trade"}]) {
    const changed = {...payload,...fields};
    assert.notEqual((await post({...changed,signature:signature(changed)})).status,200);
  }
  assert.equal(await balance(),0);
  assert.equal((await db.getPaymentOrderByOutTradeNo(order.outTradeNo)).status,"pending");
  // Valid paid callbacks still settle after new payments are disabled.
  await admin.updateConfig({...gm,enabled:false,gmpay:{...gm.gmpay,enabled:false}});
  assert.equal((await post(valid)).status,200);
  assert.equal((await post(valid)).status,200);
  assert.equal((await db.getPaymentOrderByOutTradeNo(order.outTradeNo)).status,"completed");
  assert.equal(await balance(),100);
  const {getPanelLogs} = await import(moduleUrl("server/_core/panelLogger.ts"));
  assert.equal((await getPanelLogs()).some(log=>log.message.includes(gm.gmpay.secretKey)),false);
`));

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

test("multi-period online purchases price the full order, snapshot validity and fulfill each payment once", () => scenario(String.raw`
  const easy = {...base,enabled:true,maxPendingOrders:0,easypay:{...base.easypay,enabled:true,mode:"api",apiBase:"https://easy.example.test",pid:"pid-1",pkey:"secret"}};
  await admin.updateConfig(easy);
  await db.setSetting("storeEnabled", "true");
  await runtime.insertAndGetId("hosts", {id:1,name:"period-host",ip:"127.0.0.1",userId:1,portRangeStart:20000,portRangeEnd:30000});
  await runtime.insertAndGetId("subscription_plans", {id:1,name:"period-plan",priceCents:100,durationDays:30,stockLimit:1,portCount:2,trafficLimit:1000000});
  await runtime.insertAndGetId("subscription_plan_hosts", {planId:1,hostId:1});
  const discount = await db.createDiscountCode({code:"PERIOD",discountType:"amount",discountValue:100,maxUses:1});
  let checkoutCount = 0;
  globalThis.fetch = async (url, options) => {
    if (url === "https://easy.example.test/mapi.php") {
      const params = Object.fromEntries(options.body.entries());
      assert.equal(params.money, checkoutCount++ === 0 ? "4.00" : "5.40", "server calculates total from the selected cycle, quantity and discount");
      return new Response(JSON.stringify({code:1,payurl:"/pay/period"}));
    }
    return originalFetch(url, options);
  };
  const postEasy = async order => {
    const params = {pid:"pid-1",out_trade_no:order.outTradeNo,trade_no:"EP-"+order.outTradeNo,type:"alipay",trade_status:"TRADE_SUCCESS",money:(order.amountCents/100).toFixed(2)};
    const content = Object.keys(params).sort().map(key=>key+"="+params[key]).join("&")+"secret";
    return originalFetch(origin+"/api/payment/webhook/easypay", {method:"POST",body:new URLSearchParams({...params,sign:crypto.createHash("md5").update(content).digest("hex"),sign_type:"MD5"})});
  };
  await assert.rejects(admin.createOrder({amount:1,paymentType:"alipay",planId:1,quantity:2}),/每次只能购买一份/);
  const fixedPrice = JSON.stringify([{durationDays:90,kind:"fixed",priceCents:250}]);
  await runtime.executeRaw("UPDATE subscription_plans SET cyclePrices = ? WHERE id = 1",[fixedPrice]);
  const first = await admin.createOrder({amount:0.01,paymentType:"alipay",planId:1,quantity:2,billingCycleDays:90,discountCode:"PERIOD"});
  assert.equal(first.amountCents,400);
  assert.equal(first.planQuantity,2);
  assert.equal(first.planDurationDays,180);
  assert.equal(first.discountAmountCents,100);
  assert.match(first.subject,/2/);
  await runtime.executeRaw("UPDATE subscription_plans SET durationDays = 365 WHERE id = 1");
  await assert.rejects(admin.createOrder({amount:1,paymentType:"alipay",planId:1,quantity:2}),/每次只能购买一份/);
  await assert.rejects(admin.createOrder({amount:1,paymentType:"alipay",planId:1,billingCycleDays:90}),/所选付款周期不可购买/);
  assert.equal((await postEasy(first)).status,200);
  const completed = await db.getPaymentOrderByOutTradeNo(first.outTradeNo);
  assert.equal(completed.status,"completed");
  const initial = await db.getUserSubscriptionById(completed.subscriptionId);
  assert.equal(new Date(initial.expiresAt)-new Date(initial.startedAt),180*86400000,"payment uses duration at checkout, not the edited plan");
  assert.ok(new Date(initial.nextTrafficResetAt)<new Date(initial.expiresAt));
  assert.equal((await postEasy(first)).status,200);
  const discounted = JSON.stringify([{durationDays:90,kind:"percent",pricePercent:90}]);
  await runtime.executeRaw("UPDATE subscription_plans SET durationDays = 30, cyclePrices = ? WHERE id = 1",[discounted]);
  const renewal = await admin.createOrder({amount:999,paymentType:"alipay",planId:1,quantity:2,billingCycleDays:90,subscriptionId:initial.id});
  assert.equal(renewal.amountCents,540);
  assert.equal(renewal.planQuantity,2);
  assert.equal(renewal.stockReserved,false);
  assert.equal((await postEasy(renewal)).status,200);
  const latest = await db.getUserSubscriptionById(initial.id);
  assert.equal(new Date(latest.expiresAt)-new Date(initial.expiresAt),180*86400000);
  assert.equal(latest.portRangeStart,initial.portRangeStart);
  assert.equal((await postEasy(renewal)).status,200);
  assert.equal(new Date((await db.getUserSubscriptionById(initial.id)).expiresAt).getTime(),new Date(latest.expiresAt).getTime());
  assert.equal((await db.getDiscountCodeById(discount.id)).usedCount,1);
  assert.equal((await runtime.queryRaw("SELECT stockUsed FROM subscription_plans WHERE id = 1"))[0].stockUsed,1);
  assert.equal((await runtime.queryRaw("SELECT COUNT(*) AS n FROM user_subscriptions"))[0].n,1);
  assert.equal((await runtime.queryRaw("SELECT trafficLimit FROM users WHERE id = 1"))[0].trafficLimit,1000000);
  assert.equal(await balance(),0);
  for (const quantity of [0,1.5,101]) await assert.rejects(admin.createOrder({amount:1,paymentType:"alipay",planId:1,quantity}));
  await assert.rejects(admin.createOrder({amount:1,paymentType:"alipay",quantity:2}),/仅适用于套餐/);
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

test("a verified Alipay trade-not-found query keeps waiting for payment", () => scenario(String.raw`
  await admin.updateConfig({...config,alipay:{...config.alipay,mode:"page"}});
  const order=await admin.createOrder({amount:1,paymentType:"alipay"});
  const subCode="ACQ.TRADE_NOT_EXIST";
  const notFound={code:"40004",sub_code:subCode,sub_msg:"交易不存在"};
  await db.recordPaymentOrderFailure(order.outTradeNo,"支付状态核对失败，请管理员按订单号查看支付日志");
  globalThis.fetch=async (_url,options)=>{
    const params=Object.fromEntries(options.body.entries());
    assert.equal(params.method,"alipay.trade.query");
    return aliResponse(params.method,notFound);
  };
  assert.deepEqual(await admin.queryOrder({outTradeNo:order.outTradeNo}),{
    outTradeNo:order.outTradeNo,status:"pending",reconciliationFailed:false,
  });
  assert.equal(await balance(),0);
  assert.equal((await db.getPaymentOrderByOutTradeNo(order.outTradeNo)).failureReason,null);
  const retry=async (payload,signed)=>{
    await runtime.executeRaw("UPDATE payment_orders SET lastPaymentCheckAt = NULL WHERE outTradeNo = ?",[order.outTradeNo]);
    globalThis.fetch=async()=>aliResponse("alipay.trade.query",payload,signed);
    return admin.queryOrder({outTradeNo:order.outTradeNo});
  };
  assert.equal((await retry(notFound,false)).reconciliationFailed,true);
  assert.equal((await retry({...notFound,sub_code:"ACQ.SYSTEM_ERROR"},true)).reconciliationFailed,true);
  assert.equal(await balance(),0);
  assert.equal((await retry({
    code:"10000",out_trade_no:order.outTradeNo,trade_no:"ALIPAY-PAID",trade_status:"TRADE_SUCCESS",total_amount:"1.00",
  },true)).status,"completed");
  assert.equal(await balance(),100);
`));

test("payment channel fees are added to gateway charges and excluded from balance credit", () => scenario(String.raw`
  const feeConfig = {
    ...base,
    enabled: true,
    maxPendingOrders: 0,
    routes: { ...base.routes, alipay: "easypay" },
    easypay: { ...base.easypay, enabled: true, apiBase: "https://easy.example.test", pid: "fee-pid", pkey: "fee-secret" },
    fees: { ...base.fees, alipay: { enabled: true, rateBps: 250, fixedCents: 10 } },
  };
  await admin.updateConfig(feeConfig);
  const legacyClientConfig = { ...feeConfig };
  delete legacyClientConfig.fees;
  await admin.updateConfig(legacyClientConfig);
  assert.deepEqual(await admin.feeQuote({ amountCents: 101, paymentType: "alipay" }), {
    enabled: true, rateBps: 250, fixedCents: 10, baseAmountCents: 101, feeCents: 13, totalAmountCents: 114,
  });
  globalThis.fetch = async (_url, options) => {
    const params = Object.fromEntries(options.body.entries());
    assert.equal(params.money, "1.14");
    return new Response(JSON.stringify({ code: 1, trade_no: "FEE-TRADE", payurl: "https://easy.example.test/pay" }));
  };
  const order = await admin.createOrder({ amount: 1.01, paymentType: "alipay" });
  assert.equal(order.amountCents, 114);
  assert.equal(order.baseAmountCents, 101);
  assert.equal(order.feeAmountCents, 13);
  const params = { pid: "fee-pid", out_trade_no: order.outTradeNo, trade_no: "FEE-TRADE", trade_status: "TRADE_SUCCESS", money: "1.14" };
  const canonical = Object.keys(params).sort().map(key => key + "=" + params[key]).join("&") + "fee-secret";
  params.sign = crypto.createHash("md5").update(canonical).digest("hex");
  params.sign_type = "MD5";
  assert.equal((await originalFetch(origin + "/api/payment/webhook/easypay", { method: "POST", body: new URLSearchParams(params) })).status, 200);
  assert.equal((await db.getPaymentOrderByOutTradeNo(order.outTradeNo)).status, "completed");
  assert.equal(await balance(), 101);
`));

test("PayPal validates the captured order, preserves wallet currency and isolates sandbox orders", () => scenario(String.raw`
  const paypal = { ...base.paypal, enabled:true, currency:"USD", cnyPerUnit:7.25, clientId:"merchant-client",
    clientSecret:"merchant-secret", webhookId:"WEBHOOKID", environment:"sandbox" };
  const fee = { enabled:true, rateBps:250, fixedCents:30 };
  const paypalConfig = { ...base, enabled:true, maxPendingOrders:0, paypal, fees:{ ...base.fees, paypal:fee } };
  await assert.rejects(admin.updateConfig({...paypalConfig,paypal:{...paypal,cnyPerUnit:0}}), /人民币换算汇率/);
  const safe = await admin.updateConfig(paypalConfig);
  assert.equal(safe.paypal.clientSecret,"");
  assert.equal(safe.paypal.hasClientSecret,true);
  assert.deepEqual(await otherUser.availableMethods(),[]);
  await assert.rejects(otherUser.createOrder({amount:72.5,paymentType:"paypal",orderType:"test"}),/沙盒仅支持管理员/);
  await assert.rejects(admin.createOrder({amount:72.5,paymentType:"paypal"}),/沙盒仅支持管理员/);
  assert.deepEqual(await admin.feeQuote({amountCents:7250,paymentType:"paypal"}), {
    ...fee, currency:"USD", baseAmountCents:1000, feeCents:55, totalAmountCents:1055,
  });
  assert.equal((await admin.feeQuote({amountCents:7251,paymentType:"paypal"})).baseAmountCents,1001);
  await assert.rejects(admin.feeQuote({amountCents:1000,paymentType:"paypal",currency:"EUR"}), /套餐币种/);

  const orders = new Map();
  let environment = "sandbox";
  let captureRequests = 0;
  let verifiedEvents = 0;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    assert.equal(u.hostname, environment === "sandbox" ? "api-m.sandbox.paypal.com" : "api-m.paypal.com");
    assert.equal(options.redirect,"error");
    if (u.pathname === "/v1/oauth2/token") {
      assert.equal(options.headers.Authorization,"Basic "+Buffer.from("merchant-client:merchant-secret").toString("base64"));
      assert.equal(options.body,"grant_type=client_credentials");
      return Response.json({access_token:"test-access"});
    }
    assert.equal(options.headers.Authorization,"Bearer test-access");
    if (u.pathname === "/v1/notifications/verify-webhook-signature") {
      const params = JSON.parse(options.body);
      assert.equal(params.webhook_id,"WEBHOOKID");
      assert.equal(params.transmission_id,"TRANSMISSION");
      assert.ok(params.webhook_event.event_type);
      verifiedEvents++;
      return Response.json({verification_status:params.transmission_sig === "valid" ? "SUCCESS" : "FAILURE"});
    }
    if (u.pathname === "/v2/checkout/orders") {
      const request = JSON.parse(options.body);
      const unit = request.purchase_units[0];
      const experience = request.payment_source.paypal.experience_context;
      assert.equal(options.headers["PayPal-Request-Id"],"create-"+unit.reference_id);
      assert.equal(request.intent,"CAPTURE");
      assert.equal(experience.shipping_preference,"NO_SHIPPING");
      assert.equal(experience.user_action,"PAY_NOW");
      assert.equal(new URL(experience.return_url).pathname,"/api/payment/return/paypal");
      assert.equal(new URL(experience.cancel_url).searchParams.get("payment_cancelled"),"1");
      const id = "ORDER"+(orders.size+1);
      orders.set(id,{id,intent:"CAPTURE",status:"CREATED",purchase_units:[unit]});
      const host = environment === "sandbox" ? "www.sandbox.paypal.com" : "www.paypal.com";
      return Response.json({id,links:[{rel:"payer-action",href:"https://"+host+"/checkoutnow?token="+id}]});
    }
    const [,id,capture] = /^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(u.pathname) || [];
    const order = orders.get(id);
    assert.ok(order);
    if (capture) {
      assert.equal(options.headers["PayPal-Request-Id"],"capture-"+order.purchase_units[0].reference_id);
      if (order.status === "COMPLETED") return Response.json({details:[{issue:"ORDER_ALREADY_CAPTURED"}]},{status:422});
      assert.equal(order.status,"APPROVED");
      captureRequests++;
      order.status="COMPLETED";
      const unit=order.purchase_units[0];
      unit.payments={captures:[{id:"CAPTURE"+id,status:"COMPLETED",amount:{...unit.amount},final_capture:true}]};
      return Response.json(order);
    }
    assert.equal(options.method,"GET");
    return Response.json(order);
  };
  const post = (type, id, signature = "valid", captureId = "CAPTURE"+id) => originalFetch(origin+"/api/payment/webhook/paypal",{
    method:"POST",headers:{"Content-Type":"application/json","PayPal-Auth-Algo":"SHA256withRSA","PayPal-Cert-Url":"https://api.paypal.com/cert",
      "PayPal-Transmission-Id":"TRANSMISSION","PayPal-Transmission-Sig":signature,"PayPal-Transmission-Time":"2026-11-27T00:00:00Z"},
    body:JSON.stringify({event_type:type,resource:type==="CHECKOUT.ORDER.APPROVED" ? {id} : {id:captureId,supplementary_data:{related_ids:{order_id:id}}}}),
  });
  const browserReturn = (order, token = order.tradeNo) => originalFetch(origin+"/api/payment/return/paypal?return_to=/wallet&out_trade_no="+order.outTradeNo+"&token="+token,{redirect:"manual"});

  const sandbox = await admin.createOrder({amount:72.5,paymentType:"paypal",orderType:"test"});
  assert.match(sandbox.payUrl,/^https:\/\/www\.sandbox\.paypal\.com\//);
  orders.get(sandbox.tradeNo).status="APPROVED";
  assert.equal((await post("CHECKOUT.ORDER.APPROVED",sandbox.tradeNo)).status,200);
  assert.equal((await db.getPaymentOrderByOutTradeNo(sandbox.outTradeNo)).status,"completed");
  assert.equal(await balance(),0);
  assert.deepEqual((await admin.stats()).paidAmounts,[]);

  await admin.updateConfig({...paypalConfig,paypal:{...paypal,environment:"live",clientSecret:""}});
  // Legacy settings forms only send known channels; the PayPal settings and fee survive.
  const legacy = {...paypalConfig,fees:{...paypalConfig.fees}};
  delete legacy.paypal;
  delete legacy.fees.paypal;
  await admin.updateConfig(legacy);
  environment="live";
  assert.deepEqual(await otherUser.availableMethods(),[{value:"paypal",label:"PayPal",feeEnabled:true,rateBps:250,fixedCents:30,currency:"USD"}]);
  const order=await admin.createOrder({amount:72.5,paymentType:"paypal"});
  assert.deepEqual([order.amountCents,order.baseAmountCents,order.feeAmountCents,order.balanceCreditCents,order.currency],[1055,1000,55,7250,"USD"]);
  assert.match(order.payUrl,/^https:\/\/www\.paypal\.com\//);
  assert.equal(orders.get(order.tradeNo).purchase_units[0].amount.value,"10.55");
  assert.equal((await browserReturn(order)).status,303);
  assert.equal(captureRequests,1);
  orders.get(order.tradeNo).status="APPROVED";
  assert.equal((await post("CHECKOUT.ORDER.APPROVED",order.tradeNo,"invalid")).status,400);
  assert.equal((await browserReturn(order,"WRONGID")).status,303);
  assert.equal(await balance(),0);
  assert.equal(captureRequests,1);

  await admin.updateConfig({...paypalConfig,paypal:{...paypal,environment:"live",cnyPerUnit:6.5}});
  const returned=await browserReturn(order);
  assert.equal(returned.status,303);
  assert.equal(new URL(returned.headers.get("location")).searchParams.get("payment_return"),"paypal");
  assert.equal((await db.getPaymentOrderByOutTradeNo(order.outTradeNo)).status,"completed");
  assert.equal(await balance(),7250);
  assert.notEqual((await post("PAYMENT.CAPTURE.COMPLETED",order.tradeNo,"valid","WRONGCAPTURE")).status,200);
  assert.equal((await post("PAYMENT.CAPTURE.COMPLETED",order.tradeNo)).status,200);
  assert.equal((await post("CHECKOUT.ORDER.APPROVED",order.tradeNo)).status,200);
  assert.equal(verifiedEvents,5);
  assert.equal(captureRequests,2);
  assert.equal(await balance(),7250);
  assert.deepEqual((await admin.stats()).paidAmounts,[{currency:"USD",amountCents:1055}]);

  const next=await admin.createOrder({amount:6.5,paymentType:"paypal"});
  const remote=orders.get(next.tradeNo);
  remote.status="COMPLETED";
  const unit=remote.purchase_units[0];
  unit.payments={captures:[{id:"CAPTURE"+next.tradeNo,status:"COMPLETED",amount:{currency_code:"USD",value:"0.01"}}]};
  assert.equal((await post("PAYMENT.CAPTURE.COMPLETED",next.tradeNo)).status,500);
  assert.equal((await db.getPaymentOrderByOutTradeNo(next.outTradeNo)).status,"pending");
  assert.equal(await balance(),7250);
  unit.payments.captures[0].amount=unit.amount;
  await payment.reconcilePendingPaymentOrders();
  assert.equal((await db.getPaymentOrderByOutTradeNo(next.outTradeNo)).status,"completed");
  assert.equal(await balance(),7900);

  await db.setSetting("storeEnabled","true");
  await runtime.insertAndGetId("hosts",{id:1,name:"paypal-host",ip:"127.0.0.1",userId:1,portRangeStart:20000,portRangeEnd:30000});
  await runtime.insertAndGetId("subscription_plans",{id:1,name:"paypal-plan",priceCents:650,currency:"CNY",durationDays:30,stockLimit:1,portCount:2,trafficLimit:1000000});
  await runtime.insertAndGetId("subscription_plan_hosts",{planId:1,hostId:1});
  const planOrder=await admin.createOrder({amount:999,paymentType:"paypal",planId:1,returnPath:"/store"});
  assert.equal(planOrder.amountCents,133);
  orders.get(planOrder.tradeNo).status="APPROVED";
  const [returnResponse, approvalResponse]=await Promise.all([browserReturn(planOrder),post("CHECKOUT.ORDER.APPROVED",planOrder.tradeNo)]);
  assert.equal(returnResponse.status,303);
  assert.equal(approvalResponse.status,200);
  const subscription=await db.getUserSubscriptionByPaymentOrderNo(planOrder.outTradeNo);
  assert.ok(subscription);
  const renewalOrder=await admin.createOrder({amount:1,paymentType:"paypal",planId:1,subscriptionId:subscription.id,returnPath:"/subscriptions"});
  orders.get(renewalOrder.tradeNo).status="APPROVED";
  assert.equal((await post("CHECKOUT.ORDER.APPROVED",renewalOrder.tradeNo)).status,200);
  assert.equal((await db.getPaymentOrderByOutTradeNo(renewalOrder.outTradeNo)).subscriptionId,subscription.id);
  const renewed=await db.getUserSubscriptionById(subscription.id);
  assert.ok(new Date(renewed.expiresAt).getTime() > new Date(subscription.expiresAt).getTime());
  assert.equal(await balance(),7900);
`));

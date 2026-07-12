import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildGmPayUrl, createGmPayOrder, gmPaySign, normalizeGmPayBase, normalizeGmPayHostedUrl, verifyGmPaySignature } from "./gmPay";

test("normalizes GM Pay roots and documented endpoint URLs", () => {
  assert.equal(normalizeGmPayBase("https://pay.example.com/"), "https://pay.example.com");
  assert.equal(
    normalizeGmPayBase("https://pay.example.com/base/payments/gmpay/v1/order/create-transaction"),
    "https://pay.example.com/base",
  );
  assert.equal(
    buildGmPayUrl("https://pay.example.com/base", "/payments/gmpay/v1/config"),
    "https://pay.example.com/base/payments/gmpay/v1/config",
  );
  assert.equal(normalizeGmPayBase("javascript:alert(1)"), "");
  assert.equal(normalizeGmPayHostedUrl("/cashier/GM100", "https://pay.example.com/base"), "https://pay.example.com/cashier/GM100");
  assert.throws(() => normalizeGmPayHostedUrl("javascript:alert(1)", "https://pay.example.com"), /收银台地址无效/);
});

test("GMPay request signature matches the upstream documentation vector", () => {
  const signature = gmPaySign({
    pid: "1000",
    order_id: "ORD202605230001",
    currency: "cny",
    token: "usdt",
    network: "tron",
    amount: 100,
    notify_url: "https://merchant.example/notify",
    redirect_url: "https://merchant.example/return",
    name: "VIP",
  }, "epusdt_secret_key");
  assert.equal(signature, "476412c422f4dd75c3d533f5c47a9cac");
});

test("GMPay callback verification includes numeric values and rejects changes", () => {
  const payload = {
    pid: "1000",
    trade_id: "TRADE100",
    order_id: "FWX100",
    amount: 100,
    actual_amount: 14.29,
    receive_address: "TAddress",
    token: "USDT",
    block_transaction_id: "0xabc",
    status: 2,
    signature: "",
  };
  payload.signature = gmPaySign(payload, "secret");
  assert.equal(verifyGmPaySignature(payload, "secret"), true);
  assert.equal(verifyGmPaySignature({ ...payload, amount: 101 }, "secret"), false);
  assert.equal(verifyGmPaySignature(payload, "wrong-secret"), false);
});

test("creates a hosted USDT order with a signed form request", async (t) => {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      assert.equal(req.url, "/payments/gmpay/v1/order/create-transaction");
      assert.match(String(req.headers["content-type"]), /^application\/x-www-form-urlencoded/);
      const params = Object.fromEntries(new URLSearchParams(raw));
      assert.equal(params.order_id, "FWX100");
      assert.equal(params.amount, "10.00");
      assert.equal(params.token, "usdt");
      assert.equal(params.network, "tron");
      assert.equal(verifyGmPaySignature(params, "secret"), true);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status_code: 200,
        message: "success",
        data: {
          trade_id: "GM100",
          order_id: "FWX100",
          amount: 10,
          actual_amount: 1.4,
          receive_address: "TAddress",
          token: "USDT",
          status: 1,
          expiration_time: 1_800_000_000,
          payment_url: "https://pay.example.com/pay/checkout-counter/GM100",
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await createGmPayOrder({
    apiBase: `http://127.0.0.1:${address.port}`,
    pid: "1000",
    secretKey: "secret",
    network: "tron",
  }, {
    outTradeNo: "FWX100",
    subject: "ForwardX",
    amountCents: 1000,
    notifyUrl: "https://panel.example.com/api/payment/webhook/gmpay",
    returnUrl: "https://panel.example.com/api/payment/return/gmpay",
  });
  assert.equal(result.tradeId, "GM100");
  assert.equal(result.actualAmount, 1.4);
  assert.equal(result.paymentUrl, "https://pay.example.com/pay/checkout-counter/GM100");
});

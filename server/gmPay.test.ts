import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import test from "node:test";
import { buildGmPayUrl, createGmPayOrder, gmPaySign, normalizeGmPayBase, normalizeGmPayHostedUrl, verifyGmPaySignature, type GmPaySignatureAlgorithm } from "./gmPay";

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

test("Epusdt v2 HMAC-SHA256 matches the upstream v2.0.0 Go fixed vector", () => {
  // GMWalletApp/epusdt v2.0.0: src/util/sign/sign_test.go.
  const params = { signature: "ignored", pid: "1000", empty: "", nil: null, name: "VIP", amount: 100 };
  assert.equal(gmPaySign(params, "test-secret", "hmac-sha256"), "ced9141fab53a83d1178f903e7c22d8a2a7033520f31e319934e92455a008b6c");
  assert.equal(gmPaySign(params, "test-secret", "md5"), "2203e5d2a13264c188f7fac194a632f8");
});

test("signature algorithms are strict and invalid or modified callbacks cannot downgrade", () => {
  for (const algorithm of ["md5", "hmac-sha256"] as const) {
    const params = { pid: "1000", amount: 1, status: 2, name: "中文 & VIP=1", signature: "" };
    params.signature = gmPaySign(params, "secret", algorithm);
    assert.equal(verifyGmPaySignature(params, "secret", algorithm), true);
    assert.equal(verifyGmPaySignature({ ...params, signature: params.signature.toUpperCase() }, "secret", algorithm), true);
    assert.equal(verifyGmPaySignature(params, "wrong-key", algorithm), false);
    assert.equal(verifyGmPaySignature({ ...params, amount: 100 }, "secret", algorithm), false);
    assert.equal(verifyGmPaySignature({ ...params, status: 1 }, "secret", algorithm), false);
    assert.equal(verifyGmPaySignature(params, "secret", algorithm === "md5" ? "hmac-sha256" : "md5"), false);
    for (const signature of ["", "g".repeat(params.signature.length), params.signature.slice(1), params.signature + "0"]) {
      assert.equal(verifyGmPaySignature({ ...params, signature }, "secret", algorithm), false);
    }
    assert.equal(verifyGmPaySignature({ ...params, amount: NaN }, "secret", algorithm), false);
    assert.equal(verifyGmPaySignature({ ...params, amount: {} as any }, "secret", algorithm), false);
    assert.equal(verifyGmPaySignature(params, "", algorithm), false);
  }
  assert.throws(() => gmPaySign({ amount: 1 }, "secret", "unknown" as GmPaySignatureAlgorithm), /签名方式无效/);
});

test("canonical numeric values match Go decimal formatting for small crypto amounts", () => {
  for (const [value, expected] of [[1e-7, "0.0000001"], [1.234e-7, "0.0000001234"], [-1e-7, "-0.0000001"], [1.23e21, "1230000000000000000000"], [0, "0"], [14.29, "14.29"]] as const) {
    const signature = crypto.createHmac("sha256", "secret").update(`amount=${expected}`).digest("hex");
    assert.equal(gmPaySign({ amount: value }, "secret", "hmac-sha256"), signature);
  }
});

for (const algorithm of ["md5", "hmac-sha256"] as const) test(`creates a hosted USDT order with a ${algorithm} signed form request`, async (t) => {
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
      const content = Object.keys(params).filter(key => key !== "signature" && params[key] !== "").sort().map(key => `${key}=${params[key]}`).join("&");
      const expected = algorithm === "md5" ? crypto.createHash("md5").update(content + "secret").digest("hex")
        : crypto.createHmac("sha256", "secret").update(content).digest("hex");
      assert.equal(params.signature, expected);
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
    // Omitting the setting remains backward-compatible with the old API.
    ...(algorithm === "hmac-sha256" ? { signatureAlgorithm: algorithm } : {}),
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

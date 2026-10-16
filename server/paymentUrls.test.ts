import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { importPaymentPrivateKey, importPaymentPublicKey, PaymentKeyConfigurationError, paymentOrderFailureMessage } from "./paymentCrypto";
import { PAYMENT_ERRORS } from "../shared/paymentErrors";
import {
  appendWxpayH5Redirect,
  buildPanelUrl,
  buildPaymentFrontendReturnUrl,
  buildPaymentProviderReturnUrl,
  buildPaymentWebhookUrl,
  normalizePaymentReturnPath,
  queryToStringRecord,
} from "./paymentUrls";

test("payment RSA keys support PKCS#1/PKCS#8 PEM and headerless DER without changing signatures", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const data = Buffer.from("app_id=test&method=alipay.trade.precreate");
  for (const type of ["pkcs1", "pkcs8"] as const) {
    const pem = pair.privateKey.export({ format: "pem", type }).toString();
    const bare = pair.privateKey.export({ format: "der", type }).toString("base64");
    for (const input of [pem, bare, pem.replace(/\n/g, "\\n"), "\n" + bare.match(/.{1,64}/g)!.join("\n") + "\n"]) {
      for (const provider of ["alipay", "wxpay"] as const) {
        const signature = crypto.sign("RSA-SHA256", data, importPaymentPrivateKey(input, provider));
        assert.equal(crypto.verify("RSA-SHA256", data, pair.publicKey, signature), true);
      }
    }
  }
  for (const type of ["pkcs1", "spki"] as const) {
    for (const input of [
      pair.publicKey.export({ format: "pem", type }).toString(),
      pair.publicKey.export({ format: "der", type }).toString("base64"),
    ]) {
      const signature = crypto.sign("RSA-SHA256", data, pair.privateKey);
      assert.equal(crypto.verify("RSA-SHA256", data, importPaymentPublicKey(input, "alipay"), signature), true);
    }
  }
  // Reproduce the old bug: labeling a bare PKCS#1 private key as PKCS#8.
  const barePkcs1 = pair.privateKey.export({ format: "der", type: "pkcs1" }).toString("base64");
  assert.throws(() => crypto.createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${barePkcs1}\n-----END PRIVATE KEY-----`));
});

test("payment key validation rejects wrong, truncated, encrypted and non-RSA keys with safe field-specific messages", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const invalidPrivateKeys = [
    "", "not a private key", "QUJDREVGRw==",
    pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    pair.publicKey.export({ format: "der", type: "pkcs1" }).toString("base64"),
    pair.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "test" }).toString(),
    ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ec.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  ];
  for (const provider of ["alipay", "wxpay"] as const) {
    for (const input of invalidPrivateKeys) {
      assert.throws(() => importPaymentPrivateKey(input, provider), (error: unknown) => {
        assert.ok(error instanceof PaymentKeyConfigurationError);
        assert.equal(error.message, PAYMENT_ERRORS[`${provider}PrivateKey`]);
        assert.doesNotMatch(error.message, /error:|DECODER|unsupported/);
        return true;
      });
    }
    for (const input of ["", "invalid", pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      pair.privateKey.export({ format: "der", type: "pkcs1" }).toString("base64"),
      ec.publicKey.export({ format: "pem", type: "spki" }).toString()]) {
      assert.throws(() => importPaymentPublicKey(input, provider), { message: PAYMENT_ERRORS[`${provider}PublicKey`] });
    }
  }
});

test("payment order failures hide arbitrary gateway details and classify key, timeout and network errors", () => {
  assert.equal(paymentOrderFailureMessage(new PaymentKeyConfigurationError("alipay", "PrivateKey")), PAYMENT_ERRORS.alipayPrivateKey);
  assert.equal(paymentOrderFailureMessage(new Error("error:1E08010C:DECODER routines::unsupported")), PAYMENT_ERRORS.keyConfiguration);
  assert.equal(paymentOrderFailureMessage(new Error("支付宝官方配置不完整")), PAYMENT_ERRORS.configuration);
  assert.equal(paymentOrderFailureMessage(Object.assign(new Error("timeout"), { name: "TimeoutError" })), PAYMENT_ERRORS.timeout);
  assert.equal(paymentOrderFailureMessage(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } })), PAYMENT_ERRORS.timeout);
  assert.equal(paymentOrderFailureMessage(new Error("fetch failed", { cause: { code: "ECONNREFUSED" } })), PAYMENT_ERRORS.network);
  assert.equal(paymentOrderFailureMessage(new Error("<html>gateway internals</html>")), PAYMENT_ERRORS.unavailable);
  assert.equal(paymentOrderFailureMessage(null), PAYMENT_ERRORS.unavailable);
});

test("payment return paths only accept known panel pages", () => {
  assert.equal(normalizePaymentReturnPath("/store"), "/store");
  assert.equal(normalizePaymentReturnPath(["/subscriptions", "/wallet"]), "/subscriptions");
  assert.equal(normalizePaymentReturnPath("https://evil.example/"), "/wallet");
  assert.equal(normalizePaymentReturnPath("//evil.example"), "/wallet");
  assert.equal(normalizePaymentReturnPath("/unknown", "/payments"), "/payments");
});

test("payment URLs preserve a configured reverse-proxy base path", () => {
  assert.equal(
    buildPaymentWebhookUrl("https://panel.example.com/forwardx/", "easypay"),
    "https://panel.example.com/forwardx/api/payment/webhook/easypay",
  );
  assert.equal(
    buildPanelUrl("https://panel.example.com/forwardx?old=1#hash", "/wallet", { payment_return: "stripe" }),
    "https://panel.example.com/forwardx/wallet?payment_return=stripe",
  );
});

test("provider return URL carries the order and constrained destination", () => {
  const result = new URL(buildPaymentProviderReturnUrl({
    panelUrl: "https://panel.example.com",
    provider: "stripe",
    returnPath: "/store",
    outTradeNo: "FWX123",
  }));
  assert.equal(result.pathname, "/api/payment/return/stripe");
  assert.equal(result.searchParams.get("return_to"), "/store");
  assert.equal(result.searchParams.get("out_trade_no"), "FWX123");
});

test("frontend return URL forwards only expected payment state", () => {
  const result = new URL(buildPaymentFrontendReturnUrl({
    panelUrl: "https://panel.example.com/base",
    provider: "alipay",
    returnPath: "/subscriptions",
    outTradeNo: "FWX456",
    cancelled: true,
  }));
  assert.equal(result.pathname, "/base/subscriptions");
  assert.equal(result.searchParams.get("payment_return"), "alipay");
  assert.equal(result.searchParams.get("out_trade_no"), "FWX456");
  assert.equal(result.searchParams.get("payment_cancelled"), "1");
});

test("WeChat H5 redirect is encoded and keeps provider query parameters", () => {
  const redirect = "https://panel.example.com/api/payment/return/wxpay?return_to=%2Fwallet&out_trade_no=FWX789";
  const result = new URL(appendWxpayH5Redirect("https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=abc", redirect));
  assert.equal(result.searchParams.get("prepay_id"), "abc");
  assert.equal(result.searchParams.get("redirect_url"), redirect);
});

test("EasyPay query parameters are normalized for GET notifications", () => {
  assert.deepEqual(queryToStringRecord({
    out_trade_no: " FWX123 ",
    sign: ["abc", "ignored"],
    empty: "",
    nested: { value: "ignored" },
  }), {
    out_trade_no: "FWX123",
    sign: "abc",
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendWxpayH5Redirect,
  buildPanelUrl,
  buildPaymentFrontendReturnUrl,
  buildPaymentProviderReturnUrl,
  buildPaymentWebhookUrl,
  normalizePaymentReturnPath,
  queryToStringRecord,
} from "./paymentUrls";

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

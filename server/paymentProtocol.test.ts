import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { alipayTimestamp, fetchPaymentText, normalizePaymentLink, rawJsonMember, verifyAlipayResponse } from "./paymentProtocol";

test("Alipay timestamps use Beijing time across midnight regardless of server timezone", () => {
  assert.equal(alipayTimestamp(new Date("2026-10-17T18:02:03Z")), "2026-10-18 02:02:03");
});

test("EasyPay root-relative links are resolved without rewriting opaque QR payloads", () => {
  assert.equal(normalizePaymentLink("/pay?id=1", "https://gateway.test/base"), "https://gateway.test/pay?id=1");
  assert.equal(normalizePaymentLink("weixin://wxpay/bizpayurl?pr=abc", "https://gateway.test"), "weixin://wxpay/bizpayurl?pr=abc");
  assert.equal(normalizePaymentLink("opaque-token", "https://gateway.test"), "opaque-token");
  assert.equal(normalizePaymentLink(" ", "https://gateway.test"), null);
});

test("Alipay response verification uses exact JSON bytes including whitespace and escapes", () => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const content = String.raw`{ "code":"10000", "nested":[{"text":"escaped \"quote\" and }, ]"}], "subject":"\u4e2d\u6587" }`;
  const sign = crypto.sign("RSA-SHA256", Buffer.from(content), pair.privateKey).toString("base64");
  const raw = JSON.stringify({ sign, unrelated: "x" }).slice(0, -1) + ', "alipay_trade_query_response": ' + content + " }";
  assert.equal(rawJsonMember(raw, "alipay_trade_query_response"), content);
  assert.equal(verifyAlipayResponse(raw, "alipay_trade_query_response", key), true);
  assert.equal(verifyAlipayResponse(raw.replace("10000", "20000"), "alipay_trade_query_response", key), false);
  assert.equal(verifyAlipayResponse(JSON.stringify({alipay_trade_query_response:{code:"10000"}}), "alipay_trade_query_response", key), false);
  assert.throws(() => rawJsonMember('{"sign":"a","sign":"b","response":{}}', "response"), /Duplicate/);
  assert.throws(() => rawJsonMember('{"a":1', "a"));
});

test("payment request timeout includes a stalled response body", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => ({
      text: () => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    }) as Response;
    await assert.rejects(fetchPaymentText("https://unused.test", {}, 10), error => error instanceof Error && error.name === "AbortError");
  } finally { globalThis.fetch = previous; }
});

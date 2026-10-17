import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { paymentCheckoutState, paymentPageUrl, paymentQrContent } from "./paymentCheckout";

test("native WeChat links are QR payloads, never web page links", () => {
  const native = "weixin://wxpay/bizpayurl?pr=abc";
  assert.equal(paymentPageUrl(native), null);
  assert.equal(paymentQrContent({outTradeNo:"test",payUrl:native}), native);
  assert.equal(paymentQrContent({outTradeNo:"test",payUrl:"https://gateway.test/pay"}), null);
  assert.equal(paymentPageUrl("javascript:alert(1)"), null);
  assert.equal(paymentPageUrl("//gateway.test"), null);
  assert.equal(paymentPageUrl("https://user:secret@gateway.test"), null);
});

test("paid and processing are not treated as successful fulfillment", () => {
  for (const status of ["paid", "processing"]) assert.equal(paymentCheckoutState(status), "processing");
  assert.equal(paymentCheckoutState("completed"), "completed");
  for (const status of ["failed", "expired", "cancelled"]) assert.equal(paymentCheckoutState(status), "closed");
  assert.equal(paymentCheckoutState("pending"), "pending");
});

test("all payment surfaces share checkout and avoid asynchronous popup opening", () => {
  for (const page of ["Wallet", "Subscriptions", "Store", "Payments"]) {
    const source = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
    assert.match(source, /<PaymentCheckoutDialog\b/, page);
    assert.doesNotMatch(source, /window\.open\(/, page);
  }
  const source = readFileSync("client/src/components/PaymentCheckoutDialog.tsx", "utf8");
  assert.match(source, /enabled: !!order/);
  assert.match(source, /refetchIntervalInBackground: false/);
  assert.match(source, /active = false/);
});

test("orders live in paginated billing, not duplicated in payment configuration", () => {
  const payments = readFileSync("client/src/pages/Payments.tsx", "utf8");
  assert.doesNotMatch(payments, /payment\.listOrders|订单记录/);
  const billing = readFileSync("client/src/pages/Billing.tsx", "utf8");
  assert.match(billing, /trpc\.billing\.ledgerPage\.useQuery/);
  assert.match(billing, /trpc\.billing\.listTransactionsPage\.useQuery/);
  assert.doesNotMatch(billing, /trpc\.billing\.(ledger|listTransactions)\.useQuery/);
  for (const name of ["ledger", "transaction", "subscription", "redemption", "discount"]) {
    assert.match(billing, new RegExp('<PersistentPagination pagination=\\{' + name + 'Pagination\\}'));
  }
  assert.equal((billing.match(/<PaymentLedgerDetails item=\{item\}/g) || []).length, 2, "mobile and desktop retain diagnostics");
  assert.match(billing, /item\.failureReason/);
  assert.match(billing, /ledgerPageRequest\.setPage\(1\)/, "user filtering restarts pagination");
});

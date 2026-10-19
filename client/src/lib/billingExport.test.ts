import assert from "node:assert/strict";
import test from "node:test";
import { requestBillingExport } from "./billingExport";

const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
test("billing export sends filters and session credentials without page limits", async () => {
  const result = await requestBillingExport(42, undefined, async (input, init) => {
    assert.equal(input, "/api/billing/ledger.xlsx?userId=42");
    assert.equal(init?.credentials, "include");
    return new Response("xlsx bytes", { headers: { "content-type": mime, "content-disposition": 'attachment; filename="forwardx-billing-user-42.xlsx"' } });
  });
  assert.equal(await result.blob.text(), "xlsx bytes");
  assert.equal(result.filename, "forwardx-billing-user-42.xlsx");
});

test("native exports use the saved panel and bearer session; errors never become spreadsheets", async () => {
  const controller = new AbortController();
  await requestBillingExport(undefined, controller.signal, async (input, init) => {
    assert.equal(input, "https://panel.example/api/billing/ledger.xlsx");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    assert.equal(init?.signal, controller.signal);
    return new Response("xlsx bytes", { headers: { "content-type": mime } });
  }, { isNative: true, getPanelUrl: () => "https://panel.example", getToken: () => "test-token" } as never);
  await assert.rejects(requestBillingExport(undefined, undefined, async () => new Response('{"error":"导出繁忙，请稍后重试"}', { status: 429 })), /导出繁忙/);
  await assert.rejects(requestBillingExport(undefined, undefined, async () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } })), /账单导出失败/);
});

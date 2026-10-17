import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { buildOperationsFinanceCharts, type FinanceChartData } from "@/lib/operationsFinanceCharts";
import OperationsFinanceCharts from "./OperationsFinanceCharts";
import OperationsDonutChart from "./OperationsDonutChart";
import { operationsMoney } from "./OperationsFinanceSummary";

const data: FinanceChartData = {
  receipts: [
    { currency: "CNY", orderType: "plan", amountCents: 7500, count: 3 },
    { currency: "CNY", orderType: "plan", amountCents: 1500, count: 1 },
    { currency: "CNY", orderType: "balance", amountCents: 3000, count: 1 },
    { currency: "USD", orderType: "balance", amountCents: 900, count: 2 },
    { currency: "CNY", orderType: "test", amountCents: 99999, count: 9 },
  ],
  balances: [
    { type: "purchase", creditCents: 0, debitCents: 6000 },
    { type: "traffic_addon_purchase", creditCents: 0, debitCents: 3000 },
    { type: "traffic_billing", creditCents: 0, debitCents: 1000 },
    { type: "payment", creditCents: 3000, debitCents: 0 },
    { type: "admin_adjust", creditCents: 0, debitCents: 2000 },
    { type: "admin_recharge", creditCents: 7000, debitCents: 0 },
  ],
  orders: [{ status: "failed", count: 1 }, { status: "pending", count: 2 }, { status: "completed", count: 7 }],
};

test("finance charts aggregate receipts per currency and never mix receipts with balance spending", () => {
  const model = buildOperationsFinanceCharts(data);
  assert.deepEqual(model.receipts.map(row => [row.currency, row.count, row.items.map(item => item.value)]), [
    ["CNY", 5, [9000, 3000]], ["USD", 2, [0, 900]],
  ]);
  assert.deepEqual(model.consumption.map(item => [item.id, item.value]), [
    ["purchase", 6000], ["traffic_addon_purchase", 3000], ["traffic_billing", 1000],
  ]);
  assert.deepEqual(model.orders.map(item => [item.id, item.value]), [["completed", 7], ["pending", 2], ["failed", 1]]);
});

test("chart states retain semantic colors, aggregate duplicates and guard invalid values", () => {
  const model = buildOperationsFinanceCharts({ receipts: [], balances: [
    { type: "purchase", creditCents: 0, debitCents: -30 },
    { type: "traffic_billing", creditCents: 0, debitCents: NaN },
  ], orders: [{ status: "failed", count: 2 }, { status: "failed", count: 3 }, { status: "future", count: 1 }, { status: "pending", count: Infinity }] });
  assert.deepEqual(model.consumption.map(item => item.value), [0, 0, 0]);
  const failed = model.orders.find(item => item.id === "failed")!;
  assert.equal(failed.value, 5);
  assert.equal(failed.color, buildOperationsFinanceCharts(data).orders.find(item => item.id === "failed")!.color);
  assert.equal(model.orders.find(item => item.id === "future")!.label, "未知");
  assert.equal(model.orders.find(item => item.id === "pending")!.value, 0);
});

test("static ring sectors and textual legends use the same denominator", () => {
  const html = renderToStaticMarkup(<OperationsDonutChart title="Test chart" items={[
    { id: "one", label: "One", value: 75, color: "#3b82f6" },
    { id: "two", label: "Two", value: 25, color: "#14b8a6" },
  ]} formatValue={String} />);
  assert.match(html, /stroke-dasharray="75 25"/);
  assert.match(html, /stroke-dasharray="25 75"/);
  assert.match(html, /stroke-dashoffset="-75"/);
  assert.match(html, /75%/);
  assert.match(html, /25%/);
  assert.match(html, /<ul[^>]*aria-label="Test chart"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /animate|<animate|NaN|Infinity/);
});

test("empty and single-category charts never invent shares or invalid SVG sectors", () => {
  const empty = renderToStaticMarkup(<OperationsDonutChart title="Empty" items={[
    { id: "zero", label: "Zero", value: 0, color: "#3b82f6" },
  ]} formatValue={String} />);
  assert.equal((empty.match(/<circle /g) || []).length, 1, "neutral track only");
  assert.match(empty, /0%/);
  assert.doesNotMatch(empty, /stroke-dasharray|NaN|Infinity/);
  const single = renderToStaticMarkup(<OperationsDonutChart title="Single" items={[
    { id: "only", label: "Only", value: 100, color: "#3b82f6" },
  ]} formatValue={String} />);
  assert.match(single, /stroke-dasharray="100 0"/);
  assert.match(single, /100%/);
});

test("finance charts render three responsive panels, accessible labels and preserved adjustments in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const html = renderToStaticMarkup(<OperationsFinanceCharts data={data} formatMoney={operationsMoney} />);
      assert.equal((html.match(/<section /g) || []).length, 3);
      assert.equal((html.match(/<svg viewBox="0 0 128 128"/g) || []).length, 3);
      assert.match(html, /xl:grid-cols-3/);
      assert.match(html, /xl:flex-col 2xl:flex-row/);
      assert.match(html, /120\.00/);
      assert.match(html, /100\.00/);
      assert.match(html, /-.*20\.00/);
      assert.match(html, /75%/);
      assert.match(html, /60%/);
      assert.match(html, /70%/);
      assert.match(html, language === "en" ? /aria-label="Payment currency"/ : /aria-label="支付币种"/);
      assert.equal(/\p{Script=Han}/u.test(html), language === "zh-CN");
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("payment chart falls back to an available currency after filters remove CNY", () => {
  const html = renderToStaticMarkup(<OperationsFinanceCharts data={{ ...data, receipts: data.receipts.filter(row => row.currency === "USD") }} formatMoney={operationsMoney} />);
  assert.match(html, /USD/);
  assert.match(html, /9\.00/);
  assert.doesNotMatch(html, /75%|120\.00/);
  const empty = renderToStaticMarkup(<OperationsFinanceCharts data={{ receipts: [], balances: [], orders: [] }} formatMoney={operationsMoney} />);
  assert.equal((empty.match(/<circle /g) || []).length, 3);
  assert.doesNotMatch(empty, /NaN|Infinity/);
});

test("charts reuse summary data without network calls, chart runtimes or animations", () => {
  for (const file of ["OperationsFinanceCharts", "OperationsDonutChart"]) {
    const source = readFileSync(`client/src/components/${file}.tsx`, "utf8");
    assert.doesNotMatch(source, /useQuery|fetch\(|ResizeObserver|recharts|requestAnimationFrame|animate-/);
  }
  const summary = readFileSync("client/src/components/OperationsFinanceSummary.tsx", "utf8");
  assert.match(summary, /<OperationsFinanceCharts data=\{data\} formatMoney=\{operationsMoney\}/);
});

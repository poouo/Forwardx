import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ArrowDownToLine } from "lucide-react";
import { SummaryMetricCard } from "./SummaryMetricCard";

test("overview metrics use colorful icons, static values and opt-in hover in every semantic tone", () => {
  for (const tone of ["sky", "emerald", "violet", "amber"] as const) {
    const html = renderToStaticMarkup(<SummaryMetricCard title="Traffic" value="36.26 GiB" hint="Selected range" icon={ArrowDownToLine} tone={tone} />);
    assert.equal((html.match(new RegExp(`from-${tone}-500 to-${tone}-600`, "g")) || []).length, 2);
    assert.match(html, /h-5 w-5 text-white/);
    assert.match(html, /h-10 w-10 shrink-0/);
    assert.match(html, /pearl-hover-card/);
    assert.match(html, /36\.26 GiB/);
    assert.match(html, /Selected range/);
    assert.match(html, /overflow-wrap:anywhere/);
    assert.doesNotMatch(html, /stagger-card|forwardx-stat-value|role="button"|backdrop-blur|hoverable=/);
  }
  const compact = renderToStaticMarkup(<SummaryMetricCard title="Balance" value="¥12" icon={ArrowDownToLine} tone="sky" compact />);
  assert.match(compact, /text-xl/);
});

test("operations and finance both use the shared colored overview cards without changing data queries", () => {
  const overview = readFileSync("client/src/pages/Operations.tsx", "utf8");
  const finance = readFileSync("client/src/components/OperationsFinanceSummary.tsx", "utf8");
  for (const source of [overview, finance]) {
    assert.match(source, /<SummaryMetricCard/);
    for (const tone of ["sky", "emerald", "violet", "amber"]) assert.match(source, new RegExp(`tone:\\s*"${tone}"`));
  }
  assert.doesNotMatch(overview, /size-8 text-primary\/60/);
  assert.match(finance, /summary\.isError \? "—" : card.value/);
});

test("payment status and paid amount icons stay colorful independently of the theme primary color", () => {
  const source = readFileSync("client/src/pages/Payments.tsx", "utf8");
  const cards = source.match(/<PaymentStatCard\b[\s\S]*?\/>/g) || [];
  assert.equal(cards.length, 4);
  assert.match(cards[0], /tone=\{form.enabled \? "text-emerald-600 dark:text-emerald-400" : "text-sky-600 dark:text-sky-400"\}/);
  assert.match(cards[1], /tone="text-violet-600 dark:text-violet-400"/);
  assert.doesNotMatch(cards.join(""), /tone="text-primary"|text-muted-foreground/);
});

test("billing overview keeps status text on one line and reserves a separate row for toggles", () => {
  const source = readFileSync("client/src/pages/Billing.tsx", "utf8");
  const cards = source.slice(source.indexOf("function BillingStatCard("), source.indexOf("function normalizeCodeInput("));
  const toggle = cards.slice(cards.indexOf("function BillingToggleCard("));
  assert.match(source, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,12rem\),1fr\)\)\]/);
  assert.doesNotMatch(cards, /break-words/);
  assert.match(toggle, /className="truncate whitespace-nowrap text-2xl/);
  assert.match(toggle, /className="mt-2 flex min-w-0 items-center justify-between gap-3"[\s\S]*?<OptimisticSwitch/);
  assert.match(toggle, /<OptimisticSwitch[^>]*aria-label=\{title\}/);
  assert.equal((cards.match(/title=\{title\}/g) || []).length, 2);
});

test("payment enable switch lives in the status card and retains explicit configuration saving", () => {
  const source = readFileSync("client/src/pages/Payments.tsx", "utf8");
  const statusCard = source.slice(source.indexOf('<PaymentStatCard'), source.indexOf('cacheKey="payments.paidAmount"'));
  const basicTab = source.slice(source.indexOf('<TabsContent value="basic"'), source.indexOf('<TabsContent value="easypay"'));
  assert.match(statusCard, /action=\{[\s\S]*<Switch[\s\S]*checked=\{form\.enabled\}/);
  assert.match(statusCard, /onCheckedChange=\{\(enabled\) => setForm\(\(prev\) => \(\{ \.\.\.prev, enabled \}\)\)\}/);
  assert.match(statusCard, /disabled=\{isLoading \|\| updateConfig\.isPending\}/);
  assert.match(statusCard, /aria-label=\{translateText\("启用支付功能"\)\}/);
  assert.match(statusCard, /title=\{translateText\("关闭后无法下单"\)\}/);
  assert.doesNotMatch(basicTab, /启用支付功能|checked=\{form\.enabled\}/);
  assert.match(source, /<Button onClick=\{save\}/);
});

test("missing overview and product hover treatments are covered without moving sortable tunnel cards", () => {
  const checks = [
    ["client/src/pages/Affiliates.tsx", /<Card key=\{label\} hoverable/],
    ["client/src/pages/Home.tsx", /<Card enterIndex=\{index\} interactive hoverable/],
    ["client/src/pages/SupportTickets.tsx", /pearl-hover-card min-w-0 rounded-xl/],
    ["client/src/pages/Plans.tsx", /pearl-hover-card rounded-lg border border-border/],
    ["client/src/pages/Store.tsx", /pearl-hover-card pearl-store-plan/],
    ["client/src/pages/Subscriptions.tsx", /<Card key=\{sub.id\} hoverable/],
    ["client/src/components/LatencyStabilityStats.tsx", /pearl-hover-card latency-stat-card/],
  ] as const;
  for (const [file, pattern] of checks) {
    const source = readFileSync(file, "utf8");
    assert.match(source, pattern);
  }
  for (const file of ["Billing", "Payments", "Hosts", "HostMonitor", "Users", "Rules"]) {
    assert.match(readFileSync(`client/src/pages/${file}.tsx`, "utf8"), /<Card hoverable className=/);
  }
  const tunnels = readFileSync("client/src/pages/Tunnels.tsx", "utf8");
  assert.equal((tunnels.match(/interactive=\{!isDragging\}/g) || []).length, 2);
  assert.doesNotMatch(tunnels, /<Card[^>]*hoverable/);
});

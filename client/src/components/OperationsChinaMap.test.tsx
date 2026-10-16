import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import OperationsDateFilter from "./OperationsDateFilter";
import OperationsSourceList from "./OperationsSourceList";
import DatePickerInput from "./DatePickerInput";
import { operationsMoney, operationsLedgerLabel } from "./OperationsFinanceSummary";
import { renderToStaticMarkup } from "react-dom/server";
import { setLanguagePreference, getLanguagePreference, initializeLanguage } from "@/i18n";
import OperationsChinaMap, { geometryPath, sourceUsage, provinceColor, PROVINCE_COLORS } from "./OperationsChinaMap";

test("local province asset decodes all 34 regions into bounded nonempty SVG geometry", () => {
  const asset = JSON.parse(fs.readFileSync("client/public/china-provinces.json", "utf8"));
  assert.equal(asset.features.length, 34);
  for (const feature of asset.features) {
    const path = geometryPath(feature);
    assert.match(path, /^M/);
    assert.ok(path.length > 10);
    assert.doesNotMatch(path, /NaN|Infinity|undefined/);
    for (const value of path.match(/-?\d+\.\d+/g) || []) assert.ok(Number(value) > -10 && Number(value) < 800, `${feature.properties.name}: ${value}`);
  }
});

test("date filters use built-in calendars with separate labels and wrapping in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<OperationsDateFilter from="2026-10-15" to="2026-10-16" minimum="2026-09-17" today="2026-10-16"
        onFromChange={() => {}} onToChange={() => {}} onApply={() => {}} onToday={() => {}} onMonth={() => {}} />);
      assert.match(html, /grid-cols-1/);
      assert.match(html, /sm:grid-cols-2/);
      assert.match(html, /flex-wrap/);
      for (const id of ["operations-from", "operations-to"]) {
        assert.match(html, new RegExp(`<label(?=[^>]*for="${id}")(?=[^>]*class="[^"]*block[^"]*")[^>]*>[^<]+</label><div[^>]*><button[^>]*id="${id}"`));
      }
      assert.doesNotMatch(html, /type="date"/);
      assert.doesNotMatch(html, />清除<|>Clear</);
      assert.equal(/\p{Script=Han}/u.test(html), language === "zh-CN");
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("built-in calendar disables dates and navigation outside the operations range", () => {
  const html = renderToStaticMarkup(<DatePickerInput id="test-date" value="2026-10-16" min="2026-10-15" max="2026-10-16" allowClear={false} onChange={() => {}} />);
  const days = [...html.matchAll(/<button([^>]*)>(\d+)<\/button>/g)];
  assert.equal(days.length, 42);
  assert.equal(days.filter(([, attributes]) => !attributes.includes("disabled=")).length, 2);
  assert.match(html, /aria-label="[^"]+"/);
});

test("source list has bounded height, sortable rankings and ten-row page navigation in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const html = renderToStaticMarkup(<OperationsSourceList rows={Array.from({length:10}, (_, i) => ({ip:`192.0.2.${i+1}`,rules:1,bytesIn:100,bytesOut:200,knownSamples:1,unknownSamples:0}))} total={84} page={1} sort="traffic" loading={false} onPageChange={() => {}} onSortChange={() => {}} onSelectIp={() => {}} />);
      assert.equal((html.match(/<tbody>/g) || []).length, 1);
      assert.equal((html.match(/<tr/g) || []).length, 11);
      assert.match(html, /max-h-\[28rem\]/);
      assert.match(html, /overflow-auto/);
      assert.match(html, language === "en" ? /Page 2 of 9/ : /第 2 页，共 9 页/);
      assert.equal(/\p{Script=Han}/u.test(html), language === "zh-CN");
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("source traffic renders unknown instead of zero and supports English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    assert.equal(sourceUsage({ bytesIn: 0, bytesOut: 0, knownSamples: 0, unknownSamples: 1 }), "Unavailable");
    assert.equal(sourceUsage({ bytesIn: 100, bytesOut: 100, knownSamples: 1, unknownSamples: 1 }), "200 B *");
    const html = renderToStaticMarkup(<OperationsChinaMap provinces={[]} unmappedIps={4} />);
    assert.match(html, /Sources in China/);
    assert.match(html, /Unlocated sources/);
    assert.match(html, /4 IP/);
    assert.match(html, /Tap a region for traffic and top IPs/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("province heat uses distinct colors, not theme monochrome", () => {
  assert.equal(provinceColor(0,15),"var(--muted)");
  assert.equal(provinceColor(1,15),PROVINCE_COLORS[0]);
  assert.equal(provinceColor(15,15),PROVINCE_COLORS[4]);
  assert.ok(new Set(Array.from({length:15},(_,i)=>provinceColor(i+1,15))).size>=4);
});

test("finance amounts preserve currency and ledger types are translated in English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    assert.match(operationsMoney(12345, "CNY"), /123\.45/);
    assert.match(operationsMoney(-500, "USD"), /-.*5\.00/);
    assert.equal(operationsMoney(500, "invalid-currency"), "5.00 invalid-currency");
    for (const type of ["payment", "purchase", "traffic_addon_purchase", "traffic_billing", "admin_recharge", "admin_adjust", "redeem", "affiliate_transfer", "unrecognized"]) {
      const label = operationsLedgerLabel("balance", type);
      assert.ok(label.length > 0);
      assert.doesNotMatch(label, /\p{Script=Han}/u);
    }
    assert.doesNotMatch(operationsLedgerLabel("payment", "plan"), /\p{Script=Han}/u);
    assert.notEqual(operationsLedgerLabel("payment", "plan"), operationsLedgerLabel("balance", "purchase"));
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

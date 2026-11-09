import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import OperationsPeriodSummary from "./OperationsPeriodSummary";
import HostViewSelect from "./hosts/HostViewSelect";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";

test("operations period describes the applied single day or range in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const day = renderToStaticMarkup(<OperationsPeriodSummary from="2026-11-09" to="2026-11-09" />);
      const range = renderToStaticMarkup(<OperationsPeriodSummary from="2026-10-11" to="2026-11-09" />);
      assert.equal((day.match(/2026\/11\/09/g) || []).length, 1);
      assert.match(range, /2026\/10\/11 – 2026\/11\/09/);
      assert.doesNotMatch(day, /最近 30 天|Last 30 days/);
      if (language === "en") assert.doesNotMatch(day + range, /\p{Script=Han}/u);
      for (const value of ["compact-card", "card", "table", "map", "flat-map"] as const) {
        const view = renderToStaticMarkup(<HostViewSelect value={value} onChange={() => {}} />);
        assert.match(view, /role="combobox"/);
        assert.match(view, /aria-label="(?:视图|View)"/);
        assert.match(view, /h-4 w-4 shrink-0/);
        if (language === "en") assert.doesNotMatch(view, /\p{Script=Han}/u);
      }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
  const operations = readFileSync("client/src/pages/Operations.tsx", "utf8");
  assert.match(operations, /<OperationsPeriodSummary \{\.\.\.dates\} \/>/);
  assert.match(operations, /const scopedDates = \{ \.\.\.dates, userId: scopeUserId \}/);
  assert.match(operations, /实时状态，不随日期范围变化/);
});

test("shared metrics and toolbars preserve readability without animating layout", () => {
  const css = readFileSync("client/src/styles/pearl.css", "utf8");
  assert.match(css, /\.pearl-metric-label[^}]+font-size: \.75rem/);
  assert.match(css, /\.pearl-metric-value[^}]+font-variant-numeric: tabular-nums/);
  assert.match(css, /\.pearl-toolbar :is\([^}]+height: 36px/);
  assert.match(css, /@media \(max-width: 767px\) and \(pointer: coarse\)[\s\S]+height: 44px/);
  const feedback = css.match(/--pearl-card-feedback-transition:([^;]+);/)?.[1];
  assert.ok(feedback);
  assert.doesNotMatch(feedback, /(?:min-)?height|width|margin/);
  const rules = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const start = rules.indexOf("{/* 转发流量汇总 */}");
  const summary = rules.slice(start, rules.indexOf("{isOwnRuleScope &&", start));
  assert.doesNotMatch(summary, /text-\[(?:8|9|10)px\]|gradient|stagger-card/);
  assert.equal((summary.match(/fallbackCacheKeys=/g) || []).length, 6);
  assert.equal((summary.match(/mirrorCacheKeys=/g) || []).length, 6);
  const hosts = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(hosts, /<HostViewSelect value=\{viewMode\} onChange=\{handleViewModeChange\}/);
  assert.match(hosts, /sm:w-auto sm:min-w-40/);
});

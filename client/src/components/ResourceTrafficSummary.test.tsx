import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceTrafficSummary } from "./ResourceTrafficSummary";

test("resource traffic cards show total and both directions with an explicit accounting scope", () => {
  const html = renderToStaticMarkup(<ResourceTrafficSummary summary={{bytesIn:1024,bytesOut:2048,totalBytes:3072,ruleCount:2}} />);
  assert.match(html, /累计流量/);
  assert.match(html, /3\.00 KB/);
  assert.match(html, /入向.*1\.00 KB/);
  assert.match(html, /出向.*2\.00 KB/);
  assert.match(html, /不按倍率折算/);
  assert.match(html, /flex-wrap/);
  assert.match(html, /引用规则/);
  assert.match(html, />2<\/span>/);
  assert.match(html, /逻辑规则去重/);
});

test("compact resource totals retain directional details and empty resources show zero", () => {
  const html = renderToStaticMarkup(<ResourceTrafficSummary compact summary={{bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}} />);
  assert.equal((html.match(/0 B/g) || []).length,3);
  assert.match(html,/入向/);
  assert.match(html,/出向/);
  assert.match(html,/>0<\/span>/);
  const unavailable = renderToStaticMarkup(<ResourceTrafficSummary />);
  assert.doesNotMatch(unavailable,/0 B/);
  assert.match(unavailable,/—/);
});

test("resource summaries can omit a duplicate count and translate rule scope", async () => {
  const { getLanguagePreference, setLanguagePreference, initializeLanguage } = await import("../i18n");
  const previous = getLanguagePreference();
  const summary = {bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:4};
  assert.doesNotMatch(renderToStaticMarkup(<ResourceTrafficSummary summary={summary} showRuleCount={false} />), /引用规则/);
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<ResourceTrafficSummary summary={summary} compact />);
    assert.match(html,/Referenced Rules/);
    assert.match(html,/unique logical rules/);
    assert.doesNotMatch(html,/\p{Script=Han}/u);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

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
});

test("compact resource totals retain directional details and empty resources show zero", () => {
  const html = renderToStaticMarkup(<ResourceTrafficSummary compact summary={{bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:0}} />);
  assert.equal((html.match(/0 B/g) || []).length,3);
  assert.match(html,/入向/);
  assert.match(html,/出向/);
  const unavailable = renderToStaticMarkup(<ResourceTrafficSummary />);
  assert.doesNotMatch(unavailable,/0 B/);
  assert.match(unavailable,/—/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { newRuleLimitsForm, ruleLimitsPayload, RuleLimitsForm } from "./RuleLimitsForm";
import { RuleUsageSummary } from "./RuleUsageSummary";

test("rule limits start collapsed, unlimited and timestamped now", () => {
  const before = Date.now();
  const value = newRuleLimitsForm();
  const payload = ruleLimitsPayload(value);
  assert.ok(payload.createdAt.getTime() >= before - 1000);
  assert.equal(payload.expiresAt, null);
  assert.equal(payload.rateLimitMbps, 0);
  assert.equal(payload.trafficLimit, 0);
  const html = renderToStaticMarkup(<RuleLimitsForm value={value} onChange={() => {}} />);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /Mbps/); assert.match(html, /GiB/);
  assert.match(html, /type="time"/);
  assert.match(html, /管理员可为本人或其他用户的规则设置独立限额/);
});
test("date and time fields round-trip existing rule policy without truncating days or quotas", () => {
  const createdAt = new Date(2026, 9, 7, 13, 22, 31);
  const expiresAt = new Date(2026, 10, 7, 18, 59, 37);
  const quota = 123456789;
  const value = newRuleLimitsForm({ createdAt, expiresAt, trafficMode: "max", trafficLimit: quota, rateLimitMbps: 15 });
  const payload = ruleLimitsPayload(value);
  assert.equal(payload.createdAt.getTime(), createdAt.getTime());
  assert.equal(payload.expiresAt?.getTime(), expiresAt.getTime());
  assert.equal(payload.trafficLimit, quota); assert.equal(payload.trafficMode, "max");
  assert.equal(ruleLimitsPayload({ ...value, expiresDate: "" }).expiresAt, null);
  assert.throws(() => ruleLimitsPayload({ ...value, speed: "1.5" }));
  assert.throws(() => ruleLimitsPayload({ ...value, quota: "-1" }));
  assert.throws(() => ruleLimitsPayload({ ...value, expiresDate: "2026-01-01" }));
  assert.throws(() => ruleLimitsPayload({ ...value, createdTime: "25:00" }));
  assert.throws(() => ruleLimitsPayload({ ...value, createdDate: "" }));
});

test("user-facing usage matches quota enforcement and contains no write controls", () => {
  const rule = { adminManaged: true, trafficLimit: 1024, quotaUsedIn: 600, quotaUsedOut: 500 };
  const render = (data: any) => renderToStaticMarkup(<RuleUsageSummary rule={data} />);
  assert.equal(render({}), "");
  const both = render({ ...rule, trafficMode: "both" });
  assert.match(both, /1.07 KiB/);
  assert.match(both, /aria-valuenow="100"/);
  assert.match(both, /剩余 0 B/);
  assert.doesNotMatch(both, /<button|<input/);
  assert.match(render({ ...rule, trafficMode: "max" }), /已用 600 B/);
  assert.match(render({ ...rule, trafficMode: "outbound" }), /已用 500 B/);
  assert.match(render({ ...rule, trafficLimit: 0 }), /额度 不限/);
  assert.match(render({ adminManaged: true }), /已用 —/);
  // Logical quota counters take priority over graph counters that may reset.
  assert.match(renderToStaticMarkup(<RuleUsageSummary rule={rule} totals={{ bytesIn: 1, bytesOut: 2 }} />), /1.07 KiB/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleLimitsForm, newRuleLimitsForm } from "../rules/RuleLimitsForm";
import HostChinaHealthSettings, { createChinaHealthDraft } from "../hosts/HostChinaHealthSettings";
import HostTrafficShutdownSetting from "../hosts/HostTrafficShutdownSetting";

const source = (path: string) => readFileSync(`client/src/${path}`, "utf8").replace(/\r\n/g, "\n");
const section = (path: string, start: string, end: string) => {
  const text = source(path);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${path}: section exists`);
  return text.slice(from, to);
};

test("short numbers stay paired while date/time fields wrap when their container is too narrow", () => {
  const html = renderToStaticMarkup(<RuleLimitsForm value={newRuleLimitsForm()} onChange={() => {}} />);
  assert.equal((html.match(/grid min-w-0 grid-cols-2 gap-3/g) || []).length, 1);
  assert.ok(html.includes("grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]"));
  assert.equal((html.match(/type="number"/g) || []).length, 2);
  assert.equal((html.match(/type="time"/g) || []).length, 2);
  const health = renderToStaticMarkup(<HostChinaHealthSettings value={{ ...createChinaHealthDraft(), enabled: true, notify: false }} onChange={() => {}} />);
  assert.match(health, /grid min-w-0 grid-cols-2 gap-2\.5/);
  assert.equal((health.match(/type="number"/g) || []).length, 5);
});

test("shutdown thresholds move below the header in narrow cards and inline in wide cards", () => {
  const html = renderToStaticMarkup(<HostTrafficShutdownSetting enabled percent={95} triggered={false} onEnabledChange={() => {}} onPercentChange={() => {}} />);
  assert.match(html, /@container/);
  assert.match(html, /col-span-2 row-start-2/);
  assert.match(html, /@min-\[16rem\]:row-start-1/);
  assert.match(html, /col-start-2 row-start-1 @min-\[16rem\]:col-start-3/);
  assert.match(html, /value="95"/);
  assert.doesNotMatch(html, /whitespace-nowrap/);
});

test("host billing and paired controls use mobile columns without squeezing timestamps", () => {
  const host = section("pages/Hosts.tsx", '<TabsContent value="other"', 'translateText("DDNS 服务")');
  assert.match(host, /grid min-w-0 grid-cols-2 gap-2\.5 px-1/);
  assert.equal((host.match(/col-span-2 min-w-0 space-y-1 sm:col-span-1/g) || []).length, 2);
  assert.match(host, /col-span-2 row-start-2 min-w-0 space-y-1 md:col-span-1 md:row-start-auto/);
  assert.equal((host.match(/mt-2\.5 grid min-w-0 grid-cols-2 gap-2\.5/g) || []).length, 2);
  assert.match(host, /@min-\[16rem\]:grid-cols-/);
});

test("plan and rule names retain full mobile width while short settings share columns", () => {
  const plan = section("pages/Plans.tsx", '<TabsContent value="settings"', '<PlanDescriptionEditor');
  assert.match(plan, /grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3/);
  assert.match(plan, /col-span-2 space-y-2 md:col-span-1/);
  const rule = section("pages/Rules.tsx", '</RuleRouteTransition>\n            <div className="grid min-w-0 grid-cols-2', 'translateText("源端口")');
  assert.match(rule, /col-span-2 space-y-2 sm:col-span-1/);
  for (const label of ["规则名称", "协议", "转发工具"]) assert.ok(rule.includes(label));
  const billing = section("components/TrafficBillingConfigManager.tsx", '<Dialog open={dialogOpen}', '<DialogFooter>');
  assert.match(billing, /grid min-w-0 grid-cols-2 gap-3/);
  assert.match(billing, /col-span-2 grid min-w-0 gap-3/);
  assert.match(billing, /col-span-2 space-y-2/);
});

test("code generators preserve full-width code, plan selection and submit rows on mobile", () => {
  const billing = section("pages/Billing.tsx", '<TabsContent value="redeem"', '<CardTitle>{translateText("折扣码列表")}');
  assert.equal((billing.match(/grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4/g) || []).length, 2);
  assert.equal((billing.match(/col-span-2 space-y-2">/g) || []).length, 2);
  assert.match(billing, /col-span-2 space-y-2 md:col-span-4/);
  assert.equal((billing.match(/col-span-2 flex justify-end md:col-span-4/g) || []).length, 2);
});

test("host services and SMTP reserve only a compact column for ports", () => {
  const service = source("components/hosts/HostProbeServiceManager.tsx");
  assert.match(service, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.match(service, /grid-cols-\[minmax\(0,1fr\)_6\.5rem\]/);
  const smtp = source("pages/EmailSettings.tsx");
  assert.match(smtp, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.match(smtp, /grid-cols-\[minmax\(0,1fr\)_6rem\]/);
});

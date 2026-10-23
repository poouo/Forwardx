import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanDetails } from "./PlanDetails";
import { planDescriptionTemplate } from "../lib/planDisplay";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "@shared/planDescription";

test("metered plan names have an editable form field and consistent management/store fallbacks", () => {
  const source = readFileSync("client/src/components/TrafficBillingConfigManager.tsx", "utf8");
  assert.match(source, /name: String\(config\.name \|\| ""\)/);
  assert.match(source, /name: configForm\.name\.trim\(\)/);
  assert.match(source, /htmlFor="billing-config-name"[^\n]*套餐名称/);
  assert.match(source, /id="billing-config-name" maxLength=\{255\} value=\{configForm\.name\}/);
  assert.match(source, /留空使用资源名称/);
  assert.equal((source.match(/\{config\.name \|\| config\.resourceName\}/g) || []).length, 2, "both card and table show the plan name");
  const store = readFileSync("client/src/pages/Store.tsx", "utf8");
  assert.match(store, /\{config\.name \|\| config\.resourceName\}/);
  assert.match(store, /config\.name && <p[^\n]*title=\{config\.resourceName\}/);
});

test("metered descriptions share the subscription editor, safe rendering and optional default details", () => {
  const source = readFileSync("client/src/components/TrafficBillingConfigManager.tsx", "utf8");
  assert.match(source, /<PlanDescriptionEditor value=\{configForm.description\}/);
  assert.doesNotMatch(source, /<Textarea/);
  assert.match(source, /setConfigForm\(\{ \.\.\.defaultBillingConfigForm\(\), description: planDescriptionTemplate\("metered"\) \}\)/);
  assert.match(source, /description: String\(config.description \|\| ""\)/);
  const card = source.slice(source.indexOf("function BillingConfigCard("), source.indexOf("export default function TrafficBillingConfigManager("));
  const end = card.indexOf("</PlanDetails>");
  assert.ok(end > 0);
  assert.match(card.slice(0, end), /<PlanDetails description=\{config.description\}/);
  assert.ok(card.indexOf('label={translateText("权限")}') > end);
  assert.ok(card.indexOf('label={translateText("状态")}') > end);
  const store = readFileSync("client/src/pages/Store.tsx", "utf8");
  assert.match(store, /<PlanDetails description=\{billingDescription\(config\)\}/);
  assert.ok(store.indexOf("moneyFromMilliCents(effectiveBillingPriceMilliCents(config))") < store.indexOf("<PlanDetails description={billingDescription(config)}"), "actual billing price remains outside custom content");
  const template = planDescriptionTemplate("metered");
  assert.ok(template.length < PLAN_DESCRIPTION_MAX_LENGTH);
  const html = renderToStaticMarkup(<PlanDetails description={template} />);
  assert.match(html, /<h2>按量计费介绍<\/h2>/);
  assert.match(html, /<strong>计费方式<\/strong>/);
  const unsafe = renderToStaticMarkup(<PlanDetails description={'<h3>说明</h3><script>bad()</script><p onclick="bad()">内容</p>'} />);
  assert.match(unsafe, /<h3>说明<\/h3>/);
  assert.doesNotMatch(unsafe, /<script|onclick|bad\(\)/);
});

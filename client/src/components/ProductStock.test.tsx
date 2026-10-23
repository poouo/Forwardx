import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MeteredRuleLimitBadge, ProductStockBadge, ProductStockField } from "./ProductStock";

test("stock badges distinguish unlimited, remaining and sold out quantities", () => {
  assert.match(renderToStaticMarkup(<ProductStockBadge product={{ stockLimit: 0 }} />), /库存：∞/);
  assert.match(renderToStaticMarkup(<ProductStockBadge product={{ stockLimit: 3, stockUsed: 1 }} />), /库存：2/);
  const empty = renderToStaticMarkup(<ProductStockBadge product={{ stockLimit: 1, stockUsed: 2 }} />);
  assert.match(empty, /库存：0/);
  assert.match(empty, /destructive/);
});

test("stock inputs default to zero and explain the current user-based metered semantics", () => {
  const html = renderToStaticMarkup(<ProductStockField value="0" onChange={() => {}} metered />);
  assert.match(html, /min="0"/);
  assert.match(html, /value="0"/);
  assert.match(html, /每名用户占 1 份/);
  assert.match(html, /全部逻辑规则后释放/);
  assert.match(renderToStaticMarkup(<MeteredRuleLimitBadge config={{ maxRulesPerUser: 3, currentUserRuleCount: 2 }} />), /2 \/ 3/);
  assert.match(renderToStaticMarkup(<MeteredRuleLimitBadge config={{ maxRulesPerUser: 0 }} />), /∞/);
});

test("stock controls stay outside custom descriptions and sold-out plans cannot be purchased", () => {
  const store = readFileSync("client/src/pages/Store.tsx", "utf8");
  const plans = readFileSync("client/src/pages/Plans.tsx", "utf8");
  const metered = readFileSync("client/src/components/TrafficBillingConfigManager.tsx", "utf8");
  assert.match(store, /disabled=\{purchasing \|\| soldOut\}/);
  assert.match(store, /const current = plans.find/);
  assert.match(store, /productStock\(current\).soldOut/);
  for (const source of [plans, metered]) {
    assert.ok(source.indexOf("<ProductStockBadge") < source.indexOf("<PlanDetails"));
    assert.match(source, /<ProductStockField/);
    assert.match(source, /stockLimit: Number\(/);
  }
  assert.match(metered, /maxRulesPerUser: Number\(configForm.maxRulesPerUser/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanDetails } from "./PlanDetails";
import { planDescription } from "../lib/planDisplay";

test("missing, empty and whitespace descriptions retain default plan information", () => {
  for (const description of [undefined, null, "", " \n\t ", 123]) {
    assert.equal(renderToStaticMarkup(<PlanDetails description={description}><div>价格 / 端口 / 流量 / 连接 / 限速</div></PlanDetails>), "<div>价格 / 端口 / 流量 / 连接 / 限速</div>");
  }
  assert.equal(planDescription(null), "");
});

test("custom descriptions replace defaults, preserve lines and render as safe text", () => {
  const html = renderToStaticMarkup(<PlanDetails description={"  自定义套餐\n第二行 <script>alert(1)</script>  "}><div>默认套餐信息</div></PlanDetails>);
  assert.match(html, /自定义套餐\n第二行/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /默认套餐信息|<script|line-clamp|truncate/);
});

test("plan management keeps status controls outside the replaceable card content and supports table view", () => {
  const source = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  const card = source.slice(source.indexOf("function PlanCard("), source.indexOf("function hostTitle("));
  const start = card.indexOf("<PlanDetails");
  const end = card.indexOf("</PlanDetails>");
  assert.ok(start > 0 && end > start);
  for (const text of ["价格", "资源", "端口", "规则/流量", "连接/IP", "限速", "附加流量"]) assert.ok(card.slice(start, end).includes(text));
  assert.ok(card.indexOf("<PlanStatusQuickToggle") > end);
  assert.match(source, /TableCell colSpan=\{3\}[\s\S]*?<PlanDetails description=\{plan.description\}/);
});

test("store replaces default benefits but retains actual price and purchase controls", () => {
  const source = readFileSync(new URL("../pages/Store.tsx", import.meta.url), "utf8");
  const card = source.slice(source.indexOf("function StorePlanCard("), source.indexOf("export default function Store("));
  assert.match(card, /\{description \? \([\s\S]*?<PlanDetails description=\{description\}[\s\S]*?: \(<>/);
  const end = card.indexOf("</>)}");
  assert.ok(end > 0);
  assert.ok(card.indexOf("money(plan.priceCents, plan.currency)") > end);
  assert.ok(card.indexOf("onClick={onBuy}") > end);
});

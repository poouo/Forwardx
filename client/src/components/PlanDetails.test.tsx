import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanDetails } from "./PlanDetails";
import { planDescription } from "../lib/planDisplay";
import { planDescriptionTemplate } from "../lib/planDisplay";
import { PlanDescriptionEditor } from "./PlanDescriptionEditor";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "@shared/planDescription";

test("missing, empty and whitespace descriptions retain default plan information", () => {
  for (const description of [undefined, null, "", " \n\t ", 123]) {
    assert.equal(renderToStaticMarkup(<PlanDetails description={description}><div>价格 / 端口 / 流量 / 连接 / 限速</div></PlanDetails>), "<div>价格 / 端口 / 流量 / 连接 / 限速</div>");
  }
  assert.equal(planDescription(null), "");
});

test("custom plain descriptions replace defaults and preserve lines", () => {
  const html = renderToStaticMarkup(<PlanDetails description={"  自定义套餐\n第二行  "}><div>默认套餐信息</div></PlanDetails>);
  assert.match(html, /<p>自定义套餐<\/p>\n<p>第二行<\/p>/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.doesNotMatch(html, /默认套餐信息|<script|line-clamp|truncate/);
});

test("plan descriptions render Markdown headings, lists, emphasis, links, quotes and code", () => {
  const description = "## 套餐介绍\n- **优势**：低延迟\n- [使用教程](https://example.com/guide)\n\n> 请确认权益\n\n```\n<script>not executed</script>\n```";
  const html = renderToStaticMarkup(<PlanDetails description={description} />);
  for (const fragment of ["<h2>套餐介绍</h2>", "<ul>", "<strong>优势</strong>", '<a href="https://example.com/guide"', "<blockquote>请确认权益</blockquote>", "<pre><code>&lt;script&gt;not executed&lt;/script&gt;</code></pre>"]) assert.ok(html.includes(fragment), fragment);
  assert.doesNotMatch(html, /<script/);
  assert.match(renderToStaticMarkup(<PlanDetails description="*斜体*与~~删除线~~" />), /<em>斜体<\/em>与<del>删除线<\/del>/);
});

test("H5 plan descriptions allow basic layout but filter scripts, events, embeds and unsafe links", () => {
  const html = renderToStaticMarkup(<PlanDetails description={'<div style="position:fixed"><h3>套餐</h3><p onclick="alert(1)">介绍 <strong>亮点</strong></p><table><tr><th>额度</th><td>示例</td></tr></table><a href="javascript:alert(1)">联系</a><script>alert(1)</script><iframe src="https://evil.test"></iframe><img src=x onerror=alert(1)></div>'} />);
  assert.match(html, /<h3>套餐<\/h3>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>亮点<\/strong>/);
  assert.doesNotMatch(html, /<script|<iframe|<img|onclick|onerror|javascript:|position:fixed|alert\(1\)/);
});

test("new-plan templates and editor use preview and the same character limit without replacing saved descriptions", () => {
  assert.ok(planDescriptionTemplate().length < PLAN_DESCRIPTION_MAX_LENGTH);
  const html = renderToStaticMarkup(<PlanDetails description={planDescriptionTemplate()} />);
  assert.match(html, /<h2>/);
  assert.match(html, /<ul>/);
  const editor = renderToStaticMarkup(<PlanDescriptionEditor value="现有说明" onChange={() => {}} />);
  assert.match(editor, /maxLength="10000"/);
  assert.match(editor, /现有说明/);
  assert.match(editor, /aria-expanded="false"/);
  assert.match(editor, /aria-describedby="plan-description-help"/);
  const source = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  assert.match(source, /const openPlanCreate = \(\) => \{\s*setForm\(\{ \.\.\.emptyForm, description: planDescriptionTemplate\(\) \}\)/);
  assert.match(source, /description: plan.description \|\| ""/);
  const editorSource = readFileSync(new URL("./PlanDescriptionEditor.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /<PlanDetails description=\{value\}/);
});

test("card edit actions use labeled pencil icons", () => {
  const source = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/aria-label=\{translateText\("编辑套餐"\)\}/g) || []).length, 1);
  assert.equal((source.match(/<Pencil className="h-4 w-4" \/>/g) || []).length, 1);
  assert.doesNotMatch(source, />\{translateText\("编辑"\)\}<\/Button>/);
});

test("plan management keeps status controls outside replaceable card content and only supports sortable cards", () => {
  const source = readFileSync(new URL("../pages/Plans.tsx", import.meta.url), "utf8");
  const card = source.slice(source.indexOf("function PlanCard("), source.indexOf("function hostTitle("));
  const start = card.indexOf("<PlanDetails");
  const end = card.indexOf("</PlanDetails>");
  assert.ok(start > 0 && end > start);
  for (const text of ["价格", "资源", "端口", "规则/流量", "连接/IP", "限速", "附加流量"]) assert.ok(card.slice(start, end).includes(text));
  assert.ok(card.indexOf("<PlanStatusQuickToggle") > end);
  assert.match(source, /<SortableReorderContext sortable=\{planSortable\} strategy="rect">/);
  assert.match(source, /<PlanCard/);
  assert.doesNotMatch(source, /<Table|planViewMode|PlanListViewMode|forwardx\.plans\.viewMode|列表视图|卡片视图/);
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

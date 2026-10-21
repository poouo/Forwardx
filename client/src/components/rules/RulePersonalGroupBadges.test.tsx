import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RulePersonalGroupBadges } from "./RulePersonalGroupBadges";
import { RuleCardMetadata } from "./RuleCardMetadata";

const groups = [{ id: 2, name: "游戏" }, { id: 1, name: "常用" }, { id: 3, name: "测试" }];

test("ungrouped cards render nothing and ungrouped cells use a placeholder", () => {
  assert.equal(renderToStaticMarkup(<RulePersonalGroupBadges groups={groups} />), "");
  assert.equal(renderToStaticMarkup(<RulePersonalGroupBadges groups={groups} groupIds={[99]} />), "");
  assert.match(renderToStaticMarkup(<RulePersonalGroupBadges groups={groups} groupIds={[]} emptyPlaceholder />), /—/);
});

test("group badges follow account group order, deduplicate assignments and omit unrelated groups", () => {
  const html = renderToStaticMarkup(<RulePersonalGroupBadges groups={groups} groupIds={[1, 2, 1, 99]} />);
  assert.ok(html.indexOf('title="游戏"') < html.indexOf('title="常用"'));
  assert.equal((html.match(/title="常用"/g) || []).length, 1);
  assert.doesNotMatch(html, /测试|99/);
  assert.match(html, /truncate/);
  assert.match(html, /max-w-24/);
});

test("many groups stay in one compact strip with a full-name hover title", () => {
  const html = renderToStaticMarkup(<RulePersonalGroupBadges groups={groups} groupIds={[1, 2, 3]} />);
  assert.match(html, /title="所属分组: 游戏、常用、测试"/);
  assert.match(html, />\+1</);
  assert.doesNotMatch(html, /title="测试"/);
  const escaped = renderToStaticMarkup(<RulePersonalGroupBadges groups={[{ id: 1, name: '<b>"group"</b>' }]} groupIds={[1]} />);
  assert.doesNotMatch(escaped, /<b>/);
  assert.match(escaped, /&lt;b&gt;/);
});

test("cards and table cells share one presentational group badge component", () => {
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.equal((source.match(/\{renderRuleCardMetadata\(rule\)\}/g) || []).length, 2);
  assert.match(source, /routeBadges=\{renderRouteBadge\(rule, false, true\)\}/);
  assert.match(source, /case "groups": return <RulePersonalGroupBadges[^>]+emptyPlaceholder/);
  const badgeSource = readFileSync("client/src/components/rules/RulePersonalGroupBadges.tsx", "utf8");
  assert.doesNotMatch(badgeSource, /useQuery|fetch\(/);
});

test("card route, protocol and group tags stay in one line with the path in a separate row", () => {
  const html = renderToStaticMarkup(<RuleCardMetadata routeBadges={<span>隧道 / GOST</span>} protocol="TCP" groups={groups} groupIds={[1, 2, 3]} path={<span>HK entry → JP exit</span>} />);
  assert.match(html, /data-rule-card-tags="true" class="[^"]*flex-nowrap/);
  assert.ok(html.indexOf("隧道 / GOST") < html.indexOf(">TCP<"));
  assert.ok(html.indexOf(">TCP<") < html.indexOf("data-rule-personal-groups"));
  assert.ok(html.indexOf("data-rule-personal-groups") < html.indexOf("data-rule-card-path"));
  assert.match(html, />\+2</);
  assert.doesNotMatch(html, /title="常用"/);
  const noPath = renderToStaticMarkup(<RuleCardMetadata routeBadges={<span>realm</span>} protocol="UDP" groups={[]} />);
  assert.doesNotMatch(noPath, /data-rule-card-path|data-rule-personal-groups/);
});

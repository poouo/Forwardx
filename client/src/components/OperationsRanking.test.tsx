import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import Ranking from "./OperationsRanking";

test("rule rankings distinguish ranks and IDs, preserving real names in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<Ranking title="Traffic" ruleLabels rows={[
        { id: 62, name: "香港入口", bytesIn: 100, bytesOut: 200 },
        { id: 39, name: "  ", bytesIn: 10, bytesOut: 20 },
        { id: 63, name: null, bytesIn: 1, bytesOut: 2 },
        { id: 44, name: "44", bytesIn: 0, bytesOut: 1 },
      ]} />);
      assert.ok(html.includes('title="香港入口 · #62"'));
      for (const id of [39, 63]) assert.ok(html.includes(`${language === "en" ? "Rule" : "规则"} #${id}`));
      assert.match(html, /title="44 · #44">44<\/span>/);
      assert.match(html, /shrink-0 text-muted-foreground">1<\/span>/);
      const resource = renderToStaticMarkup(<Ranking title="Resources" rows={[{ id: "group:3", name: "慈云数据", bytesIn: 10, bytesOut: 20 }]} />);
      assert.ok(resource.includes('title="慈云数据"'));
      assert.ok(!resource.includes("Rule #"));
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("ranking previews stay compact, show five rows and retain access to the top ten", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `traffic-item-${index + 1}`, bytesIn: 1000 - index, bytesOut: 0 }));
  const html = renderToStaticMarkup(<Ranking title="Rules" rows={rows} ruleLabels />);
  for (let index = 1; index <= 5; index++) assert.ok(html.includes(`title="traffic-item-${index} · #${index}"`));
  for (let index = 6; index <= 10; index++) assert.ok(!html.includes(`title="traffic-item-${index} · #${index}"`));
  assert.equal((html.match(/<li /g) || []).length, 5);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /self-start/);
  const source = readFileSync("client/src/components/OperationsRanking.tsx", "utf8");
  assert.match(source, /<RankingEntries rows=\{rankedRows\} max=\{max\} ruleLabels=\{ruleLabels\}/);
  assert.match(source, /<DialogContent className="sm:max-w-xl">/);
  const page = readFileSync("client/src/pages/Operations.tsx", "utf8");
  assert.match(page, /grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4/);
});

test("short and empty rankings do not reserve space or show an unnecessary more button", () => {
  for (const count of [0, 1, 2, 5]) {
    const rows = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `item-${index + 1}`, bytesIn: 100, bytesOut: 0 }));
    const html = renderToStaticMarkup(<Ranking title="Hosts" rows={rows} />);
    assert.equal((html.match(/<li /g) || []).length, count);
    assert.doesNotMatch(html, /aria-haspopup="dialog"|min-h-/);
    assert.doesNotMatch(html.slice(0, html.indexOf(">")), /h-full/);
    if (count === 0) assert.match(html, /暂无数据/);
  }
});

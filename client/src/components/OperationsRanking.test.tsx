import assert from "node:assert/strict";
import test from "node:test";
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

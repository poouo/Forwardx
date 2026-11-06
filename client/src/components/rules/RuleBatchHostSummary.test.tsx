import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { RuleBatchHostSummary } from "./RuleBatchHostSummary";

test("batch rule host summaries are compact, bilingual and escape host names", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const html = renderToStaticMarkup(<RuleBatchHostSummary hosts={[
        { id: 1, name: "Entry <script>", address: "192.0.2.1" },
        { id: 2, name: "Entry B", address: "2001:db8::2" },
        { id: 3, name: "Entry C", address: "192.0.2.3" },
      ]} />);
      assert.match(html, /Entry &lt;script&gt;/);
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /192\.0\.2\.1/);
      assert.match(html, /2001:db8::2/);
      assert.match(html, /title="[^"]*Entry C/);
      assert.match(html, />\+1<\/span>/);
      assert.match(html, /min-w-0 truncate/);
      const empty = renderToStaticMarkup(<RuleBatchHostSummary hosts={[]} />);
      if (language === "en") {
        assert.match(html, /Entry Host/);
        assert.match(empty, /Unknown/);
        assert.doesNotMatch(html + empty, /\p{Script=Han}/u);
      } else assert.match(html, /入口主机/);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("batch host selection applies to both displayed and selected rules and resets on owner/host changes", () => {
  const source = readFileSync(new URL("../../pages/Rules.tsx", import.meta.url), "utf8");
  assert.match(source, /useEffect\(\(\) => \{\s*setCopyRuleHostId\("all"\);\s*setCopyRuleIds\(\[\]\);\s*\}, \[filterUser, user\?\.id\]\)/);
  const open = source.slice(source.indexOf("const openCopyDialog ="), source.indexOf("const openEdit ="));
  assert.match(open, /setCopyRuleHostId\("all"\)/);
  const filters = source.slice(source.indexOf("const copyableSourceRules ="), source.indexOf("const copyTargetResources ="));
  assert.equal((filters.match(/matchesRuleBatchHost\(copyRuleEntryHosts\.get\(Number\(rule\.id\)\) \|\| \[\], copyRuleHostId\)/g) || []).length, 2);
  const panel = source.slice(source.indexOf("const batchRuleSelectionPanel ="), source.indexOf("const buildEmptyBatchEditForm ="));
  assert.match(panel, /<Select value=\{copyRuleHostId\} disabled=\{copyActionPending\}/);
  assert.match(panel, /setCopyRuleHostId\(value\);\s*setCopyRuleIds\(\[\]\)/);
  assert.match(panel, /aria-label=\{translateText\("入口主机"\)\}/);
  assert.match(panel, /copyRuleHostOptions\.map/);
  assert.match(panel, /<RuleBatchHostSummary hosts=\{copyRuleEntryHosts\.get\(Number\(rule\.id\)\) \|\| \[\]\}/);
});

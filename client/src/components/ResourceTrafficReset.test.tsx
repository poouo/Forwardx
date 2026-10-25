import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t } from "@/i18n";
import { ResourceTrafficResetButton } from "./ResourceTrafficReset";
import { ResourceTrafficSummary } from "./ResourceTrafficSummary";

test("resource reset is accessible and explains its accounting scope in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN","en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const html = renderToStaticMarkup(<ResourceTrafficResetButton disabled onClick={()=>{}} />);
      assert.match(html,/type="button"/); assert.match(html,/disabled=""/); assert.match(html,/aria-label=/); assert.match(html,/title=/);
      const text = t("将“{0}”的当日和累计展示流量归零，后续上报重新累计。不影响转发连接、规则用量、用户额度、历史记录或账单。",["Test"]);
      const totals = renderToStaticMarkup(<ResourceTrafficSummary resettable summary={{bytesIn:0,bytesOut:0,totalBytes:0,ruleCount:2,daily:{bytesIn:0,bytesOut:0,totalBytes:0}}} />);
      if (language === "en") { assert.doesNotMatch(html+text+totals,/\p{Script=Han}/u); assert.match(text,/quotas, history and billing are unchanged/); assert.match(totals,/latest reset today/); }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("desktop, mobile and table preserve sync and add an independent confirmed port reset", () => {
  const source = readFileSync("client/src/pages/ForwardGroups.tsx","utf8");
  assert.equal((source.match(/\{resourceTrafficResetAction\(group\)\}/g)||[]).length,3);
  assert.equal((source.match(/syncMutation\.mutate\(\{ id: group\.id \}\)/g)||[]).length,3);
  assert.match(source,/normalizeGroupMode\(group.groupMode\) === "port"\s*\? <ResourceTrafficResetButton/);
  assert.match(source,/<ResourceTrafficResetDialog/);
  assert.match(source,/trpc.forwardGroups.resetTraffic.useMutation/);
  const dialog = readFileSync("client/src/components/ResourceTrafficReset.tsx","utf8");
  assert.match(dialog,/if \(!open && !pending\) onClose\(\)/);
  assert.match(dialog,/aria-busy=\{pending\}/);
  assert.match(dialog,/disabled=\{pending\} onClick=\{onConfirm\}/);
});

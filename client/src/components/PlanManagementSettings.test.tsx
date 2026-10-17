import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../i18n";
import { PlanManagementSettings } from "./PlanManagementSettings";

test("plan management switches retain independent states and accessible labels in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const storeEnabled of [true, false]) {
        const html = renderToStaticMarkup(<PlanManagementSettings
          store={{ enabled: storeEnabled, unavailable: false, onChange: async () => {} }}
          trafficBilling={{ enabled: !storeEnabled, unavailable: false, onChange: async () => {} }}
        />);
        assert.equal((html.match(/role="switch"/g) || []).length, 2);
        const states = [...html.matchAll(/aria-checked="(true|false)"/g)].map(match => match[1]);
        assert.deepEqual(states, [String(storeEnabled), String(!storeEnabled)]);
        for (const match of html.matchAll(/<label[^>]*for="([^"]+)"/g)) assert.ok(html.includes(`id="${match[1]}"`));
        assert.equal((html.match(/aria-describedby=/g) || []).length, 2);
        assert.match(html, /min-w-0/);
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
        else assert.match(html, /需授权的资源仍须先授权/);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("loading or failed settings cannot be toggled, independently of the other setting", () => {
  for (const unavailable of [true, false]) {
    const html = renderToStaticMarkup(<PlanManagementSettings
      store={{ enabled: true, unavailable, onChange: async () => {} }}
      trafficBilling={{ enabled: false, unavailable: true, onChange: async () => {} }}
    />);
    const switches = html.match(/<button\b[^>]*role="switch"[^>]*>/g) || [];
    assert.equal(switches.filter(button => /\sdisabled=""/.test(button)).length, unavailable ? 2 : 1);
  }
});

test("plans start with the resource tabs rather than overview cards or billing summary requests", () => {
  const source = readFileSync("client/src/pages/Plans.tsx", "utf8");
  assert.doesNotMatch(source, /AnimatedStatValue|plans\.summary\.useQuery|trafficBilling\.status\.useQuery/);
  assert.doesNotMatch(source, /累计扣费|已计费流量|套餐数量|套餐资源|planResourceSummary/);
  const page = source.slice(source.indexOf("<DashboardLayout>"), source.indexOf("<Dialog open={settingsOpen}"));
  assert.ok(page.indexOf("pearl-page-header") < page.indexOf("<Tabs value={activeTab}"));
  assert.match(page, /setSettingsOpen\(true\)/);
  assert.match(source, /storeStatus\.useQuery\(undefined, \{ enabled: settingsOpen \}\)/);
  assert.match(source, /trafficBilling\.configs\.useQuery\(undefined, \{ enabled: settingsOpen \}\)/);
  assert.match(source, /setStoreEnabled\.mutateAsync\(\{ enabled \}\)/);
  assert.match(source, /setTrafficBillingEnabled\.mutateAsync\(\{ enabled \}\)/);
  assert.match(source, /storeStatusQuery\.isError/);
  assert.match(source, /trafficBillingQuery\.refetch\(\)/);
  const manager = readFileSync("client/src/components/TrafficBillingConfigManager.tsx", "utf8");
  assert.match(manager, /trafficBilling\.status\.useQuery\(undefined, \{ enabled: showSummary \}\)/);
});

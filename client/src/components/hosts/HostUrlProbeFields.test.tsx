import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import HostUrlProbeFields from "./HostUrlProbeFields";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "../../i18n";

test("URL controls are compact, labeled, and bilingual", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const html = renderToStaticMarkup(<HostUrlProbeFields value={{ targetUrl: "https://example.com/health", timeoutSeconds: 5, expectedStatus: 204 }} onChange={() => {}} />);
      assert.match(html, /grid-cols-2/);
      assert.match(html, /type="url"/);
      for (const id of ["probe-service-url", "probe-service-timeout", "probe-service-status"]) {
        assert.ok(html.includes(`for="${id}"`)); assert.ok(html.includes(`id="${id}"`));
      }
      assert.match(html, /value="204"/);
      if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("edit, toggle and target display keep URL probe settings instead of falling back to TCP", () => {
  const source = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(source, /normalizeHostProbeMethod\(service\??\.method\)/);
  assert.match(source, /service\.method === "url"\) return service\.targetUrl/);
  assert.match(source, /targetUrl: method === "url" \? service.targetUrl : null/);
  assert.match(source, /timeoutSeconds: Number\(service.timeoutSeconds \?\? 5\)/);
  assert.match(source, /expectedStatus: Number\(service.expectedStatus \?\? 200\)/);
  const chart = readFileSync("client/src/components/hosts/HostProbeServiceLatencyDialog.tsx", "utf8");
  assert.match(chart, /translateText\("URL 请求失败率"\)/);
  assert.match(chart, /service.method === "tcping"/);
  assert.doesNotMatch(chart, /every\(\(service\) => service.method !== "ping"\)/);
});

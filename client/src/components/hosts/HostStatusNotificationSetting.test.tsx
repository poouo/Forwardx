import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import HostStatusNotificationSetting from "./HostStatusNotificationSetting";

test("host notification switch is accessible, bilingual and retains saved checked state", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const checked of [true, false]) {
        const html = renderToStaticMarkup(<HostStatusNotificationSetting checked={checked} onChange={() => {}} />);
        assert.match(html, /role="switch"/);
        assert.ok(html.includes(`aria-checked="${checked}"`));
        const labelId = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
        assert.ok(labelId && html.includes(`id="${labelId}"`));
        assert.doesNotMatch(html, /<p\b/);
        assert.match(html, /data-state="closed"/);
        assert.match(html, /min-w-0/);
        assert.match(html, /shrink-0/);
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("host form preserves defaults and sends the setting only in the administrator payload", () => {
  const source = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(source, /hostStatusNotifyEnabled: true/);
  assert.match(source, /hostStatusNotifyEnabled: host\.hostStatusNotifyEnabled \?\? true/);
  const payload = source.slice(source.indexOf("const trafficConfigPayload"), source.indexOf("const protocolPolicyPayload"));
  assert.match(payload, /user\?\.role === "admin"/);
  assert.match(payload, /hostStatusNotifyEnabled: form\.hostStatusNotifyEnabled/);
  const location = source.slice(source.indexOf('<TabsContent value="other"'));
  assert.ok(location.indexOf('user?.role === "admin"') < location.indexOf("<HostStatusNotificationSetting"));
});

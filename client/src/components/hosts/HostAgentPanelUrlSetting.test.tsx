import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import HostAgentPanelUrlSetting from "./HostAgentPanelUrlSetting";

test("host panel URL setting uses project controls and wraps in both languages", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const enabled of [true, false]) {
        const html = renderToStaticMarkup(<HostAgentPanelUrlSetting enabled={enabled} value="https://panel.example.com:8443" onEnabledChange={() => {}} onChange={() => {}} />);
        assert.match(html, new RegExp(`aria-checked="${enabled}"`));
        assert.equal(/disabled=""/.test(html), !enabled);
        assert.match(html, /type="url"/);
        assert.match(html, /min-w-0/);
        assert.match(html, /break-words/);
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

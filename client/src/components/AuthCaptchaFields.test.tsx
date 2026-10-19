import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeLanguage, setLanguagePreference } from "@/i18n";
import AuthCaptchaSettingsFields from "./AuthCaptchaSettingsFields";
import ImageCaptchaField from "./ImageCaptchaField";

test("captcha settings use two equal responsive columns with an administrator-selected provider", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language); await initializeLanguage();
    for (const provider of ["cap", "image"] as const) {
      const html = renderToStaticMarkup(<AuthCaptchaSettingsFields enabled provider={provider} onEnabledChange={() => {}} onProviderChange={() => {}} />);
      assert.match(html, /md:grid-cols-2/);
      assert.match(html, /id="auth-captcha-provider"/);
      assert.match(html, /role="combobox"/);
      assert.match(html, /aria-checked="true"/);
      if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
  }
});

test("image field is bilingual, refreshable, bounded to six characters and disabled until ready", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language); await initializeLanguage();
    const props = { id: "captcha", value: "", loading: false, refreshDisabled: false, refreshTitle: "Refresh", onChange() {}, onRefresh() {} };
    const missing = renderToStaticMarkup(<ImageCaptchaField {...props} />);
    assert.match(missing, /<input[^>]+ disabled=""/);
    const html = renderToStaticMarkup(<ImageCaptchaField {...props} imageDataUrl="data:image/svg+xml;base64,PHN2Zy8+" />);
    assert.match(html, /maxLength="6"/);
    assert.match(html, /autoComplete="off"/);
    assert.match(html, /object-contain/);
    assert.match(html, /type="button"/);
    assert.doesNotMatch(html, /<input[^>]+ disabled=""/);
    if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
  }
});

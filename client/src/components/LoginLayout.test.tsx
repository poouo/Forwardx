import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { LoginLayout } from "./LoginLayout";
import { loginContentMotion } from "@/lib/loginTransition";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";

test("login layout localizes both modes and preserves a single custom brand", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const mode of ["login", "register"] as const) {
        const html = renderToStaticMarkup(<Router ssrPath="/login"><LoginLayout siteTitle="Light-ZZ" logo="data:image/png;base64,dGVzdA==" mode={mode}
          subtitle="Account access" toolbar={<button>Theme</button>}>
          <form><label htmlFor="email">Email</label><input id="email" /><button type="submit">Continue</button></form>
        </LoginLayout></Router>);
        assert.equal((html.match(/<img\b/g) || []).length, 1);
        assert.equal((html.match(/<h1\b/g) || []).length, 1);
        assert.match(html, /aria-labelledby="auth-login-title"/);
        assert.doesNotMatch(html, /auth-login-mode-switch/);
        assert.match(html, /<form>/);
        assert.doesNotMatch(html, /min-h-\[470px\]|min-h-\[660px\]|NETWORK CONSOLE/);
        if (language === "en") {
          assert.doesNotMatch(html, /\p{Script=Han}/u);
          assert.match(html, /Every route, in reach/);
          assert.ok(html.includes(mode === "login" ? "Welcome Back" : "Create Account"));
        } else assert.ok(html.includes(mode === "login" ? "欢迎回来" : "创建账号"));
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("auth layout supports narrow screens, theme colors, keyboard access and reduced motion", () => {
  const css = readFileSync("client/src/styles/pearl.css", "utf8");
  assert.match(css, /@media \(max-width: 479px\)/);
  assert.match(css, /\.auth-login-visual \{ display: none; \}/);
  assert.match(css, /\.auth-login-brand > span \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.auth-login-form-panel input \{[^}]*font-size: 16px/);
  assert.match(css, /\.auth-password-toggle:focus-visible/);
  assert.doesNotMatch(css, /\.auth-login-form-content \{[^}]*overflow-y: auto/);
  const layout = readFileSync("client/src/components/LoginLayout.tsx", "utf8");
  assert.match(layout, /new ResizeObserver\(measure\)/);
  assert.match(layout, /height: frameHeight/);
  assert.match(layout, /mode="popLayout"/);
  assert.match(css, /\.auth-network-line-trace \{ animation: none !important/);
  const page = readFileSync("client/src/pages/Login.tsx", "utf8");
  for (const control of ["handleLogin", "handleRegister", "handleVerifyTwoFactorLogin", "GoogleLoginButton", "ImageCaptchaField", "handleMobileTelegramLogin", "setShowPanelSettings"]) assert.ok(page.includes(control));
  assert.match(page, /publicInfo\?\.siteLogoDataUrl/);
  assert.match(page, /if \(!registrationEnabled\)/);
  assert.match(page, /没有账号？点击注册/);
  assert.match(page, /已有账号？返回登录/);
  assert.doesNotMatch(layout, /auth-login-mode-switch|onModeChange/);
  assert.match(page, /loginContentMotion\(!!reduceMotion\)/);
  assert.doesNotMatch(page, /min-h-\[470px\]|min-h-\[660px\]|authHighlights/);
});

test("form text fades out before new text fades in without transforming glyphs", () => {
  const motion = loginContentMotion(false);
  assert.ok(motion.animate.transition.delay >= motion.exit.transition.duration);
  assert.equal(motion.animate.transition.duration, .30);
  assert.equal(motion.exit.pointerEvents, "none");
  for (const state of [motion.initial, motion.animate, motion.exit]) {
    assert.doesNotMatch(JSON.stringify(state), /"(?:x|y|scale|filter)":/);
  }
  const reduced = loginContentMotion(true);
  assert.equal(reduced.initial, false);
  assert.equal(reduced.animate.transition.delay, 0);
  assert.equal(reduced.animate.transition.duration, 0);
  assert.equal(reduced.exit.transition.duration, 0);
});

test("language menu uses the shared themed select and retains preference handling", () => {
  const source = readFileSync("client/src/components/LanguageSelector.tsx", "utf8");
  assert.match(source, /from "@\/components\/ui\/select"/);
  assert.match(source, /<SelectTrigger aria-label=\{t\("语言"\)\}/);
  assert.match(source, /<SelectItem value="zh-CN"/);
  assert.match(source, /<SelectItem value="en"/);
  assert.doesNotMatch(source, /<select\b|<option\b/);
  assert.match(source, /setLanguagePreference\(next\)/);
  assert.match(source, /onLanguageChange\?\.\(\)/);
});

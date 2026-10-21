import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { areAnimationsEnabled, canAnimate, applyMotionPreference } from "@/lib/motionPreference";
import { AnimationPreferenceControl } from "./AnimationPreferencesCard";

test("missing preferences default on and account switches never inherit another user's opt-out", () => {
  assert.equal(areAnimationsEnabled(undefined), true);
  assert.equal(areAnimationsEnabled(null), true);
  assert.equal(areAnimationsEnabled({}), true);
  assert.equal(areAnimationsEnabled({ animationsEnabled: null }), true);
  assert.equal(areAnimationsEnabled({ animationsEnabled: false }), false);
  assert.equal(areAnimationsEnabled({ animationsEnabled: true }), true);
  const attributes = new Set<string>();
  const root = { toggleAttribute(name: string, enabled: boolean) { if (enabled) attributes.add(name); else attributes.delete(name); } } as HTMLElement;
  for (const user of [{ animationsEnabled: false }, { animationsEnabled: true }, null]) {
    applyMotionPreference(root, areAnimationsEnabled(user));
    assert.equal(attributes.has("data-forwardx-motion-disabled"), user?.animationsEnabled === false);
  }
});

test("personal opt-in still respects system reduced motion and hidden tabs", () => {
  for (const enabled of [false, true]) for (const hidden of [false, true]) for (const reduced of [false, true]) {
    assert.equal(canAnimate(enabled, hidden, reduced), enabled && !hidden && !reduced);
  }
});

test("animation switch remains accessible and bilingual without permanent helper text", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      for (const checked of [true, false]) {
        const html = renderToStaticMarkup(<AnimationPreferenceControl checked={checked} onChange={() => {}} />);
        assert.match(html, /role="switch"/);
        assert.match(html, new RegExp(`aria-checked="${checked}"`));
        const labelId = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
        assert.ok(labelId && html.includes(`id="${labelId}"`));
        assert.doesNotMatch(html, /<p\b/);
        if (language === "en") { assert.match(html, /Interface animations/); assert.doesNotMatch(html, /\p{Script=Han}/u); }
      }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("all motion implementations share the personal policy instead of only hiding CSS animation", () => {
  const files = ["AutoAnimateContainer.tsx", "PearlSidebarContent.tsx", "AnimatedStatValue.tsx", "ui/content-transition.tsx", "ui/sliding-tabs.tsx", "hosts/HostProbeServiceLatencyDialog.tsx", "rules/TcpingDetailDialog.tsx"];
  for (const file of files) assert.match(readFileSync(`client/src/components/${file}`, "utf8"), /useMotionEnabled\(\)/, file);
  const autoAnimate = readFileSync("client/src/components/AutoAnimateContainer.tsx", "utf8");
  assert.match(autoAnimate, /if \(!motionEnabled\)/);
  assert.match(autoAnimate, /controller\.destroy\?\.\(\)/);
  assert.match(autoAnimate, /if \(!motionEnabled \|\| !animateLayout/);
  const css = readFileSync("client/src/styles/pearl.css", "utf8");
  const override = css.slice(css.indexOf('html[data-forwardx-motion-disabled],'), css.indexOf('/* Finite animations only.'));
  assert.match(override, /\*::before/); assert.match(override, /\*::after/);
  for (const rule of ["animation: none !important", "transition: none !important", "scroll-behavior: auto !important"]) assert.ok(override.includes(rule));
  assert.doesNotMatch(override, /display:\s*none|visibility:\s*hidden|opacity:\s*0/);
  const card = readFileSync("client/src/components/AnimationPreferencesCard.tsx", "utf8");
  assert.match(card, /utils.auth.me.cancel\(\)/);
  assert.match(card, /context\?\.previous\?\.id === utils.auth.me.getData\(\)\?\.id/);
  assert.doesNotMatch(card, /localStorage|system\.update|userId:/);
});

test("open dialogs and backdrops have visible state styles independent of animation keyframes", () => {
  const css = readFileSync("client/src/index.css", "utf8");
  const panel = css.match(/\.dialog-panel\[data-state="open"\]\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(panel, /opacity:\s*1\s*;/);
  assert.match(panel, /transform:\s*translateY\(0\)\s*;/);
  const overlay = css.match(/\.dialog-overlay\[data-state="open"\]\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(overlay, /background-color:\s*var\(--dialog-overlay-tint\)\s*;/);
  const material = css.match(/\.dialog-overlay\[data-state="open"\]::before,\s*\.dialog-overlay\[data-state="open"\]::after\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(material, /opacity:\s*1\s*;/);
  // Disabled animation must not retain an invisible full-screen interaction blocker.
  assert.doesNotMatch(panel, /pointer-events:\s*none|visibility:\s*hidden/);
});

test("disabling decorative movement preserves functional inline drag transforms", () => {
  const css = readFileSync("client/src/styles/pearl.css", "utf8");
  const disabled = css.slice(css.indexOf('html[data-forwardx-motion-disabled],'), css.indexOf('/* Finite animations only.'));
  assert.doesNotMatch(disabled, /transform:\s*none\s*!important/);
  assert.doesNotMatch(disabled, /\.pearl-card:hover/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.doesNotMatch(reduced, /transform:\s*none\s*!important/);
  // Dnd-kit uses direct transforms while dragging, not a decorative animation.
  const sortable = readFileSync("client/src/components/SortableDragHandle.tsx", "utf8");
  assert.match(sortable, /transform: transform \? CSS\.Translate\.toString\(transform\)/);
});

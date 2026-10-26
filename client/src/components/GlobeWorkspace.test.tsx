import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t } from "@/i18n";
import { GlobeSceneBoundary, GlobeWorkspace, globeColorWithAlpha, globeTooltip, globeViewportSize, resolveGlobeThemeColor, type useGlobeScene } from "./GlobeWorkspace";

function scene(ready = true, motionEnabled = true) {
  return {
    containerRef: { current: null }, globeRef: { current: undefined }, ready, setReady() {},
    size: { width: 720, height: 580 }, rotating: true, setRotating() {}, reset() {}, zoom() {}, focus() {}, motionEnabled,
    palette: { primary: "#236de9", cap: "", side: "", stroke: "", mutedStroke: "" },
  } as ReturnType<typeof useGlobeScene>;
}

test("globe fits the available stage width instead of imposing desktop minimums", () => {
  assert.deepEqual(globeViewportSize(488.4, 800), { width: 488, height: 510 });
  assert.deepEqual(globeViewportSize(1200, 1600), { width: 1200, height: 720 });
  assert.deepEqual(globeViewportSize(0, 400), { width: 1, height: 460 });
});

test("globe tooltips escape every user-controlled field and reject CSS injection", () => {
  const html = globeTooltip({ title: '<img src=x onerror="alert(1)">', color: 'red; background:url(x)', status: "<online>", rows: [{ label: '"IP"', value: "<script>bad</script>&'" }], action: "<edit>" });
  assert.match(html, /class="globe-tooltip"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;&amp;&#39;/);
  assert.match(html, /background:#236de9/);
  assert.doesNotMatch(html, /<img|<script|background:url|onmouseover=/);
  assert.equal(globeColorWithAlpha("#14a050", .3), "rgba(20,160,80,0.3)");
  assert.equal(globeColorWithAlpha("bad", .12), "rgba(35,109,233,0.12)");
});

test("OKLCH theme colors are converted to sRGB for WebGL rather than falling back to blue", () => {
  assert.equal(resolveGlobeThemeColor("#ABC123", "#236de9"), "#ABC123");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let fillStyle = "";
  try {
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: { supports: () => true } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => ({ set fillStyle(value: string) { fillStyle = value; }, fillRect() {}, getImageData: () => ({ data: [15, 118, 110, 255] }) }) }) } });
    assert.equal(resolveGlobeThemeColor("oklch(0.50 0.14 180)", "#236de9"), "#0f766e");
    assert.equal(fillStyle, "oklch(0.50 0.14 180)");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement() { throw new Error("Canvas access blocked"); } } });
    assert.equal(resolveGlobeThemeColor("oklch(0.50 0.14 180)", "#236de9"), "#236de9");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss); else Reflect.deleteProperty(globalThis, "CSS");
  }
});

test("shared globe layout keeps details separate, controls accessible and both languages complete", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const html = renderToStaticMarkup(<GlobeWorkspace title={t("全球主机地图")} subtitle={t("节点分布 · 在线状态一览")} stats={[{ label: t("在线"), value: 3, tone: "success" }]} scene={scene()} sidebar={<button>{t("节点列表")}</button>} empty={t("暂无可定位主机")}><div data-canvas="true" /></GlobeWorkspace>);
      assert.match(html, /xl:grid-cols-\[minmax\(0,1fr\)_19rem\]/);
      assert.match(html, /<aside[^>]*globe-sidebar/);
      assert.match(html, /aria-pressed="true"/);
      assert.equal((html.match(/aria-label=/g) || []).length, 4);
      assert.match(html, /data-canvas="true"/);
      assert.ok(html.indexOf("data-canvas") < html.indexOf("<aside"));
      if (language === "en") { assert.doesNotMatch(html, /\p{Script=Han}/u); assert.match(html, /Reset view/); }
      else assert.match(html, /暂停旋转/);
      const paused = renderToStaticMarkup(<GlobeWorkspace title="Globe" subtitle="" stats={[]} scene={scene(false, false)} sidebar={null}>{null}</GlobeWorkspace>);
      assert.equal((paused.match(/disabled=""/g) || []).length, 4);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("globe failure is contained within the scene and its fallback is bilingual", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const boundary = new GlobeSceneBoundary({ children: <div>Canvas</div> });
    assert.deepEqual(GlobeSceneBoundary.getDerivedStateFromError(), { failed: true });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(boundary.render());
    assert.match(html, /role="status"/);
    assert.match(html, /side list is still available/);
    assert.doesNotMatch(html, /\p{Script=Han}|min-h-screen/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("both globe views share themed chrome, motion policy and background-tab suspension", () => {
  const shared = readFileSync("client/src/components/GlobeWorkspace.tsx", "utf8");
  assert.match(shared, /useMotionEnabled\(\)/);
  assert.match(shared, /rotating && motionEnabled && !hovered/);
  assert.match(shared, /document.hidden\) globe.pauseAnimation\(\); else globe.resumeAnimation\(\)/);
  assert.match(shared, /removeEventListener\("visibilitychange", visibility\)/);
  assert.match(shared, /observer\?\.disconnect\(\)/);
  for (const page of ["Hosts", "Rules"]) {
    const source = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
    assert.match(source, /<GlobeWorkspace scene=\{scene\}/);
    assert.match(source, /globeTooltip\(\{/);
    assert.match(source, /backgroundColor="rgba\(0,0,0,0\)"/);
    assert.doesNotMatch(source, /night-sky|backgroundImageUrl=|minWidth:\s*900/);
    assert.match(source, /scene\.focus\(/);
    assert.match(source, /aria-pressed=\{/);
  }
  const hosts = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(hosts, /points\.slice\(0, 48\)/);
  assert.match(hosts, /createHostGlobeLeaderPaths\(labelPoints\)/);
  assert.match(hosts, /onlinePoints\.slice\(0, 80\)/);
  assert.match(hosts, /ringsData=\{scene.motionEnabled/);
  assert.match(readFileSync("client/src/pages/Rules.tsx", "utf8"), /pathDashAnimateTime=\{[^\n]*scene.motionEnabled/);
});

test("globe chrome follows light, dark and custom themes without covering the canvas", () => {
  const css = readFileSync("client/src/styles/globe.css", "utf8");
  assert.match(css, /\.dark \.globe-stage/);
  assert.match(css, /var\(--primary\)/);
  assert.match(css, /background: var\(--popover\); color: var\(--popover-foreground\)/);
  assert.match(css, /max-width: min\(330px, 80vw, var\(--globe-tooltip-max-width, 330px\)\)/);
  assert.match(css, /\.globe-list-row:focus-visible/);
  assert.match(readFileSync("client/src/pages/Settings.tsx", "utf8"), /pearl-hover-card group flex min-h-32/);
});

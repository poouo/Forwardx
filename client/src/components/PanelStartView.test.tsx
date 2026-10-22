import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PanelStartView from "./PanelStartView";
import AnimatedStatValue, { StatValuePersistenceContext } from "./AnimatedStatValue";
import { initializeLanguage, setLanguagePreference } from "@/i18n";
import { pendingPageTitle } from "./SidebarPresentation";
import { saveSidebarPresentation } from "@/lib/sidebarPresentation";

test("initial UI is usable and bilingual, without an overlay or private controls", async () => {
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language); await initializeLanguage();
    const html = renderToStaticMarkup(<PanelStartView />);
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /href="\/login"/);
    assert.match(html, /<h1/);
    assert.match(html, /data-sidebar="spacer"/);
    assert.match(html, /data-sidebar="container"/);
    assert.match(html, /pearl-topbar/);
    assert.doesNotMatch(html, /inset-0|animate-pulse|type="password"|\/settings|\/users|dialog-overlay/);
    if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
  }
});

test("pending titles follow the URL instead of falling back to the dashboard", async () => {
  setLanguagePreference("zh-CN"); await initializeLanguage();
  assert.equal(pendingPageTitle("/rules?category=tunnel"), "转发规则");
  assert.equal(pendingPageTitle("/tunnels"), "链路管理");
  assert.equal(pendingPageTitle("/operations"), "运维看板");
  assert.equal(pendingPageTitle("/affiliate-management"), "推广管理");
  assert.equal(pendingPageTitle("/custom-pages/help", [{ label: "其他", items: [{ path: "/custom-pages/help", label: "帮助中心" }] }]), "帮助中心");
});

test("refresh retains full inert navigation and hides collapsed text, without dashboard stats", async () => {
  setLanguagePreference("zh-CN"); await initializeLanguage();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { origin: "https://panel.test", pathname: "/rules" },
    sessionStorage: { getItem: (key: string) => memory.get(key), setItem: (key: string, value: string) => memory.set(key, value) },
    localStorage: { getItem: () => null },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "sidebar:state=false", getElementById: () => null } });
  try {
    saveSidebarPresentation("1:admin", [{ label: "主菜单", items: [{ path: "/", label: "仪表盘" }, { path: "/hosts", label: "主机管理" }, { path: "/tunnels", label: "链路管理" }, { path: "/rules", label: "转发规则" }] }, { label: "管理", items: [{ path: "/settings", label: "系统设置" }] }]);
    const html = renderToStaticMarkup(<PanelStartView branding={{ siteTitle: "Test", siteLogoDataUrl: "" }} />);
    assert.match(html, /<h1[^>]*>转发规则<\/h1>/);
    assert.equal((html.match(/data-sidebar="menu-button"/g) || []).length, 5);
    assert.match(html, /data-state="collapsed"/);
    assert.match(html, /class="sr-only">主机管理/);
    assert.match(html, /aria-disabled="true"/);
    assert.doesNotMatch(html, /href="\/settings"|入站流量|出站流量|运行状态/);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("pending sidebar and header render custom branding without showing ForwardX first", () => {
  const html = renderToStaticMarkup(<PanelStartView branding={{ siteTitle: "Custom Panel", siteLogoDataUrl: "data:image/png;base64,dGVzdA==" }} />);
  assert.match(html, /Custom Panel/);
  assert.match(html, /src="data:image\/png;base64,dGVzdA=="/);
  assert.doesNotMatch(html, />ForwardX<|aria-label="ForwardX"/);
  assert.match(html, /aria-busy="true"/);
});

test("dashboard presentation ignores legacy unscoped text caches", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => "OTHER-USER-DATA" } } });
  try {
    const html = renderToStaticMarkup(<StatValuePersistenceContext.Provider value={false}><AnimatedStatValue cacheKey="home.stats.totalRules" value={0} loading fallbackValue="—" /></StatValuePersistenceContext.Provider>);
    assert.doesNotMatch(html, /OTHER-USER-DATA/);
    assert.match(html, /—/);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});

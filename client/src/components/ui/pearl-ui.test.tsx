import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";
import { Card, CardContent, CardFooter, CardHeader } from "./card";
import { ContentTransition } from "./content-transition";
import { RuleLimitsForm, newRuleLimitsForm } from "../rules/RuleLimitsForm";
import { RuleCardControls } from "../rules/RuleCardControls";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Progress } from "./progress";
import { Switch } from "./switch";
import { Tabs } from "./tabs";
import { SlidingTabsList } from "./sliding-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import LanguageSelector from "../LanguageSelector";
import { ConfirmDialogProvider } from "./confirm-dialog";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";

const css = readFileSync("client/src/styles/pearl.css", "utf8");

test("rule card controls reserve identical space with and without sorting", () => {
  const switchControl = <Switch checked aria-label="Toggle rule" />;
  const handle = <button type="button" className="h-6 w-6" aria-label="Sort rule" />;
  const sortable = renderToStaticMarkup(<RuleCardControls dragHandle={handle}>{switchControl}</RuleCardControls>);
  const filtered = renderToStaticMarkup(<RuleCardControls>{switchControl}</RuleCardControls>);
  for (const html of [sortable, filtered]) {
    assert.match(html, /data-rule-card-controls="" class="flex h-6 shrink-0 items-center gap-1"/);
    assert.match(html, /data-rule-card-drag-slot="" class="flex size-6 shrink-0 items-center justify-center"/);
    assert.match(html, /role="switch"[^>]*aria-checked="true"/);
  }
  assert.equal(sortable.replace(/<button[^>]*aria-label="Sort rule"><\/button>/, ""), filtered);
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const cards = source.slice(source.indexOf("const renderRuleCard ="), source.indexOf("const renderRuleCard =") + 8000);
  assert.equal((cards.match(/<RuleCardControls dragHandle=/g) || []).length, 2);
  assert.equal((cards.match(/disableEnterAnimation/g) || []).length, 2);
});

test("idle sortable items do not retain a different compositing layer from filtered cards", () => {
  const source = readFileSync("client/src/components/SortableDragHandle.tsx", "utf8");
  assert.match(source, /willChange: isDragging \|\| transform \? "transform" : undefined/);
  assert.doesNotMatch(source, /willChange: "transform"/);
});

test("affiliate and operations pages fill the dashboard content width", () => {
  for (const page of ["Affiliates", "Operations"]) {
    const source = readFileSync(`client/src/pages/${page}.tsx`, "utf8");
    const classes = source.match(/<DashboardLayout>\s*<div className="([^"]+)"/)?.[1];
    assert.ok(classes, `${page} has a dashboard content wrapper`);
    assert.match(classes, /\bw-full\b/);
    assert.match(classes, /\bmin-w-0\b/);
    assert.doesNotMatch(classes, /max-w-|mx-auto|\bcontainer\b/);
  }
  const placeholder = readFileSync("client/src/components/RoutePage.tsx", "utf8");
  const classes = placeholder.match(/role="status"[^>]*className="([^"]+)"/)?.[1];
  assert.ok(classes);
  assert.match(classes, /\bw-full\b/);
  assert.match(classes, /\bmin-w-0\b/);
  assert.doesNotMatch(classes, /max-w-|mx-auto/);
});

test("host and rule card grids release animation clipping and preserve shadow overflow", () => {
  const baseCss = readFileSync("client/src/index.css", "utf8");
  for (const selector of [".rule-card-grid-static", ".host-card-grid-static", ".host-management-tabs"]) {
    const block = baseCss.slice(baseCss.indexOf(`${selector} {`)).split("}")[0];
    assert.match(block, /contain: layout;/);
    assert.doesNotMatch(block, /contain:[^;]*paint|overflow:\s*(?:hidden|clip)/);
  }
  for (const selector of [".rule-card-grid-static", ".rule-card-grid-static > *", ".host-card-grid-static", ".host-card-grid-static > *", ".host-card-mode-content"]) {
    const block = baseCss.slice(baseCss.indexOf(`${selector} {`)).split("}")[0];
    assert.match(block, /animation:[^;]* backwards;/);
    assert.doesNotMatch(block, /animation:[^;]*\b(?:both|forwards)\b/);
  }
});

test("rule groups clip during disclosure but let expanded card shadows remain visible", () => {
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const groupItems = source.slice(source.indexOf("function RuleGroupItems("), source.indexOf("function RuleContentTransition("));
  assert.match(groupItems, /open && \(!motionEnabled \|\| expanded\) \? "overflow-visible" : "overflow-hidden"/);
  assert.match(groupItems, /aria-hidden=\{!open\}/);
  assert.match(groupItems, /inert=\{!open\}/);
  assert.match(groupItems, /window\.clearTimeout\(timer\)/);
  assert.doesNotMatch(groupItems, /<AutoAnimateContainer|<motion\.|\.animate\(/);
  assert.match(groupItems, /transition-\[grid-template-rows,opacity\]/);
});

test("grouped rule cards use normal text rasterization without permanent compositing hints", () => {
  const baseCss = readFileSync("client/src/index.css", "utf8");
  for (const selector of [".rule-card-grid-static", ".rule-card-grid-static > *"]) {
    const block = baseCss.slice(baseCss.indexOf(`${selector} {`)).split("}")[0];
    assert.match(block, /transform: none !important/);
    assert.doesNotMatch(block, /will-change:|backface-visibility:|text-rendering:|font-smoothing:/);
    assert.match(block, /animation:[^;]* backwards;/);
  }
});

test("wrapped rule and forwarding group content leaves space before pagination", () => {
  for (const file of ["Rules", "ForwardGroups"]) {
    const source = readFileSync(`client/src/pages/${file}.tsx`, "utf8");
    assert.match(source, /<PersistentPagination[^>]+className="mt-5"/);
  }
});

test("link group table statuses reserve intrinsic width and never squeeze switches or wrap badges", () => {
  const source = readFileSync("client/src/pages/ForwardGroups.tsx", "utf8");
  assert.match(source, /<TableHead className="w-px whitespace-nowrap">\{translateText\("状态"\)\}/);
  assert.match(source, /<TableCell className="w-px whitespace-nowrap py-3">\s*<div className="flex w-max items-center gap-1\.5 \[&>\*\]:shrink-0">\s*\{renderGroupEnabledSwitch\(group\)\}\s*\{groupStatusBadge\(group\)\}/);
});

test("shared dialogs scroll long forms within short viewports instead of clipping save actions", () => {
  const source = readFileSync("client/src/components/ui/dialog.tsx", "utf8");
  const content = source.match(/className=\{cn\("(dialog-panel[^"]+)"/)?.[1];
  assert.ok(content);
  assert.match(content, /overflow-y-auto/);
  assert.match(content, /overflow-x-hidden/);
  assert.doesNotMatch(content, /(?:^|\s)overflow-hidden(?:\s|$)/);
  assert.ok(content.includes("max-h-[min(92svh,calc(100svh-1.5rem))]"));
  assert.ok(content.includes("sm:max-h-[min(92svh,calc(100svh-3rem))]"));
  assert.match(content, /overscroll-contain/);
});

test("dashboard background polling does not flash the online badge and the date uses themed colors", () => {
  const source = readFileSync("client/src/pages/Home.tsx", "utf8");
  assert.doesNotMatch(source, /dashboardRefreshing|isFetching|数据更新中/);
  assert.match(source, /refetchInterval: adaptivePollingInterval\(pollingInterval\("normal"\)\)/);
  assert.match(source, /refetchInterval: adaptivePollingInterval\(pollingInterval\("slow"\)\)/);
  assert.match(source, /dashboardRefreshFailed \? "部分数据更新失败，保留上次结果" : "系统在线"/);
  assert.match(source, /title=\{Number.isFinite\(dashboardUpdatedAt\)/);
  const date = css.match(/\.pearl-page-header \.pearl-spec-plate\s*\{([^}]+)\}/)?.[1];
  assert.ok(date);
  assert.match(date, /background: color-mix\(in srgb, var\(--primary\) 4%, var\(--card\)\)/);
  assert.match(date, /color: var\(--muted-foreground\)/);
  assert.match(date, /border-radius: 999px/);
  assert.match(date, /box-shadow: none/);
});

test("overlay scroll locks preserve sticky navigation by locking the document rather than body", () => {
  const baseCss = readFileSync("client/src/index.css", "utf8");
  const rootLock = baseCss.match(/html:has\(> body\[data-scroll-locked\]\),\s*html:has\(> body\[data-dialog-scroll-lock\]\),\s*html:has\(> body\.with-scroll-bars-hidden\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(rootLock, "Select, dropdown, dialog and nested locks share the document scrolling element");
  assert.match(rootLock, /overflow-y: hidden !important/);
  assert.match(rootLock, /scrollbar-gutter: stable/);
  const bodyLock = baseCss.match(/html body\[data-scroll-locked\],\s*html body\[data-dialog-scroll-lock\],\s*html body\.with-scroll-bars-hidden\s*\{([^}]+)\}/)?.[1];
  assert.ok(bodyLock);
  assert.match(bodyLock, /overflow: visible !important/);
  assert.doesNotMatch(bodyLock, /overflow(?:-[xy])?:\s*(?:auto|hidden|scroll)/);
  assert.doesNotMatch(baseCss, /data-forwardx-select-open/);
  assert.match(css, /\.pearl-topbar\s*\{\s*position: sticky; top: 0/);
  assert.match(baseCss, /--removed-body-scroll-bar-size: 0px !important/);
});

test("selects retain native Radix focus and open-state behavior without effect-based scroll overrides", async () => {
  const { Select, SelectTrigger, SelectValue } = await import("./select");
  for (const props of [{ open: false }, { defaultOpen: false }, { open: true }, { defaultOpen: true }]) {
    const html = renderToStaticMarkup(<Select {...props} value="all"><SelectTrigger><SelectValue placeholder="All" /></SelectTrigger></Select>);
    assert.match(html, /role="combobox"/);
    assert.match(html, new RegExp(`aria-expanded="${Boolean(props.open ?? props.defaultOpen)}"`));
  }
  const source = readFileSync("client/src/components/ui/select.tsx", "utf8");
  assert.match(source, /const Select = SelectPrimitive.Root/);
  assert.match(source, /<SelectPortal>/);
  assert.doesNotMatch(source, /markSelectOpen|forwardxSelectOpen|document\.body|preventDefault/);
});

test("animated stat values leave glyph bottoms visible at system-font and zoom boundaries", async () => {
  const { default: AnimatedStatValue } = await import("../AnimatedStatValue");
  const baseCss = readFileSync("client/src/index.css", "utf8");
  const inner = baseCss.match(/\.forwardx-stat-value-inner\s*\{([^}]+)\}/)?.[1];
  assert.ok(inner);
  assert.match(inner, /overflow: visible/);
  assert.match(inner, /vertical-align: baseline/);
  assert.match(inner, /line-height: inherit/);
  assert.doesNotMatch(inner, /overflow:\s*(?:hidden|clip)|backface-visibility:\s*hidden|text-overflow:\s*ellipsis/);
  for (const value of ["59", "1.84 TB", "180.27 GB", "gjpqy"]) {
    const html = renderToStaticMarkup(<AnimatedStatValue as="p" value={value} className="text-2xl leading-tight" />);
    assert.ok(html.includes(value));
    assert.match(html, /forwardx-stat-value-inner/);
    assert.doesNotMatch(html, /overflow-hidden|overflow-clip/);
  }
  assert.match(baseCss, /animation: forwardx-stat-value-change 260ms/);
});

test("Dashboard stats match the tinted billing cards without ruler decorations", async () => {
  const { DashboardStatCard } = await import("@/pages/Home");
  const { Server } = await import("lucide-react");
  for (const tone of ["teal", "blue", "emerald", "orange"]) {
    const html = renderToStaticMarkup(<DashboardStatCard title="Total inbound traffic"
      value="59.58 GB" subtitle="Cumulative inbound" icon={Server} cacheKey={`test.${tone}`}
      tone={`bg-gradient-to-br from-${tone}-500 to-${tone}-600`} />);
    assert.match(html, /Total inbound traffic/);
    assert.match(html, /59\.58 GB/);
    assert.match(html, /Cumulative inbound/);
    assert.match(html, /pointer-events-none absolute inset-0 opacity-\[0\.04\] dark:opacity-\[0\.07\]/);
    assert.match(html, /text-2xl font-bold leading-tight tracking-tight tabular-nums/);
    assert.match(html, /pearl-stat-icon[^"\n]*rounded-full[^"\n]*shadow-sm/);
    assert.match(html, /h-5 w-5 text-white/);
    assert.equal((html.match(new RegExp(`from-${tone}-500`, "g")) || []).length, 2);
    assert.doesNotMatch(html, /pearl-card-featured|font-mono|role="button"/);
  }
  assert.doesNotMatch(css, /\.pearl-stat::after|repeating-linear-gradient|\.pearl-stat-value/);
  assert.doesNotMatch(css, /\.pearl-stat-icon\s*\{/);
});

test("Dashboard traffic shares one card with responsive internal sections", async () => {
  const { DashboardTrafficOverview } = await import("@/pages/Home");
  for (const loading of [false, true]) {
    const html = renderToStaticMarkup(<DashboardTrafficOverview tunnelData={[]} portData={[]} groupData={[]} loading={loading} />);
    assert.equal((html.match(/glass-panel pearl-card /g) || []).length, 1);
    assert.equal((html.match(/<section /g) || []).length, 3);
    for (const label of ["隧道流量", "端口转发流量", "转发组流量"]) assert.match(html, new RegExp(label));
    assert.match(html, /divide-y divide-border\/50 lg:grid-cols-3 lg:divide-x lg:divide-y-0/);
    assert.doesNotMatch(html, /backdrop-blur/);
    if (!loading) assert.equal((html.match(/暂无流量数据/g) || []).length, 3);
    else assert.match(html, /animate-spin/);
  }
  const html = renderToStaticMarkup(<DashboardTrafficOverview tunnelData={[{ id: 1, name: "Tunnel example", value: 2048 }]} portData={[{ id: 2, name: "Port example", value: 4096 }]} groupData={[{ id: 3, name: "Group example", value: 1024 }]} loading={false} />);
  for (const label of ["Tunnel example", "Port example", "Group example", "2 KB", "4 KB", "1 KB"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /暂无流量数据/);
});

test("Dashboard status shares one card and preserves admin-only host visibility", async () => {
  const { DashboardStatusOverview } = await import("@/pages/Home");
  for (const isAdmin of [false, true]) {
    const html = renderToStaticMarkup(<DashboardStatusOverview isAdmin={isAdmin} loading={false} onlineHosts={3} totalHosts={4} activeRules={2} totalRules={5} />);
    assert.equal((html.match(/glass-panel pearl-card /g) || []).length, 1);
    assert.equal((html.match(/<section /g) || []).length, isAdmin ? 3 : 2);
    assert.match(html, /规则启用率/);
    assert.match(html, /系统概览/);
    assert.match(html, /40%/);
    assert.match(html, /lg:divide-x lg:divide-y-0/);
    if (isAdmin) {
      assert.match(html, /主机在线率/);
      assert.match(html, /75%/);
      assert.match(html, /lg:grid-cols-3/);
    } else {
      assert.doesNotMatch(html, /主机在线率|75%/);
      assert.match(html, /普通用户/);
      assert.match(html, /lg:grid-cols-2/);
    }
  }
  const html = renderToStaticMarkup(<DashboardStatusOverview isAdmin loading={true} onlineHosts={0} totalHosts={0} activeRules={0} totalRules={0} />);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, /animate-pulse/);
});

test("Store plan decoration stays behind custom/default content and preserves purchase controls", async () => {
  const { StorePlanCard } = await import("@/pages/Store");
  const plan = { name: "Test plan", priceCents: 1200, durationDays: 30, portCount: 5 };
  const custom = renderToStaticMarkup(<StorePlanCard plan={{ ...plan, description: "Custom plan details" }} purchasing onBuy={() => {}} />);
  const defaults = renderToStaticMarkup(<StorePlanCard plan={plan} onBuy={() => {}} />);
  for (const html of [custom, defaults]) {
    assert.match(html, /pearl-store-plan flex/);
    assert.equal((html.match(/pearl-store-plan-details/g) || []).length, 1);
    assert.match(html, /from-primary\/45 via-primary\/20 to-emerald-500\/25/);
    assert.match(html, /Test plan/);
    assert.match(html, /<button/);
  }
  assert.match(custom, /Custom plan details/);
  assert.doesNotMatch(custom, /连续端口/);
  assert.match(custom, /<button[^>]*disabled=""/);
  assert.doesNotMatch(defaults, /disabled=""/);
  assert.match(defaults, /连续端口/);
  for (const selector of ["pearl-store-plan", "pearl-store-plan-details"]) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))?.[1];
    assert.ok(rule);
    assert.match(rule, /background-image:[\s\S]*radial-gradient/);
    assert.match(rule, /var\(--primary\)/);
    assert.doesNotMatch(rule, /animation:|filter:|position:|z-index:/);
  }
});

test("Language selectors expose only Chinese and English and select the effective default", async () => {
  const previous = getLanguagePreference();
  try {
    // No window/browser hints in SSR: automatic detection falls back to Chinese.
    setLanguagePreference("auto");
    await initializeLanguage();
    for (const setup of [false, true]) {
      const html = renderToStaticMarkup(<ConfirmDialogProvider><LanguageSelector setup={setup} /></ConfirmDialogProvider>);
      assert.match(html, /role="combobox"/);
      assert.match(html, /pearl-select-trigger/);
      assert.doesNotMatch(html, /value="auto"/);
      assert.match(html, />简体中文<\/span>/);
    }
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<ConfirmDialogProvider><LanguageSelector /></ConfirmDialogProvider>);
    assert.match(html, />English<\/span>/);
    const source = readFileSync("client/src/components/LanguageSelector.tsx", "utf8");
    assert.equal((source.match(/<SelectItem value=/g) || []).length, 2);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("Desktop workspace has no dark perimeter or frame-related offsets", () => {
  assert.doesNotMatch(css, /--pearl-frame|\.pearl-shell::after|top: 14px|100svh - 28px/);
  assert.match(css, /\.pearl-sidebar \{ top: 0; bottom: 0; left: 0; height: 100svh; \}/);
});

test("Desktop brand header and topbar share a fixed border-inclusive height", () => {
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  assert.match(css, /--pearl-header-height: 4rem/);
  assert.match(layout, /<SidebarHeader className="h-16 md:h-\[var\(--pearl-header-height\)\]/);
  const topbar = css.match(/\.pearl-topbar \{([^}]+)\}/)?.[1];
  assert.ok(topbar);
  assert.match(topbar, /height: var\(--pearl-header-height\); min-height: var\(--pearl-header-height\)/);
  assert.match(topbar, /flex-shrink: 0; box-sizing: border-box; padding: 0 1\.5rem/);
});

test("Mobile page headings align left and card spacing remains overridable", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 767px)"), css.indexOf("@keyframes pearl-content-reveal"));
  assert.match(mobile, /\.pearl-card-header \{ padding: 1rem; \}/);
  assert.match(mobile, /\.pearl-card-content, \.pearl-card-footer \{ padding: 0 1rem 1rem; \}/);
  assert.match(mobile, /\.pearl-page-header \{ align-items: stretch; text-align: left; \}/);
  assert.match(mobile, /\.pearl-page-header > div:first-child \{ min-width: 0; \}/);
  assert.match(css, /@media \(max-width: 767px\) and \(pointer: coarse\) \{\s*input\.pearl-field, textarea\.pearl-field \{ font-size: 1rem; \}/);
  const html = renderToStaticMarkup(<Card disableEnterAnimation>
    <CardHeader className="p-2">Header</CardHeader>
    <CardContent className="p-3 sm:p-4">Content</CardContent>
    <CardFooter className="px-0">Actions</CardFooter>
  </Card>);
  assert.match(html, /pearl-card-header[^\"]*p-2/);
  assert.match(html, /pearl-card-content[^\"]*p-3 sm:p-4/);
  assert.match(html, /pearl-card-footer[^\"]*px-0/);
  assert.doesNotMatch(html, /\bp-6\b|\bsm:p-6\b/);
});

test("Mobile sidebar reserves native safe areas on the drawer, not its utility-padded children", () => {
  const mobileCss = readFileSync("client/src/index.css", "utf8");
  assert.match(mobileCss, /--forwardx-safe-area-top: var\(--safe-area-inset-top, env\(safe-area-inset-top, 0px\)\)/);
  assert.match(mobileCss, /--forwardx-safe-area-bottom: var\(--safe-area-inset-bottom, env\(safe-area-inset-bottom, 0px\)\)/);
  const unlayered = mobileCss.slice(mobileCss.indexOf("/* The fixed drawer"), mobileCss.indexOf("/* Unified scrollbar"));
  assert.match(unlayered, /\[data-mobile-sidebar="true"\] \{/);
  assert.match(unlayered, /box-sizing: border-box/);
  assert.match(unlayered, /padding-top: var\(--forwardx-safe-area-top\)/);
  assert.match(unlayered, /padding-bottom: var\(--forwardx-safe-area-bottom\)/);
  assert.doesNotMatch(unlayered, /@layer/);
  assert.doesNotMatch(mobileCss, /html\.capacitor-native \[data-sidebar="(?:header|footer)"\] \{/);
  assert.doesNotMatch(mobileCss, /min-height: calc\((?:3\.75|3)rem \+ env\(safe-area-inset-top\)\)/);
});

test("Sidebar animation keeps one geometry transition and avoids large-area blur", () => {
  const sidebar = readFileSync("client/src/components/ui/sidebar.tsx", "utf8");
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  const legacyCss = readFileSync("client/src/index.css", "utf8");
  assert.match(sidebar, /data-sidebar="container"/);
  assert.match(sidebar, /transition-\[width\] ease-linear/);
  assert.match(sidebar, /transition-\[left,right,width\] ease-linear/);
  assert.doesNotMatch(sidebar, /backdrop-blur-2xl|supports-\[backdrop-filter\]|transition-\[margin,opa\]/);
  assert.doesNotMatch(sidebar, /transition-\[width,height,padding/);
  assert.doesNotMatch(layout, /transition-\[width,height,padding/);
  const collapsed = legacyCss.match(/\.group\[data-collapsible="icon"\] \[data-sidebar="menu-button"\],\s*\.group\[data-collapsible="icon"\] \.collapsed-sidebar-logo-button \{([^}]+)\}/)?.[1];
  assert.ok(collapsed);
  assert.doesNotMatch(collapsed, /width \d|height \d|padding \d/);
  assert.match(css, /\.pearl-sidebar \{ overflow: hidden; contain: layout paint; \}/);
  const topbar = css.match(/\.pearl-topbar \{([^}]+)\}/)?.[1];
  assert.ok(topbar);
  assert.doesNotMatch(topbar, /backdrop-filter/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-sidebar="spacer"\], \[data-sidebar="container"\], \[data-mobile-sidebar="true"\],\s*\[data-sidebar="group-label"\] \{ transition: none !important; \}/);
});

test("Sidebar marker follows CSS width instead of measuring every menu item every frame", () => {
  const nav = readFileSync("client/src/components/PearlSidebarContent.tsx", "utf8");
  assert.match(nav, /right: centered \? `calc\(50% - \$\{next.width \/ 2\}px\)` : `\$\{next.left\}px`/);
  assert.match(nav, /previous.mode === next.mode/);
  assert.doesNotMatch(nav, /width: `\$\{next.width\}px`|querySelectorAll/);
  assert.match(nav, /if \(heightChanged\) schedule\(\)/);
  assert.match(nav, /observer\?\.observe\(active\)/);
  assert.match(nav, /observer\?\.unobserve\(observedActive\)/);
  for (const event of ["transitionend", "transitioncancel"]) {
    assert.ok(nav.includes(`addEventListener("${event}", finishResize)`));
    assert.ok(nav.includes(`removeEventListener("${event}", finishResize)`));
  }
  assert.match(nav, /removeEventListener\("resize", schedule\)/);
});

test("Desktop topbar does not duplicate the sidebar toggle and mobile retains its trigger", () => {
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  const desktopTopbar = layout.match(/<header className="pearl-topbar">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(desktopTopbar);
  assert.doesNotMatch(desktopTopbar, /SidebarTrigger/);
  assert.match(layout, /onClick=\{toggleSidebar\}/);
  assert.match(layout, /<SidebarTrigger className="h-9 w-9 rounded-lg bg-background"/);
});

test("Theme switching stays in the topbar and mobile header, not the sidebar", () => {
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  const sidebar = layout.match(/<Sidebar collapsible="icon"[\s\S]*?<\/Sidebar>/)?.[0];
  assert.ok(sidebar);
  assert.doesNotMatch(sidebar, /onClick=\{toggleTheme\}/);
  const desktopTopbar = layout.match(/<header className="pearl-topbar">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(desktopTopbar);
  assert.match(desktopTopbar, /onClick=\{toggleTheme\}/);
  assert.equal((layout.match(/onClick=\{toggleTheme\}/g) || []).length, 2);
});

test("Pearl buttons preserve Slot composition, form semantics, and caller overrides", () => {
  const html = renderToStaticMarkup(<>
    <Button asChild variant="outline"><a href="/rules" aria-label="Forwarding rules">Open rules</a></Button>
    <Button type="submit" disabled className="h-12 bg-destructive">Save Notification Settings</Button>
  </>);
  assert.match(html, /<a[^>]*href="\/rules"/);
  assert.match(html, /aria-label="Forwarding rules"/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /type="submit"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /h-12 bg-destructive/);
  assert.match(html, /pearl-button/);
});

test("Pearl fields retain validation, autocomplete, read-only and disabled contracts", () => {
  const html = renderToStaticMarkup(<>
    <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid="true" />
    <Input name="quota" type="number" min={0} max={100} readOnly defaultValue={5} />
    <Textarea aria-label="Description" disabled defaultValue="Long English description" />
  </>);
  assert.match(html, /type="email"/);
  assert.match(html, /autoComplete="email"/);
  assert.match(html, /required=""/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /min="0" max="100"/);
  assert.match(html, /readOnly=""/);
  assert.match(html, /disabled=""/);
  assert.match(html, /pearl-field/);
});

test("Cards can opt out of entrances and dense tables retain cell-level overrides", () => {
  const html = renderToStaticMarkup(<Card disableEnterAnimation className="border-destructive">
    <Table><TableHeader><TableRow><TableHead>Traffic / Expiration</TableHead></TableRow></TableHeader>
      <TableBody><TableRow data-state="selected"><TableCell className="sticky left-0 bg-card">1.25 GB</TableCell></TableRow></TableBody>
    </Table>
  </Card>);
  assert.doesNotMatch(html, /stagger-card/);
  assert.match(html, /border-destructive/);
  assert.match(html, /overflow-auto/);
  assert.match(html, /sticky left-0 bg-card/);
  assert.match(html, /data-state="selected"/);
});

test("Progress exposes its real value and switches keep Radix checked/disabled semantics", () => {
  const html = renderToStaticMarkup(<>
    <Progress value={35} />
    <Switch checked disabled aria-label="Enable forwarding" instant />
  </>);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="35"/);
  assert.match(html, /translateX\(-65%\)/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /disabled=""/);
});

test("switch track and thumb drop shadows stay centered without changing the decorative highlight", () => {
  assert.match(css, /\.pearl-switch\s*\{\s*box-shadow: inset 0 0 3px rgb\(20 34 28 \/ 12%\);\s*\}/);
  assert.match(css, /\.pearl-switch > span\s*\{\s*box-shadow: 0 0 3px rgb\(0 0 0 \/ 18%\), inset 0 1px 0 rgb\(255 255 255 \/ 75%\);\s*\}/);
});

test("Glass sliding tabs retain intrinsic long-label widths, selected semantics and readable text", () => {
  const html = renderToStaticMarkup(<Tabs value="notifications"><SlidingTabsList activeValue="notifications" onValueChange={() => {}} items={[
    { value: "system", label: "System Configuration" },
    { value: "notifications", label: "Notification Channels", badge: 120 },
  ]} /></Tabs>);
  assert.match(html, /pearl-tab-indicator/);
  assert.match(html, /minmax\(max-content, auto\)/);
  assert.match(html, /aria-selected="true"/);
  assert.doesNotMatch(html, /data-\[state=active\]:text-primary-foreground/);
});

test("Theme text and primary controls meet WCAG AA contrast in light and dark palettes", () => {
  const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const dark = css.slice(css.indexOf(".dark {"), css.indexOf("@layer components"));
  const luminance = (hex: string) => {
    const rgb = hex.slice(1).match(/../g)!.map(pair => {
      const c = parseInt(pair, 16) / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const theme of [light, dark]) {
    const value = (key: string) => theme.match(new RegExp(`--${key}: (#[0-9a-f]{6});`))![1];
    for (const [text, background] of [
      ["foreground", "background"], ["foreground", "muted"], ["muted-foreground", "card"],
      ["primary-foreground", "primary"], ["destructive-foreground", "destructive"],
    ]) {
      const a = luminance(value(text)), b = luminance(value(background));
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.ok(ratio >= 4.5, `${text}/${background}: ${ratio.toFixed(2)}`);
    }
    // The console mixes 3% of any personalized primary into muted. Even
    // the darkest/lightest possible tint must retain readable output.
    for (const tint of [0, 255]) {
      const surface = "#" + value("muted").slice(1).match(/../g)!.map(pair =>
        Math.round(parseInt(pair, 16) * .97 + tint * .03).toString(16).padStart(2, "0")
      ).join("");
      const a = luminance(value("foreground")), b = luminance(surface);
      assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5);
    }
  }
});

test("Network and iperf3 consoles follow theme colors and retain raw monospace output", async () => {
  const { ResultOutput, Iperf3Output } = await import("@/pages/LookingGlass");
  const raw = "first line\nsecond line <tag> & value";
  const html = renderToStaticMarkup(<>
    <ResultOutput result={null} liveOutput={raw} state="running" />
    <Iperf3Output loading={false} onCopy={() => {}} />
  </>);
  assert.equal((html.match(/<pre class="pearl-console/g) || []).length, 2);
  assert.doesNotMatch(html, /bg-slate-950|text-slate-100|terminal-scrollbar/);
  assert.match(html, /overflow-auto[^"\n]*font-mono/);
  assert.match(html, /first line\nsecond line &lt;tag&gt; &amp; value/);
  assert.match(css, /\.pearl-console \{\s*color: var\(--foreground\);/);
  assert.match(css, /background: color-mix\(in srgb, var\(--primary\) 3%, var\(--muted\)\)/);
  assert.match(css, /scrollbar-color: var\(--muted-foreground\) var\(--muted\)/);
});

test("Shared materials keep utility overrides, mobile safe areas and reduced-motion fallbacks", () => {
  assert.match(css, /@layer components/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /data-forwardx-motion-paused/);
  assert.match(css, /data-personalization-background="image"/);
  assert.doesNotMatch(css, /\binfinite\b|will-change\s*:\s*transform/);
  const nav = readFileSync("client/src/components/PearlSidebarContent.tsx", "utf8");
  assert.match(nav, /observer\?\.disconnect\(\)/);
  assert.match(nav, /mutations.disconnect\(\)/);
  assert.match(nav, /animation\?\.cancel\(\)/);
  assert.match(nav, /cancelAnimationFrame\(frame\)/);
  assert.match(nav, /removeEventListener\("visibilitychange", settle\)/);
  assert.doesNotMatch(nav, /setInterval/);
  const setup = readFileSync("client/src/pages/Setup.tsx", "utf8");
  assert.doesNotMatch(setup, /bg-[\w-]+\/\d+\/\d+/);
  assert.doesNotMatch(setup, /bg-white\//);
  assert.match(readFileSync("client/public/pearl-ui-license.txt", "utf8"), /Copyright \(c\) 2026 wbr664393425-lgtm/);
});

test("Featured and interactive cards preserve nested controls and caller attributes", () => {
  const html = renderToStaticMarkup(<Card variant="featured" interactive disableEnterAnimation
    id="rule-42" data-state="selected" className="bg-destructive rounded-none" style={{ opacity: .7 }}>
    <Button type="button" disabled>Copy</Button>
  </Card>);
  assert.match(html, /pearl-card-featured pearl-card-interactive/);
  assert.match(html, /bg-destructive rounded-none/);
  assert.match(html, /id="rule-42" data-state="selected"/);
  assert.match(html, /style="opacity:0.7"/);
  assert.doesNotMatch(html, /variant=|interactive=|stagger-card|role="button"/);
  assert.match(html, /<button[^>]*type="button"[^>]*disabled=""/);
  const hover = css.match(/\.pearl-card-interactive:hover \{([^}]+)\}/)?.[1];
  assert.ok(hover);
  assert.match(hover, /box-shadow:/);
  assert.doesNotMatch(hover, /transform:|filter:|backdrop-filter:/);
});

test("standalone card hover is opt-in, pointer-only, reduced-motion safe and distinct from sortable feedback", () => {
  const active = renderToStaticMarkup(<Card hoverable disableEnterAnimation><span>Statistics</span></Card>);
  assert.match(active, /pearl-hover-card/);
  assert.doesNotMatch(active, /hoverable=|role="button"|stagger-card/);
  const form = renderToStaticMarkup(<Card disableEnterAnimation><input /></Card>);
  assert.doesNotMatch(form, /pearl-hover-card/);
  const sortable = renderToStaticMarkup(<Card interactive disableEnterAnimation />);
  assert.match(sortable, /pearl-card-interactive/);
  assert.doesNotMatch(sortable, /pearl-hover-card/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.pearl-card-interactive:hover[^}]*\}\s*\.pearl-hover-card:hover/);
  const hover = css.match(/\.pearl-hover-card:hover \{([^}]+)\}/)?.[1];
  assert.ok(hover);
  assert.match(hover, /transform: translateY\(-2px\)/);
  assert.match(hover, /border-color:/);
  assert.match(hover, /box-shadow:/);
  assert.doesNotMatch(hover, /will-change|filter:|backdrop-filter/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.pearl-hover-card[^}]*transition: none !important/);
  assert.match(reduced, /\.pearl-hover-card:hover \{ transform: none; \}/);
});

test("card shadows ease in and out slowly without delaying layout changes or sortable transforms", () => {
  assert.match(css, /--pearl-card-shadow-duration: 480ms;/);
  assert.match(css, /--pearl-card-shadow-ease: cubic-bezier\(\.4, 0, \.2, 1\);/);
  const feedback = css.match(/--pearl-card-feedback-transition:([^;]+);/)?.[1];
  assert.ok(feedback);
  assert.match(feedback, /box-shadow var\(--pearl-card-shadow-duration\) var\(--pearl-card-shadow-ease\)/);
  assert.match(feedback, /min-height 300ms/);
  assert.match(feedback, /opacity 300ms/);
  assert.doesNotMatch(feedback, /transform|all |will-change/);
  assert.match(css, /^\.pearl-card-interactive,\s*\.pearl-hover-card \{\s*transition: var\(--pearl-card-feedback-transition\);/m);
  assert.match(css, /^\.pearl-hover-card \{\s*transition: var\(--pearl-card-feedback-transition\), transform 300ms/m);
  for (const selector of ["pearl-card-interactive", "pearl-hover-card"]) {
    const hover = css.match(new RegExp(`\\.${selector}:hover \\{([^}]+)\\}`))?.[1];
    assert.ok(hover);
    assert.match(hover, /box-shadow: var\(--pearl-card-hover-shadow\)/);
    assert.doesNotMatch(hover, /pearl-overlay-shadow/);
  }
  assert.equal((css.match(/--pearl-card-hover-shadow:/g) || []).length, 2, "light and dark themes have dedicated subtle card shadows");
  const card = readFileSync("client/src/components/ui/card.tsx", "utf8");
  assert.doesNotMatch(card, /pearl-hover-card duration-200/);
  assert.match(readFileSync("client/src/pages/HostMonitor.tsx", "utf8"), /hoverable=\{!!onSelect\}/);
  assert.match(readFileSync("client/src/pages/Plugins.tsx", "utf8"), /className="pearl-hover-card group flex min-h-\[17rem\]/);
});

test("hover cards restore a visible theme glow and deeper bottom shadow in both themes", () => {
  const shadows = [...css.matchAll(/--pearl-card-hover-shadow:\s*([^;]+);/g)].map((match) => match[1]);
  assert.equal(shadows.length, 2);
  for (const shadow of shadows) {
    assert.match(shadow, /0 6px 20px -4px var\(--theme-glow\)/);
    assert.match(shadow, /0 20px 40px -12px/);
    assert.match(shadow, /inset 0 1px 0 var\(--pearl-highlight\)/);
  }
  assert.match(shadows[0], /rgb\(28 44 38 \/ 24%\)/);
  assert.match(shadows[1], /rgb\(0 0 0 \/ 52%\)/);
});

test("Content switches render real content immediately without initial fade or layout scaling", () => {
  const html = renderToStaticMarkup(<ContentTransition transitionKey="rules" className="test-content">
    <button type="button">Existing action</button>
  </ContentTransition>);
  assert.match(html, /class="test-content"/);
  assert.match(html, /Existing action/);
  assert.doesNotMatch(html, /inert=""|aria-hidden="true"|opacity:0|scale\(/);
  const source = readFileSync("client/src/components/ui/content-transition.tsx", "utf8");
  assert.match(source, /useMotionEnabled\(\)/);
  assert.match(source, /inert=\{!present\}/);
  assert.match(source, /initial=\{false\}/);
  assert.doesNotMatch(source, /setInterval|requestAnimationFrame/);
  const rules = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.match(rules, /aria-hidden=\{!open\}\s+inert=\{!open\}/);
});

test("Limit disclosures remain native, collapsed by default and keep editable form values", () => {
  const html = renderToStaticMarkup(<RuleLimitsForm value={{ ...newRuleLimitsForm(), speed: "123" }} onChange={() => {}} />);
  assert.match(html, /<details class="pearl-disclosure/);
  assert.doesNotMatch(html, /<details[^>]*\sopen[\s=>]/);
  assert.match(html, /<summary/);
  assert.match(html, /pearl-disclosure-chevron/);
  assert.match(html, /value="123"/);
  assert.match(css, /@supports \(interpolate-size: allow-keywords\)/);
  assert.match(css, /pearl-disclosure::details-content/);
  assert.match(css, /html\[data-forwardx-motion-paused\] \.tab-content-enter/);
});

test("network test selectors show host status without redundant selection checkmarks", () => {
  const source = readFileSync("client/src/pages/LookingGlass.tsx", "utf8");
  assert.doesNotMatch(source, /公网目标限定|ShieldCheck/);
  assert.match(source, /<SelectItem key=\{host\.id\}[^>]*showIndicator=\{false\}[^>]*data-\[state=checked\]:bg-accent/);
  assert.match(source, /<HostStatusLabel\s+host=\{host\}/);
  assert.match(source, /<SelectItem key=\{item\.value\}[^>]*showIndicator=\{false\}[^>]*data-\[state=checked\]:bg-accent/);
  assert.match(source, /<ItemIcon className="h-4 w-4 text-primary"/);
});

test("agent token management removes the decorative encryption banner but retains actionable install warnings", () => {
  const source = readFileSync("client/src/components/AgentTokenManager.tsx", "utf8");
  assert.doesNotMatch(source, /通讯已加密|ShieldCheck/);
  assert.match(source, /当前安装地址是本机回环地址/);
});

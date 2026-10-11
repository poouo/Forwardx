import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";
import { Card } from "./card";
import { ContentTransition } from "./content-transition";
import { RuleLimitsForm, newRuleLimitsForm } from "../rules/RuleLimitsForm";
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

test("Language selectors expose only Chinese and English and select the effective default", async () => {
  const previous = getLanguagePreference();
  try {
    // No window/browser hints in SSR: automatic detection falls back to Chinese.
    setLanguagePreference("auto");
    await initializeLanguage();
    for (const setup of [false, true]) {
      const html = renderToStaticMarkup(<ConfirmDialogProvider><LanguageSelector setup={setup} /></ConfirmDialogProvider>);
      assert.equal((html.match(/<option /g) || []).length, 2);
      assert.doesNotMatch(html, /value="auto"/);
      assert.match(html, /value="zh-CN" selected=""/);
    }
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(<ConfirmDialogProvider><LanguageSelector /></ConfirmDialogProvider>);
    assert.match(html, /value="en" selected=""/);
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

test("Glass sliding tabs retain intrinsic long-label widths, selected semantics and readable text", () => {
  const html = renderToStaticMarkup(<Tabs value="notifications"><SlidingTabsList activeValue="notifications" items={[
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

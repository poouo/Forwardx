import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpDetails } from "./help-details";
import { CardTitle } from "./card";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import LinkCreateTypeSelector from "../LinkCreateTypeSelector";
import { PersistentPagination, type PersistentPaginationState } from "../PersistentPagination";
import { RuleLimitsForm, newRuleLimitsForm } from "../rules/RuleLimitsForm";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { ForwardXLogo } from "../ForwardXLogo";

test("speed unit suffixes stay compact and opt out of browser translation", () => {
  for (const name of ["ForwardGroups", "Users"]) {
    const source = readFileSync(`client/src/pages/${name}.tsx`, "utf8");
    assert.match(source, /<span translate="no" className="notranslate[^\"]*">Mbps<\/span>/);
    assert.doesNotMatch(source, /每秒兆比特|兆比特数/);
  }
});

test("group DDNS offers both address families and only shows CNAME for saved legacy selections", () => {
  const page = readFileSync("client/src/pages/ForwardGroups.tsx", "utf8");
  assert.match(page, /<SelectItem value="A">IPv4 \/ A<\/SelectItem>/);
  assert.match(page, /<SelectItem value="AAAA">IPv6 \/ AAAA<\/SelectItem>/);
  assert.match(page, /<SelectItem value="BOTH">A \+ AAAA<\/SelectItem>/);
  assert.match(page, /form\.recordType === "CNAME" && <SelectItem value="CNAME">/);
  assert.match(page, /_160px/);
  assert.match(page, /forwardGroupDdnsHostValue\(host, form\.recordType\)/);
});

test("operations monitor is display-only and sits below the other dashboard sections", () => {
  const page = readFileSync("client/src/pages/Operations.tsx", "utf8");
  const filters = page.indexOf("<OperationsDateFilter ");
  const summary = page.indexOf("<SummaryMetricCard ");
  const monitor = page.indexOf("<OperationsMonitorPanel ");
  assert.ok(filters >= 0 && filters < summary && summary < monitor);
  assert.ok(monitor > page.indexOf('t("转发组事件")'));
  const panel = readFileSync("client/src/components/OperationsMonitorPanel.tsx", "utf8");
  assert.doesNotMatch(panel, /saveMonitor|saveResourceAlertSettings|资源告警设置/);
  assert.match(panel, /IP 更换记录/);
  const services = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(services, /<HostResourceAlertSettings /);
  assert.doesNotMatch(services, /ChinaHealthStatus|lastAction|blockedAction/);
  assert.equal((page.match(/<OperationsDateFilter\b/g) || []).length, 1);
  assert.equal((page.match(/<OperationsMonitorPanel\b/g) || []).length, 1);
});

test("public homepage branding renders only one logo, including uploaded site logos", () => {
  const page = readFileSync("client/src/pages/PublicHome.tsx", "utf8");
  const header = page.slice(page.indexOf("<header"), page.indexOf("</header>"));
  assert.equal((header.match(/<ForwardXLogo\b/g) || []).length, 1);
  assert.doesNotMatch(header, /<img\b/);
  assert.match(header, /src=\{info\?\.siteLogoDataUrl\}/);
  for (const src of [undefined, "data:image/png;base64,dGVzdA=="]) {
    const html = renderToStaticMarkup(<ForwardXLogo size={36} alt="Light-ZZ" src={src} />);
    assert.equal((html.match(/<(?:img|svg)\b/g) || []).length, 1);
    if (src) assert.ok(html.includes(src));
    else assert.match(html, /<svg\b/);
  }
});

test("sidebar menu toggles use consistent single-line rows without descriptions", () => {
  const settings = readFileSync("client/src/pages/Settings.tsx", "utf8");
  const rows = settings.slice(settings.indexOf("{SIDEBAR_MENU_KEYS.map((key) => ("));
  const menu = rows.slice(0, rows.indexOf("</Dialog>"));
  assert.match(menu, /<span className="text-sm">\{translateText\(getSidebarMenuLabel\(key, true\)\)\}<\/span>/);
  assert.match(menu, /checked=\{sidebarMenu\[key\]\}/);
  assert.match(menu, /setSidebarMenuEnabled\(key, checked\)/);
  assert.doesNotMatch(menu, /<p\b|仅控制用户侧菜单显示|仅控制菜单显示/);
  assert.doesNotMatch(menu, /supportTicketsEnabled|affiliateEnabled/);
});

test("ticket navigation belongs to management for both roles and keeps unread badges", () => {
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  const primary = layout.slice(layout.indexOf("  const primaryMenuItems = filterSidebarNavItems("), layout.indexOf("  const otherMenuItems:"));
  assert.ok(primary.length > 0);
  assert.doesNotMatch(primary, /ticketMenuItems|\/tickets|sidebarMenuSettings\.tickets/);
  const management = layout.slice(layout.indexOf("  const managementMenuItems:"), layout.indexOf("  const allMenuItems ="));
  assert.equal((management.match(/\.\.\.ticketMenuItems/g) || []).length, 2);
  assert.match(layout, /const ticketMenuItems = filterSidebarNavItems\(/);
  assert.doesNotMatch(layout, /isAdmin \|\| sidebarMenuSettings\.tickets/);
  assert.match(layout, /ticketStatus\?\.enabled === true/);
  assert.match(layout, /ticketSummary\.unread > 99/);
  assert.match(layout, /const allMenuItems = \[\.\.\.primaryMenuItems, \.\.\.managementMenuItems, \.\.\.otherMenuItems\]/);
});

test("ticket actions distinguish administrator handling from user submission in both languages", async () => {
  const { TicketListActions } = await import("@/pages/SupportTickets");
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const admin of [true, false]) {
        const html = renderToStaticMarkup(<TicketListActions admin={admin} onCreate={() => {}} onManageReplies={() => {}} onSettings={() => {}} />);
        assert.equal((html.match(/<button/g) || []).length, admin ? 2 : 1);
        const create = language === "en" ? "Submit a ticket" : "提交工单";
        const manage = language === "en" ? "Manage saved replies" : "管理快捷回复";
        assert.ok(html.includes(admin ? manage : create));
        assert.ok(!html.includes(admin ? create : manage));
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
  const page = readFileSync("client/src/pages/SupportTickets.tsx", "utf8");
  assert.match(page, /creating && user\?\.role === "user" &&/);
});

test("cancelled subscriptions stay in default billing history, not in the package view", () => {
  const billing = readFileSync("client/src/pages/Billing.tsx", "utf8");
  const packages = readFileSync("client/src/pages/Subscriptions.tsx", "utf8");
  assert.doesNotMatch(billing, /showCancelledSubscriptions|visibleLedger|查看已取消|隐藏已取消/);
  assert.match(billing, /\{ledger\.map\(\(item: any\) =>/);
  assert.match(billing, /translateText\(item\.statusLabel \|\| item\.status\)/);
  assert.doesNotMatch(packages, /showCancelled|cancelledCount|已取消记录当前处于隐藏状态|删除已取消订阅/);
  assert.match(packages, /subscriptions\.filter\(\(sub: any\) => sub\.status !== "cancelled"\)/);
  const wallet = readFileSync("client/src/pages/Wallet.tsx", "utf8");
  assert.match(wallet, /translateText\(item\.statusLabel \|\| item\.status\)/);
});

test("secondary help is native, collapsed, touch/keyboard accessible and retains full content", () => {
  const html = renderToStaticMarkup(<HelpDetails><p>Detailed guidance</p><a href="/guide">Read more</a></HelpDetails>);
  assert.match(html, /<details class="pearl-disclosure pearl-help/);
  assert.doesNotMatch(html, /<details[^>]*\bopen|aria-hidden="true"[^>]*>Detailed/);
  assert.match(html, /<summary/);
  assert.match(html, /使用说明/);
  assert.match(html, /Detailed guidance/);
  assert.match(html, /href="\/guide"/);
  assert.doesNotMatch(html, /<button|role="tooltip"|line-clamp/);
});

test("card and dialog typography stay readable without forced desktop enlargement or clipping", () => {
  const title = renderToStaticMarkup(<CardTitle className="text-base">Long English resource title</CardTitle>);
  assert.match(title, /text-base/);
  assert.doesNotMatch(title, /text-2xl|sm:text-xl|truncate|line-clamp/);
  const html = renderToStaticMarkup(<Dialog><DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Important risk warning</DialogDescription></DialogHeader></Dialog>);
  assert.match(html, /text-left/);
  assert.match(html, /leading-relaxed/);
  assert.match(html, /Important risk warning/);
  assert.doesNotMatch(html, /line-clamp/);
});

test("short pagination retains visible range, total, mobile page state and navigation", () => {
  const pagination: PersistentPaginationState<never> = {
    currentPage: 2, totalPages: 5, totalItems: 100, pageSize: 20,
    startItem: 21, endItem: 40, items: [], setPage() {}, nextPage() {}, previousPage() {},
  };
  const html = renderToStaticMarkup(<PersistentPagination pagination={pagination} itemName="rules" />);
  assert.match(html, /21–40 \/ 100 rules/);
  assert.match(html, /aria-label="第 2 页，共 5 页"/);
  assert.match(html, /上一页/);
  assert.match(html, /下一页/);
});

test("English help and link selectors update without reloading module-level labels", async () => {
  const previous = getLanguagePreference();
  try {
    const render = () => renderToStaticMarkup(<><HelpDetails><p>Help content</p></HelpDetails><LinkCreateTypeSelector value="port" onValueChange={() => {}} /></>);
    setLanguagePreference("zh-CN"); await initializeLanguage();
    assert.match(render(), /端口转发/);
    setLanguagePreference("en"); await initializeLanguage();
    const html = render();
    assert.match(html, />Help</);
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
    assert.match(html, /aria-pressed="true"/);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("quota guidance stays available without changing the editable policy", () => {
  const html = renderToStaticMarkup(<RuleLimitsForm value={{ ...newRuleLimitsForm(), speed: "15", quota: "20" }} onChange={() => {}} />);
  assert.match(html, /0 或留空不限，与账户限额同时生效/);
  assert.match(html, /value="15"/);
  assert.match(html, /value="20"/);
  assert.match(html, /修改日期不会清零已用流量/);
  assert.equal((html.match(/<details/g) || []).length, 2);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
});

test("destructive and security warnings are preserved; no global CSS hides descriptions", () => {
  const tunnels = readFileSync("client/src/pages/Tunnels.tsx", "utf8");
  const groups = readFileSync("client/src/pages/ForwardGroups.tsx", "utf8");
  const plugins = readFileSync("client/src/pages/Plugins.tsx", "utf8");
  const setup = readFileSync("client/src/pages/Setup.tsx", "utf8");
  assert.match(tunnels, /此操作会解除关联转发规则的隧道绑定，并停止这些规则的运行状态/);
  assert.match(groups, /引用它的转发规则会被同步清理/);
  assert.match(plugins, /仅对你确认可信的插件开启/);
  assert.match(setup, /此操作不可撤销/);
  const css = readFileSync("client/src/styles/pearl.css", "utf8");
  assert.doesNotMatch(css, /\.pearl-page-header\s+p\s*\{[^}]*display:\s*none/);
  assert.match(css, /\.pearl-page-header[^}]*background: transparent; box-shadow: none/s);
});

test("Google login settings precede the final contact card without duplication", () => {
  const settings = readFileSync("client/src/pages/Settings.tsx", "utf8");
  const systemTab = settings.match(/<TabsContent value="system"[^>]*>([\s\S]*?)<\/TabsContent>/)?.[1] || "";
  assert.match(systemTab, /<SystemInfoSection \/>/);
  assert.doesNotMatch(systemTab, /<GoogleLoginSettingsCard/);
  assert.equal((settings.match(/<GoogleLoginSettingsCard \/>/g) || []).length, 1);
  const section = settings.slice(settings.indexOf("function SystemInfoSection("));
  const google = section.indexOf("<GoogleLoginSettingsCard />");
  const contact = section.indexOf('translateText("开源与联系")');
  assert.ok(google >= 0 && contact > google);
});

test("financial status badges and positive balances adapt to dark mode", () => {
  const payments = readFileSync("client/src/pages/Payments.tsx", "utf8");
  assert.doesNotMatch(payments, /bg-emerald-50\b|bg-amber-50\b|bg-slate-50\b/);
  // Payment orders now live in the ledger, where status badges use semantic
  // shared variants instead of the removed payment-page badge classes.
  const badge = readFileSync("client/src/components/ui/badge.tsx", "utf8");
  assert.match(badge, /bg-primary text-primary-foreground/);
  assert.match(badge, /bg-secondary text-secondary-foreground/);
  for (const name of ['Wallet', 'Billing']) {
    const source = readFileSync(`client/src/pages/${name}.tsx`, 'utf8');
    assert.match(source, /text-emerald-600 dark:text-emerald-400/);
    assert.match(source, /<Badge variant=\{item\.status[^}]*\? "default" : "secondary"\}/);
  }
});
